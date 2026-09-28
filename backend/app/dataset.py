"""Loads the synthetic Nimbus Pay history from data/ into typed models."""

import json
from pathlib import Path
from typing import Any

from app.config import REPO_ROOT
from app.models import AttemptFacts, IncidentFacts, PostmortemFacts

DATA_DIR = REPO_ROOT / "data"


def _read(name: str) -> Any:
    return json.loads((DATA_DIR / name).read_text(encoding="utf-8"))


def load_history(data_dir: Path = DATA_DIR) -> list[tuple[IncidentFacts, PostmortemFacts]]:
    incidents = json.loads((data_dir / "incidents.json").read_text(encoding="utf-8"))
    postmortems = {pm["incident_id"]: pm for pm in json.loads((data_dir / "postmortems.json").read_text(encoding="utf-8"))}
    history: list[tuple[IncidentFacts, PostmortemFacts]] = []
    for raw in incidents:
        pm = postmortems[raw["id"]]
        history.append((
            IncidentFacts.model_validate(raw),
            PostmortemFacts(
                summary=pm["summary"],
                root_cause=pm["root_cause"],
                fix=pm["fix"],
                follow_ups=pm["follow_ups"],
                ttr_minutes=pm["ttr_minutes"],
                attempts=[AttemptFacts.model_validate(a) for a in pm["attempts"]],
            ),
        ))
    return history


def load_demo_alerts() -> list[dict[str, Any]]:
    alerts: list[dict[str, Any]] = _read("demo_alerts.json")
    return alerts
