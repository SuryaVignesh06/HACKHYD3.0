"""Runtime settings for payments-api. Values come from the Helm chart env block."""

import os

PAYMENTS_WORKER_CONCURRENCY = int(os.environ.get("PAYMENTS_WORKER_CONCURRENCY", "8"))
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
# Each worker thread holds up to 3 connections at peak (idempotency check, rate limit, session cache).
REDIS_MAX_POOL = int(os.environ.get("REDIS_MAX_POOL", "20"))
REDIS_SOCKET_TIMEOUT_MS = int(os.environ.get("REDIS_SOCKET_TIMEOUT_MS", "250"))
IDEMPOTENCY_TTL_SECONDS = int(os.environ.get("IDEMPOTENCY_TTL_SECONDS", "86400"))
