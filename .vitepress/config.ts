import { withMermaid } from 'vitepress-plugin-mermaid'

// Deployed as a GitHub Pages project site, so every URL is prefixed with the repo name.
const base = '/byos-docs/'

export default withMermaid({
  base,
  title: 'BYOS',
  description: 'Bring Your Own Solver — shared specification',
  cleanUrls: true,
  lastUpdated: true,

  // README.md is the site home too, so the entry point cannot drift between
  // GitHub and the published site.
  rewrites: { 'README.md': 'index.md' },

  // A broken link here means an ADR in an implementation repo is about to cite a
  // section that no longer exists. Fail the build instead.
  ignoreDeadLinks: false,

  themeConfig: {
    nav: [
      { text: 'Overview', link: '/overview' },
      { text: 'Design document', link: '/design-document' },
      { text: 'Sub-solver guide', link: '/guides/sub-solver-integration' },
      { text: 'Glossary', link: '/glossary' },
    ],

    sidebar: [
      {
        text: 'Overview',
        items: [{ text: 'What is BYOS', link: '/overview' }],
      },
      {
        text: 'Specification',
        items: [
          { text: 'Design document', link: '/design-document' },
          { text: 'Contracts reference', link: '/contracts' },
          { text: 'Service architecture', link: '/service' },
          { text: 'Glossary', link: '/glossary' },
        ],
      },
      {
        text: 'Guides',
        items: [{ text: 'Sub-solver integration', link: '/guides/sub-solver-integration' }],
      },
      {
        text: 'Operations',
        items: [{ text: 'SLO targets', link: '/operations/slo-targets' }],
      },
      {
        text: 'Security',
        items: [
          {
            text: 'Trampoline / settlement isolation',
            link: '/security/trampoline-settlement-isolation',
          },
        ],
      },
      {
        text: 'CoW protocol reference',
        collapsed: false,
        items: [
          { text: 'Fee collection', link: '/reference/cow-fee-collection' },
          { text: 'Solver slashing policy', link: '/reference/cow-solver-slashing-policy' },
          { text: 'Solver auctions', link: '/reference/solver-auctions' },
          { text: 'Solver CIPs', link: '/reference/solver-cips' },
        ],
      },
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/bleu/byos-docs' }],

    search: { provider: 'local' },

    editLink: {
      pattern: 'https://github.com/bleu/byos-docs/edit/main/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message:
        'This specification is normative. Where an implementation disagrees with it, the implementation is wrong.',
    },
  },
})
