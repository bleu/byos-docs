# Trampoline isolation from GPv2Settlement funds

Status: proven (COW-1152)

## What this guarantees

A sub-solver authors an arbitrary route — a list of `(target, value, callData)`
interactions — that the Trampoline runs during a settlement. This document states, and
backs with tests, what such a route can and cannot reach.

The guarantee is structural rather than filtered. Routes execute as the Trampoline
instance (`msg.sender` is the instance), never as `GPv2Settlement`, so they inherit none
of the settlement's buffer-spend or approval-granting authority ([`#topology`](../design-document#topology)).
`execute` sweeps the instance's full remaining balance of both trade tokens to the
settlement ([`#residue`](../design-document#residue)), so the instance is empty of
trade tokens at rest, and each sub-solver has a distinct instance. The blast radius of
any route is the trade capital in flight during its own settlement.

The tests run against the **real deployed `GPv2Settlement`** on a mainnet fork, exercising
CoW's actual semantics (allowance checks, `onlySolver`, the reentrancy guard,
owner-scoped order state). A controlled ERC-20 buffer is seeded into the settlement in
`setUp`, so every "no value moved" assertion runs against non-zero value.

The invariant asserted is that value does not move — buffer balances, allowances, and
order state are unchanged after the route runs. A revert is one mechanism that enforces
this, but it is not the bar: several attacks are also proven inside a settlement that
**succeeds** (the failed attack swallowed so the transaction finalizes), because a real
adversary wants the settlement to complete unattributed rather than self-abort.

## Reachability

| Target | Reachable by a route | Why | Backing |
| --- | --- | --- | --- |
| Own instance balance, in flight | **yes** | The route runs as the instance, so during its own settlement it moves the instance's balance freely. This is the boundary's positive edge, and isolation is instance-scoped, not token-scoped: a route reaches the capital passing through its own instance while the settlement's buffer of the same token stays put. At rest there is nothing left to reach — the sweep empties the instance of trade tokens, so a planted approval drains nothing. | Cited: `test_execute_sweeps_full_route_output_and_emits_executed`, `test_execute_buy_order_sweeps_unconsumed_sell_token_to_settlement`, `test_planted_approval_cannot_reach_other_instances_residue` (`test/Trampoline/Trampoline.t.sol`) |
| Settlement token buffers | no | A `transferFrom` from the settlement needs an allowance the settlement never granted the instance. Proven inside a *successful* settlement where the failed attempt is swallowed, so the guarantee holds even when the transaction finalizes rather than aborting. | `test_settlement_succeeds_but_buffer_transferFrom_moves_nothing` |
| Settlement via re-entering `settle()` | no | `settle` is `nonReentrant onlySolver`. A route always runs inside a live `settle`, so the reentrancy guard (the first modifier) reverts before `onlySolver` is even reached. `onlySolver` is the backstop that applies if the guard weren't engaged — the instance is not an allow-listed solver. | `test_route_cannot_reenter_settle` (guard), `test_route_settle_call_is_rejected_by_onlySolver` (backstop) |
| Another party's order state | no | `setPreSignature` and `invalidateOrder` require the order's encoded owner to equal `msg.sender`. A route is the instance, so it cannot pre-sign or cancel an order owned by anyone else; the victim's state is unchanged. A route can pre-sign an order it *owns*, but nobody places orders naming a Trampoline, so that capability is inert. | `test_route_cannot_presign_another_owners_order`, `test_route_cannot_invalidate_another_owners_order` |
| Vault-relayer allowances (user funds) | no | The vault relayer pulls users' sell tokens and is `onlyCreator` — only the settlement may call it. A route calling it is rejected at the gate even against a user who really approved the relayer. | `test_route_cannot_pull_through_vault_relayer` |
| Other instances' balances | no | Cross-instance isolation is a property of per-instance EVM storage; an approval or call from one instance grants nothing over another's balance (instances end settlements swept empty, but a stray token could still land outside the flow). | Cited: `test_route_cannot_call_another_instances_execute`, `test_planted_approval_cannot_reach_other_instances_residue`, `test_signature_from_other_factory_generation_fails` (`test/Trampoline/Trampoline.t.sol`) |
| Escrow collateral | no | Collateral lives in the `Escrow` contract, which never routes funds through a Trampoline; payouts are gated to escrow's own access-controlled roles, unreachable from a route. | Cited: `test/Escrow/AccessControl.t.sol`, `test/Escrow/SubSolverActions.t.sol` |

Two directions are deliberately inert rather than blocked, because they move value
*toward* the settlement:

| Action | Effect | Backing |
| --- | --- | --- |
| Approving the settlement | Grants the settlement an allowance over the *instance's* funds, not the reverse; the instance holds nothing for it to reach. | `test_route_approving_settlement_is_inert` |
| Sending native value at the settlement | A one-way donation; the settlement ends richer, the instance poorer, nothing extracted. | `test_route_sending_value_at_settlement_is_inert` |

## Running the proofs

The suite (`test/fork/SettlementIsolation.t.sol`) is fork-gated. It uses a public RPC by
default, so it runs in CI without extra configuration; override with `MAINNET_RPC_URL`,
or set it empty to skip when offline.

```
MAINNET_RPC_URL=<url> forge test --match-path test/fork/SettlementIsolation.t.sol
```
