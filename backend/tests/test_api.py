"""Endpoint tests. Hindsight and the LLM are replaced at the service boundary; SQLite is real."""

import json
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models import (
    DiagnosisDraft,
    DraftAvoid,
    DraftFix,
    Hypothesis,
    IncidentFacts,
    PostmortemFacts,
    PostmortemText,
    RecalledMemory,
)
from app.services.llm import LLMUnavailable
from app.services.memory import MemoryUnavailable, ReflectVerdict, format_postmortem_memory

DEMO_A = (
    "[FIRING] PaymentsApiHighLatency SEV1 payments-api\n"
    "p99 latency 4.2s (threshold 1.5s) for 5m on POST /v1/charges\n"
    "log: redis.exceptions.ConnectionError: Too many connections"
)


class FakeMemory:
    bank_id = "test-bank"

    def __init__(self, fail_recall: bool = False) -> None:
        self.fail_recall = fail_recall
        self.retained: list[str] = []

    async def retain_alert(self, incident: IncidentFacts) -> None:
        self.retained.append(incident.id)

    async def recall_similar(self, alert_text: str, service: str) -> list[RecalledMemory]:
        if self.fail_recall:
            raise MemoryUnavailable("Memory is unavailable (recall failed). Try again in a moment.")
        return [
            RecalledMemory(text="INC-037 Redis pool exhaustion", type="world", incident_id="INC-037", relevance=0.96),
            RecalledMemory(text="INC-030 Redis pool exhaustion", type="world", incident_id="INC-030", relevance=0.89),
            RecalledMemory(text="INC-003 Redis pool exhaustion", type="observation", incident_id="INC-003", relevance=0.88),
        ]

    async def reflect_diagnosis(self, alert_text: str, service: str, budget: str = "mid") -> ReflectVerdict:
        return ReflectVerdict(text="Matches INC-030 and INC-037. Restarting pods failed.",
                              strong_precedent=True, matching_ids=["INC-030", "INC-037"])

    async def retain_attempt(self, incident: IncidentFacts, attempt: Any) -> None:
        self.retained.append(f"{incident.id}:attempt:{attempt.outcome}")

    async def retain_postmortem(self, incident: IncidentFacts, postmortem: PostmortemFacts) -> str:
        self.retained.append(f"{incident.id}:postmortem")
        self.count += 3
        return format_postmortem_memory(incident, postmortem)

    count = 230

    async def memory_count(self) -> int:
        return self.count

    async def observation_count(self) -> int:
        return 41


class FakeLLM:
    def __init__(self, fail: bool = False, precedent: bool = True) -> None:
        self.fail = fail
        self.precedent = precedent

    async def format_diagnosis(self, *args: Any, **kwargs: Any) -> tuple[DiagnosisDraft, str]:
        if self.fail:
            raise LLMUnavailable("down")
        # INC-003#1, INC-030#1 and INC-037#1 are the failed restarts in the seeded history.
        return DiagnosisDraft(
            strong_precedent=self.precedent,
            precedent_ids=["INC-037", "INC-030"] if self.precedent else [],
            summary="Redis pool exhaustion after a concurrency increase (INC-037, INC-030).",
            confidence=0.9,
            hypotheses=[Hypothesis(cause="Pool exhaustion", confidence=0.9, evidence=["INC-037", "INC-030", "INC-404"])],
            try_first=DraftFix(action="Raise REDIS_MAX_POOL and roll back concurrency", attempt_refs=["INC-037#2", "INC-030#2"]),
            avoid=[DraftAvoid(action="Restart payments-api pods", why="Failed every time",
                              attempt_refs=["INC-037#1", "INC-030#1", "INC-003#1", "INC-030#2"])],
        ), "nvidia/nemotron-test"

    async def draft_postmortem(self, incident_line: str, alert_text: str, attempts: list[Any],
                               diagnosis_summary: str | None) -> tuple[PostmortemText, str]:
        if self.fail:
            raise LLMUnavailable("down")
        return PostmortemText(summary="Pool exhausted; restart failed.", root_cause="Concurrency 24 exceeded the pool.",
                              fix="Raised REDIS_MAX_POOL to 75", follow_ups=["Derive pool from concurrency"]), "nvidia/test"

    async def baseline_diagnosis(self, alert_text: str, service: str) -> tuple[DiagnosisDraft, str]:
        return DiagnosisDraft(
            summary="Check Redis and restart the service. Similar to INC-030.",
            confidence=0.8,
            try_first=DraftFix(action="Restart the service"),
        ), "nvidia/nemotron-test"


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        app.state.memory = FakeMemory()
        app.state.llm = FakeLLM()
        yield test_client


def events(response: Any) -> list[dict[str, Any]]:
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def create(client: TestClient) -> str:
    response = client.post("/api/incidents", json={"alert_text": DEMO_A})
    assert response.status_code == 201
    return str(response.json()["id"])


def test_history_is_imported_and_listed(client: TestClient) -> None:
    rows = client.get("/api/incidents").json()
    assert {"INC-001", "INC-045"} <= {r["id"] for r in rows}
    detail = client.get("/api/incidents/INC-030").json()
    assert [a["outcome"] for a in detail["attempts"]] == ["failed", "worked"]


def test_create_incident_parses_alert(client: TestClient) -> None:
    body = client.post("/api/incidents", json={"alert_text": DEMO_A}).json()
    assert body["id"].startswith("INC-") and int(body["id"][4:]) >= 46
    assert body["service"] == "payments-api" and body["severity"] == "SEV1"
    assert body["title"] == "PaymentsApiHighLatency on payments-api"


def test_alert_is_retained_once_after_first_memory_investigation(client: TestClient) -> None:
    memory: FakeMemory = app.state.memory
    incident_id = create(client)
    assert incident_id not in memory.retained
    first = events(client.post(f"/api/incidents/{incident_id}/diagnose"))[-1]
    second = events(client.post(f"/api/incidents/{incident_id}/diagnose"))[-1]
    assert first["alert_retained"] is True and second["alert_retained"] is False
    assert memory.retained.count(incident_id) == 1


def test_diagnose_streams_all_steps_and_verified_diagnosis(client: TestClient) -> None:
    incident_id = create(client)
    stream = events(client.post(f"/api/incidents/{incident_id}/diagnose?memory=true"))
    assert [e["step"]["name"] for e in stream if e["type"] == "step"] == ["parse", "recall", "evidence", "inspect", "reflect", "diagnosis"]
    final = stream[-1]
    assert final["type"] == "diagnosis"
    diagnosis = final["diagnosis"]
    assert diagnosis["strong_match"] is True
    assert diagnosis["avoid"][0]["evidence"] == ["INC-037", "INC-030", "INC-003"]
    assert diagnosis["try_first"]["evidence"] == ["INC-037", "INC-030"]
    assert "INC-404" not in diagnosis["cited_incidents"]
    assert [m["id"] for m in diagnosis["matched"]] == ["INC-037", "INC-030", "INC-003"]
    learning = client.get("/api/learning").json()
    assert learning[-1]["incident_id"] == incident_id and learning[-1]["cited_count"] == 3


def test_no_confirmed_precedent_means_no_claims(client: TestClient) -> None:
    app.state.llm = FakeLLM(precedent=False)
    incident_id = create(client)
    diagnosis = events(client.post(f"/api/incidents/{incident_id}/diagnose"))[-1]["diagnosis"]
    assert diagnosis["strong_match"] is False
    assert diagnosis["summary"].startswith("No strong precedent in memory.")
    assert diagnosis["cited_incidents"] == [] and diagnosis["avoid"] == [] and diagnosis["try_first"] is None
    assert diagnosis["confidence"] <= 0.4
    assert len(diagnosis["matched"]) == 3  # still shown in "Why I think this", just not claimed


def test_memory_off_has_no_incident_ids(client: TestClient) -> None:
    incident_id = create(client)
    stream = events(client.post(f"/api/incidents/{incident_id}/diagnose?memory=false"))
    assert [e["step"]["name"] for e in stream if e["type"] == "step"] == ["parse", "diagnosis"]
    diagnosis = stream[-1]["diagnosis"]
    assert diagnosis["memory_enabled"] is False
    assert "INC-" not in json.dumps(diagnosis)


def test_memory_unavailable_is_a_readable_event(client: TestClient) -> None:
    app.state.memory = FakeMemory(fail_recall=True)
    incident_id = create(client)
    stream = events(client.post(f"/api/incidents/{incident_id}/diagnose"))
    assert stream[-1] == {"type": "error", "error": "memory_unavailable",
                          "message": "Memory is unavailable (recall failed). Try again in a moment."}


def test_llm_failure_degrades_to_reflect_text(client: TestClient) -> None:
    app.state.llm = FakeLLM(fail=True)
    incident_id = create(client)
    diagnosis = events(client.post(f"/api/incidents/{incident_id}/diagnose"))[-1]["diagnosis"]
    assert diagnosis["degraded"] is True
    assert diagnosis["summary"].startswith("Matches INC-030")


def test_unknown_incident_is_readable(client: TestClient) -> None:
    assert client.get("/api/incidents/INC-999").json()["error"] == "not_found"
    stream = events(client.post("/api/incidents/INC-999/diagnose"))
    assert stream == [{"type": "error", "error": "not_found", "message": "Incident INC-999 does not exist."}]


def test_stats_and_demo_alerts(client: TestClient) -> None:
    assert client.get("/api/memory/stats").json() == {"bank_id": "test-bank", "memory_count": 230,
                                                      "observation_count": 41, "available": True}
    assert [d["id"] for d in client.get("/api/demo-alerts").json()] == ["DEMO-A", "DEMO-B", "DEMO-C"]


def test_learning_loop_attempts_draft_resolve(client: TestClient) -> None:
    memory: FakeMemory = app.state.memory
    incident_id = create(client)
    failed = client.post(f"/api/incidents/{incident_id}/attempts",
                         json={"action": "Rolling restart of payments-api pods", "outcome": "failed", "notes": "back in 8 min"})
    assert failed.status_code == 201 and failed.json()["memory_retained"] is True
    client.post(f"/api/incidents/{incident_id}/attempts", json={"action": "Raised REDIS_MAX_POOL to 75", "outcome": "worked"})
    assert f"{incident_id}:attempt:failed" in memory.retained

    draft = client.post(f"/api/incidents/{incident_id}/postmortem-draft").json()
    assert draft["drafted_by"] == "test" and draft["ttr_minutes"] >= 1

    captured = client.post(f"/api/incidents/{incident_id}/resolve", json={
        "summary": draft["summary"], "root_cause": draft["root_cause"], "fix": draft["fix"], "follow_ups": draft["follow_ups"],
    }).json()
    assert captured["failed_fixes"] == ["Rolling restart of payments-api pods"]
    assert captured["worked_fixes"] == ["Raised REDIS_MAX_POOL to 75"]
    assert captured["memory_count_after"] == captured["memory_count_before"] + 3
    assert "Outcome: FAILED" in captured["retained_text"] and incident_id in captured["retained_text"]

    detail = client.get(f"/api/incidents/{incident_id}").json()
    assert detail["status"] == "resolved" and len(detail["attempts"]) == 2
    again = client.post(f"/api/incidents/{incident_id}/resolve", json={"summary": "xxxxx", "root_cause": "xxxxx", "fix": "xxx"})
    assert again.status_code == 409 and again.json()["error"] == "conflict"


def test_postmortem_draft_degrades_to_session_data(client: TestClient) -> None:
    app.state.llm = FakeLLM(fail=True)
    incident_id = create(client)
    client.post(f"/api/incidents/{incident_id}/attempts", json={"action": "Restart pods", "outcome": "failed"})
    client.post(f"/api/incidents/{incident_id}/attempts", json={"action": "Raise the pool", "outcome": "worked"})
    draft = client.post(f"/api/incidents/{incident_id}/postmortem-draft").json()
    assert draft["drafted_by"] == "session"
    assert draft["fix"] == "Raise the pool" and "Restart pods" in draft["summary"]


def test_projects_require_the_desktop_client(client: TestClient, tmp_path: Any) -> None:
    denied = client.post("/api/projects", json={"root_path": str(tmp_path)})
    assert denied.status_code == 403 and denied.json()["error"] == "desktop_only"
    bad = client.post("/api/projects", json={"root_path": str(tmp_path / "missing")}, headers={"X-OnCall-Client": "desktop"})
    assert bad.status_code == 400


def test_inspect_step_finds_the_setting_past_fixes_changed(client: TestClient, demo_project: Any) -> None:
    project = client.post("/api/projects", json={"root_path": str(demo_project), "scope": "once"},
                          headers={"X-OnCall-Client": "desktop"}).json()
    incident = client.post("/api/incidents", json={"alert_text": DEMO_A, "project_id": project["id"], "origin": "logs"}).json()
    assert incident["project_id"] == project["id"]
    stream = events(client.post(f"/api/incidents/{incident['id']}/diagnose"))
    names = [e["step"]["name"] for e in stream if e["type"] == "step"]
    assert names == ["parse", "recall", "evidence", "inspect", "reflect", "diagnosis"]
    inspect = next(e for e in stream if e["type"] == "step" and e["step"]["name"] == "inspect")
    assert "REDIS_MAX_POOL at deploy/helm/payments-api/values-prod.yaml" in inspect["step"]["detail"]
    diagnosis = stream[-1]["diagnosis"]
    assert diagnosis["project"] == "nimbus-pay"
    pool = next(f for f in diagnosis["findings"] if f["identifier"] == "REDIS_MAX_POOL")
    assert pool["current_value"] == "20" and {"INC-030", "INC-037"} <= set(pool["related_incidents"])
    kinds = [e["kind"] for e in client.get("/api/memory/events").json()]
    assert "recall" in kinds and "reflect" in kinds
    assert client.get("/api/projects/resolve-path", params={"path": pool["abs_path"]}).json()["id"] == project["id"]
    assert client.get("/api/projects/resolve-path", params={"path": "C:/Windows/win.ini"}).status_code == 404
    context = client.get(f"/api/projects/{project['id']}/context").json()
    assert context["files_indexed"] >= 5


def test_resolve_without_retain_does_not_touch_memory(client: TestClient) -> None:
    memory: FakeMemory = app.state.memory
    incident_id = create(client)
    captured = client.post(f"/api/incidents/{incident_id}/resolve", json={
        "summary": "xxxxx", "root_cause": "Pool exhausted", "fix": "Raised pool", "retain": False}).json()
    assert captured["memory_retained"] is False and captured["retained_text"] == ""
    assert f"{incident_id}:postmortem" not in memory.retained


def test_memory_overview_is_built_from_real_records(client: TestClient) -> None:
    body = client.get("/api/memory/overview").json()
    totals = body["totals"]
    assert totals["incidents_learned"] >= 45 and totals["families"] == 6
    assert totals["worked"] + totals["failed"] + totals["partial"] == totals["fix_attempts"]
    payments = next(s for s in body["services"] if s["service"] == "payments-api")
    redis = next(f for f in payments["families"] if f["family"] == "redis-pool-exhaustion")
    assert redis["label"] == "Redis pool exhaustion"
    assert {"INC-003", "INC-014", "INC-030", "INC-037"} <= set(redis["incident_ids"])
    assert sum(1 for f in redis["failed"] if "restart" in f["action"].lower()) == 4
    assert [p["incidents_learned"] for p in body["growth"]] == sorted(p["incidents_learned"] for p in body["growth"])


def test_screen_endpoint_rejects_non_images(client: TestClient) -> None:
    response = client.post("/api/context/screen", json={"image_data_url": "data:text/plain;base64," + "A" * 200})
    assert response.status_code == 400 and response.json()["error"] == "invalid_image"


def test_invalid_request_is_readable(client: TestClient) -> None:
    body = client.post("/api/incidents", json={"alert_text": "short"}).json()
    assert body["error"] == "invalid_request"
