"""Project access, the deterministic finder, log extraction and secret redaction. No network."""

from datetime import datetime
from pathlib import Path

import pytest

from app.services.project_context import (
    ProjectAccessError,
    config_identifiers,
    find_findings,
    inside,
    recent_log_errors,
    validate_root,
)
from app.services.redaction import redact

REDIS_HISTORY = {
    "INC-030": "Raised REDIS_MAX_POOL from 20 to 50 and rolled back PAYMENTS_WORKER_CONCURRENCY to 8. Rolling restart failed.",
    "INC-037": "Raised REDIS_MAX_POOL from 20 to 50 and rolled back PAYMENTS_WORKER_CONCURRENCY to 8, committed to the Helm chart values.",
    "INC-003": "Rolled back PAYMENTS_WORKER_CONCURRENCY to 8 so the 20-connection Redis pool was enough again.",
}


@pytest.fixture
def project(demo_project: Path) -> Path:
    return demo_project


def test_validate_root_rejects_drive_roots_home_and_files(tmp_path: Path) -> None:
    with pytest.raises(ProjectAccessError):
        validate_root(str(Path(tmp_path.anchor)))
    with pytest.raises(ProjectAccessError):
        validate_root(str(Path.home()))
    file = tmp_path / "x.txt"
    file.write_text("x")
    with pytest.raises(ProjectAccessError):
        validate_root(str(file))
    assert validate_root(str(tmp_path)) == tmp_path.resolve()


def test_inside_blocks_path_traversal(project: Path) -> None:
    root = project.resolve()
    assert inside(root, root / "deploy" / "helm") == (root / "deploy" / "helm").resolve()
    with pytest.raises(ProjectAccessError):
        inside(root, root / ".." / ".." / "secrets.txt")


def test_config_identifiers_skip_non_config_words() -> None:
    ids = config_identifiers("Raised REDIS_MAX_POOL from 20 to 50 (SEV1, INC-030); max.poll.records to 500; api.sendgrid.com 429")
    assert ids == ["REDIS_MAX_POOL", "max.poll.records"]


def test_finder_points_at_the_helm_value_past_fixes_changed(project: Path) -> None:
    findings = find_findings(project.resolve(), REDIS_HISTORY)
    first = findings[0]
    assert first.identifier == "PAYMENTS_WORKER_CONCURRENCY"  # mentioned by all three incidents
    by_id = {f.identifier: f for f in findings}
    pool = by_id["REDIS_MAX_POOL"]
    assert pool.path == "deploy/helm/payments-api/values-prod.yaml"
    assert pool.current_value == "20"
    assert pool.related_incidents == ["INC-030", "INC-037"]
    assert "INC-030: REDIS_MAX_POOL from 20 to 50" in pool.history
    assert any(line.no == pool.line and "REDIS_MAX_POOL" in line.text for line in pool.snippet)
    assert by_id["PAYMENTS_WORKER_CONCURRENCY"].current_value == "24"


def test_finder_returns_nothing_for_unrelated_history(project: Path) -> None:
    assert find_findings(project.resolve(), {"INC-013": "Disabled the analytics widget flag."}) == []


def test_recent_log_errors_reads_the_newest_error_block(project: Path) -> None:
    logs = project / "logs"
    logs.mkdir()
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    (logs / "payments-api.log").write_text(
        f"2020-01-01T00:00:00+00:00 ERROR payments-api old failure: something\n"
        f"{now} WARN  payments-api POST /v1/charges p99=4.2s redis_pool=20/20\n"
        f"{now} ERROR payments-api worker-3 request failed: redis.exceptions.ConnectionError: Too many connections\n"
        '  File "/app/payments/idempotency.py", line 12, in get_idempotency_key\n',
        encoding="utf-8",
    )
    context = recent_log_errors(project.resolve())
    assert context is not None
    assert context.path == "logs/payments-api.log"
    assert context.error_count == 1
    assert any("Too many connections" in line for line in context.lines)
    assert not any("old failure" in line for line in context.lines)


def test_no_logs_means_no_log_context(project: Path) -> None:
    assert recent_log_errors(project.resolve()) is None


def test_redaction_removes_secrets_but_keeps_config_values() -> None:
    text = ("OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnopqrstuvwxyz123456 REDIS_MAX_POOL=50 "
            "DB_PASSWORD: hunter2hunter2 Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 "
            "redis://admin:s3cretpass@payments-redis:6379 AKIAABCDEFGHIJKLMNOP")
    cleaned = redact(text)
    for secret in ("sk-or-v1-abcdef", "hunter2", "abcdefghijklmnopqrstuvwxyz0123", "s3cretpass", "AKIAABCDEFGHIJKLMNOP"):
        assert secret not in cleaned
    assert "REDIS_MAX_POOL=50" in cleaned
