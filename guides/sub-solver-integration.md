# Sub-solver integration

This guide tells you how to go from zero to a settled proposal.

All normative facts (field names, amounts, signature formats, penalty amounts) are in [the design document](../design-document) or the [OpenAPI document](https://github.com/bleu/byos-service/blob/main/crates/byos/openapi.yml). This guide links to them and does not repeat them. If this guide and one of those disagree, the source document is correct.

You do not need a CoW solver seat, an allowlist entry, or a relationship with CoW DAO. You need an address, collateral in the Escrow, and the ability to sign EIP-712 messages.

## Your role as a sub-solver

**You are responsible for:**

- **Collateral.** Deposit funds into the Escrow. Your balance must be more than one worst-case Track A debit (`gas + c_l`).
- **Order selection.** Find orders in CoW's public orderbook. Compute any route that delivers buy tokens to the GPv2Settlement contract. Assume execution from Trampoline with sell tokens on it.
- **Floor margin.** Set the `buyAmount` floor in your proposal. If the floor is too close to the route output, your route can revert on-chain (Track A debit). If the floor is too far below, you lose auctions.
- **Venue-level fees.** If your route goes through a pool you operate, you keep those fees. To capture surplus above your floor, do it inside your route before the sweep. Any remaining tokens in the Trampoline belong to you to claim or use in future trades.
- **Responding to Track B claims** within the 36-hour challenge window. Claims can arrive months after a trade.

**You are NOT responsible for:**

- **Transaction submission.** BYOS builds and submits the settlement through the CoW driver. You never call `settle`.
- **Scoring.** BYOS scores proposals (`surplus - gas`), selects the best one per order, and bids it into CoW's auction.
- **Gas estimation or fee calculation.** BYOS sizes the gas cut. The driver applies protocol and partner fees. Your amounts are raw, pre-fee route amounts.
- **Trampoline contract logic.** The sweep, the floor check, and the sandbox isolation are in the contract code. You cannot change them.
- **CoW protocol compliance.** BYOS manages the relationship with CoW DAO, the bonding pool, and the reward accounting. But gatekeeping is non-exculpatory. Your signed route is your responsibility.

## 1. Understand the risks

You compute routes. BYOS bids them into CoW's auction under its own bonded solver seat. BYOS submits the settlement and takes the consequences from the protocol.

When a settlement that carries your route fails on-chain, BYOS debits the cost from your escrow balance. **BYOS debits this amount without prior approval.** Read the terms in [`#penalties`](../design-document#penalties).

**The `buyAmount` is a floor, not a quote.** The contract enforces it as a minimum. If the route delivers less than this amount, the settlement reverts. You set the margin between the floor and the expected route output. A [Track A](../design-document#track-a) debit is the penalty for a revert. A floor that is too far below the output loses auctions.

## 2. Deposit collateral

Deposit native token into the [Escrow](../design-document#escrow) for your address. Any address can fund a sub-solver address. Only the sub-solver address can withdraw.

The deposit causes three effects:

1. **You can submit proposals.** The deposit is the only requirement. The minimum balance must be enough for a single worst-case Track A debit ([`#penalties`](../design-document#penalties)).
2. **BYOS deploys your [Trampoline](../design-document#topology) instance.** The instance has a deterministic CREATE2 address that is based on your address. You pay this one-time gas cost. All your routes execute in this instance.
3. **BYOS sets your rate limit.** The rate limit scales with your balance ([`#proposal-api`](../design-document#proposal-api)). A larger deposit gives more throughput.

### Withdrawal

Withdrawal is not instant. It is all-or-nothing with a cooldown period. When you request a withdrawal, your effective balance drops to zero immediately. You cannot submit proposals during the cooldown. See [`#withdrawal-and-freeze`](../design-document#withdrawal-and-freeze).

### Key rotation

To rotate keys, use the ERC20 `transfer` function to move your escrow balance to the new address. Do not withdraw and redeposit. A transfer prevents the gap where you have no collateral.

The new address gets its own Trampoline instance. Your old proposals do not follow you. Your address serves three roles: proposal signer, escrow key, and CREATE2 salt ([`#proposal-schema`](../design-document#proposal-schema)).

## 3. Find orders to route

BYOS does not operate an orderbook. Orders come from CoW's public orderbook API.

One proposal covers one order ([`#single-order-solutions`](../design-document#single-order-solutions)). There is no batch format.

## 4. Build a route

A route is a list of raw calls. Each call has a target, a value, and calldata. You can use any DEX or protocol. BYOS does not maintain a venue registry. The calls execute as-is inside your Trampoline instance.

### Sandbox constraints

Your Trampoline instance holds only the sell amount that BYOS pushes in for this settlement. The instance has no allowance over `GPv2Settlement`. It has no access to other sub-solver instances. The instance is empty between settlements ([`#topology`](../design-document#topology)).

A route that tries to access protocol buffers gets nothing. A route that plants an approval for future use against a funded contract gets nothing.

### Headroom

Leave headroom above the user's limit price. BYOS takes a [gas cut](../design-document#gas) from the trade. The CoW driver applies protocol and partner fees on top. If a route quotes exactly at the limit, BYOS skips it because the solution is not feasible.

Sign **raw, pre-fee route amounts**. Do not pre-subtract fees. The driver creates the fee wedge after your amounts. The wedge stays in the settlement, not in your instance.

## 5. Sign the proposal

Sign the EIP-712 typed data described in [`#proposal-schema`](../design-document#proposal-schema). Get the struct, domain, and typehash from [`bleu/byos-contracts`](https://github.com/bleu/byos-contracts). Test your signatures against the contract's own test vectors. Do not derive the typehash yourself.

The API verifies your signature at submission. The Trampoline verifies the same signature on-chain at settlement. If the two do not match, the settlement fails.

### Domain binding

The EIP-712 domain binds to the TrampolineFactory address. The domain is specific to a chain **and** a deployment generation. A contracts v2 deployment invalidates all outstanding signatures. Update your domain configuration when contracts change.

### Route commitment

The `interactionsHash` field in the signed struct commits to your route. BYOS cannot substitute different interactions. A third party can verify that the signed data matches the settlement calldata. This property makes Track A debits verifiable.

### Expiry

Keep `validUntil` short. BYOS caps it at ingestion ([`#proposal-lifecycle`](../design-document#proposal-lifecycle)). A route that is more than a few minutes old is stale.

## 6. Submit and poll

Send a `POST` request with the proposal. See the [OpenAPI document](https://github.com/bleu/byos-service/blob/main/crates/byos/openapi.yml) for the payload format, status codes, and rejection reasons.

### API endpoints

All endpoints are on the public listener (default port 9585):

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/proposals` | Proposal signature (in body) | Submit a signed proposal. Returns `202` with an id. This is **not** acceptance. |
| `GET` | `/proposal/{id}` | `X-Signature` (EIP-712 `ReadAuth`) | Get your proposal status, rejection reason, and settlement/penalty tx hashes. |
| `GET` | `/proposals/{order_uid}` | `X-Signature` | List your proposals on one order. |
| `GET` | `/proposals/by-sub-solver` | `X-Signature` | List all your proposals. |
| `DELETE` | `/proposal/{id}` | `X-Signature` (EIP-712 `CancelProposal`) | Cancel a proposal. Works only on `Submitted` or `Active` proposals. |

### Read authentication

Sign an EIP-712 `ReadAuth { version: 1 }` message once. Send it in the `X-Signature` header with every `GET` request. This signature has no timestamp or nonce. If it leaks, the risk is limited to read access to your own proposals. The signature does not grant write or cancellation access.

If you query a proposal that is not yours, you get `404` (not `403`). You cannot check if a proposal id exists.

### The response to POST is not acceptance

A `2xx` response means "accepted for validation". BYOS stores the proposal as `Submitted` and returns an id. Escrow checks and simulation run in a background loop ([`#proposal-api`](../design-document#proposal-api)). Do not treat a `2xx` as "my proposal is live".

### Poll for the verdict

After you submit, poll for the verdict with `GET /proposal/{id}`. You can see only your own proposals. Expect a verdict within approximately one block. The validator tick interval determines the latency, not the request round-trip. See [SLO targets](../operations/slo-targets).

Continue to poll after the first verdict. A live proposal is re-simulated every tick. It can fail at any time because chain state changed.

Run a loop: quote, sign, submit, poll, resubmit. This loop is the intended operating mode.

### Cancel a proposal

To cancel a proposal before it settles, send a signed `DELETE` request. Proposals are immutable. There is no update operation. To replace a proposal, cancel it and submit a new one.

## 7. Error handling

| What happened | Cost | Action |
|---|---|---|
| Rejected at gatekeeping | None | Read the typed rejection reason. Fix the route or the amounts. |
| Simulation reverted | None (one rate-limit slot used) | The proposal is dropped on the first revert. There are no retries. Resubmit if the route is still valid. |
| `429` rate limited | None | You are over your budget. Wait out `Retry-After`. Deposit more escrow for a larger budget. |
| `503` service unavailable | None | A BYOS dependency is down. Wait out `Retry-After` and retry; nothing was lost. |
| `403` insufficient escrow | None | Your cached balance is below the minimum collateral. Deposit more. |
| Expired | None | Your `validUntil` passed. Use a shorter interval. |
| Lost the auction | None | Your proposal stays live and competes in the next auction. |
| Settlement reverted on-chain | [Track A](../design-document#track-a) debit | BYOS debits your escrow immediately. You have a 72-hour dispute window. |
| BYOS won but did not settle | Smaller Track A debit | Same dispute window and grounds. |
| CoW raised an EBBO or fairness claim | [Track B](../design-document#track-b) passthrough | BYOS freezes your balance and sends you the certificate and evidence. |

### Rate limits: `429` and `503`

Your requests share one budget across `POST`, `GET` and `DELETE`, scaled by your escrow balance. A larger deposit buys more throughput. Size your polling against the budget, not against the tick interval: polling every live proposal on a short tick is what consumes it, and writes are cheap by comparison.

A `429` means you exceeded that budget, or the per-IP limit in front of it. A `503` means a store BYOS depends on is unreachable — infrastructure, not load. The two are deliberately separate so you can tell them apart in your own logs.

Both carry a `Retry-After` header, in seconds. Honour it. The reference clients do not, and that is a limitation of the examples rather than a pattern to copy: a client that retries at full rate through a `429` gets nothing back sooner and keeps its own counter pinned.

A `403` with `InsufficientEscrow` on submission means BYOS has a cached balance for your address that is below the minimum collateral. Deposit more; the gate clears within one refresh interval. An address BYOS has not seen before is not rejected — it is admitted at the lowest rate tier.

### Simulation failures

Simulation failures do not cost escrow. Only on-chain failures cause escrow debits. If a revert is caused by BYOS's own orchestration (not your route), BYOS pays.

### Track B operational readiness

Track B claims need operational readiness. Claims can arrive up to three months after the trade. Your refutation window is 36 hours. The CoW core team arbitrates (not BYOS). BYOS cannot fabricate a claim against you, but it also cannot waive one.

If you cannot respond to evidence requests within 36 hours, this is a risk you must plan for.

Every penalty action emits an on-chain Escrow event. You can use these events to audit your own history.

## 8. Reference implementations

Two baseline sub-solver examples exist. Both do the full loop: fetch orders, compute a Uniswap V2 route, sign an EIP-712 proposal, submit, poll, and resubmit.

| Language | Location | Notes |
|---|---|---|
| **Rust** | [`crates/subsolver`](https://github.com/bleu/byos-service/tree/main/crates/subsolver) in `byos-service` | Used in the Rust service's end-to-end test suite. |
| **TypeScript** | [`apps/subsolver`](https://github.com/bleu/byos-service-ts/tree/main/apps/subsolver) in `byos-service-ts` | Uses viem for EIP-712 signing. Uses multicall for reserve fetching. |

The protocol is language-neutral. Use either example for the sequence, the EIP-712 construction, and the polling behavior. The [OpenAPI document](https://github.com/bleu/byos-service/blob/main/crates/byos/openapi.yml) specifies all wire-level details.

## Pre-launch checklist

Before you go live, make sure that:

- [ ] You funded the Escrow above the minimum. A deposit also deploys your Trampoline.
- [ ] You verified your EIP-712 hashes against the contract's test vectors (not your own derivation).
- [ ] Your domain configuration points to the correct chain and contracts generation.
- [ ] Your `validUntil` value is within the ingestion cap.
- [ ] Your route leaves headroom above the user's limit for the gas cut and the driver's fee shift.
- [ ] You have a polling loop that resubmits (not fire-and-forget).
- [ ] You have an operational process to respond to a Track B claim within 36 hours.
