/**
 * The pure half: decide which registry ids are stale.
 *
 * A "stale" id is one the registry still records but session persistence no
 * longer holds. This module owns no services and no clock, so the decision can
 * be reasoned about — and tested — without a harness: give it the two sets and
 * it returns the difference plus the per-workspace breakdown that the caller
 * needs to act.
 *
 * @module @jinngoo/dsh-registry-gc/plan
 */

/** One workspace's stale slots, keyed by the workspace the id is accounted under. */
export interface StaleWorkspaceSlots {
  /** The workspace whose `sessionIds` still lists the id. */
  readonly workspaceId: string
  /** Display title, for the log line; the id is the authority. */
  readonly title: string
  /** Ids accounted under this workspace that persistence no longer holds. */
  readonly sessionIds: readonly string[]
}

/** Everything one pass would clean, computed without touching any service. */
export interface GcPlan {
  /** Ids in the global archive set whose session is gone. */
  readonly staleArchived: readonly string[]
  /** Ids in the global pin set whose session is gone. */
  readonly stalePinned: readonly string[]
  /** Per-workspace stale accounting slots. */
  readonly staleSlots: readonly StaleWorkspaceSlots[]
  /** Ids the run will actually touch (union of the three groups above). */
  readonly totalIds: number
}

/** The registry facts this decision needs, as plain data. */
export interface RegistrySnapshot {
  /** Every id persistence currently holds. */
  readonly liveSessionIds: ReadonlySet<string>
  /** The registry-global archive set, in registry order. */
  readonly archived: readonly string[]
  /** The registry-global pin set, in registry order. */
  readonly pinned: readonly string[]
  /** Workspaces and the session slots they account for. */
  readonly workspaces: readonly {
    readonly id: string
    readonly title: string
    readonly sessionIds: readonly string[]
  }[]
}

/**
 * Compute what a garbage-collection pass would remove.
 *
 * An id is stale when persistence no longer holds it. Both registry sets are
 * checked against the same live set, so an id that is both archived and pinned
 * is reported once in each set — the caller removes it from both, which is
 * idempotent on the registry side.
 *
 * The live set must come from session persistence, not from the filesystem:
 * persistence is what the registry itself validates membership against, so a
 * log file that exists but is unreadable counts as absent on both sides.
 *
 * **Workspace slots need no work here.** `Workspace#sessionIds` is a getter that
 * filters the durable record through the same membership check, so a slot whose
 * session is gone is already invisible to every caller — including this one.
 * The record is also pruned durably by any accepted mutation. Reporting such a
 * slot would mean inventing an id the registry will never hand out, so this
 * function reads the visible slots and can only ever report what it can see.
 * The `staleSlots` field is therefore always empty in practice; it is kept so a
 * future registry that exposes raw records needs no signature change.
 * @param snapshot - the registry's current ids and persistence's live ids.
 * @returns the stale ids grouped by where they are recorded.
 */
export function planGc(snapshot: RegistrySnapshot): GcPlan {
  const isStale = (id: string): boolean => !snapshot.liveSessionIds.has(id)

  const staleArchived = snapshot.archived.filter(isStale)
  const stalePinned = snapshot.pinned.filter(isStale)

  const staleSlots: StaleWorkspaceSlots[] = []
  for (const workspace of snapshot.workspaces) {
    const stale = workspace.sessionIds.filter(isStale)
    if (stale.length === 0) continue
    staleSlots.push({ workspaceId: workspace.id, title: workspace.title, sessionIds: stale })
  }

  // Count distinct ids: the same session can be archived, pinned, and accounted
  // under a workspace at once, and "how many sessions will this clean" should
  // say 1, not 3.
  const distinct = new Set<string>([...staleArchived, ...stalePinned])
  for (const slot of staleSlots) for (const id of slot.sessionIds) distinct.add(id)

  return { staleArchived, stalePinned, staleSlots, totalIds: distinct.size }
}

/** Whether a plan has any work to do. */
export function isEmptyPlan(plan: GcPlan): boolean {
  return plan.staleArchived.length === 0
    && plan.stalePinned.length === 0
    && plan.staleSlots.length === 0
}
