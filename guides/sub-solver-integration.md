# Sub-solver integration

This guide tells you how to go from zero to a settled proposal.

Use this guide with the [OpenAPI document](https://github.com/bleu/byos-service-ts/blob/main/apps/byos/openapi.yml) and the contracts for your deployment. The [design document](../design-document) gives background. Its automatic-sweep model differs from the current TypeScript service contract dependency: your route must transfer output to settlement.

You need an address, collateral in the Escrow, and an EIP-712 signer. You do not need a CoW solver seat. Ask the BYOS operator for access if the deployment restricts proposal submission or auction forwarding.

## Your role as a sub-solver

**You are responsible for:**

- **Collateral.** Fund the Escrow to at least the deployment minimum and cover the total exposure of your submitted proposals plus each new proposal.
- **Order selection.** Discover orders through the orderbook or auction forwarding. Build a route that executes from your Trampoline and delivers buy tokens to `GPv2Settlement`.
- **Floor and ceiling.** Set `minBuyAmount` and `quoteBuyAmount` in your proposal. The safest and recommended option is enforcing `minBuyAmount = quoteBuyAmount`. `quoteBuyAmount` is the clearing-price commitment — it determines your score and how much the user receives. `minBuyAmount` is the on-chain revert threshold. If the route delivers less than `minBuyAmount`, the settlement reverts (Track A debit). If `quoteBuyAmount` is too low, you lose auctions. For sell orders, you can set `minBuyAmount < quoteBuyAmount` to opt into loose slippage — but the gap between `quoteBuyAmount` and what the route actually delivers is charged against your escrow. For buy orders, `minBuyAmount` must equal `quoteBuyAmount`.
- **Income.** BYOS does not forward CoW solver rewards. Collect your fee inside the route. Output sent to settlement above your commitment does not become your fee.
<!-- - **Responding to Track B claims** within the 36-hour challenge window. Claims can arrive months after a trade. -->

**You are NOT responsible for:**

- **Transaction submission.** BYOS builds and submits the settlement through the CoW driver. You never call `settle`.
- **Scoring.** BYOS scores proposals (`surplus - gas`), selects the best one per order, and bids it into CoW's auction.
- **Gas estimation or fee calculation.** BYOS sizes the gas cut. The driver applies protocol and partner fees. Your amounts are raw, pre-fee route amounts.
- **Trampoline contract logic.** The contract enforces the floor and isolates your route.
- **CoW protocol compliance.** BYOS manages the relationship with CoW DAO, the bonding pool, and the reward accounting. But gatekeeping is non-exculpatory. Your signed route is your responsibility.

## Byos Availability

Currently, BYOS is only available in **staging competition** of **BNB chain**.

See [Active deployments](../reference/deployments) for addresses, endpoints, and chain-specific parameters.


## 1. Understand the risks

You compute routes. BYOS bids them into CoW's auction under its own bonded solver seat. BYOS submits the settlement and takes the consequences from the protocol.

When a settlement that carries your route fails on-chain, BYOS debits the cost from your escrow balance. **BYOS debits this amount without prior approval.** Read the terms in [`#penalties`](../design-document#penalties).

**`minBuyAmount` is the floor, `quoteBuyAmount` is the clearing-price commitment.** The contract enforces `minBuyAmount` as a minimum. If the route delivers less, the settlement reverts. `quoteBuyAmount` is the amount BYOS bids into the auction — it determines the user's price and your score. A [Track A](../design-document#track-a) debit is the penalty for a revert. A `quoteBuyAmount` that is too low loses auctions.

**Loose slippage (sell orders only).** When you set `minBuyAmount < quoteBuyAmount`, you accept a wider on-chain tolerance. The delta check uses `minBuyAmount`, but the clearing price uses `quoteBuyAmount`. If the route delivers between the two, the difference `quoteBuyAmount − delivered` is converted to native token and recorded as a buffer entry you owe. If the route over-delivers above `quoteBuyAmount`, the difference is recorded as a credit that offsets future shortfalls but is never paid out. Entries accumulate in a ledger — credits offset debits — and BYOS debits your escrow only when the outstanding balance exceeds `c_l`. Monitor your running balance with `GET /buffer-balance` ([API endpoints](#api-endpoints)). For buy orders, `minBuyAmount` must equal `quoteBuyAmount`.

**Slippage limits.** BYOS enforces two per-proposal caps on the gap between `quoteBuyAmount` and `minBuyAmount`: `MAX_PROPOSAL_SLIPPAGE_BPS` (maximum gap as a fraction of `quoteBuyAmount`, in basis points) and `MAX_PROPOSAL_SLIPPAGE_NATIVE` (maximum gap in native token value). Proposals that exceed either limit are rejected at ingestion. See [Active deployments](../reference/deployments) for the current values on each chain.

## 2. Deposit collateral

Deposit native token into the [Escrow](../design-document#escrow) for your address. Any address can fund a sub-solver address. Only the sub-solver address can withdraw.

The deposit deploys your Trampoline at a deterministic address. Resolve it with `TrampolineFactory.addressOf(yourAddress)`. More collateral also increases your API rate limit.

Keep enough effective balance for both collateral checks:

1. Hold at least `MIN_COLLATERAL`, the deployment's fixed minimum.
2. Cover the current proposal plus all your submitted proposals: `sum(c_l + simulatedGas × gasPrice) <= effectiveBalance − max(outstandingBufferBalance, 0)`.

For each proposal, `c_l = min(sellValueNative × COLLATERAL_RATIO_BPS / 10_000, MIN_COLLATERAL)`, rounded down. Positive buffer liabilities reduce available collateral; negative credits cannot cover gas or penalties. Other in-memory candidates are excluded. On `ExposureCapExceeded`, add collateral or wait for submitted proposals to complete. See [collateral gates](../design-document#collateral-gates-and-deployment-penalty-cap).

### Withdrawal

Withdrawal is not instant. It is all-or-nothing with a cooldown period. When you request a withdrawal, your effective balance drops to zero immediately. You cannot submit proposals during the cooldown. See [`#withdrawal-and-freeze`](../design-document#withdrawal-and-freeze).

### Key rotation

To rotate keys, use the ERC20 `transfer` function to move your escrow balance to the new address. Do not withdraw and redeposit. A transfer prevents the gap where you have no collateral.

The new address gets its own Trampoline instance. Your old proposals do not follow you. Your address serves three roles: proposal signer, escrow key, and CREATE2 salt ([`#proposal-schema`](../design-document#proposal-schema)).

## 3. Find orders to route

Use one of these discovery methods:

- **Orderbook calls:** poll `GET /api/v1/auction` on the chain's CoW orderbook. Access is easier in staging; production access can require permission from the CoW team.
- **Auction forwarding:** expose `POST /solve`. Ask the BYOS operator to whitelist your endpoint in `SUBSOLVERS_ENDPOINTS` and agree on `SUBSOLVER_BEARER`. Verify `Authorization: Bearer <token>`. This method is more common in production. Submit signed proposals to BYOS with `POST /proposals`; the `/solve` response is only an acknowledgement.

One proposal covers one order ([`#single-order-solutions`](../design-document#single-order-solutions)). There is no batch format. Both fill-or-kill and partially fillable orders are supported. For partially fillable orders, your proposal's `sellAmount` can be any amount up to the order's remaining fillable amount, and both `minBuyAmount` and `quoteBuyAmount` must independently satisfy the proportionally scaled limit price.

## 4. Auction timing

Order discovery does not open the BYOS auction. Submit only for orders in BYOS's active auction. For forwarded auctions, finish quoting and submission before `deadline` minus the operator's `SELECTOR_BUFFER_MS` (default 200 ms). Allow time for BYOS to simulate the proposal during submission.

A candidate is valid for one auction window only. Unselected candidates stop competing when the window closes; selected candidates become durable `submitted` proposals and remain available for driver outcomes. New `POST /proposals` requests after the window closes receive `400 NoActiveAuction` until the next auction arrives.

If an order was not filled in the current auction, submit a new proposal when the next auction opens.

## 5. Build a route

A route is a list of raw calls. Each call has a target, a value, and calldata. You can use any DEX or protocol. BYOS does not maintain a venue registry. The calls execute as-is inside your Trampoline instance.

### Sandbox constraints

BYOS transfers the signed `sellAmount` to your Trampoline before execution. Your calls execute as the Trampoline. Include the token approvals that your route needs, then deliver at least `minBuyAmount` to `GPv2Settlement`. Set the swap receiver to settlement or add an explicit transfer. The contract checks the settlement balance increase; it does not sweep trade tokens.

Your instance cannot use settlement funds or other instances. Remaining tokens stay in your instance. Recover them with `claimToken`, and manage any approvals that can spend them.

### Headroom

Leave headroom above the user's limit price. BYOS takes a [gas cut](../design-document#gas) from the trade. The CoW driver applies protocol and partner fees on top. If a route quotes exactly at the limit, BYOS skips it because the solution is not feasible.

Sign **raw, pre-fee route amounts**. Do not pre-subtract fees. The driver creates the fee wedge after your amounts. The wedge stays in the settlement, not in your instance.

### Private market makers

Keep inventory in your own funds contract or EOA. Approve only your Trampoline to spend the buy token. Include these calls in your signed route:

1. `sellToken.transfer(yourFundsAddress, sellAmount)` to receive payment and fail if the input is missing.
2. `buyToken.transferFrom(yourFundsAddress, GPv2Settlement, minBuyAmount)` to deliver output.

Recover remaining tokens with `claimToken`. The signature commits to both calls.

## 6. Sign the proposal

Sign the EIP-712 typed data described in [`#proposal-schema`](../design-document#proposal-schema). The `ProposalData` struct has nine fields: `orderUidHash`, `sellToken`, `buyToken`, `sellAmount`, `minBuyAmount`, `quoteBuyAmount`, `interactionsHash`, `validUntil`, `nonce`. Get the struct, domain, and typehash from [`bleu/byos-contracts`](https://github.com/bleu/byos-contracts). Test your signatures against the contract's own test vectors. Do not derive the typehash yourself.

The API verifies your signature at submission. The Trampoline verifies the same signature on-chain at settlement. If the two do not match, the settlement fails.

### Domain binding

The EIP-712 domain binds to the TrampolineFactory address. The domain is specific to a chain **and** a deployment generation. A contracts v2 deployment invalidates all outstanding signatures. Update your domain configuration when contracts change.

### Route commitment

The `interactionsHash` field in the signed struct commits to your route. BYOS cannot substitute different interactions. A third party can verify that the signed data matches the settlement calldata. This property makes Track A debits verifiable.

### Expiry

Keep `validUntil` short. BYOS caps it at ingestion ([`#proposal-lifecycle`](../design-document#proposal-lifecycle)). A route that is more than a few minutes old is stale.

## 7. Submit and poll

Send a `POST` request with the proposal. See the [OpenAPI document](https://github.com/bleu/byos-service-ts/blob/main/apps/byos/openapi.yml) for the payload format, status codes, and rejection reasons.

### API endpoints

All endpoints are on the public listener (default port 9585):

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/proposals` | Proposal signature (in body) | Submit a proposal. Returns `200 {"id": n}` for a candidate; errors include `400 ProposalRejected`, `400 NoActiveAuction`, and `400 UnknownOrder`. See the response rules below. |
| `GET` | `/proposal/{id}` | `X-Signature` (EIP-712 `ReadAuth`) | Get your proposal status, rejection reason, and settlement/penalty tx hashes. Automatically falls back to the permanent log if the proposal has been swept from the active store — so this works regardless of how old the proposal is. |
| `GET` | `/proposals/{order_uid}` | `X-Signature` | List your proposals on one order. Returns only in-flight proposals by default. Pass `?includeArchived=true` to fetch from the permanent log instead, which includes all statuses and swept proposals. |
| `GET` | `/proposals/by-sub-solver` | `X-Signature` | List all your proposals. Returns only in-flight proposals by default. Pass `?includeArchived=true` to fetch from the permanent log instead. |
| `GET` | `/openapi.yaml` | None | Machine-readable OpenAPI 3 spec for the full API. Use this to generate a client or validate your integration. |
| `GET` | `/buffer-balance` | `X-Signature` (EIP-712 `ReadAuth`) | Your outstanding buffer balance, the clearing threshold, and individual per-proposal entries. |
| `DELETE` | `/proposal/{id}` | `X-Signature` (EIP-712 `CancelProposal`) | Cancel a proposal. Works only on `Candidate` proposals (in-memory, not yet submitted). Returns `409 AlreadySubmitted` if the proposal has already been sent to the driver. |

### Read authentication

Sign an EIP-712 `ReadAuth { version: 1 }` message once. Send it in the `X-Signature` header with every `GET` request. This signature has no timestamp or nonce. If it leaks, the risk is limited to read access to your own proposals. The signature does not grant write or cancellation access.

If you query a proposal that is not yours, you get `404` (not `403`). You cannot check if a proposal id exists.

### The response to POST is acceptance

A `200 {"id": n}` response means the proposal passed validation and is a candidate in memory. For `400 ProposalRejected`, read the reason in `description`. For `400 NoActiveAuction`, wait for the next auction and resubmit. If the auction closes after ID allocation, BYOS keeps a rejected `AuctionClosed` log entry. Repeated signed requests can receive new IDs.

### Poll for status

Poll `GET /proposal/{id}` after acceptance. You can see only your own proposals. See [SLO targets](../operations/slo-targets).

Once the proposal has been selected in an auction, the response includes four price snapshot fields: `sellTokenRefPrice`, `surplusTokenRefPrice`, `auctionGasPrice`, and `clearingPrices`. These are the auction-time prices used to score and settle the proposal. They are absent until the first auction selection and never change afterwards.

A proposal that was not selected at `/solve` time (because another sub-solver won the order, or the auction closed) is written directly to the log with reason `SubsolverOutbid` or `AuctionClosed`. You will see this on `GET /proposal/{id}`.

A submitted proposal may be marked `lost` by the outcome worker if no driver outcome is observed within the window. This is provisional: a late driver `Success` or `Revert` notification corrects it. The `lost` state carries a sub-reason: `SolverOutbid` (an on-chain Trade event was found for the order — an external solver settled it) or `UnknownOutput` (no Trade event found; the solution was dropped or abandoned).

A `settleFailed` outcome includes a reason:

| Reason | Meaning |
|---|---|
| `DriverCancelled` | The driver cancelled submission; this alone does not authorize a penalty. |
| `SettlementReverted` | The settlement reverted on-chain; the existing Track A policy applies. |

`settlementTxHash` identifies the settlement transaction. `penaltyTxHash` identifies an escrow debit. Late confirmed outcomes can correct a cancellation while preserving existing debit evidence.

Run a loop: quote, sign, submit, poll, resubmit. This loop is the intended operating mode.

### Cancel a proposal

Send a signed `DELETE` request to cancel a candidate. Once BYOS sends it to the driver, cancellation returns `409 AlreadySubmitted`. To offer a new route, submit a new proposal with a new nonce. The earlier candidate remains until you cancel it or selection ends.

## 8. Error handling

| What happened | Cost | Action |
|---|---|---|
| Rejected at gatekeeping | None | Read the typed rejection reason. Fix the route or the amounts. |
| `400 NoActiveAuction` | None | No `/solve` has arrived yet. BYOS just started or is between auctions. Wait for the next auction and resubmit. |
| `400 UnknownOrder` | None | The order UID is not in the current auction. The order may not have reached BYOS yet. Wait for the next auction. |
| Simulation reverted | None (one rate-limit slot used) | The proposal is dropped on the first revert. There are no retries. Resubmit if the route is still valid. |
| `429` rate limited | None | You are over your budget. Wait out `Retry-After`. Deposit more escrow for a larger budget. |
| `503` service unavailable | None | A BYOS dependency is down. Wait out `Retry-After` and retry; nothing was lost. |
| `403` insufficient escrow | None | Your cached balance is below the minimum collateral. Deposit more. Submission only — reads and cancellations keep working. |
| Expired | None | Your `validUntil` passed. Use a shorter interval. |
| `SubsolverOutbid` | None | BYOS selected a different sub-solver for this order at `/solve` time. Resubmit with a better route for the next auction. |
| `AuctionClosed` | None | The auction ended without selecting this candidate. Resubmit for the next auction. |
| `SolverOutbid` | None | The submitted proposal was lost to an external solver (on-chain Trade event found). Resubmit or move to the next order. |
| `Lost/UnknownOutput` | None (provisional) | The outcome worker found no driver outcome within the window and no on-chain trade. May be corrected by a late driver notification. |
| Settlement reverted on-chain | [Track A](../design-document#track-a) debit | BYOS debits your escrow immediately. You have a 72-hour dispute window. |
| BYOS won but did not settle | Smaller Track A debit | Same dispute window and grounds. |
<!-- | CoW raised an EBBO or fairness claim | [Track B](../design-document#track-b) passthrough | BYOS freezes your balance and sends you the certificate and evidence. | -->

### Rate limits: `429` and `503`

Your requests share one budget across `POST`, `GET` and `DELETE`, scaled by your escrow balance. A larger deposit buys more throughput. Size your polling against the budget: polling every live proposal on a short interval is what consumes it, and writes are cheap by comparison.

A `429` means you exceeded that budget, or the per-IP limit in front of it. A `503` means a store BYOS depends on is unreachable — infrastructure, not load. The two are deliberately separate so you can tell them apart in your own logs.

Both carry a `Retry-After` header, in seconds. Honour it. The reference clients do not, and that is a limitation of the examples rather than a pattern to copy: a client that retries at full rate through a `429` gets nothing back sooner and keeps its own counter pinned.

A `403` with `InsufficientEscrow` on submission means BYOS has a cached balance for your address that is below the minimum collateral. Deposit more; the gate clears within one refresh interval. An address BYOS has not seen before is not rejected — it is admitted at the lowest rate tier.

The gate is on submission alone. Reading and cancelling keep working at any balance, deliberately: requesting a withdrawal drops your effective balance to zero, and you still need to cancel and watch whatever you have live while it winds down.

### Simulation failures

Simulation failures do not cost escrow. Only on-chain failures cause escrow debits. If a revert is caused by BYOS's own orchestration (not your route), BYOS pays.

<!-- ### Track B operational readiness

Track B claims need operational readiness. Claims can arrive up to three months after the trade. Your refutation window is 36 hours. The CoW core team arbitrates (not BYOS). BYOS cannot fabricate a claim against you, but it also cannot waive one.

If you cannot respond to evidence requests within 36 hours, this is a risk you must plan for.

Every penalty action emits an on-chain Escrow event. You can use these events to audit your own history. -->

## 9. Reference implementations

| Language | Location |
|---|---|
| **Rust** | [`crates/subsolver`](https://github.com/bleu/byos-service/tree/main/crates/subsolver) in `byos-service` |
| **TypeScript** | [`apps/subsolver`](https://github.com/bleu/byos-service-ts/tree/main/apps/subsolver) in `byos-service-ts` |
| **TypeScript** | [`apps/fynd-subsolver`](https://github.com/bleu/byos-service-ts/tree/main/apps/fynd-subsolver) in `byos-service-ts` |
| **TypeScript** | [`apps/private-mm-subsolver`](https://github.com/bleu/byos-service-ts/tree/main/apps/private-mm-subsolver) in `byos-service-ts` |

The protocol is language-neutral. Use either example for the sequence, the EIP-712 construction, and the polling behavior. The [OpenAPI document](https://github.com/bleu/byos-service-ts/blob/main/apps/byos/openapi.yml) specifies all wire-level details.

## Pre-launch checklist

Before you go live, make sure that:

- [ ] You funded the Escrow above the minimum. A deposit also deploys your Trampoline.
- [ ] You verified your EIP-712 hashes against the contract's test vectors (not your own derivation). The struct has nine fields.
- [ ] Your domain configuration points to the correct chain and contracts generation.
- [ ] Your `validUntil` value is within the ingestion cap.
- [ ] Your route leaves headroom above the user's limit for the gas cut and the driver's fee shift.
- [ ] For buy orders, `minBuyAmount == quoteBuyAmount == order.buyAmount`.
- [ ] For sell orders using loose slippage, you understand the escrow charge for the gap between `quoteBuyAmount` and the actual delivery. Monitor with `GET /buffer-balance`.
- [ ] If you are a private MM, your inventory is held in your own contract with an approval to your Trampoline — not deposited directly in the Trampoline instance.
- [ ] For partially fillable orders, your `sellAmount` does not exceed the remaining fillable amount, and both buy amounts satisfy the scaled limit price.
- [ ] You have a polling loop that resubmits (not fire-and-forget).
<!-- - [ ] You have an operational process to respond to a Track B claim within 36 hours. -->
