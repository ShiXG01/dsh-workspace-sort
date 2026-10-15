'use strict'

/**
 * Behavioural tests for the host half.
 *
 * The real `lib/index.js` is imported with `DSH_HOME` pointed at a scratch
 * directory, mounted onto a fake `ctx`, and driven through its own HTTP
 * handler — so the durable state store, the route dispatch and the
 * browser-trust fence are all exercised without touching a real DSH profile.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { pathToFileURL } = require('node:url')

// Scratch state lives in the OS temp directory, so a run never litters the
// package. The path is unique per process, so concurrent runs cannot collide.
const SCRATCH = join(tmpdir(), `dsh-workspace-sort-test-${process.pid}`)
const HOME = join(SCRATCH, 'home')
const DATA_DIR = join(HOME, 'workspace-sort')
const STATE_PATH = join(DATA_DIR, 'state.json')

rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })
test.after(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

// The module reads DSH_HOME at load time, so seed both the environment and a
// damaged state file before importing it.
process.env.DSH_HOME = HOME
writeFileSync(STATE_PATH, '{ this is not json', 'utf8')

/** One fake Node request carrying a JSON body. */
function createRequest(options = {}) {
  const body = options.body === undefined ? {} : options.body
  const text = options.rawBody === undefined ? JSON.stringify(body) : options.rawBody
  return {
    method: options.method ?? 'POST',
    url: options.url ?? '/workspace-sort/api/state',
    headers: options.headers ?? { host: '127.0.0.1:19387' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text, 'utf8')
    },
  }
}

/** One fake Node response capturing status and body. */
function createResponse() {
  const captured = { status: 0, body: '' }
  return {
    captured,
    writeHead(status) {
      captured.status = status
    },
    end(text) {
      captured.body = text === undefined ? '' : String(text)
    },
  }
}

/**
 * Mount the host half and return a caller for its route.
 * @returns the mounted harness.
 */
async function mount() {
  const module = await import(pathToFileURL(join(__dirname, '..', 'lib', 'index.js')).href)
  const registrations = []
  const disposers = []
  const ctx = {
    webServer: {
      register(registration) {
        registrations.push(registration)
        return () => {}
      },
    },
    webRuntime: { trustedHosts: ['lan.example.test:8080'] },
    effect(callback) {
      disposers.push(callback())
    },
  }
  module.apply(ctx)
  const registration = registrations[0]
  return {
    module,
    registration,
    /** Call one route and decode the JSON reply. */
    async call(options) {
      const request = createRequest(options)
      const response = createResponse()
      await registration.handler(request, response)
      return { status: response.captured.status, payload: JSON.parse(response.captured.body) }
    },
    /** Call one API method with a JSON body. */
    method(name, body) {
      return this.call({ url: `/workspace-sort/api/${name}`, body })
    },
    dispose() {
      for (const dispose of disposers) if (typeof dispose === 'function') dispose()
    },
  }
}

test('a damaged state file resets to defaults and is preserved for inspection', async () => {
  const host = await mount()
  const state = await host.method('state')
  assert.equal(state.status, 200)
  assert.deepEqual(state.payload, { ok: true, value: { version: 1, sortMode: 'manual', pinned: [] } })
  const backups = readdirSync(DATA_DIR).filter((name) => name.includes('.corrupt-'))
  assert.equal(backups.length, 1, 'the damaged file must be kept, not silently dropped')
  host.dispose()
})

test('the route is registered on the plugin prefix', async () => {
  const host = await mount()
  assert.equal(host.registration.kind, 'prefix')
  assert.equal(host.registration.path, '/workspace-sort/api')
  assert.deepEqual([...host.module.inject], ['webServer', 'webRuntime'])
  assert.equal(host.module.name, 'dsh-workspace-sort')
  host.dispose()
})

test('the sort mode round-trips and is persisted to disk', async () => {
  const host = await mount()
  const updated = await host.method('sortMode', { mode: 'updated' })
  assert.equal(updated.payload.value.sortMode, 'updated')
  assert.equal(JSON.parse(readFileSync(STATE_PATH, 'utf8')).sortMode, 'updated')

  const manual = await host.method('sortMode', { mode: 'manual' })
  assert.equal(manual.payload.value.sortMode, 'manual')
  assert.equal(JSON.parse(readFileSync(STATE_PATH, 'utf8')).sortMode, 'manual')
  host.dispose()
})

test('pinning keeps the most recent pin first and never duplicates', async () => {
  const host = await mount()
  await host.method('pin', { workspaceId: 'w1' })
  await host.method('pin', { workspaceId: 'w2' })
  const again = await host.method('pin', { workspaceId: 'w1' })
  assert.deepEqual(again.payload.value.pinned, ['w1', 'w2'])

  const removed = await host.method('unpin', { workspaceId: 'w1' })
  assert.deepEqual(removed.payload.value.pinned, ['w2'])
  assert.deepEqual(JSON.parse(readFileSync(STATE_PATH, 'utf8')).pinned, ['w2'])
  host.dispose()
})

test('the fence admits loopback and trusted authorities only', async () => {
  const host = await mount()
  const loopback = await host.method('state')
  assert.equal(loopback.status, 200)

  const trusted = await host.call({
    url: '/workspace-sort/api/state',
    headers: { host: 'lan.example.test:8080' },
  })
  assert.equal(trusted.status, 200)

  const crossSite = await host.call({
    url: '/workspace-sort/api/state',
    headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(crossSite.status, 403)

  const foreignHost = await host.call({
    url: '/workspace-sort/api/state',
    headers: { host: 'evil.example.test' },
  })
  assert.equal(foreignHost.status, 403)

  const foreignOrigin = await host.call({
    url: '/workspace-sort/api/state',
    headers: { host: '127.0.0.1:19387', origin: 'http://evil.example.test' },
  })
  assert.equal(foreignOrigin.status, 403)

  const sameOrigin = await host.call({
    url: '/workspace-sort/api/state',
    headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' },
  })
  assert.equal(sameOrigin.status, 200)
  host.dispose()
})

test('malformed requests are refused with a typed error instead of throwing', async () => {
  const host = await mount()
  const get = await host.call({ method: 'GET', url: '/workspace-sort/api/state' })
  assert.equal(get.status, 405)

  const unknown = await host.method('nope')
  assert.equal(unknown.status, 400)
  assert.equal(unknown.payload.ok, false)

  const badMode = await host.method('sortMode', { mode: 'sideways' })
  assert.equal(badMode.status, 400)

  const badPin = await host.method('pin', {})
  assert.equal(badPin.status, 400)

  const nested = await host.call({ url: '/workspace-sort/api/pin/extra' })
  assert.equal(nested.status, 404)

  assert.equal(existsSync(STATE_PATH), true)
  host.dispose()
})

test('the diagnostic channel carries the browser half report back to the host', async () => {
  const host = await mount()

  // Nothing reported yet.
  const before = await host.method('diagnostic')
  assert.equal(before.payload.value, null)

  const report = { viewOptions: 'injected', rowPins: 14, panelSlot: true, mode: 'updated' }
  const written = await host.method('diagReport', { report })
  assert.equal(written.payload.ok, true)
  assert.ok(typeof written.payload.value.receivedAt === 'string')

  const after = await host.method('diagnostic')
  assert.deepEqual(after.payload.value.report, report)
  assert.ok(typeof after.payload.value.receivedAt === 'string')
  host.dispose()
})

test('a diagnostic report that is not an object is refused', async () => {
  const host = await mount()
  for (const report of ['text', 7, [], null]) {
    const response = await host.method('diagReport', { report })
    assert.equal(response.status, 400, `report ${JSON.stringify(report)} must be refused`)
  }
  const missing = await host.method('diagReport', {})
  assert.equal(missing.status, 400)
  host.dispose()
})

test('the diagnostic is never persisted, since it describes one running window', async () => {
  const host = await mount()
  const report = { viewOptions: 'injected', rowPins: 3 }
  await host.method('diagReport', { report })
  // The durable state file must not have gained a diagnostic section.
  const persisted = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  assert.deepEqual(Object.keys(persisted).sort(), ['pinned', 'sortMode', 'version'])
  host.dispose()
})
