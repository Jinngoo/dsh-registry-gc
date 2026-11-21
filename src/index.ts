/**
 * Registry garbage collection.
 *
 * `workspace.json` records session ids in three places: the global archive set,
 * the global pin set, and each workspace's accounting slots. Deleting a session
 * log outside the harness (which is what a cleanup skill does) leaves those ids
 * behind. Membership is filtered on read, so the *symptom* is invisible — but the
 * ids persist, are re-read and re-validated on every start, and never shrink.
 *
 * This row removes them through the two public registry methods that are
 * explicitly safe for a session that no longer exists:
 *
 * - `Workspace#detachSession` — "Idempotent: an id not on the account resolves
 *   without writing … Never touches the session's own stored log."
 * - `WorkspaceRegistry#unarchiveSession` — "runs no session-existence check
 *   because removing an id cannot introduce an unknown one, so an entry whose
 *   session is gone still resolves."
 *
 * It never writes `workspace.json` directly. That file carries a
 * pending-mutation marker and one-time bootstrap logic, and an inconsistent
 * write is read as corruption.
 *
 * @module @jinngoo/dsh-registry-gc
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Side-effect type imports: each package augments `Context` from its own entry
// module (`declare module '@deepseek-ai/cordis'`), so the services only appear on
// the type once the owning package is referenced.
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

import { isEmptyPlan, planGc, type GcPlan, type RegistrySnapshot } from './plan.js'

export { planGc, isEmptyPlan } from './plan.js'
export type { GcPlan, RegistrySnapshot, StaleWorkspaceSlots } from './plan.js'

/** Host-plane services this row consumes. */
export const inject = ['tools', 'sessionPersistence', 'workspaceRegistry']

/** Row configuration. */
export interface Config {
  /** Collect once on the first Agent creation of the process. */
  readonly collectOnStart: boolean
  /** Seconds to wait after the first Agent appears before the automatic pass. */
  readonly startDelaySeconds: number
  /**
   * Also rewrite every workspace record once, so the registry prunes the slots
   * it hides from us.
   *
   * Off by default: it restamps every workspace's `updatedAt`, which changes
   * `updatedAt` ordering for any consumer that sorts by it. Turn it on when
   * stale slots matter more than that timestamp.
   */
  readonly sweepSlotsOnStart: boolean
}

export const Config: Schema<Config> = Schema.object({
  collectOnStart: Schema.boolean().default(true),
  startDelaySeconds: Schema.number().default(15),
  sweepSlotsOnStart: Schema.boolean().default(false),
})

export const name = 'registry-gc'

/**
 * One pass's outcome, also the tool's result shape.
 *
 * The index signature lets the value satisfy the tool registry's `JsonValue`
 * contract without a cast; the named fields stay documented for readers.
 */
interface GcResult {
  readonly [key: string]: unknown
  readonly ok: boolean
  readonly dryRun: boolean
  readonly cleaned: number
  readonly archived: number
  readonly pinned: number
  readonly slots: number
  /** Workspace records rewritten so their hidden slots were pruned. */
  readonly swept: number
  readonly workspaces: readonly { readonly workspaceId: string; readonly title: string; readonly ids: number }[]
  readonly errors: readonly string[]
}

/**
 * Install the collection tool and the optional automatic pass.
 * @param ctx - the row's host-plane context.
 * @param config - the resolved row configuration.
 */
export function apply(ctx: Context, config: Config): void {
  /**
   * Read the registry and persistence as plain data.
   *
   * `sessionPersistence.list()` returns header-only snapshots — it does not read
   * event logs — so this is cheap even with hundreds of stored sessions, and it
   * is the same source the registry itself validates membership against.
   *
   * `workspace.sessionIds` is the *filtered* view: the real getter hides ids
   * whose session is gone, and any accepted mutation prunes them from the
   * durable record. So the slot list read here can only ever contain live ids,
   * which is why `planGc` finds no stale slots — the registry already handles
   * that half. The two global sets are the ones nothing filters, and they are
   * what this row exists for.
   */
  const snapshot = async (): Promise<RegistrySnapshot> => {
    const stored = await ctx.sessionPersistence.list()
    const liveSessionIds = new Set<string>(stored.map((entry) => entry.header.id))
    const registry = ctx.workspaceRegistry
    return {
      liveSessionIds,
      archived: [...registry.archivedSessionIds],
      pinned: [...registry.pinnedSessionIds],
      workspaces: registry.list().map((workspace) => ({
        id: workspace.id,
        title: workspace.title,
        sessionIds: [...workspace.sessionIds],
      })),
    }
  }

  /**
   * Apply one plan.
   *
   * The workspace-slot loop is normally empty (see `snapshot`), but it stays:
   * the registry may one day expose raw records, and the cost of an empty loop is
   * one comparison. Global sets are removed after slots so an interrupted pass
   * leaves the smaller, resumable remainder — every call is idempotent.
   * @param plan - what to remove.
   * @param dryRun - report only.
   * @param sweepSlots - rewrite every workspace record so `mutate` prunes the
   *   slots it hides from this row. Opt-in because it restamps `updatedAt`.
   */
  const collect = async (plan: GcPlan, dryRun: boolean, sweepSlots = false): Promise<GcResult> => {
    const errors: string[] = []
    let archived = 0
    let pinned = 0
    let slots = 0
    let swept = 0

    const workspaces = plan.staleSlots.map((slot) => ({
      workspaceId: slot.workspaceId,
      title: slot.title,
      ids: slot.sessionIds.length,
    }))

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        cleaned: plan.totalIds,
        archived: plan.staleArchived.length,
        pinned: plan.stalePinned.length,
        slots: plan.staleSlots.reduce((sum, slot) => sum + slot.sessionIds.length, 0),
        swept: 0,
        workspaces,
        errors,
      }
    }

    for (const slot of plan.staleSlots) {
      const workspace = ctx.workspaceRegistry.list().find((candidate) => candidate.id === slot.workspaceId)
      if (workspace === undefined) {
        errors.push(`工作区 ${slot.workspaceId} 在本次清点后消失了，跳过其 ${slot.sessionIds.length} 个槽位`)
        continue
      }
      for (const id of slot.sessionIds) {
        try {
          await workspace.detachSession(id as SessionId)
          slots += 1
        } catch (error) {
          errors.push(`detach ${id}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    for (const id of plan.staleArchived) {
      try {
        await ctx.workspaceRegistry.unarchiveSession(id as SessionId)
        archived += 1
      } catch (error) {
        errors.push(`unarchive ${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    for (const id of plan.stalePinned) {
      try {
        await ctx.workspaceRegistry.unpinSession(id as SessionId)
        pinned += 1
      } catch (error) {
        errors.push(`unpin ${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Last step: walk every workspace and re-apply its own title.
    //
    // Why this is needed: `Workspace#sessionIds` is a getter that filters the
    // durable record through `candidateMatches`, so a slot whose session is gone
    // is invisible — the planner above literally cannot see it, and no public API
    // exposes the raw array. The only way to drop those slots is to make the
    // registry write the record, because `mutate()` prunes non-matching
    // candidates on every accepted mutation.
    //
    // Re-applying the same title parses as a change: `setTitle` builds a fresh
    // object (`{ ...record, title }`), so `mutate`'s `changed === current`
    // identity check never short-circuits and the write happens. The pruning is a
    // side effect of that write, not something the title participates in.
    //
    // Known cost, accepted deliberately: `mutate()` also restamps `updatedAt`, so
    // every swept workspace looks "touched now". That only affects ordering, and
    // only for callers that sort by it.
    if (sweepSlots) {
      for (const workspace of ctx.workspaceRegistry.list()) {
        try {
          await workspace.setTitle(workspace.title)
          swept += 1
        } catch (error) {
          errors.push(`sweep ${workspace.id}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    ctx.logger.info(
      `registry-gc: 清理 ${String(plan.totalIds)} 个悬空 id`
      + `（归档 ${String(archived)}、置顶 ${String(pinned)}、工作区槽位 ${String(slots)}）`
      + `${sweepSlots ? `，并重写 ${String(swept)} 个工作区记录以剪除不可见槽位` : ''}`,
    )

    return {
      ok: errors.length === 0,
      dryRun: false,
      cleaned: plan.totalIds,
      archived,
      pinned,
      slots,
      swept,
      workspaces,
      errors,
    }
  }

  ctx.tools.register(defineTool({
    name: 'registry_gc',
    description:
      '清理 workspace.json 里指向已不存在会话的悬空 id：全局归档集合与置顶集合（这两处不受任何过滤，会永久残留）。'
      + '通过官方 unarchiveSession / unpinSession 通道完成，绝不直接改注册表文件。'
      + 'sweepSlots=true 时会额外重写每个工作区记录一次——工作区槽位被 getter 过滤后本插件看不见，'
      + '只能靠触发一次写操作让注册表自己剪除；代价是所有工作区的 updatedAt 会被刷新。'
      + 'dryRun=true（默认）只报告，不改动。',
    parameters: {
      dryRun: { type: 'boolean' as const, description: '只报告，不做任何改动（默认 true）' },
      sweepSlots: {
        type: 'boolean' as const,
        description: '额外重写每个工作区记录以剪除不可见槽位（会刷新 updatedAt，默认 false）',
      },
    },
    output: {
      schema: { type: 'json' } as const,
      render: (_args: unknown, value: unknown) => [
        { type: 'text' as const, text: JSON.stringify(value, null, 2) },
      ],
    },
    async execute(args): Promise<JsonValue> {
      const dryRun = args.dryRun !== false
      const sweepSlots = args.sweepSlots === true
      const plan = planGc(await snapshot())
      const result = await collect(plan, dryRun, sweepSlots)
      // GcResult is a plain JSON object; the assertion is only about the
      // recursive JsonValue union, not about shape.
      return result as unknown as JsonValue
    },
  }))

  if (!config.collectOnStart) return

  // One process-wide pass shortly after the first Agent appears. `global: true`
  // keeps this a single listener instead of one per Agent scope. The delay lets
  // the first turn start before the registry is touched, so a slow disk never
  // delays session creation.
  //
  // The empty-plan shortcut only skips the *global set* work: a slot sweep is
  // independent of the plan (the plan cannot even see the slots), so skipping it
  // on an empty plan would leave those slots forever.
  let armed = true
  ctx.on('agent/created', () => {
    if (!armed) return
    armed = false
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const plan = planGc(await snapshot())
          if (isEmptyPlan(plan) && !config.sweepSlotsOnStart) return
          await collect(plan, false, config.sweepSlotsOnStart)
        } catch (error) {
          ctx.logger.warn(
            `registry-gc: 自动清理失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      })()
    }, config.startDelaySeconds * 1000)
    ctx.effect(() => () => clearTimeout(timer), 'registry-gc.startTimer')
    return undefined
  }, { global: true })
}
