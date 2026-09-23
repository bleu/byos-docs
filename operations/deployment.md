# Deployment

This page describes the deployment order for a new BYOS instance.

## Order

Deploy the contracts first. The contracts deployment produces two addresses — Escrow and TrampolineFactory — that the service requires to start.

1. **Deploy contracts** → [`byos-contracts` deployment guide](https://github.com/bleu/byos-contracts/blob/main/docs/deploy.md)
2. **Deploy service** → [`byos-service-ts` deployment guide](https://github.com/bleu/byos-service-ts/blob/main/docs/deploy.md)

## What each step produces

| Step | Output | Used by |
|------|--------|---------|
| Contracts deployment | `ESCROW_ADDRESS`, `TRAMPOLINE_FACTORY` | Service configuration |
| Service deployment | Public API on port 9585, internal API on port 9586 | Sub-solvers, CoW driver |
