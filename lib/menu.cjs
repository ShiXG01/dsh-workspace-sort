'use strict'

/**
 * Pure UI decision helpers for dsh-workspace-sort.
 *
 * The browser half is deliberately thin: everything that can be decided
 * without touching the DOM is decided here, where it is unit-testable. The
 * shipping DOM wiring then only locates nodes, calls these helpers, and
 * applies the result.
 *
 * Shared verbatim by the Node test suite and the browser bundle (inlined by
 * `build.cjs`), so it stays dependency-free CommonJS.
 */

/**
 * Stable suffix of the view-options menu card's CSS-module class.
 *
 * The prefix is a build-time hash (`_9lTDKa_viewOptionsMenu` in the shipped
 * 0.2.0-rc.2 build) that changes between releases, so only this suffix may be
 * matched: `[class*="_viewOptionsMenu"]`.
 */
const VIEW_OPTIONS_CLASS_SUFFIX = '_viewOptionsMenu'

/** Attribute marking a node this plugin injected into the menu. */
const INJECTED_ATTR = 'data-dsh-ws-sort'

/** Attribute marking an injected workspace-row pin button. */
const PIN_ATTR = 'data-dsh-ws-pin'

/** Attribute marking the first unpinned workspace row when preceded by pinned rows. */
const DIVIDER_ATTR = 'data-dsh-ws-divider'

/** Class carried by an injected pin button, for the plugin's own stylesheet. */
const PIN_CLASS = 'dsh-ws-pin'

/** Workspace-row key prefix on the row element (`workspace:<workspaceId>`). */
const WORKSPACE_ROW_PREFIX = 'workspace:'

/** localStorage key holding the sidebar's persisted view state. */
const VIEW_STATE_KEY = 'dsh.workspace.view.v5'

/** Grouping modes whose tree renders workspace rows. */
const GROUPED_MODES = ['workspace', 'workspace-tree']

/** Sorter modes accepted from the host. */
const SORT_MODES = ['manual', 'updated']

/**
 * Whether the 「工作区排序方式」 group belongs in the menu.
 *
 * Workspace rows exist only in the two grouped modes; the flat list has no
 * workspace group to order, so the control is hidden there.
 *
 * @param groupBy - current grouping mode.
 * @returns whether to inject the group.
 */
function shouldShowWorkspaceSort(groupBy) {
  return GROUPED_MODES.includes(groupBy)
}

/**
 * Read the grouping mode out of a persisted view-state payload.
 * @param raw - raw localStorage string.
 * @returns the grouping mode, or undefined when absent or unparsable.
 */
function readGroupBy(raw) {
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return undefined
    return typeof parsed.groupBy === 'string' ? parsed.groupBy : undefined
  } catch {
    return undefined
  }
}

/**
 * Extract the workspace id from a row's `data-row-key`.
 *
 * The ungrouped bucket is a derived group whose key carries an empty suffix,
 * so an empty result means "not a real workspace" and must never be pinned.
 *
 * @param rowKey - the row element's `data-row-key` value.
 * @returns the workspace id, or undefined when the row is not a workspace.
 */
function workspaceIdFromRowKey(rowKey) {
  if (typeof rowKey !== 'string') return undefined
  if (!rowKey.startsWith(WORKSPACE_ROW_PREFIX)) return undefined
  const id = rowKey.slice(WORKSPACE_ROW_PREFIX.length)
  return id === '' ? undefined : id
}

/**
 * Clamp a popup position into the viewport.
 *
 * @param point - `{ x, y }` desired top-left in client coordinates.
 * @param size - `{ width, height }` popup size.
 * @param viewport - `{ width, height }` viewport size.
 * @param margin - minimum gap kept from every edge.
 * @returns the clamped `{ x, y }`.
 */
function clampMenuPosition(point, size, viewport, margin) {
  const gap = typeof margin === 'number' ? margin : 8
  const maxX = Math.max(gap, viewport.width - size.width - gap)
  const maxY = Math.max(gap, viewport.height - size.height - gap)
  return {
    x: Math.min(Math.max(point.x, gap), maxX),
    y: Math.min(Math.max(point.y, gap), maxY),
  }
}

/**
 * Resolve the UI language from a BCP-47 tag.
 * @param tag - navigator language, possibly absent.
 * @returns 'zh' or 'en'.
 */
function resolveLanguage(tag) {
  return typeof tag === 'string' && tag.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** The path for an unpinned (slanted) workspace pin icon. */
const PIN_PATH_SLANTED =
  'M9.5 1.5 14.5 6.5 12.6 7.1 10.6 9.1 10.9 11.6 9.9 12.6 6.4 9.1 2.6 13.4 2.3 13.1 6.4 7.4 2.9 3.9 3.9 2.9 6.4 3.2 8.4 1.2 Z'

/** The path for a pinned (upright with a flat base and centered needle) workspace pin icon. */
const PIN_PATH_UPRIGHT =
  'M4 2h8v1.5L10.5 5l2 4v1.5H8.5L8 15l-.5-4.5H3.5V9l2-4L4 3.5Z'

/**
 * Return the SVG path for the pin icon based on pinned state.
 * @param pinned - whether the workspace is pinned.
 * @returns the SVG path data.
 */
function pinPath(pinned) {
  return pinned ? PIN_PATH_UPRIGHT : PIN_PATH_SLANTED
}

/**
 * The stylesheet for the injected pin buttons.
 *
 * The pin is normally injected into the row's action container, which the
 * shipped stylesheet keeps `display:none` until the row is hovered (or its menu
 * is open) — so inside that container the pin inherits the native reveal for
 * free. The opacity rule below is for the fallback placement (a row whose
 * action container could not be found), where the pin sits directly in the row
 * and needs its own hover reveal, and for keyboard focus, which `:hover` alone
 * would not cover. Colors come from the theme tokens the shipped rows use, with
 * hard-coded fallbacks for a theme that lacks them.
 *
 * @returns the CSS text.
 */
function pinStylesheet() {
  return [
    `.${PIN_CLASS}{display:inline-flex;align-items:center;justify-content:center;`,
    'box-sizing:border-box;width:20px;height:20px;padding:0;border:0;background:transparent;',
    'color:var(--dsw-alias-label-tertiary,#9a9a9a);border-radius:var(--dsw-radius-sm,4px);',
    'cursor:pointer;opacity:0;flex:none;transition:opacity .12s ease}',
    `.${PIN_CLASS}:focus-visible{opacity:1;outline:1px solid var(--dsw-alias-border-focus,#4c8dff)}`,
    `[data-row-key]:hover .${PIN_CLASS}{opacity:1}`,
    `.${PIN_CLASS}:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18))}`,
    `.${PIN_CLASS}[data-pinned="1"]{opacity:1;color:var(--dsw-alias-state-business-primary,#4c8dff)}`,
    `.${PIN_CLASS}[data-pinned="1"] svg path{fill:currentColor}`,
    `.${PIN_CLASS}[data-pinned="0"] svg path{fill:none}`,
    `[${DIVIDER_ATTR}="true"]{position:relative;margin-top:10px}`,
    `[${DIVIDER_ATTR}="true"]::before{content:"";position:absolute;top:-5px;left:8px;right:8px;height:2px;border-radius:1px;background:#ffffff;opacity:.85;pointer-events:none}`,
    `@media (prefers-reduced-motion: reduce){.${PIN_CLASS}{transition:none}}`,
  ].join('')
}

/**
 * The accessible name and tooltip for one pin button.
 * @param pinned - whether the workspace is pinned.
 * @param language - 'zh' or 'en'.
 * @returns the label text.
 */
function pinLabel(pinned, language) {
  const text = rowMenuText(language)
  return pinned ? text.unpin : text.pin
}

/** Row-menu copy, so the right-click menu follows the interface language. */
const ROW_MENU_TEXT = {
  zh: {
    pin: '置顶此工作区',
    unpin: '取消置顶',
    sortByTime: '按最近更新排序',
    pinFailed: '置顶失败',
  },
  en: {
    pin: 'Pin this workspace',
    unpin: 'Unpin this workspace',
    sortByTime: 'Sort by most recent',
    pinFailed: 'Could not pin the workspace',
  },
}

/**
 * Row-menu copy for one language.
 * @param language - 'zh' or 'en'.
 * @returns the copy table.
 */
function rowMenuText(language) {
  return ROW_MENU_TEXT[language] ?? ROW_MENU_TEXT.en
}

/**
 * View-options group label, by language.
 *
 * The two option rows reuse the shipped 手动排序 / 最近更新 nodes as templates,
 * so their wording follows the interface language automatically; only this
 * new group heading needs its own copy.
 */
const VIEW_TEXT = {
  zh: { orderLabel: '工作区排序方式' },
  en: { orderLabel: 'Workspace order' },
}

/**
 * View-options copy for one language.
 * @param language - 'zh' or 'en'.
 * @returns the copy table.
 */
function viewText(language) {
  return VIEW_TEXT[language] ?? VIEW_TEXT.en
}

/**
 * Copy for the footer panel, which is the officially-slotted fallback surface
 * for everything the DOM augmentations do.
 */
const PANEL_TEXT = {
  zh: {
    title: '工作区排序',
    open: '工作区排序',
    close: '关闭',
    modeLabel: '工作区排序方式',
    manual: '手动排序',
    updated: '最近更新',
    pinColumn: '置顶',
    unpinned: '未置顶工作区',
    pinnedGroup: '已置顶',
    empty: '暂无工作区',
    sortNow: '立即排序',
  },
  en: {
    title: 'Workspace order',
    open: 'Workspace order',
    close: 'Close',
    modeLabel: 'Workspace order',
    manual: 'Manual order',
    updated: 'Most recent',
    pinColumn: 'Pinned',
    unpinned: 'Not pinned',
    pinnedGroup: 'Pinned',
    empty: 'No workspaces',
    sortNow: 'Sort now',
  },
}

/**
 * Panel copy for one language.
 * @param language - 'zh' or 'en'.
 * @returns the copy table.
 */
function panelText(language) {
  return PANEL_TEXT[language] ?? PANEL_TEXT.en
}

/**
 * Build the right-click menu entries for one workspace.
 * @param options - pinned state and copy.
 * @returns the entry list.
 */
function rowMenuEntries(options) {
  const { pinned, text } = options
  return [
    { id: pinned ? 'unpin' : 'pin', label: pinned ? text.unpin : text.pin },
    { id: 'sort-by-time', label: text.sortByTime },
  ]
}

/**
 * Identify the workspace id that should carry the divider between pinned and
 * unpinned workspaces.
 *
 * A divider is only placed when there is at least one pinned workspace and at
 * least one unpinned workspace, and attaches to the first unpinned workspace in
 * rendered order.
 *
 * @param workspaceIds - workspace ids in their rendered order.
 * @param isPinned - predicate returning whether an id is pinned.
 * @returns the id of the first unpinned workspace preceded by a pinned workspace, or undefined.
 */
function findDividerWorkspaceId(workspaceIds, isPinned) {
  if (!Array.isArray(workspaceIds) || typeof isPinned !== 'function') return undefined
  let hasPinned = false
  for (const id of workspaceIds) {
    if (isPinned(id)) {
      hasPinned = true
    } else if (hasPinned) {
      return id
    }
  }
  return undefined
}

exports.VIEW_OPTIONS_CLASS_SUFFIX = VIEW_OPTIONS_CLASS_SUFFIX
exports.INJECTED_ATTR = INJECTED_ATTR
exports.PIN_ATTR = PIN_ATTR
exports.DIVIDER_ATTR = DIVIDER_ATTR
exports.PIN_CLASS = PIN_CLASS
exports.WORKSPACE_ROW_PREFIX = WORKSPACE_ROW_PREFIX
exports.VIEW_STATE_KEY = VIEW_STATE_KEY
exports.GROUPED_MODES = GROUPED_MODES
exports.SORT_MODES = SORT_MODES
exports.shouldShowWorkspaceSort = shouldShowWorkspaceSort
exports.readGroupBy = readGroupBy
exports.workspaceIdFromRowKey = workspaceIdFromRowKey
exports.clampMenuPosition = clampMenuPosition
exports.resolveLanguage = resolveLanguage
exports.pinStylesheet = pinStylesheet
exports.pinLabel = pinLabel
exports.rowMenuText = rowMenuText
exports.rowMenuEntries = rowMenuEntries
exports.viewText = viewText
exports.panelText = panelText
exports.findDividerWorkspaceId = findDividerWorkspaceId
exports.PIN_PATH_SLANTED = PIN_PATH_SLANTED
exports.PIN_PATH_UPRIGHT = PIN_PATH_UPRIGHT
exports.pinPath = pinPath
