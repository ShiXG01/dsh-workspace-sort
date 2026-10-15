/* ── dsh-workspace-sort: browser half ──────────────────────────────────────
 *
 * Inlined by build.cjs directly after lib/order.cjs, inside the module-loader
 * factory, so `exports` already carries the pure ordering helpers and
 * `require` resolves against the frozen platform module table. No imports, no
 * JSX, no build toolchain: this file is the shipping artifact's source.
 *
 * The browser half is the only place that can see the Session list exactly as
 * the sidebar renders it (same `updatedAt` the row displays), so it computes
 * the order and applies it through the documented
 * `workspaces.insertBefore` client call. The host half owns only the durable
 * plugin state (sort mode + pinned ids).
 * ------------------------------------------------------------------------- */

const {
  orderFor,
  scoreAll,
  scoresChanged,
  sameOrder,
  minimalMoves,
  hasPartitionViolation,
  INJECTED_ATTR,
  PIN_ATTR,
  PIN_PATH_SLANTED,
  PIN_PATH_UPRIGHT,
  DIVIDER_ATTR,
  PIN_CLASS,
  VIEW_OPTIONS_CLASS_SUFFIX,
  VIEW_STATE_KEY,
  clampMenuPosition,
  findDividerWorkspaceId,
  pinLabel,
  pinPath,
  pinStylesheet,
  readGroupBy,
  resolveLanguage,
  rowMenuEntries,
  rowMenuText,
  shouldShowWorkspaceSort,
  viewText,
  workspaceIdFromRowKey,
} = exports

/** Host route base serving the durable plugin state. */
const API_BASE = '/workspace-sort/api'

/** Activity settles before a reorder, so a burst of turns costs one write. */
const DEBOUNCE_MS = 1500

/**
 * How often the durable host state is re-read.
 *
 * The menu is the only writer, and it adopts each response immediately, so
 * this poll exists for out-of-band changes only: a hand-edited `state.json`, a
 * second window, or another surface. It is one small loopback request, and it
 * can never reorder on its own — `adopt` reports a change only when the mode
 * or the pin set actually differs.
 */
const POLL_INTERVAL_MS = 15000

/**
 * POST one host route and unwrap its `{ ok, value }` envelope.
 * @param method - route name after the base path.
 * @param body - JSON request body.
 * @returns the route's value.
 */
async function callHost(method, body) {
  const response = await fetch(`${API_BASE}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body === undefined ? {} : body),
  })
  const payload = await response.json().catch(() => undefined)
  if (payload === undefined || payload.ok !== true) {
    throw new Error(`workspace-sort: ${method} failed (HTTP ${response.status})`)
  }
  return payload.value
}

/**
 * A minimal snapshot store matching the client-store contract, so the slot
 * framework's hook seat can subscribe to it.
 *
 * `getSnapshot` must return a referentially stable value between changes —
 * React compares snapshots by identity on every render — so the cached object
 * is rebuilt only when something actually changed.
 *
 * @param build - produces the current value from scratch.
 * @param subscribeTo - registers a listener fired on any underlying change.
 * @returns the store.
 */
function createSnapshotStore(build, subscribeTo) {
  let cache
  let dirty = true
  const listeners = new Set()
  const flush = () => {
    dirty = true
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[workspace-sort] store listener failed:', error)
      }
    }
  }
  if (typeof subscribeTo === 'function') subscribeTo(flush)
  return {
    getSnapshot() {
      if (dirty) {
        cache = build()
        dirty = false
      }
      return cache
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * Build the sorter bound to one client context.
 * @param ctx - client Cordis context carrying `sessions` and `workspaces`.
 * @returns the sorter handle used by this file's UI half.
 */
function createSorter(ctx) {
  const sessions = ctx.get('sessions')
  const workspaces = ctx.get('workspaces')
  if (sessions === undefined || workspaces === undefined) {
    throw new Error('workspace-sort: the sessions and workspaces services are required')
  }

  const state = {
    mode: 'manual',
    pinned: [],
    ready: false,
    applying: false,
    pending: false,
    panelOpen: false,
    timer: undefined,
    lastScores: {},
  }
  const listeners = new Set()

  const emit = () => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[workspace-sort] listener failed:', error)
      }
    }
  }

  /** Workspace rows in current registry order. */
  const readWorkspaces = () => {
    const snapshot = workspaces.list.getSnapshot()
    return (snapshot.items ?? []).map((item) => ({
      workspaceId: item.workspaceId,
      sessionIds: item.sessionIds ?? [],
    }))
  }

  /** Session summaries keyed by session id — the sidebar's own source. */
  const readSummaries = () => sessions.list.getSnapshot().byId ?? {}

  /** Registry-global archived session ids. */
  const readArchived = () => workspaces.list.getSnapshot().archivedSessionIds ?? []

  const schedule = () => {
    if (state.timer !== undefined) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = undefined
      void tick()
    }, DEBOUNCE_MS)
  }

  /**
   * Recompute and apply the desired order.
   *
   * The automatic path (`force` unset) only runs in `updated` mode and is
   * gated on the sort key actually having moved: a pure manual drag changes
   * the order without changing any score, so it is deliberately left alone.
   * The explicit path (`force`) runs after a pin, an unpin, a mode change or
   * "sort now" — all direct user instructions that must take effect even while
   * automatic sorting is off.
   *
   * @param force - whether this is an explicit user instruction.
   */
  async function tick(force) {
    if (!state.ready) return
    if (state.applying) {
      state.pending = true
      return
    }
    const list = readWorkspaces()
    if (list.length < 2) return
    const current = list.map((workspace) => workspace.workspaceId)
    const partitionViolated = hasPartitionViolation(current, state.pinned)
    if (state.mode !== 'updated' && force !== true && !partitionViolated) return
    const scores = scoreAll(list, readSummaries(), readArchived(), { excludeBlank: true })
    const next = orderFor(list, scores, state.pinned, state.mode)
    if (sameOrder(current, next)) {
      state.lastScores = scores
      return
    }
    if (force !== true && !partitionViolated && !scoresChanged(state.lastScores, scores)) return
    const moves = minimalMoves(current, next)
    if (moves.length === 0) {
      state.lastScores = scores
      return
    }
    state.applying = true
    try {
      for (const move of moves) {
        await workspaces.insertBefore(move.workspaceId, move.beforeWorkspaceId)
      }
      state.lastScores = scores
      emit()
    } catch (error) {
      console.warn('[workspace-sort] reorder failed:', error)
    } finally {
      state.applying = false
      if (state.pending) {
        state.pending = false
        schedule()
      }
    }
  }

  /**
   * Adopt one host state payload.
   *
   * Reports a change only when the mode or the pin set actually differs, so a
   * poll can never masquerade as user activity and re-sort a manual drag.
   *
   * @param value - host state payload.
   * @returns whether the adopted state differs from what was already known.
   */
  function adopt(value) {
    if (value === undefined || value === null) return false
    const mode =
      value.sortMode === 'manual' || value.sortMode === 'updated' ? value.sortMode : state.mode
    const pinned = Array.isArray(value.pinned)
      ? value.pinned.filter((id) => typeof id === 'string')
      : state.pinned
    const first = !state.ready
    const changed = mode !== state.mode || !sameOrder(pinned, state.pinned)
    state.mode = mode
    state.pinned = pinned
    state.ready = true
    if (first || changed) state.lastScores = {}
    if (first || changed) emit()
    return first || changed
  }

  /**
   * Re-read the durable state from the host half.
   * @returns whether the state changed.
   */
  async function refresh() {
    return adopt(await callHost('state'))
  }

  /** Re-read and apply, containing failures (a poll must never throw). */
  async function converge() {
    try {
      if (await refresh()) await tick(true)
    } catch (error) {
      console.warn('[workspace-sort] host state refresh failed:', error)
    }
  }

  /** Switch the workspace sort mode. */
  async function setMode(mode) {
    if (mode !== 'manual' && mode !== 'updated') return
    adopt(await callHost('sortMode', { mode }))
    await tick(true)
  }

  const setPinned = async (method, workspaceId) => {
    const prevPinned = state.pinned
    const nextPinned =
      method === 'pin'
        ? [workspaceId, ...state.pinned.filter((id) => id !== workspaceId)]
        : state.pinned.filter((id) => id !== workspaceId)
    if (!sameOrder(state.pinned, nextPinned)) {
      state.pinned = nextPinned
      emit()
    }
    try {
      const [hostState] = await Promise.all([
        callHost(method, { workspaceId }),
        tick(true),
      ])
      adopt(hostState)
      emit()
    } catch (error) {
      state.pinned = prevPinned
      emit()
      throw error
    }
  }

  /** Start the out-of-band convergence poll, when the environment has timers. */
  function startPoll() {
    if (typeof setInterval !== 'function') return undefined
    const id = setInterval(() => {
      void converge()
    }, POLL_INTERVAL_MS)
    return () => {
      if (typeof clearInterval === 'function') clearInterval(id)
    }
  }

  /** Re-read whenever the window regains focus, when the environment has one. */
  function startFocusWatch() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return undefined
    }
    const onFocus = () => {
      void converge()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }

  const api = {
    state,
    /** @param listener - called after any state change. */
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start() {
      ctx.effect(() => sessions.list.subscribe(() => schedule()), 'workspace-sort: session activity')
      ctx.effect(
        () =>
          workspaces.list.subscribe(() => {
            // Workspace additions/removals should reconcile immediately rather
            // than waiting for debounced session activity.
            void tick()
          }),
        'workspace-sort: workspace changes',
      )
      const stopPoll = startPoll()
      if (stopPoll !== undefined) ctx.effect(() => stopPoll, 'workspace-sort: host state poll')
      const stopFocus = startFocusWatch()
      if (stopFocus !== undefined) {
        ctx.effect(() => stopFocus, 'workspace-sort: host state focus watch')
      }
      converge()
    },
    schedule,
    refresh,
    converge,
    setMode,
    pin: (workspaceId) => setPinned('pin', workspaceId),
    unpin: (workspaceId) => setPinned('unpin', workspaceId),
    /** Toggle one workspace's pinned state. */
    togglePin: (workspaceId) =>
      setPinned(state.pinned.includes(workspaceId) ? 'unpin' : 'pin', workspaceId),
    /** Whether one workspace is currently pinned. */
    isPinned: (workspaceId) => state.pinned.includes(workspaceId),
    /** Display title for one workspace, when the projection still holds it. */
    titleOf(workspaceId) {
      const item = (workspaces.list.getSnapshot().items ?? []).find(
        (candidate) => candidate.workspaceId === workspaceId,
      )
      return item === undefined ? undefined : item.title
    },
    /** Sort immediately, ignoring the score-change gate (an explicit user ask). */
    sortNow() {
      state.lastScores = {}
      return tick(true)
    },
    /** Open or close the control panel. */
    setPanelOpen(open) {
      state.panelOpen = open === true
      emit()
    },
    /** Every workspace with the facts the panel displays, in current order. */
    rows() {
      const list = readWorkspaces()
      const scores = scoreAll(list, readSummaries(), readArchived(), { excludeBlank: true })
      return list.map((workspace) => ({
        workspaceId: workspace.workspaceId,
        title: api.titleOf(workspace.workspaceId) ?? workspace.workspaceId,
        pinned: state.pinned.includes(workspace.workspaceId),
        score: scores[workspace.workspaceId],
      }))
    },
  }

  // Built after `api` exists so the snapshot can read the panel rows through it.
  api.store = createSnapshotStore(
    () => ({
      open: state.panelOpen,
      mode: state.mode,
      ready: state.ready,
      rows: api.rows(),
    }),
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  )
  return api
}

/** The live sorter, exposed for the menu and row UI in the same bundle. */
let current

/* ── DOM layer ─────────────────────────────────────────────────────────────
 *
 * Everything decidable without a DOM lives in lib/order.cjs and lib/menu.cjs;
 * this section only locates nodes, calls those helpers and applies the result.
 * The shipped 0.2.0-rc.2 sidebar exposes no slot for the view-options menu or
 * for workspace-row actions, so these are DOM augmentations — each one is
 * wrapped so a structural change degrades to "no control" instead of breaking
 * the shipped menu.
 * ------------------------------------------------------------------------- */

/** The open right-click menu, when there is one. */
let rowMenu

/** Whether the footer action reached the shipped slot, for diagnostics. */
let panelSlotInstalled = false

/** Whether the row context-menu listener is attached, for diagnostics. */
let rowMenuInstalled = false

/** Read one localStorage key, tolerating a locked-down or absent store. */
function readStored(key) {
  try {
    if (typeof localStorage === 'undefined') return undefined
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

/** The interface language for this plugin's own copy. */
function language() {
  const tag = typeof navigator === 'undefined' ? undefined : navigator.language
  return resolveLanguage(tag)
}

/**
 * Ask the shipped menu to close itself.
 *
 * The menu ignores outside pointerdown for targets inside its own list, so an
 * injected row cannot rely on that path; dispatching the Escape it already
 * handles uses its own close sequence (and restores focus to its anchor).
 */
function closeViewOptionsMenu() {
  try {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  } catch (error) {
    console.warn('[workspace-sort] could not close the view options menu:', error)
  }
}

/** The trailing check icon of a selected menu row, if it has one. */
function trailingIcon(button) {
  const last = button.lastElementChild
  return last !== null && last.tagName.toLowerCase() === 'svg' ? last : undefined
}

/** Whether a class name is the menu's selected-state marker. */
function isSelectedClass(name) {
  return /_selected(?:Fill)?$/.test(name)
}

/**
 * Build one injected option row from a shipped row used as a template.
 *
 * Cloning the shipped 手动排序 / 最近更新 rows carries their classes, spacing and
 * icons across, and keeps their wording in step with the interface language —
 * only the selected state has to be set by hand.
 *
 * @param template - the shipped row to clone.
 * @param selected - whether this option is the active one.
 * @param selectedClassName - the menu's selected-state class, when known.
 * @param checkIcon - a check icon to clone, when known.
 * @returns the cloned row element.
 */
function buildOrderRow(template, selected, selectedClassName, checkIcon) {
  const button = template.cloneNode(true)
  button.setAttribute(INJECTED_ATTR, '')
  for (const attribute of ['aria-keyshortcuts', 'aria-haspopup', 'aria-expanded']) {
    button.removeAttribute(attribute)
  }
  for (const name of [...button.classList]) {
    if (isSelectedClass(name)) button.classList.remove(name)
  }
  const clonedIcon = trailingIcon(button)
  if (clonedIcon !== undefined) clonedIcon.remove()
  if (selected) {
    if (selectedClassName !== undefined) button.classList.add(selectedClassName)
    if (checkIcon !== undefined) button.appendChild(checkIcon.cloneNode(true))
  }
  button.setAttribute('aria-checked', selected ? 'true' : 'false')
  return button
}

/**
 * Insert the 「工作区排序方式」 group into an open view-options menu.
 *
 * Idempotent: the group is marked, and the shipped menu unmounts its portal on
 * close, so each open starts from a clean list.
 *
 * @param sorter - the live sorter.
 * @returns why the group is or is not present, for the diagnostic report.
 */
function injectViewOptionsGroup(sorter) {
  const list = document.querySelector(`[class*="${VIEW_OPTIONS_CLASS_SUFFIX}"]`)
  if (list === null) return 'menu-closed'
  if (list.querySelector(`[${INJECTED_ATTR}]`) !== null) return 'already-present'
  if (!shouldShowWorkspaceSort(readGroupBy(readStored(VIEW_STATE_KEY)))) return 'hidden-for-mode'
  const rows = list.querySelectorAll('button[role="menuitem"]')
  // group / group / group / manual / updated -- the shipped order.
  if (rows.length < 5) return 'menu-shape-unexpected'
  const manualRow = rows[3]
  const updatedRow = rows[4]
  const manualWrap = manualRow.parentElement
  if (manualWrap === null || manualWrap.parentElement !== list) return 'menu-shape-unexpected'
  const sortLabel = manualWrap.previousElementSibling
  if (sortLabel === null) return 'menu-shape-unexpected'
  const beforeSortLabel = sortLabel.previousElementSibling
  const anchor =
    beforeSortLabel !== null && beforeSortLabel.getAttribute('role') === 'separator'
      ? beforeSortLabel
      : sortLabel

  const selectedRow = list.querySelector('button[role="menuitem"][class*="_selected"]')
  const selectedClassName =
    selectedRow === null ? undefined : [...selectedRow.classList].find(isSelectedClass)
  const checkIcon = selectedRow === null ? undefined : trailingIcon(selectedRow)
  const separatorTemplate = list.querySelector('[role="separator"]')
  const text = viewText(language())

  const fragment = document.createDocumentFragment()
  if (separatorTemplate !== null) fragment.appendChild(separatorTemplate.cloneNode(false))
  const label = sortLabel.cloneNode(false)
  label.setAttribute(INJECTED_ATTR, '')
  label.textContent = text.orderLabel
  fragment.appendChild(label)

  for (const [template, mode] of [
    [manualRow, 'manual'],
    [updatedRow, 'updated'],
  ]) {
    const wrap = manualWrap.cloneNode(false)
    const button = buildOrderRow(
      template,
      sorter.state.mode === mode,
      selectedClassName,
      checkIcon,
    )
    button.addEventListener('click', (event) => {
      // Keep the event from reaching React's root listener: these nodes have no
      // fiber of their own, so React would otherwise attribute the click to an
      // ancestor fiber's handler.
      event.preventDefault()
      event.stopPropagation()
      sorter.setMode(mode).catch((error) => {
        console.warn('[workspace-sort] could not change the workspace sort mode:', error)
      })
      closeViewOptionsMenu()
    })
    wrap.appendChild(button)
    fragment.appendChild(wrap)
  }
  list.insertBefore(fragment, anchor)
  return 'injected'
}

/** Tear down the right-click menu and its listeners. */
function closeRowMenu() {
  if (rowMenu === undefined) return
  const menu = rowMenu
  rowMenu = undefined
  menu.remove()
  document.removeEventListener('pointerdown', onRowMenuPointerDown, true)
  document.removeEventListener('keydown', onRowMenuKeyDown, true)
  document.removeEventListener('scroll', closeRowMenu, true)
  window.removeEventListener('blur', closeRowMenu)
  window.removeEventListener('resize', closeRowMenu)
}

/** Close the right-click menu when a pointer lands outside it. */
function onRowMenuPointerDown(event) {
  if (rowMenu !== undefined && !rowMenu.contains(event.target)) closeRowMenu()
}

/** Close the right-click menu on Escape. */
function onRowMenuKeyDown(event) {
  if (event.key === 'Escape') closeRowMenu()
}

/**
 * Open the workspace row menu at one point.
 * @param sorter - the live sorter.
 * @param workspaceId - the workspace the row belongs to.
 * @param point - `{ x, y }` client coordinates.
 */
function openRowMenu(sorter, workspaceId, point) {
  closeRowMenu()
  const text = rowMenuText(language())
  const menu = document.createElement('div')
  menu.setAttribute(INJECTED_ATTR, '')
  menu.setAttribute('role', 'menu')
  menu.style.cssText = [
    'position:fixed',
    'z-index:2147483000',
    'min-width:180px',
    'padding:4px',
    'border-radius:var(--dsw-radius-lg,10px)',
    'border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,0.28))',
    'background:var(--dsw-alias-bg-elevated,#1f1f22)',
    'color:var(--dsw-alias-label-primary,#f5f5f5)',
    'box-shadow:0 8px 24px rgba(0,0,0,0.28)',
    'font-size:13px',
    'line-height:20px',
    'user-select:none',
  ].join(';')

  const title = sorter.titleOf(workspaceId)
  if (title !== undefined && title !== '') {
    const header = document.createElement('div')
    header.textContent = title
    header.style.cssText = [
      'padding:4px 10px 6px',
      'color:var(--dsw-alias-label-tertiary,#9a9a9a)',
      'font-size:12px',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'white-space:nowrap',
    ].join(';')
    menu.appendChild(header)
  }

  for (const entry of rowMenuEntries({ pinned: sorter.isPinned(workspaceId), text })) {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.textContent = entry.label
    button.style.cssText = [
      'display:block',
      'width:100%',
      'padding:5px 10px',
      'border:0',
      'border-radius:var(--dsw-radius-md,6px)',
      'background:transparent',
      'color:inherit',
      'font:inherit',
      'text-align:start',
      'cursor:pointer',
    ].join(';')
    button.addEventListener('mouseenter', () => {
      button.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.18))'
    })
    button.addEventListener('mouseleave', () => {
      button.style.background = 'transparent'
    })
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      closeRowMenu()
      const action =
        entry.id === 'pin'
          ? sorter.pin(workspaceId)
          : entry.id === 'unpin'
            ? sorter.unpin(workspaceId)
            : sorter.sortNow()
      action.catch((error) => {
        console.warn(`[workspace-sort] row action "${entry.id}" failed:`, error)
      })
    })
    menu.appendChild(button)
  }

  document.body.appendChild(menu)
  const rect = menu.getBoundingClientRect()
  const at = clampMenuPosition(
    point,
    { width: rect.width, height: rect.height },
    { width: window.innerWidth, height: window.innerHeight },
    8,
  )
  menu.style.left = `${at.x}px`
  menu.style.top = `${at.y}px`
  rowMenu = menu

  document.addEventListener('pointerdown', onRowMenuPointerDown, true)
  document.addEventListener('keydown', onRowMenuKeyDown, true)
  document.addEventListener('scroll', closeRowMenu, true)
  window.addEventListener('blur', closeRowMenu)
  window.addEventListener('resize', closeRowMenu)
}

/**
 * Take over right-click on a real workspace row.
 *
 * The ungrouped bucket is a derived group whose row key has an empty suffix,
 * so it is left to the native menu: there is nothing to pin.
 *
 * @param event - the contextmenu event.
 * @param sorter - the live sorter.
 */
function onContextMenu(event, sorter) {
  const target = event.target
  if (!(target instanceof Element)) return
  const row = target.closest(`[data-row-key^="workspace:"]`)
  if (row === null) return
  const workspaceId = workspaceIdFromRowKey(row.getAttribute('data-row-key'))
  if (workspaceId === undefined) return
  event.preventDefault()
  event.stopPropagation()
  openRowMenu(sorter, workspaceId, { x: event.clientX, y: event.clientY })
}

/**
 * Install the plugin's own stylesheet once.
 * @returns the style element, or undefined when the document cannot take one.
 */
function installPinStyles() {
  const existing = document.querySelector(`style[${INJECTED_ATTR}="style"]`)
  if (existing !== null) return existing
  const style = document.createElement('style')
  style.setAttribute(INJECTED_ATTR, 'style')
  style.textContent = pinStylesheet()
  document.head.appendChild(style)
  return style
}

/**
 * The row's action container: its last child that holds buttons.
 *
 * The shipped classes are build-time hashed, so the container is located
 * structurally instead. That container is the element the sidebar shows on row
 * hover (`display:none` until `:hover`), which is exactly where a new row
 * action belongs: it then inherits the same reveal, gap and alignment as the
 * shipped "…" and "new session" buttons.
 *
 * @param row - one workspace row element.
 * @returns the container, or undefined when the row has no button-bearing child.
 */
function rowActionsContainer(row) {
  const children = row.children
  for (let index = children.length - 1; index >= 0; index -= 1) {
    if (children[index].querySelector('button') !== null) return children[index]
  }
  return undefined
}

/** The pin glyph, filled and upright when pinned, slanted and outlined when not. */
function pinIcon(pinned) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', pinPath(pinned))
  path.setAttribute('fill', pinned ? 'currentColor' : 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.2')
  path.setAttribute('stroke-linejoin', 'round')
  svg.appendChild(path)
  return svg
}

/**
 * Bring every real workspace row's pin button up to date.
 *
 * The pin is placed first inside the row's action container when the row has
 * one, so it inherits the same hover reveal and spacing as the shipped actions;
 * otherwise it is appended to the row. React may drop the injected node when it
 * re-renders a row's children, so this runs again after every mutation and
 * re-adds or re-places it. The ungrouped bucket (empty row-key suffix) is
 * skipped: it is a derived group, not a workspace.
 *
 * @param sorter - the live sorter.
 * @returns how many real workspace rows now carry a pin.
 */
function decorateWorkspaceRows(sorter) {
  const rows = document.querySelectorAll('[data-row-key^="workspace:"]')
  const lang = language()
  let decorated = 0

  const workspaceEntries = []
  for (const row of rows) {
    const workspaceId = workspaceIdFromRowKey(row.getAttribute('data-row-key'))
    if (workspaceId === undefined) {
      if (row.hasAttribute(DIVIDER_ATTR)) row.removeAttribute(DIVIDER_ATTR)
      continue
    }
    workspaceEntries.push({ row, workspaceId })
  }
  const dividerWorkspaceId = findDividerWorkspaceId(
    workspaceEntries.map((entry) => entry.workspaceId),
    (id) => sorter.isPinned(id),
  )

  for (const { row, workspaceId } of workspaceEntries) {
    decorated += 1
    const pinned = sorter.isPinned(workspaceId)
    const container = rowActionsContainer(row)
    const parent = container === undefined ? row : container
    let button = row.querySelector(`[${PIN_ATTR}]`)
    if (button === null) {
      button = document.createElement('button')
      button.type = 'button'
      button.className = PIN_CLASS
      button.setAttribute(PIN_ATTR, workspaceId)
      button.appendChild(pinIcon(pinned))
      button.addEventListener('click', (event) => {
        // The row toggles its own expansion on click, so the pin must not bubble.
        event.preventDefault()
        event.stopPropagation()
        const nextPinned = !sorter.isPinned(workspaceId)
        button.setAttribute('data-pinned', nextPinned ? '1' : '0')
        const path = button.querySelector('path')
        if (path !== null) {
          path.setAttribute('d', pinPath(nextPinned))
          path.setAttribute('fill', nextPinned ? 'currentColor' : 'none')
        }
        const nextLabel = pinLabel(nextPinned, lang)
        button.setAttribute('aria-label', nextLabel)
        button.setAttribute('title', nextLabel)
        sorter.togglePin(workspaceId).catch((error) => {
          console.warn('[workspace-sort] pin toggle failed:', error)
        })
      })
      parent.insertBefore(button, container === undefined ? null : container.firstElementChild)
    } else if (button.parentElement !== parent || (parent.firstElementChild !== button && container !== undefined)) {
      // React rebuilt the row (or the action container moved): put the pin back
      // in its place without disturbing the shipped buttons.
      parent.insertBefore(button, container === undefined ? null : container.firstElementChild)
    }
    button.setAttribute('data-pinned', pinned ? '1' : '0')
    const path = button.querySelector('path')
    if (path !== null) {
      path.setAttribute('d', pinPath(pinned))
      path.setAttribute('fill', pinned ? 'currentColor' : 'none')
    }
    const label = pinLabel(pinned, lang)
    button.setAttribute('aria-label', label)
    button.setAttribute('title', label)

    if (workspaceId === dividerWorkspaceId) {
      row.setAttribute(DIVIDER_ATTR, 'true')
    } else if (row.hasAttribute(DIVIDER_ATTR)) {
      row.removeAttribute(DIVIDER_ATTR)
    }
  }
  return decorated
}

/* ── footer panel ──────────────────────────────────────────────────────────
 *
 * The officially-slotted surface. `sidebar.footer.action` is a declared `list`
 * slot, so the button is real composition rather than DOM injection, and the
 * panel below is a self-managed container (never inside React's tree) so it
 * cannot be clobbered by a re-render. It stays available even if every DOM
 * augmentation above stops matching a future sidebar.
 * ------------------------------------------------------------------------- */

/** The open panel container, when there is one. */
let panel

/** Tear down the panel and its listeners. */
function closePanel() {
  if (panel === undefined) return
  panel.remove()
  panel = undefined
  document.removeEventListener('pointerdown', onPanelPointerDown, true)
  document.removeEventListener('keydown', onPanelKeyDown, true)
  window.removeEventListener('resize', closePanel)
  const sorter = current
  if (sorter !== undefined && sorter.state.panelOpen === true) sorter.setPanelOpen(false)
}

/** Close the panel when a pointer lands outside it. */
function onPanelPointerDown(event) {
  if (panel !== undefined && !panel.contains(event.target)) closePanel()
}

/** Close the panel on Escape. */
function onPanelKeyDown(event) {
  if (event.key === 'Escape') closePanel()
}

/**
 * Build one clickable panel row.
 * @param options - label, pressed state and handler.
 * @returns the button element.
 */
function panelButton(options) {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = options.label
  button.setAttribute('aria-pressed', options.pressed === true ? 'true' : 'false')
  button.style.cssText = [
    'display:block',
    'width:100%',
    'padding:5px 8px',
    'border:0',
    'border-radius:var(--dsw-radius-md,6px)',
    `background:${options.selected === true ? 'var(--dsw-alias-interactive-bg-selected,rgba(128,128,128,0.26))' : 'transparent'}`,
    'color:inherit',
    'font:inherit',
    'text-align:start',
    'cursor:pointer',
  ].join(';')
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    options.onClick()
  })
  return button
}

/**
 * Fill the panel body from the sorter's current state.
 * @param sorter - the live sorter.
 */
function renderPanel(sorter) {
  const text = panelText(language())
  const body = panel.querySelector(`[${INJECTED_ATTR}="body"]`)
  if (body === null) return
  body.textContent = ''
  const snapshot = sorter.store.getSnapshot()

  const modeLabel = document.createElement('div')
  modeLabel.textContent = text.modeLabel
  modeLabel.style.cssText = 'padding:2px 8px 4px;font-size:12px;opacity:.7'
  body.appendChild(modeLabel)

  for (const [mode, label] of [
    ['manual', text.manual],
    ['updated', text.updated],
  ]) {
    body.appendChild(
      panelButton({
        label,
        selected: snapshot.mode === mode,
        onClick: () => {
          sorter.setMode(mode).catch((error) => {
            console.warn('[workspace-sort] could not change the workspace sort mode:', error)
          })
        },
      }),
    )
  }

  const separator = document.createElement('div')
  separator.style.cssText =
    'height:1px;margin:6px 4px;background:var(--dsw-alias-border-secondary,rgba(128,128,128,.28))'
  body.appendChild(separator)

  if (snapshot.rows.length === 0) {
    const empty = document.createElement('div')
    empty.textContent = text.empty
    empty.style.cssText = 'padding:6px 8px;font-size:12px;opacity:.7'
    body.appendChild(empty)
    return
  }

  for (const row of snapshot.rows) {
    const line = document.createElement('div')
    line.style.cssText = 'display:flex;align-items:center;gap:6px'
    const toggle = panelButton({
      label: row.pinned ? `✓ ${row.title}` : `　${row.title}`,
      pressed: row.pinned,
      onClick: () => {
        sorter.togglePin(row.workspaceId).catch((error) => {
          console.warn('[workspace-sort] pin toggle failed:', error)
        })
      },
    })
    toggle.setAttribute('data-dsh-ws-panel-row', row.workspaceId)
    toggle.setAttribute('aria-label', `${row.pinned ? text.pinnedGroup : text.unpinned}: ${row.title}`)
    toggle.style.overflow = 'hidden'
    toggle.style.textOverflow = 'ellipsis'
    toggle.style.whiteSpace = 'nowrap'
    line.appendChild(toggle)
    body.appendChild(line)
  }

  const actions = document.createElement('div')
  actions.style.cssText = 'margin-top:6px'
  actions.appendChild(
    panelButton({
      label: text.sortNow,
      onClick: () => {
        sorter.sortNow().catch((error) => {
          console.warn('[workspace-sort] sort now failed:', error)
        })
      },
    }),
  )
  body.appendChild(actions)
}

/**
 * Open the panel.
 * @param sorter - the live sorter.
 */
function openPanel(sorter) {
  closePanel()
  const text = panelText(language())
  const container = document.createElement('div')
  container.setAttribute(INJECTED_ATTR, 'panel')
  container.setAttribute('role', 'dialog')
  container.setAttribute('aria-label', text.title)
  container.style.cssText = [
    'position:fixed',
    'z-index:2147483000',
    'left:12px',
    'bottom:56px',
    'width:260px',
    'max-height:60vh',
    'overflow:auto',
    'padding:6px',
    'border-radius:var(--dsw-radius-lg,10px)',
    'border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,0.28))',
    'background:var(--dsw-alias-bg-elevated,#1f1f22)',
    'color:var(--dsw-alias-label-primary,#f5f5f5)',
    'box-shadow:0 8px 24px rgba(0,0,0,0.28)',
    'font-size:13px',
    'line-height:20px',
    'user-select:none',
  ].join(';')

  const header = document.createElement('div')
  header.textContent = text.title
  header.style.cssText = 'padding:2px 8px 6px;font-size:12px;opacity:.7'
  container.appendChild(header)

  const body = document.createElement('div')
  body.setAttribute(INJECTED_ATTR, 'body')
  container.appendChild(body)

  document.body.appendChild(container)
  panel = container
  renderPanel(sorter)

  document.addEventListener('pointerdown', onPanelPointerDown, true)
  document.addEventListener('keydown', onPanelKeyDown, true)
  window.addEventListener('resize', closePanel)
  sorter.setPanelOpen(true)
}

/**
 * Toggle the panel from the footer action.
 * @param sorter - the live sorter.
 */
function togglePanel(sorter) {
  if (panel === undefined) openPanel(sorter)
  else closePanel()
}

/**
 * Register the footer action into the shipped sidebar slot.
 *
 * `ctx.inject` keeps `slots` optional: the callback runs when the service is
 * present (and again if it is replaced), so this bundle still loads on a
 * deployment without the sidebar. React comes from the frozen platform module
 * table; a missing one only costs the button.
 *
 * @param ctx - client Cordis context.
 * @param sorter - the live sorter.
 */
function installFooterSlot(ctx, sorter) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['slots'], (slotsCtx) => {
    try {
      const React = require('react')
      if (React === undefined || typeof React.createElement !== 'function') return
      const text = panelText(language())

      /**
       * The footer button.
       *
       * The slot framework turns each injected `hooks` entry into a selector
       * hook named after it — `hooks: { panel }` becomes `props.usePanel` — so
       * the button follows the panel's open state instead of guessing. When the
       * framework does not supply the hook, it falls back to the module's own
       * knowledge, which keeps the button working either way.
       */
      const FooterAction = (props) => {
        const usePanel = props === undefined ? undefined : props.usePanel
        const open =
          typeof usePanel === 'function'
            ? usePanel((state) => state.open === true) === true
            : panel !== undefined
        return React.createElement(
          'button',
          {
            type: 'button',
            'data-dsh-ws-panel-toggle': '',
            'aria-label': text.open,
            title: text.open,
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => {
              togglePanel(sorter)
            },
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '28px',
              height: '28px',
              padding: 0,
              border: 0,
              borderRadius: 'var(--dsw-radius-md,6px)',
              background: open ? 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18))' : 'transparent',
              color: 'var(--dsw-alias-label-secondary,#c9c9c9)',
              cursor: 'pointer',
            },
          },
          React.createElement(
            'svg',
            { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true' },
            React.createElement('path', {
              d: 'M2 4h12M2 8h12M2 12h8',
              fill: 'none',
              stroke: 'currentColor',
              'stroke-width': '1.4',
              'stroke-linecap': 'round',
            }),
          ),
        )
      }

      slotsCtx.slots.inject('sidebar.footer.action', () =>
        slotsCtx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'workspace-sort',
            order: 500,
            inject: () => ({ hooks: { panel: sorter.store } }),
          },
          FooterAction,
        ),
      )
      panelSlotInstalled = true
      reportNow()
    } catch (error) {
      console.warn('[workspace-sort] footer action unavailable:', error)
    }
  })
}

/** The last diagnostic payload sent, so unchanged reports are not repeated. */
let lastDiagnosticKey

/** What the most recent UI pass observed, for out-of-band re-reports. */
let lastObserved = { viewOptions: 'not-run', rowPins: -1 }

/**
 * Tell the host half what the UI wiring actually achieved at runtime.
 *
 * The DOM unit tests run against a faithful reconstruction of the shipped
 * markup; only the live window can confirm the plugin matched the real thing.
 * Reporting the outcome makes that difference observable instead of assumed.
 * Fire-and-forget: a diagnostic must never disturb the interface.
 *
 * @param observed - what the current UI pass observed.
 */
function reportDiagnostic(observed) {
  if (observed !== undefined) lastObserved = observed
  try {
    const sorter = current
    const payload = {
      ...lastObserved,
      panelSlot: panelSlotInstalled === true,
      rowMenuInstalled: rowMenuInstalled === true,
      panelOpen: panel !== undefined,
      mode: sorter === undefined ? undefined : sorter.state.mode,
      ready: sorter === undefined ? false : sorter.state.ready,
      language: language(),
      href: typeof location === 'undefined' ? undefined : location.pathname,
    }
    const key = JSON.stringify(payload)
    if (key === lastDiagnosticKey) return
    lastDiagnosticKey = key
    void callHost('diagReport', { report: payload }).catch(() => {
      // A missing route (older host half) is not worth a console warning.
    })
  } catch (error) {
    console.warn('[workspace-sort] diagnostic report failed:', error)
  }
}

/**
 * Re-send the diagnostic with the latest observations.
 *
 * Used when something changes outside a UI pass — the footer slot landing
 * asynchronously, or a pin toggling — so the report is not left stale.
 */
function reportNow() {
  reportDiagnostic()
}

/**
 * Install the DOM augmentations, each independently guarded.
 * @param ctx - client Cordis context, used for effect disposal.
 * @param sorter - the live sorter.
 */
function installUi(ctx, sorter) {
  if (typeof document === 'undefined') return
  const onContext = (event) => {
    try {
      onContextMenu(event, sorter)
    } catch (error) {
      console.warn('[workspace-sort] context menu failed:', error)
    }
  }
  document.addEventListener('contextmenu', onContext, true)
  rowMenuInstalled = true
  ctx.effect(
    () => () => {
      document.removeEventListener('contextmenu', onContext, true)
      rowMenuInstalled = false
      closeRowMenu()
    },
    'workspace-sort: workspace row context menu',
  )

  if (typeof MutationObserver !== 'function') return
  try {
    installPinStyles()
  } catch (error) {
    console.warn('[workspace-sort] pin styles failed:', error)
  }

  let scheduled = false
  const run = () => {
    scheduled = false
    let viewOptions = 'not-run'
    try {
      viewOptions = injectViewOptionsGroup(sorter)
    } catch (error) {
      viewOptions = 'error'
      console.warn('[workspace-sort] view options injection failed:', error)
    }
    let rowPins = -1
    try {
      rowPins = decorateWorkspaceRows(sorter)
    } catch (error) {
      console.warn('[workspace-sort] row pin decoration failed:', error)
    }
    reportDiagnostic({ viewOptions, rowPins })
  }
  const observer = new MutationObserver(() => {
    if (scheduled) return
    scheduled = true
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
    else queueMicrotask(run)
  })
  observer.observe(document.body, { childList: true, subtree: true })
  ctx.effect(
    () => () => {
      observer.disconnect()
      closeRowMenu()
    },
    'workspace-sort: sidebar DOM observer',
  )
  // A pin change does not always mutate the DOM, so refresh on state changes too.
  ctx.effect(() => sorter.subscribe(run), 'workspace-sort: row pin refresh')
  run()
}

/**
 * Client plugin body.
 * @param ctx - client Cordis context.
 */
function apply(ctx) {
  try {
    const sorter = createSorter(ctx)
    sorter.start()
    current = sorter
    installUi(ctx, sorter)
    installFooterSlot(ctx, sorter)
    ctx.effect(
      () => () => {
        closePanel()
      },
      'workspace-sort: panel disposal',
    )
  } catch (error) {
    console.error('[workspace-sort] client half failed to start:', error)
  }
}

const inject = ['sessions', 'workspaces']

exports.createSorter = createSorter
exports.getSorter = () => current
exports.apply = apply
exports.inject = inject
exports.injectViewOptionsGroup = injectViewOptionsGroup
exports.decorateWorkspaceRows = decorateWorkspaceRows
exports.installPinStyles = installPinStyles
exports.installFooterSlot = installFooterSlot
exports.reportDiagnostic = reportDiagnostic
exports.reportNow = reportNow
exports.openPanel = openPanel
exports.closePanel = closePanel
exports.togglePanel = togglePanel
exports.renderPanel = renderPanel
exports.getPanel = () => panel
exports.onContextMenu = onContextMenu
exports.pinPath = pinPath
exports.PIN_PATH_SLANTED = PIN_PATH_SLANTED
exports.PIN_PATH_UPRIGHT = PIN_PATH_UPRIGHT
exports.closeRowMenu = closeRowMenu
