# Minimal meander example

The smallest runnable meander project: one part, one source file,
two annotations.

## Run it

From this directory:

```bash
pnpm install -g @socketsecurity/meander
meander generate meander.config.json
meander serve meander.config.json
```

Open http://127.0.0.1:8080 — you should see an index page with
one part link, and the part page should show two prose cards
paired with the code from `src/app.ts`.

## What's inside

```
minimal/
├── meander.config.json    ← one part, pointing at src/app.ts
├── src/
│   └── app.ts             ← two block comments + two tiny functions
└── README.md              ← this file
```

## What to try next

- Add a second file to `files:` in `meander.config.json` and
  watch meander stitch them together on the same part page.
- Add a second part with its own `keywords` and `objective`.
- Peek at
  [`example/consumer-build/`](../consumer-build/README.md) for
  how to hook meander into a consumer's own build pipeline.
