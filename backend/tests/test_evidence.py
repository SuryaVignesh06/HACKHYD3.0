"""Unit tests for the evidence rule: unverified claims never reach the UI."""

from datetime import datetime, timezone

from app.models import AttemptFacts, DiagnosisDraft, DraftAvoid, DraftFix, Hypothesis, MatchedIncident, RecalledMemory
from app.services.evidence import (
    KnownIncident,
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

MATCHED = [
    MatchedIncident(id="INC-037", relevance=0.96),
    MatchedIncident(id="INC-030", relevance=0.89),
    MatchedIncident(id="INC-003", relevance=0.88),
]
ATTEMPTS = {
    "INC-037": [AttemptFacts(action="Rolling restart of payments-api pods", outcome="failed"),
                AttemptFacts(action="Raised REDIS_MAX_POOL from 20 to 50", outcome="worked")],
    "INC-030": [AttemptFacts(action="Rolling restart of payments-api pods", outcome="failed"),
                AttemptFacts(action="Raised REDIS_MAX_POOL from 20 to 50", outcome="worked")],
    "INC-003": [AttemptFacts(action="Rolling restart of payments-api pods", outcome="failed"),
                AttemptFacts(action="Rolled back PAYMENTS_WORKER_CONCURRENCY", outcome="worked")],
}
INDEX = attempt_index(ATTEMPTS)


def draft(**overrides: object) -> DiagnosisDraft:
    base: dict[str, object] = {
        "summary": "Redis pool exhaustion, as in INC-037 and INC-030.",
        "confidence": 0.9,
        "hypotheses": [Hypothesis(cause="Pool exhaustion", confidence=0.9, evidence=["INC-037", "INC-099"])],
        "try_first": DraftFix(action="Raise REDIS_MAX_POOL to 75", attempt_refs=["INC-037#2", "INC-030#2"]),
        "avoid": [DraftAvoid(action="Restart pods", why="Failed before",
                             attempt_refs=["INC-037#1", "INC-030#1", "INC-003#1"])],
    }
    base.update(overrides)
    return DiagnosisDraft.model_validate(base)


def test_verified_claims_keep_only_supported_ids() -> None:
    claims = verify_draft(draft(), MATCHED, INDEX, strong_match=True)
    assert claims.hypotheses[0].evidence == ["INC-037"]  # INC-099 was never recalled
    assert claims.try_first is not None and claims.try_first.evidence == ["INC-037", "INC-030"]
    assert claims.avoid[0].evidence == ["INC-037", "INC-030", "INC-003"]
    assert claims.cited_incidents == ["INC-037", "INC-030", "INC-003"]
    assert claims.confidence == 0.9


def test_avoid_citing_a_worked_attempt_is_removed() -> None:
    bad = draft(avoid=[DraftAvoid(action="Raise the pool", why="made up", attempt_refs=["INC-037#2"])])
    assert verify_draft(bad, MATCHED, INDEX, strong_match=True).avoid == []


def test_try_first_citing_a_failed_attempt_is_removed() -> None:
    bad = draft(try_first=DraftFix(action="Restart pods", attempt_refs=["INC-037#1"]))
    assert verify_draft(bad, MATCHED, INDEX, strong_match=True).try_first is None


def test_unknown_or_unmatched_refs_are_ignored() -> None:
    bad = draft(avoid=[DraftAvoid(action="X", why="Y", attempt_refs=["INC-050#1", "INC-037#9", "garbage"])])
    assert verify_draft(bad, MATCHED, INDEX, strong_match=True).avoid == []


def test_low_relevance_incidents_are_never_cited() -> None:
    weak = MATCHED + [MatchedIncident(id="INC-013", relevance=0.70)]
    index = attempt_index({**ATTEMPTS, "INC-013": [AttemptFacts(action="Restarted data nodes", outcome="failed")]})
    claims = verify_draft(
        draft(avoid=[DraftAvoid(action="Restart nodes", why="weak", attempt_refs=["INC-013#1"])],
              hypotheses=[Hypothesis(cause="x", confidence=0.3, evidence=["INC-013"])]),
        weak, index, strong_match=True,
    )
    assert claims.avoid == [] and claims.hypotheses == []
    assert "INC-013" not in claims.cited_incidents


def test_weak_match_caps_confidence() -> None:
    assert verify_draft(draft(confidence=0.95), MATCHED, INDEX, strong_match=False).confidence == 0.4


def test_no_verified_citation_caps_confidence() -> None:
    empty = draft(hypotheses=[], try_first=None, avoid=[])
    claims = verify_draft(empty, MATCHED, INDEX, strong_match=True)
    assert claims.cited_incidents == [] and claims.confidence == 0.4


def test_matched_incidents_groups_by_best_relevance_and_excludes_current() -> None:
    known = {iid: KnownIncident(title=iid, service="payments-api", occurred_at=datetime(2026, 9, 3, tzinfo=timezone.utc))
             for iid in ("INC-030", "INC-037", "INC-046")}
    recalled = [
        RecalledMemory(text="a", type="world", incident_id="INC-030", relevance=0.7),
        RecalledMemory(text="b", type="world", incident_id="INC-030", relevance=0.89),
        RecalledMemory(text="c", type="world", incident_id="INC-037", relevance=0.96),
        RecalledMemory(text="d", type="world", incident_id="INC-046", relevance=0.99),  # the incident itself
        RecalledMemory(text="e", type="observation", incident_id=None, relevance=0.95),
        RecalledMemory(text="f", type="world", incident_id="INC-777", relevance=0.95),  # not a known incident
    ]
    matched = matched_incidents(recalled, known, exclude_id="INC-046")
    assert [(m.id, m.relevance) for m in matched] == [("INC-037", 0.96), ("INC-030", 0.89)]
    assert is_strong_match(matched)
    assert not is_strong_match([MatchedIncident(id="INC-013", relevance=0.70)])


def test_precedent_needs_agreement_and_a_relevant_named_incident() -> None:
    family = cite_candidates(MATCHED)
    assert family == {"INC-037", "INC-030", "INC-003"}
    assert confirm_precedent(family, True, True, ["INC-030"]) == (True, family)
    assert confirm_precedent(family, None, True, ["INC-030"]) == (True, family)  # verdict unavailable
    # One stray memory made INC-013 score 0.94 for an unrelated alert: either model saying no wins.
    noisy = cite_candidates([MatchedIncident(id="INC-013", relevance=0.94), MatchedIncident(id="INC-026", relevance=0.69)])
    assert confirm_precedent(noisy, True, False, []) == (False, set())
    assert confirm_precedent(noisy, False, True, ["INC-013"]) == (False, set())
    # Naming only an irrelevant or unknown incident is not a precedent.
    assert confirm_precedent(family, True, True, ["INC-999"]) == (False, set())


def test_parse_alert_reads_service_severity_and_signature() -> None:
    parsed = parse_alert(
        "[FIRING] PaymentsApiHighLatency SEV1 payments-api\np99 4.2s\nlog: redis.exceptions.ConnectionError: Too many connections"
    )
    assert parsed.service == "payments-api"
    assert parsed.severity == "SEV1"
    assert parsed.signature == "redis.exceptions.ConnectionError: Too many connections"


def test_unverified_ids_in_free_text_are_scrubbed() -> None:
    text = ("No strong precedent in memory. The SNI mismatch comes from the CDN change. "
            "This matches the failure mechanism in INC-034 and INC-014.")
    assert scrub_unverified(text, set()) == ("No strong precedent in memory. The SNI mismatch comes from the CDN change.")
    assert scrub_unverified("Same as INC-046. Revert it.", {"INC-046"}) == "Same as INC-046. Revert it."
    bad = draft(summary="Pool exhaustion as in INC-037. Also like INC-099.",
                avoid=[DraftAvoid(action="Restart pods", why="Failed in INC-037. Also failed in INC-050.",
                                  attempt_refs=["INC-037#1"])])
    claims = verify_draft(bad, MATCHED, INDEX, strong_match=True)
    assert claims.summary == "Pool exhaustion as in INC-037."
    assert claims.avoid[0].why == "Failed in INC-037."


def test_parse_alert_reads_raw_log_lines() -> None:
    parsed = parse_alert(
        "[LOG] recent errors in nimbus-pay/logs/payments-api.log\n"
        "2026-09-28T17:15:17+05:30 WARN  payments-api POST /v1/charges p99=3.9s redis_pool=20/20\n"
        "2026-09-28T17:15:17+05:30 ERROR payments-api worker-14 request failed: redis.exceptions.ConnectionError: Too many connections\n"
        '  File "/app/payments/idempotency.py", line 12, in get_idempotency_key\n'
        '    raise ConnectionError("Too many connections")'
    )
    assert parsed.service == "payments-api"
    assert parsed.signature == "redis.exceptions.ConnectionError: Too many connections"


def test_strip_incident_ids() -> None:
    assert strip_incident_ids("Like INC-030, restart.") == "Like a past incident, restart."
