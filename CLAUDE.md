# CLAUDE.md

smaltts is a planned thin, typed TypeScript API for [smaltdb](https://smaltdb.dev), at the language layer beside smaltql
and smaltdf. There is no code yet. Several Claude Code sessions work on the smalt repos in parallel and cannot see each
other: this file is the shared starting point, and its working rules match smaltdb's `CLAUDE.md`.

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
