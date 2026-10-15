'use strict'

/**
 * Behavioural tests for the browser half.
 *
 * The real shipping source (`buildBody()` — the exact text that becomes
 * `lib/client.js`) runs in a VM against fake `sessions` / `workspaces`
 * services and a fake host route, with a deterministic clock standing in for
 * `setTimeout`. This exercises the whole controller: state sync, the
 * score-change gate that protects a manual drag, minimal-move application and
 * graceful degradation when the host route is missing.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')

const { buildBody } = require('../build.cjs')

/** Build one workspace projection row. */
const workspace = (workspaceId, sessionIds) => ({ workspaceId, sessionIds })

/** Build one eligible session summary. */
const summary = (id, updatedAt, extra) => ({ id, updatedAt, blank: false, ...extra })

/** Let queued promise jobs and timers drain. */
async function settle() {
  for (let pass = 0; pass < 8; pass += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** A deterministic stand-in for the browser's timer queue. */
function createClock() {
  const timeouts = new Map()
  const intervals = new Map()
  let nextId = 1
  return {
    setTimeout: (callback) => {
      const id = nextId
      nextId += 1
      timeouts.set(id, callback)
      return id
    },
    clearTimeout: (id) => {
      timeouts.delete(id)
    },
    setInterval: (callback) => {
      const id = nextId
      nextId += 1
      intervals.set(id, callback)
      return id
    },
    clearInterval: (id) => {
      intervals.delete(id)
    },
    async flush() {
      for (let guard = 0; guard < 25 && timeouts.size > 0; guard += 1) {
        const batch = [...timeouts.values()]
        timeouts.clear()
        for (const callback of batch) callback()
        await settle()
      }
    },
    /** Fire every registered interval once, as a real clock would. */
    async tickIntervals() {
      for (const callback of [...intervals.values()]) callback()
      await settle()
    },
    intervalCount: () => intervals.size,
  }
}

/**
 * Load the shipping browser half against fake services.
 * @param options - workspaces, summaries, archived ids, host state, failure mode.
 * @returns a harness exposing the sorter and its observable effects.
 */
function createHarness(options) {
  const { workspaces, summaries, archived = [] } = options
  const hostState = options.hostState ?? { sortMode: 'manual', pinned: [] }
  const failApi = options.failApi === true
  const titles = options.titles ?? {}

  const items = workspaces.map((entry) => ({
    workspaceId: entry.workspaceId,
    sessionIds: [...entry.sessionIds],
    ...(titles[entry.workspaceId] === undefined ? {} : { title: titles[entry.workspaceId] }),
  }))
  const inserts = []
  const apiCalls = []
  const workspaceListeners = new Set()
  const sessionListeners = new Set()
  const disposers = []
  const clock = createClock()

  const workspacesStore = {
    list: {
      getSnapshot: () => ({
        items,
        archivedSessionIds: [...archived],
        pinnedSessionIds: [],
      }),
      subscribe: (listener) => {
        workspaceListeners.add(listener)
        return () => workspaceListeners.delete(listener)
      },
    },
    async insertBefore(workspaceId, beforeWorkspaceId) {
      inserts.push({ workspaceId, beforeWorkspaceId })
      const from = items.findIndex((item) => item.workspaceId === workspaceId)
      if (from === -1) return
      const [entry] = items.splice(from, 1)
      const at =
        beforeWorkspaceId === undefined
          ? items.length
          : items.findIndex((item) => item.workspaceId === beforeWorkspaceId)
      items.splice(at === -1 ? items.length : at, 0, entry)
    },
  }

  const sessionsStore = {
    list: {
      getSnapshot: () => ({
        ids: Object.keys(summaries),
        byId: summaries,
        phase: 'ready',
        projectionsBySession: {},
      }),
      subscribe: (listener) => {
        sessionListeners.add(listener)
        return () => sessionListeners.delete(listener)
      },
    },
  }

  const ctx = {
    get: (name) =>
      name === 'sessions' ? sessionsStore : name === 'workspaces' ? workspacesStore : undefined,
    effect: (callback) => {
      disposers.push(callback())
    },
  }

  const fetchStub = async (url, init) => {
    const method = String(url).split('/').pop()
    const body = init !== undefined && init.body !== undefined ? JSON.parse(init.body) : {}
    apiCalls.push(method)
    if (failApi) return { ok: false, status: 503, json: async () => ({ ok: false }) }
    const reply = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
    switch (method) {
      case 'state':
        return reply({ sortMode: hostState.sortMode, pinned: [...hostState.pinned] })
      case 'sortMode':
        hostState.sortMode = body.mode
        return reply({ sortMode: hostState.sortMode, pinned: [...hostState.pinned] })
      case 'pin':
        hostState.pinned = [
          body.workspaceId,
          ...hostState.pinned.filter((id) => id !== body.workspaceId),
        ]
        return reply({ sortMode: hostState.sortMode, pinned: [...hostState.pinned] })
      case 'unpin':
        hostState.pinned = hostState.pinned.filter((id) => id !== body.workspaceId)
        return reply({ sortMode: hostState.sortMode, pinned: [...hostState.pinned] })
      default:
        return { ok: false, status: 404, json: async () => ({ ok: false }) }
    }
  }

  const moduleObject = { exports: {} }
  const focusListeners = new Set()
  const fakeWindow = {
    addEventListener: (type, listener) => {
      if (type === 'focus') focusListeners.add(listener)
    },
    removeEventListener: (type, listener) => {
      if (type === 'focus') focusListeners.delete(listener)
    },
  }
  const context = vm.createContext({
    require: () => ({}),
    module: moduleObject,
    exports: moduleObject.exports,
    fetch: fetchStub,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    console,
    window: fakeWindow,
  })
  new vm.Script(buildBody(), { filename: 'dsh-workspace-sort.client.body.js' }).runInContext(context)
  const api = moduleObject.exports

  const order = () => items.map((item) => item.workspaceId)

  return {
    api,
    hostState,
    inserts,
    apiCalls,
    clock,
    order,
    sorter: () => api.getSorter(),
    /** Fire every registered interval once, as a real clock would. */
    async poll() {
      await clock.tickIntervals()
      await settle()
    },
    /** Fire every registered window focus listener, as a real window would. */
    async focus() {
      for (const listener of [...focusListeners]) listener()
      await settle()
    },
    /** Start the client half and let its state fetch settle. */
    async start() {
      api.apply(ctx)
      await settle()
    },
    /** Fire the debounce timer and let the resulting writes settle. */
    async tick() {
      await clock.flush()
      await settle()
    },
    /** Advance one session's activity and notify subscribers, as the sidebar does. */
    async advance(id, updatedAt) {
      summaries[id] = { ...summaries[id], updatedAt }
      for (const listener of [...sessionListeners]) listener()
      await this.tick()
    },
    /** Simulate a user drag landing a new order, then notify subscribers. */
    async dragTo(nextIds) {
      const byId = new Map(items.map((item) => [item.workspaceId, item]))
      items.length = 0
      for (const id of nextIds) items.push(byId.get(id))
      for (const listener of [...workspaceListeners]) listener()
      await this.tick()
    },
    dispose() {
      for (const dispose of disposers) if (typeof dispose === 'function') dispose()
    },
  }
}

test('manual mode (the default) never reorders', async () => {
  const harness = createHarness({
    workspaces: [workspace('a', ['s1']), workspace('b', ['s2'])],
    summaries: { s1: summary('s1', 100), s2: summary('s2', 900) },
  })
  await harness.start()
  await harness.tick()
  assert.deepEqual(harness.order(), ['a', 'b'])
  assert.deepEqual(harness.inserts, [])
  harness.dispose()
})

test('switching to "updated" sorts immediately and persists through the host route', async () => {
  const harness = createHarness({
    workspaces: [workspace('a', ['s1']), workspace('b', ['s2'])],
    summaries: { s1: summary('s1', 100), s2: summary('s2', 900) },
  })
  await harness.start()
  await harness.sorter().setMode('updated')
  await harness.tick()
  assert.deepEqual(harness.order(), ['b', 'a'])
  assert.equal(harness.hostState.sortMode, 'updated')
  assert.ok(harness.inserts.length > 0)
  harness.dispose()
})

test('a pinned workspace leads even when another workspace is far more recent', async () => {
  const harness = createHarness({
    workspaces: [workspace('a', ['s1']), workspace('b', ['s2'])],
    summaries: { s1: summary('s1', 100), s2: summary('s2', 900) },
    hostState: { sortMode: 'updated', pinned: ['a'] },
  })
  await harness.start()
  await harness.tick()
  assert.deepEqual(harness.order(), ['a', 'b'])
  harness.dispose()
})

test('two pinned workspaces order by time among themselves, ahead of the rest', async () => {
  const harness = createHarness({
    workspaces: [
      workspace('w1', ['s1']),
      workspace('w2', ['s2']),
      workspace('w3', ['s3']),
    ],
    summaries: {
      s1: summary('s1', 200),
      s2: summary('s2', 800),
      s3: summary('s3', 100_000),
    },
    hostState: { sortMode: 'updated', pinned: ['w1', 'w2'] },
  })
  await harness.start()
  await harness.tick()
  assert.deepEqual(harness.order(), ['w2', 'w1', 'w3'])
  harness.dispose()
})

test('new session activity reorders the workspaces', async () => {
  const harness = createHarness({
    workspaces: [workspace('a', ['s1']), workspace('b', ['s2'])],
    summaries: { s1: summary('s1', 100), s2: summary('s2', 900) },
    hostState: { sortMode: 'updated', pinned: [] },
  })
  await harness.start()
  await harness.tick()
  assert.deepEqual(harness.order(), ['b', 'a'])
  await harness.advance('s1', 5_000)
  assert.deepEqual(harness.order(), ['a', 'b'])
  harness.dispose()
})

test('a manual drag survives while no score changes', async () => {
  const harness = createHarness({
    workspaces: [workspace('a', ['s1']), workspace('b', ['s2'])],
    summaries: { s1: summary('s1', 900), s2: summary('s2', 100) },
    hostState: { sortMode: 'updated', pinned: [] },
  })
  await harness.start()
  await harness.tick()
  assert.deepEqual(harness.order(), ['a', 'b'])

  await harness.dragTo(['b', 'a'])
  assert.deepEqual(harness.order(), ['b', 'a'], 'the drag must not be reverted')

  await harness.dragTo(['b', 'a'])
  assert.deepEqual(harness.order(), ['b', 'a'])

  // ...but the next real activity does re-sort.
  await harness.advance('s1', 6_000)
  assert.deepEqual(harness.order(), ['a', 'b'])
  harness.dispose()
})

test('an explicit "sort now" overrides the score-change gate', async () => {
  const harness = createHarness({
    workspaces: [workspace('a', ['s1']), workspace('b', ['s2'])],
    summaries: { s1: summary('s1', 900), s2: summary('s2', 100) },
    hostState: { sortMode: 'updated', pinned: [] },
  })
  await harness.start()
  await harness.tick()
  await harness.dragTo(['b', 'a'])
  assert.deepEqual(harness.order(), ['b', 'a'])
  await harness.sorter().sortNow()
  await harness.tick()
  assert.deepEqual(harness.order(), ['a', 'b'])
  harness.dispose()
})

test('blank, archived and subagent sessions never pull a workspace up', async () => {
  const harness = createHarness({
    workspaces: [
      workspace('blank', ['s1']),
      workspace('archived', ['s2']),
      workspace('subagent', ['s3']),
      workspace('live', ['s4']),
    ],
    summaries: {
      s1: summary('s1', 900, { blank: true }),
      s2: summary('s2', 800),
      s3: summary('s3', 700, { origin: 'subagent' }),
      s4: summary('s4', 100),
    },
    archived: ['s2'],
    hostState: { sortMode: 'updated', pinned: [] },
  })
  await harness.start()
  await harness.tick()
  assert.deepEqual(harness.order(), ['live', 'blank', 'archived', 'subagent'])
  harness.dispose()
})

test('workspaces without eligible sessions sink and keep their relative order', async () => {
  const harness = createHarness({
    workspaces: [
      workspace('e1', []),
      workspace('live', ['s1']),
      workspace('e2', []),
    ],
    summaries: { s1: summary('s1', 100) },
    hostState: { sortMode: 'updated', pinned: [] },
  })
  await harness.start()
  await harness.tick()
  assert.deepEqual(harness.order(), ['live', 'e1', 'e2'])
  harness.dispose()
})

test('pinning works while automatic sorting is off, and does not apply time order', async () => {
  const harness = createHarness({
    workspaces: [workspace('a', ['s1']), workspace('b', ['s2']), workspace('c', ['s3'])],
    summaries: {
      s1: summary('s1', 100),
      s2: summary('s2', 900),
      s3: summary('s3', 500),
    },
    hostState: { sortMode: 'manual', pinned: [] },
  })
  await harness.start()
  await harness.tick()
  // Manual mode: the user's own order stands, despite b being the most recent.
  assert.deepEqual(harness.order(), ['a', 'b', 'c'])

  await harness.sorter().pin('c')
  await harness.tick()
  // The pin takes effect; the unpinned rows keep their order rather than
  // sorting by time (which would put b before a).
  assert.deepEqual(harness.order(), ['c', 'a', 'b'])
  assert.equal(harness.hostState.sortMode, 'manual')

  await harness.sorter().unpin('c')
  await harness.tick()
  // Unpinning does not restore a remembered position — it only drops the pin,
  // matching the shipped Session-level rule ("取消置顶不改变保存的位置").
  assert.deepEqual(harness.order(), ['c', 'a', 'b'])
  assert.deepEqual(harness.hostState.pinned, [])
  harness.dispose()
})

test('togglePin flips one workspace and reports its state', async () => {
  const harness = createHarness({
    // 'b' is ahead of 'a' in manual order, so pinning 'a' visibly lifts it.
    workspaces: [workspace('b', ['s2']), workspace('a', ['s1'])],
    summaries: { s1: summary('s1', 100), s2: summary('s2', 900) },
    hostState: { sortMode: 'manual', pinned: [] },
  })
  await harness.start()
  assert.equal(harness.sorter().isPinned('a'), false)
  assert.deepEqual(harness.order(), ['b', 'a'])

  await harness.sorter().togglePin('a')
  await harness.tick()
  assert.equal(harness.sorter().isPinned('a'), true)
  assert.deepEqual(harness.order(), ['a', 'b'])

  await harness.sorter().togglePin('a')
  await harness.tick()
  assert.equal(harness.sorter().isPinned('a'), false)
  // Unpinning drops the pin without restoring a remembered slot.
  assert.deepEqual(harness.order(), ['a', 'b'])
  harness.dispose()
})

test('switching to manual freezes the current order instead of undoing it', async () => {
  const harness = createHarness({
    workspaces: [workspace('a', ['s1']), workspace('b', ['s2'])],
    summaries: { s1: summary('s1', 100), s2: summary('s2', 900) },
    hostState: { sortMode: 'updated', pinned: [] },
  })
  await harness.start()
  await harness.tick()
  assert.deepEqual(harness.order(), ['b', 'a'])

  await harness.sorter().setMode('manual')
  await harness.tick()
  assert.deepEqual(harness.order(), ['b', 'a'], 'the sorted order is frozen, not reverted')

  // Further activity must not move anything while manual ordering is active.
  await harness.advance('s1', 50_000)
  assert.deepEqual(harness.order(), ['b', 'a'])
  harness.dispose()
})

test('the workspace title is available for the row menu', async () => {
  const harness = createHarness({
    workspaces: [workspace('a', ['s1'])],
    summaries: { s1: summary('s1', 100) },
    titles: { a: 'deepseek' },
  })
  await harness.start()
  assert.equal(harness.sorter().titleOf('a'), 'deepseek')
  assert.equal(harness.sorter().titleOf('missing'), undefined)
  harness.dispose()
})

test('pinning and unpinning from the UI take effect', async () => {
  const harness = createHarness({
    workspaces: [workspace('a', ['s1']), workspace('b', ['s2'])],
    summaries: { s1: summary('s1', 100), s2: summary('s2', 900) },
    hostState: { sortMode: 'updated', pinned: [] },
  })
  await harness.start()
  await harness.tick()
  assert.deepEqual(harness.order(), ['b', 'a'])

  await harness.sorter().pin('a')
  await harness.tick()
  assert.deepEqual(harness.order(), ['a', 'b'])
  assert.deepEqual(harness.hostState.pinned, ['a'])

  await harness.sorter().unpin('a')
  await harness.tick()
  assert.deepEqual(harness.order(), ['b', 'a'])
  assert.deepEqual(harness.hostState.pinned, [])
  harness.dispose()
})

test('a missing host route degrades to no auto sorting instead of throwing', async () => {
  const harness = createHarness({
    workspaces: [workspace('a', ['s1']), workspace('b', ['s2'])],
    summaries: { s1: summary('s1', 100), s2: summary('s2', 900) },
    failApi: true,
  })
  await harness.start()
  await harness.tick()
  assert.deepEqual(harness.order(), ['a', 'b'])
  assert.deepEqual(harness.inserts, [])
  assert.equal(harness.sorter().state.ready, false)
  harness.dispose()
})

test('a reorder only ever emits moves that reproduce the computed order', async () => {
  const harness = createHarness({
    workspaces: [
      workspace('a', ['s1']),
      workspace('b', ['s2']),
      workspace('c', ['s3']),
      workspace('d', ['s4']),
    ],
    summaries: {
      s1: summary('s1', 100),
      s2: summary('s2', 400),
      s3: summary('s3', 300),
      s4: summary('s4', 200),
    },
    hostState: { sortMode: 'updated', pinned: [] },
  })
  await harness.start()
  await harness.tick()
  assert.deepEqual(harness.order(), ['b', 'c', 'd', 'a'])
  assert.deepEqual(harness.inserts, [
    { workspaceId: 'b', beforeWorkspaceId: 'a' },
    { workspaceId: 'c', beforeWorkspaceId: 'a' },
    { workspaceId: 'd', beforeWorkspaceId: 'a' },
  ])
  harness.dispose()
})

test('the client half reports failure instead of throwing when services are absent', async () => {
  const moduleObject = { exports: {} }
  const context = vm.createContext({
    require: () => ({}),
    module: moduleObject,
    exports: moduleObject.exports,
    fetch: async () => ({ ok: false, status: 503, json: async () => ({ ok: false }) }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    window: {},
  })
  new vm.Script(buildBody(), { filename: 'dsh-workspace-sort.client.body.js' }).runInContext(context)
  const api = moduleObject.exports
  assert.doesNotThrow(() => api.apply({ get: () => undefined, effect: () => {} }))
  assert.equal(api.getSorter(), undefined)
  // Spread into this realm: the bundle's array has the VM's prototypes.
  assert.deepEqual([...api.inject], ['sessions', 'workspaces'])
})

test('the poll converges an out-of-band pin change without any user action', async () => {
  const harness = createHarness({
    workspaces: [workspace('a', ['s1']), workspace('b', ['s2'])],
    summaries: { s1: summary('s1', 100), s2: summary('s2', 900) },
    hostState: { sortMode: 'updated', pinned: [] },
  })
  await harness.start()
  await harness.tick()
  assert.deepEqual(harness.order(), ['b', 'a'])

  // Something outside this window pinned 'a' (hand-edited state, another window).
  harness.hostState.pinned = ['a']
  await harness.poll()
  await harness.tick()
  assert.deepEqual(harness.hostState.pinned, ['a'])
  assert.deepEqual(harness.order(), ['a', 'b'])
  harness.dispose()
})

test('the poll converges an out-of-band mode change', async () => {
  const harness = createHarness({
    workspaces: [workspace('a', ['s1']), workspace('b', ['s2'])],
    summaries: { s1: summary('s1', 100), s2: summary('s2', 900) },
    hostState: { sortMode: 'manual', pinned: [] },
  })
  await harness.start()
  await harness.tick()
  assert.deepEqual(harness.order(), ['a', 'b'])

  harness.hostState.sortMode = 'updated'
  await harness.poll()
  await harness.tick()
  assert.deepEqual(harness.order(), ['b', 'a'])
  harness.dispose()
})

test('a poll with no actual change never re-sorts a manual drag', async () => {
  const harness = createHarness({
    workspaces: [workspace('a', ['s1']), workspace('b', ['s2'])],
    summaries: { s1: summary('s1', 900), s2: summary('s2', 100) },
    hostState: { sortMode: 'updated', pinned: [] },
  })
  await harness.start()
  await harness.tick()
  assert.deepEqual(harness.order(), ['a', 'b'])

  await harness.dragTo(['b', 'a'])
  assert.deepEqual(harness.order(), ['b', 'a'])

  const before = harness.inserts.length
  for (let round = 0; round < 3; round += 1) await harness.poll()
  await harness.tick()
  assert.deepEqual(harness.order(), ['b', 'a'], 'an unchanged poll must not reorder')
  assert.equal(harness.inserts.length, before, 'an unchanged poll must emit no moves')
  harness.dispose()
})

test('regaining window focus re-reads the durable state', async () => {
  const harness = createHarness({
    workspaces: [workspace('a', ['s1']), workspace('b', ['s2'])],
    summaries: { s1: summary('s1', 100), s2: summary('s2', 900) },
    hostState: { sortMode: 'updated', pinned: [] },
  })
  await harness.start()
  await harness.tick()
  assert.deepEqual(harness.order(), ['b', 'a'])

  harness.hostState.pinned = ['a']
  await harness.focus()
  await harness.tick()
  assert.deepEqual(harness.order(), ['a', 'b'])
  harness.dispose()
})

test('starting registers a poll, and disposal releases it', async () => {
  const harness = createHarness({
    workspaces: [workspace('a', ['s1']), workspace('b', ['s2'])],
    summaries: { s1: summary('s1', 100), s2: summary('s2', 900) },
  })
  await harness.start()
  assert.equal(harness.clock.intervalCount(), 1)
  harness.dispose()
  assert.equal(harness.clock.intervalCount(), 0)
})
