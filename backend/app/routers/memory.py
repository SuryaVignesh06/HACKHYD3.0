"""Memory page: the team's accumulated engineering experience, grouped service -> failure family -> incidents.

Everything is computed from recorded incidents, attempts and diagnoses; the Hindsight memory count comes
from the bank itself. Nothing is estimated.
"""

from collections import defaultdict
from datetime import datetime

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Session, select

from app.db import from_db_time, get_session
from app.models import AttemptRow, Diagnosis, DiagnosisRow, IncidentRow
from app.services.memory import MemoryService, MemoryUnavailable

router = APIRouter(prefix="/api")


class FixOutcome(BaseModel):
    action: str
    incident_id: str
    outcome: str


class FamilyNode(BaseModel):
    family: str
    label: str
    incident_ids: list[str]
    worked: list[FixOutcome]
    failed: list[FixOutcome]
    related_files: list[str]
    first_seen: datetime | None
    last_seen: datetime | None


class ServiceNode(BaseModel):
    service: str
    incident_count: int
    families: list[FamilyNode]
    other_incident_ids: list[str]


class GrowthPoint(BaseModel):
    at: datetime
    incidents_learned: int
    fixes_recorded: int


class MemoryTotals(BaseModel):
    incidents_learned: int
    fix_attempts: int
    worked: int
    failed: int
    partial: int
    families: int
    live_incidents_learned: int
    hindsight_memories: int | None
    hindsight_observations: int | None


class MemoryOverview(BaseModel):
    totals: MemoryTotals
    services: list[ServiceNode]
    growth: list[GrowthPoint]


def label_for(family: str) -> str:
    words = family.replace("-", " ").split()
    fixed = {"oom": "OOM", "tls": "TLS", "cdn": "CDN", "api": "API"}
    return " ".join(fixed.get(w, w) for w in words).capitalize() if words else family


def get_memory(request: Request) -> MemoryService:
    memory: MemoryService = request.app.state.memory
    return memory


@router.get("/memory/overview", response_model=MemoryOverview)
async def overview(session: Session = Depends(get_session), memory: MemoryService = Depends(get_memory)) -> MemoryOverview:
    incidents = [i for i in session.exec(select(IncidentRow)).all() if i.status == "resolved"]
    resolved_ids = {i.id for i in incidents}
    attempts = [a for a in session.exec(select(AttemptRow)).all() if a.incident_id in resolved_ids]
    by_incident: dict[str, list[AttemptRow]] = defaultdict(list)
    for attempt in attempts:
        by_incident[attempt.incident_id].append(attempt)

    family_members: dict[str, list[IncidentRow]] = defaultdict(list)
    for incident in incidents:
        if incident.family:
            family_members[incident.family].append(incident)

    # Files the desktop agent actually found for incidents of a family.
    family_files: dict[str, set[str]] = defaultdict(set)
    family_of = {i.id: i.family for i in incidents if i.family}
    for row in session.exec(select(DiagnosisRow)).all():
        diagnosis = Diagnosis.model_validate_json(row.payload_json)
        if not diagnosis.findings:
            continue
        for cited in diagnosis.cited_incidents:
            family = family_of.get(cited)
            if family:
                family_files[family].update(f"{diagnosis.project}/{f.path}" if diagnosis.project else f.path for f in diagnosis.findings)

    services: dict[str, ServiceNode] = {}
    for service in sorted({i.service for i in incidents}):
        members = [i for i in incidents if i.service == service]
        families: list[FamilyNode] = []
        for family in sorted({i.family for i in members if i.family}):
            rows = sorted(family_members[family], key=lambda i: i.created_at)
            outcomes = [FixOutcome(action=a.action, incident_id=a.incident_id, outcome=a.outcome)
                        for r in rows for a in by_incident.get(r.id, [])]
            families.append(FamilyNode(
                family=family,
                label=label_for(family),
                incident_ids=[r.id for r in rows],
                worked=[o for o in outcomes if o.outcome == "worked"],
                failed=[o for o in outcomes if o.outcome == "failed"],
                related_files=sorted(family_files.get(family, set())),
                first_seen=from_db_time(rows[0].created_at) if rows else None,
                last_seen=from_db_time(rows[-1].created_at) if rows else None,
            ))
        services[service] = ServiceNode(
            service=service,
            incident_count=len(members),
            families=families,
            other_incident_ids=sorted(i.id for i in members if not i.family),
        )

    growth: list[GrowthPoint] = []
    learned = fixes = 0
    for incident in sorted(incidents, key=lambda i: i.resolved_at or i.created_at):
        learned += 1
        fixes += len(by_incident.get(incident.id, []))
        moment = from_db_time(incident.resolved_at or incident.created_at)
        if moment:
            growth.append(GrowthPoint(at=moment, incidents_learned=learned, fixes_recorded=fixes))

    try:
        memories: int | None = await memory.memory_count()
        observations: int | None = await memory.observation_count()
    except MemoryUnavailable:
        memories = observations = None

    return MemoryOverview(
        totals=MemoryTotals(
            incidents_learned=len(incidents),
            fix_attempts=len(attempts),
            worked=sum(1 for a in attempts if a.outcome == "worked"),
            failed=sum(1 for a in attempts if a.outcome == "failed"),
            partial=sum(1 for a in attempts if a.outcome == "partial"),
            families=len(family_members),
            live_incidents_learned=sum(1 for i in incidents if i.source == "live"),
            hindsight_memories=memories,
            hindsight_observations=observations,
        ),
        services=list(services.values()),
        growth=growth,
    )
