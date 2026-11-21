import { describe, expect, it, vi } from 'vitest'

import { apply, Config } from '../src/index.ts'

/**
 * The assembly half: what the row actually calls on the registry.
 *
 * The plan module is tested in isolation; these tests exist because the risk
 * lives one layer up — calling the wrong registry method, mutating a set the
 * registry does not own, or touching a live session. A fake context records the
 * exact call sequence so the assertions are about behaviour, not shape.
 */

interface FakeWorkspace {
  id: string
  title: string
  /** The durable record the real entity owns; `sessionIds` is derived from it. */
  record: { sessionIds: string[] }
  sessionIds: readonly string[]
  detachSession: (id: string) => Promise<void>
}

/**
 * A context with only the services this row consumes.
 *
 * `sessionIds` mirrors the real entity: a getter that filters the durable record
 * through the live set on every read, rather than a stored array. Getting that
 * wrong in the fake would hide exactly the bug this suite is meant to catch.
 */
function makeContext(options: {
  live?: string[]
  archived?: string[]
  pinned?: string[]
  workspaces?: { id: string, title: string, sessionIds: string[] }[]
} = {}) {
  const live = options.live ?? []
  const liveSet = new Set(live)
  const archived = [...(options.archived ?? [])]
  const pinned = [...(options.pinned ?? [])]
  const calls: string[] = []

  const workspaces = (options.workspaces ?? []).map((workspace) => {
    const record = { sessionIds: [...workspace.sessionIds] }
    const fake: FakeWorkspace = {
      id: workspace.id,
      title: workspace.title,
      record,
      get sessionIds() {
        // Exactly what WorkspaceEntity#sessionIds does.
        return record.sessionIds.filter((id) => liveSet.has(id))
      },
      async detachSession(id: string) {
        calls.push(`detach:${workspace.id}:${id}`)
        const index = record.sessionIds.indexOf(id)
        if (index >= 0) record.sessionIds.splice(index, 1)
      },
    }
    return fake
  })

  const tools: { name: string, execute: (args: Record<string, unknown>) => Promise<unknown> }[] = []
  const listeners: { named: string, handler: () => void, options?: unknown }[] = []
  const timers: (() => void)[] = []

  const ctx = {
    sessionPersistence: {
      async list() {
        return live.map((id) => ({ header: { id, cwd: '/tmp' } }))
      },
    },
    workspaceRegistry: {
      get archivedSessionIds() { return archived },
      get pinnedSessionIds() { return pinned },
      list: () => workspaces,
      async unarchiveSession(id: string) {
        calls.push(`unarchive:${id}`)
        const index = archived.indexOf(id)
        if (index >= 0) archived.splice(index, 1)
      },
      async unpinSession(id: string) {
        calls.push(`unpin:${id}`)
        const index = pinned.indexOf(id)
        if (index >= 0) pinned.splice(index, 1)
      },
    },
    tools: {
      register(definition: { name: string, execute: (args: Record<string, unknown>) => Promise<unknown> }) {
        tools.push(definition)
        return () => {}
      },
    },
    on(named: string, handler: () => void, options?: unknown) {
      listeners.push({ named, handler, options })
      return () => {}
    },
    effect(fn: () => () => void) {
      timers.push(fn())
      return () => {}
    },
    logger: { info: () => {}, warn: () => {} },
  }

  return { ctx, calls, workspaces, tools, listeners, archived, pinned }
}

describe('apply', () => {
  it('registers exactly one tool and one global listener', () => {
    const fake = makeContext()

    apply(fake.ctx as never, { collectOnStart: true, startDelaySeconds: 0 })

    expect(fake.tools).toHaveLength(1)
    expect(fake.tools[0]?.name).toBe('registry_gc')
    expect(fake.listeners).toHaveLength(1)
    expect(fake.listeners[0]?.named).toBe('agent/created')
    expect(fake.listeners[0]?.options).toEqual({ global: true })
  })

  it('does not arm the automatic pass when collectOnStart is false', () => {
    const fake = makeContext()

    apply(fake.ctx as never, { collectOnStart: false, startDelaySeconds: 0 })

    expect(fake.listeners).toHaveLength(0)
    expect(fake.tools).toHaveLength(1)
  })

  it('reports without writing when asked for a dry run', async () => {
    const fake = makeContext({
      live: ['alive'],
      archived: ['gone'],
      pinned: ['gone'],
      workspaces: [{ id: 'w1', title: 'W', sessionIds: ['alive', 'gone'] }],
    })
    apply(fake.ctx as never, { collectOnStart: false, startDelaySeconds: 0 })

    const result = await fake.tools[0]?.execute({ dryRun: true })

    expect(result).toMatchObject({ ok: true, dryRun: true, cleaned: 1, archived: 1, pinned: 1, slots: 0 })
    expect(fake.calls).toEqual([])
    expect(fake.archived).toEqual(['gone'])
    // Dry run leaves the durable record alone (the getter hides the stale id).
    expect(fake.workspaces[0]?.record.sessionIds).toEqual(['alive', 'gone'])
  })

  it('defaults to a dry run when the argument is omitted', async () => {
    const fake = makeContext({ live: [], archived: ['gone'] })
    apply(fake.ctx as never, { collectOnStart: false, startDelaySeconds: 0 })

    const result = await fake.tools[0]?.execute({})

    expect(result).toMatchObject({ dryRun: true, cleaned: 1 })
    expect(fake.calls).toEqual([])
  })

  it('leaves workspace slots alone, because the registry already hides stale ones', async () => {
    // The real `Workspace#sessionIds` getter filters the durable record through
    // the live set, so a slot whose session is gone is never visible to this row
    // — and the record is pruned durably by any accepted mutation. Asking the
    // registry to detach an id it will not hand out is not something this row can
    // even express, so what matters is that it does not try.
    const fake = makeContext({
      live: ['alive'],
      archived: ['gone'],
      workspaces: [{ id: 'w1', title: 'W', sessionIds: ['gone', 'alive'] }],
    })
    apply(fake.ctx as never, { collectOnStart: false, startDelaySeconds: 0 })

    const result = await fake.tools[0]?.execute({ dryRun: true }) as { slots: number, archived: number }

    expect(result.archived).toBe(1)
    expect(result.slots).toBe(0)
    // The durable record still holds it; the getter hides it. Removing the
    // archive entry is what this row can actually do.
    expect(fake.workspaces[0]?.record.sessionIds).toEqual(['gone', 'alive'])
  })

  it('removes the global sets in a fixed order and is idempotent on a second pass', async () => {
    const fake = makeContext({ live: [], archived: ['gone'], pinned: ['gone'] })
    apply(fake.ctx as never, { collectOnStart: false, startDelaySeconds: 0 })

    await fake.tools[0]?.execute({ dryRun: false })
    expect(fake.calls).toEqual(['unarchive:gone', 'unpin:gone'])

    const second = await fake.tools[0]?.execute({ dryRun: false }) as { cleaned: number }
    expect(second.cleaned).toBe(0)
    expect(fake.calls).toEqual(['unarchive:gone', 'unpin:gone'])
  })

  it('never touches a session that persistence still holds', async () => {
    const fake = makeContext({
      live: ['alive'],
      archived: ['alive'],
      pinned: ['alive'],
      workspaces: [{ id: 'w1', title: 'W', sessionIds: ['alive'] }],
    })
    apply(fake.ctx as never, { collectOnStart: false, startDelaySeconds: 0 })

    const result = await fake.tools[0]?.execute({ dryRun: false })

    expect(result).toMatchObject({ cleaned: 0 })
    expect(fake.calls).toEqual([])
  })

  it('is a no-op on an empty registry', async () => {
    const fake = makeContext()
    apply(fake.ctx as never, { collectOnStart: false, startDelaySeconds: 0 })

    const result = await fake.tools[0]?.execute({ dryRun: false })

    expect(result).toMatchObject({ ok: true, cleaned: 0, archived: 0, pinned: 0, slots: 0 })
    expect(fake.calls).toEqual([])
  })

  it('keeps going when a workspace in the snapshot disappears before the write', async () => {
    // Slot work is normally unreachable, but the code path exists for a registry
    // that does expose stale slots. Simulate one that reports a stale slot and is
    // gone by the time the write runs: the pass must record the loss and finish
    // the remaining work rather than throwing.
    const fake = makeContext({ live: [], archived: ['gone'] })
    apply(fake.ctx as never, { collectOnStart: false, startDelaySeconds: 0 })

    // Inject a stale slot directly into the plan by faking the registry's view.
    const registry = fake.ctx.workspaceRegistry as {
      list: () => unknown[]
    }
    const originalList = registry.list
    let call = 0
    registry.list = () => {
      call += 1
      // First call: report a workspace whose slot looks stale to the planner
      // (the fake getter hides live ids, so force one through).
      if (call === 1) {
        return [{
          id: 'w-vanish',
          title: 'Vanishing',
          get sessionIds() { return ['orphan'] },
          detachSession: async () => { throw new Error('must not be called') },
        }]
      }
      return []
    }

    const result = await fake.tools[0]?.execute({ dryRun: false }) as { ok: boolean, errors: string[] }

    // The archive work still happened even though the workspace vanished.
    expect(fake.calls).toEqual(['unarchive:gone'])
    expect(result.errors.join(' ')).toContain('w-vanish')
    registry.list = originalList
  })

  it('does not fire the automatic pass before the delay elapses', async () => {
    vi.useFakeTimers()
    try {
      const fake = makeContext({ live: [], archived: ['gone'] })
      apply(fake.ctx as never, { collectOnStart: true, startDelaySeconds: 15 })

      fake.listeners[0]?.handler()
      expect(fake.calls).toEqual([])

      vi.advanceTimersByTime(14_999)
      await Promise.resolve()
      expect(fake.calls).toEqual([])

      vi.advanceTimersByTime(1)
      await vi.runOnlyPendingTimersAsync()
      expect(fake.calls).toContain('unarchive:gone')
    } finally {
      vi.useRealTimers()
    }
  })

  it('arms only once, so a second Agent creation schedules nothing', async () => {
    vi.useFakeTimers()
    try {
      const fake = makeContext({ live: [], archived: ['gone'] })
      apply(fake.ctx as never, { collectOnStart: true, startDelaySeconds: 1 })

      fake.listeners[0]?.handler()
      fake.listeners[0]?.handler()
      await vi.runOnlyPendingTimersAsync()

      expect(fake.calls.filter((call) => call === 'unarchive:gone')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Config', () => {
  it('defaults to collecting on start after a short delay', () => {
    const resolved = new Config({})
    expect(resolved.collectOnStart).toBe(true)
    expect(resolved.startDelaySeconds).toBe(15)
  })
})
