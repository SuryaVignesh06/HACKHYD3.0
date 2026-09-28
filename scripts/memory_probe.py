"""Runs recall and reflect for DEMO-A, DEMO-B and DEMO-C and prints what memory returns.

Nothing is retained, so the demo alerts stay out of memory.
"""

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.dataset import load_demo_alerts  # noqa: E402
from app.services.memory import MemoryService  # noqa: E402

TOP_N = 5


async def probe(memory: MemoryService, alert: dict[str, str]) -> None:
    print("=" * 100)
    print(f"{alert['id']}: {alert['title']}")
    print(f"Expected: {alert['expected']}")
    started = time.perf_counter()
    recalled, reflect_text = await asyncio.gather(
        memory.recall_similar(alert["alert_text"], alert["service"]),
        memory.reflect_diagnosis(alert["alert_text"], alert["service"]),
    )
    elapsed = time.perf_counter() - started
    print(f"\nRecall: {len(recalled)} memories (recall + reflect in parallel took {elapsed:.1f}s). Top {TOP_N}:")
    for memory_item in recalled[:TOP_N]:
        date = memory_item.occurred_at.date().isoformat() if memory_item.occurred_at else "no date"
        print(f"  [{memory_item.incident_id or '-'} | {date} | {memory_item.type}] {memory_item.text[:220]}")
    cited = sorted({m.incident_id for m in recalled if m.incident_id})
    print(f"\nIncident IDs across all recalled memories: {', '.join(cited) or 'none'}")
    print(f"\nReflect answer:\n{reflect_text}\n")


async def main() -> int:
    memory = MemoryService(timeout=120.0)
    try:
        print(f"Bank {memory.bank_id} holds {await memory.memory_count()} memories.")
        for alert in load_demo_alerts():
            await probe(memory, alert)
    finally:
        await memory.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
