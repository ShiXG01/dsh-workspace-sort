'use strict'

/**
 * Unit tests for the shared pure ordering logic.
 *
 * These pin the rules the plan locks in: pinned group first and sorted inside
 * itself, the ordinary group sorted by the sidebar's own `updatedAt`, blank /
 * archived / subagent sessions excluded, and unscored workspaces sinking
 * without disturbing their relative order.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  computeOrder,
  hasPartitionViolation,
  orderFor,
  partitionByPin,
  scoreAll,
  scoreWorkspace,
  scoresChanged,
  sameOrder,
  minimalMoves,
} = require('../lib/order.cjs')

/** Build one workspace projection row. */
const workspace = (workspaceId, sessionIds) => ({ workspaceId, sessionIds })

/** Build one eligible session summary. */
const summary = (id, updatedAt, extra) => ({ id, updatedAt, blank: false, ...extra })

/** Order the given workspaces with the given summaries and pins. */
function orderOf(workspaces, summaries, pinned, archived) {
  return computeOrder(workspaces, scoreAll(workspaces, summaries, archived ?? []), pinned ?? [])
}

test('sorts the ordinary group by the sidebar activity time, newest first', () => {
  const workspaces = [workspace('a', ['s1']), workspace('b', ['s2']), workspace('c', ['s3'])]
  const summaries = { s1: summary('s1', 300), s2: summary('s2', 100), s3: summary('s3', 200) }
  assert.deepEqual(orderOf(workspaces, summaries), ['a', 'c', 'b'])
})

test('the newest workspace inside a group wins, matching the reported example', () => {
  // deepseek just spoke (now); supermarket-ip-monitor spoke 15 minutes earlier.
  const workspaces = [workspace('supermarket', ['s1']), workspace('deepseek', ['s2'])]
  const summaries = { s1: summary('s1', 1_000), s2: summary('s2', 500_000) }
  assert.deepEqual(orderOf(workspaces, summaries), ['deepseek', 'supermarket'])
})

test('a pinned workspace outranks every more active unpinned workspace', () => {
  const workspaces = [workspace('a', ['s1']), workspace('b', ['s2']), workspace('c', ['s3'])]
  const summaries = { s1: summary('s1', 100), s2: summary('s2', 900), s3: summary('s3', 500) }
  assert.deepEqual(orderOf(workspaces, summaries, ['a']), ['a', 'b', 'c'])
})

test('multiple pinned workspaces sort by time among themselves and stay ahead of the rest', () => {
  const workspaces = [
    workspace('w1', ['s1']),
    workspace('w2', ['s2']),
    workspace('w3', ['s3']),
    workspace('w4', ['s4']),
  ]
  const summaries = {
    s1: summary('s1', 200),
    s2: summary('s2', 800),
    s3: summary('s3', 500),
    s4: summary('s4', 100_000),
  }
  // w1 and w2 are pinned; w2 is more recent, so w2 leads, and both precede the
  // far more active unpinned w4.
  assert.deepEqual(orderOf(workspaces, summaries, ['w1', 'w2']), ['w2', 'w1', 'w4', 'w3'])
})

test('unpinning restores the purely time-based position', () => {
  const workspaces = [workspace('a', ['s1']), workspace('b', ['s2'])]
  const summaries = { s1: summary('s1', 100), s2: summary('s2', 900) }
  assert.deepEqual(orderOf(workspaces, summaries, ['a']), ['a', 'b'])
  assert.deepEqual(orderOf(workspaces, summaries, []), ['b', 'a'])
})

test('a pinned id that is not a current workspace injects no phantom row', () => {
  const workspaces = [workspace('a', ['s1']), workspace('b', ['s2'])]
  const summaries = { s1: summary('s1', 100), s2: summary('s2', 900) }
  assert.deepEqual(orderOf(workspaces, summaries, ['ghost']), ['b', 'a'])
})

test('a workspace scores by its newest eligible session, not its last member', () => {
  const workspaces = [workspace('a', ['old', 'new']), workspace('b', ['mid'])]
  const summaries = {
    old: summary('old', 10),
    new: summary('new', 900),
    mid: summary('mid', 500),
  }
  assert.deepEqual(orderOf(workspaces, summaries), ['a', 'b'])
})

test('blank sessions never score, so a fresh empty workspace does not jump ahead', () => {
  const workspaces = [workspace('fresh', ['s1']), workspace('busy', ['s2'])]
  const summaries = {
    s1: summary('s1', 900, { blank: true }),
    s2: summary('s2', 100),
  }
  assert.deepEqual(orderOf(workspaces, summaries), ['busy', 'fresh'])
})

test('archived sessions never score', () => {
  const workspaces = [workspace('archivedOnly', ['s1']), workspace('live', ['s2'])]
  const summaries = { s1: summary('s1', 900), s2: summary('s2', 100) }
  assert.deepEqual(orderOf(workspaces, summaries, [], ['s1']), ['live', 'archivedOnly'])
})

test('subagent sessions never score', () => {
  const workspaces = [workspace('parent', ['s1']), workspace('other', ['s2'])]
  const summaries = {
    s1: summary('s1', 900, { origin: 'subagent' }),
    s2: summary('s2', 100),
  }
  assert.deepEqual(orderOf(workspaces, summaries), ['other', 'parent'])
})

test('workspaces without an eligible session sink and keep their relative order', () => {
  const workspaces = [
    workspace('e1', []),
    workspace('live', ['s1']),
    workspace('e2', []),
  ]
  const summaries = { s1: summary('s1', 100) }
  assert.deepEqual(orderOf(workspaces, summaries), ['live', 'e1', 'e2'])
})

test('ties keep the incoming relative order', () => {
  const workspaces = [workspace('a', ['s1']), workspace('b', ['s2']), workspace('c', ['s3'])]
  const summaries = {
    s1: summary('s1', 100),
    s2: summary('s2', 100),
    s3: summary('s3', 100),
  }
  assert.deepEqual(orderOf(workspaces, summaries), ['a', 'b', 'c'])
})

test('a session without a usable timestamp scores zero rather than NaN', () => {
  const workspaces = [workspace('broken', ['s1']), workspace('ok', ['s2'])]
  const summaries = { s1: { id: 's1', updatedAt: undefined }, s2: summary('s2', 5) }
  assert.deepEqual(orderOf(workspaces, summaries), ['ok', 'broken'])
})

test('scoreWorkspace returns undefined for a workspace with no eligible member', () => {
  assert.equal(scoreWorkspace([], {}, new Set(), true), undefined)
  assert.equal(scoreWorkspace(['x'], {}, new Set(), true), undefined)
})

test('scoresChanged detects added, removed and advanced scores', () => {
  assert.equal(scoresChanged({ a: 1 }, { a: 1 }), false)
  assert.equal(scoresChanged({ a: 1 }, { a: 2 }), true)
  assert.equal(scoresChanged({ a: 1 }, {}), true)
  assert.equal(scoresChanged({}, { a: 1 }), true)
  assert.equal(scoresChanged({}, {}), false)
})

test('sameOrder compares by position, not by membership', () => {
  assert.equal(sameOrder(['a', 'b'], ['a', 'b']), true)
  assert.equal(sameOrder(['a', 'b'], ['b', 'a']), false)
  assert.equal(sameOrder(['a'], ['a', 'b']), false)
  assert.equal(sameOrder([], []), true)
})

/** Every ordering of a list. */
function permutations(items) {
  if (items.length <= 1) return [items]
  const result = []
  for (let index = 0; index < items.length; index += 1) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)]
    for (const tail of permutations(rest)) result.push([items[index], ...tail])
  }
  return result
}

/** Replay moves with DOM `insertBefore` semantics. */
function replay(current, moves) {
  const work = [...current]
  for (const move of moves) {
    const from = work.indexOf(move.workspaceId)
    if (from === -1) throw new Error(`move names an absent workspace: ${move.workspaceId}`)
    work.splice(from, 1)
    const at =
      move.beforeWorkspaceId === undefined
        ? work.length
        : work.indexOf(move.beforeWorkspaceId)
    if (at === -1) throw new Error(`anchor absent: ${move.beforeWorkspaceId}`)
    work.splice(at, 0, move.workspaceId)
  }
  return work
}

test('minimalMoves is a no-op for an order that already matches', () => {
  assert.deepEqual(minimalMoves(['a', 'b', 'c'], ['a', 'b', 'c']), [])
})

test('minimalMoves reproduces every target permutation of four workspaces', () => {
  const base = ['a', 'b', 'c', 'd']
  for (const current of permutations(base)) {
    for (const next of permutations(base)) {
      const moves = minimalMoves(current, next)
      assert.deepEqual(replay(current, moves), next, `failed for ${current} -> ${next}`)
      // One move per displaced position is the tight upper bound.
      assert.ok(moves.length <= base.length, `too many moves for ${current} -> ${next}`)
    }
  }
})

test('minimalMoves never drops a workspace the computed order omitted', () => {
  const moves = minimalMoves(['a', 'b', 'c'], ['c'])
  assert.deepEqual(replay(['a', 'b', 'c'], moves), ['c', 'a', 'b'])
})

test('minimalMoves ignores ids the current order does not hold', () => {
  const moves = minimalMoves(['a', 'b'], ['ghost', 'b', 'a'])
  assert.deepEqual(replay(['a', 'b'], moves), ['b', 'a'])
})

test('partitionByPin lifts pinned ids and preserves every other relative position', () => {
  assert.deepEqual(partitionByPin(['a', 'b', 'c', 'd'], []), ['a', 'b', 'c', 'd'])
  assert.deepEqual(partitionByPin(['a', 'b', 'c', 'd'], ['c']), ['c', 'a', 'b', 'd'])
  assert.deepEqual(partitionByPin(['a', 'b', 'c', 'd'], ['d', 'b']), ['b', 'd', 'a', 'c'])
  // A stale pin cannot invent a row.
  assert.deepEqual(partitionByPin(['a', 'b'], ['ghost']), ['a', 'b'])
})

test('manual mode only partitions by pin, so drags survive untouched', () => {
  const workspaces = [workspace('a', ['s1']), workspace('b', ['s2']), workspace('c', ['s3'])]
  const scores = { a: 100, b: 900, c: 500 }
  // Time order would be b, c, a -- manual mode must not apply it.
  assert.deepEqual(orderFor(workspaces, scores, [], 'manual'), ['a', 'b', 'c'])
  // Pinning still takes effect, and the rest keep their order.
  assert.deepEqual(orderFor(workspaces, scores, ['a'], 'manual'), ['a', 'b', 'c'])
  assert.deepEqual(orderFor(workspaces, scores, ['c'], 'manual'), ['c', 'a', 'b'])
})

test('updated mode sorts both groups by time', () => {
  const workspaces = [workspace('a', ['s1']), workspace('b', ['s2']), workspace('c', ['s3'])]
  const scores = { a: 100, b: 900, c: 500 }
  assert.deepEqual(orderFor(workspaces, scores, [], 'updated'), ['b', 'c', 'a'])
  assert.deepEqual(orderFor(workspaces, scores, ['a'], 'updated'), ['a', 'b', 'c'])
})

test('an unknown mode falls back to manual, the safe default', () => {
  const workspaces = [workspace('a', ['s1']), workspace('b', ['s2'])]
  const scores = { a: 100, b: 900 }
  assert.deepEqual(orderFor(workspaces, scores, [], undefined), ['a', 'b'])
  assert.deepEqual(orderFor(workspaces, scores, [], 'sideways'), ['a', 'b'])
})

test('hasPartitionViolation detects when unpinned workspaces precede pinned ones', () => {
  // Pinned follows unpinned -> violation!
  assert.equal(hasPartitionViolation(['unpinned', 'pinned'], ['pinned']), true)
  assert.equal(hasPartitionViolation(['u1', 'p1', 'u2', 'p2'], ['p1', 'p2']), true)
  assert.equal(hasPartitionViolation(['p1', 'u1', 'p2'], ['p1', 'p2']), true)

  // Proper partition -> no violation
  assert.equal(hasPartitionViolation(['pinned', 'unpinned'], ['pinned']), false)
  assert.equal(hasPartitionViolation(['p1', 'p2', 'u1', 'u2'], ['p1', 'p2']), false)

  // Edge cases: no pinned items or all pinned items -> no violation
  assert.equal(hasPartitionViolation(['a', 'b', 'c'], []), false)
  assert.equal(hasPartitionViolation(['a', 'b'], ['a', 'b']), false)
  assert.equal(hasPartitionViolation([], ['pinned']), false)
  assert.equal(hasPartitionViolation(null, ['pinned']), false)
})
