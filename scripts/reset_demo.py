"""Reset Demo: puts everything back to the start of the demo script.

- Hindsight bank nimbus-oncall: deleted and reseeded with the 45 historical incidents
- SQLite: live incidents, their attempts and diagnoses, and the memory event log removed
- demo/nimbus-pay: payments-api config back to 24 workers and REDIS_MAX_POOL 20, logs cleared
Connected projects (the engineer's access decisions) are kept. The same reset is available in the
app (Memory page, Reset demo) through POST /api/demo/reset.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.seeding import reset_demo  # noqa: E402
from app.services.memory import MemoryService  # noqa: E402


async def main() -> int:
    memory = MemoryService(timeout=600.0)
    try:
        await reset_demo(memory)
    finally:
        await memory.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
