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


def test_memory_unavailable_falls_back_to_context_only(client: TestClient) -> None:
    app.state.memory = FakeMemory(fail_recall=True)
    incident_id = create(client)
    stream = events(client.post(f"/api/incidents/{incident_id}/diagnose"))
    recall = next(e for e in stream if e["type"] == "step" and e["step"]["name"] == "recall")
    assert recall["data"] == {"matched": [], "recalled": [], "unavailable": True}
    assert "Hindsight unavailable" in recall["step"]["detail"]
    diagnosis = stream[-1]["diagnosis"]
    # Nothing is presented as recalled: no matches, no citations, no incident IDs at all.
    assert diagnosis["memory_unavailable"] is True and diagnosis["memory_enabled"] is False
    assert diagnosis["matched"] == [] and diagnosis["cited_incidents"] == [] and diagnosis["worked_fixes"] == []
    assert "INC-" not in json.dumps({k: v for k, v in diagnosis.items() if k != "steps"})


def test_diagnosis_separates_worked_and_failed_fixes(client: TestClient) -> None:
    incident_id = create(client)
    stream = events(client.post(f"/api/incidents/{incident_id}/diagnose"))
    evidence = next(e for e in stream if e["type"] == "step" and e["step"]["name"] == "evidence")
    diagnosis = stream[-1]["diagnosis"]
    for data in (evidence["data"], diagnosis):
        assert {r["outcome"] for r in data["worked_fixes"]} == {"worked"}
        assert {r["outcome"] for r in data["failed_fixes"]} == {"failed"}
        assert {r["incident_id"] for r in data["failed_fixes"]} == {"INC-037", "INC-030", "INC-003"}
    # Every record is a real attempt of that incident in the fix log.
    for record in diagnosis["worked_fixes"] + diagnosis["failed_fixes"]:
        attempts = client.get(f"/api/incidents/{record['incident_id']}").json()["attempts"]
        assert any(a["action"] == record["action"] and a["outcome"] == record["outcome"] for a in attempts)


def test_no_precedent_hides_fix_history_claims(client: TestClient) -> None:
    app.state.llm = FakeLLM(precedent=False)
    incident_id = create(client)
    diagnosis = events(client.post(f"/api/incidents/{incident_id}/diagnose"))[-1]["diagnosis"]
    assert diagnosis["worked_fixes"] == [] and diagnosis["failed_fixes"] == []


def test_resolved_incident_is_recalled_as_learned_live(client: TestClient) -> None:
    first = create(client)
    client.post(f"/api/incidents/{first}/resolve", json={"summary": "Pool exhausted", "root_cause": "Pool too small",
                                                         "fix": "Raised REDIS_MAX_POOL from 20 to 50"})

    class RecallsLearned(FakeMemory):
        async def recall_similar(self, alert_text: str, service: str) -> list[RecalledMemory]:
            return [RecalledMemory(text=f"{first} Redis pool", type="experience", incident_id=first, relevance=0.97),
                    *await super().recall_similar(alert_text, service)]

    app.state.memory = RecallsLearned()
    second = create(client)
    matched = events(client.post(f"/api/incidents/{second}/diagnose"))[-1]["diagnosis"]["matched"]
    assert matched[0] == {**matched[0], "id": first, "learned_live": True}
    assert all(m["learned_live"] is False for m in matched[1:])


class FakeSeedMemory:
    bank_id = "test-bank"
    stored = {f"INC-{n:03d}" for n in range(1, 41)}
    batches: list[list[str]] = []

    def __init__(self, timeout: float = 30.0) -> None:
        pass

    async def ensure_bank(self) -> None:
        return None

    async def document_ids(self) -> set[str]:
        return set(self.stored)

    async def retain_postmortem_batch(self, items: list[dict[str, Any]]) -> int:
        ids = [item["document_id"] for item in items]
        FakeSeedMemory.batches.append(ids)
        FakeSeedMemory.stored |= set(ids)
        return len(items)

    async def close(self) -> None:
        return None


def test_seed_only_adds_missing_incidents(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.routers.demo.MemoryService", FakeSeedMemory)
    first = client.post("/api/memory/seed").json()
    assert first["status"] == "success" and first["created"] == 5 and first["skipped"] == 40
    assert [i for batch in FakeSeedMemory.batches for i in batch] == [f"INC-{n:03d}" for n in range(41, 46)]
    again = client.post("/api/memory/seed").json()
    assert again == {**again, "status": "already_seeded", "created": 0, "skipped": 45, "bank": "test-bank"}


def test_demo_tools_can_be_disabled(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.routers.demo.get_settings", lambda: type("S", (), {"DEMO_TOOLS": False})())
    assert client.post("/api/memory/seed").status_code == 403
    assert client.post("/api/demo/reset", json={"confirm": "reset"}).json()["error"] == "demo_tools_disabled"


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
                                                      "observation_count": 41, "available": True, "demo_tools": True}
    assert [d["id"] for d in client.get("/api/demo-alerts").json()] == ["DEMO-A", "DEMO-B", "DEMO-C",
                                                                              "DEMO-D", "DEMO-E", "DEMO-F"]


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
    assert all(e["id"] not in {f"INC-{n:03d}" for n in range(1, 46)} for e in body["recent_learned"])


def test_screen_endpoint_rejects_non_images(client: TestClient) -> None:
    response = client.post("/api/context/screen", json={"image_data_url": "data:text/plain;base64," + "A" * 200})
    assert response.status_code == 400 and response.json()["error"] == "invalid_image"


def test_invalid_request_is_readable(client: TestClient) -> None:
    body = client.post("/api/incidents", json={"alert_text": "short"}).json()
    assert body["error"] == "invalid_request"


class AskMemory(FakeMemory):
    async def reflect_free(self, query: str, budget: str = "mid") -> str:
        return ("Redis pool exhaustion happened in INC-037 and INC-030; restarting pods failed both times. "
                "It also resembles INC-999, which recall never returned.")


def test_ask_answers_from_recalled_incidents_only(client: TestClient) -> None:
    app.state.memory = AskMemory()
    body = client.post("/api/memory/ask", json={"question": "Have we seen Redis pool exhaustion before?"}).json()
    assert body["memory_unavailable"] is False and body["recalled_count"] == 3
    assert "INC-037" in body["answer"] and "INC-999" not in body["answer"]
    assert [i["id"] for i in body["incidents"]] == ["INC-037", "INC-030", "INC-003"]
    inc037 = body["incidents"][0]
    assert inc037["relevance"] == 0.96 and inc037["title"]
    assert any("restart" in f.lower() for f in inc037["failed"]) and inc037["worked"]


def test_ask_with_hindsight_down_shows_nothing_recalled(client: TestClient) -> None:
    app.state.memory = type("DownAsk", (AskMemory,), {})(fail_recall=True)
    body = client.post("/api/memory/ask", json={"question": "Redis pool errors?"}).json()
    assert body["memory_unavailable"] is True and body["incidents"] == [] and "unavailable" in body["answer"]



SCREEN = (
    "2026-09-29T16:16:40+05:30 ERROR payments-api worker-3 request failed: redis.exceptions.ConnectionError: Too many connections\n"
    '  File "/app/payments/idempotency.py", line 12, in get_idempotency_key'
)


class AssistLLM(FakeLLM):
    def __init__(self, fail: bool = False) -> None:
        super().__init__(fail=fail)
        self.prompts: list[str] = []

    async def answer_question(self, prompt: str) -> tuple[Any, str]:
        from app.models import AssistDraft, AssistDraftHistory

        self.prompts.append(prompt)
        if self.fail:
            raise LLMUnavailable("down")
        return AssistDraft(
            answer="The pool is capped at 20, the same pattern as INC-037. It also looks like INC-999.",
            recommendation="Raise REDIS_MAX_POOL from 20 to 50 in values-prod.yaml.",
            next_step="Open deploy/helm/payments-api/values-prod.yaml",
            history=[AssistDraftHistory(incident_id="INC-037", text="INC-037 was fixed by raising the pool to 50."),
                     AssistDraftHistory(incident_id="INC-999", text="Invented incident.")],
        ), "nvidia/test"


def test_assist_grounds_the_answer_in_screen_memory_and_project(client: TestClient, demo_project: Any) -> None:
    app.state.memory = AskMemory()
    llm = AssistLLM()
    app.state.llm = llm
    project = client.post("/api/projects", json={"root_path": str(demo_project), "scope": "once"},
                          headers={"X-OnCall-Client": "desktop"}).json()
    body = client.post("/api/assist", json={"question": "Where should I fix this?", "screen_text": SCREEN,
                                            "project_id": project["id"]}).json()
    assert body["intent"] == "location" and body["screen_used"] is True and body["no_match"] is False
    assert "INC-999" not in body["answer"] and "INC-037" in body["answer"]
    assert [h["incident_id"] for h in body["history"]] == ["INC-037"]
    sources = {item["source"] for item in body["current"]}
    assert sources == {"SCREEN", "PROJECT"}
    assert body["current"][0]["text"].startswith("redis.exceptions.ConnectionError: Too many connections")
    pool = next(item for item in body["current"] if item["source"] == "PROJECT" and "REDIS_MAX_POOL" in item["text"])
    assert pool["location"].startswith("deploy/helm/payments-api/values-prod.yaml:") and "= 20" in pool["text"]
    assert any("restart" in f["action"].lower() for f in body["failed"]) and body["worked"]
    # The model saw the evidence, labelled, and never a request to use its own knowledge.
    assert "CURRENT CONTEXT (screen)" in llm.prompts[0] and "PROJECT FINDINGS" in llm.prompts[0]


class NoMatchMemory(AskMemory):
    async def recall_similar(self, alert_text: str, service: str) -> list[RecalledMemory]:
        return [RecalledMemory(text="INC-026 alias swap", type="world", incident_id="INC-026", relevance=0.41)]


def test_assist_says_plainly_when_history_has_nothing(client: TestClient) -> None:
    app.state.memory = NoMatchMemory()
    app.state.llm = AssistLLM()
    body = client.post("/api/assist", json={"question": "Has this happened before?", "screen_text": SCREEN}).json()
    assert body["intent"] == "history" and body["no_match"] is True
    assert body["answer"].startswith("No previous engineering experience matched this problem.")
    assert body["history"] == [] and body["worked"] == [] and body["failed"] == []


def test_assist_with_memory_down_invents_nothing(client: TestClient) -> None:
    app.state.memory = type("DownAssist", (AskMemory,), {})(fail_recall=True)
    app.state.llm = AssistLLM(fail=True)
    body = client.post("/api/assist", json={"question": "What is causing this?", "screen_text": SCREEN}).json()
    assert body["memory_unavailable"] is True and body["degraded"] is True
    assert body["answer"].startswith("FRIDAY memory is unavailable") and body["history"] == [] and body["incidents"] == []
