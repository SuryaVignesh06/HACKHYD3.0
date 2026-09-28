"""Investigation orchestrator: runs parse -> recall -> evidence -> inspect -> reflect -> diagnosis and streams each step.

inspect only runs when the incident belongs to an authorized project; it reads the project to find where
the settings that past fixes changed are set today.

run_investigation is an async generator of JSON-serialisable events:
  {"type": "step", "step": InvestigationStep, "data": {...}}   one per finished step
  {"type": "diagnosis", "diagnosis": Diagnosis, "diagnosis_id": int}
  {"type": "error", "error": "memory_unavailable" | "not_found", "message": str}
Reflect starts concurrently with recall because it is the slow call (about 9 s at budget low).
"""

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator
from typing import Any

from sqlmodel import Session, select

from app.db import engine, from_db_time, record_event, to_db_time, utc_now
from app.models import (
    AttemptFacts,
    AttemptRow,
    AvoidFix,
    CodeFinding,
    Diagnosis,
    DiagnosisRow,
    FixSuggestion,
    IncidentFacts,
    IncidentRow,
    InvestigationStep,
    ProjectRow,
    RecalledMemory,
    StepName,
)
from app.services.evidence import (
    KnownIncident,
    ParsedAlert,
    attempt_index,
    cite_candidates,
    confirm_precedent,
    is_strong_match,
    matched_incidents,
    parse_alert,
    scrub_unverified,
    strip_incident_ids,
    verify_draft,
)
from app.services.llm import LLMService, LLMUnavailable
from app.services.memory import MemoryService, MemoryUnavailable
from app.services.project_context import ProjectAccessError, find_findings, validate_root

logger = logging.getLogger(__name__)

MAX_RECALLED_IN_PAYLOAD = 20
Event = dict[str, Any]


def _ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


def _step(name: StepName, detail: str, duration_ms: int, data: dict[str, Any] | None = None) -> tuple[InvestigationStep, Event]:
    step = InvestigationStep(name=name, detail=detail, duration_ms=duration_ms)
    return step, {"type": "step", "step": step.model_dump(), "data": data or {}}


async def _timed(coro: Any) -> tuple[Any, int]:
    started = time.perf_counter()
    result = await coro
    return result, _ms(started)


def _known_incidents(session: Session) -> dict[str, KnownIncident]:
    return {
        row.id: KnownIncident(title=row.title, service=row.service, occurred_at=from_db_time(row.created_at))
        for row in session.exec(select(IncidentRow)).all()
    }


def _attempts_for(session: Session, incident_ids: list[str]) -> dict[str, list[AttemptFacts]]:
    result: dict[str, list[AttemptFacts]] = {iid: [] for iid in incident_ids}
    if not incident_ids:
        return result
    rows = session.exec(
        select(AttemptRow).where(AttemptRow.incident_id.in_(incident_ids)).order_by(AttemptRow.id)  # type: ignore[attr-defined]
    ).all()
    for row in rows:
        result[row.incident_id].append(AttemptFacts(
            action=row.action, outcome=row.outcome, notes=row.notes,  # type: ignore[arg-type]
            created_at=from_db_time(row.created_at),
        ))
    return result


def _save(session: Session, incident_id: str, diagnosis: Diagnosis) -> int:
    row = DiagnosisRow(
        incident_id=incident_id,
        memory_enabled=diagnosis.memory_enabled,
        payload_json=diagnosis.model_dump_json(),
        recalled_ids_json=json.dumps([m.id for m in diagnosis.matched]),
        latency_ms=diagnosis.latency_ms,
        created_at=to_db_time(utc_now()),
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    assert row.id is not None
    return row.id


def _final(session: Session, incident_id: str, diagnosis: Diagnosis) -> Event:
    diagnosis_id = _save(session, incident_id, diagnosis)
    return {"type": "diagnosis", "diagnosis": diagnosis.model_dump(mode="json"), "diagnosis_id": diagnosis_id}


async def _baseline(incident: IncidentRow, parsed: ParsedAlert, llm: LLMService, steps: list[InvestigationStep],
                    started: float) -> tuple[Event, Diagnosis]:
    """Memory off: the alert alone goes to the LLM, and any incident ID it produces is stripped."""
    llm_started = time.perf_counter()
    try:
        draft, model = await llm.baseline_diagnosis(incident.alert_text, parsed.service)
        diagnosis = Diagnosis(
            summary=strip_incident_ids(draft.summary),
            confidence=min(draft.confidence, 0.5),
            hypotheses=[h.model_copy(update={"cause": strip_incident_ids(h.cause), "evidence": []}) for h in draft.hypotheses],
            try_first=FixSuggestion(action=strip_incident_ids(draft.try_first.action)) if draft.try_first else None,
            avoid=[AvoidFix(action=strip_incident_ids(a.action), why=strip_incident_ids(a.why)) for a in draft.avoid],
            memory_enabled=False,
            latency_ms=0,
        )
        detail = f"Generic answer from {model.split('/')[-1]}, no memory used"
    except LLMUnavailable:
        diagnosis = Diagnosis(
            summary="The language model is unavailable right now, so no generic answer could be produced.",
            memory_enabled=False, degraded=True, latency_ms=0,
        )
        detail = "Language model unavailable"
    step, event = _step("diagnosis", detail, _ms(llm_started))
    steps.append(step)
    diagnosis.steps = steps
    diagnosis.latency_ms = _ms(started)
    return event, diagnosis


async def run_investigation(incident_id: str, memory_enabled: bool, memory: MemoryService,
                            llm: LLMService) -> AsyncIterator[Event]:
    started = time.perf_counter()
    steps: list[InvestigationStep] = []
    with Session(engine) as session:
        incident = session.get(IncidentRow, incident_id)
        if incident is None:
            yield {"type": "error", "error": "not_found", "message": f"Incident {incident_id} does not exist."}
            return

        parse_started = time.perf_counter()
        parsed = parse_alert(incident.alert_text, incident.service, incident.severity)
        step, event = _step("parse", f"{parsed.service}, {parsed.severity}, signature: {parsed.signature}",
                            _ms(parse_started), {"service": parsed.service, "severity": parsed.severity,
                                                 "signature": parsed.signature})
        steps.append(step)
        yield event

        if not memory_enabled:
            event, baseline = await _baseline(incident, parsed, llm, steps, started)
            yield event
            yield _final(session, incident_id, baseline)
            return

        reflect_task = asyncio.create_task(_timed(memory.reflect_diagnosis(incident.alert_text, parsed.service, budget="low")))

        # ------------------------------------------------ recall
        try:
            recalled_all, recall_ms = await _timed(memory.recall_similar(incident.alert_text, parsed.service))
        except MemoryUnavailable as exc:
            reflect_task.cancel()
            record_event("recall", f"{parsed.service}: {parsed.signature}", False, None, incident_id)
            yield {"type": "error", "error": "memory_unavailable", "message": str(exc)}
            return
        record_event("recall", f"{parsed.service}: {parsed.signature}", True, len(recalled_all), incident_id)
        others = [m for m in recalled_all if m.incident_id != incident_id]
        recalled: list[RecalledMemory] = others[:MAX_RECALLED_IN_PAYLOAD]
        known = _known_incidents(session)
        matched = matched_incidents(others, known, exclude_id=incident_id)
        if matched:
            best = matched[0]
            detail = (f"{len(recalled_all)} memories, {len(matched)} related incidents; "
                      f"most relevant {best.id} at {best.relevance:.0%}")
        else:
            detail = f"{len(recalled_all)} memories, no related incidents"
        step, event = _step("recall", detail, recall_ms, {
            "matched": [m.model_dump(mode="json") for m in matched],
            "recalled": [m.model_dump(mode="json") for m in recalled],
        })
        steps.append(step)
        yield event

        # ------------------------------------------------ evidence
        evidence_started = time.perf_counter()
        attempts = _attempts_for(session, [m.id for m in matched])
        worked = sum(1 for items in attempts.values() for a in items if a.outcome == "worked")
        failed = sum(1 for items in attempts.values() for a in items if a.outcome == "failed")
        step, event = _step("evidence", f"Checked the fix log of {len(matched)} incidents: {worked} fixes worked, {failed} failed",
                            _ms(evidence_started), {"worked": worked, "failed": failed})
        steps.append(step)
        yield event

        # ------------------------------------------------ inspect the authorized project
        candidates = cite_candidates(matched)
        inspect_started = time.perf_counter()
        project = session.get(ProjectRow, incident.project_id) if incident.project_id else None
        findings: list[CodeFinding] = []
        if project is None:
            detail = "No project connected, so no code or config was inspected"
        else:
            try:
                root = validate_root(project.root_path)
                history = _history_text(session, [m.id for m in matched if m.id in candidates], attempts)
                findings = await asyncio.to_thread(find_findings, root, history)
                detail = (f"Inspected {project.name}: " + "; ".join(f"{f.identifier} at {f.path}:{f.line}" for f in findings)
                          if findings else
                          f"Inspected {project.name}: none of the settings that past fixes changed appear in it")
            except ProjectAccessError as exc:
                detail = f"Could not read {project.name}: {exc}"
        step, event = _step("inspect", detail, _ms(inspect_started),
                            {"findings": [f.model_dump(mode="json") for f in findings]})
        steps.append(step)
        yield event

        # ------------------------------------------------ reflect
        try:
            verdict, reflect_ms = await reflect_task
            reflect_text, hindsight_strong, hindsight_ids = verdict.text, verdict.strong_precedent, verdict.matching_ids
            named = [i for i in hindsight_ids if i in candidates]
            if hindsight_strong is None:
                detail = "Hindsight reasoned over the matching incidents; no structured verdict returned"
            elif hindsight_strong:
                detail = f"Hindsight sees a possible precedent: {', '.join(named) or 'unnamed incidents'}"
            else:
                detail = "Hindsight found no strong precedent for this failure"
        except MemoryUnavailable:
            reflect_text, reflect_ms, hindsight_strong, hindsight_ids = "", _ms(started), None, []
            detail = "Hindsight reflect unavailable; continuing with recall and the fix log"
        record_event("reflect", detail, hindsight_strong is not None or bool(reflect_text), None, incident_id)
        step, event = _step("reflect", detail, reflect_ms, {"hindsight_strong": hindsight_strong,
                                                            "hindsight_ids": hindsight_ids})
        steps.append(step)
        yield event

        # ------------------------------------------------ diagnosis
        llm_started = time.perf_counter()
        strong = is_strong_match(matched) and hindsight_strong is not False
        try:
            draft, model = await llm.format_diagnosis(
                incident.alert_text, parsed.service, parsed.signature, matched, attempts, recalled, reflect_text,
                hindsight_strong, hindsight_ids, candidates, findings)
            strong, citable = confirm_precedent(candidates, hindsight_strong, draft.strong_precedent, draft.precedent_ids)
            claims = verify_draft(draft, matched, attempt_index(attempts), strong, citable)
            if not strong and not claims.summary.startswith("No strong precedent"):
                claims.summary = f"No strong precedent in memory. {claims.summary}"
            diagnosis = Diagnosis(
                summary=claims.summary,
                confidence=claims.confidence,
                hypotheses=claims.hypotheses,
                try_first=claims.try_first,
                avoid=claims.avoid,
                cited_incidents=claims.cited_incidents,
                matched=matched,
                recalled=recalled,
                # A finding is only relevant if the incidents that make it relevant are a confirmed precedent.
                findings=[f for f in findings if set(f.related_incidents) & citable],
                unknowns=[u for u in (scrub_unverified(u, set(claims.cited_incidents)) for u in draft.unknowns) if u],
                project=project.name if project else None,
                strong_match=strong,
                memory_enabled=True,
                latency_ms=0,
            )
            verdict_text = "precedent confirmed" if strong else "no strong precedent"
            detail = (f"Formatted by {model.split('/')[-1]}; {verdict_text}; {len(claims.cited_incidents)} verified "
                      f"citations, {len(claims.avoid)} verified warnings")
        except LLMUnavailable:
            diagnosis = Diagnosis(
                summary=reflect_text or "Memory returned related incidents, but the diagnosis could not be formatted.",
                matched=matched,
                recalled=recalled,
                findings=findings if strong else [],
                project=project.name if project else None,
                strong_match=strong,
                memory_enabled=True,
                degraded=True,
                latency_ms=0,
            )
            detail = "Language model unavailable; showing the Hindsight reflect answer as text"
        step, event = _step("diagnosis", detail, _ms(llm_started))
        steps.append(step)
        yield event

        diagnosis.steps = steps
        diagnosis.latency_ms = _ms(started)
        final = _final(session, incident_id, diagnosis)
        # The alert is retained (asynchronously on the Hindsight side) after the first memory-on
        # investigation, not at creation, so the incident never recalls or reflects on itself.
        final["alert_retained"] = await _retain_alert_once(session, incident, memory, final["diagnosis_id"])
        yield final


async def _retain_alert_once(session: Session, incident: IncidentRow, memory: MemoryService, diagnosis_id: int) -> bool:
    earlier = session.exec(
        select(DiagnosisRow).where(DiagnosisRow.incident_id == incident.id, DiagnosisRow.memory_enabled == True,  # noqa: E712
                                   DiagnosisRow.id != diagnosis_id)
    ).first()
    if earlier is not None:
        return False
    try:
        await memory.retain_alert(IncidentFacts(
            id=incident.id, title=incident.title, service=incident.service, severity=incident.severity,
            started_at=from_db_time(incident.created_at) or utc_now(), alert_text=incident.alert_text,
            on_call=incident.on_call,
        ))
    except MemoryUnavailable:
        record_event("retain", f"alert for {incident.id}", False, None, incident.id)
        return False
    record_event("retain", f"alert for {incident.id} (background)", True, 1, incident.id)
    return True


def _history_text(session: Session, incident_ids: list[str], attempts: dict[str, list[AttemptFacts]]) -> dict[str, str]:
    """Fix, root cause and attempt text for each incident, the source of the identifiers the finder looks for."""
    history: dict[str, str] = {}
    for iid in incident_ids:
        row = session.get(IncidentRow, iid)
        parts = [row.fix or "", row.root_cause or "", row.summary or ""] if row else []
        parts += [f"{a.action}. {a.notes or ''}" for a in attempts.get(iid, [])]
        history[iid] = " ".join(parts)
    return history
