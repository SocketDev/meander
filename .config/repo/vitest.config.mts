/**
 * @file Vitest configuration.
 *   Matches the layout used across ../socket-* repos: tests live in
 *   test/`**`/`*.test.mts,` coverage uses v8, src/ is the only include.
 *   Fleet-canonical location: the fleet test/cover runners resolve this
 *   config at `.config/repo/vitest.config.mts` (see scripts/fleet/test.mts
 *   `ROOT_VITEST_CONFIG`). Without it, the runner falls back to vitest's
 *   default discovery, whose broad `**\/*.test.*` include wrongly sweeps in
 *   the `assets/val/lib/**\/*.test.ts` node:test suites (they run via
 *   `node --test` / `pnpm run test:val`, not vitest).
 *   Files intentionally excluded from coverage:
 *
 *   - src/cli.mts argv plumbing, exercised by CI smoke test and by running
 *     `meander …` during dev.
 *   - src/deploy-val.mts thin @valtown/sdk wrapper; needs a live Val Town account
 *     to exercise for real.
 *   - src/doctor.mts peer-dep probe, reports human-readable status; exercised
 *     manually.
 *   - src/publish.mts thin Val Town blob uploader; needs a live account + token.
 *   - src/render-mermaid.mts requires puppeteer + a headless browser in the
 *     runner.
 *   - src/generate.mts 2k LOC of HTML generation; covered via integration smoke
 *     tests against the fixture in test/fixtures/test-docs.
 */
import process from 'node:process'

import { configDefaults, defineConfig } from 'vitest/config'

const isCoverageEnabled =
  process.env['COVERAGE'] === 'true' ||
  process.env['npm_lifecycle_event']?.includes('coverage') ||
  process.argv.some(arg => arg.includes('coverage'))

if (isCoverageEnabled) {
  process.env['COVERAGE'] = 'true'
}

export default defineConfig({
  cacheDir: './node_modules/.cache/vitest',
  test: {
    deps: {
      interopDefault: false,
    },
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.mts'],
    // The assets/val/lib suites are node:test files (`node --test` /
    // `pnpm run test:val`), not vitest — they fail under vitest with
    // "No test suite found". The test/-only include above already skips
    // them, but keep an explicit exclude so a future include widening
    // can't silently pull them back in.
    exclude: [...configDefaults.exclude, 'assets/**'],
    reporters: ['default'],
    setupFiles: ['./test/utils/setup.mts'],
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: isCoverageEnabled,
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        '**/*.config.*',
        '**/node_modules/**',
        '**/[.]**',
        '**/*.d.ts',
        '**/virtual:*',
        'assets/**',
        'coverage/**',
        'dist/**',
        'docs/**',
        'scripts/**',
        'test/**',
        /* Excluded from coverage — see header comment for rationale. */
        'src/cli.mts',
        'src/deploy-val.mts',
        'src/doctor.mts',
        'src/generate.mts',
        'src/publish.mts',
        'src/render-mermaid.mts',
      ],
      all: true,
      clean: true,
      skipFull: false,
      ignoreClassMethods: ['constructor'],
      thresholds: {
        /* Lines/statements/functions are the meaningful coverage
         * signal; branch coverage dips because V8 surfaces micro-
         * branches in `??`, `&&`, and guard-expression chains that
         * only one side can be exercised in practice. 90% catches
         * real gaps without forcing contrived tests. */
        branches: 90,
        functions: 95,
        lines: 95,
        statements: 95,
      },
      reportsDirectory: './coverage',
      include: ['src/**/*.mts'],
    },
  },
})
