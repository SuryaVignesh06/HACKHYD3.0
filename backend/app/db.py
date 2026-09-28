"""SQLite engine, session dependency, UTC helpers, light migrations, the memory event log and the
one-time import of the seeded history."""

import json
from collections.abc import Iterator
from datetime import datetime, timezone

from sqlalchemy import text
from sqlmodel import Session, SQLModel, create_engine, select

from app.config import get_settings
from app.dataset import load_history
from app.models import AttemptRow, DiagnosisRow, IncidentRow, MemoryEventRow

engine = create_engine(
    get_settings().DATABASE_URL,
    connect_args={"check_same_thread": False},
)

# Columns added after the first release. create_all() never alters existing tables, so they are added here.
ADDED_COLUMNS: dict[str, dict[str, str]] = {
    "incidents": {"family": "VARCHAR", "project_id": "INTEGER", "origin": "VARCHAR"},
}


def to_db_time(moment: datetime) -> datetime:
    """Everything is stored as timezone-aware UTC (SQLModel rejects naive datetimes)."""
    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def from_db_time(moment: datetime | None) -> datetime | None:
    if moment is None:
        return None
    return moment.replace(tzinfo=timezone.utc) if moment.tzinfo is None else moment


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def get_session() -> Iterator[Session]:
    with Session(engine) as session:
        yield session


def migrate() -> None:
    with engine.begin() as connection:
        for table, columns in ADDED_COLUMNS.items():
            existing = {row[1] for row in connection.execute(text(f"PRAGMA table_info({table})"))}
            for column, sql_type in columns.items():
                if column not in existing:
                    connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {sql_type}"))


def record_event(kind: str, detail: str, ok: bool, count: int | None = None, incident_id: str | None = None) -> None:
    """Log a Hindsight operation. Failures to log never break the operation itself."""
    try:
        with Session(engine) as session:
            session.add(MemoryEventRow(kind=kind, detail=detail[:500], ok=ok, count=count,
                                       incident_id=incident_id, created_at=to_db_time(utc_now())))
            session.commit()
    except Exception:  # noqa: BLE001 - the audit log is best effort by design
        return


def reset_live_data() -> int:
    """Delete incidents created through the app (and their attempts, diagnoses and memory events); keep the seeded history."""
    SQLModel.metadata.create_all(engine)
    migrate()
    with Session(engine) as session:
        live_ids = list(session.exec(select(IncidentRow.id).where(IncidentRow.source == "live")).all())
        for model in (AttemptRow, DiagnosisRow):
            for row in session.exec(select(model).where(model.incident_id.in_(live_ids))).all():  # type: ignore[attr-defined]
                session.delete(row)
        for event in session.exec(select(MemoryEventRow)).all():
            session.delete(event)
        session.flush()
        for iid in live_ids:
            incident = session.get(IncidentRow, iid)
            if incident is not None:
                session.delete(incident)
        session.commit()
        return len(live_ids)


def init_db() -> int:
    """Create tables, apply migrations and import the seeded history once. Returns how many incidents were imported."""
    SQLModel.metadata.create_all(engine)
    migrate()
    history = load_history()
    with Session(engine) as session:
        if session.exec(select(IncidentRow).limit(1)).first() is not None:
            # Backfill the family label on databases created before the column existed.
            for incident, _ in history:
                row = session.get(IncidentRow, incident.id)
                if row is not None and row.family is None and incident.family:
                    row.family = incident.family
                    session.add(row)
            session.commit()
            return 0
        for incident, postmortem in history:
            session.add(IncidentRow(
                id=incident.id,
                title=incident.title,
                service=incident.service,
                severity=incident.severity,
                status="resolved",
                source="history",
                alert_text=incident.alert_text,
                on_call=incident.on_call,
                created_at=to_db_time(incident.started_at),
                resolved_at=to_db_time(incident.resolved_at) if incident.resolved_at else None,
                summary=postmortem.summary,
                root_cause=postmortem.root_cause,
                fix=postmortem.fix,
                follow_ups_json=json.dumps(postmortem.follow_ups),
                ttr_minutes=postmortem.ttr_minutes,
                family=incident.family,
            ))
        session.flush()
        for incident, postmortem in history:
            for attempt in postmortem.attempts:
                session.add(AttemptRow(
                    incident_id=incident.id,
                    action=attempt.action,
                    outcome=attempt.outcome,
                    notes=attempt.notes,
                    created_at=to_db_time(incident.started_at),
                ))
        session.commit()
        return len(history)
