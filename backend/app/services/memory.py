"""Hindsight memory layer. This is the only module that imports hindsight_client.

Every memory follows CLAUDE.md section 6.2: document_id is the incident ID, timestamp is the
real event time, context is one of alert / fix-attempt / postmortem / runbook, and metadata
carries service, severity and (for fix attempts) outcome. Content is written as plain
sentences so Hindsight can extract facts from it.
"""

import logging
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from hindsight_client import Hindsight, RecallResult

from app.config import Settings, get_settings
from app.models import AttemptFacts, IncidentFacts, PostmortemFacts, RecalledMemory
from app.services.redaction import redact

logger = logging.getLogger(__name__)

BANK_NAME = "Nimbus On-Call Memory"
BANK_MISSION = (
    "I am the on-call memory for Nimbus Pay. I track production incidents, their root causes, "
    "the fixes that worked, and the fixes that failed. I help on-call engineers diagnose new "
    "incidents quickly by recalling similar past incidents."
)
BANK_DISPOSITION = {"skepticism": 4, "literalism": 3, "empathy": 2}
DIRECTIVES: list[tuple[str, str]] = [
    ("cite-incident-ids", "Always cite incident IDs (for example, INC-030) for every claim."),
    ("warn-failed-fixes", "Always warn when a proposed fix failed in a past incident, and name that incident."),
    ("rollback-for-destructive", "Never suggest a destructive command without a rollback step."),
    ("no-strong-match", "If no past incident is a strong match, say so plainly instead of guessing."),
]
DIAGNOSE_QUERY = (
    "Diagnose this incident. Give the likely root cause, the fix to try first, and any fixes "
    "that failed in similar past incidents. Cite incident IDs."
)
RECALL_TYPES = ["world", "experience", "observation"]
VERDICT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "strong_precedent": {
            "type": "boolean",
            "description": "true only if at least one past incident had the same failure mode, not just the same service",
        },
        "matching_incident_ids": {
            "type": "array",
            "items": {"type": "string"},
            "description": "past incident IDs with the same failure mode; empty when there is no strong precedent",
        },
    },
    "required": ["strong_precedent", "matching_incident_ids"],
}


@dataclass(frozen=True)
class Observation:
    text: str
    incident_ids: list[str]
    proof_count: int
    updated_at: datetime | None


@dataclass(frozen=True)
class ReflectVerdict:
    text: str
    strong_precedent: bool | None  # None when Hindsight returned no structured output
    matching_ids: list[str]


def parse_verdict(text: str | None, structured: dict[str, Any] | None) -> ReflectVerdict:
    strong: bool | None = None
    ids: list[str] = []
    if isinstance(structured, dict):
        value = structured.get("strong_precedent")
        strong = value if isinstance(value, bool) else None
        raw_ids = structured.get("matching_incident_ids")
        if isinstance(raw_ids, list):
            ids = [i for i in (str(x).strip() for x in raw_ids) if INCIDENT_ID_PATTERN.fullmatch(i)]
    return ReflectVerdict(text=text or "", strong_precedent=strong, matching_ids=ids)

MemoryContext = Literal["alert", "fix-attempt", "postmortem", "runbook"]
INCIDENT_ID_PATTERN = re.compile(r"\bINC-\d{3,}\b")
OUTCOME_WORDS = {"worked": "WORKED", "failed": "FAILED", "partial": "PARTIALLY WORKED"}


class MemoryUnavailable(Exception):
    """Hindsight could not be reached or returned an error. Callers turn this into a readable UI state."""


# ---------------------------------------------------------------- pure formatting helpers


def human_date(moment: datetime) -> str:
    return f"{moment.day} {moment.strftime('%B %Y')}"


def human_time(moment: datetime) -> str:
    if moment.tzinfo is None:
        return moment.strftime("%H:%M")
    return moment.strftime("%H:%M UTC%z")


def format_alert_memory(incident: IncidentFacts) -> str:
    return (
        f"{incident.id} was opened on {human_date(incident.started_at)} at {human_time(incident.started_at)}: "
        f"{incident.severity} alert on {incident.service}, \"{incident.title}\". "
        f"The alert and log excerpt were:\n{incident.alert_text}"
    )


def format_attempt_memory(incident: IncidentFacts, attempt: AttemptFacts) -> str:
    when = attempt.created_at or incident.started_at
    sentence = (
        f"During {incident.id} on {incident.service} ({human_date(when)}), the on-call engineer tried: "
        f"{attempt.action}. Outcome: {OUTCOME_WORDS[attempt.outcome]}."
    )
    if attempt.notes:
        sentence += f" {attempt.notes}"
    return sentence


def format_postmortem_memory(incident: IncidentFacts, postmortem: PostmortemFacts) -> str:
    resolved = incident.resolved_at or incident.started_at
    lines = [
        f"Postmortem for {incident.id} ({incident.severity}, {incident.service}, {human_date(incident.started_at)}, "
        f"on-call {incident.on_call or 'unknown'}): {incident.title}.",
        f"Alert signature for {incident.id}:\n{incident.alert_text}",
        f"Summary of {incident.id}: {postmortem.summary}",
        f"Root cause of {incident.id}: {postmortem.root_cause}",
    ]
    for attempt in postmortem.attempts:
        line = f"Fix attempt in {incident.id}: {attempt.action}. Outcome: {OUTCOME_WORDS[attempt.outcome]}."
        if attempt.notes:
            line += f" {attempt.notes}"
        lines.append(line)
    lines.append(f"Fix that resolved {incident.id}: {postmortem.fix}")
    lines.append(
        f"{incident.id} was resolved on {human_date(resolved)} after {postmortem.ttr_minutes} minutes."
    )
    if postmortem.follow_ups:
        lines.append(f"Follow-ups from {incident.id}: " + " ".join(postmortem.follow_ups))
    return "\n".join(lines)


def extract_incident_id(document_id: str | None, text: str) -> str | None:
    if document_id and INCIDENT_ID_PATTERN.fullmatch(document_id):
        return document_id
    match = INCIDENT_ID_PATTERN.search(text)
    if match:
        return match.group(0)
    return None


def parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def to_recalled_memory(result: RecallResult) -> RecalledMemory:
    return RecalledMemory(
        text=result.text,
        type=result.type or "world",
        incident_id=extract_incident_id(result.document_id, result.text),
        occurred_at=parse_timestamp(result.occurred_start) or parse_timestamp(result.mentioned_at),
        relevance=_relevance(result),
    )


def _relevance(result: RecallResult) -> float | None:
    """Hindsight's reranker score clamped to 0..1; None when the server did not rerank."""
    if result.scores is None or result.scores.reranker is None:
        return None
    return max(0.0, min(1.0, float(result.scores.reranker)))


def metadata_for(incident: IncidentFacts, outcome: str | None = None) -> dict[str, str]:
    metadata = {"service": incident.service, "severity": incident.severity}
    if outcome is not None:
        metadata["outcome"] = outcome
    return metadata


def postmortem_item(incident: IncidentFacts, postmortem: PostmortemFacts) -> dict[str, Any]:
    """One retain_batch item for a resolved incident."""
    return {
        "content": format_postmortem_memory(incident, postmortem),
        "timestamp": incident.resolved_at or incident.started_at,
        "context": "postmortem",
        "document_id": incident.id,
        "metadata": metadata_for(incident),
    }


# ---------------------------------------------------------------- service


class MemoryService:
    def __init__(self, settings: Settings | None = None, timeout: float = 30.0) -> None:
        self.settings = settings or get_settings()
        self.bank_id = self.settings.HINDSIGHT_BANK_ID
        self.client = Hindsight(
            base_url=self.settings.HINDSIGHT_BASE_URL,
            api_key=self.settings.HINDSIGHT_API_KEY,
            timeout=timeout,
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def ensure_bank(self) -> None:
        """Create or update the bank profile and make sure every directive exists."""
        try:
            await self.client.acreate_bank(
                self.bank_id,
                name=BANK_NAME,
                mission=BANK_MISSION,
                disposition_skepticism=BANK_DISPOSITION["skepticism"],
                disposition_literalism=BANK_DISPOSITION["literalism"],
                disposition_empathy=BANK_DISPOSITION["empathy"],
                enable_observations=True,
            )
            existing = await self.client.alist_directives(self.bank_id)
            existing_names = {directive.name for directive in existing.items}
            for name, content in DIRECTIVES:
                if name not in existing_names:
                    await self.client.acreate_directive(self.bank_id, name=name, content=content)
        except Exception as exc:
            raise _unavailable("ensure_bank", exc) from exc

    async def _retain(self, incident: IncidentFacts, content: str, context: MemoryContext,
                      timestamp: datetime, outcome: str | None = None, background: bool = False) -> None:
        try:
            await self.client.aretain(
                self.bank_id,
                redact(content),
                timestamp=timestamp,
                context=context,
                document_id=incident.id,
                metadata=metadata_for(incident, outcome),
                update_mode="append",
                retain_async=background,
            )
        except Exception as exc:
            raise _unavailable(f"retain {context}", exc) from exc

    async def retain_alert(self, incident: IncidentFacts) -> None:
        # Background retain: the alert is only context, and the diagnosis stream should not wait for extraction.
        await self._retain(incident, format_alert_memory(incident), "alert", incident.started_at, background=True)

    async def retain_attempt(self, incident: IncidentFacts, attempt: AttemptFacts) -> None:
        # Background retain keeps the one-click outcome buttons fast; the postmortem repeats every attempt.
        await self._retain(
            incident,
            format_attempt_memory(incident, attempt),
            "fix-attempt",
            attempt.created_at or incident.started_at,
            outcome=attempt.outcome,
            background=True,
        )

    async def retain_postmortem(self, incident: IncidentFacts, postmortem: PostmortemFacts) -> str:
        """Synchronous retain, so the very next diagnosis can recall what was learned. Returns the retained text."""
        text = redact(format_postmortem_memory(incident, postmortem))
        await self._retain(incident, text, "postmortem", incident.resolved_at or incident.started_at)
        return text

    async def retain_postmortem_batch(self, items: list[dict[str, Any]]) -> int:
        try:
            response = await self.client.aretain_batch(self.bank_id, items, retain_async=False)
        except Exception as exc:
            raise _unavailable("retain_batch", exc) from exc
        return response.items_count

    async def recall_similar(self, alert_text: str, service: str) -> list[RecalledMemory]:
        try:
            response = await self.client.arecall(
                self.bank_id,
                query=f"{service}: {alert_text}" if service else alert_text,
                types=RECALL_TYPES,
                budget="mid",
                max_tokens=4096,
                include_chunks=True,
            )
        except Exception as exc:
            raise _unavailable("recall", exc) from exc
        return [to_recalled_memory(result) for result in response.results]

    async def reflect_diagnosis(self, alert_text: str, service: str, budget: str = "mid") -> ReflectVerdict:
        """Free-text reasoning plus Hindsight's own structured verdict on whether a real precedent exists."""
        try:
            response = await self.client.areflect(
                self.bank_id,
                query=DIAGNOSE_QUERY,
                context=f"Service: {service}\nAlert:\n{alert_text}",
                budget=budget,
                response_schema=VERDICT_SCHEMA,
            )
        except Exception as exc:
            raise _unavailable("reflect", exc) from exc
        return parse_verdict(response.text, response.structured_output)

    async def reflect_free(self, query: str, budget: str = "mid") -> str:
        try:
            response = await self.client.areflect(self.bank_id, query=query, budget=budget)
        except Exception as exc:
            raise _unavailable("reflect", exc) from exc
        return response.text

    async def list_observations(self, limit: int = 200) -> list[Observation]:
        """Observations Hindsight consolidated on its own from the retained memories."""
        try:
            response = await self.client.alist_memories(self.bank_id, type="observation", limit=limit)
        except Exception as exc:
            raise _unavailable("list_memories observation", exc) from exc
        return [
            Observation(
                text=item.text or "",
                incident_ids=sorted(set(INCIDENT_ID_PATTERN.findall(item.text or ""))),
                proof_count=item.proof_count or 1,
                updated_at=parse_timestamp(item.updated_at),
            )
            for item in response.items
            if item.text and (item.state in (None, "valid"))
        ]

    async def document_ids(self) -> set[str]:
        """Every document ID in the bank (one per incident), used to seed without duplicating."""
        ids: set[str] = set()
        offset = 0
        try:
            while True:
                page = await self.client.documents.list_documents(self.bank_id, limit=200, offset=offset)
                ids.update(item.id for item in page.items)
                offset += len(page.items)
                if not page.items or offset >= page.total:
                    return ids
        except Exception as exc:
            if "404" in str(exc) or "not found" in str(exc).lower():
                return ids  # the bank does not exist yet, so nothing is seeded
            raise _unavailable("list_documents", exc) from exc

    async def memory_count(self) -> int:
        try:
            response = await self.client.alist_memories(self.bank_id, limit=1)
        except Exception as exc:
            raise _unavailable("list_memories", exc) from exc
        return response.total

    async def observation_count(self) -> int:
        try:
            response = await self.client.alist_memories(self.bank_id, type="observation", limit=1)
        except Exception as exc:
            raise _unavailable("list_memories observation", exc) from exc
        return response.total

    async def delete_bank(self) -> None:
        try:
            await self.client.adelete_bank(self.bank_id)
        except Exception as exc:
            raise _unavailable("delete_bank", exc) from exc


def _unavailable(operation: str, exc: Exception) -> MemoryUnavailable:
    logger.warning("Hindsight %s failed: %s: %s", operation, type(exc).__name__, exc)
    return MemoryUnavailable(f"Memory is unavailable ({operation} failed). Try again in a moment.")
