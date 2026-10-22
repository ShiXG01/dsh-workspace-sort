'use strict'

// Artifact checks: the shipping bundle must parse as a classic script and
// register the expected module-loader id, and the host half must import
// cleanly as an ESM module with the expected cordis surface.

const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const assert = require('node:assert/strict')

const bundle = readFileSync('lib/client.js', 'utf8')
new vm.Script(bundle, { filename: 'lib/client.js' })

const idMatch = /id:\s*"([^"]+)"/.exec(bundle)
assert.equal(idMatch[1], 'dsh-workspace-sort', 'bundle must register the package id')
assert.ok(
  bundle.includes('window.__ModuleLoader__.load('),
  'bundle must register through the module loader',
)
assert.ok(!bundle.includes('export '), 'bundle must be a classic script, not an ESM module')

console.log(`client.js: parses OK, ${bundle.length} bytes, registers "${idMatch[1]}"`)

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

/** Import the host half and assert its cordis surface. */
async function main() {
  const host = await import('../lib/index.js')
  assert.equal(host.name, 'dsh-workspace-sort')
  assert.deepEqual([...host.inject], ['webServer', 'connection'])
  assert.equal(typeof host.apply, 'function')
  console.log(`index.js:  name "${host.name}", inject ${JSON.stringify([...host.inject])}`)
}
