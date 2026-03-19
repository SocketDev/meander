---
name: content-filename-from-title
description: Picks a short, URL-friendly filename for a meander walkthrough part or document. Use when adding or renaming `parts[].filename` or `documents[].filename` in `meander.config.json`.
---

# content-filename-from-title

<task>
Produce a short, lowercase, ASCII filename (no extension) that
best represents a titled meander page. The chosen string lands
in `meander.config.json` as either a `parts[].filename` (URL
becomes `/<slug>/parts/<filename>.html`) or a
`documents[].filename` (URL becomes `/<slug>/docs/<filename>`,
also referenced in `llms.txt`).
</task>

<context>
## Why this skill exists

Public URLs age badly when filenames carry implementation
detail (`walkthrough-part-1.html`), numbering (`part-3-x.html`),
or cluttering punctuation (`build-%26-emit.html`). A
content-bearing filename (`anatomy.html`, `building.html`,
`db-key.html`) stays speakable on a call, typeable from
hearing, and survives reorderings of the surrounding parts.

The decision is fuzzy enough that two contributors will arrive
at different answers. This skill captures the procedure so the
output is reproducible across sessions and authors.

## Where it applies in meander

Two `meander.config.json` slots accept the result:

1. **`parts[].filename`** — the slug for an emitted walkthrough
   part. URL: `/<slug>/parts/<filename>.html`.
2. **`documents[].filename`** — the slug for a doc page. URL:
   `/<slug>/docs/<filename>`. Also surfaces in the generated
   `llms.txt` and `llms-full.txt`.

Both fields are validated by TypeBox in
`/Users/jdalton/projects/meander/src/config.mts`
(`WalkthroughPartSchema`, `DocEntrySchema`). The shape regex is
the same in both:

```
^[a-z0-9][a-z0-9-]*$
```

`loadMeanderConfig` in the same file additionally cross-checks
**uniqueness across `parts[]` + `documents[]` combined** — a
collision throws at config-load time. This skill picks the
word; the loader enforces the shape and uniqueness.
</context>

<constraints>
## Hard constraints (loader-enforced)

- **Shape** matches `^[a-z0-9][a-z0-9-]*$`:
  - First character is a lowercase ASCII letter or digit.
  - Remaining characters are lowercase letters, digits, or
    hyphens.
  - No leading hyphen, no underscores, no dots, no slashes,
    no unicode.
- **Unique across the same `meander.config.json`**, against
  every other `parts[].filename` *and* `documents[].filename`.
  `loadMeanderConfig` throws if two entries collide.
- **Single concept.** Compound phrases that smash two ideas
  together are out (`building-and-stringifying`). A hyphen is
  fine when it joins parts of one term-of-art (`db-key`,
  `blob-key`); not fine when it concatenates two distinct
  topics.

## Soft constraints (style)

- **Typeable.** A reader should hear "go to the `building`
  page" and type it correctly without spelling.
- **Stable.** The word still makes sense if surrounding parts
  are reordered. `part-one` is unstable; `anatomy` is stable.
- **Content-bearing, not generic.** `page`, `doc`, `content`,
  `item`, `section` are out. The word should still mean
  something in a URL with no surrounding context.
- **Internally consistent across the manifest.** If the
  surrounding parts are gerunds (`parsing`, `building`), match
  that; if they are plain nouns (`anatomy`, `ecosystems`),
  match that. Don't mix unless the topic genuinely demands a
  different form.
</constraints>

<instructions>
## Decision procedure

Apply in order. Stop at the first rule that produces a clean
filename.

### Step 1 — Inventory the nouns in the title

List every noun and nominalized action (gerund, `-ion`,
`-ance`). Drop articles, prepositions, conjunctions ("and",
"&", "of"). Drop any noun that appears in two or more other
titles in the same manifest — those are qualifiers, not
distinguishers.

> **Why:** the filename has to distinguish this page from its
> siblings. A non-distinct word can never be load-bearing.

### Step 2 — Pick the distinguishing noun

If exactly one noun is unique to this title and the others
appear elsewhere in the manifest, that noun wins.

### Step 3 — If several nouns tie, pick the superset

When the title lists facets of one bigger concept, pick the
bigger one.

### Step 4 — If the title is "verb on a subject", pick the verb's nominal form

Use `-ing` (gerund) when the activity itself is the topic;
use `-ion` / `-ance` when the state or output is the topic.

### Step 5 — If the title is already a single content noun, lowercase it

`Anatomy` → `anatomy`. No transformation beyond casing.

### Step 6 — When the term is a multi-word term-of-art, hyphenate

Meander permits hyphens in `parts[].filename`/
`documents[].filename`, so multi-word internal terms can stay
hyphenated **as long as the hyphenated form names a single
concept**:

- `db-key` — the database wrapping key. One concept, two
  words. Hyphen is correct.
- `blob-key` — the blob wrapping key. One concept. Correct.
- `building-and-stringifying` — two concepts (building,
  stringifying). Wrong; pick one.

The test: would a developer in this codebase use the
hyphenated form when speaking? `db-key`, yes.
`building-and-stringifying`, never.

### Step 7 — Validate against hard constraints

Check the chosen filename:

1. Matches `^[a-z0-9][a-z0-9-]*$`.
2. Unique across every other `parts[].filename` AND
   `documents[].filename` in the same `meander.config.json`.
3. Single concept (Step 6 test).
4. Content-bearing (not `item`, `details`, `page`).

If any fails, return to Step 2 with the next-best candidate.

### Step 8 — Sanity check across the manifest

Read the chosen filename in the context of its neighbors. If
your pick is the odd one out (a gerund among plain nouns, a
hyphenated form among single words), prefer the form that
matches the surrounding family — internal consistency
outweighs individually-optimal word choice.
</instructions>

<examples>
## Worked examples

These titles are hypothetical meander walkthrough parts. Each
example shows the rule that produced the filename.

<example id="1">
<title>Anatomy of a Walkthrough</title>
<filename>anatomy</filename>
<reasoning>
Nouns: `Anatomy`, `Walkthrough`. `Walkthrough` recurs across
the manifest (it's the umbrella concept). `Anatomy` is unique.
Step 2: distinguishing noun.
</reasoning>
</example>

<example id="2">
<title>Building & Emitting Pages</title>
<filename>building</filename>
<reasoning>
Nouns: `Building`, `Emitting`, `Pages`. `Pages` is a qualifier
(every part is "about pages"). Emitting is a substep of
building. Step 3 (superset) + Step 4 (gerund). Result:
`building`.
</reasoning>
</example>

<example id="3">
<title>The Database Wrapping Key Ceremony</title>
<filename>db-key</filename>
<reasoning>
Nouns: `Database`, `Wrapping`, `Key`, `Ceremony`. The
domain-specific term-of-art in this codebase is "db-key" — one
concept, hyphenated. Step 6 applies. The alternative
`ceremony` is too abstract for a URL segment.
</reasoning>
</example>

<example id="4">
<title>Validation, Errors & Results</title>
<filename>validation</filename>
<reasoning>
Nouns: `Validation`, `Errors`, `Results`. Errors and results
are facets of validation. Step 3 (superset). Result:
`validation`.
</reasoning>
</example>

<example id="5">
<title>Encryption Primitives</title>
<filename>encryption</filename>
<reasoning>
Nouns: `Encryption`, `Primitives`. `Primitives` is too
abstract on its own. `Encryption` is the topic. Step 2
(distinguishing) + Step 5 (lowercase the noun).
</reasoning>
</example>

<example id="6">
<title>Ecosystems</title>
<filename>ecosystems</filename>
<reasoning>
Title is already a single content noun. Step 5: lowercase it.
</reasoning>
</example>

## Counter-examples — choices the procedure rejects

<example id="bad-1">
<title>Building & Emitting Pages</title>
<rejected>building-and-emitting</rejected>
<reasoning>
Two distinct concepts joined by `and`. Step 6 rejects: a
hyphen is for one concept made of multiple words, not for
gluing two ideas. Pick the superset (`building`) instead.
</reasoning>
</example>

<example id="bad-2">
<title>Anatomy of a Walkthrough</title>
<rejected>walkthrough</rejected>
<reasoning>
`Walkthrough` recurs across the manifest. Fails Step 1
(non-distinguishing). Also fails uniqueness if any other part
is using `walkthrough`.
</reasoning>
</example>

<example id="bad-3">
<title>The Database Wrapping Key Ceremony</title>
<rejected>dbkey</rejected>
<reasoning>
Smashes a multi-word term-of-art into one token, losing the
internal structure that helps a reader parse it. Meander
allows hyphens; use them when the hyphenated form is the
canonical spoken form (`db-key`, not `dbkey`).
</reasoning>
</example>

<example id="bad-4">
<title>Anatomy of a Walkthrough</title>
<rejected>part1</rejected>
<reasoning>
Numeric, generic, unstable to reordering, not content-bearing.
Fails the soft constraints on stability and content-bearing.
</reasoning>
</example>

<example id="bad-5">
<title>Acme Inc Integration</title>
<rejected>acme</rejected>
<reasoning>
Real customer or company names belong in walkthroughs only as
deliberate authoring choices — not as URL segments that bake
the name into the file path. Pick the technical concept the
walkthrough is about (e.g. `integration`, `webhooks`,
`auth`), not the customer.
</reasoning>
</example>
</examples>

<checklist>
## Checklist before adding a filename to `meander.config.json`

```
Filename choice: _______________

- [ ] Matches ^[a-z0-9][a-z0-9-]*$
- [ ] Unique across every parts[].filename AND
      documents[].filename in this meander.config.json
- [ ] Single concept (no `and`, no two-topic compounds)
- [ ] Content-bearing (not 'page', 'item', 'section')
- [ ] Stable under reordering (no 'part1', 'first')
- [ ] Typeable from hearing it spoken
- [ ] Style-consistent with neighbor filenames (gerund/noun/
      `-ion`/hyphenated — pick the family the manifest already
      uses)
```

If any checkbox fails, return to the decision procedure.
</checklist>

<when-not-to-use>
## When NOT to use this skill

- The filename is **internal** (build artifact under `dist/`,
  intermediate JSON in `.cache/`). Internal paths don't need
  to be pretty.
- The filename is **code-shaped**, not content-shaped. `.mts`
  source files follow the codebase's kebab-case + matching-
  export-name convention; this skill is for content URL
  segments.
- The slot exposes a **hash** or **date-based identifier**
  (release slug, blob key). Use the hash; it's already
  optimal.
- The walkthrough's `slug` field — that's the site-level
  identifier (`/<slug>/...`), not a per-page filename. Slug
  selection has different constraints (longer, more brand-
  bearing) and isn't covered here.
</when-not-to-use>

<further-reading>
- [reference.md](./reference.md) — edge cases, manifest-type
  notes, acronym + proper-noun handling, hyphenation
  guidance, schema regex quick-checks.
- `/Users/jdalton/projects/meander/src/config.mts` —
  `WalkthroughPartSchema` (line 24), `DocEntrySchema` (line
  85), `loadMeanderConfig` + `checkFilenameUniqueness`
  (line 541+).
- `/Users/jdalton/projects/meander/CLAUDE.md` § Consumer
  contract — the surrounding `meander.config.json` shape.
</further-reading>
