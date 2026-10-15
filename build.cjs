'use strict'

/**
 * Zero-dependency bundler for dsh-workspace-sort's browser half.
 *
 * The host serves `lib/client.js` and requires only that it registers its
 * factory through `window.__ModuleLoader__.load` — it does not require tsdown,
 * rolldown or any other toolchain. This script therefore inlines the shared
 * pure logic (`lib/order.cjs`) and the browser body (`lib/client.src.js`) into
 * a single classic script, then compiles it to prove the artifact parses.
 *
 * Each source file is wrapped in its own block so their top-level `const`
 * declarations cannot collide while `exports` still reaches the factory's
 * `module.exports`.
 */

const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')
const vm = require('node:vm')

const ROOT = __dirname
const ID = 'dsh-workspace-sort'
const ORDER_PATH = join(ROOT, 'lib', 'order.cjs')
const MENU_PATH = join(ROOT, 'lib', 'menu.cjs')
const CLIENT_SRC_PATH = join(ROOT, 'lib', 'client.src.js')
const OUTPUT_PATH = join(ROOT, 'lib', 'client.js')

/**
 * Indent every non-empty line of one chunk.
 * @param text - source text.
 * @param tabs - number of leading tabs to add.
 * @returns the indented text.
 */
function indent(text, tabs) {
  const pad = '\t'.repeat(tabs)
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : pad + line))
    .join('\n')
}

/**
 * Wrap one source file in its own block scope.
 * @param label - human-readable file label for the banner comment.
 * @param source - file contents.
 * @returns the block-wrapped source.
 */
function block(label, source) {
  return `// ── ${label} ${'─'.repeat(Math.max(0, 62 - label.length))}\n{\n${indent(source.trimEnd(), 1)}\n}`
}

/**
 * Build the factory body shared by the bundle and its tests.
 * @returns the wrapped browser-half source.
 */
function buildBody() {
  return [
    block('lib/order.cjs (shared pure ordering logic)', readFileSync(ORDER_PATH, 'utf8')),
    block('lib/menu.cjs (shared pure UI decisions)', readFileSync(MENU_PATH, 'utf8')),
    block('lib/client.src.js (browser half)', readFileSync(CLIENT_SRC_PATH, 'utf8')),
  ].join('\n\n')
}

/**
 * Build the shippable module-loader bundle.
 * @returns the complete `lib/client.js` source.
 */
function buildBundle() {
  return [
    'window.__ModuleLoader__.load({',
    `\tid: ${JSON.stringify(ID)},`,
    '\tfactory: (require) => {',
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    indent(buildBody(), 2),
    '\t\treturn module.exports;',
    '\t}',
    '});',
    '',
  ].join('\n')
}

const bundle = buildBundle()

// Compile before writing: a syntax error must fail the build, not the browser.
new vm.Script(bundle, { filename: OUTPUT_PATH })

mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
writeFileSync(OUTPUT_PATH, bundle, 'utf8')
console.log(`built ${OUTPUT_PATH} (${Buffer.byteLength(bundle)} bytes)`)

module.exports = { buildBody, buildBundle, ID, OUTPUT_PATH }
