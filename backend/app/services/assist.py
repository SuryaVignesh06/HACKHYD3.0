"""FRIDAY's grounded answer to a question about what the engineer is looking at.

Pipeline: understand the question -> read the current context (screen text or open incident) -> Hindsight recall
(with reflect started concurrently) -> the fix log of the recalled incidents -> inspect the authorized project ->
the LLM writes the answer from that evidence only -> every incident ID and sentence is verified.

Facts are kept apart by source: SCREEN / INCIDENT and PROJECT items are built here, deterministically, from what was
read; HINDSIGHT items are the LLM's one-line summaries of experiences, kept only for incidents recall returned with
citable relevance. The LLM never supplies knowledge of its own.
"""

import asyncio
import logging
import re
import time

from sqlmodel import Session, select

from app.db import from_db_time, record_event
from app.models import (
    AssistAnswer,
    AssistIntent,
    AssistRequest,
    AttemptFacts,
    AttemptRow,
    CodeFinding,
    EvidenceItem,
    IncidentRow,
    MatchedIncident,
    PastIncident,
    ProjectRow,
)
from app.services.diagnosis import _attempts_for, _history_text, _known_incidents
from app.services.evidence import (
    INCIDENT_ID,
    cite_candidates,
    fix_records,
    matched_incidents,
    parse_alert,
    scrub_unverified,
    scrub_unverified_lines,
)
from app.services.llm import LLMService, LLMUnavailable
from app.services.memory import MemoryService, MemoryUnavailable
from app.services.project_context import ProjectAccessError, find_findings, validate_root
from app.services.redaction import redact

logger = logging.getLogger("oncall.agent")

NO_MATCH = "No previous engineering experience matched this problem."
MAX_CONTEXT_CHARS = 2500
MAX_SCREEN_FACTS = 3
MAX_HISTORY = 3
MAX_MATCHED_ASSIST = 10
REFLECT_QUERY = ("{question}\n\nThe engineer is looking at this right now:\n{context}\n\n"
                 "From the team's past incidents only: which experiences match, what was the root cause, which fixes worked "
                 "and which failed, and what lesson applies. Name the incident IDs. If nothing matches, say so plainly.")

INTENTS: list[tuple[AssistIntent, re.Pattern[str]]] = [
    ("why_not", re.compile(r"\bwhy\b.*\b(not|shouldn'?t|don'?t|avoid|didn'?t)\b", re.I)),
    ("location", re.compile(r"\bwhere\b|\bwhich file\b|\bwhat file\b|\bwhich line\b", re.I)),
    ("previous_fix", re.compile(r"\b(what|how) did (we|you|they)\b|\blast time\b|\btried before\b|\bwhat (have|has) (we|been) tried\b", re.I)),
    ("history", re.compile(r"\b(happened|seen|occurred)\b.*\b(before|previously|earlier)\b|\bbefore\?|\bhistory\b", re.I)),
    ("exact_change", re.compile(r"\bexact(ly)?\b|\bwhat (should|do) i change\b|\bwhich value\b|\bwhat value\b", re.I)),
    ("cause", re.compile(r"\bcaus(e|ing)\b|\bwhat('?s| is) wrong\b|\bwhy\b|\broot\b|\bwhat should i do\b|\bfix\b", re.I)),
]


def understand(question: str) -> AssistIntent:
    """What kind of question this is; it shapes which evidence the answer leads with."""
    for intent, pattern in INTENTS:
        if pattern.search(question):
            return intent
    return "general"


def screen_facts(screen_text: str) -> list[str]:
    """The error lines exactly as read from the screen (already OCR-cleaned by the desktop app), most important first."""
    lines = [line.strip() for line in screen_text.splitlines() if line.strip()]
    signature = parse_alert(screen_text).signature
    facts: list[str] = [signature] if signature else []
    for line in lines:
        if len(facts) >= MAX_SCREEN_FACTS:
            break
        if line != signature and signature not in line and not line.startswith(("File ", "at ", "raise ")):
            facts.append(line[:220])
    return facts


def project_facts(findings: list[CodeFinding]) -> list[EvidenceItem]:
    items: list[EvidenceItem] = []
    for f in findings:
        value = f" = {f.current_value}" if f.current_value is not None else ""
        items.append(EvidenceItem(source="PROJECT", text=f"{f.identifier}{value} in {f.path}, line {f.line}",
                                  location=f"{f.path}:{f.line}"))
    return items


def build_prompt(question: str, intent: AssistIntent, context_label: str, context: str, matched: list[MatchedIncident],
                 citable: set[str], attempts: dict[str, list[AttemptFacts]], findings: list[CodeFinding],
                 project_line: str, reflect_text: str) -> str:
    lines = [f"QUESTION ({intent}): {question}", "", f"CURRENT CONTEXT ({context_label}):", context or "  none", ""]
    lines.append("MATCHED EXPERIENCES (id | relevance | citable | date | service | title):")
    for m in matched:
        date = m.occurred_at.date().isoformat() if m.occurred_at else "unknown date"
        lines.append(f"  {m.id} | {m.relevance:.2f} | {'citable' if m.id in citable else 'NOT citable'} | {date} | {m.service} | {m.title}")
    if not matched:
        lines.append("  none")
    lines += ["", "FIX LOG (incident | outcome | action | notes):"]
    logged = False
    for m in matched:
        if m.id not in citable:
            continue
        for attempt in attempts.get(m.id, []):
            logged = True
            notes = f" | {attempt.notes}" if attempt.notes else ""
            lines.append(f"  {m.id} | {attempt.outcome.upper()} | {attempt.action}{notes}")
    if not logged:
        lines.append("  none")
    lines += ["", f"PROJECT FINDINGS ({project_line}):"]
    for f in findings:
        value = f" = {f.current_value}" if f.current_value is not None else ""
        history = f" | past changes: {'; '.join(f.history)}" if f.history else ""
        lines.append(f"  {f.path}:{f.line} | {f.identifier}{value}{history}")
    if not findings:
        lines.append("  none")
    lines += ["", f"HINDSIGHT REFLECTION:\n{reflect_text[:5000] or 'unavailable'}"]
    return "\n".join(lines)


def _past_incidents(session: Session, matched: list[MatchedIncident], ids: list[str]) -> list[PastIncident]:
    rows = {row.id: row for row in session.exec(select(IncidentRow).where(IncidentRow.id.in_(ids))).all()} if ids else {}  # type: ignore[attr-defined]
    attempts: dict[str, list[AttemptRow]] = {iid: [] for iid in ids}
    if ids:
        for a in session.exec(select(AttemptRow).where(AttemptRow.incident_id.in_(ids)).order_by(AttemptRow.id)).all():  # type: ignore[attr-defined]
            attempts[a.incident_id].append(a)
    relevance = {m.id: m.relevance for m in matched}
    return [
        PastIncident(
            id=iid, title=rows[iid].title, service=rows[iid].service, occurred_at=from_db_time(rows[iid].created_at),
            relevance=relevance.get(iid), learned_live=rows[iid].source == "live" and rows[iid].status == "resolved",
            root_cause=rows[iid].root_cause, fix=rows[iid].fix,
            worked=[a.action for a in attempts[iid] if a.outcome == "worked"],
            failed=[a.action for a in attempts[iid] if a.outcome == "failed"],
        )
        for iid in ids
        if iid in rows
    ]


async def answer(body: AssistRequest, session: Session, memory: MemoryService, llm: LLMService) -> AssistAnswer:
    started = time.perf_counter()
    question = body.question.strip()
    intent = understand(question)

    # 1. The current context: what is on screen, and the open incident when there is one.
    incident = session.get(IncidentRow, body.incident_id) if body.incident_id else None
    screen = redact(body.screen_text.strip())[:MAX_CONTEXT_CHARS] if body.screen_text and body.screen_text.strip() else ""
    parts = [screen] if screen else []
    if incident and incident.alert_text.strip() not in screen:
        parts.append(incident.alert_text.strip()[:MAX_CONTEXT_CHARS])
    context = "\n".join(parts)
    context_label = "screen" if screen else f"incident {incident.id}" if incident else "none"
    parsed = parse_alert(context or question, incident.service if incident else None)
    service = parsed.service if parsed.service != "unknown-service" else ""

    current: list[EvidenceItem] = [EvidenceItem(source="SCREEN", text=fact) for fact in screen_facts(screen)] if screen else []
    if incident:
        current.append(EvidenceItem(source="INCIDENT", text=f"{incident.id}: {incident.title}", incident_id=incident.id))

    # 2. Search memory with the question and what the engineer is looking at, not a bare keyword.
    query = "\n".join(p for p in [question, parsed.signature if context else "", context[:1200]] if p)
    logger.info("[RECALL] assist (%s): %r", intent, question[:120])
    reflect_task = asyncio.create_task(memory.reflect_free(
        REFLECT_QUERY.format(question=question, context=context[:1500] or "(nothing captured)"), budget="low"))
    memory_unavailable = False
    matched: list[MatchedIncident] = []
    try:
        recalled = await memory.recall_similar(query, service)
        record_event("recall", f"assist: {question[:100]}", True, len(recalled), incident.id if incident else None)
        # A question can be about any of the related experiences, so it looks wider than a diagnosis does.
        matched = matched_incidents(recalled, _known_incidents(session), exclude_id=incident.id if incident else None,
                                    limit=MAX_MATCHED_ASSIST)
    except MemoryUnavailable:
        reflect_task.cancel()
        memory_unavailable = True
        record_event("recall", f"assist: {question[:100]}", False, None, incident.id if incident else None)
    citable = cite_candidates(matched)
    citable_ids = [m.id for m in matched if m.id in citable]
    attempts = _attempts_for(session, citable_ids)
    worked, failed = fix_records(attempts, citable_ids)

    # 3. Inspect the authorized project for the settings those experiences changed.
    project = session.get(ProjectRow, body.project_id) if body.project_id else (
        session.get(ProjectRow, incident.project_id) if incident and incident.project_id else None)
    findings: list[CodeFinding] = []
    project_error: str | None = None
    if project is None:
        project_line = "no project connected"
    else:
        try:
            root = validate_root(project.root_path)
            if citable_ids:
                findings = await asyncio.to_thread(find_findings, root, _history_text(session, citable_ids, attempts))
            project_line = f"read from {project.name} just now"
        except ProjectAccessError as exc:
            project_error = f"FRIDAY couldn't access the project: {exc}"
            project_line = "project unavailable"

    # 4. Hindsight's reasoning across the experiences.
    reflect_text = ""
    if not memory_unavailable:
        try:
            reflect_text = scrub_unverified_lines(await reflect_task, citable)
            record_event("reflect", f"assist: {question[:100]}", True, None, incident.id if incident else None)
        except MemoryUnavailable:
            record_event("reflect", f"assist: {question[:100]}", False, None, incident.id if incident else None)

    # 5. The answer, from that evidence only, then verified.
    degraded = False
    history: list[EvidenceItem] = []
    recommendation: str | None = None
    next_step: str | None = None
    prompt = build_prompt(question, intent, context_label, context, matched, citable, attempts, findings, project_line, reflect_text)
    try:
        draft, model = await llm.answer_question(prompt)
        text = scrub_unverified(draft.answer, citable)
        recommendation = scrub_unverified(draft.recommendation, citable) or None if draft.recommendation else None
        next_step = scrub_unverified(draft.next_step, citable) or None if draft.next_step else None
        for item in draft.history[:MAX_HISTORY]:
            summary = scrub_unverified(item.text, citable)
            if item.incident_id in citable and summary:
                history.append(EvidenceItem(source="HINDSIGHT", text=summary, incident_id=item.incident_id))
        logger.info("[ANSWER] assist answered by %s: %d experiences, %d findings", model.split("/")[-1], len(history), len(findings))
    except LLMUnavailable:
        degraded = True
        text = reflect_text or ""
        logger.warning("[ANSWER] assist: language model unavailable; returning Hindsight's reasoning as text")

    no_match = not citable
    if memory_unavailable:
        text = "FRIDAY memory is unavailable, so no past experience was used. " + (text or "Nothing was recalled rather than guessed.")
    elif no_match and not text.startswith(NO_MATCH):
        text = f"{NO_MATCH} {text}".strip()
    if not text:
        text = "The answer could not be written right now; the evidence FRIDAY found is below."
    if no_match:
        history = []

    named = [iid for iid in dict.fromkeys(INCIDENT_ID.findall(" ".join([text, recommendation or ""] + [h.text for h in history])))
             if iid in citable]
    shown = list(dict.fromkeys([h.incident_id for h in history if h.incident_id] + named + citable_ids))[:4]
    return AssistAnswer(
        question=question, intent=intent, answer=text, recommendation=recommendation, next_step=next_step,
        current=current + project_facts(findings), history=history,
        worked=worked, failed=failed, findings=findings,
        incidents=_past_incidents(session, matched, shown), screen_used=bool(screen),
        project=project.name if project else None, project_error=project_error, memory_unavailable=memory_unavailable,
        no_match=no_match, degraded=degraded, latency_ms=int((time.perf_counter() - started) * 1000),
    )
