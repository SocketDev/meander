import { defineConfig } from 'taze'

/* Socket-owned scopes that bypass the 7-day maturity window.
 * We trust ourselves to ship vetted releases; the cooldown
 * exists to catch compromised upstream packages before the
 * ecosystem catches them, and a Socket release going through
 * our own provenance + publish pipeline doesn't carry that
 * risk. A second pass (taze.config.socket.mts) runs with
 * maturityPeriod: 0 scoped to just these names. */
const SOCKET_SCOPES = [
  '@socketregistry/*',
  '@socketsecurity/*',
  '@socketdev/*',
  'socket-*',
  'ecc-agentshield',
  'sfw',
]

export default defineConfig({
  // Interactive mode disabled for automation.
  interactive: false,
  // Use minimal logging.
  loglevel: 'warn',
  // Skip Socket-owned packages here — they bump in the second
  // pass with maturityPeriod: 0 so new Socket releases land
  // without waiting out the cooldown window.
  exclude: SOCKET_SCOPES,
  // Only update packages that have been stable for 7 days.
  maturityPeriod: 7,
  // Update mode: 'latest'.
  mode: 'latest',
  // Write to package.json automatically.
  write: true,
})
