"""Deletes the nimbus-oncall bank and reseeds it, and removes live incidents from SQLite, so every
demo run starts from the same state. Restart the backend afterwards if it is running."""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.db import reset_live_data  # noqa: E402
from app.seeding import seed  # noqa: E402
from app.services.memory import MemoryService, MemoryUnavailable  # noqa: E402


async def main() -> int:
    memory = MemoryService(timeout=600.0)
    try:
        try:
            await memory.delete_bank()
            print(f"Deleted bank {memory.bank_id}.")
        except MemoryUnavailable:
            print(f"Bank {memory.bank_id} did not exist or could not be deleted; continuing with a fresh seed.")
        await seed(memory)
        removed = reset_live_data()
        print(f"Removed {removed} live incidents from SQLite; the 45 seeded incidents are kept.")
    finally:
        await memory.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
