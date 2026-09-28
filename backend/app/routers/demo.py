"""Reset Demo: restores the Hindsight bank, live incidents and the demo project to the start of the demo script."""

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from app.seeding import reset_demo
from app.services.memory import MemoryService

router = APIRouter(prefix="/api")


class ResetRequest(BaseModel):
    confirm: Literal["reset"]  # explicit, so a stray request can never wipe the demo


class ResetResult(BaseModel):
    memories: int
    live_incidents_removed: int
    log: list[str]


@router.post("/demo/reset", response_model=ResetResult)
async def demo_reset(_: ResetRequest) -> ResetResult:
    lines: list[str] = []
    memory = MemoryService(timeout=600.0)  # seeding 45 postmortems takes about a minute
    try:
        result = await reset_demo(memory, lines.append)
    finally:
        await memory.close()
    return ResetResult(memories=result["memories"], live_incidents_removed=result["live_incidents_removed"], log=lines)
