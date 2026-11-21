import { describe, expect, it } from 'vitest'

import { isEmptyPlan, planGc, type RegistrySnapshot } from '../src/plan.ts'

/** A snapshot with the given stale/live split, everything else empty. */
function snapshot(parts: Partial<{
  live: string[]
  archived: string[]
  pinned: string[]
  workspaces: { id: string, title: string, sessionIds: string[] }[]
}>): RegistrySnapshot {
  return {
    liveSessionIds: new Set(parts.live ?? []),
    archived: parts.archived ?? [],
    pinned: parts.pinned ?? [],
    workspaces: parts.workspaces ?? [],
  }
}

describe('planGc', () => {
  it('reports nothing when every recorded id still has a session', () => {
    const plan = planGc(snapshot({
      live: ['a', 'b'],
      archived: ['a'],
      pinned: ['b'],
      workspaces: [{ id: 'w1', title: 'W', sessionIds: ['a', 'b'] }],
    }))

    expect(isEmptyPlan(plan)).toBe(true)
    expect(plan.totalIds).toBe(0)
  })

  it('finds a stale archived id', () => {
    const plan = planGc(snapshot({ live: ['a'], archived: ['a', 'gone'] }))

    expect(plan.staleArchived).toEqual(['gone'])
    expect(plan.totalIds).toBe(1)
  })

  it('finds a stale pinned id', () => {
    const plan = planGc(snapshot({ live: [], pinned: ['gone'] }))

    expect(plan.stalePinned).toEqual(['gone'])
    expect(plan.totalIds).toBe(1)
  })

  it('finds stale workspace slots and keeps the workspace breakdown', () => {
    const plan = planGc(snapshot({
      live: ['alive'],
      workspaces: [
        { id: 'w1', title: 'W1', sessionIds: ['alive', 'gone-1', 'gone-2'] },
        { id: 'w2', title: 'W2', sessionIds: ['alive'] },
      ],
    }))

    expect(plan.staleSlots).toHaveLength(1)
    expect(plan.staleSlots[0]).toEqual({ workspaceId: 'w1', title: 'W1', sessionIds: ['gone-1', 'gone-2'] })
    expect(plan.totalIds).toBe(2)
  })

  it('counts a session recorded in all three places once', () => {
    const plan = planGc(snapshot({
      live: [],
      archived: ['gone'],
      pinned: ['gone'],
      workspaces: [{ id: 'w1', title: 'W', sessionIds: ['gone'] }],
    }))

    // Three places to remove it from, one session to clean.
    expect(plan.staleArchived).toHaveLength(1)
    expect(plan.stalePinned).toHaveLength(1)
    expect(plan.staleSlots[0]?.sessionIds).toHaveLength(1)
    expect(plan.totalIds).toBe(1)
  })

  it('keeps registry order within each group', () => {
    const plan = planGc(snapshot({ live: [], archived: ['c', 'a', 'b'] }))

    expect(plan.staleArchived).toEqual(['c', 'a', 'b'])
  })

  it('treats an empty registry as nothing to do', () => {
    expect(isEmptyPlan(planGc(snapshot({})))).toBe(true)
  })
})
