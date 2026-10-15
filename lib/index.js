/**
 * dsh-workspace-sort — host half.
 *
 * Owns the durable plugin state (workspace sort mode + pinned workspace ids)
 * and serves it to the browser half over a fenced `/workspace-sort/api` route.
 *
 * It deliberately holds no Session or Workspace data of its own: the browser
 * half already has the Session list exactly as the sidebar renders it, so it
 * computes the order and applies it through the documented
 * `workspaces.insertBefore` client API. That keeps this half dependency-free
 * (Node builtins only, no `@deepseek-ai/*` imports) and guarantees the sort
 * key can never drift from the `updatedAt` the user sees on the row.
 *
 * State lives beside the other DSH plugin data:
 *   `$DSH_HOME/workspace-sort/state.json` (default `~/.dsh/workspace-sort/`).
 *
 * @module dsh-workspace-sort
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis plugin identity. */
export const name = 'dsh-workspace-sort'

/** The web server serves the route; the web runtime supplies the trust list. */
export const inject = ['webServer', 'webRuntime']

/** Durable state shape version; a mismatch resets to defaults. */
const STATE_VERSION = 1

/** Accepted workspace sort modes. */
const SORT_MODES = new Set(['manual', 'updated'])

/** Largest accepted JSON request body. */
const MAX_BODY_BYTES = 64 * 1024

/** Plugin data directory beside the harness home. */
const DATA_DIR =
  process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? join(process.env.DSH_HOME, 'workspace-sort')
    : join(homedir(), '.dsh', 'workspace-sort')

/** Durable state file. */
const STATE_PATH = join(DATA_DIR, 'state.json')

/**
 * Fresh default state: manual ordering, nothing pinned.
 * @returns a new default state object.
 */
function defaultState() {
  return { version: STATE_VERSION, sortMode: 'manual', pinned: [] }
}

/**
 * Coerce untrusted persisted or requested state into the durable shape.
 * @param value - decoded JSON value of unknown shape.
 * @returns a normalized state object.
 */
function normalizeState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return defaultState()
  const sortMode = SORT_MODES.has(value.sortMode) ? value.sortMode : 'manual'
  const pinned = Array.isArray(value.pinned)
    ? value.pinned.filter((id) => typeof id === 'string' && id !== '')
    : []
  return { version: STATE_VERSION, sortMode, pinned: [...new Set(pinned)] }
}

/**
 * Read durable state, falling back to defaults.
 *
 * A damaged file is preserved under a `.corrupt-<timestamp>` sibling and the
 * plugin starts clean rather than failing to mount.
 *
 * @returns the current state.
 */
async function readState() {
  try {
    return normalizeState(JSON.parse(await readFile(STATE_PATH, 'utf8')))
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return defaultState()
    console.warn(`[workspace-sort] unreadable state at ${STATE_PATH}; starting clean:`, error)
    try {
      await rename(STATE_PATH, `${STATE_PATH}.corrupt-${Date.now()}`)
    } catch {
      /* the reset matters more than the backup */
    }
    return defaultState()
  }
}

/**
 * Persist state atomically (temp sibling then rename).
 * @param value - state to persist.
 */
async function writeState(value) {
  await mkdir(DATA_DIR, { recursive: true })
  const temporary = `${STATE_PATH}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, STATE_PATH)
}

/**
 * Create the serialized state holder.
 *
 * Every mutation runs on one chain, so a burst of pin clicks cannot interleave
 * a read-modify-write pair.
 *
 * @returns the state store.
 */
function createStateStore() {
  let cache
  let chain = Promise.resolve()

  /**
   * Run one task after every previously queued task.
   * @param task - the task to serialize.
   * @returns the task's own result.
   */
  const serialize = (task) => {
    const result = chain.then(task, task)
    chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  return {
    /** Read state, loading it from disk once. */
    read() {
      return serialize(async () => {
        if (cache === undefined) cache = await readState()
        return cache
      })
    },
    /**
     * Apply one mutation and persist the result.
     * @param mutate - receives the current state, returns the next one.
     * @returns the persisted state.
     */
    update(mutate) {
      return serialize(async () => {
        if (cache === undefined) cache = await readState()
        const next = normalizeState(mutate({ ...cache, pinned: [...cache.pinned] }))
        cache = next
        await writeState(next)
        return next
      })
    },
  }
}

/** One header value, or undefined. */
function header(headers, key) {
  const value = headers[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Parse a Host-header authority.
 * @param authority - `host[:port]` text.
 * @returns the parsed URL, or undefined when unparsable.
 */
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/**
 * Whether a hostname names the local loopback authority.
 * @param hostname - URL hostname.
 * @returns whether it is loopback.
 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/**
 * Canonical authority form: hostname, or hostname:port when a port was given.
 * @param entry - configured trusted authority.
 * @param entryUrl - its parsed URL.
 * @returns the canonical authority text.
 */
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/**
 * Whether the request authority matches a trusted authority entry.
 * @param hostUrl - the request's parsed authority.
 * @param trustedHosts - configured non-loopback authorities.
 * @returns whether the authority is trusted.
 */
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * Browser-trust fence for the plugin route.
 *
 * A DNS-rebinding / cross-site defense, not authentication: the Host must be
 * loopback or a trusted authority, cross-site browser markers are refused, and
 * a present Origin must name the same hostname.
 *
 * @param request - Node request facts.
 * @param trustedHosts - deployment's trusted authorities.
 * @returns whether the request may reach the plugin route.
 */
function isTrustedRequest(request, trustedHosts) {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/**
 * Write one JSON response.
 * @param response - Node response.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function writeJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/**
 * Read and decode one bounded JSON request body.
 * @param request - Node request.
 * @returns the decoded value.
 */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Read one workspace id out of a request body.
 * @param body - decoded request body.
 * @returns the workspace id.
 */
function workspaceIdOf(body) {
  const workspaceId = body !== null && typeof body === 'object' ? body.workspaceId : undefined
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    throw new Error('workspaceId must be a non-empty string')
  }
  return workspaceId
}

/**
 * Install the durable state route.
 * @param ctx - host Cordis context.
 */
export function apply(ctx) {
  const store = createStateStore()
  const prefix = '/workspace-sort/api/'

  /**
   * The browser half's last self-report, kept in memory only.
   *
   * This is runtime observability, not durable state: it answers "did the UI
   * wiring actually take effect in the running window?" — a question the DOM
   * unit tests cannot answer, because the sidebar's real markup is what the
   * plugin has to match. It resets on every host restart, like the DOM it
   * describes.
   */
  let diagnostic

  /**
   * Dispatch one plugin API method.
   * @param method - route name after the prefix.
   * @param body - decoded request body.
   * @returns the route's value.
   */
  async function dispatch(method, body) {
    switch (method) {
      case 'state':
        return store.read()
      case 'diagReport': {
        const report = body !== null && typeof body === 'object' ? body.report : undefined
        if (report === null || typeof report !== 'object' || Array.isArray(report)) {
          throw new Error('report must be an object')
        }
        diagnostic = { receivedAt: new Date().toISOString(), report }
        return { receivedAt: diagnostic.receivedAt }
      }
      case 'diagnostic':
        return diagnostic ?? null
      case 'sortMode': {
        const mode = body !== null && typeof body === 'object' ? body.mode : undefined
        if (mode !== 'manual' && mode !== 'updated') {
          throw new Error('mode must be "manual" or "updated"')
        }
        return store.update((state) => ({ ...state, sortMode: mode }))
      }
      case 'pin': {
        const workspaceId = workspaceIdOf(body)
        return store.update((state) => ({
          ...state,
          pinned: [workspaceId, ...state.pinned.filter((id) => id !== workspaceId)],
        }))
      }
      case 'unpin': {
        const workspaceId = workspaceIdOf(body)
        return store.update((state) => ({
          ...state,
          pinned: state.pinned.filter((id) => id !== workspaceId),
        }))
      }
      default:
        throw new Error(`unknown workspace-sort API method "${method}"`)
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/workspace-sort/api',
        handler: async (request, response) => {
          if (!isTrustedRequest(request, ctx.webRuntime.trustedHosts)) {
            writeJson(response, 403, { ok: false, error: { code: 'forbidden' } })
            return
          }
          if (request.method !== 'POST') {
            writeJson(response, 405, { ok: false, error: { code: 'method-error' } })
            return
          }
          const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
          if (!pathname.startsWith(prefix)) {
            writeJson(response, 404, { ok: false, error: { code: 'not-found' } })
            return
          }
          const method = pathname.slice(prefix.length)
          if (method === '' || method.includes('/')) {
            writeJson(response, 404, { ok: false, error: { code: 'not-found' } })
            return
          }
          try {
            writeJson(response, 200, { ok: true, value: await dispatch(method, await readJsonBody(request)) })
          } catch (error) {
            console.warn('[workspace-sort] API failure:', error)
            writeJson(response, 400, {
              ok: false,
              error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error) },
            })
          }
        },
      }),
    'dsh-workspace-sort: durable state route',
  )
}
