"""Incident, diagnosis, memory-stats, demo-alert and learning-curve endpoints."""

import json
import logging
import re
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from sqlmodel import Session, select

from app.config import get_settings
from app.dataset import load_demo_alerts
from app.db import from_db_time, get_session, record_event, to_db_time, utc_now
from app.models import (
    AttemptCreate,
    AttemptFacts,
    AttemptLogged,
    AttemptOut,
    AttemptRow,
    Diagnosis,
    DiagnosisRecord,
    DiagnosisRow,
    ExperienceCaptured,
    IncidentCreate,
    IncidentCreated,
    IncidentDetail,
    IncidentFacts,
    IncidentRow,
    IncidentSummary,
    LearningPoint,
    MemoryStats,
    PostmortemDraft,
    PostmortemFacts,
    ProjectRow,
    ResolveRequest,
)
from app.services.diagnosis import run_investigation
from app.services.evidence import parse_alert
from app.services.llm import LLMService, LLMUnavailable
from app.services.memory import MemoryService, MemoryUnavailable, format_postmortem_memory
from app.services.redaction import redact

router = APIRouter(prefix="/api")
logger = logging.getLogger("oncall.agent")

ALERT_NAME = re.compile(r"^\s*\[[A-Z]+\]\s*([A-Za-z0-9_.-]+)")


def get_memory(request: Request) -> MemoryService:
    memory: MemoryService = request.app.state.memory
    return memory


def get_llm(request: Request) -> LLMService:
    llm: LLMService = request.app.state.llm
    return llm


def not_found(incident_id: str) -> JSONResponse:
    return JSONResponse(status_code=404, content={"error": "not_found", "message": f"Incident {incident_id} does not exist."})


def next_incident_id(session: Session) -> str:
    numbers = [int(row.split("-")[1]) for row in session.exec(select(IncidentRow.id)).all() if row.startswith("INC-")]
    return f"INC-{(max(numbers) + 1 if numbers else 1):03d}"


def derive_title(alert_text: str, service: str, signature: str) -> str:
    match = ALERT_NAME.search(alert_text)
    if match and match.group(1)[:1].isupper():  # alert names like PaymentsApiHighLatency, not "[LOG] recent ..."
        return f"{match.group(1)} on {service}"
    short = signature.split(".")[-1] if signature.count(".") and ":" in signature.split(".")[-1] else signature
    return f"{short[:80]} on {service}" if short else f"Alert on {service}"


def summary_of(row: IncidentRow) -> IncidentSummary:
    return IncidentSummary(
        id=row.id, title=row.title, service=row.service, severity=row.severity, status=row.status,
        source=row.source, created_at=from_db_time(row.created_at) or utc_now(),
        resolved_at=from_db_time(row.resolved_at), root_cause=row.root_cause, ttr_minutes=row.ttr_minutes,
        family=row.family, origin=row.origin, project_id=row.project_id,
    )


def facts_of(row: IncidentRow) -> IncidentFacts:
    return IncidentFacts(
        id=row.id, title=row.title, service=row.service, severity=row.severity,
        started_at=from_db_time(row.created_at) or utc_now(), resolved_at=from_db_time(row.resolved_at),
        alert_text=row.alert_text, on_call=row.on_call,
    )


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/incidents", response_model=IncidentCreated, status_code=201)
async def create_incident(body: IncidentCreate, session: Session = Depends(get_session)) -> IncidentCreated | JSONResponse:
    if body.project_id is not None and session.get(ProjectRow, body.project_id) is None:
        return JSONResponse(status_code=400, content={"error": "unknown_project", "message": "That project is not connected."})
    parsed = parse_alert(body.alert_text, body.service, body.severity)
    row = IncidentRow(
        id=next_incident_id(session),
        title=body.title or derive_title(body.alert_text, parsed.service, parsed.signature),
        service=parsed.service,
        severity=parsed.severity,
        status="open",
        source="live",
        alert_text=body.alert_text,
        on_call=body.on_call,
        created_at=to_db_time(utc_now()),
        project_id=body.project_id,
        origin=body.origin or "manual",
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    logger.info("[CONTEXT] %s created from %s (%s, %s): %s", row.id, row.origin, row.service, row.severity, row.title)
    # The alert is retained into Hindsight at the end of the first memory-on investigation
    # (services/diagnosis.py), so the incident never matches itself during that investigation.
    return IncidentCreated(**summary_of(row).model_dump(), alert_text=row.alert_text)


@router.post("/incidents/{incident_id}/diagnose")
async def diagnose(incident_id: str, memory_enabled: bool = Query(True, alias="memory"),
                   memory: MemoryService = Depends(get_memory), llm: LLMService = Depends(get_llm)) -> StreamingResponse:
    async def stream() -> AsyncIterator[bytes]:
        async for event in run_investigation(incident_id, memory_enabled, memory, llm):
            yield (json.dumps(event) + "\n").encode("utf-8")

    return StreamingResponse(stream(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def attempts_of(session: Session, incident_id: str) -> list[AttemptRow]:
    return list(session.exec(select(AttemptRow).where(AttemptRow.incident_id == incident_id).order_by(AttemptRow.id)).all())  # type: ignore[arg-type]


def attempt_facts(rows: list[AttemptRow]) -> list[AttemptFacts]:
    return [AttemptFacts(action=r.action, outcome=r.outcome, notes=r.notes, created_at=from_db_time(r.created_at))  # type: ignore[arg-type]
            for r in rows]


def latest_memory_diagnosis(session: Session, incident_id: str) -> Diagnosis | None:
    row = session.exec(
        select(DiagnosisRow).where(DiagnosisRow.incident_id == incident_id, DiagnosisRow.memory_enabled == True)  # noqa: E712
        .order_by(DiagnosisRow.id.desc())  # type: ignore[union-attr]
    ).first()
    return Diagnosis.model_validate_json(row.payload_json) if row else None


def minutes_open(row: IncidentRow) -> int:
    started = from_db_time(row.created_at) or utc_now()
    return max(1, round((utc_now() - started).total_seconds() / 60))


def conflict(message: str) -> JSONResponse:
    return JSONResponse(status_code=409, content={"error": "conflict", "message": message})


@router.post("/incidents/{incident_id}/attempts", response_model=AttemptLogged, status_code=201)
async def log_attempt(incident_id: str, body: AttemptCreate, session: Session = Depends(get_session),
                      memory: MemoryService = Depends(get_memory)) -> AttemptLogged | JSONResponse:
    incident = session.get(IncidentRow, incident_id)
    if incident is None:
        return not_found(incident_id)
    if incident.status == "resolved":
        return conflict(f"{incident_id} is already resolved.")
    row = AttemptRow(incident_id=incident_id, action=body.action.strip(), outcome=body.outcome,
                     notes=(body.notes or "").strip() or None, created_at=to_db_time(utc_now()))
    session.add(row)
    session.commit()
    session.refresh(row)
    logger.info("[USER ACTION] %s tried: %s", incident_id, row.action[:160])
    logger.info("[OUTCOME] %s %s%s", incident_id, row.outcome, f" ({row.notes[:120]})" if row.notes else "")
    try:
        await memory.retain_attempt(facts_of(incident), attempt_facts([row])[0])
        retained = True
    except MemoryUnavailable:
        retained = False
    logger.info("[RETAIN] fix attempt on %s %s", incident_id, "queued in Hindsight" if retained else "failed: Hindsight unavailable")
    record_event("retain", f"fix attempt on {incident_id}: {row.action[:120]} ({row.outcome})", retained,
                 1 if retained else None, incident_id)
    return AttemptLogged(id=row.id or 0, action=row.action, outcome=row.outcome, notes=row.notes,
                         created_at=from_db_time(row.created_at) or utc_now(), memory_retained=retained)


@router.post("/incidents/{incident_id}/postmortem-draft", response_model=PostmortemDraft)
async def postmortem_draft(incident_id: str, session: Session = Depends(get_session),
                           llm: LLMService = Depends(get_llm)) -> PostmortemDraft | JSONResponse:
    incident = session.get(IncidentRow, incident_id)
    if incident is None:
        return not_found(incident_id)
    attempts = attempt_facts(attempts_of(session, incident_id))
    diagnosis = latest_memory_diagnosis(session, incident_id)
    ttr = minutes_open(incident)
    try:
        text, model = await llm.draft_postmortem(
            f"{incident.id} {incident.severity} {incident.service}: {incident.title}", incident.alert_text,
            attempts, diagnosis.summary if diagnosis else None)
        return PostmortemDraft(**text.model_dump(), ttr_minutes=ttr, drafted_by=model.split("/")[-1])
    except LLMUnavailable:
        # Degraded draft built only from what the session recorded, for the engineer to edit.
        worked = [a.action for a in attempts if a.outcome == "worked"]
        failed = [a.action for a in attempts if a.outcome == "failed"]
        summary = f"{incident.title}. {len(attempts)} fix attempts recorded"
        summary += f"; failed: {'; '.join(failed)}." if failed else "."
        return PostmortemDraft(
            summary=summary,
            root_cause=diagnosis.summary if diagnosis else "Not determined during the incident.",
            fix=worked[-1] if worked else "",
            follow_ups=[],
            ttr_minutes=ttr,
            drafted_by="session",
        )


@router.post("/incidents/{incident_id}/resolve", response_model=ExperienceCaptured)
async def resolve(incident_id: str, body: ResolveRequest, session: Session = Depends(get_session),
                  memory: MemoryService = Depends(get_memory)) -> ExperienceCaptured | JSONResponse:
    incident = session.get(IncidentRow, incident_id)
    if incident is None:
        return not_found(incident_id)
    if incident.status == "resolved":
        return conflict(f"{incident_id} is already resolved.")
    attempts = attempt_facts(attempts_of(session, incident_id))
    ttr = body.ttr_minutes if body.ttr_minutes is not None else minutes_open(incident)
    started = from_db_time(incident.created_at) or utc_now()
    incident.status = "resolved"
    incident.resolved_at = to_db_time(utc_now())
    incident.summary, incident.root_cause, incident.fix = body.summary, body.root_cause, body.fix
    incident.follow_ups_json = json.dumps(body.follow_ups)
    incident.ttr_minutes = ttr
    # The resolved incident joins the failure family of its confirmed precedent, which the Memory page groups by.
    diagnosis = latest_memory_diagnosis(session, incident_id)
    if diagnosis and diagnosis.strong_match and incident.family is None:
        # The most relevant cited precedent that belongs to a family; open live incidents have none yet.
        precedents = (session.get(IncidentRow, iid) for iid in diagnosis.cited_incidents)
        incident.family = next((p.family for p in precedents if p is not None and p.family), None)
    session.add(incident)
    session.commit()
    session.refresh(incident)

    facts = facts_of(incident).model_copy(update={"started_at": started})
    postmortem = PostmortemFacts(summary=body.summary, root_cause=body.root_cause, fix=body.fix,
                                 follow_ups=body.follow_ups, ttr_minutes=ttr, attempts=attempts)
    logger.info("[OUTCOME] %s resolved: %s", incident_id, body.fix[:160])
    if not body.retain:
        return ExperienceCaptured(
            incident_id=incident_id, pattern=body.root_cause,
            worked_fixes=[a.action for a in attempts if a.outcome == "worked"] or [body.fix],
            failed_fixes=[a.action for a in attempts if a.outcome == "failed"],
            retained_text="", memory_retained=False, memory_count_before=None, memory_count_after=None,
        )
    try:
        before: int | None = await memory.memory_count()
    except MemoryUnavailable:
        before = None
    try:
        retained_text = await memory.retain_postmortem(facts, postmortem)
        retained = True
    except MemoryUnavailable:
        retained_text, retained = redact(format_postmortem_memory(facts, postmortem)), False
    record_event("retain", f"postmortem for {incident_id}: {body.root_cause[:120]}", retained, 1 if retained else None,
                 incident_id)
    logger.info("[RETAIN] postmortem for %s %s", incident_id,
                "stored successfully; the next similar incident can recall it" if retained else "failed: Hindsight unavailable")
    try:
        after: int | None = await memory.memory_count()
    except MemoryUnavailable:
        after = None
    return ExperienceCaptured(
        incident_id=incident_id,
        pattern=body.root_cause,
        worked_fixes=[a.action for a in attempts if a.outcome == "worked"] or [body.fix],
        failed_fixes=[a.action for a in attempts if a.outcome == "failed"],
        retained_text=retained_text,
        memory_retained=retained,
        memory_count_before=before,
        memory_count_after=after,
    )


@router.get("/incidents", response_model=list[IncidentSummary])
async def list_incidents(session: Session = Depends(get_session)) -> list[IncidentSummary]:
    rows = session.exec(select(IncidentRow).order_by(IncidentRow.created_at.desc())).all()  # type: ignore[attr-defined]
    return [summary_of(row) for row in rows]


@router.get("/incidents/{incident_id}", response_model=IncidentDetail)
async def get_incident(incident_id: str, session: Session = Depends(get_session)) -> IncidentDetail | JSONResponse:
    row = session.get(IncidentRow, incident_id)
    if row is None:
        return not_found(incident_id)
    attempts = session.exec(select(AttemptRow).where(AttemptRow.incident_id == incident_id).order_by(AttemptRow.id)).all()  # type: ignore[arg-type]
    diagnoses = session.exec(select(DiagnosisRow).where(DiagnosisRow.incident_id == incident_id).order_by(DiagnosisRow.id)).all()  # type: ignore[arg-type]
    return IncidentDetail(
        **summary_of(row).model_dump(),
        alert_text=row.alert_text,
        on_call=row.on_call,
        summary=row.summary,
        fix=row.fix,
        follow_ups=json.loads(row.follow_ups_json),
        attempts=[AttemptOut(id=a.id or 0, action=a.action, outcome=a.outcome, notes=a.notes,
                             created_at=from_db_time(a.created_at) or utc_now()) for a in attempts],
        diagnoses=[DiagnosisRecord(id=d.id or 0, created_at=from_db_time(d.created_at) or utc_now(),
                                   diagnosis=Diagnosis.model_validate_json(d.payload_json)) for d in diagnoses],
    )


@router.get("/memory/stats", response_model=MemoryStats)
async def memory_stats(memory: MemoryService = Depends(get_memory)) -> MemoryStats:
    try:
        return MemoryStats(bank_id=memory.bank_id, memory_count=await memory.memory_count(),
                           observation_count=await memory.observation_count(), available=True,
                           demo_tools=get_settings().DEMO_TOOLS)
    except MemoryUnavailable:
        return MemoryStats(bank_id=memory.bank_id, memory_count=None, observation_count=None, available=False,
                           demo_tools=get_settings().DEMO_TOOLS)


@router.get("/demo-alerts")
async def demo_alerts() -> list[dict[str, Any]]:
    return load_demo_alerts()


@router.get("/learning", response_model=list[LearningPoint])
async def learning(session: Session = Depends(get_session)) -> list[LearningPoint]:
    points: list[LearningPoint] = []
    for row in session.exec(select(DiagnosisRow).order_by(DiagnosisRow.id)).all():  # type: ignore[arg-type]
        diagnosis = Diagnosis.model_validate_json(row.payload_json)
        points.append(LearningPoint(
            diagnosis_id=row.id or 0, incident_id=row.incident_id, memory_enabled=row.memory_enabled,
            confidence=diagnosis.confidence, cited_count=len(diagnosis.cited_incidents),
            strong_match=diagnosis.strong_match, degraded=diagnosis.degraded, latency_ms=row.latency_ms,
            created_at=from_db_time(row.created_at) or utc_now(),
        ))
    return points
