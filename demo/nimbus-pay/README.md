# nimbus-pay (demo project)

A small, fictional slice of the Nimbus Pay monorepo, used to demonstrate On-Call Copilot's desktop agent. It is not a working payments system.

- `deploy/helm/payments-api/values-prod.yaml` holds the production config that the incident history keeps coming back to (`REDIS_MAX_POOL`, `PAYMENTS_WORKER_CONCURRENCY`).
- `scripts/run_payments_api.py` simulates payments-api in production. It re-reads the values file every 2 seconds and writes `logs/payments-api.log`. With 24 workers and a pool of 20 it logs `redis.exceptions.ConnectionError: Too many connections`; fix the config and the errors stop.
- `scripts/deploy.py` simulates a release (`--set KEY=VALUE`) and restores the demo starting state (`--reset`).
