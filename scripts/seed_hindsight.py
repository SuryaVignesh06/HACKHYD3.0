"""Creates the nimbus-oncall bank (mission, disposition, directives) and retains every postmortem.

Uses retain_async=False so recall works as soon as the script finishes.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.seeding import seed  # noqa: E402
from app.services.memory import MemoryService  # noqa: E402


async def main() -> int:
    memory = MemoryService(timeout=600.0)
    try:
        await seed(memory)
    finally:
        await memory.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
