/**
 * Local dev entry: generate + serve the test fixture, with
 * optional file-watcher that re-runs generate on source change.
 *
 * Invoked via `pnpm dev` — serve-only by default, `--watch`
 * adds the file watcher. The watcher uses Node's `fs.watch`
 * across three scopes:
 *
 * - The fixture dir (source files referenced by parts + docs)
 * - Meander.config.json itself (config changes)
 * - Assets/ (CSS + client-side JS bundled into the emit)
 *
 * Events are debounced so a multi-file save (IDE formatters,
 * git checkouts) triggers a single regen, not one per file.
 */
import path from 'node:path'
import { watch as fsWatch } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// oxlint-disable-next-line socket/prefer-stable-self-import -- @socketsecurity/meander is not yet published; no -stable alias exists, so the src/ import is required. Revisit after first publish.
import { generate } from '../src/generate.mts'
// oxlint-disable-next-line socket/prefer-stable-self-import -- @socketsecurity/meander is not yet published; no -stable alias exists, so the src/ import is required. Revisit after first publish.
import { serve } from '../src/serve.mts'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

const logger = getDefaultLogger()

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const fixtureDir = path.join(repoRoot, 'test', 'fixtures', 'test-docs')
const assetsDir = path.join(repoRoot, 'assets')
const configPath = path.join(fixtureDir, 'meander.config.json')

const portArg = process.argv.find(a => a.startsWith('--port='))
const port = portArg ? Number(portArg.slice('--port='.length)) : 8080
const watchMode = process.argv.includes('--watch')

async function main(): Promise<void> {
  await generate(configPath, { __proto__: null })

  if (watchMode) {
    /* Fire-and-forget watcher — the serve() call below blocks
     * forever on its HTTP listener, so this promise is a
     * long-running sidecar. Any error escaping regenerate() is
     * logged + swallowed so a single bad save doesn't kill the
     * dev loop. */
    void startWatcher()
  }

  await serve(configPath, { port, __proto__: null })
}

async function startWatcher(): Promise<void> {
  /* Debounce window. Save-on-format triggers a burst of events
   * within ~50ms; 150ms catches them all while still feeling
   * live. Tune up if you see duplicate regens. */
  const DEBOUNCE_MS = 150
  let pending = false
  let timer: NodeJS.Timeout | undefined = undefined
  const kick = (reason: string): void => {
    if (timer) {
      clearTimeout(timer)
    }
    pending = true
    timer = setTimeout(() => {
      if (!pending) {
        return
      }
      pending = false
      timer = undefined
      const started = Date.now()
      generate(configPath, { __proto__: null })
        .then(() => {
          logger.log(`✓ regen (${reason}) in ${Date.now() - started}ms`)
        })
        .catch((e: unknown) => {
          logger.fail(`✗ regen failed (${reason}):`, e)
        })
    }, DEBOUNCE_MS)
  }

  /* Three independent watchers, each on its own scope. We
   * ignore both the new "pages/" emit dir and the legacy
   * "walkthrough/" dir explicitly by checking path prefixes —
   * writes from our own generate() would otherwise trigger an
   * infinite regen loop. Using both names handles the case
   * where the fixture still has a stale walkthrough/ sitting
   * around from before the outDir rename. */
  const ignoredOutDirs = new Set(['pages', 'walkthrough'])
  const watchOne = async (dir: string, reason: string): Promise<void> => {
    try {
      const watcher = fsWatch(dir, { recursive: true })
      for await (const event of watcher) {
        const name = event.filename ?? ''
        const firstSeg = name.split(path.sep, 1)[0] ?? ''
        if (ignoredOutDirs.has(firstSeg)) {
          continue
        }
        kick(`${reason}: ${name || '?'}`)
      }
    } catch (e) {
      logger.fail(`watcher ${reason} stopped:`, e)
    }
  }

  logger.log('→ watch: fixture sources + meander.config.json + assets/')
  /* Watchers are long-running loops; if one throws we still
   * want the other polling, so settle rather than all. Errors
   * are already logged inside watchOne. */
  await Promise.allSettled([
    watchOne(fixtureDir, 'fixture'),
    watchOne(assetsDir, 'assets'),
  ])
}

void main().catch((e: unknown) => {
  logger.fail(String(e))
  process.exitCode = 1
})
