# BYOS documentation

The shared, normative specification for **BYOS (Bring Your Own Solver)** — a bonded CoW Protocol solver whose solutions are sourced from a permissionless set of external sub-solvers.

Published at **https://bleu.github.io/byos-docs**.

## What lives here, and what does not

This repo owns everything that constrains more than one implementation, or that a reader outside bleu needs: the design, the vocabulary, the sub-solver integration path, and the CoW protocol background all of it rests on.

Each implementation repo keeps its own ADRs. An ADR records *why* a decision was made; this repo records *what is true*. An ADR does not restate the specification — it cites a section of it:

```
Spec: docs/shared/design-document.md#penalties
      https://bleu.github.io/byos-docs/design-document#penalties
```

The local path is what agents, offline readers, and `grep` use, and it is pinned to the commit being audited. The URL is for anyone browsing on github.com, which cannot follow links into a submodule.

| Repo | Owns |
|---|---|
| [bleu/byos-contracts](https://github.com/bleu/byos-contracts) | Escrow, Trampoline, TrampolineFactory; Solidity style, contract-side rationale |
| [bleu/byos-service](https://github.com/bleu/byos-service) | The Rust service; the proposal API OpenAPI document; Rust engineering conventions |
| [bleu/byos-service-ts](https://github.com/bleu/byos-service-ts) | The TypeScript service |

## Where to start

**Auditors** — [the design document](design-document.md), top to bottom. It is normative: where an implementation disagrees with it, the implementation is wrong, unless the document carries a dated revision note saying otherwise. The status table at the top says what is built today. The adversarial isolation proof is in [trampoline / settlement isolation](security/trampoline-settlement-isolation.md).

**Sub-solvers** — [the integration guide](guides/sub-solver-integration.md). It is the path from zero to a settled proposal, and it links into the design document for anything normative.

**CoW team** — the design document's [order flow](design-document.md#order-flow) and [gas accounting](design-document.md#gas) sections cover everything that touches the protocol. Our reading of CoW's own mechanics is under [fee collection](reference/cow-fee-collection.md), [slashing policy](reference/cow-solver-slashing-policy.md), [auctions](reference/solver-auctions.md), and [CIPs](reference/solver-cips.md); corrections welcome.

**Agents** — read [`glossary.md`](glossary.md) and the design document sections relevant to your task. Inside an implementation repo these files are on disk at `docs/shared/`, pinned to the commit you are working on. From the web, [`/llms.txt`](https://bleu.github.io/byos-docs/llms.txt) indexes the corpus and [`/llms-full.txt`](https://bleu.github.io/byos-docs/llms-full.txt) is all of it in one fetch.

## Using it from an implementation repo

```bash
git submodule add https://github.com/bleu/byos-docs docs/shared
git submodule update --init --recursive   # in an existing clone
```

`docs/shared/` is read-only. Changes go through a PR here, then a pointer bump in the consuming repo.

## Local development

```bash
npm install
npm run dev      # http://localhost:5173/byos-docs/
npm run build    # also regenerates llms.txt and llms-full.txt
```
