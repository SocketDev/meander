/**
 * @file Repo overlay over the fleet oxlint config (auto-discovered by the
 *   fleet lint runner, which prefers `.config/repo/` over the fleet
 *   canonical). The factory import gives the fully-resolved fleet config;
 *   `rules` here are appended after the fleet rules.
 */

import { defineConfig } from 'oxlint'

import { config } from '../fleet/oxlint.config.mts'

// oxlint-disable-next-line socket/no-default-export -- oxlint loads the config from this module's default export.
export default defineConfig(
  config({
    rules: {
      // Staged OFF from the type-aware tsgolint lane the fleet lint runner's
      // whole-tree gate turned on: first enforcement surfaced ~60 pre-existing
      // findings, dominated by the repo-wide `{ __proto__: null, ...options }
      // as SomeOptions` narrowing idiom (null-proto options bags) plus sqlite
      // row / JSON body narrowings in the Val Town backend. Each needs a
      // per-site typed-helper or type-guard rewrite, not a mechanical fix.
      // Delete this entry once the debt reaches zero findings — the fleet
      // lint-modernization campaign owns the burn-down.
      'typescript/no-unsafe-type-assertion': 'off',
    },
  }),
)
