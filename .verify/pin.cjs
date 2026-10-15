'use strict'

/**
 * Pin or unpin one workspace through the live plugin route.
 *
 * Usage: node .verify/pin.cjs <pin|unpin> <workspaceId>
 *
 * Writes the plugin's own state file only; the running client half applies the
 * resulting order on its next state poll.
 */

const BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:19387'
const action = process.argv[2]
const workspaceId = process.argv[3]

if ((action !== 'pin' && action !== 'unpin') || workspaceId === undefined) {
  console.error('usage: node .verify/pin.cjs <pin|unpin> <workspaceId>')
  process.exit(2)
}

/** Send the pin change and report the host's answer. */
async function main() {
  const response = await fetch(`${BASE}/workspace-sort/api/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
    signal: AbortSignal.timeout(10000),
  })
  console.log(`${response.status} ${JSON.stringify(await response.json())}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
