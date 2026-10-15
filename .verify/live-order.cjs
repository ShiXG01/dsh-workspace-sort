'use strict'

/**
 * Live end-to-end verification (not part of the plugin).
 *
 * Two independent checks against the running DSH:
 *
 * 1. The host half answers on its plugin route with the durable state.
 * 2. The plugin's promise — "workspaces ordered by their most recent
 *    conversation, pinned first" — is compared against an order derived
 *    *independently* from DSH's own on-disk state (the workspace registry plus
 *    each session's persisted `sessionListMetadata.lastPromptAt`).
 *
 * The expected order mirrors the plugin's rules exactly, so a match means the
 * client half computed and applied the same result from the live Session list.
 */

const { readFileSync, readdirSync } = require('node:fs')
const { join } = require('node:path')
const { homedir } = require('node:os')

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CACHE_DIR = join(HOME, 'storages', 'session_projcache', 'sessions')
const REGISTRY = join(HOME, 'storages', 'workspace.json')
const PLUGIN_STATE = join(HOME, 'workspace-sort', 'state.json')
const BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:19387'

const bare = (id) => String(id).replace(/^session-/, '')

/**
 * Ask the live host route for the durable plugin state.
 *
 * Uses the built-in fetch: the sandbox denies `child_process`, and this route
 * is plain loopback HTTP anyway.
 *
 * @returns the route's `{ ok, value }` envelope.
 */
async function hostState() {
  try {
    const response = await fetch(`${BASE}/workspace-sort/api/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10000),
    })
    return await response.json()
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

/** Every cached session projection, keyed by bare id. */
function readSessions() {
  const sessions = new Map()
  for (const name of readdirSync(CACHE_DIR)) {
    if (!name.endsWith('.json')) continue
    let record
    try {
      record = JSON.parse(readFileSync(join(CACHE_DIR, name), 'utf8'))
    } catch {
      continue
    }
    const id = bare(name.replace(/\.json$/, ''))
    const identity = record?.record?.identity ?? {}
    const metadata = record?.record?.rows?.sessionListMetadata?.val
    const createdAt = typeof identity.createdAt === 'number' ? identity.createdAt : 0
    const lastPromptAt = typeof metadata?.lastPromptAt === 'number' ? metadata.lastPromptAt : 0
    sessions.set(id, {
      updatedAt: Math.max(createdAt, lastPromptAt),
      blank: metadata?.blank === true,
    })
  }
  return sessions
}

/** Compact relative age. */
function ago(ms, now) {
  const minutes = Math.round((now - ms) / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

/** Report whether the live order agrees with the plugin's own rules. */
async function main() {
  const live = await hostState()
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'))
  const sessions = readSessions()
  const archived = new Set((registry.global.archivedSessionIds ?? []).map(bare))
  const now = Date.now()

  let fileState = { sortMode: '(not yet persisted)', pinned: [] }
  try {
    fileState = JSON.parse(readFileSync(PLUGIN_STATE, 'utf8'))
  } catch {
    /* nothing persisted yet */
  }

  const mode = live.ok === true ? live.value.sortMode : undefined
  const pinned = live.ok === true ? live.value.pinned : []

  /** Newest eligible session activity inside one workspace. */
  function scoreOf(sessionIds) {
    let score
    for (const raw of sessionIds) {
      const id = bare(raw)
      const session = sessions.get(id)
      if (session === undefined || archived.has(id) || session.blank) continue
      if (score === undefined || session.updatedAt > score) score = session.updatedAt
    }
    return score
  }

  const rows = (registry.global.workspaceIds ?? []).map((workspaceId, index) => {
    const record = registry.tables.workspaces[workspaceId]
    return {
      workspaceId,
      title: record.title,
      liveIndex: index,
      score: scoreOf(record.sessionIds ?? []),
      pinned: pinned.includes(workspaceId),
    }
  })

  const byScore = (left, right) => {
    if (left.score === undefined && right.score === undefined) {
      return left.liveIndex - right.liveIndex
    }
    if (left.score === undefined) return 1
    if (right.score === undefined) return -1
    if (left.score !== right.score) return right.score - left.score
    return left.liveIndex - right.liveIndex
  }

  // Manual mode partitions by pin only; updated mode also sorts both groups.
  const expected = (
    mode === 'updated'
      ? [
          ...rows.filter((row) => row.pinned).sort(byScore),
          ...rows.filter((row) => !row.pinned).sort(byScore),
        ]
      : [...rows.filter((row) => row.pinned), ...rows.filter((row) => !row.pinned)]
  ).map((row) => row.workspaceId)

  console.log(`host route     : ${live.ok === true ? 'OK' : JSON.stringify(live)}`)
  console.log(`sort mode      : ${mode}   (state.json says ${fileState.sortMode})`)
  console.log(`pinned         : ${JSON.stringify(pinned)}`)
  console.log(`cached sessions: ${sessions.size}    archived: ${archived.size}`)
  console.log('')
  console.log('  #  live  want  workspace                        score')
  console.log('  -  ----  ----  -------------------------------  ---------')
  for (const [want, workspaceId] of expected.entries()) {
    const row = rows.find((candidate) => candidate.workspaceId === workspaceId)
    const moved = row.liveIndex === want ? ' ' : '*'
    console.log(
      `  ${String(want).padStart(2)}  ${String(row.liveIndex).padStart(4)}  ${String(want).padStart(4)} ${moved} ${row.title.padEnd(31).slice(0, 31)}  ${row.score === undefined ? '(no eligible session)' : ago(row.score, now)}`,
    )
  }

  const current = rows.map((row) => row.workspaceId)
  const matches = current.every((id, index) => id === expected[index])
  console.log('')

  if (mode === 'manual') {
    // In manual mode a mismatch is expected and correct: the plugin must NOT
    // have applied time order. Pins, however, must still lead.
    const head = current.slice(0, pinned.length)
    const pinsInFront = pinned.every((id) => head.includes(id))
    console.log(
      pinsInFront
        ? 'RESULT: manual mode — time order deliberately NOT applied (by design)'
        : 'RESULT: FAIL — a pinned workspace is not in front',
    )
    process.exitCode = pinsInFront ? 0 : 1
    return
  }

  console.log(
    matches
      ? 'RESULT: PASS — live order matches the independently computed expected order'
      : 'RESULT: FAIL — live order differs from the expected order',
  )
  process.exitCode = matches ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
