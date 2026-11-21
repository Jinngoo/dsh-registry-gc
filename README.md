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

`Workspace#detachSession(id)` 也接好了（同样是幂等的），但如上所述它正常不会被调用——它留在代码里是为了将来注册表若暴露原始记录可以直接用。

## 用法

**自动**：挂载后，进程内首次创建 Agent 的 15 秒后自动跑一遍（`startDelaySeconds` 可调），只在确实有悬空 id 时才动手。

**手动**：模型可调 `registry_gc` 工具，默认 `dryRun: true` 只报告：

```jsonc
// registry_gc { dryRun: true }  ->  只读报告
{ "ok": true, "dryRun": true, "cleaned": 23, "archived": 23, "pinned": 0, "slots": 21,
  "workspaces": [{ "workspaceId": "...", "title": "DSH_Bot", "ids": 5 }] }

// registry_gc { dryRun: false } ->  真正清理
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

```
持久化里的会话: 70
archivedSessionIds: 26   -> 悬空 0
pinnedSessionIds: 0      -> 悬空 0
workspaces: 6            -> 悬空槽位 0
去重后需清理的会话数: 0
```

没有悬空 id 时插件是空操作——这本身就是幂等性验证。真正的清理会在用 `dsh-session-janitor` 删掉归档会话后，于下次启动自动完成。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`src/plan.ts` 是纯决策逻辑（无服务、无时钟），`src/index.ts` 只做装配。
