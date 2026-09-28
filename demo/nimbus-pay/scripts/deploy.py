"""Simulates a Helm release of payments-api by editing its production values.

Usage: python scripts/deploy.py --set PAYMENTS_WORKER_CONCURRENCY=32
       python scripts/deploy.py --reset     (back to the demo starting state: concurrency 24, pool 20)
"""

import argparse
import re
import sys
from pathlib import Path

VALUES = Path(__file__).resolve().parents[1] / "deploy" / "helm" / "payments-api" / "values-prod.yaml"
DEMO_START = {"PAYMENTS_WORKER_CONCURRENCY": "24", "REDIS_MAX_POOL": "20"}


def set_values(changes: dict[str, str]) -> None:
    text = VALUES.read_text(encoding="utf-8")
    for key, value in changes.items():
        text, count = re.subn(rf'^(\s+{re.escape(key)}:\s*)"[^"]*"', rf'\g<1>"{value}"', text, flags=re.MULTILINE)
        if count == 0:
            raise SystemExit(f"{key} not found in {VALUES.name}")
    VALUES.write_text(text, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--set", action="append", default=[], metavar="KEY=VALUE")
    parser.add_argument("--reset", action="store_true")
    args = parser.parse_args()
    changes = dict(DEMO_START) if args.reset else {}
    for item in args.set:
        key, _, value = item.partition("=")
        changes[key.strip()] = value.strip()
    if not changes:
        parser.error("nothing to deploy; use --set KEY=VALUE or --reset")
    set_values(changes)
    for key, value in changes.items():
        print(f"deployed payments-api: {key}={value}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
