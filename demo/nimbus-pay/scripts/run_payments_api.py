"""Simulates payments-api in production for the FRIDAY demo.

Reads the real Helm values file on every tick, so editing deploy/helm/payments-api/values-prod.yaml
changes the behaviour live. Each worker thread needs about 2.5 Redis connections at peak; when
REDIS_MAX_POOL is below that, the service logs redis-py "Too many connections" errors and p99 climbs.
Writes to logs/payments-api.log, which FRIDAY reads when the project is authorized. A config change is rolled
out like a real release: the old pod's output is cleared and a new pod starts, so the terminal (and FRIDAY, reading
the screen) only shows errors that are still happening.

Usage: python scripts/run_payments_api.py            (runs until Ctrl+C)
       python scripts/run_payments_api.py --once     (one tick, for tests)
"""

import argparse
import math
import os
import random
import re
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VALUES = ROOT / "deploy" / "helm" / "payments-api" / "values-prod.yaml"
LOG = ROOT / "logs" / "payments-api.log"
CONNECTIONS_PER_WORKER = 2.5


def read_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for line in VALUES.read_text(encoding="utf-8").splitlines():
        match = re.match(r'^\s+([A-Z][A-Z0-9_]+):\s*"?([^"#\n]*)"?', line)
        if match:
            env[match.group(1)] = match.group(2).strip()
    return env


def now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def tick(out: list[str]) -> bool:
    env = read_env()
    concurrency = int(env.get("PAYMENTS_WORKER_CONCURRENCY", "8"))
    pool = int(env.get("REDIS_MAX_POOL", "20"))
    needed = math.ceil(concurrency * CONNECTIONS_PER_WORKER)
    healthy = pool >= needed
    if healthy:
        in_use = min(pool, max(1, int(needed * random.uniform(0.55, 0.8))))
        p99 = random.randint(340, 460)
        out.append(f"{now()} INFO  payments-api POST /v1/charges p99={p99}ms rps=1840 redis_pool={in_use}/{pool} workers={concurrency}")
    else:
        waiting = needed - pool + random.randint(3, 11)
        p99 = round(random.uniform(3.8, 4.6), 1)
        worker = random.randint(1, concurrency)
        out.append(f"{now()} WARN  payments-api POST /v1/charges p99={p99}s rps=1790 redis_pool={pool}/{pool} waiting={waiting} workers={concurrency}")
        out.append(f"{now()} ERROR payments-api worker-{worker} request failed: redis.exceptions.ConnectionError: Too many connections")
        out.append('  File "/app/payments/idempotency.py", line 12, in get_idempotency_key')
        out.append('  File "/usr/local/lib/python3.12/site-packages/redis/connection.py", line 1422, in get_connection')
        out.append("    raise ConnectionError(\"Too many connections\")")
    return healthy


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    LOG.parent.mkdir(parents=True, exist_ok=True)
    LOG.write_text("", encoding="utf-8")  # each run starts a fresh log, like a new pod
    if os.name == "nt":
        os.system("")  # enables ANSI colours and screen clearing in the Windows console
    env = read_env()
    rolled_out = (env.get("PAYMENTS_WORKER_CONCURRENCY"), env.get("REDIS_MAX_POOL"))
    print(f"payments-api 2026.09.28-1 starting: workers={env.get('PAYMENTS_WORKER_CONCURRENCY')} "
          f"REDIS_MAX_POOL={env.get('REDIS_MAX_POOL')} (edit {VALUES.relative_to(ROOT)} to change)")
    try:
        while True:
            current = read_env()
            release = (current.get("PAYMENTS_WORKER_CONCURRENCY"), current.get("REDIS_MAX_POOL"))
            if release != rolled_out:
                rolled_out = release
                pod = "".join(random.choice("0123456789abcdef") for _ in range(5))
                sys.stdout.write("\033[2J\033[3J\033[H")  # new pod: the old pod's output is gone
                print(f"{now()} INFO  rollout: payments-api-{pod} started with workers={release[0]} "
                      f"REDIS_MAX_POOL={release[1]}")
            lines: list[str] = []
            tick(lines)
            with LOG.open("a", encoding="utf-8") as handle:
                handle.write("\n".join(lines) + "\n")
            for line in lines:
                colour = "\033[31m" if " ERROR " in line or "raise" in line or "File" in line else "\033[33m" if " WARN " in line else "\033[32m"
                print(f"{colour}{line}\033[0m")
            if args.once:
                return 0
            time.sleep(2)
    except KeyboardInterrupt:
        print("payments-api stopped")
        return 0


if __name__ == "__main__":
    sys.exit(main())
