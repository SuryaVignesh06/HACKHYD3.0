"""Seeding and demo reset, shared by scripts/seed_hindsight.py, scripts/reset_demo.py and POST /api/demo/reset."""

import re
import time
from collections.abc import Callable

from app.config import REPO_ROOT
from app.dataset import load_history
from app.db import reset_live_data
from app.services.memory import MemoryService, MemoryUnavailable, postmortem_item

BATCH_SIZE = 5
DEMO_PROJECT = REPO_ROOT / "demo" / "nimbus-pay"
DEMO_VALUES = DEMO_PROJECT / "deploy" / "helm" / "payments-api" / "values-prod.yaml"
DEMO_START = {"PAYMENTS_WORKER_CONCURRENCY": "24", "REDIS_MAX_POOL": "20"}


async def seed(memory: MemoryService, log: Callable[[str], None] = print) -> int:
    """Configure the bank (mission, disposition, directives) and retain every historical postmortem."""
    log(f"Configuring bank {memory.bank_id} (mission, disposition, directives)...")
    await memory.ensure_bank()
    items = [postmortem_item(incident, postmortem) for incident, postmortem in load_history()]
    started = time.perf_counter()
    for start in range(0, len(items), BATCH_SIZE):
        batch = items[start:start + BATCH_SIZE]
        count = await memory.retain_postmortem_batch(batch)
        log(f"  retained {batch[0]['document_id']}..{batch[-1]['document_id']} ({count} items, "
            f"{time.perf_counter() - started:.0f}s elapsed)")
    total = await memory.memory_count()
    log(f"Done. {len(items)} postmortems retained; the bank now holds {total} memories.")
    return total


def reset_demo_project() -> None:
    """payments-api config back to the demo starting state, and simulator logs cleared."""
    text = DEMO_VALUES.read_text(encoding="utf-8")
    for key, value in DEMO_START.items():
        text = re.sub(rf'^(\s+{key}:\s*)"[^"]*"', rf'\g<1>"{value}"', text, flags=re.MULTILINE)
    DEMO_VALUES.write_text(text, encoding="utf-8")
    for log_file in (DEMO_PROJECT / "logs").glob("*.log"):
        log_file.unlink()


async def reset_demo(memory: MemoryService, log: Callable[[str], None] = print) -> dict[str, int]:
    """Delete and reseed the bank, remove live incidents, and reset the demo project. Connected projects are kept."""
    try:
        await memory.delete_bank()
        log(f"Deleted bank {memory.bank_id}.")
    except MemoryUnavailable:
        log(f"Bank {memory.bank_id} did not exist or could not be deleted; seeding fresh.")
    memories = await seed(memory, log)
    removed = reset_live_data()
    log(f"Removed {removed} live incidents from SQLite; the 45 seeded incidents are kept.")
    reset_demo_project()
    log("Demo project reset: payments-api back to 24 workers and REDIS_MAX_POOL 20, logs cleared.")
    return {"memories": memories, "live_incidents_removed": removed}
