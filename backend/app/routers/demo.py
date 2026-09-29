"""Demo tools: seed engineering memory without duplicates, and Reset demo. Both are off when DEMO_TOOLS=false."""

import logging
from typing import Literal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.config import get_settings
from app.models import SeedResult
from app.seeding import reset_demo, seed_missing
from app.services.memory import MemoryService, MemoryUnavailable

router = APIRouter(prefix="/api")
logger = logging.getLogger("oncall.agent")


class ResetRequest(BaseModel):
    confirm: Literal["reset"]  # explicit, so a stray request can never wipe the demo


class ResetResult(BaseModel):
    memories: int
    live_incidents_removed: int
    log: list[str]


def disabled() -> JSONResponse:
    return JSONResponse(status_code=403, content={"error": "demo_tools_disabled",
                                                  "message": "Demo tools are turned off on this deployment."})


@router.post("/memory/seed", response_model=SeedResult)
async def seed_memory(request: Request) -> SeedResult | JSONResponse:
    if not get_settings().DEMO_TOOLS:
        return disabled()
    lines: list[str] = []
    memory = MemoryService(timeout=600.0)  # a first seed of 45 postmortems takes about a minute
    try:
        counts = await seed_missing(memory, lines.append)
    finally:
        await memory.close()
    live: MemoryService = request.app.state.memory
    try:
        total: int | None = await live.memory_count()
    except MemoryUnavailable:
        total = None
    status: Literal["success", "already_seeded"] = "already_seeded" if counts["created"] == 0 else "success"
    logger.info("[RETAIN] seed: %d created, %d skipped, bank %s", counts["created"], counts["skipped"], live.bank_id)
    return SeedResult(status=status, bank=live.bank_id, created=counts["created"], skipped=counts["skipped"],
                      memory_count=total, log=lines)


@router.post("/demo/reset", response_model=ResetResult)
async def demo_reset(_: ResetRequest) -> ResetResult | JSONResponse:
    if not get_settings().DEMO_TOOLS:
        return disabled()
    lines: list[str] = []
    memory = MemoryService(timeout=600.0)  # seeding 45 postmortems takes about a minute
    try:
        result = await reset_demo(memory, lines.append)
    finally:
        await memory.close()
    return ResetResult(memories=result["memories"], live_incidents_removed=result["live_incidents_removed"], log=lines)
