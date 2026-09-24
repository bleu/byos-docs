# Operational Runbook

This runbook describes the tools and signals available to operate a BYOS instance. It covers the admin dashboard, logs, Slack notifications, uptime monitoring, and a monitoring checklist.

## Admin dashboard

The admin dashboard is a web interface that reads data from the BYOS PostgreSQL database. It runs on port 53001 (prod-local). It has four pages.

### Overview

The Overview page shows the proposal funnel for a selected time range (24 hours, 7 days, or 30 days):

- Proposals received
- Proposals sent to auction
- Proposals won
- Proposals settled
- Proposals discarded
- Rejection breakdown by reason
- Penalty counts and total penalized amount

Use the Overview page to get a high-level picture of service health and activity.

### Subsolvers

The Subsolvers page shows one row per connected sub-solver with:

- Proposal counts (received, settled, reverted, rejected, penalized)
- Win rate (settled / (settled + reverted))
- Total penalties: count and amount
- Buffer balance
- On-chain escrow balance

Use the Subsolvers page to identify a sub-solver with an abnormal revert rate or growing penalty count.

### Proposals

The Proposals page shows a paginated list of proposals. You can filter by sub-solver address and by status.

Possible statuses: `submitted`, `active`, `rejected`, `simFailed`, `executing`, `settled`, `settleFailed`, `penalized`, `cancelled`, `expired`.

Each row links to the proposal detail page. The detail page shows:

- Full proposal fields (tokens, amounts, sub-solver, order UID)
- Settlement transaction with a link to the block explorer
- Penalty transaction (if applicable)
- Tenderly replay link for reverted or simulation-failed proposals
- Audit trail: a chronological list of all events with timestamps and raw payload data

Use the Proposals page to find and inspect a specific proposal. Use the Tenderly link on the detail page to debug a reverted settlement.

### System

The System page shows operational metrics at the time of page load:

- Pending penalties count: penalty transactions that have not yet been submitted on-chain

Use the System page to detect whether the penalty worker is falling behind. A growing pending penalties count indicates a problem — see the [monitoring checklist](#monitoring-checklist).

## Logging

The service uses structured logging via pino.

### Log level

Set `LOG_LEVEL` to control verbosity. Accepted values: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. Default: `info`.

Set `JSON_LOGS=true` to emit JSON-formatted logs. This is recommended when shipping logs to a cloud aggregator.

A change to either variable requires a service restart:

```bash
docker compose -f docker-compose.prod-local.yml restart byos
```

### Key log lines

Use these log lines to debug specific workers.

**Validation worker**

| Message | Level | What it means |
|---------|-------|---------------|
| `"validation tick"` | info | Normal tick. Fields: `total`, `enqueued`, `expired`. |
| `"proposal rejected"` | info | Proposal failed escrow check or simulation. Field: `reason`. |
| `"proposal sim failed"` | warn | Simulation returned an unexpected error. |
| `"failed to snapshot live proposals"` | error | The validation worker could not read from the database. |

**Penalty worker**

| Message | Level | What it means |
|---------|-------|---------------|
| `"revert debit landed"` | info | Penalty transaction confirmed on-chain. Fields: `id`, `subSolver`, `amount`, `tx`. |
| `"settlement cost lookup failed"` | warn | Could not calculate the cost of a settlement. The worker will retry. |
| `"keeps failing; giving up"` | error | A penalty operation exhausted all retries. The debit was not submitted. |

**Balance refresh worker**

| Message | Level | What it means |
|---------|-------|---------------|
| `"balance refresh set is over half its cap"` | warn | The number of tracked sub-solvers is large. RPC call volume may be high. Fields: `active`, `cap`, `requests`. |
| `"balance refresh batch failed"` | warn | A multicall batch to fetch escrow balances failed. |

**Retention worker**

| Message | Level | What it means |
|---------|-------|---------------|
| `"retention sweep dropped proposals"` | info | Normal cleanup. Field: `deleted`. |
| `"retention sweep failed"` | error | The retention worker could not delete expired proposals. |

**Audit worker**

| Message | Level | What it means |
|---------|-------|---------------|
| `"failed to enqueue slack notification"` | warn | An audit event was saved but the Slack job could not be enqueued. |

## Slack notifications

Configure `SLACK_TOKEN` and `SLACK_CHANNEL` to receive notifications. Both variables must be set together. If one is missing, no notifications are sent.

Failed notification jobs retry up to 5 times with exponential backoff. If a notification does not arrive, check the logs for `"failed to enqueue slack notification"`.

### Events

| Event | Trigger | Message content |
|-------|---------|-----------------|
| Service started | Process startup | Chain ID |
| New sub-solver connected | First proposal from a sub-solver address | Sub-solver address |
| Proposal settled | Settlement transaction confirmed | Sub-solver, order UID, transaction hash |
| Settlement reverted | Settlement transaction reverted on-chain | Sub-solver, order UID, transaction hash, Tenderly link |
| Sub-solver penalized | Escrow debited for a revert | Sub-solver, order UID, amount, penalty transaction hash |
| Sub-solver non-settlement debited | Escrow debited for abandoning a won auction | Sub-solver, order UID, amount, penalty transaction hash |
| BYOS buffer debited | Internal buffer cleared | Sub-solver, amount, entries cleared, transaction hash |

### Redis persistence and the "new sub-solver" notification

The service tracks known sub-solver addresses in a Redis set. When a sub-solver sends its first proposal, the set does not contain its address, so a "new sub-solver connected" notification fires.

`docker-compose.prod-local.yml` enables AOF persistence (`--appendonly yes`) by default. If you are running Redis outside that compose file, ensure `--appendonly yes` is set — without it, every Redis restart will re-fire the "new sub-solver connected" notification for every known sub-solver.

## Uptime monitoring

Use an external uptime tool (for example, BetterStack) to poll the health endpoint:

```
GET http://<host>:59585/healthz
```

A `200 OK` response confirms the HTTP server is running.

> **Note.** The `/healthz` endpoint is a liveness probe only. It does not check database connectivity, Redis, or chain connectivity. Use Slack alerts and logs as health signals for those dependencies.

## Monitoring checklist

Check these items regularly to detect operational issues before they affect sub-solvers.

| What to check | Where to look | Normal state | Action if abnormal |
|---------------|--------------|--------------|-------------------|
| Pending penalties count | Admin dashboard → System page | Near zero | Check operator wallet balance; check logs for `"settlement cost lookup failed"` or `"keeps failing; giving up"` |
| Operator wallet balance | Block explorer for the `ESCROW_OPERATOR` address | Sufficient to cover gas for several penalty transactions | Send native tokens to the operator address |
| Slack alerts active | Slack channel | Periodic `settled` and `settleFailed` alerts during auction activity | Silence here means the service is not winning auctions or not receiving `/notify` callbacks from the driver |
| Error-level log lines | Service logs | None | Investigate the specific worker named in the log |
