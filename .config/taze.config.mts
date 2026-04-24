import { defineConfig } from 'taze'

export default defineConfig({
  // Interactive mode disabled for automation.
  interactive: false,
  // Use minimal logging.
  loglevel: 'warn',
  // Only update packages that have been stable for 7 days.
  maturityPeriod: 7,
  // Update mode: 'latest'.
  mode: 'latest',
  // Write to package.json automatically.
  write: true,
})
