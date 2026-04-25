# content-filename-from-title reference

Extended reference for the `content-filename-from-title` skill.
SKILL.md carries the decision procedure and the worked
examples; this file captures the edge cases, the alternative
manifest-style guidance, the hyphenation policy, and the schema
quick-checks.

## Table of contents

1. [When the procedure does not produce a clean word](#edge-cases)
2. [`parts[]` vs. `documents[]` — the two slots](#manifest-types)
3. [Hyphenation policy](#hyphenation)
4. [Acronyms, proper nouns, non-English titles](#special-tokens)
5. [Customer / company names — never](#real-names)
6. [Schema regex + uniqueness check](#schema)
7. [Cross-references](#cross-references)

---

<a id="edge-cases"></a>
## 1. When the procedure does not produce a clean word

The decision procedure covers the common cases. Tie-breakers in
order:

### Two words feel equally strong

When Steps 2–4 produce two candidates that both read as "the
topic" — pick the one that is:

1. **Shorter.** Fewer keystrokes, fewer chances to mistype.
2. **More common English.** A word the reader has seen in other
   contexts.
3. **Closer to the surrounding family.** If the manifest's
   other filenames are all gerunds, prefer a gerund. If all
   `-ion` forms, prefer `-ion`. Internal consistency outweighs
   one-off optimality.

If still tied, ask the author or flip a coin. The downstream
cost of a "wrong" pick is low — the loader only enforces shape
+ uniqueness, not optimality.

### The title is in a second language

Translate to English before applying the procedure. The
filename is a URL segment consumed globally; English is the
lowest-common-denominator. If the original-language word
happens to be a better fit *and* matches `^[a-z0-9][a-z0-9-]*$`,
that's acceptable — but default to English.

### The title contains a URL-unsafe character

Unicode, emoji, arrows, operators — translate to the nearest
ASCII equivalent during Step 7. Drop visual punctuation:

- "Build → Emit" — the arrow is visual; ignore it. Nouns are
  `Build`, `Emit`. Apply Step 4 (gerund) → `building` or
  `emitting`.
- "C++ Primer" — `++` isn't part of a noun. Pick the subject
  (`primer` is generic; pick what the primer is *about*).

### Every candidate noun is generic

If the title is "Overview" or "Introduction" and you're
choosing between `overview`, `intro`, `summary` — these are all
generic. Escape by picking what's being introduced:

- "Introduction to Walkthroughs" → `walkthrough` or
  `getting-started` (if hyphenation is acceptable in the
  manifest's style family).
- "Overview of the Build Pipeline" → `pipeline`.

If the title truly has no distinguishing noun, the title needs
work first. Push back on the author before inventing a
filename.

### The title's distinguishing noun is already taken

Order of fallbacks:

1. **Go to a synonym.** `errors` → `failures`, `validation`.
2. **Go to the verb form.** "Injection" already taken? Use
   `detecting` or `hardening`.
3. **Go to the object.** "Comment Encryption" → `comments` (if
   `encryption` is taken).
4. **Add a hyphenated qualifier** when the result is still a
   single concept. `db-key` works because "db-key" is the term
   used in this codebase. `injection-safety` does not — it's
   two concepts.

---

<a id="manifest-types"></a>
## 2. `parts[]` vs. `documents[]` — the two slots

Both fields use the same regex (`^[a-z0-9][a-z0-9-]*$`) and
share a common uniqueness namespace. The difference is the
emitted URL.

### `parts[].filename`

URL: `/<slug>/parts/<filename>.html`.

Walkthrough parts are the primary content artifact. Filenames
sit alongside `id`, `title`, `objective`, `keywords`, `files`.
The manifest typically holds 3–10 parts; internal consistency
across the set is worth optimizing for.

### `documents[].filename`

URL: `/<slug>/docs/<filename>` (no `.html` suffix in the URL —
the doc is served as-is from the slug). Also surfaces as a
link in the generated `llms.txt` and `llms-full.txt`, so the
filename is read by both humans and LLM agents.

`documents[]` accepts either a string shorthand
(`"path/to/file.md"`) or an object with `source`, `filename`,
`title`, and `summary`. Only the object form lets you set
`filename`; the shorthand uses the file's basename.

### Shared uniqueness namespace

`loadMeanderConfig` cross-checks every `parts[].filename`
against every `documents[].filename`. If both list `building`,
the loader throws at config-load time:

> filename "building" is used by both part 2 and doc
> "docs/building.md". Filenames must be unique across parts
> and docs.

When picking a filename, scan **both** arrays in the config,
not just the one you're editing.

---

<a id="hyphenation"></a>
## 3. Hyphenation policy

Meander's regex permits hyphens (`^[a-z0-9][a-z0-9-]*$`), which
is more permissive than a letters-only manifest. Use that
permission carefully:

### Allowed: hyphens that join one term-of-art

A multi-word term that this codebase or its readers use as a
single concept can stay hyphenated:

- `db-key` — the database wrapping key.
- `blob-key` — the blob wrapping key.
- `magic-code` — the email magic-code login flow.
- `getting-started` — common term-of-art, one concept.

Test: would a developer in this codebase use the hyphenated
form when *speaking*? "Open the db-key page" — yes.

### Not allowed: hyphens that smash two concepts

When a hyphen joins two distinct topics, pick the superset
instead:

- `building-and-stringifying` → pick `building` (or
  `stringifying`).
- `validation-errors-results` → pick `validation`.
- `auth-and-comments` → pick whichever the page is actually
  about.

Test: read it aloud. If it sounds like an `and`/`+`/`or` joins
two ideas, the procedure picks the wrong shape — go back to
Step 2 or Step 3.

### Allowed: digits in the body, but not for sequencing

The regex permits digits anywhere except as the very first
character of a leading hyphen-prefixed pattern. Use digits
when they're part of the term:

- `oauth2` — fine, the `2` is part of the protocol name.
- `step1` — bad, sequence number leaks ordering into the URL.

The first-character rule (`[a-z0-9]`) does technically allow
`2nd-pass` to start with a digit. Don't — it fails the
"content-bearing" soft constraint and the "stable under
reordering" check.

---

<a id="special-tokens"></a>
## 4. Acronyms, proper nouns, non-English titles

### Acronyms

Lowercase the acronym and use as a single token:

- `URL` → `url`
- `JSON` → `json`
- `SBOM` → `sbom`
- `CSP` → `csp`
- `SRI` → `sri`

Don't expand (`json`, not `javascriptobjectnotation`). Don't
CamelCase (which fails the regex). Don't hyphenate within an
acronym.

### Proper nouns / product names

Use the lowercase form of the recognizable name:

- `GitHub` → `github`
- `TypeScript` → `typescript`
- `Val Town` → `valtown` (concatenate — space isn't legal,
  hyphen is acceptable: `val-town`).
- `meander` → `meander`.

For brand names with internal capitals (`hljs`, `hLjS`), use
the lowercase form of the canonical short form (`hljs`).

### Non-English source text

Translate to English before picking a filename. If the
English is awkward, pick the underlying concept noun:

- "こんにちは" — title is a greeting; use `greeting` or
  `hello`, not transliterate.
- Pure transliterations (`konnichiwa`) tend to be unstable and
  unfamiliar to non-Japanese readers.

---

<a id="real-names"></a>
## 5. Customer / company names — never

Per `CLAUDE.md`, real customer or company names are forbidden
across public surface — and a URL segment is the most public
surface there is.

If a walkthrough is *about* a customer integration, pick the
**technical concept**, not the customer:

- "Acme Inc Integration" → `integration` or `webhooks` or
  `auth`, depending on the actual content. Never `acme`.
- "Setup Guide for Acme" → `setup`.
- "Migrating from Old Vendor to New Vendor" → `migration`.

If the brand is *meander itself* or an OSS dependency
(`github`, `valtown`, `typescript`), that's allowed because
it's a tool name, not a customer reference.

---

<a id="schema"></a>
## 6. Schema regex + uniqueness check

### Shape

```regex
^[a-z0-9][a-z0-9-]*$
```

Quick-check in a terminal:

```bash
echo -n "your-filename" | grep -qE '^[a-z0-9][a-z0-9-]*$' \
  && echo OK || echo FAIL
```

### TypeBox source

From `/Users/jdalton/projects/meander/src/config.mts`:

```ts
// WalkthroughPartSchema (line 24+)
filename: Type.Optional(
  Type.String({ pattern: '^[a-z0-9][a-z0-9-]*$', minLength: 1 }),
),

// DocEntrySchema (line 85+)
filename: Type.Optional(
  Type.String({ pattern: '^[a-z0-9][a-z0-9-]*$', minLength: 1 }),
),
```

Both fields are optional at the schema level. Parts that omit
`filename` fall back to `/<slug>/part/<id>.html` (numeric URL).
Docs that omit `filename` fall back to the markdown basename.
A skill consumer would only invoke this skill when *adding*
the optional `filename` to make the URL human-readable.

### Uniqueness

Cross-check via `loadMeanderConfig` →
`checkFilenameUniqueness` (`src/config.mts` line 541+):

```ts
function checkFilenameUniqueness(
  configPath: string,
  config: MeanderConfig,
): void {
  const seen = new Map<string, string>()
  for (const part of config.parts) {
    const fn = part.filename
    if (!fn) continue
    const prev = seen.get(fn)
    if (prev !== undefined) {
      throw new Error(
        `${configPath}: filename "${fn}" is used by both ${prev} ` +
        `and part ${part.id}. Filenames must be unique across ` +
        `parts and docs.`,
      )
    }
    seen.set(fn, `part ${part.id}`)
  }
  // ... same loop for config.documents ...
}
```

Quick-check from the repo root:

```bash
node -e "
const c = JSON.parse(require('fs').readFileSync('meander.config.json','utf8'));
const partFns = (c.parts ?? []).map(p => p.filename).filter(Boolean);
const docFns = (c.documents ?? [])
  .filter(d => typeof d === 'object')
  .map(d => d.filename)
  .filter(Boolean);
const all = [...partFns, ...docFns];
const dupes = all.filter((f, i) => all.indexOf(f) !== i);
if (dupes.length) console.log('DUPES:', dupes);
else console.log('OK — ' + all.length + ' unique filenames');
"
```

The loader throws on duplicates at config-load time, so the
build will fail anyway — this script just lets you find the
problem without running the full pipeline.

---

<a id="cross-references"></a>
## 7. Cross-references

- **SKILL.md** (this skill's main file) — the decision
  procedure and worked examples.
- `/Users/jdalton/projects/meander/src/config.mts`:
  - `WalkthroughPartSchema` (line 24) — `parts[]` shape.
  - `DocEntrySchema` (line 85) — `documents[]` shape.
  - `MeanderConfigSchema` (line 204) — top-level config.
  - `checkFilenameUniqueness` (line 547) — the cross-check.
  - `loadMeanderConfig` (line 591) — the loader entry point.
- `/Users/jdalton/projects/meander/CLAUDE.md` § Consumer
  contract — the surrounding `meander.config.json` shape and
  schema-evolution policy (breaking config changes need a
  major version bump).
