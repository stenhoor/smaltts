# CLAUDE.md

This repository is smaltts (`@smaltworks/smaltts`), the database-first, plan-first TypeScript API for
[smaltdb](https://github.com/stenhoor/smaltdb). The design, its engine findings and open questions are in
[docs/DESIGN.md](docs/DESIGN.md); the research behind it in [docs/research](docs/research/README.md). Several Claude
Code sessions work on the smalt repos in parallel and cannot see each other: this file is the shared starting point,
and its working rules match smaltdb's `CLAUDE.md`.

## Commands

| Command | What it does | When |
|---|---|---|
| `npm ci && npm run deps` | Installs dependencies, then the pinned smaltdb build in `packed.json` | First, and again after every `npm ci` or `npm install` |
| `npm run check` | `npm run typecheck` then `npm test` (vitest) | Before every commit |

To try an unmerged smaltdb change: `node scripts/fetch-packed.mjs --local smaltdb=../smaltdb`.

## Layout

- `src/spec.ts`: specs (tables, indexes) and the typed builders. `src/catalog.ts`: a database read back as specs.
  `src/changes.ts`: diff, change sets, apply and history. `src/rel.ts`: relations (the named IR) and compiling them to
  engine plans. `src/database.ts`: `attach()` and the database API. `src/backend.ts`: engine and client backends.
  `src/language.ts`: smaltts as a registered smaltdb language.

## Rules for this library

- No SQL, anywhere: smaltts reaches the engine only through plans, schema operations, transactions and plugin calls.
- Builders return JSON-safe data; running is a separate call. Never prompt; never guess renames.
- Builders import `smaltdb/plan` (no engine), the language imports `smaltdb/language`; runtime imports of
  `smaltdb/engine` only in tests.
- What the engine cannot do is proposed to smaltdb (DESIGN.md section 11), not emulated here. An engine bug is pinned
  with a `test.fails` that names its finding.
- Never loosen or skip a test to get to green. Probe tests (`test/zz-*.test.ts`) are scratch files: never commit them.
  Don't reformat files with Prettier.
- No runtime dependencies. smaltdb is a peer dependency.

## Working rules for sessions

- One task per branch and PR. Do not add unrelated work to an open PR.
- Mark unfinished work clearly, and open a PR only when CI passes.
- When a PR depends on another repo's PR, add a line such as `Depends on: stenhoor/smaltdb#12`.
