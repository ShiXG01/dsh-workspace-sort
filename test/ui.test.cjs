'use strict'

/**
 * Structural tests for the browser half's DOM augmentations.
 *
 * These run the real shipping source against `test/dom.cjs` and assert on the
 * resulting element tree, which is the only way to verify the view-options
 * injection without a browser: the sidebar declares no slot for that menu, so
 * the plugin appends its group to the shipped list and must land it in the
 * right place without disturbing what is already there.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')

const { buildBody } = require('../build.cjs')
const { Element, createDocument, el } = require('./dom.cjs')

/** The class suffix the injection matches; the build hash varies by release. */
const MENU_CLASS = '_9lTDKa_viewOptionsMenu'

/** A stand-in sorter recording the calls the UI makes. */
function fakeSorter(overrides = {}) {
  const calls = []
  return {
    calls,
    state: { mode: overrides.mode ?? 'manual', pinned: overrides.pinned ?? [], ready: true },
    setMode: async (mode) => {
      calls.push(['setMode', mode])
    },
    pin: async (id) => {
      calls.push(['pin', id])
    },
    unpin: async (id) => {
      calls.push(['unpin', id])
    },
    togglePin: async (id) => {
      calls.push(['togglePin', id])
    },
    sortNow: async () => {
      calls.push(['sortNow'])
    },
    isPinned: (id) => (overrides.pinned ?? []).includes(id),
    titleOf: (id) => overrides.titles?.[id],
  }
}

/**
 * Build one menu row wrapper holding a menuitem button.
 * @param options - label, selected state and check icon.
 * @returns the wrapper element.
 */
function row(options) {
  const button = el('button', {
    className: options.selected === true ? `_9lTDKa_item _9lTDKa_selected` : '_9lTDKa_item',
    attributes: { role: 'menuitem', type: 'button' },
  })
  button.appendChild(el('span', { className: '_9lTDKa_itemIcon', text: 'icon' }))
  button.appendChild(el('span', { className: '_9lTDKa_itemLabel', text: options.label }))
  if (options.selected === true) {
    button.appendChild(el('svg', { className: '_9lTDKa_check' }))
  }
  return el('div', { className: '_9lTDKa_itemWrap', children: [button] })
}

/**
 * Build the shipped view-options menu list, in its real order:
 * group-by label, three grouping rows, separator, order-by label, two ordering
 * rows, separator, filter label, three filter rows.
 * @param selectedGroup - which grouping row carries the selected state.
 * @returns the menu list element.
 */
function menuList(selectedGroup = '按工作区') {
  return el('div', {
    className: `_9lTDKa_list ${MENU_CLASS}`,
    attributes: { role: 'menu' },
    children: [
      el('div', { className: '_9lTDKa_label', attributes: { role: 'presentation' }, text: '分组方式' }),
      row({ label: '按工作区', selected: selectedGroup === '按工作区' }),
      row({ label: '按工作区树', selected: selectedGroup === '按工作区树' }),
      row({ label: '单列表', selected: selectedGroup === '单列表' }),
      el('div', { className: '_9lTDKa_separator', attributes: { role: 'separator' } }),
      el('div', { className: '_9lTDKa_label', attributes: { role: 'presentation' }, text: '排序方式' }),
      row({ label: '手动排序', selected: true }),
      row({ label: '最近更新', selected: false }),
      el('div', { className: '_9lTDKa_separator', attributes: { role: 'separator' } }),
      el('div', { className: '_9lTDKa_label', attributes: { role: 'presentation' }, text: '筛选会话' }),
      row({ label: '隐藏已归档', selected: true }),
      row({ label: '全部对话（显示已归档）', selected: false }),
      row({ label: '仅显示已归档', selected: false }),
    ],
  })
}

/**
 * Load the shipping browser half against the fake DOM.
 * @param options - groupBy persisted state and menu presence.
 * @returns the loaded module exports plus its document.
 */
function load(options = {}) {
  const list = options.list === undefined ? menuList(options.selectedGroup) : options.list
  const document = createDocument(list === null ? [] : [list])
  const storage = new Map()
  if (options.groupBy !== undefined) {
    storage.set('dsh.workspace.view.v5', JSON.stringify({ groupBy: options.groupBy }))
  }
  const moduleObject = { exports: {} }
  const windowListeners = new Map()
  // Records every POST the bundle makes, so the diagnostic channel and the
  // state calls can be asserted without a live host.
  const postings = { calls: [] }
  postings.record = async (url, init) => {
    const method = String(url).split('/').pop()
    const body = init !== undefined && init.body !== undefined ? JSON.parse(init.body) : {}
    postings.calls.push({ method, body })
    // The diagnostic route is fire-and-forget; answer it like a real host.
    if (method === 'diagReport') {
      return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }
    }
    return { ok: false, status: 503, json: async () => ({ ok: false }) }
  }
  // A MutationObserver stub whose callback the test fires by hand, and a frame
  // queue the test drains, so `run()` executes synchronously on demand.
  const observers = []
  const frames = []
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback
      observers.push(this)
    }
    observe() {}
    disconnect() {}
    trigger() {
      this.callback([])
    }
  }
  // The bundle resolves `require` against the frozen platform module table;
  // tests supply a minimal React so the footer component can be inspected.
  const reactStub =
    options.react === false
      ? {}
      : {
          createElement: (type, props, ...children) => ({
            type,
            props: props ?? {},
            children: children.flat(),
          }),
        }
  const fakeWindow = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: (type, listener) => {
      const existing = windowListeners.get(type)
      if (existing === undefined) windowListeners.set(type, [listener])
      else existing.push(listener)
    },
    removeEventListener: (type, listener) => {
      const existing = windowListeners.get(type)
      if (existing === undefined) return
      windowListeners.set(
        type,
        existing.filter((candidate) => candidate !== listener),
      )
    },
  }
  const context = vm.createContext({
    require: (id) => (id === 'react' ? reactStub : {}),
    module: moduleObject,
    exports: moduleObject.exports,
    fetch: postings.record,
    setTimeout,
    clearTimeout,
    // A fake interval: the plugin's state poll must not keep the test process
    // alive (a real setInterval would).
    setInterval: () => 0,
    clearInterval: () => {},
    console,
    document,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, value),
    },
    navigator: { language: options.language ?? 'zh-CN' },
    window: fakeWindow,
    Element,
    MutationObserver: FakeMutationObserver,
    requestAnimationFrame: (callback) => {
      frames.push(callback)
      return frames.length
    },
    KeyboardEvent: class KeyboardEvent {
      constructor(type, init) {
        this.type = type
        Object.assign(this, init)
      }
    },
  })
  new vm.Script(buildBody(), { filename: 'dsh-workspace-sort.client.body.js' }).runInContext(context)
  /** Drain queued animation frames, running each `run()` pass. */
  const flushFrames = () => {
    while (frames.length > 0) frames.shift()()
  }
  return {
    api: moduleObject.exports,
    document,
    list,
    windowListeners,
    postings,
    observers,
    flushFrames,
    /** Fire the DOM observer, as a real mutation would, then drain frames. */
    triggerObserver() {
      for (const observer of observers) observer.trigger()
      flushFrames()
    },
  }
}

/** Shipped (non-injected) menu rows of one list. */
function shippedRows(list) {
  return list
    .querySelectorAll('button[role="menuitem"]')
    .filter((button) => !button.hasAttribute('data-dsh-ws-sort'))
}

/** The row labels of a menu list, in DOM order. */
function labels(list) {
  return list
    .querySelectorAll('[role="menuitem"]')
    .map((button) => button.querySelector('span[class*="_itemLabel"]').textContent)
}

/** The presentation-div labels of a menu list, in DOM order. */
function sectionLabels(list) {
  return list
    .querySelectorAll('[role="presentation"]')
    .map((node) => node.textContent)
}

test('the group lands between the grouping rows and the session ordering rows', () => {
  const { api, list } = load({ groupBy: 'workspace' })
  api.injectViewOptionsGroup(fakeSorter())

  assert.deepEqual(sectionLabels(list), ['分组方式', '工作区排序方式', '排序方式', '筛选会话'])
  assert.deepEqual(labels(list), [
    '按工作区',
    '按工作区树',
    '单列表',
    // The injected rows clone the shipped ones, so their wording follows the UI.
    '手动排序',
    '最近更新',
    '手动排序',
    '最近更新',
    '隐藏已归档',
    '全部对话（显示已归档）',
    '仅显示已归档',
  ])
})

test('the injected rows sit before the shipped ordering section, not after it', () => {
  const { api, list } = load({ groupBy: 'workspace' })
  api.injectViewOptionsGroup(fakeSorter())
  const injected = list.querySelectorAll('[data-dsh-ws-sort][role="menuitem"]')
  const shipped = shippedRows(list)

  // The injected group must close before the shipped ordering section, whose
  // first row (手动排序) is the fourth shipped row.
  const order = list.querySelectorAll('[role="menuitem"]')
  const lastInjected = injected[injected.length - 1]
  assert.ok(
    order.indexOf(lastInjected) < order.indexOf(shipped[3]),
    'the injected group must close before 手动排序',
  )
})

test('a separator is inserted above the injected group', () => {
  const { api, list } = load({ groupBy: 'workspace' })
  const before = list.querySelectorAll('[role="separator"]').length
  api.injectViewOptionsGroup(fakeSorter())
  assert.equal(list.querySelectorAll('[role="separator"]').length, before + 1)
})

test('the active mode carries the selected marker and the check icon', () => {
  const { api, list } = load({ groupBy: 'workspace' })
  api.injectViewOptionsGroup(fakeSorter({ mode: 'updated' }))

  const injected = list.querySelectorAll(`[${'data-dsh-ws-sort'}][role="menuitem"]`)
  assert.equal(injected.length, 2)
  const [manual, updated] = injected

  assert.equal(manual.getAttribute('aria-checked'), 'false')
  assert.equal(updated.getAttribute('aria-checked'), 'true')

  const selectedClass = [...updated.classList].find((name) => /_selected/.test(name))
  assert.ok(selectedClass !== undefined, 'the active row must carry the selected class')
  assert.equal(updated.querySelector('svg[class*="_check"]') !== null, true)
  assert.equal(manual.querySelector('svg[class*="_check"]') === null, true)
})

test('the injected rows drop the cloned selected state of their templates', () => {
  const { api, list } = load({ groupBy: 'workspace' })
  // 手动排序 is the shipped template and is selected; 最近更新 is not.
  api.injectViewOptionsGroup(fakeSorter({ mode: 'updated' }))
  const injected = list.querySelectorAll('[data-dsh-ws-sort][role="menuitem"]')
  // Only the row we marked selected may carry a check icon.
  const withCheck = injected.filter((button) => button.querySelector('svg[class*="_check"]') !== null)
  assert.equal(withCheck.length, 1)
  // The manual template's check icon must not have been cloned into the manual row.
  assert.equal(injected[0].getAttribute('aria-checked'), 'false')
})

test('the group is hidden in the flat list, and shown in both grouped modes', () => {
  for (const [groupBy, expected] of [
    ['workspace', true],
    ['workspace-tree', true],
    ['flat', false],
    [undefined, false],
  ]) {
    const { api, list } = load({ groupBy })
    api.injectViewOptionsGroup(fakeSorter())
    const injected = list.querySelectorAll('[data-dsh-ws-sort]')
    assert.equal(injected.length > 0, expected, `groupBy=${String(groupBy)}`)
  }
})

test('injection is idempotent and leaves the shipped rows untouched', () => {
  const { api, list } = load({ groupBy: 'workspace' })
  api.injectViewOptionsGroup(fakeSorter())
  const afterFirst = list.querySelectorAll('[role="menuitem"]').length
  const shippedBefore = shippedRows(list).map((button) => button.getAttribute('aria-checked'))

  api.injectViewOptionsGroup(fakeSorter())

  assert.equal(list.querySelectorAll('[role="menuitem"]').length, afterFirst, 'no duplicate group')
  assert.deepEqual(
    shippedRows(list).map((button) => button.getAttribute('aria-checked')),
    shippedBefore,
    'shipped rows must not be modified',
  )
})

test('a menu without the expected rows is left alone', () => {
  const short = el('div', {
    className: `_9lTDKa_list ${MENU_CLASS}`,
    children: [row({ label: '只有一项' })],
  })
  const { api, list } = load({ list: short, groupBy: 'workspace' })
  assert.doesNotThrow(() => api.injectViewOptionsGroup(fakeSorter()))
  assert.equal(list.querySelectorAll('[data-dsh-ws-sort]').length, 0)
})

test('a missing menu is not an error', () => {
  const { api } = load({ list: null, groupBy: 'workspace' })
  assert.doesNotThrow(() => api.injectViewOptionsGroup(fakeSorter()))
})

test('clicking an injected row switches the mode and closes the menu', () => {
  const sorter = fakeSorter({ mode: 'manual' })
  const { api, document, list } = load({ groupBy: 'workspace' })
  api.injectViewOptionsGroup(sorter)

  const injected = list.querySelectorAll('[data-dsh-ws-sort][role="menuitem"]')
  let propagated = false
  const click = { preventDefault: () => {}, stopPropagation: () => { propagated = true } }
  for (const listener of injected[1].listeners.get('click') ?? []) listener(click)

  assert.equal(propagated, true, 'the click must not reach the React root listener')
  assert.deepEqual(sorter.calls, [['setMode', 'updated']])
  assert.equal(document.dispatched.length, 1, 'the menu must be asked to close')
  assert.equal(document.dispatched[0].key, 'Escape')
})

test('the group heading follows the interface language', () => {
  const chinese = load({ groupBy: 'workspace', language: 'zh-CN' })
  chinese.api.injectViewOptionsGroup(fakeSorter())
  assert.ok(sectionLabels(chinese.list).includes('工作区排序方式'))

  const english = load({ groupBy: 'workspace', language: 'en-US' })
  english.api.injectViewOptionsGroup(fakeSorter())
  assert.ok(sectionLabels(english.list).includes('Workspace order'))
})

test('right-clicking a workspace row opens the row menu', () => {
  const { api, document } = load({ groupBy: 'workspace' })
  const sorter = fakeSorter({ titles: { w1: 'deepseek' } })
  const rowElement = el('div', { attributes: { 'data-row-key': 'workspace:w1' } })
  document.body.appendChild(rowElement)

  let prevented = false
  api.onContextMenu(
    {
      target: rowElement,
      clientX: 100,
      clientY: 120,
      preventDefault: () => {
        prevented = true
      },
      stopPropagation: () => {},
    },
    sorter,
  )

  assert.equal(prevented, true, 'the native menu must be suppressed')
  const menu = document.body.querySelector('[data-dsh-ws-sort][role="menu"]')
  assert.ok(menu !== null, 'our menu must be present')
  assert.deepEqual(
    menu.querySelectorAll('[role="menuitem"]').map((button) => button.textContent),
    ['置顶此工作区', '按最近更新排序'],
  )
  assert.equal(menu.querySelector('div').textContent, 'deepseek')
  api.closeRowMenu()
})

test('a pinned workspace offers to unpin', () => {
  const { api, document } = load({ groupBy: 'workspace' })
  const rowElement = el('div', { attributes: { 'data-row-key': 'workspace:w1' } })
  document.body.appendChild(rowElement)
  api.onContextMenu(
    { target: rowElement, clientX: 0, clientY: 0, preventDefault: () => {}, stopPropagation: () => {} },
    fakeSorter({ pinned: ['w1'] }),
  )
  const menu = document.body.querySelector('[data-dsh-ws-sort][role="menu"]')
  const first = menu.querySelectorAll('[role="menuitem"]')[0]
  assert.equal(first.textContent, '取消置顶')
  api.closeRowMenu()
})

test('the ungrouped bucket is not offered a pin', () => {
  const { api, document } = load({ groupBy: 'workspace' })
  const ungrouped = el('div', { attributes: { 'data-row-key': 'workspace:' } })
  document.body.appendChild(ungrouped)
  api.onContextMenu(
    { target: ungrouped, clientX: 0, clientY: 0, preventDefault: () => {}, stopPropagation: () => {} },
    fakeSorter(),
  )
  assert.equal(document.body.querySelector('[data-dsh-ws-sort][role="menu"]'), null)
  assert.equal(document.body.querySelectorAll('[data-dsh-ws-sort]').length, 0)
})

test('a right-click outside a workspace row is left to the native menu', () => {
  const { api, document } = load({ groupBy: 'workspace' })
  const elsewhere = el('div')
  document.body.appendChild(elsewhere)
  let prevented = false
  api.onContextMenu(
    {
      target: elsewhere,
      clientX: 0,
      clientY: 0,
      preventDefault: () => {
        prevented = true
      },
      stopPropagation: () => {},
    },
    fakeSorter(),
  )
  assert.equal(prevented, false)
  assert.equal(document.body.querySelector('[data-dsh-ws-sort][role="menu"]'), null)
})

test('the row menu stays inside the viewport near an edge', () => {
  const { api, document } = load({ groupBy: 'workspace' })
  const rowElement = el('div', { attributes: { 'data-row-key': 'workspace:w1' } })
  document.body.appendChild(rowElement)
  api.onContextMenu(
    {
      target: rowElement,
      clientX: 1270,
      clientY: 795,
      preventDefault: () => {},
      stopPropagation: () => {},
    },
    fakeSorter(),
  )
  const menu = document.body.querySelector('[data-dsh-ws-sort][role="menu"]')
  const left = Number.parseFloat(String(menu.style.left))
  const top = Number.parseFloat(String(menu.style.top))
  assert.ok(left >= 8 && left <= 1280, `left ${left} must be clamped`)
  assert.ok(top >= 8 && top <= 800, `top ${top} must be clamped`)
  api.closeRowMenu()
})

test('choosing a row action calls the sorter, and the menu closes', () => {
  const { api, document } = load({ groupBy: 'workspace' })
  const sorter = fakeSorter()
  const rowElement = el('div', { attributes: { 'data-row-key': 'workspace:w1' } })
  document.body.appendChild(rowElement)
  api.onContextMenu(
    { target: rowElement, clientX: 10, clientY: 10, preventDefault: () => {}, stopPropagation: () => {} },
    sorter,
  )
  const menu = document.body.querySelector('[data-dsh-ws-sort][role="menu"]')
  const pinButton = menu.querySelectorAll('[role="menuitem"]')[0]
  let propagated = false
  for (const listener of pinButton.listeners.get('click') ?? []) {
    listener({ preventDefault: () => {}, stopPropagation: () => { propagated = true } })
  }
  assert.equal(propagated, true)
  assert.deepEqual(sorter.calls, [['pin', 'w1']])
  assert.equal(document.body.querySelector('[data-dsh-ws-sort][role="menu"]'), null)
  api.closeRowMenu()
})

test('a nested target inside a row still resolves to that row', () => {
  const { api, document } = load({ groupBy: 'workspace' })
  const rowElement = el('div', { attributes: { 'data-row-key': 'workspace:w9' } })
  const nested = el('span', { text: 'label' })
  rowElement.appendChild(nested)
  document.body.appendChild(rowElement)
  let prevented = false
  api.onContextMenu(
    {
      target: nested,
      clientX: 5,
      clientY: 5,
      preventDefault: () => {
        prevented = true
      },
      stopPropagation: () => {},
    },
    fakeSorter(),
  )
  assert.equal(prevented, true)
  api.closeRowMenu()
})

/* ── inline pin ────────────────────────────────────────────────────────── */

/** A harness whose body holds the given workspace rows. */
function loadWithRows(rowIds, options = {}) {
  const loaded = load({ groupBy: 'workspace', ...options })
  for (const id of rowIds) {
    loaded.document.body.appendChild(
      el('div', { attributes: { 'data-row-key': `workspace:${id}` } }),
    )
  }
  return loaded
}

/**
 * Build one workspace row shaped like the shipped `ProjectRowItem`: a folder
 * slot, a chevron slot, the title, and a trailing action container that holds
 * the "…" menu and "new session" buttons.
 * @param workspaceId - the row's workspace id.
 * @returns the row element.
 */
function shippedWorkspaceRow(workspaceId) {
  const menuButton = el('button', {
    className: '_x_iconButton',
    attributes: { 'aria-label': '操作' },
  })
  const newButton = el('button', {
    className: '_x_iconButton',
    attributes: { 'aria-label': '新建会话' },
  })
  const actions = el('span', {
    className: '_x_rowActions',
    children: [menuButton, newButton],
  })
  return el('div', {
    className: '_x_projectRow',
    attributes: { 'data-row-key': `workspace:${workspaceId}`, role: 'treeitem' },
    children: [
      el('span', { className: '_x_slot' }),
      el('span', { className: '_x_slot' }),
      el('span', { className: '_x_projectText' }),
      actions,
    ],
  })
}

test('every real workspace row gets a pin button, and the ungrouped bucket does not', () => {
  const { api, document } = loadWithRows(['w1', 'w2'])
  document.body.appendChild(el('div', { attributes: { 'data-row-key': 'workspace:' } }))
  document.body.appendChild(el('div', { attributes: { 'data-row-key': 'session:s1' } }))

  api.decorateWorkspaceRows(fakeSorter())

  const pins = document.body.querySelectorAll('[data-dsh-ws-pin]')
  assert.equal(pins.length, 2, 'only the two real workspaces get a pin')
  assert.deepEqual(
    pins.map((button) => button.getAttribute('data-dsh-ws-pin')),
    ['w1', 'w2'],
  )
  // The row with an empty suffix is the derived ungrouped bucket.
  assert.equal(
    document.querySelector('[data-row-key="workspace:"]').querySelector('[data-dsh-ws-pin]'),
    null,
  )
})

test('decoration is idempotent, so the observer cannot stack buttons', () => {
  const { api, document } = loadWithRows(['w1'])
  api.decorateWorkspaceRows(fakeSorter())
  api.decorateWorkspaceRows(fakeSorter())
  api.decorateWorkspaceRows(fakeSorter())
  assert.equal(document.body.querySelectorAll('[data-dsh-ws-pin]').length, 1)
})

test('the pin reflects and refreshes the pinned state', () => {
  const { api, document } = loadWithRows(['w1', 'w2'])
  const pinned = []
  const sorter = {
    ...fakeSorter(),
    isPinned: (id) => pinned.includes(id),
  }

  api.decorateWorkspaceRows(sorter)
  const [first, second] = document.body.querySelectorAll('[data-dsh-ws-pin]')
  assert.equal(first.getAttribute('data-pinned'), '0')
  assert.equal(second.getAttribute('data-pinned'), '0')

  pinned.push('w2')
  api.decorateWorkspaceRows(sorter)
  const [firstAfter, secondAfter] = document.body.querySelectorAll('[data-dsh-ws-pin]')
  assert.equal(firstAfter.getAttribute('data-pinned'), '0')
  assert.equal(secondAfter.getAttribute('data-pinned'), '1')
  assert.equal(firstAfter.querySelector('path').getAttribute('fill'), 'none')
  assert.equal(secondAfter.querySelector('path').getAttribute('fill'), 'currentColor')
  assert.equal(firstAfter.querySelector('path').getAttribute('d'), api.PIN_PATH_SLANTED)
  assert.equal(secondAfter.querySelector('path').getAttribute('d'), api.PIN_PATH_UPRIGHT)
})

test('the first unpinned workspace gets a divider attribute when preceded by pinned workspaces', () => {
  const { api, document } = loadWithRows(['w1', 'w2', 'w3'])
  const pinned = ['w1']
  const sorter = {
    ...fakeSorter(),
    isPinned: (id) => pinned.includes(id),
  }

  // w1 pinned -> w2 should have data-dsh-ws-divider="true", w1 and w3 should not
  api.decorateWorkspaceRows(sorter)
  const [r1, r2, r3] = document.body.querySelectorAll('[data-row-key^="workspace:"]')
  assert.equal(r1.getAttribute('data-dsh-ws-divider'), null)
  assert.equal(r2.getAttribute('data-dsh-ws-divider'), 'true')
  assert.equal(r3.getAttribute('data-dsh-ws-divider'), null)

  // Pin w2 as well -> w3 becomes the first unpinned workspace
  pinned.push('w2')
  api.decorateWorkspaceRows(sorter)
  assert.equal(r1.getAttribute('data-dsh-ws-divider'), null)
  assert.equal(r2.getAttribute('data-dsh-ws-divider'), null)
  assert.equal(r3.getAttribute('data-dsh-ws-divider'), 'true')

  // Unpin all -> divider should be removed completely
  pinned.length = 0
  api.decorateWorkspaceRows(sorter)
  assert.equal(r1.getAttribute('data-dsh-ws-divider'), null)
  assert.equal(r2.getAttribute('data-dsh-ws-divider'), null)
  assert.equal(r3.getAttribute('data-dsh-ws-divider'), null)

  // Pin all -> no unpinned workspace, so no divider
  pinned.push('w1', 'w2', 'w3')
  api.decorateWorkspaceRows(sorter)
  assert.equal(r1.getAttribute('data-dsh-ws-divider'), null)
  assert.equal(r2.getAttribute('data-dsh-ws-divider'), null)
  assert.equal(r3.getAttribute('data-dsh-ws-divider'), null)
})

test('the pin label offers the opposite action, following the language', () => {
  const zh = loadWithRows(['w1'])
  zh.api.decorateWorkspaceRows({ ...fakeSorter(), isPinned: () => false })
  const zhPin = zh.document.body.querySelector('[data-dsh-ws-pin]')
  assert.equal(zhPin.getAttribute('aria-label'), '置顶此工作区')
  assert.equal(zhPin.getAttribute('title'), '置顶此工作区')

  const zhPinned = loadWithRows(['w1'])
  zhPinned.api.decorateWorkspaceRows({ ...fakeSorter(), isPinned: () => true })
  assert.equal(
    zhPinned.document.body.querySelector('[data-dsh-ws-pin]').getAttribute('aria-label'),
    '取消置顶',
  )

  const en = loadWithRows(['w1'], { language: 'en-US' })
  en.api.decorateWorkspaceRows({ ...fakeSorter(), isPinned: () => false })
  assert.equal(
    en.document.body.querySelector('[data-dsh-ws-pin]').getAttribute('aria-label'),
    'Pin this workspace',
  )
})

test('clicking a pin toggles it without toggling the row', () => {
  const { api, document } = loadWithRows(['w1'])
  const sorter = fakeSorter()
  api.decorateWorkspaceRows(sorter)

  const pin = document.body.querySelector('[data-dsh-ws-pin]')
  let prevented = false
  let stopped = false
  for (const listener of pin.listeners.get('click') ?? []) {
    listener({
      preventDefault: () => {
        prevented = true
      },
      stopPropagation: () => {
        stopped = true
      },
    })
  }

  assert.equal(prevented, true, 'the row must not act on the click')
  assert.equal(stopped, true, 'the click must not reach the row handler')
  assert.deepEqual(sorter.calls, [['togglePin', 'w1']])
})

test('a row that React rebuilt gets its pin back on the next pass', () => {
  const { api, document } = loadWithRows(['w1'])
  api.decorateWorkspaceRows(fakeSorter())
  assert.equal(document.body.querySelectorAll('[data-dsh-ws-pin]').length, 1)

  // Simulate React replacing the row wholesale, dropping the appended child.
  const replacement = el('div', { attributes: { 'data-row-key': 'workspace:w1' } })
  const original = document.querySelector('[data-row-key="workspace:w1"]')
  original.parentElement.appendChild(replacement)
  original.remove()
  assert.equal(document.body.querySelectorAll('[data-dsh-ws-pin]').length, 0)

  api.decorateWorkspaceRows(fakeSorter())
  assert.equal(document.body.querySelectorAll('[data-dsh-ws-pin]').length, 1)
})

test('the pin button carries the glyph and the plugin class', () => {
  const { api, document } = loadWithRows(['w1'])
  api.decorateWorkspaceRows(fakeSorter())
  const pin = document.body.querySelector('[data-dsh-ws-pin]')
  assert.ok(pin.classList.contains('dsh-ws-pin'))
  const svg = pin.querySelector('svg')
  assert.ok(svg !== null, 'the pin must render a glyph')
  assert.equal(svg.getAttribute('aria-hidden'), 'true')
})

test('the stylesheet is installed once in the document head', () => {
  const { api, document } = loadWithRows([])
  api.installPinStyles()
  api.installPinStyles()
  const styles = document.head.querySelectorAll('style')
  assert.equal(styles.length, 1, 'the stylesheet must not be duplicated')
  assert.ok(styles[0].textContent.includes('.dsh-ws-pin'))
})

test('the pin goes first inside the shipped action container, not after it', () => {
  const { api, document } = load({ groupBy: 'workspace' })
  const row = shippedWorkspaceRow('w1')
  document.body.appendChild(row)

  api.decorateWorkspaceRows(fakeSorter())

  const actions = row.children[row.children.length - 1]
  assert.ok(actions.classList.contains('_x_rowActions'))
  const pin = row.querySelector('[data-dsh-ws-pin]')
  assert.ok(pin !== null, 'the pin must exist')
  assert.equal(pin.parentElement, actions, 'the pin must live in the action container')
  assert.equal(
    actions.firstElementChild,
    pin,
    'the pin must lead the action container, before the shipped buttons',
  )
  // The shipped buttons must be untouched and still present after it.
  const shipped = actions.children.filter((child) => !child.hasAttribute('data-dsh-ws-pin'))
  assert.equal(shipped.length, 2)
  assert.deepEqual(
    shipped.map((button) => button.getAttribute('aria-label')),
    ['操作', '新建会话'],
  )
})

test('a row without an action container still gets an appended pin', () => {
  const { api, document } = load({ groupBy: 'workspace' })
  const row = el('div', {
    attributes: { 'data-row-key': 'workspace:w1' },
    children: [el('span'), el('span', { text: 'deepseek' })],
  })
  document.body.appendChild(row)
  api.decorateWorkspaceRows(fakeSorter())
  const pin = row.querySelector('[data-dsh-ws-pin]')
  assert.ok(pin !== null)
  assert.equal(pin.parentElement, row, 'with no action container the pin joins the row')
})

test('a pin the reconciler detached is put back in the action container', () => {
  const { api, document } = load({ groupBy: 'workspace' })
  const row = shippedWorkspaceRow('w1')
  document.body.appendChild(row)
  api.decorateWorkspaceRows(fakeSorter())

  const pin = row.querySelector('[data-dsh-ws-pin]')
  const actions = row.children[row.children.length - 1]
  // Simulate React rebuilding the action container's children, dropping our node
  // to the row itself.
  row.appendChild(pin)
  assert.equal(pin.parentElement, row)

  api.decorateWorkspaceRows(fakeSorter())
  assert.equal(pin.parentElement, actions, 'the pin must be re-placed into the container')
  assert.equal(actions.firstElementChild, pin)
  assert.equal(row.querySelectorAll('[data-dsh-ws-pin]').length, 1, 'no duplicate pin')
})

/* ── footer panel ──────────────────────────────────────────────────────── */

/**
 * A sorter stub carrying the panel surface the panel rendering uses.
 * @param options - mode, rows and the open flag.
 * @returns the stub, recording its calls.
 */
function panelSorter(options = {}) {
  const calls = []
  let open = options.open ?? false
  return {
    calls,
    state: { mode: options.mode ?? 'manual', panelOpen: open, pinned: [], ready: true },
    store: {
      getSnapshot: () => ({
        open,
        mode: options.mode ?? 'manual',
        ready: true,
        rows: options.rows ?? [],
      }),
    },
    setPanelOpen(value) {
      open = value
      calls.push(['setPanelOpen', value])
    },
    setMode: async (mode) => {
      calls.push(['setMode', mode])
    },
    togglePin: async (id) => {
      calls.push(['togglePin', id])
    },
    sortNow: async () => {
      calls.push(['sortNow'])
    },
  }
}

/** Click one element's registered listeners, stubbing the event. */
function click(element) {
  let prevented = false
  let stopped = false
  for (const listener of element.listeners.get('click') ?? []) {
    listener({
      preventDefault: () => {
        prevented = true
      },
      stopPropagation: () => {
        stopped = true
      },
    })
  }
  return { prevented, stopped }
}

test('the panel renders mode options and sort-now button without workspace list rows', () => {
  const { api } = load({ groupBy: 'workspace' })
  const sorter = panelSorter({
    mode: 'updated',
    rows: [
      { workspaceId: 'w1', title: 'deepseek', pinned: true, score: 900 },
      { workspaceId: 'w2', title: 'supermarket-ip-monitor', pinned: false, score: 100 },
    ],
  })
  api.openPanel(sorter)

  const panel = api.getPanel()
  assert.ok(panel !== null && panel !== undefined, 'the panel must be open')
  // Workspace rows are intentionally excluded from the footer panel to keep it concise.
  assert.equal(panel.querySelectorAll('[data-dsh-ws-panel-row]').length, 0)
  assert.ok(panel.textContent.includes('工作区排序方式'))
  assert.ok(panel.textContent.includes('手动排序'))
  assert.ok(panel.textContent.includes('最近更新'))
  assert.ok(panel.textContent.includes('立即排序'))
  assert.deepEqual(sorter.calls, [['setPanelOpen', true]])
  api.closePanel()
  assert.equal(api.getPanel(), undefined)
})

test('the panel marks the active sort mode, switches it, and closes immediately on click', () => {
  const { api } = load({ groupBy: 'workspace' })
  const sorter = panelSorter({ mode: 'manual', rows: [] })
  api.openPanel(sorter)

  const panel = api.getPanel()
  const buttons = panel.querySelectorAll('button')
  const manual = buttons.find((button) => button.textContent === '手动排序')
  const updated = buttons.find((button) => button.textContent === '最近更新')
  assert.ok(manual !== undefined && updated !== undefined)
  assert.equal(manual.getAttribute('aria-pressed'), 'false')
  assert.equal(updated.getAttribute('aria-pressed'), 'false')

  click(updated)
  assert.deepEqual(sorter.calls, [
    ['setPanelOpen', true],
    ['setMode', 'updated'],
  ])
  // Panel must close immediately on selection.
  assert.equal(api.getPanel(), undefined)
})

test('clicking sort-now triggers sortNow and closes the panel immediately', () => {
  const { api } = load({ groupBy: 'workspace' })
  const sorter = panelSorter({ rows: [] })
  api.openPanel(sorter)
  const panel = api.getPanel()

  const sortNow = panel
    .querySelectorAll('button')
    .find((button) => button.textContent === '立即排序')
  click(sortNow)

  assert.deepEqual(sorter.calls, [
    ['setPanelOpen', true],
    ['sortNow'],
  ])
  // Panel must close immediately on action click.
  assert.equal(api.getPanel(), undefined)
})

test('opening the panel twice reuses one container, and toggling closes it', () => {
  const { api, document } = load({ groupBy: 'workspace' })
  const sorter = panelSorter({ rows: [] })
  api.openPanel(sorter)
  api.openPanel(sorter)
  assert.equal(document.body.querySelectorAll('[data-dsh-ws-sort="panel"]').length, 1)

  api.togglePanel(sorter)
  assert.equal(api.getPanel(), undefined)
  api.togglePanel(sorter)
  assert.ok(api.getPanel() !== undefined)
  api.closePanel()
})

test('closing the panel clears its listeners so they cannot leak', () => {
  const { api } = load({ groupBy: 'workspace' })
  const sorter = panelSorter({ rows: [] })
  api.openPanel(sorter)
  api.closePanel()
  // A second close must be a harmless no-op.
  assert.doesNotThrow(() => api.closePanel())
})

test('the panel copy follows the interface language', () => {
  const en = load({ groupBy: 'workspace', language: 'en-US' })
  en.api.openPanel(panelSorter({ rows: [] }))
  assert.ok(en.api.getPanel().textContent.includes('Workspace order'))
  assert.ok(en.api.getPanel().textContent.includes('Manual order'))
  assert.ok(en.api.getPanel().textContent.includes('Most recent'))
  en.api.closePanel()
})

test('the footer action registers into the shipped slot, and slots stays optional', () => {
  const { api } = load({ groupBy: 'workspace' })
  const registrations = []
  const injected = []
  const ctx = {
    inject: (names, callback) => {
      injected.push([...names])
      callback({
        slots: {
          inject: (name, register) => register(),
          register: (options, component) => registrations.push({ ...options, component }),
        },
      })
    },
  }

  api.installFooterSlot(ctx, panelSorter({ rows: [] }))

  assert.deepEqual(injected, [['slots']], 'slots must be injected optionally')
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].name, 'sidebar.footer.action')
  assert.equal(registrations[0].id, 'workspace-sort')
  assert.equal(typeof registrations[0].order, 'number')
})

test('the footer component renders a button that toggles the panel', () => {
  const { api } = load({ groupBy: 'workspace' })
  const registrations = []
  const sorter = panelSorter({ rows: [] })
  api.installFooterSlot(
    {
      inject: (_names, callback) =>
        callback({
          slots: {
            inject: (_name, register) => register(),
            register: (options, component) => registrations.push({ ...options, component }),
          },
        }),
    },
    sorter,
  )

  const component = registrations[0].component
  assert.equal(typeof component, 'function')

  // Without the framework hook the button still renders and falls back to the
  // module's own view of the panel.
  const element = component({})
  assert.equal(element.type, 'button')
  assert.equal(element.props.type, 'button')
  assert.equal(element.props['aria-expanded'], 'false')
  assert.equal(typeof element.props.onClick, 'function')
  assert.ok(element.children.some((child) => child !== null && child.type === 'svg'))

  element.props.onClick()
  assert.deepEqual(sorter.calls, [['setPanelOpen', true]])
})

test('the footer button follows the injected selector hook', () => {
  const { api } = load({ groupBy: 'workspace' })
  const registrations = []
  api.installFooterSlot(
    {
      inject: (_names, callback) =>
        callback({
          slots: {
            inject: (_name, register) => register(),
            register: (options, component) => registrations.push({ ...options, component }),
          },
        }),
    },
    panelSorter({ rows: [] }),
  )
  const component = registrations[0].component

  // The framework turns `hooks: { panel }` into a `usePanel(selector)` hook.
  const closed = component({ usePanel: (select) => select({ open: false }) })
  assert.equal(closed.props['aria-expanded'], 'false')
  const open = component({ usePanel: (select) => select({ open: true }) })
  assert.equal(open.props['aria-expanded'], 'true')
})

test('the footer registration injects a real snapshot store for the panel', () => {
  const { api } = load({ groupBy: 'workspace' })
  const registrations = []
  // A genuine sorter, so the injected store is the real one the panel uses.
  const sorter = api.createSorter(createClientContext())
  api.installFooterSlot(
    {
      inject: (_names, callback) =>
        callback({
          slots: {
            inject: (_name, register) => register(),
            register: (options, component) => registrations.push({ ...options, component }),
          },
        }),
    },
    sorter,
  )

  const injected = registrations[0].inject()
  assert.deepEqual(Object.keys(injected.hooks), ['panel'])
  const store = injected.hooks.panel
  assert.equal(typeof store.getSnapshot, 'function')
  assert.equal(typeof store.subscribe, 'function')

  // React compares snapshots by identity, so repeated reads must not mint a new
  // object (otherwise useSyncExternalStore loops forever).
  assert.equal(store.getSnapshot(), store.getSnapshot())

  let notified = 0
  const stop = store.subscribe(() => {
    notified += 1
  })
  sorter.setPanelOpen(true)
  assert.equal(notified, 1, 'opening the panel must notify the store')
  assert.equal(store.getSnapshot().open, true)
  assert.notEqual(store.getSnapshot(), undefined)
  stop()
  sorter.setPanelOpen(false)
  assert.equal(notified, 1, 'the unsubscribed listener must not hear later changes')
})

test('a deployment whose React cannot be resolved simply gets no button', () => {
  const { api } = load({ groupBy: 'workspace', react: false })
  const registrations = []
  assert.doesNotThrow(() =>
    api.installFooterSlot(
      {
        inject: (_names, callback) =>
          callback({
            slots: {
              inject: (_name, register) => register(),
              register: (options, component) => registrations.push({ ...options, component }),
            },
          }),
      },
      panelSorter({ rows: [] }),
    ),
  )
  assert.equal(registrations.length, 0, 'no button without React')
})

/* ── runtime diagnostics ───────────────────────────────────────────────── */

/**
 * A minimal client context serving the sorter's two required services.
 * @returns the context, with its recorded effect disposers.
 */
function createClientContext() {
  const disposers = []
  const summary = { updatedAt: 1000, blank: false }
  return {
    disposers,
    get: (name) =>
      name === 'sessions'
        ? { list: { getSnapshot: () => ({ byId: { s1: summary } }), subscribe: () => () => {} } }
        : name === 'workspaces'
          ? {
              list: {
                getSnapshot: () => ({
                  items: [{ workspaceId: 'w1', sessionIds: ['s1'], title: 'deepseek' }],
                  archivedSessionIds: [],
                }),
                subscribe: () => () => {},
              },
              insertBefore: async () => {},
            }
          : undefined,
    effect: (callback) => {
      disposers.push(callback())
    },
    inject: () => {},
  }
}

test('the full UI pass reports what it achieved to the host', () => {
  const { api, document, postings, triggerObserver } = load({ groupBy: 'workspace' })
  document.body.appendChild(el('div', { attributes: { 'data-row-key': 'workspace:w1' } }))

  api.apply(createClientContext())
  triggerObserver()

  const report = postings.calls.filter((call) => call.method === 'diagReport').pop()
  assert.ok(report !== undefined, 'the UI pass must report a diagnostic')
  assert.equal(report.body.report.rowPins, 1, 'one real workspace row was decorated')
  assert.equal(report.body.report.rowMenuInstalled, true)
  assert.equal(report.body.report.mode, 'manual')
  assert.equal(report.body.report.ready, false, 'the host state was never reachable in this test')
  // The first pass injects the group; the second reports it is already there.
  assert.ok(
    ['injected', 'already-present'].includes(report.body.report.viewOptions),
    `unexpected view options status: ${report.body.report.viewOptions}`,
  )
})

test('an unchanged diagnostic is not reported twice', () => {
  const { api, document, postings, triggerObserver } = load({ groupBy: 'workspace' })
  document.body.appendChild(el('div', { attributes: { 'data-row-key': 'workspace:w1' } }))
  api.apply(createClientContext())

  triggerObserver()
  const first = postings.calls.filter((call) => call.method === 'diagReport').length
  triggerObserver()
  triggerObserver()
  const after = postings.calls.filter((call) => call.method === 'diagReport').length

  assert.equal(after, first, 'an identical report must not be resent')
})

test('the diagnostic records menu injection once the menu is open', () => {
  // Start with no menu on screen, as a freshly loaded window has.
  const { api, document, postings, triggerObserver } = load({ groupBy: 'workspace', list: null })
  api.apply(createClientContext())
  triggerObserver()
  const before = postings.calls.filter((call) => call.method === 'diagReport').pop()
  assert.equal(before.body.report.viewOptions, 'menu-closed')

  // Opening the menu (its portal appears in the body) and mutating lets the
  // next pass find it and inject the group.
  document.body.appendChild(menuList())
  document.body.appendChild(el('div', { attributes: { 'data-row-key': 'workspace:w1' } }))
  triggerObserver()

  const after = postings.calls.filter((call) => call.method === 'diagReport').pop()
  assert.equal(after.body.report.viewOptions, 'injected')
  assert.equal(
    document.querySelector('[data-dsh-ws-sort][role="menuitem"]') !== null,
    true,
    'the group must really be in the menu',
  )
})

test('a deployment without the slots service still loads the plugin', () => {
  const { api } = load({ groupBy: 'workspace' })
  // A client context that cannot inject at all must not throw.
  assert.doesNotThrow(() => api.installFooterSlot({}, panelSorter({ rows: [] })))
  assert.doesNotThrow(() => api.installFooterSlot({ inject: () => {} }, panelSorter({ rows: [] })))
})
