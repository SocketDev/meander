# Consumer build integration

How to wire `meander generate` into your project's own build
pipeline (CI, Makefile, rolldown bundle, whatever).

meander is usable as a CLI **and** as a library. Pick whichever
matches the rest of your toolchain.

## Option 1 — CLI, scripted

Simplest. Good if you only need it occasionally.

```json
// package.json
{
  "scripts": {
    "walkthrough": "meander generate meander.config.json",
    "walkthrough:preview": "meander serve meander.config.json"
  }
}
```

```bash
pnpm run walkthrough          # emit pages/
pnpm run walkthrough:preview  # watch + serve at localhost:8080
```

## Option 2 — Programmatic

Import the generator and call it from your own build script. Good
when you want meander output as one step in a larger pipeline (a
docs site build, a CI artifact upload, etc.).

```typescript
// scripts/build-walkthrough.mts
import { generate } from '@socketsecurity/meander'

await generate('./meander.config.json', {
  basePath: '/meander', // matches your hosting prefix
})
```

Invoke it the same way you run any other Node script:

```bash
node --experimental-strip-types scripts/build-walkthrough.mts
```

## Option 3 — Minify your pages at emit time

meander can run inline scripts through rolldown's minifier,
inline SVGs through svgo, and `meander.css` through csso at
emit time — enable via the config:

```json
{
  "minify": {
    "js": true,
    "svg": true,
    "css": true
  }
}
```

Requirements:

- `svgo` and `csso` are already installed as meander deps — no
  action needed for `svg: true` or `css: true`.
- For `js: true`, install rolldown in your project:

  ```bash
  pnpm add -D rolldown
  ```

  meander loads it dynamically. If rolldown isn't available, the
  JS pass logs + skips rather than aborting the build.

## GitHub Pages deploy

The simplest zero-cost hosting path. meander emits static HTML;
GitHub Pages serves it.

```yaml
# .github/workflows/pages.yml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<pinned-sha>
      - uses: pnpm/action-setup@<pinned-sha>
      - run: pnpm install
      - run: |
          node --input-type=module -e "
            import { generate } from '@socketsecurity/meander'
            await generate('./meander.config.json', { basePath: '/your-repo' })
          "
          # GH Pages skips files starting with _ without a .nojekyll marker.
          touch pages/.nojekyll
      - uses: actions/upload-pages-artifact@<pinned-sha>
        with:
          path: pages
```

Replace `--base-path=/your-repo` with your repo's URL path
(matches `https://<user>.github.io/<your-repo>/`). For a
project-level Pages deploy at the root, drop the option.

See meander's own
[`.github/workflows/pages.yml`](../../.github/workflows/pages.yml)
for a working reference.
