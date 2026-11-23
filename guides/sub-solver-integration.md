# Sub-solver integration

This guide tells you how to go from zero to a settled proposal.

Use this guide with the [OpenAPI document](https://github.com/bleu/byos-service-ts/blob/main/apps/byos/openapi.yml) and the contracts for your deployment. The [design document](../design-document) gives background. Its automatic-sweep model differs from the current TypeScript service contract dependency: your route must transfer output to settlement.

You need an address, collateral in the Escrow, and an EIP-712 signer. You do not need a CoW solver seat. Ask the BYOS operator for access if the deployment restricts proposal submission or auction forwarding.

## Your role as a sub-solver

**You are responsible for:**

- **Collateral.** Fund the Escrow to at least the deployment minimum and cover the total exposure of your submitted proposals plus each new proposal.
- **Order selection.** Discover orders through the orderbook or auction forwarding. Build a route that executes from your Trampoline and delivers buy tokens to `GPv2Settlement`.
- **Amounts.** Set `minBuyAmount` to the settlement output your route guarantees. Use `quoteBuyAmount = minBuyAmount` unless you accept loose slippage on sell orders. Output below the floor reverts; output below the quote can create a buffer liability. For buy orders, both amounts must be equal.
- **Income.** BYOS does not forward CoW solver rewards. Collect your fee inside the route. Output sent to settlement above your commitment does not become your fee.
<!-- - **Responding to Track B claims** within the 36-hour challenge window. Claims can arrive months after a trade. -->

**You are NOT responsible for:**

- **Transaction submission.** BYOS builds and submits the settlement through the CoW driver. You never call `settle`.
- **Scoring.** BYOS scores proposals (`surplus - gas`), selects the best one per order, and bids it into CoW's auction.
- **Gas estimation or fee calculation.** BYOS sizes the gas cut. The driver applies protocol and partner fees. Your amounts are raw, pre-fee route amounts.
- **Trampoline contract logic.** The contract enforces the floor and isolates your route.
- **CoW protocol compliance.** BYOS manages the relationship with CoW DAO, the bonding pool, and the reward accounting. But gatekeeping is non-exculpatory. Your signed route is your responsibility.

## Staging deployments

Use [Staging deployments](../reference/deployments) for endpoints, contract addresses, and chain parameters.

## 1. Understand the risks

You compute routes. BYOS bids them into CoW's auction under its own bonded solver seat. BYOS submits the settlement and takes the consequences from the protocol.

When a settlement that carries your route fails on-chain, BYOS debits the cost from your escrow balance. **BYOS debits this amount without prior approval.** Read the terms in [`#penalties`](../design-document#penalties).

**The floor and the bid.** The contract reverts if settlement receives less than `minBuyAmount`. BYOS scores and prices the proposal with `min(simulationBuyAmount, quoteBuyAmount)`, then applies the gas cut. A higher quote cannot increase the bid above simulated output.

**Loose slippage (sell orders only).** Set `minBuyAmount < quoteBuyAmount` only if you accept the delivery gap. BYOS records `quoteBuyAmount − delivered`, converted to native token, in your buffer ledger. Over-delivery creates a credit that offsets future shortfalls but is never paid out. BYOS debits the full outstanding balance above `MIN_COLLATERAL / 5`. Monitor `GET /buffer-balance`; its current `threshold` field reports `MIN_COLLATERAL`, so divide it by five for the clearing threshold. Buy orders require equal min and quote amounts.

**Provider slippage.** Fynd and Binance use the provider's guaranteed minimum for both signed buy amounts. Their swap slippage settings do not create a min/quote gap. Their default provider tolerance is 50 bps, or 5 bps for configured correlated assets.

**Slippage limits.** BYOS enforces two per-proposal caps on the gap between `quoteBuyAmount` and `minBuyAmount`: `MAX_PROPOSAL_SLIPPAGE_BPS` (maximum gap as a fraction of `quoteBuyAmount`, in basis points) and `MAX_PROPOSAL_SLIPPAGE_NATIVE` (maximum gap in native token value). Proposals that exceed either limit are rejected at ingestion. See [Staging deployments](../reference/deployments) for the current values on each chain.

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

### Native tokens and order hooks

Use the auction's token addresses in your proposal. For a native buy, quote the wrapped native token at the provider and deliver it to settlement; keep the auction's `buyToken` in the signed proposal. BYOS restores the user's signed order for simulation, and the driver handles native payout. Do not add a second unwrap.

Do not add the order's own pre/post hooks to your route. BYOS includes them in simulation; the driver includes them at settlement. Orders with `flashloanHint` use BYOS's flash-loan router. Reject general Atomic Bundle orders with `wrappers`, and orders with non-ERC20 balance sources or destinations; BYOS rejects them as `UnsupportedOrder`.

### Headroom

Leave headroom above the user's limit price. BYOS takes a [gas cut](../design-document#gas) from the trade. The CoW driver applies protocol and partner fees on top. If a route quotes exactly at the limit, BYOS skips it because the solution is not feasible.

Sign **raw, pre-fee route amounts**. Do not pre-subtract fees. The driver creates the fee wedge after your amounts. The wedge stays in the settlement, not in your instance.

### Private market makers

Keep inventory in your own funds contract or EOA. Approve only your Trampoline to spend the buy token. Include these calls in your signed route:

1. `sellToken.transfer(yourFundsAddress, sellAmount)` to receive payment and fail if the input is missing.
2. `buyToken.transferFrom(yourFundsAddress, GPv2Settlement, minBuyAmount)` to deliver output.

Recover remaining tokens with `claimToken`. The signature commits to both calls.

## 6. Sign the proposal

Use `byosDomain` and `signProposal` from `packages/common`, or implement the [proposal schema](../design-document#proposal-schema). The domain uses your chain ID and TrampolineFactory address. Update both when the deployment changes. Verify hashes against the deployment contract's test vectors.

Sign all nine `ProposalData` fields: `orderUidHash`, `sellToken`, `buyToken`, `sellAmount`, `minBuyAmount`, `quoteBuyAmount`, `interactionsHash`, `validUntil`, and `nonce`. `interactionsHash` commits to the exact route. Use a new nonce for each new proposal, and keep `validUntil` within the deployment limit.

## 7. Submit and poll

Use the public BYOS endpoint (default port 9585). See [OpenAPI](https://github.com/bleu/byos-service-ts/blob/main/apps/byos/openapi.yml) for JSON fields and error responses.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/proposals` | Submit a signed proposal. `200 {"id": n}` means validation passed and the candidate is in memory. |
| `GET` | `/proposal/{id}` | Read your candidate, submitted proposal, or permanent log entry. |
| `GET` | `/proposals/{order_uid}` | List your in-flight proposals for an order. |
| `GET` | `/proposals/by-sub-solver` | List all your in-flight proposals. |
| `GET` | `/buffer-balance` | Read your buffer balance and entries. Divide the current `threshold` field by five for the clearing threshold. |
| `DELETE` | `/proposal/{id}` | Cancel your candidate. Returns `409 AlreadySubmitted` after submission to the driver. |
| `GET` | `/openapi.yaml` | Read the API schema. No authentication required. |

For proposal lists, use `?includeArchived=true` to query the permanent log instead.

### Read authentication

Sign `ReadAuth { version: 1 }` once with the proposal domain. Send it in `X-Signature` for authenticated reads. This signature grants read access only. A proposal owned by another address returns `404`.

For `DELETE`, sign `CancelProposal { proposalId }` with the same domain and send it in `X-Signature`. Use `signReadAuth` and `signCancellation` from `packages/common`.

### Poll for status

Poll `GET /proposal/{id}` after acceptance. You can see only your own proposals. See [SLO targets](../operations/slo-targets).

Treat price fields as nullable. `sellTokenRefPrice` can be present on candidates. The permanent log also retains `buyTokenRefPrice` for rejected and other outcomes before selection. Selection records `surplusTokenRefPrice`, `auctionGasPrice`, and `clearingPrices` for the submitted bid.

Unselected candidates enter the log as `SubsolverOutbid` or `AuctionClosed`. A submitted proposal with no observed driver outcome becomes `lost`: `SolverOutbid` means an on-chain trade was found; `UnknownOutput` means none was found. A late driver outcome can correct `lost`.

For `settleFailed`, read `rejectionReason`: `DriverCancelled` does not by itself authorize a debit; `SettlementReverted` follows Track A. `settlementTxHash` identifies the settlement and `penaltyTxHash` identifies an escrow debit. Late confirmed outcomes can correct a cancellation and preserve debit evidence.

Run a loop: quote, sign, submit, poll, resubmit. This loop is the intended operating mode.

To replace a route, cancel the earlier candidate and submit a new proposal with a new nonce. A new submission does not cancel an earlier candidate.

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
| Settlement started, then abandoned | 10% of frozen `c_l`, once | Debit requires matching driver start and abandonment evidence. You have a 72-hour dispute window. |
<!-- | CoW raised an EBBO or fairness claim | [Track B](../design-document#track-b) passthrough | BYOS freezes your balance and sends you the certificate and evidence. | -->

### Rate limits: `429` and `503`

`POST`, `GET`, and `DELETE` share an escrow-based budget. Reserve capacity for status reads; use `GET /proposals/by-sub-solver` to synchronize multiple proposals in one request.

On `429` or `503`, stop requests until `Retry-After` seconds have passed, then retry. `429` means the signer or IP budget is exhausted; `503` means a dependency is unavailable. The current Fynd and Binance clients defer later cycles on `429`, but can continue the current submission batch. They do not handle `503` retry headers. Your client must handle both.

On `403 InsufficientEscrow`, deposit more collateral and allow one balance refresh interval. Reads and cancellations remain available during withdrawal and at low balances. An unknown address enters at the lowest rate tier; validation still checks its collateral.

### Simulation failures

Simulation failures do not cost escrow. A loss, timeout, or cancellation alone does not authorize a non-settlement debit. BYOS requires matching `settlementStarted` and `cancelled`, `expired`, or `fail` notifications for the same auction and solution. BYOS pays for reverts caused by its own orchestration.

<!-- ### Track B operational readiness

Track B claims need operational readiness. Claims can arrive up to three months after the trade. Your refutation window is 36 hours. The CoW core team arbitrates (not BYOS). BYOS cannot fabricate a claim against you, but it also cannot waive one.

If you cannot respond to evidence requests within 36 hours, this is a risk you must plan for.

Every penalty action emits an on-chain Escrow event. You can use these events to audit your own history. -->

## 9. Reference implementations

Use the TypeScript examples in [`byos-service-ts`](https://github.com/bleu/byos-service-ts):

| Component | Use |
|---|---|
| [`apps/fynd-subsolver`](https://github.com/bleu/byos-service-ts/tree/main/apps/fynd-subsolver) | Fynd routing on BNB Chain |
| [`apps/binance-subsolver`](https://github.com/bleu/byos-service-ts/tree/main/apps/binance-subsolver) | Binance routing and both discovery methods |
| [`packages/subsolver-core`](https://github.com/bleu/byos-service-ts/tree/main/packages/subsolver-core) | Proposal signing, API client, discovery, and request budget |
| [`apps/baseline-subsolver`](https://github.com/bleu/byos-service-ts/tree/main/apps/baseline-subsolver) | Baseline client and end-to-end test example |
| [`apps/private-mm-subsolver`](https://github.com/bleu/byos-service-ts/tree/main/apps/private-mm-subsolver) | Inventory-based routes |

Fynd and Binance currently submit sell orders only. Use the [OpenAPI document](https://github.com/bleu/byos-service-ts/blob/main/apps/byos/openapi.yml) for request and response formats.

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
