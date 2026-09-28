"""Phase 0 smoke test: retain one memory into a throwaway bank, recall it, and exit 0 on success."""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from hindsight_client import Hindsight  # noqa: E402

from app.config import get_settings  # noqa: E402

SMOKE_BANK = "smoke-test"
SMOKE_TEXT = "Smoke test memory for On-Call Copilot"


async def main() -> int:
    settings = get_settings()
    client = Hindsight(base_url=settings.HINDSIGHT_BASE_URL, api_key=settings.HINDSIGHT_API_KEY, timeout=60.0)
    try:
        version = await client.aget_version()
        print(f"Connected to Hindsight at {settings.HINDSIGHT_BASE_URL} (version: {version})")
        await client.acreate_bank(SMOKE_BANK, name="Smoke Test")
        retained = await client.aretain(SMOKE_BANK, SMOKE_TEXT, context="smoke-test", document_id="SMOKE-1")
        print(f"Retained: success={retained.success} items={retained.items_count}")
        recalled = await client.arecall(SMOKE_BANK, query="On-Call Copilot smoke test", budget="low")
        for result in recalled.results:
            print(f"Recalled [{result.type}] {result.text}")
        if not recalled.results:
            print("Recall returned no results.")
            return 1
        return 0
    finally:
        await client.aclose()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
