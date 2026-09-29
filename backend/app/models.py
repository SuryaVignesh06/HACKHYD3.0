"""SQLModel tables and Pydantic schemas shared by the memory layer, the LLM layer and the API."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field as PydanticField
from sqlmodel import Field, SQLModel

Outcome = Literal["worked", "failed", "partial"]
StepName = Literal["parse", "recall", "evidence", "inspect", "reflect", "diagnosis"]
ProjectScope = Literal["once", "always"]
MemoryEventKind = Literal["recall", "reflect", "retain"]


# ---------------------------------------------------------------- tables


class IncidentRow(SQLModel, table=True):
    __tablename__ = "incidents"

    id: str = Field(primary_key=True)
    title: str
    service: str = Field(index=True)
    severity: str
    status: str = "open"  # open | resolved
    source: str = "live"  # history | live
    alert_text: str
    on_call: str | None = None
    created_at: datetime
    resolved_at: datetime | None = None
    summary: str | None = None
    root_cause: str | None = None
    fix: str | None = None
    follow_ups_json: str = "[]"
    ttr_minutes: int | None = None
    family: str | None = None  # seeded failure family, or inherited from the confirmed precedent on resolve
    project_id: int | None = None  # authorized project the incident was investigated in (desktop agent)
    origin: str | None = None  # where the alert came from: manual, demo, clipboard, logs, screen


class ProjectRow(SQLModel, table=True):
    """A folder the engineer explicitly allowed the agent to inspect."""

    __tablename__ = "projects"

    id: int | None = Field(default=None, primary_key=True)
    name: str
    root_path: str = Field(index=True)
    scope: str = "always"  # once | always
    created_at: datetime


class MemoryEventRow(SQLModel, table=True):
    """Audit log of every Hindsight operation, so the UI only shows operations that really happened."""

    __tablename__ = "memory_events"

    id: int | None = Field(default=None, primary_key=True)
    kind: str  # recall | reflect | retain
    detail: str
    ok: bool
    count: int | None = None
    incident_id: str | None = Field(default=None, index=True)
    created_at: datetime


class AttemptRow(SQLModel, table=True):
    __tablename__ = "attempts"

    id: int | None = Field(default=None, primary_key=True)
    incident_id: str = Field(foreign_key="incidents.id", index=True)
    action: str
    outcome: str  # worked | failed | partial
    notes: str | None = None
    created_at: datetime


class DiagnosisRow(SQLModel, table=True):
    __tablename__ = "diagnoses"

    id: int | None = Field(default=None, primary_key=True)
    incident_id: str = Field(foreign_key="incidents.id", index=True)
    memory_enabled: bool
    payload_json: str
    recalled_ids_json: str = "[]"
    latency_ms: int
    created_at: datetime


# ---------------------------------------------------------------- memory inputs


class IncidentFacts(BaseModel):
    """What the memory layer needs to know about an incident."""

    id: str
    title: str
    service: str
    severity: str
    started_at: datetime
    resolved_at: datetime | None = None
    alert_text: str
    on_call: str | None = None
    family: str | None = None


class AttemptFacts(BaseModel):
    action: str
    outcome: Outcome
    notes: str | None = None
    created_at: datetime | None = None


class PostmortemFacts(BaseModel):
    summary: str
    root_cause: str
    fix: str
    follow_ups: list[str] = PydanticField(default_factory=list)
    ttr_minutes: int
    attempts: list[AttemptFacts] = PydanticField(default_factory=list)


# ---------------------------------------------------------------- diagnosis (CLAUDE.md section 8)


class Hypothesis(BaseModel):
    cause: str
    confidence: float = PydanticField(ge=0.0, le=1.0)
    evidence: list[str] = PydanticField(default_factory=list)


class FixSuggestion(BaseModel):
    action: str
    source: str | None = None
    evidence: list[str] = PydanticField(default_factory=list)  # incidents where this fix worked (verified)


class AvoidFix(BaseModel):
    action: str
    why: str
    evidence: list[str] = PydanticField(default_factory=list)  # incidents where this fix failed (verified)


class RecalledMemory(BaseModel):
    text: str
    type: str
    incident_id: str | None = None
    occurred_at: datetime | None = None
    relevance: float | None = None  # Hindsight reranker score


class MatchedIncident(BaseModel):
    id: str
    title: str | None = None
    service: str | None = None
    relevance: float
    occurred_at: datetime | None = None
    learned_live: bool = False  # resolved in this app (not seeded history), so the agent learned it itself


class FixRecord(BaseModel):
    """One recorded fix attempt of a recalled incident, read from the attempts table (the mirror of what was retained)."""

    action: str
    incident_id: str
    outcome: Outcome
    notes: str | None = None


class InvestigationStep(BaseModel):
    name: StepName
    detail: str
    duration_ms: int


class SnippetLine(BaseModel):
    no: int
    text: str


class CodeFinding(BaseModel):
    """A place in the authorized project that a past fix touched. Every field was read from disk or history."""

    path: str  # relative to the project root
    abs_path: str
    line: int
    identifier: str
    current_value: str | None = None
    snippet: list[SnippetLine] = PydanticField(default_factory=list)
    related_incidents: list[str] = PydanticField(default_factory=list)
    history: list[str] = PydanticField(default_factory=list)  # e.g. "INC-030: REDIS_MAX_POOL from 20 to 50"
    note: str


class Diagnosis(BaseModel):
    summary: str
    confidence: float | None = PydanticField(default=None, ge=0.0, le=1.0)
    hypotheses: list[Hypothesis] = PydanticField(default_factory=list)
    try_first: FixSuggestion | None = None
    avoid: list[AvoidFix] = PydanticField(default_factory=list)
    cited_incidents: list[str] = PydanticField(default_factory=list)
    matched: list[MatchedIncident] = PydanticField(default_factory=list)
    recalled: list[RecalledMemory] = PydanticField(default_factory=list)
    steps: list[InvestigationStep] = PydanticField(default_factory=list)
    findings: list[CodeFinding] = PydanticField(default_factory=list)
    unknowns: list[str] = PydanticField(default_factory=list)
    project: str | None = None
    worked_fixes: list[FixRecord] = PydanticField(default_factory=list)  # from citable recalled incidents only
    failed_fixes: list[FixRecord] = PydanticField(default_factory=list)
    strong_match: bool = False
    memory_enabled: bool
    memory_unavailable: bool = False  # memory was requested but Hindsight could not be reached
    degraded: bool = False
    latency_ms: int


# ---------------------------------------------------------------- LLM output (validated before verification)


class DraftFix(BaseModel):
    action: str
    attempt_refs: list[str] = PydanticField(default_factory=list)


class DraftAvoid(BaseModel):
    action: str
    why: str
    attempt_refs: list[str] = PydanticField(default_factory=list)


class DiagnosisDraft(BaseModel):
    """What the LLM returns. Evidence is expressed as attempt references so it can be verified exactly."""

    strong_precedent: bool = False
    precedent_ids: list[str] = PydanticField(default_factory=list)
    summary: str
    confidence: float = PydanticField(ge=0.0, le=1.0)
    hypotheses: list[Hypothesis] = PydanticField(default_factory=list)
    try_first: DraftFix | None = None
    avoid: list[DraftAvoid] = PydanticField(default_factory=list)
    unknowns: list[str] = PydanticField(default_factory=list)


# ---------------------------------------------------------------- API schemas


class IncidentCreate(BaseModel):
    alert_text: str = PydanticField(min_length=10, max_length=8000)
    service: str | None = None
    severity: str | None = None
    title: str | None = None
    on_call: str | None = None
    project_id: int | None = None
    origin: str | None = PydanticField(default=None, max_length=20)


class IncidentSummary(BaseModel):
    id: str
    title: str
    service: str
    severity: str
    status: str
    source: str
    created_at: datetime
    resolved_at: datetime | None
    root_cause: str | None
    ttr_minutes: int | None
    family: str | None = None
    origin: str | None = None
    project_id: int | None = None


class IncidentCreated(IncidentSummary):
    alert_text: str


class AttemptOut(BaseModel):
    id: int
    action: str
    outcome: str
    notes: str | None
    created_at: datetime


class DiagnosisRecord(BaseModel):
    id: int
    created_at: datetime
    diagnosis: Diagnosis


class IncidentDetail(IncidentSummary):
    alert_text: str
    on_call: str | None
    summary: str | None
    fix: str | None
    follow_ups: list[str]
    attempts: list[AttemptOut]
    diagnoses: list[DiagnosisRecord]


class AttemptCreate(BaseModel):
    action: str = PydanticField(min_length=3, max_length=1000)
    outcome: Outcome
    notes: str | None = PydanticField(default=None, max_length=2000)


class AttemptLogged(AttemptOut):
    memory_retained: bool


class PostmortemText(BaseModel):
    """What the LLM drafts; ttr_minutes is computed from timestamps, never by the model."""

    summary: str
    root_cause: str
    fix: str
    follow_ups: list[str] = PydanticField(default_factory=list)


class PostmortemDraft(PostmortemText):
    ttr_minutes: int
    drafted_by: str  # model name, or "session" when the LLM was unavailable


class ResolveRequest(BaseModel):
    summary: str = PydanticField(min_length=5, max_length=4000)
    root_cause: str = PydanticField(min_length=5, max_length=4000)
    fix: str = PydanticField(min_length=3, max_length=4000)
    follow_ups: list[str] = PydanticField(default_factory=list)
    ttr_minutes: int | None = PydanticField(default=None, ge=0)
    retain: bool = True  # "Save as engineering experience"; False resolves without writing to Hindsight


class ExperienceCaptured(BaseModel):
    incident_id: str
    pattern: str
    worked_fixes: list[str]
    failed_fixes: list[str]
    retained_text: str
    memory_retained: bool
    memory_count_before: int | None
    memory_count_after: int | None


class ProjectCreate(BaseModel):
    root_path: str = PydanticField(min_length=3, max_length=1000)
    name: str | None = PydanticField(default=None, max_length=100)
    scope: ProjectScope = "always"


class ProjectOut(BaseModel):
    id: int
    name: str
    root_path: str
    scope: str
    created_at: datetime


class LogContext(BaseModel):
    path: str
    lines: list[str]
    error_count: int
    latest: str | None  # timestamp text of the newest error line, if the log has timestamps


class GitContext(BaseModel):
    branch: str
    recent_commits: list[str]


class ProjectContext(BaseModel):
    project: ProjectOut
    files_indexed: int
    log_errors: LogContext | None
    git: GitContext | None


class MemoryEvent(BaseModel):
    id: int
    kind: MemoryEventKind
    detail: str
    ok: bool
    count: int | None
    incident_id: str | None
    created_at: datetime


class Pattern(BaseModel):
    text: str
    incident_ids: list[str]
    proof_count: int
    updated_at: datetime | None


class PatternsResponse(BaseModel):
    patterns: list[Pattern]
    observation_count: int
    summary: str | None  # Hindsight reflect over the whole bank; None when reflect is unavailable
    memory_count: int | None


class MemoryStats(BaseModel):
    bank_id: str
    memory_count: int | None
    observation_count: int | None
    available: bool
    demo_tools: bool = False  # Seed and Reset buttons; disabled with DEMO_TOOLS=false in production


class SeedResult(BaseModel):
    status: Literal["success", "already_seeded"]
    bank: str
    created: int
    skipped: int
    memory_count: int | None
    log: list[str]


class LearningPoint(BaseModel):
    diagnosis_id: int
    incident_id: str
    memory_enabled: bool
    confidence: float | None
    cited_count: int
    strong_match: bool
    degraded: bool
    latency_ms: int
    created_at: datetime


class AskRequest(BaseModel):
    question: str = PydanticField(min_length=3, max_length=2000)


class PastIncident(BaseModel):
    """A past incident Hindsight recall returned, with its recorded outcomes from the fix log."""

    id: str
    title: str
    service: str
    occurred_at: datetime | None
    relevance: float | None
    learned_live: bool
    root_cause: str | None
    fix: str | None
    worked: list[str]
    failed: list[str]


class AskAnswer(BaseModel):
    question: str
    answer: str
    incidents: list[PastIncident]
    recalled_count: int
    memory_unavailable: bool
    latency_ms: int


class ApiError(BaseModel):
    error: str
    message: str
    detail: dict[str, Any] | None = None
