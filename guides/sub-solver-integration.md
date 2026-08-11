# Sub-solver integration

The path from zero to a settled proposal.

This guide is about sequence and gotchas. Every normative fact — field names, amounts, signature shapes, penalty numbers — lives in [the design document](../design-document) or the [OpenAPI document](https://github.com/bleu/byos-service/blob/main/crates/byos/openapi.yml), and is linked rather than repeated. If this guide and one of those ever disagree, they are right.

You do not need a CoW solver seat, an allowlist entry, or a relationship with the CoW DAO. You need an address, collateral in the escrow, and the ability to sign EIP-712 messages and quote a route.

## Your role as a sub-solver

**You are responsible for:**

- **Depositing collateral** into the Escrow. The deposit is the permission — there is no allowlist. Your balance must cover at least one worst-case Track A debit (`gas + c_l`).
- **Finding routable orders** in CoW's public orderbook and computing routes using any DEX or protocol.
- **Building complete routes**, including any pre- and post-hooks the order's app data requires. BYOS will reject proposals that omit required hooks, but passing that check does not transfer liability.
- **Sizing your `buyAmount` floor.** This is a margin call you make: too thin and your route reverts on-chain (Track A debit), too thick and you lose auctions.
- **Setting your own venue-level fees.** If your route goes through a pool you operate, you keep those fees. If you want to capture surplus above your floor, do it inside your route before the sweep.
- **Responding to Track B claims** within the 36-hour challenge window. Claims can arrive months after a trade.

**You are NOT responsible for:**

- **Transaction submission.** BYOS builds and submits the settlement through the CoW driver. You never call `settle`.
- **Scoring or auction bidding.** BYOS scores proposals (`surplus - gas`), selects the best one per order, and bids it into CoW's competition.
- **Gas estimation or fee calculation.** BYOS sizes the gas cut and the driver applies protocol/partner fees. Your amounts are raw, pre-fee route amounts.
- **Trampoline contract logic.** The sweep, the floor enforcement, and the sandbox isolation are contract code you cannot override.
- **CoW protocol compliance.** BYOS handles the relationship with the CoW DAO, the bonding pool, and the reward accounting. However, gatekeeping is non-exculpatory — your signed route is your responsibility.

## 1. What you are signing up for

You compute routes. BYOS bids them into CoW's auction under its own bonded solver seat, submits the settlement, and takes the consequences from the protocol. When a settlement carrying your route fails on-chain, BYOS charges that cost back to your escrow balance. **This is real money, debited without asking you first**, on the terms in [`#penalties`](../design-document#penalties).

The two things worth internalizing before you write any code:

Your signature covers your **complete route**, including any pre- and post-hooks the order's app data requires. BYOS checks for them at gatekeeping and rejects proposals that omit them, but passing that check does not transfer liability. Gatekeeping is preventive and explicitly [non-exculpatory](../design-document#gatekeeping).

The `buyAmount` you sign is a **floor, not a quote**. The contract enforces it as a minimum and reverts below it. Sizing that margin is your tradeoff and nobody else's: too thin and routes revert on-chain and cost you a [Track A](../design-document#track-a) debit, too thick and you lose auctions to sub-solvers who bid tighter.

## 2. Deposit collateral

Deposit native token into the [Escrow](../design-document#escrow) for your address. Anyone may fund an address, but only that address can withdraw.

Three things happen as a result:

- You become eligible to submit proposals. The deposit *is* the permission — there is no allowlist. The minimum is sized to cover a single worst-case Track A debit ([`#penalties`](../design-document#penalties)).
- Your [Trampoline](../design-document#topology) instance is deployed, at a deterministic CREATE2 address derived from your address. You pay that one-time gas. Routes never execute anywhere else.
- Your rate limit is set. It scales with your balance ([`#proposal-api`](../design-document#proposal-api)), so a larger deposit buys throughput as well as eligibility.

Exiting is deliberately not instant. Withdrawal is all-or-nothing behind a cooldown, and requesting it takes you offline for new proposals immediately ([`#withdrawal-and-freeze`](../design-document#withdrawal-and-freeze)). Plan for that: a balance you might need to pull at short notice is not a balance you should be operating on.

To rotate keys, ERC20-`transfer` your escrow balance to the new address rather than doing a withdraw-and-redeposit cycle. Transfer avoids the uncollateralized gap. The new address gets its own Trampoline instance, and your old proposals do not follow you — your address is your identity in all three roles at once: proposal signer, escrow key, and CREATE2 salt ([`#proposal-schema`](../design-document#proposal-schema)).

## 3. Find orders to route

BYOS does not run an orderbook and does not push you work. Orders come from CoW's public orderbook API, the same source every other solver reads.

Not every order is routable through BYOS. The [validation envelope](../design-document#simulation) rejects partially fillable orders, bridging orders, and orders using external or internal balance flavors. Filter for those before spending compute on a quote. Sell and buy orders are both supported, including native-ETH buys, and all four CoW signature schemes work.

One proposal covers exactly one order ([`#single-order-solutions`](../design-document#single-order-solutions)). There is no batch format and no netting across orders.

## 4. Build a route

A route is a list of raw calls: target, value, calldata. Any DEX, any protocol, no venue registry, no approval from BYOS. They execute as-is inside your Trampoline instance.

What the sandbox means for how you write one:

The instance holds only the sell amount BYOS pushes in for this settlement. It has no allowance over `GPv2Settlement` and no access to anyone else's instance. So a route that assumes it can reach protocol buffers, or that plants an approval expecting to use it against a funded contract later, gets nothing — the instance is empty between settlements by construction ([`#topology`](../design-document#topology)).

You do not need to return funds yourself. The Trampoline sweeps both trade tokens back to the settlement and enforces your floor, in contract code you cannot override ([`#order-flow`](../design-document#order-flow)). Delivering output straight to the settlement also works; the check measures what the settlement actually received.

Anything you deliver above your floor is **not yours** once the sweep runs. It becomes BYOS-owned settlement slippage. If you want to keep surplus, capture it inside your route before the sweep, or sign a higher floor — both are fine and neither is penalized ([`#residue`](../design-document#residue)).

Leave headroom above the user's limit price. BYOS takes a [gas cut](../design-document#gas) sized at the estimated settlement cost, and CoW's driver applies protocol and partner fees on top of that, after your amounts. A route quoted exactly at the limit produces an infeasible solution and will be skipped.

Amounts you sign are **raw, pre-fee route amounts**. Do not try to pre-subtract fees; the wedge is created downstream by the driver's price shift and lands in the settlement, not in your instance.

## 5. Sign the proposal

Sign the EIP-712 typed data in [`#proposal-schema`](../design-document#proposal-schema). The struct, the domain, and the typehash are owned by the contracts repo — derive them from [`bleu/byos-contracts`](https://github.com/bleu/byos-contracts) and test against the contract's own vectors rather than re-deriving them yourself. The same signature the API accepts is verified again on-chain by your Trampoline at settlement, so a mismatch fails late and expensively.

Two details that catch people:

The domain binds to the TrampolineFactory address, so it is per-chain **and per deployment generation**. A contracts v2 invalidates every outstanding signature and you must update your domain config.

Your route is committed to by hash. BYOS cannot substitute different interactions behind your signature — that is deliberate, and it is what makes a Track A debit something a third party can verify rather than something you have to take BYOS's word for.

Keep `validUntil` short. It is capped at ingestion ([`#proposal-lifecycle`](../design-document#proposal-lifecycle)), and a route priced longer ago than a few minutes is stale anyway.

## 6. Submit, then poll

`POST` the proposal. Endpoints, payload shape, status codes, and typed rejection reasons are in the [OpenAPI document](https://github.com/bleu/byos-service/blob/main/crates/byos/openapi.yml).

### API endpoint summary

All endpoints on the public listener (default port 9585):

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/proposals` | Proposal signature (in body) | Submit a signed proposal. Returns `202` with an id — **not** acceptance. |
| `GET` | `/proposal/{id}` | `X-Signature` (EIP-712 `ReadAuth`) | Fetch your proposal's status, rejection reason, settlement/penalty tx hashes. |
| `GET` | `/proposals/{order_uid}` | `X-Signature` | List your proposals on a specific order. |
| `GET` | `/proposals/by-sub-solver` | `X-Signature` | List all your proposals. |
| `DELETE` | `/proposal/{id}` | `X-Signature` (EIP-712 `CancelProposal`) | Cancel a proposal. Only works on `Submitted` or `Active` proposals. |

Read authentication uses a bearer-style EIP-712 signature over `ReadAuth { version: 1 }`. Sign it once and send it on every `GET` request via the `X-Signature` header. It carries no timestamp or nonce — the blast radius of a leak is read access to your own proposals only, no writes, no cancellation.

Non-owners always get `404` — not `403` — so you cannot probe whether a proposal id exists.

**A `2xx` is not acceptance.** It means "accepted for validation" and hands you an id. Escrow checks and simulation run in a background loop, not on the request path ([`#proposal-api`](../design-document#proposal-api)). Integration code that treats a `2xx` as "my proposal is live" is wrong.

Poll for the verdict. Reads are signature-gated and scoped to you — you sign a long-lived read token once and send it on every request, and you cannot see anyone else's proposals on an order, not even the fact that they exist. A proposal that is not yours returns 404 rather than 403, so do not read a 404 as "deleted".

Expect a verdict within roughly one block, bounded by the validator tick rather than by your request. Latency budgets are in [SLO targets](../operations/slo-targets).

Then keep polling. A live proposal is re-simulated every tick and can die at any point because the chain moved. Run a loop: quote, sign, submit, watch, resubmit. That loop is the intended operating mode, and several design decisions assume you have one.

To withdraw a proposal before it settles, send a signed cancellation. Proposals are immutable, so there is no update — replace by cancelling and posting a new one.

## 7. When things go wrong

| What happened | What it costs you | What to do |
|---|---|---|
| Rejected at gatekeeping | nothing | Read the typed reason and fix the route or the amounts. |
| Simulation reverted | nothing beyond a rate-limit slot | The proposal is dropped permanently on the first revert, with no retries. Resubmit if you still believe in the route — resubmission is how you say so. |
| Expired | nothing | Your `validUntil` passed. Shorten your loop. |
| Lost the auction | nothing | Normal. Your proposal stays live and competes again next auction. |
| Settlement reverted on-chain | a [Track A](../design-document#track-a) debit | Debited immediately. You have a dispute window on narrow, verifiable grounds. |
| BYOS won and did not settle | a smaller Track A debit | Same window, same grounds. |
| CoW raised an EBBO or fairness claim | a [Track B](../design-document#track-b) passthrough | Your balance is frozen on receipt and you get the certificate and evidence. Your refutation window is tight — see below. |

Simulation failures are free on purpose. They are usually environmental — a pool moved, the order filled elsewhere — and charging for them would punish honest participants. Only on-chain failures touch your escrow.

Reverts caused by BYOS's own orchestration rather than your route are BYOS's cost, not yours.

Track B is the one that needs operational readiness. Claims can arrive up to three months after the trade, your refutation window inside that is short, and the arbiter is the CoW core team rather than BYOS — so BYOS cannot fabricate a claim against you, but it also cannot waive one. If you cannot respond to evidence requests within a day and a half, that is a real risk to price in.

Every penalty action emits an on-chain Escrow event. That is the public record, and it is enough for you to audit your own history without trusting BYOS's private accounting.

## 8. Reference implementations

Two baseline sub-solver examples exist, one per service implementation. Both do the full loop: fetch orders from CoW's orderbook, quote a Uniswap V2 route, sign an EIP-712 proposal, submit, poll for verdict, resubmit.

| Language | Location | Notes |
|---|---|---|
| **Rust** | [`crates/subsolver`](https://github.com/bleu/byos-service/tree/main/crates/subsolver) in `byos-service` | Counterpart in the Rust service's end-to-end test suite |
| **TypeScript** | [`apps/subsolver`](https://github.com/bleu/byos-service-ts/tree/main/apps/subsolver) in `byos-service-ts` | Uses viem for EIP-712 signing, multicall for reserve fetching |

The protocol is language-neutral — what you want from either example is the sequence, the EIP-712 construction, and the polling behavior. Everything they do over the wire is specified in the OpenAPI document.

## Checklist before you go live

- Escrow funded above the minimum, and your Trampoline deployed (a deposit does both).
- EIP-712 hashes verified against contract-provided vectors, not your own re-derivation.
- Domain configuration pinned to the right chain and contracts generation.
- `validUntil` inside the ingestion cap.
- Route leaves headroom above the user's limit for the gas cut and the driver's fee shift.
- Required order hooks included in your interactions.
- A polling loop that resubmits, rather than fire-and-forget submission.
- An operational path for responding to a Track B claim inside its window.
