"""Unit tests for the memory formatting and mapping helpers. No network access."""

from datetime import datetime, timedelta, timezone

from hindsight_client import RecallResult

from app.dataset import load_history
from app.models import AttemptFacts, IncidentFacts, PostmortemFacts
from app.services.memory import (
    extract_incident_id,
    format_alert_memory,
    format_attempt_memory,
    format_postmortem_memory,
    metadata_for,
    parse_verdict,
    postmortem_item,
    to_recalled_memory,
)

IST = timezone(timedelta(hours=5, minutes=30))
INCIDENT = IncidentFacts(
    id="INC-046",
    title="payments-api p99 at 4.2 s",
    service="payments-api",
    severity="SEV1",
    started_at=datetime(2026, 9, 28, 2, 40, tzinfo=IST),
    resolved_at=datetime(2026, 9, 28, 3, 25, tzinfo=IST),
    alert_text="log: redis.exceptions.ConnectionError: Too many connections",
    on_call="Priya Nair",
)


def test_alert_memory_names_id_service_date_and_signature() -> None:
    text = format_alert_memory(INCIDENT)
    assert "INC-046" in text
    assert "payments-api" in text
    assert "28 September 2026" in text
    assert "Too many connections" in text


def test_attempt_memory_states_outcome_in_words() -> None:
    attempt = AttemptFacts(action="Restarted payments-api pods", outcome="failed", notes="Latency back in 8 minutes.")
    text = format_attempt_memory(INCIDENT, attempt)
    assert text.startswith("During INC-046 on payments-api (28 September 2026)")
    assert "Outcome: FAILED." in text
    assert text.endswith("Latency back in 8 minutes.")


def test_postmortem_memory_includes_every_attempt_and_the_fix() -> None:
    postmortem = PostmortemFacts(
        summary="Pool exhausted.",
        root_cause="Concurrency raised to 24 with REDIS_MAX_POOL at 50.",
        fix="Raised REDIS_MAX_POOL to 75.",
        follow_ups=["Derive the pool from concurrency."],
        ttr_minutes=45,
        attempts=[
            AttemptFacts(action="Rolling restart", outcome="failed"),
            AttemptFacts(action="Raised REDIS_MAX_POOL to 75", outcome="worked"),
        ],
    )
    text = format_postmortem_memory(INCIDENT, postmortem)
    assert "Fix attempt in INC-046: Rolling restart. Outcome: FAILED." in text
    assert "Fix attempt in INC-046: Raised REDIS_MAX_POOL to 75. Outcome: WORKED." in text
    assert "Fix that resolved INC-046: Raised REDIS_MAX_POOL to 75." in text
    assert "after 45 minutes" in text


def test_metadata_only_carries_outcome_for_attempts() -> None:
    assert metadata_for(INCIDENT) == {"service": "payments-api", "severity": "SEV1"}
    assert metadata_for(INCIDENT, "worked")["outcome"] == "worked"


def test_extract_incident_id_prefers_document_id_then_text() -> None:
    assert extract_incident_id("INC-030", "text mentions INC-003") == "INC-030"
    assert extract_incident_id("some-uuid", "Postmortem for INC-014 (SEV1)") == "INC-014"
    assert extract_incident_id(None, "no id here") is None


def test_to_recalled_memory_maps_type_id_and_date() -> None:
    result = RecallResult(
        id="m1",
        text="INC-037 caused payments-api p99 latency to reach 4.3s.",
        type="world",
        document_id="INC-037",
        occurred_start="2026-09-03T15:48:00+00:00",
    )
    memory = to_recalled_memory(result)
    assert memory.incident_id == "INC-037"
    assert memory.type == "world"
    assert memory.occurred_at == datetime(2026, 9, 3, 15, 48, tzinfo=timezone.utc)
    assert memory.relevance is None


def test_relevance_comes_from_reranker_score() -> None:
    result = RecallResult.model_validate({
        "id": "m3",
        "text": "INC-030 Redis pool exhaustion.",
        "document_id": "INC-030",
        "scores": {"final": 1.04, "reranker": 0.9588, "semantic": 0.82},
    })
    assert to_recalled_memory(result).relevance == 0.9588


def test_to_recalled_memory_tolerates_missing_fields() -> None:
    memory = to_recalled_memory(RecallResult(id="m2", text="Observation without an incident."))
    assert memory.incident_id is None
    assert memory.occurred_at is None
    assert memory.type == "world"


def test_parse_verdict_accepts_only_real_incident_ids() -> None:
    verdict = parse_verdict("text", {"strong_precedent": True, "matching_incident_ids": ["INC-030", "inc-9", "INC-037 "]})
    assert verdict.strong_precedent is True and verdict.matching_ids == ["INC-030", "INC-037"]
    missing = parse_verdict(None, None)
    assert missing.strong_precedent is None and missing.matching_ids == [] and missing.text == ""


def test_seed_items_follow_memory_conventions() -> None:
    history = load_history()
    assert len(history) == 45
    for incident, postmortem in history:
        item = postmortem_item(incident, postmortem)
        assert item["document_id"] == incident.id
        assert item["context"] == "postmortem"
        assert item["timestamp"] == incident.resolved_at
        assert set(item["metadata"]) == {"service", "severity"}
        assert incident.id in item["content"] and incident.service in item["content"]
