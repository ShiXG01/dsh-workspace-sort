'use strict'

/**
 * Unit tests for the pure UI decisions in `lib/menu.cjs`.
 *
 * These cover everything the DOM layer is allowed to assume: which grouping
 * modes get the control, how the persisted view state is read, which row keys
 * name a real workspace, and how a popup is kept inside the viewport.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  PIN_PATH_SLANTED,
  PIN_PATH_UPRIGHT,
  clampMenuPosition,
  findDividerWorkspaceId,
  pinPath,
  pinStylesheet,
  readGroupBy,
  resolveLanguage,
  rowMenuEntries,
  rowMenuText,
  shouldShowWorkspaceSort,
  viewText,
  workspaceIdFromRowKey,
} = require('../lib/menu.cjs')

test('the control is shown in both grouped modes and hidden in the flat list', () => {
  assert.equal(shouldShowWorkspaceSort('workspace'), true)
  assert.equal(shouldShowWorkspaceSort('workspace-tree'), true)
  assert.equal(shouldShowWorkspaceSort('flat'), false)
  assert.equal(shouldShowWorkspaceSort(undefined), false)
  assert.equal(shouldShowWorkspaceSort(''), false)
})

test('the grouping mode is read out of the persisted view state', () => {
  assert.equal(readGroupBy(JSON.stringify({ groupBy: 'workspace', orderBy: 'updated' })), 'workspace')
  assert.equal(readGroupBy(JSON.stringify({ groupBy: 'flat' })), 'flat')
  assert.equal(readGroupBy(JSON.stringify({ orderBy: 'updated' })), undefined)
  assert.equal(readGroupBy(JSON.stringify({ groupBy: 7 })), undefined)
  assert.equal(readGroupBy('[]'), undefined)
  assert.equal(readGroupBy('not json'), undefined)
  assert.equal(readGroupBy(''), undefined)
  assert.equal(readGroupBy(undefined), undefined)
})

test('only a row key with a workspace id names a real workspace', () => {
  assert.equal(workspaceIdFromRowKey('workspace:6b825e4d-c518'), '6b825e4d-c518')
  // The ungrouped bucket is a derived group; its key has an empty suffix.
  assert.equal(workspaceIdFromRowKey('workspace:'), undefined)
  assert.equal(workspaceIdFromRowKey('session:abc'), undefined)
  assert.equal(workspaceIdFromRowKey(undefined), undefined)
})

test('a popup is clamped inside the viewport with a margin', () => {
  const viewport = { width: 1000, height: 600 }
  const size = { width: 200, height: 100 }

  assert.deepEqual(clampMenuPosition({ x: 100, y: 100 }, size, viewport, 8), { x: 100, y: 100 })
  // Past the right and bottom edges.
  assert.deepEqual(clampMenuPosition({ x: 990, y: 590 }, size, viewport, 8), { x: 792, y: 492 })
  // Past the left and top edges.
  assert.deepEqual(clampMenuPosition({ x: -50, y: -20 }, size, viewport, 8), { x: 8, y: 8 })
  // A popup wider than the viewport still starts at the margin.
  assert.deepEqual(
    clampMenuPosition({ x: 500, y: 500 }, { width: 2000, height: 2000 }, viewport, 8),
    { x: 8, y: 8 },
  )
})

test('the language resolves from a BCP-47 tag', () => {
  assert.equal(resolveLanguage('zh-CN'), 'zh')
  assert.equal(resolveLanguage('zh-Hans'), 'zh')
  assert.equal(resolveLanguage('ZH'), 'zh')
  assert.equal(resolveLanguage('en-US'), 'en')
  assert.equal(resolveLanguage(undefined), 'en')
  assert.equal(resolveLanguage(7), 'en')
})

test('the row menu offers the opposite of the current pin state', () => {
  const zh = rowMenuText('zh')
  assert.deepEqual(
    rowMenuEntries({ pinned: false, text: zh }).map((entry) => entry.label),
    ['置顶此工作区', '按最近更新排序'],
  )
  assert.deepEqual(
    rowMenuEntries({ pinned: true, text: zh }).map((entry) => entry.label),
    ['取消置顶', '按最近更新排序'],
  )
  assert.deepEqual(
    rowMenuEntries({ pinned: false, text: zh }).map((entry) => entry.id),
    ['pin', 'sort-by-time'],
  )
  assert.deepEqual(
    rowMenuEntries({ pinned: true, text: zh }).map((entry) => entry.id),
    ['unpin', 'sort-by-time'],
  )
})

test('an unknown language falls back to English copy', () => {
  assert.equal(rowMenuText('fr'), rowMenuText('en'))
  assert.equal(viewText('fr'), viewText('en'))
  assert.equal(viewText('zh').orderLabel, '工作区排序方式')
  assert.equal(viewText('en').orderLabel, 'Workspace order')
})

test('findDividerWorkspaceId identifies the first unpinned workspace preceded by a pinned one', () => {
  const isPinned = (id) => ['w1', 'w2'].includes(id)

  // w1, w2 pinned, w3 first unpinned
  assert.equal(findDividerWorkspaceId(['w1', 'w2', 'w3', 'w4'], isPinned), 'w3')
  // No pinned workspaces -> no divider
  assert.equal(findDividerWorkspaceId(['w3', 'w4'], isPinned), undefined)
  // All workspaces pinned -> no divider
  assert.equal(findDividerWorkspaceId(['w1', 'w2'], isPinned), undefined)
  // Empty or invalid input
  assert.equal(findDividerWorkspaceId([], isPinned), undefined)
  assert.equal(findDividerWorkspaceId(null, isPinned), undefined)
})

test('pinPath returns upright flat-base path when pinned and slanted path when unpinned', () => {
  assert.equal(pinPath(true), PIN_PATH_UPRIGHT)
  assert.equal(pinPath(false), PIN_PATH_SLANTED)
  // Verify upright path has horizontal flat base with y = 10.5
  assert.ok(PIN_PATH_UPRIGHT.includes('H8.5'))
  assert.ok(PIN_PATH_UPRIGHT.includes('H3.5'))
})

test('pinStylesheet includes filled glyph rules and divider styling', () => {
  const css = pinStylesheet()
  assert.ok(css.includes('fill:currentColor'))
  assert.ok(css.includes('data-dsh-ws-divider'))
  assert.ok(css.includes('::before'))
  assert.ok(css.includes('height:1px'))
  assert.ok(css.includes('background:#ffffff'))
})
