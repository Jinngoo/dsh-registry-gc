# dsh-registry-gc

> DSH 注册表垃圾回收：把 `workspace.json` 里指向**已不存在会话**的悬空 id 清掉。

## 为什么需要它

`workspace.json` 在三处记录会话 id：

| 位置 | 日志删除后 | 谁负责清 |
|---|---|---|
| `global.archivedSessionIds` | **id 永久保留**，getter 无过滤 | **本插件** |
| `global.pinnedSessionIds` | **id 永久保留**，getter 无过滤 | **本插件** |
| `tables.workspaces[].sessionIds` | getter 实时 `candidateMatches` 过滤；原始数组不可见 | **本插件**（`sweepSlots`，见下） |

前两行是源码事实：`workspaceRegistry.archivedSessionIds` 的 getter 直接 `return this.requireState().archivedSessionIds`，没有任何过滤。第三行同样有据：`WorkspaceEntity#sessionIds` 是 `this.record.sessionIds.filter(id => this.host.candidateMatches(...))`，所以失效槽位会被**隐藏但不会自动消失**——除非该工作区发生过一次写入。

**本插件三处都清**，但第三处的方式不同：它需要主动触发一次写操作，代价是刷新 `updatedAt`，因此默认关闭。

## 怎么做

**绝不直接改 `workspace.json`**——它带 pending-mutation 标记和一次性引导逻辑，乱序或中断的写入会被判为损坏并大声失败。本插件只调用官方方法，两个都在文档里明确写着「会话不存在也能安全解析」：

```
WorkspaceRegistry#unarchiveSession(id)  「不做会话存在性检查，因为移除 id 不会引入未知 id，
                                          所以会话已消失的条目仍能正常解析」
WorkspaceRegistry#unpinSession(id)
```

`Workspace#detachSession(id)` 也接好了（同样幂等），但正常不会被调用——因为失效槽位对插件不可见，指名删除无从谈起；它留在代码里是为将来注册表若暴露原始记录可直接用。

## 用法

**自动**：挂载后，进程内首次创建 Agent 的 15 秒后自动跑一遍（`startDelaySeconds` 可调）。只在确实有悬空 id 时才动手；若开了 `sweepSlotsOnStart`，则即使计划为空也会扫一遍槽位。

**手动**：模型可调 `registry_gc` 工具，默认 `dryRun: true` 只报告：

```jsonc
// registry_gc { dryRun: true }  ->  只读报告
{ "ok": true, "dryRun": true, "cleaned": 23, "archived": 23, "pinned": 0,
  "slots": 0, "swept": 0, "errors": [] }

// registry_gc { dryRun: false }                 -> 真正清全局两个集合
// registry_gc { dryRun: false, sweepSlots: true } -> 顺带重写工作区记录，剪除隐藏槽位
```

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `collectOnStart` | `true` | 进程内首次创建 Agent 后自动清理一次 |
| `startDelaySeconds` | `15` | 首次 Agent 出现后等多久再动手 |
| `sweepSlotsOnStart` | `false` | 启动时顺带重写所有工作区记录，剪除不可见槽位（刷新 `updatedAt`） |

## 工作区槽位：为什么需要「重写一次记录」

`workspaces[].sessionIds` 的情况和上面两个集合不同：

```ts
// entity.ts:110 —— getter 每次都过滤
get sessionIds() { return this.record.sessionIds.filter(id => this.host.candidateMatches(...)) }
```

所以失效槽位**对本插件不可见**（读到的已经是过滤后的数组），也没有任何公开 API 能读到原始数组。唯一的清除途径是让注册表**写一次这个记录**——`mutate()` 在落盘前会 prune 掉所有失配的候选：

```ts
// entity.ts:219-228
const sessionIds = changed.sessionIds.filter(id => this.host.candidateMatches(id, changed.path))
```

`sweepSlots` 就是利用这一点：对**每个**工作区调用一次 `setTitle(它自己的标题)`。

- 传相同标题也能触发写盘，因为 `setTitle` 用 `{ ...record, title }` 每次造新对象，`mutate` 的 `changed === current` 恒为 false，哨兵不会短路；
- 剪除是那次写入的**副作用**，和标题内容无关；标题最终保持不变；
- 因为看不到哪些记录有失效槽位，只能**全部重写一遍**（无法只挑有问题的）。

**代价（已知且可选）**：`mutate()` 会顺便把 `updatedAt` 重盖章，所以被扫过的所有工作区都显示「刚刚更新」。这只会影响按 `updatedAt` 排序的调用方；按名称排序的界面无感。因为多数人不需要这个副作用，它默认关闭：

| 键 | 默认 | 含义 |
|---|---|---|
| `sweepSlotsOnStart` | `false` | 启动时顺带重写所有工作区记录，剪除不可见槽位 |

工具调用时用 `registry_gc { sweepSlots: true }` 可以按需显式触发。

## 安全性

- 只删「持久化里没有 header」的 id；`sessionPersistence.list()` 返回 header-only 快照，不读事件日志，几百个会话也只有毫秒级；
- 每个调用都是幂等的，中断后重跑即可续上；第二次跑 `cleaned` 必为 0；
- 不动任何文件，只走注册表方法；
- 清理数量按**去重后的会话数**报告（同一会话可能同时出现在归档与置顶里）。

## 当前实测（本机 2026-11-21）

一次完整的「清理后收尾」全流程：

| 阶段 | archivedSessionIds 悬空 | 工作区悬空槽位 |
|---|---|---|
| 用 `dsh-session-janitor` 删掉 23 个归档会话后 | 23 | 19 |
| 重启 DSH（插件自动跑一遍） | **0** | 19 |
| 开启 `sweepSlotsOnStart` 再重启 | **0** | **0** |

第二行说明了一件事：只靠全局集合的清理，槽位残留不会自己消失——必须有那次写入。第三行把 `sessionIds` 从 19/19/3 降到 10/10/2（六个工作区各自剪掉了失效项）。

没有悬空 id 时插件是空操作，第二次跑 `cleaned` 必为 0，这本身就是幂等性验证。

## 配套使用

本插件只做注册表收尾，**不删任何文件**。删会话日志靠技能 `dsh-session-janitor`（纯 Node 脚本，可脱离 DSH 运行）：

```
停 DSH → node scripts/janitor.mjs apply --backup → 重启 DSH
                                                      ↓
                                          registry-gc 自动清掉悬空 id
```

顺序反过来（先启动再删文件）不会出错，只是残留要等下一次启动才清。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`src/plan.ts` 是纯决策逻辑（无服务、无时钟），`src/index.ts` 只做装配。25 项测试覆盖：纯决策、装配调用序列、`dryRun` 零写入、二次运行幂等、并发消失容错、定时器只武装一次、槽位清扫（默认不动 / 全量重写并剪除 / 标题不变 / dry-run 不扫 / 启动时空计划也扫）。
