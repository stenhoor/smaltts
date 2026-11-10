# CLAUDE.md

smaltts is a thin, typed TypeScript API for [smaltdb](https://smaltdb.dev), at the language layer beside smaltql
and smaltdf: typed plan and schema operations, with structured flows, for applications and layers that want neither
SQL nor dataframes. The design, its milestones and the research behind it are in [docs/DESIGN.md](docs/DESIGN.md),
[docs/MILESTONES.md](docs/MILESTONES.md) and [docs/research](docs/research/README.md); a prototype is in `src/`. The
language's decisions are recorded in [docs/adr](docs/adr/README.md): a significant decision gets a new ADR,
numbered in the one sequence all smalt repositories share (after smaltdb's 0001–0022).
Several Claude Code sessions work on the smalt repos in parallel and cannot see each other: this file is the shared
starting point, and its working rules match smaltdb's `CLAUDE.md`.

## Brand: read smalt-brand first

Before changing this repository's site, README, or how it describes the product, read smalt-brand's
[BRAND.md](https://github.com/stenhoor/smalt-brand/blob/main/BRAND.md) (the family table, and "Sites and READMEs", the
standard every product site and README follows) and
[DECISIONS.md](https://github.com/stenhoor/smalt-brand/blob/main/DECISIONS.md). A newer decision there wins over any
copy here: lines and roles change, and a copy taken before the change is out of date.

- Copy brand files and the site kit (`themes/vitepress/`) unchanged. To change them, change smalt-brand first, then
  copy them again.
- A change to this product's status or to what it does comes with a smalt-brand PR that updates smaltworks.dev (its
  status page and this product's page), linked with `Depends on:`.

## Commands

| Command | What it does | When |
|---|---|---|
| `npm ci && npm run deps` | Installs dependencies, then the pinned smaltdb build in `packed.json` | First, and again after every `npm ci` or `npm install` |
| `npm run check` | `npm test` (vitest; the reference's examples are stripped with smaltty and run) | Before every commit |
| `npm run docs:dev` | The docs site (VitePress) with live reload; `npm run docs:build` fails on dead links | Docs changes |

To try an unmerged smaltdb change: `node scripts/fetch-packed.mjs --local smaltdb=../smaltdb`.

## Layout

- `src/spec.ts`: specs (tables, indexes) and the typed builders. `src/catalog.ts`: a database read back as specs, from
  the engine's catalog API. `src/changes.ts`: diff, change sets, apply and history. `src/files.ts`: saved change-set files, replayed in order. `src/rel.ts`: relations (the named
  IR), expressions (`fn`, `agg` and the aliases) and compiling them to engine plans. `src/functions.ts`: the engine's
  functions, generated from its catalog by `node scripts/functions.mjs` (`test/functions.test.ts` fails when they
  change). `src/signatures.ts`: the TypeScript signatures of the engine's operations. `src/views.ts`: views' relations edited
  as ALTER TABLE renames what they read, and the tables they read. `src/database.ts`:
  `attach()` and the database API. `src/backend.ts`: engine and client backends. `src/source.ts`: the language name
  and view sources, with no engine import.
- `src/language.ts` is its own entry point (`@smaltworks/smaltts/language`, for where the engine runs): smaltts as a
  registered smaltdb language, for its views. The main entry point (`src/index.ts`) imports only `smaltdb/plan`.

## Rules for this library

- No SQL, anywhere: smaltts reaches the engine only through plans, schema operations, transactions and plugin calls.
- Builders return JSON-safe data; running is a separate call. Never prompt; never guess renames.
- Builders import `smaltdb/plan` (no engine), the language imports `smaltdb/language`; runtime imports of
  `smaltdb/engine` only in tests.
- **Expressions are the engine's operations, by their engine names** (`fn.<name>`, `agg.<name>`), with methods only
  where an operation has one meaning (ADR 0023). smaltts adds no meaning of its own.
- **Erasable TypeScript only** in `src/` (no `enum`, `namespace`, constructor parameter properties):
  `test/erasable.test.ts` strips every file with smaltty.
- What the engine cannot do is proposed to smaltdb (DESIGN.md section 11), not emulated here. An engine bug is pinned
  with a `test.fails` that names its finding.
- Never loosen or skip a test to get to green. Probe tests (`test/zz-*.test.ts`) are scratch files: never commit them.
  Don't reformat files with Prettier.
- No runtime dependencies. smaltdb is a peer dependency.
- **The API reference is the specification** (`docs/REFERENCE.md`): a change to the API changes it in the same PR.
  Its TypeScript examples are stripped with smaltty and run by `test/reference.test.ts`; mark an example of API that
  is not built yet with `<!-- spec:planned -->` on the line before it.
- **TypeScript tooling is smaltty's** (owner's decision, 2026-11-10): no `typescript` dependency. smaltts uses smaltty,
  and extends it, for parsing, stripping and checking; static checks return with smaltty's checker. Development and
  test tools allowed without asking: other smaltworks packages, Node's types and vitest (and VitePress for the site);
  none of them in deployed code.
- **The site** (`docs/`, deployed to GitHub Pages from `main` by `.github/workflows/docs.yml`) uses smalt-brand's
  VitePress theme, copied unchanged into `docs/.vitepress/theme/`, and its badges and logos in `docs/public/`.

## Working rules for sessions

- One task per branch and PR. Do not add unrelated work to an open PR: it holds up everything else in it.
- Mark unfinished work clearly, and open a PR only when CI passes.
- Read review comments on your PR and answer them with commits that say what they address.
- When a PR depends on another repo's PR, add a line such as `Depends on: stenhoor/smaltdb#12`.
- Issues: follow smaltdb's `CLAUDE.md` ("Issues").
- **Ask before adding outside code.** Ask the owner, and wait for a yes, before adding a package (a dependency of any
  kind, or a pin in `packed.json`), copying or bundling in someone else's code, or loading code from another site at run
  time (a CDN such as jsDelivr). Say what it is, its licence and size, what it's for, and why our own code can't do it.
  Outside code that a feature needs goes in a plugin, so it is named and optional, never in core.
