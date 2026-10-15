'use strict'

/**
 * Pure ordering logic for dsh-workspace-sort.
 *
 * This file is shared *verbatim* by the Node test suite and the browser
 * bundle: `build.cjs` inlines it into `lib/client.js`. It must therefore stay
 * dependency-free and CommonJS — `node --test` requires it directly, while the
 * module-loader factory supplies its own `module`/`exports` pair.
 *
 * Vocabulary:
 * - `workspaces`: the client Workspace projection items, each carrying
 *   `workspaceId` and `sessionIds`, in current registry order.
 * - `summaries`: Session summaries keyed by session id, carrying `id`,
 *   `updatedAt`, `blank` and `origin`. `updatedAt` is the same value the
 *   sidebar row displays (`max(createdAt, lastPromptAt)`).
 * - `scores`: `workspaceId` -> newest eligible `updatedAt`, or `undefined`
 *   when the workspace holds no eligible Session.
 */

/** Sessions from this origin stay hidden in the sidebar and never score. */
const SUBAGENT_ORIGIN = 'subagent'

/**
 * Whether one Session summary may contribute activity to its workspace.
 * @param summary - Session summary, possibly absent.
 * @param archived - registry-global archived session ids.
 * @param excludeBlank - whether blank Sessions are excluded.
 * @returns whether the Session counts as workspace activity.
 */
function isEligible(summary, archived, excludeBlank) {
  if (summary === undefined || summary === null) return false
  if (summary.origin === SUBAGENT_ORIGIN) return false
  if (archived.has(summary.id)) return false
  if (excludeBlank && summary.blank === true) return false
  return true
}

/**
 * Newest eligible Session activity inside one workspace.
 * @param sessionIds - the workspace's accounted Session ids.
 * @param summaries - Session summaries keyed by session id.
 * @param archived - registry-global archived session ids.
 * @param excludeBlank - whether blank Sessions are excluded.
 * @returns epoch ms, or undefined when no member Session is eligible.
 */
function scoreWorkspace(sessionIds, summaries, archived, excludeBlank) {
  let score
  for (const id of sessionIds) {
    const summary = summaries[id]
    if (!isEligible(summary, archived, excludeBlank)) continue
    const at = typeof summary.updatedAt === 'number' && Number.isFinite(summary.updatedAt)
      ? summary.updatedAt
      : 0
    if (score === undefined || at > score) score = at
  }
  return score
}

/**
 * Score every workspace.
 * @param workspaces - workspace projection items in current order.
 * @param summaries - Session summaries keyed by session id.
 * @param archivedIds - archived session ids, as an array or Set.
 * @param options - `excludeBlank` defaults to true.
 * @returns `workspaceId` -> score.
 */
function scoreAll(workspaces, summaries, archivedIds, options) {
  const archived = archivedIds instanceof Set ? archivedIds : new Set(archivedIds ?? [])
  const excludeBlank = options === undefined || options.excludeBlank !== false
  const scores = {}
  for (const workspace of workspaces) {
    scores[workspace.workspaceId] = scoreWorkspace(
      workspace.sessionIds ?? [],
      summaries,
      archived,
      excludeBlank,
    )
  }
  return scores
}

/**
 * Stable descending sort by score. Workspaces without a score sink below every
 * scored workspace; ties keep their incoming relative order.
 * @param entries - `{ workspaceId, score }` in incoming order.
 * @returns workspace ids, pinned-group-agnostic.
 */
function sortByScore(entries) {
  return entries
    .map((entry, index) => ({ workspaceId: entry.workspaceId, score: entry.score, index }))
    .sort((left, right) => {
      if (left.score === undefined && right.score === undefined) return left.index - right.index
      if (left.score === undefined) return 1
      if (right.score === undefined) return -1
      if (left.score !== right.score) return right.score - left.score
      return left.index - right.index
    })
    .map((entry) => entry.workspaceId)
}

/**
 * Complete desired workspace order: the pinned group first, then the ordinary
 * group, each sorted by score inside itself. Pinned ids that are not current
 * workspaces are ignored, so a stale pin never injects a phantom row.
 * @param workspaces - workspace projection items in current order.
 * @param scores - `workspaceId` -> score.
 * @param pinned - pinned workspace ids.
 * @returns the complete desired order of workspace ids.
 */
function computeOrder(workspaces, scores, pinned) {
  const pinnedSet = new Set(pinned ?? [])
  const pinnedGroup = []
  const ordinaryGroup = []
  for (const workspace of workspaces) {
    const entry = { workspaceId: workspace.workspaceId, score: scores[workspace.workspaceId] }
    if (pinnedSet.has(workspace.workspaceId)) pinnedGroup.push(entry)
    else ordinaryGroup.push(entry)
  }
  return [...sortByScore(pinnedGroup), ...sortByScore(ordinaryGroup)]
}

/**
 * Whether any workspace score differs between two score maps.
 * @param previous - earlier `workspaceId` -> score map.
 * @param current - later `workspaceId` -> score map.
 * @returns whether the user's activity changed any score.
 */
function scoresChanged(previous, current) {
  const left = previous ?? {}
  const right = current ?? {}
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) if (left[key] !== right[key]) return true
  return false
}

/**
 * Stable partition: pinned workspaces first, everything else after, both
 * keeping their current relative order.
 *
 * This is the `manual` mode's ordering. Pinning is an explicit user
 * instruction, so it must still visibly move a workspace while automatic
 * time-based sorting is off; unpinning returns the workspace to its position
 * among the ordinary rows rather than inventing a new one.
 *
 * @param ids - current workspace order.
 * @param pinned - pinned workspace ids.
 * @returns the partitioned order.
 */
function partitionByPin(ids, pinned) {
  const pinnedSet = new Set(pinned ?? [])
  const head = []
  const tail = []
  for (const id of ids) (pinnedSet.has(id) ? head : tail).push(id)
  return [...head, ...tail]
}

/**
 * Desired order for one mode.
 *
 * `updated` sorts both groups by score; `manual` only partitions by pin, so a
 * user's drags survive untouched. `manual` is the default and the safe
 * fallback for an unknown mode.
 *
 * @param workspaces - workspace projection items in current order.
 * @param scores - `workspaceId` -> score.
 * @param pinned - pinned workspace ids.
 * @param mode - `updated` or `manual`.
 * @returns the complete desired order of workspace ids.
 */
function orderFor(workspaces, scores, pinned, mode) {
  if (mode === 'updated') return computeOrder(workspaces, scores, pinned)
  return partitionByPin(
    workspaces.map((workspace) => workspace.workspaceId),
    pinned,
  )
}

/**
 * Whether two id lists are identical in order.
 * @param left - first order.
 * @param right - second order.
 * @returns whether the orders match exactly.
 */
function sameOrder(left, right) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * Minimal DOM-insertBefore-like moves turning `current` into `next`.
 *
 * Each returned move maps onto the documented
 * `workspaces.insertBefore(workspaceId, beforeWorkspaceId)` client call. Ids in
 * `next` that `current` does not hold are ignored; ids missing from `next` keep
 * their relative current position at the end, so an incomplete computed order
 * can never drop a workspace.
 *
 * @param current - current workspace order.
 * @param next - desired workspace order.
 * @returns the ordered list of moves to apply.
 */
function minimalMoves(current, next) {
  const present = new Set(current)
  const target = next.filter((id) => present.has(id))
  for (const id of current) if (!target.includes(id)) target.push(id)
  const work = [...current]
  const moves = []
  for (let index = 0; index < target.length; index += 1) {
    const id = target[index]
    if (work[index] === id) continue
    const from = work.indexOf(id)
    const anchor = work[index]
    if (from === -1 || anchor === undefined) continue
    work.splice(from, 1)
    work.splice(index, 0, id)
    moves.push({ workspaceId: id, beforeWorkspaceId: anchor })
  }
  return moves
}

/**
 * Whether the current order violates the pinned partition constraint.
 *
 * Pinned workspaces must always precede all unpinned workspaces. If any
 * unpinned workspace appears before a pinned workspace, the partition is
 * violated (for example, when a newly created workspace is prepended to the
 * top by the platform).
 *
 * @param ids - current workspace ids in displayed order.
 * @param pinned - pinned workspace ids.
 * @returns whether any unpinned workspace appears before a pinned workspace.
 */
function hasPartitionViolation(ids, pinned) {
  if (!Array.isArray(ids) || !Array.isArray(pinned) || pinned.length === 0) return false
  const pinnedSet = new Set(pinned)
  let seenUnpinned = false
  for (const id of ids) {
    if (pinnedSet.has(id)) {
      if (seenUnpinned) return true
    } else {
      seenUnpinned = true
    }
  }
  return false
}

exports.SUBAGENT_ORIGIN = SUBAGENT_ORIGIN
exports.isEligible = isEligible
exports.scoreWorkspace = scoreWorkspace
exports.scoreAll = scoreAll
exports.computeOrder = computeOrder
exports.scoresChanged = scoresChanged
exports.partitionByPin = partitionByPin
exports.hasPartitionViolation = hasPartitionViolation
exports.orderFor = orderFor
exports.sameOrder = sameOrder
exports.minimalMoves = minimalMoves
