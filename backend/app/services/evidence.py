"""Deterministic evidence step: alert parsing, incident matching and verification of LLM claims.

Nothing here calls an LLM or the network. The rule from CLAUDE.md section 8 is enforced in
verify_draft: an incident ID survives only if recall matched it, and a Try First or Avoid
evidence reference survives only if it points at a real attempt with the right outcome.
"""

import re
from dataclasses import dataclass
from datetime import datetime

from app.models import (
    AttemptFacts,
    AvoidFix,
    DiagnosisDraft,
    FixRecord,
    FixSuggestion,
    Hypothesis,
    MatchedIncident,
    RecalledMemory,
)

SERVICES = ("payments-api", "checkout-web", "ledger-worker", "notifications-svc", "auth-service", "search-api")
STRONG_MATCH = 0.85  # measured: family matches score 0.88-0.99, the unrelated DEMO-C best is 0.70
CITE_FLOOR = 0.75  # incidents below this relevance are shown in the panel but never cited as evidence
WEAK_CONFIDENCE_CAP = 0.4
MAX_MATCHED = 6

INCIDENT_ID = re.compile(r"\bINC-\d{3,}\b")
SEVERITY_PATTERN = re.compile(r"\bSEV\s?-?([123])\b", re.IGNORECASE)
SIGNATURE_PATTERN = re.compile(r"(?:log|client error|browser console|sentry|api|cdn log|event):\s*(.+)", re.IGNORECASE)
ERROR_WORDS = re.compile(r"(Error|Exception|OOMKilled|x509|429|502|timeout)", re.IGNORECASE)
EXCEPTION = re.compile(r"\b[\w.]*(?:Error|Exception)\b:")
LOG_PREFIX = re.compile(r"^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?\s+(?:ERROR|WARN(?:ING)?|INFO|FATAL|CRITICAL)?\s*")


@dataclass(frozen=True)
class ParsedAlert:
    service: str
    severity: str
    signature: str


@dataclass(frozen=True)
class KnownIncident:
    title: str
    service: str
    occurred_at: datetime | None
    live: bool = False  # resolved in the app rather than seeded


def parse_alert(alert_text: str, service_hint: str | None = None, severity_hint: str | None = None) -> ParsedAlert:
    service = service_hint or next((s for s in SERVICES if s in alert_text), "unknown-service")
    severity = severity_hint
    if severity is None:
        match = SEVERITY_PATTERN.search(alert_text)
        severity = f"SEV{match.group(1)}" if match else "SEV2"
    signature = ""
    for line in alert_text.splitlines():
        match = SIGNATURE_PATTERN.search(line)
        if match:
            signature = match.group(1).strip()
            break
    if not signature:
        signature = next((line.strip() for line in alert_text.splitlines()
                          if EXCEPTION.search(line) and not line.lstrip().startswith(("File ", "raise ", "at "))), "")
    if not signature:
        signature = next((line.strip() for line in alert_text.splitlines() if ERROR_WORDS.search(line)), "")
    if not signature:
        signature = alert_text.strip().splitlines()[0] if alert_text.strip() else ""
    # Raw log lines: drop the timestamp and level, and keep the exception onwards when there is one.
    signature = LOG_PREFIX.sub("", signature)
    exception = EXCEPTION.search(signature)
    if exception:
        signature = signature[exception.start():]
    return ParsedAlert(service=service, severity=severity.upper(), signature=signature[:200])


def matched_incidents(recalled: list[RecalledMemory], known: dict[str, KnownIncident],
                      exclude_id: str | None) -> list[MatchedIncident]:
    """Group recalled memories by incident and keep each incident's best Hindsight relevance."""
    best: dict[str, float] = {}
    for memory in recalled:
        iid = memory.incident_id
        if not iid or iid == exclude_id or iid not in known or memory.relevance is None:
            continue
        best[iid] = max(best.get(iid, 0.0), memory.relevance)
    ranked = sorted(best.items(), key=lambda item: item[1], reverse=True)[:MAX_MATCHED]
    return [
        MatchedIncident(
            id=iid,
            title=known[iid].title,
            service=known[iid].service,
            relevance=round(score, 4),
            occurred_at=known[iid].occurred_at,
            learned_live=known[iid].live,
        )
        for iid, score in ranked
    ]


def is_strong_match(matched: list[MatchedIncident]) -> bool:
    """Relevance-only rule, used when Hindsight's reflect verdict is unavailable."""
    return bool(matched) and matched[0].relevance >= STRONG_MATCH


def cite_candidates(matched: list[MatchedIncident]) -> set[str]:
    return {m.id for m in matched if m.relevance >= CITE_FLOOR}


def confirm_precedent(candidates: set[str], hindsight_strong: bool | None, llm_strong: bool,
                      llm_ids: list[str]) -> tuple[bool, set[str]]:
    """Decide whether a real precedent exists. Returns (strong_match, citable incident IDs).

    Relevance alone is noisy (one stray memory scored 0.94 for an unrelated alert) and each model's
    verdict alone varied between runs, so a precedent needs agreement: Hindsight's reflect verdict must
    not be negative, the formatter must judge the failure mechanism the same, and it must name at
    least one relevant incident. Without a precedent nothing is citable, so nothing is claimed.
    """
    named = candidates & set(llm_ids)
    strong = hindsight_strong is not False and llm_strong and bool(named)
    return strong, (candidates if strong else set())


def fix_records(attempts_by_incident: dict[str, list[AttemptFacts]], incident_ids: list[str]) -> tuple[list[FixRecord], list[FixRecord]]:
    """What worked and what failed across the given recalled incidents, in recall order, exact duplicates removed."""
    worked: list[FixRecord] = []
    failed: list[FixRecord] = []
    for iid in incident_ids:
        for attempt in attempts_by_incident.get(iid, []):
            target = worked if attempt.outcome == "worked" else failed if attempt.outcome == "failed" else None
            if target is None or any(r.incident_id == iid and r.action == attempt.action for r in target):
                continue
            target.append(FixRecord(action=attempt.action, incident_id=iid, outcome=attempt.outcome, notes=attempt.notes))
    return worked, failed


def attempt_index(attempts_by_incident: dict[str, list[AttemptFacts]]) -> dict[str, tuple[str, AttemptFacts]]:
    """Stable references such as INC-030#1 for every attempt the LLM is allowed to cite."""
    index: dict[str, tuple[str, AttemptFacts]] = {}
    for iid, attempts in attempts_by_incident.items():
        for position, attempt in enumerate(attempts, start=1):
            index[f"{iid}#{position}"] = (iid, attempt)
    return index


def _verified_ids(refs: list[str], index: dict[str, tuple[str, AttemptFacts]], outcome: str) -> list[str]:
    ids: list[str] = []
    for ref in refs:
        entry = index.get(ref.strip())
        if entry and entry[1].outcome == outcome and entry[0] not in ids:
            ids.append(entry[0])
    return ids


SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


def scrub_unverified(text: str, allowed: set[str]) -> str:
    """Drop every sentence that names an incident outside the verified set (no citation, no claim)."""
    kept = [s for s in SENTENCE_SPLIT.split(text.strip())
            if all(iid in allowed for iid in INCIDENT_ID.findall(s))]
    return " ".join(kept).strip()


def scrub_unverified_lines(text: str, allowed: set[str]) -> str:
    """scrub_unverified per line, so markdown headings and bullets keep their structure."""
    lines: list[str] = []
    for line in text.splitlines():
        if not line.strip():
            if lines and lines[-1] != "":
                lines.append("")
            continue
        indent = line[: len(line) - len(line.lstrip())]
        kept = scrub_unverified(line, allowed)
        if kept and kept.strip("*#-_ ") != "":
            lines.append(indent + kept)
    return "\n".join(lines).strip()


@dataclass
class VerifiedClaims:
    summary: str
    confidence: float
    hypotheses: list[Hypothesis]
    try_first: FixSuggestion | None
    avoid: list[AvoidFix]
    cited_incidents: list[str]


def verify_draft(draft: DiagnosisDraft, matched: list[MatchedIncident],
                 index: dict[str, tuple[str, AttemptFacts]], strong_match: bool,
                 citable: set[str] | None = None) -> VerifiedClaims:
    matched_ids = citable if citable is not None else {m.id for m in matched if m.relevance >= CITE_FLOOR}

    hypotheses = [
        Hypothesis(cause=h.cause, confidence=h.confidence, evidence=[i for i in h.evidence if i in matched_ids])
        for h in draft.hypotheses
    ]
    hypotheses = [h for h in hypotheses if h.evidence]

    try_first: FixSuggestion | None = None
    if draft.try_first:
        worked = [i for i in _verified_ids(draft.try_first.attempt_refs, index, "worked") if i in matched_ids]
        if worked:
            try_first = FixSuggestion(action=draft.try_first.action, source=worked[0], evidence=worked)

    avoid: list[AvoidFix] = []
    for item in draft.avoid:
        failed = [i for i in _verified_ids(item.attempt_refs, index, "failed") if i in matched_ids]
        if failed:
            why = scrub_unverified(item.why, set(failed)) or f"Failed in {', '.join(failed)}."
            avoid.append(AvoidFix(action=item.action, why=why, evidence=failed))

    cited: list[str] = []
    for ids in [h.evidence for h in hypotheses] + [try_first.evidence if try_first else []] + [a.evidence for a in avoid]:
        for iid in ids:
            if iid not in cited:
                cited.append(iid)
    order = {m.id: pos for pos, m in enumerate(matched)}
    cited.sort(key=lambda iid: order.get(iid, len(order)))

    confidence = draft.confidence if strong_match else min(draft.confidence, WEAK_CONFIDENCE_CAP)
    if not cited:
        confidence = min(confidence, WEAK_CONFIDENCE_CAP)
    return VerifiedClaims(
        summary=scrub_unverified(draft.summary, set(cited)),
        confidence=round(confidence, 2),
        hypotheses=hypotheses,
        try_first=try_first,
        avoid=avoid,
        cited_incidents=cited,
    )


def strip_incident_ids(text: str) -> str:
    """Memory-off answers must not mention incident IDs."""
    return INCIDENT_ID.sub("a past incident", text)
