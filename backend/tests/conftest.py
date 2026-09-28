"""Test setup: point the app at a throwaway SQLite file before any app module is imported."""

import os
import tempfile
from pathlib import Path

_db_dir = Path(tempfile.mkdtemp(prefix="oncall-test-"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_db_dir / 'test.db').as_posix()}"
os.environ.setdefault("HINDSIGHT_BASE_URL", "http://hindsight.invalid")
os.environ.setdefault("HINDSIGHT_API_KEY", "test-key")
os.environ.setdefault("OPENROUTER_API_KEY", "test-key")

import re  # noqa: E402
import shutil  # noqa: E402

import pytest  # noqa: E402

DEMO_SOURCE = Path(__file__).resolve().parents[2] / "demo" / "nimbus-pay"


@pytest.fixture
def demo_project(tmp_path: Path) -> Path:
    """A private copy of demo/nimbus-pay at its demo starting state (the live copy is edited during demos)."""
    root = tmp_path / "nimbus-pay"
    shutil.copytree(DEMO_SOURCE, root, ignore=shutil.ignore_patterns("logs"))
    values = root / "deploy" / "helm" / "payments-api" / "values-prod.yaml"
    text = values.read_text(encoding="utf-8")
    for key, value in {"PAYMENTS_WORKER_CONCURRENCY": "24", "REDIS_MAX_POOL": "20"}.items():
        text = re.sub(rf'^(\s+{key}:\s*)"[^"]*"', rf'\g<1>"{value}"', text, flags=re.MULTILINE)
    values.write_text(text, encoding="utf-8")
    return root
