# SLO targets

Latency targets for the BYOS service, and the reasoning behind each number. These are commitments the service implementations are built against, so they belong here rather than in either service repo.

## `POST /solve` p99 < 100ms

The hot path, called by the CoW driver during auctions.

The driver gives solvers a 15-second deadline, configurable via `solve_deadline` in the autopilot. BYOS does no simulation and no RPC on this path: an indexed read of the live proposal rows per auction order, one `solutions` insert per returned bid, and scoring and encoding in memory ([`#solver-engine`](../design-document#solver-engine)).

100ms is conservative against a 15s deadline. The point is not to be fast, it is to guarantee BYOS is never the bottleneck in the auction cycle.

## `GET /proposals/by-sub-solver` p99 < 50ms

Lists a sub-solver's live proposals, submitted and active. One indexed read scoped to the caller's own address ([`#proposal-api`](../design-document#proposal-api)). Even with hundreds of active proposals this is a single query.

## Proposal ingestion p99 < 1s

The asynchronous pipeline that runs *after* `POST /proposals` has already answered with a proposal id. This is time-to-verdict, not request latency — the request path itself does signature recovery and an expiry check and nothing else ([`#proposal-api`](../design-document#proposal-api)).

| Step | Estimated latency |
|---|---|
| EIP-712 signature recovery and validation | 10-20ms |
| Escrow balance check (cached, or RPC) | 50-100ms |
| Interactions hash verification | ~5ms |
| Simulation (`eth_estimateGas` over RPC) | ~500ms |
| Scoring and the row insert | ~10ms |
| **Total expected** | **600-650ms** |

Simulation dominates. The 1s target leaves roughly 50% headroom over the expected 650ms for slow RPC responses, retries, and GC pauses.

Note that the validator tick interval, not this budget, is what bounds how long a sub-solver waits for a verdict in practice: a proposal submitted just after a tick waits for the next one. The tick targets about one block.
