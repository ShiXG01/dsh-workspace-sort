'use strict'

/**
 * Report what the running window's UI wiring actually achieved.
 *
 * The browser half posts a diagnostic after every interface pass; this reads
 * it back. It is the only way to confirm that the plugin matched the sidebar's
 * *real* markup, since the DOM unit tests run against a reconstruction.
 *
 * Usage: node .verify/diagnostic.cjs
 */

const BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:19387'

/** Explain one view-options status in plain language. */
function explain(status) {
  switch (status) {
    case 'injected':
      return 'the sort group was inserted into the open view-options menu'
    case 'already-present':
      return 'the sort group is already in the open menu (nothing to do)'
    case 'menu-closed':
      return 'no view-options menu was open during this pass (normal)'
    case 'hidden-for-mode':
      return 'hidden because the grouping mode is the flat list (by design)'
    case 'menu-shape-unexpected':
      return 'THE MENU DID NOT MATCH the expected structure -- injection is NOT working'
    case 'error':
      return 'injection threw -- see the browser console'
    default:
      return `unrecognised status: ${status}`
  }
}

/** Read and explain the running window's self-report. */
async function main() {
  const response = await fetch(`${BASE}/workspace-sort/api/diagnostic`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(10000),
  })
  const payload = await response.json()

  if (payload.ok !== true) {
    console.log(`host route refused the request: ${JSON.stringify(payload)}`)
    process.exitCode = 1
    return
  }
  if (payload.value === null) {
    console.log('no diagnostic yet.')
    console.log('The browser half has not reported since the host started, which means the')
    console.log('client bundle is not running: restart the app (or toggle the plugin) so the')
    console.log('window loads the current lib/client.js.')
    process.exitCode = 1
    return
  }

  const { receivedAt, report } = payload.value
  console.log(`reported at    : ${receivedAt}`)
  console.log(`sort mode      : ${report.mode}    ready: ${report.ready}`)
  console.log(`language       : ${report.language}`)
  console.log('')
  console.log(`view options   : ${report.viewOptions}`)
  console.log(`                 ${explain(report.viewOptions)}`)
  console.log(`row pins       : ${report.rowPins} workspace row(s) decorated`)
  console.log(`context menu   : ${report.rowMenuInstalled === true ? 'installed' : 'NOT installed'}`)
  console.log(`footer panel   : ${report.panelSlot === true ? 'slot registered' : 'NOT registered'}`)
  console.log('')

  const problems = []
  if (report.rowMenuInstalled !== true) problems.push('the row context menu is not attached')
  if (report.panelSlot !== true) problems.push('the footer panel slot was never registered')
  if (report.rowPins === 0) problems.push('no workspace row was decorated (no rows, or rows not matched)')
  if (report.viewOptions === 'menu-shape-unexpected') {
    problems.push('the view-options menu structure did not match')
  }
  if (report.viewOptions === 'error') problems.push('the menu injection threw')

  if (problems.length === 0) {
    console.log('RESULT: PASS — every DOM augmentation and the footer slot are in place')
  } else {
    console.log('RESULT: attention needed')
    for (const problem of problems) console.log(`  - ${problem}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
