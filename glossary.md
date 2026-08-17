# Glossary

The stable domain language for BYOS. Every term below is defined here and nowhere else — implementation repos use this vocabulary in issues, ADRs, tests, metric names, and code, and their own `CONTEXT.md` files define only what is local to them.

If a concept you need is not here, that is a signal. Either you are inventing language the project does not use, or there is a real gap worth flagging.

Source RFP: [Bring Your Own Solver (BYOS)](https://forum.cow.fi/t/rfp-bring-your-own-solver-byos/3469) · [accepted grant application](https://forum.cow.fi/t/grant-application-cow-byos-bring-your-own-solver/3476). CoW protocol background: [fee collection](reference/cow-fee-collection), [slashing policy](reference/cow-solver-slashing-policy), [auctions](reference/solver-auctions), [CIPs](reference/solver-cips).

## What BYOS is

A **bonded CoW solver** whose proposed solutions are sourced from a permissionless set of **external sub-solvers**. Sub-solvers submit signed routing proposals against specific order UIDs, collateralized by an escrow balance held by BYOS. BYOS retains exclusive control over on-chain settlement submission. From the protocol's perspective BYOS is a single, ordinary bonded solver — the sub-solver relationship is entirely internal to BYOS.

v1 targets **Ethereum mainnet + Gnosis**. Out of scope: a BYOS-operated orderbook, reward pass-through to sub-solvers, cross-chain escrow accounting, and BYOS's own bonding capital.

## Two risk classes

The core economic framing. Everything about escrow, penalties, and gatekeeping follows from this split.

| | Track A — gas + revert penalty | Track B — EBBO / fairness slash |
|---|---|---|
| Determined by | On-chain fact (tx reverted) | Off-chain CIP-52 certificate + DAO |
| Timing | Seconds to about one accounting week | Days, up to 3 months |
| Attributable cleanly? | Yes (tx to proposal) | Murky; BYOS *chose* to settle it |
| Recoverable from escrow? | Yes | Only if funds are still present; otherwise BYOS eats it |
| Primary defense | Escrow debit | BYOS pre-settlement **gatekeeping** |

## Terms

- **Sub-solver** — an external, permissionless party that computes a route for a specific order and submits a signed proposal to BYOS. Never holds submission keys; never calls `settle`. Identified by its address, recovered from its EIP-712 signature; that same address is its escrow key and its Trampoline CREATE2 salt. It is `sub_solver`, never plain `solver` — in CoW's vocabulary `solver` means BYOS itself.

- **Proposal** — an EIP-712-signed message authorizing BYOS to attempt a settlement of a specific route, and consenting to the associated escrow risk. Immutable: amounts (`sellAmount`, `minBuyAmount`, `quotedBuyAmount`), interactions, expiry, nonce, and signature form one signed unit, so there is no update operation. One proposal commits to exactly one order. Field-level definition is in [the design document](design-document#proposal-schema); the wire shape is in `byos-service`'s [`crates/byos/openapi.yml`](https://github.com/bleu/byos-service/blob/main/crates/byos/openapi.yml).

- **Trampoline** — the contract that receives a route's `sellAmount`, executes the sub-solver's interactions as itself, sweeps both trade tokens back to `GPv2Settlement`, and enforces `minBuyAmount` as a floor. Confines sub-solver code to a fund-less context so it cannot reach settlement buffers or plant an exploitable approval. One immutable instance per sub-solver, at a deterministic CREATE2 address, deployed at escrow-deposit time. See [the design document](design-document#trampoline).

- **Escrow** — a per-chain, native-token ERC20 contract holding sub-solver collateral keyed by sub-solver address. Tokens are minted 1:1 with deposited ETH and burned on withdrawal or debit; `balanceOf` is the single source of truth. The collateral at risk is the *only* sub-solver capital BYOS ever touches — trade capital flows atomically through `GPv2Settlement` into the Trampoline and back. See [the design document](design-document#escrow).

- **Owner** — the secure wallet (multisig or Safe) that owns the Escrow. Receives debited funds, sets the operator, grants and revokes submitters, configures the cooldown. Ownership transfer is two-step.

- **Operator** — an EOA held by the BYOS service for automated operations: debit, freeze, unfreeze, pause, unpause. Cannot withdraw funds or change configuration. A compromised operator can grief but not steal.

- **Submitter** — an EOA the BYOS service submits settlements from. Holds the Escrow's `SUBMITTER_ROLE`; `Trampoline.execute` requires `tx.origin` to be one. Covers both the allow-listed solver EOA and the auxiliary accounts of CoW's `Solver7702Delegate` parallel path, since there the auxiliary account is `tx.origin`. Rotation is a role change by the Owner, not a redeploy.

- **Cooldown** — the waiting period between requesting and executing an escrow withdrawal. Withdrawal is all-or-nothing: requesting drops effective balance to zero immediately, so a sub-solver is offline for new proposals for the duration.

- **Pause** — an operator-triggered global emergency brake blocking all ERC20 transfers and withdrawal executions. Deposits, debits, withdrawal requests and cancellations, and debit sweeps stay operational. The first response to detected malicious transfer activity; should be short-lived, minutes rather than hours.

- **Freeze** — the operator blocking withdrawal execution and ERC20 transfers, in both directions, for one sub-solver address while a Track B investigation is open. Does not affect effective balance. Deposits to a frozen address are allowed.

- **Debit (Track A)** — routine, provable recovery of `gas + c_l` from escrow when a winning settlement carrying a proposal reverts on-chain, misses its deadline, or is abandoned after winning. See [the design document](design-document#track-a).

- **Slash / clawback (Track B)** — rare passthrough of a CoW EBBO or fairness penalty (CIP-52) to the responsible sub-solver's escrow, mirroring the process CoW runs against BYOS. The service tracks a 5× off-chain reserve against pending claims. See [the design document](design-document#track-b).

- **Attribution** — mapping a settlement transaction back to the sub-solver whose proposal it contained. Enforced by settling one sub-solver per settlement transaction; the per-sub-solver Trampoline CREATE2 address in the calldata self-evidences which sub-solver's route ran.

- **Gatekeeping** — BYOS's *preventive* control: validating each proposal (simulation, hook presence, EBBO baseline price) before settling. Distinct from escrow, which is *recovery*. Best-effort and non-exculpatory — passing gatekeeping does not absolve a sub-solver.

- **Floor and ceiling** (`minBuyAmount` / `quotedBuyAmount`) — the two signed buy-amount fields in a proposal. `minBuyAmount` is the floor: the hard revert threshold the Trampoline's delta check enforces on-chain. `quotedBuyAmount` is the ceiling: the clearing-price commitment used for scoring, gas-cut sizing, and settlement encoding. When both are equal, the proposal behaves as a fixed-amount commitment. When `minBuyAmount` is lower (sell orders only), the sub-solver opts into loose slippage — the gap between `quotedBuyAmount` and the actual delivery is charged against the sub-solver's escrow. Buy orders hard-reject `minBuyAmount != quotedBuyAmount`. See [the design document](design-document#order-flow).

- **Gas cut** — what BYOS keeps back to cover submitting a settlement: exactly the estimated gas cost, in the order's sell token, on every solution it bids. Kept rather than reimbursed. Always on, no rate to configure. Say "gas cut", not "fee": the order's signed `feeAmount` is a different field and is zero on every live order, CoW's **protocol fee** and **network fee** are applied by the driver rather than by BYOS, and the percentage-of-`sellAmount` "BYOS fee" of early drafts never shipped. See [the design document](design-document#gas).

- **`c_l`** — CoW's per-auction lower reward cap, which is the maximum revert penalty: 0.010 ETH on mainnet, 10 xDAI on Gnosis. A BYOS debit per reverted auction is bounded by `gas + c_l`. See [`reference/cow-solver-slashing-policy`](reference/cow-solver-slashing-policy).

- **Residue** — a retired category for trade-token leftovers. Until 2026-07-22, route output above the signed floor and unconsumed sell tokens stranded in the Trampoline instance and were reclaimable by the sub-solver. `execute` now sweeps both trade tokens to `GPv2Settlement`, so that value is BYOS-owned settlement slippage. The Trampoline still has `claimToken`/`claimTokens` for non-trade-token strays (intermediate-token dust, mistaken transfers, airdrops). See [the design document](design-document#residue).
