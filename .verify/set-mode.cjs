'use strict'

/**
 * Set the durable workspace sort mode through the live plugin route.
 *
 * Usage: node .verify/set-mode.cjs <manual|updated>
 *
 * This writes the plugin's own state file only; the running client half picks
 * the change up on its next state poll and applies the resulting order.
 */

const BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:19387'
const mode = process.argv[2]

if (mode !== 'manual' && mode !== 'updated') {
  console.error('usage: node .verify/set-mode.cjs <manual|updated>')
  process.exit(2)
}

/** Send the mode change and report the host's answer. */
async function main() {
  const response = await fetch(`${BASE}/workspace-sort/api/sortMode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
    signal: AbortSignal.timeout(10000),
  })
  console.log(`${response.status} ${JSON.stringify(await response.json())}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

