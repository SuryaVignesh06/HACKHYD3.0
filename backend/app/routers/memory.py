"""Memory page: the team's accumulated engineering experience, grouped service -> failure family -> incidents.

Everything is computed from recorded incidents, attempts and diagnoses; the Hindsight memory count comes
from the bank itself. Nothing is estimated.
"""

import asyncio
import logging
import time
from collections import defaultdict
from datetime import datetime

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Session, select

from app.db import from_db_time, get_session, record_event
from app.models import (
    AskAnswer,
    AskRequest,
    AssistAnswer,
    AssistRequest,
    AttemptRow,
    Diagnosis,
    DiagnosisRow,
    IncidentRow,
    PastIncident,
)
from app.services import assist as assist_service
from app.services.evidence import INCIDENT_ID, parse_alert, scrub_unverified_lines
from app.services.llm import LLMService
from app.services.memory import MemoryService, MemoryUnavailable

router = APIRouter(prefix="/api")
logger = logging.getLogger("oncall.agent")
ASK_MAX_INCIDENTS = 6
ASK_QUERY = ("{question}\n\nAnswer from the team's past incidents only, for an on-call engineer reading a small panel. "
             "Start with one or two plain sentences that answer the question. Then at most four short bullet points: "
             "what worked, what failed, and the lesson, each naming the incident IDs it relies on. No headings, no tables. "
             "If nothing in memory matches, say so plainly.")


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


class LearnedExperience(BaseModel):
    """An incident resolved in the app and retained as a new engineering experience."""

    id: str
    title: str
    service: str
    root_cause: str | None
    fix: str | None
    resolved_at: datetime | None
    worked: int
    failed: int


class MemoryOverview(BaseModel):
    totals: MemoryTotals
    services: list[ServiceNode]
    growth: list[GrowthPoint]
    recent_learned: list[LearnedExperience]


def label_for(family: str) -> str:
    words = family.replace("-", " ").split()
    fixed = {"oom": "OOM", "tls": "TLS", "cdn": "CDN", "api": "API"}
    return " ".join(fixed.get(w, w) for w in words).capitalize() if words else family


def get_memory(request: Request) -> MemoryService:
    memory: MemoryService = request.app.state.memory
    return memory


def get_llm(request: Request) -> LLMService:
    llm: LLMService = request.app.state.llm
    return llm


@router.post("/assist", response_model=AssistAnswer)
async def assist(body: AssistRequest, session: Session = Depends(get_session), memory: MemoryService = Depends(get_memory),
                 llm: LLMService = Depends(get_llm)) -> AssistAnswer:
    """A question about what the engineer is looking at, answered from the screen, Hindsight memory and the
    authorized project, with every fact labelled by its source (services/assist.py)."""
    return await assist_service.answer(body, session, memory, llm)


@router.post("/memory/ask", response_model=AskAnswer)
async def ask(body: AskRequest, session: Session = Depends(get_session),
              memory: MemoryService = Depends(get_memory)) -> AskAnswer:
    """Ask the team's memory a question. Recall picks the incidents; reflect answers; any incident the answer names
    that recall did not return is scrubbed (no citation, no claim)."""
    started = time.perf_counter()
    question = body.question.strip()
    parsed = parse_alert(question)
    service = parsed.service if parsed.service != "unknown-service" else ""
    logger.info("[RECALL] ask: %r", question[:160])
    reflect_task = asyncio.create_task(memory.reflect_free(ASK_QUERY.format(question=question), budget="low"))
    try:
        recalled = await memory.recall_similar(question, service)
    except MemoryUnavailable:
        reflect_task.cancel()
        record_event("recall", f"ask: {question[:120]}", False, None, None)
        return AskAnswer(question=question, answer="Hindsight is unavailable right now, so nothing could be recalled. "
                         "No past incidents are shown rather than guessed.", incidents=[], recalled_count=0,
                         memory_unavailable=True, latency_ms=int((time.perf_counter() - started) * 1000))
    record_event("recall", f"ask: {question[:120]}", True, len(recalled), None)

    rows = {row.id: row for row in session.exec(select(IncidentRow)).all()}
    best: dict[str, float | None] = {}
    for m in recalled:
        if m.incident_id and m.incident_id in rows:
            current = best.get(m.incident_id)
            best[m.incident_id] = max(current or 0.0, m.relevance or 0.0) if m.relevance is not None else current
    try:
        raw_answer = await reflect_task
        record_event("reflect", f"ask: {question[:120]}", True, None, None)
    except MemoryUnavailable:
        raw_answer = ""
        record_event("reflect", f"ask: {question[:120]}", False, None, None)
    answer = scrub_unverified_lines(raw_answer, set(best))
    if raw_answer and not answer:
        answer = "Hindsight's answer relied on incidents that recall did not return, so it is not shown."
    elif not raw_answer:
        answer = "Hindsight reflect is unavailable; these are the incidents recall returned."

    top = sorted(best, key=lambda iid: best[iid] or 0.0, reverse=True)[:ASK_MAX_INCIDENTS]
    named = [iid for iid in dict.fromkeys(INCIDENT_ID.findall(answer)) if iid in best and iid not in top]
    ids = sorted(top + named, key=lambda iid: best[iid] or 0.0, reverse=True)
    attempts: dict[str, list[AttemptRow]] = defaultdict(list)
    if ids:
        for a in session.exec(select(AttemptRow).where(AttemptRow.incident_id.in_(ids)).order_by(AttemptRow.id)).all():  # type: ignore[attr-defined]
            attempts[a.incident_id].append(a)
    incidents = [
        PastIncident(
            id=iid, title=rows[iid].title, service=rows[iid].service, occurred_at=from_db_time(rows[iid].created_at),
            relevance=round(best[iid], 4) if best[iid] is not None else None,
            learned_live=rows[iid].source == "live" and rows[iid].status == "resolved",
            root_cause=rows[iid].root_cause, fix=rows[iid].fix,
            worked=[a.action for a in attempts[iid] if a.outcome == "worked"],
            failed=[a.action for a in attempts[iid] if a.outcome == "failed"],
        )
        for iid in ids
    ]
    logger.info("[REFLECT] ask answered from %d recalled memories, %d incidents shown", len(recalled), len(incidents))
    return AskAnswer(question=question, answer=answer, incidents=incidents, recalled_count=len(recalled),
                     memory_unavailable=False, latency_ms=int((time.perf_counter() - started) * 1000))


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
        recent_learned=[
            LearnedExperience(
                id=i.id, title=i.title, service=i.service, root_cause=i.root_cause, fix=i.fix,
                resolved_at=from_db_time(i.resolved_at),
                worked=sum(1 for a in by_incident.get(i.id, []) if a.outcome == "worked"),
                failed=sum(1 for a in by_incident.get(i.id, []) if a.outcome == "failed"),
            )
            for i in sorted((i for i in incidents if i.source == "live"), key=lambda i: i.resolved_at or i.created_at,
                            reverse=True)[:8]
        ],
    )
