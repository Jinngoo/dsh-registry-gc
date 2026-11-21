# dsh-registry-gc

> DSH 注册表垃圾回收：把 `workspace.json` 里指向**已不存在会话**的悬空 id 清掉。

## 为什么需要它

`workspace.json` 在三处记录会话 id：

| 位置 | 日志删除后 | 谁负责清 |
|---|---|---|
| `global.archivedSessionIds` | **id 永久保留**，getter 无过滤 | **本插件** |
| `global.pinnedSessionIds` | **id 永久保留**，getter 无过滤 | **本插件** |
| `tables.workspaces[].sessionIds` | getter 实时 `candidateMatches` 过滤；且任何一次被接受的变更都会**持久化剪掉**失效槽位 | DSH 自己 |

前两行是源码事实：`workspaceRegistry.archivedSessionIds` 的 getter 直接 `return this.requireState().archivedSessionIds`，没有任何过滤。第三行同样有据：`WorkspaceEntity#sessionIds` 是 `this.record.sessionIds.filter(id => this.host.candidateMatches(...))`，而 `mutate()` 落盘前再 prune 一遍。

**所以本插件只做前两件。** 工作区槽位那一半 DSH 自己已经处理了——插件读到的是过滤后的视图，根本看不到悬空槽位，也就不该假装能清它。这个边界比「全都清」更窄，但它是正确的：不制造假的清理动作。

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
