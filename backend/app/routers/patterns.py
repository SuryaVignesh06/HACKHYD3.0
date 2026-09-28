"""Patterns page: recurring failure modes that Hindsight consolidated into observations on its own."""

from fastapi import APIRouter, Depends, Request

from app.models import Pattern, PatternsResponse
from app.services.memory import MemoryService, MemoryUnavailable

router = APIRouter(prefix="/api")

PATTERNS_QUERY = (
    "Which failure patterns keep recurring across incidents? For each pattern, name the service, the incidents "
    "involved, the fix that worked and the fixes that failed every time, and the follow-up that would stop it "
    "recurring. Cite incident IDs."
)

# The reflect answer only changes when memory changes, so it is cached per memory count.
_summary_cache: dict[int, str] = {}


def get_memory(request: Request) -> MemoryService:
    memory: MemoryService = request.app.state.memory
    return memory


@router.get("/patterns", response_model=PatternsResponse)
async def patterns(memory: MemoryService = Depends(get_memory)) -> PatternsResponse:
    observations = await memory.list_observations()
    # A pattern is an observation that spans more than one incident; single-incident observations are summaries.
    recurring = sorted(
        (o for o in observations if len(o.incident_ids) >= 2),
        key=lambda o: (len(o.incident_ids), o.proof_count),
        reverse=True,
    )
    try:
        count: int | None = await memory.memory_count()
    except MemoryUnavailable:
        count = None
    summary: str | None = _summary_cache.get(count) if count is not None else None
    if summary is None:
        try:
            summary = await memory.reflect_free(PATTERNS_QUERY, budget="low")
            if count is not None:
                _summary_cache.clear()
                _summary_cache[count] = summary
        except MemoryUnavailable:
            summary = None
    return PatternsResponse(
        patterns=[Pattern(text=o.text, incident_ids=o.incident_ids, proof_count=o.proof_count, updated_at=o.updated_at)
                  for o in recurring],
        observation_count=len(observations),
        summary=summary,
        memory_count=count,
    )
