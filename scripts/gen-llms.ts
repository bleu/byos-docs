/**
 * Emits public/llms.txt (index) and public/llms-full.txt (whole corpus, one fetch).
 *
 * Agents working inside an implementation repo read these files from the docs/shared/
 * submodule instead; this exists for agents that only have the published site.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = 'https://bleu.github.io/byos-docs'

const PAGES: { path: string; url: string; summary: string }[] = [
  {
    path: 'design-document.md',
    url: '/design-document',
    summary:
      'The normative BYOS specification: order flow, trampoline, escrow, proposal schema and API, gas accounting, penalties and attribution. Cited by ADRs in every implementation repo via stable #slugs.',
  },
  {
    path: 'glossary.md',
    url: '/glossary',
    summary: 'The joint domain vocabulary. Every shared term is defined here and nowhere else.',
  },
  {
    path: 'guides/sub-solver-integration.md',
    url: '/guides/sub-solver-integration',
    summary: 'How an external sub-solver goes from zero to a settled proposal.',
  },
  {
    path: 'operations/slo-targets.md',
    url: '/operations/slo-targets',
    summary: 'Latency targets for the proposal API and /solve, and the reasoning behind each.',
  },
  {
    path: 'security/trampoline-settlement-isolation.md',
    url: '/security/trampoline-settlement-isolation',
    summary:
      'Adversarial proof that a sub-solver route reaches only its own trampoline instance.',
  },
  {
    path: 'reference/cow-fee-collection.md',
    url: '/reference/cow-fee-collection',
    summary: 'How CoW fees work: a price wedge, settled by weekly accounting. Third-party background.',
  },
  {
    path: 'reference/cow-solver-slashing-policy.md',
    url: '/reference/cow-solver-slashing-policy',
    summary: "CoW's own penalty framework, which BYOS mirrors toward sub-solvers. Third-party background.",
  },
  {
    path: 'reference/solver-auctions.md',
    url: '/reference/solver-auctions',
    summary: "CoW's auction mechanism, including the fair combinatorial auction. Third-party background.",
  },
  {
    path: 'reference/solver-cips.md',
    url: '/reference/solver-cips',
    summary: 'The CIPs that govern solver behaviour. Third-party background.',
  },
]

const index = [
  '# BYOS — Bring Your Own Solver',
  '',
  '> A bonded CoW Protocol solver whose solutions are sourced from a permissionless set of external sub-solvers. This site is the normative specification shared by the contracts and service implementations.',
  '',
  '## Docs',
  '',
  ...PAGES.map((p) => `- [${p.url}](${SITE}${p.url}.md): ${p.summary}`),
  '',
  '## Optional',
  '',
  `- [Full corpus](${SITE}/llms-full.txt): every page above concatenated, for a single fetch.`,
  '- [bleu/byos-contracts](https://github.com/bleu/byos-contracts): Escrow, Trampoline, TrampolineFactory, and the contract-side ADRs.',
  '- [bleu/byos-service](https://github.com/bleu/byos-service): the Rust service, its ADRs, and the proposal API OpenAPI document.',
  '- [bleu/byos-service-ts](https://github.com/bleu/byos-service-ts): the TypeScript service.',
  '',
].join('\n')

const full = [
  '# BYOS — full documentation corpus',
  '',
  `Generated from ${SITE}. This specification is normative: where an implementation disagrees with it, the implementation is wrong.`,
  '',
  ...PAGES.flatMap((p) => ['', '---', '', `# FILE: ${p.path}`, '', readFileSync(join(root, p.path), 'utf8')]),
].join('\n')

// VitePress serves HTML, not markdown. Mirror each source file into public/ so the
// .md URLs advertised in llms.txt actually resolve, and an agent fetching one page
// gets markdown rather than a parsed-out article.
for (const p of PAGES) {
  const dest = join(root, 'public', p.path)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(join(root, p.path), dest)
}

mkdirSync(join(root, 'public'), { recursive: true })
writeFileSync(join(root, 'public/llms.txt'), index)
writeFileSync(join(root, 'public/llms-full.txt'), full)

console.log(`wrote public/llms.txt, public/llms-full.txt, and ${PAGES.length} raw markdown mirrors`)
