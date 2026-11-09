import { defineConfig } from 'vitepress'
import path from 'node:path'
import { smaltLight, smaltDark } from './theme/shiki'
import { smaltworksMenu, smaltworksFooter } from './theme/smaltworks'

const REPO = 'https://github.com/stenhoor/smaltts'
// Served at stenhoor.github.io/smaltts/ until the site has a domain of its own: then DOCS_BASE is '/'.
const base = process.env.DOCS_BASE ?? '/smaltts/'
const DESCRIPTION = 'smaltdb, straight from TypeScript.'

export default defineConfig({
  title: 'smaltts',
  description: DESCRIPTION,
  base,
  cleanUrls: true,
  lastUpdated: false,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon-32.svg` }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    ['link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;700&family=Geist+Mono:wght@400;500&family=Martian+Mono:wght@400;600&display=swap' }],
    ['meta', { property: 'og:title', content: 'smaltts' }],
    ['meta', { property: 'og:description', content: DESCRIPTION }],
    ['meta', { property: 'og:image', content: `https://stenhoor.github.io${base}social.png` }],
  ],
  markdown: {
    theme: { light: smaltLight, dark: smaltDark },
    config(md) {
      // Links that leave docs/ (sources, tests) point at the file on GitHub.
      const fallback = md.renderer.rules.link_open ?? ((t, i, o, _e, s) => s.renderToken(t, i, o))
      md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        const href = tokens[idx].attrGet('href')
        if (href && !/^[a-z]+:|^#|^\//i.test(href) && env?.relativePath) {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(env.relativePath), href))
          if (target.startsWith('../')) {
            tokens[idx].attrSet('href', `${REPO}/blob/HEAD/${target.slice(3)}`)
            tokens[idx].attrSet('target', '_blank')
            tokens[idx].attrSet('rel', 'noreferrer')
          }
        }
        return fallback(tokens, idx, options, env, self)
      }
    },
  },
  themeConfig: {
    logo: { light: '/lockup.svg', dark: '/lockup-on-dark.svg', alt: 'smaltts' },
    siteTitle: false,
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Reference', link: '/REFERENCE' },
      { text: 'Design', link: '/DESIGN' },
      { text: 'Status', link: '/guide/status' },
      smaltworksMenu(),
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Status', link: '/guide/status' },
        ],
      },
      {
        text: 'API reference',
        items: [
          { text: 'Conventions', link: '/REFERENCE#conventions' },
          { text: 'Attaching', link: '/REFERENCE#attaching' },
          { text: 'Specs and types', link: '/REFERENCE#specs-and-types' },
          { text: 'Catalog', link: '/REFERENCE#catalog' },
          { text: 'Change sets', link: '/REFERENCE#change-sets' },
          { text: 'Typed plans', link: '/REFERENCE#typed-plans' },
          { text: 'Views', link: '/REFERENCE#views' },
          { text: 'Loads and writes', link: '/REFERENCE#loads-and-writes' },
          { text: 'Flows', link: '/REFERENCE#flows' },
          { text: 'Plan review', link: '/REFERENCE#plan-review' },
          { text: 'Plugins and transactions', link: '/REFERENCE#plugins-and-transactions' },
          { text: 'The language', link: '/REFERENCE#the-language' },
          { text: 'Errors', link: '/REFERENCE#errors' },
        ],
      },
      {
        text: 'Design',
        items: [
          { text: 'Design', link: '/DESIGN' },
          { text: 'Decisions (ADRs)', link: '/adr/README' },
          { text: 'Milestones', link: '/MILESTONES' },
          { text: 'Research', link: '/research/README' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: REPO }],
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    footer: smaltworksFooter(base),
  },
})
