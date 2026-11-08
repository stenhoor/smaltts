---
layout: home

hero:
  name: 'sm<span class="alt">alt</span><span class="suffix language">ts</span>'
  text: 'Small. Alternative.<br>Typed.'
  tagline: smaltdb, straight from TypeScript.
  image:
    light: /generic-mark.svg
    dark: /generic-mark-on-dark.svg
    alt: smaltts
  actions:
    - theme: brand
      text: Getting started
      link: /guide/getting-started
    - theme: alt
      text: API reference
      link: /REFERENCE
    - theme: alt
      text: Status
      link: /guide/status

features:
  - title: Schemas as values
    details: Tables declared in TypeScript or discovered at run time are the same specs, read back from a database the same way.
    link: /REFERENCE#specs-and-types
    linkText: Specs and types
  - title: Changes you review first
    details: A diff is a change set, as data. Every step says its impact and what it may lose, and a policy decides whether it runs.
    link: /REFERENCE#change-sets
    linkText: Change sets
  - title: Typed plans
    details: The engine's plan operations with names instead of positions, and TypeScript types on every column. No query language in between.
    link: /REFERENCE#typed-plans
    linkText: Typed plans
  - title: Structured flows
    details: Migrations, loads, refreshes and checks as one reviewable flow, previewed before it runs, for the pipelines built on it.
    link: /REFERENCE#flows
    linkText: Flows
---

smaltts is a thin, typed TypeScript API over [smaltdb](https://smaltdb.dev)'s plan and schema operations, with
structured flows, for applications and layers that want neither SQL nor dataframes. It sits at the language layer,
beside [smaltql](https://stenhoor.github.io/smaltql/) and [smaltdf](https://stenhoor.github.io/smaltdf/).
