'use strict'

// Audit what the shipping bundle asks the module loader for. A request outside
// the frozen platform table would fail to materialise — and because the footer
// component is built inside `apply`, that failure would take the sidebar panel
// with it.

const { readFileSync } = require('node:fs')

const bundle = readFileSync('lib/client.js', 'utf8')

const literal = [
  ...new Set([...bundle.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1])),
]
const nonLiteral = [
  ...new Set([...bundle.matchAll(/require\(([^)"']+)\)/g)].map((m) => m[1])),
].filter((value) => !value.startsWith('"') && !value.startsWith("'"))

// The frozen baseline: React, Cordis and the static UI libraries.
const BASELINE = new Set(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'])

console.log('literal module requests :', JSON.stringify(literal))
console.log('non-literal requests    :', JSON.stringify(nonLiteral))
console.log('classic script (no ESM) :', !/^\s*export\s/m.test(bundle))
console.log('loader id               :', /id:\s*"([^"]+)"/.exec(bundle)[1])

const unexpected = literal.filter((id) => !BASELINE.has(id))
if (unexpected.length > 0) {
  console.log('')
  console.log('NOTE: these must be declared in dsh.client.inject to resolve:')
  for (const id of unexpected) console.log(`  - ${id}`)
} else {
  console.log('')
  console.log('RESULT: every request is in the frozen platform baseline (no inject needed)')
}

if (nonLiteral.length > 0) {
  console.log('RESULT: FAIL — the bundle resolves a module dynamically')
  process.exitCode = 1
}
