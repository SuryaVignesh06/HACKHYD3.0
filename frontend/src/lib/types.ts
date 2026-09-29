// Mirrors backend/app/models.py. Keep in sync when the backend schemas change.

export type Outcome = "worked" | "failed" | "partial";
export type StepName = "parse" | "recall" | "evidence" | "inspect" | "reflect" | "diagnosis";

export interface SnippetLine {
  no: number;
  text: string;
}

export interface CodeFinding {
  path: string;
  abs_path: string;
  line: number;
  identifier: string;
  current_value: string | null;
  snippet: SnippetLine[];
  related_incidents: string[];
  history: string[];
  note: string;
}

export interface ProjectOut {
  id: number;
  name: string;
  root_path: string;
  scope: "once" | "always";
  created_at: string;
}

export interface LogContext {
  path: string;
  lines: string[];
  error_count: number;
  latest: string | null;
}

export interface ProjectContext {
  project: ProjectOut;
  files_indexed: number;
  log_errors: LogContext | null;
  git: { branch: string; recent_commits: string[] } | null;
}

export interface MemoryEvent {
  id: number;
  kind: "recall" | "reflect" | "retain";
  detail: string;
  ok: boolean;
  count: number | null;
  incident_id: string | null;
  created_at: string;
}

export interface Hypothesis {
  cause: string;
  confidence: number;
  evidence: string[];
}

export interface FixSuggestion {
  action: string;
  source: string | null;
  evidence: string[];
}

export interface AvoidFix {
  action: string;
  why: string;
  evidence: string[];
}

export interface RecalledMemory {
  text: string;
  type: string;
  incident_id: string | null;
  occurred_at: string | null;
  relevance: number | null;
}

export interface MatchedIncident {
  id: string;
  title: string | null;
  service: string | null;
  relevance: number;
  occurred_at: string | null;
  learned_live: boolean;
}

export interface FixRecord {
  action: string;
  incident_id: string;
  outcome: Outcome;
  notes: string | null;
}

export interface InvestigationStep {
  name: StepName;
  detail: string;
  duration_ms: number;
}

export interface Diagnosis {
  summary: string;
  confidence: number | null;
  hypotheses: Hypothesis[];
  try_first: FixSuggestion | null;
  avoid: AvoidFix[];
  cited_incidents: string[];
  matched: MatchedIncident[];
  recalled: RecalledMemory[];
  steps: InvestigationStep[];
  findings: CodeFinding[];
  unknowns: string[];
  project: string | null;
  worked_fixes: FixRecord[];
  failed_fixes: FixRecord[];
  strong_match: boolean;
  memory_enabled: boolean;
  memory_unavailable: boolean;
  degraded: boolean;
  latency_ms: number;
}

export interface IncidentSummary {
  id: string;
  title: string;
  service: string;
  severity: string;
  status: "open" | "resolved";
  source: "history" | "live";
  created_at: string;
  resolved_at: string | null;
  root_cause: string | null;
  ttr_minutes: number | null;
  family: string | null;
  origin: string | null;
  project_id: number | null;
}

export interface IncidentCreated extends IncidentSummary {
  alert_text: string;
}

export interface AttemptOut {
  id: number;
  action: string;
  outcome: Outcome;
  notes: string | null;
  created_at: string;
}

export interface AttemptLogged extends AttemptOut {
  memory_retained: boolean;
}

export interface DiagnosisRecord {
  id: number;
  created_at: string;
  diagnosis: Diagnosis;
}

export interface IncidentDetail extends IncidentSummary {
  alert_text: string;
  on_call: string | null;
  summary: string | null;
  fix: string | null;
  follow_ups: string[];
  attempts: AttemptOut[];
  diagnoses: DiagnosisRecord[];
}

export interface MemoryStats {
  bank_id: string;
  memory_count: number | null;
  observation_count: number | null;
  available: boolean;
  demo_tools: boolean;
}

export interface SeedResult {
  status: "success" | "already_seeded";
  bank: string;
  created: number;
  skipped: number;
  memory_count: number | null;
  log: string[];
}

export interface LearnedExperience {
  id: string;
  title: string;
  service: string;
  root_cause: string | null;
  fix: string | null;
  resolved_at: string | null;
  worked: number;
  failed: number;
}

export interface LearningPoint {
  diagnosis_id: number;
  incident_id: string;
  memory_enabled: boolean;
  confidence: number | null;
  cited_count: number;
  strong_match: boolean;
  degraded: boolean;
  latency_ms: number;
  created_at: string;
}

export interface PostmortemDraft {
  summary: string;
  root_cause: string;
  fix: string;
  follow_ups: string[];
  ttr_minutes: number;
  drafted_by: string;
}

export interface ResolveRequest {
  summary: string;
  root_cause: string;
  fix: string;
  follow_ups: string[];
  ttr_minutes: number | null;
  retain?: boolean;
}

export interface ExperienceCaptured {
  incident_id: string;
  pattern: string;
  worked_fixes: string[];
  failed_fixes: string[];
  retained_text: string;
  memory_retained: boolean;
  memory_count_before: number | null;
  memory_count_after: number | null;
}

export interface DemoSignal {
  at_ms: number;
  level: "info" | "warn" | "critical";
  text: string;
}

export interface DemoAlert {
  id: string;
  title: string;
  service: string;
  severity: string;
  alert_text: string;
  expected: string;
  signals: DemoSignal[];
  follow_up_alert?: string;
  follow_up_service?: string;
}

export interface Pattern {
  text: string;
  incident_ids: string[];
  proof_count: number;
  updated_at: string | null;
}

export interface PatternsResponse {
  patterns: Pattern[];
  observation_count: number;
  summary: string | null;
  memory_count: number | null;
}

export interface FixOutcome {
  action: string;
  incident_id: string;
  outcome: Outcome;
}

export interface FamilyNode {
  family: string;
  label: string;
  incident_ids: string[];
  worked: FixOutcome[];
  failed: FixOutcome[];
  related_files: string[];
  first_seen: string | null;
  last_seen: string | null;
}

export interface ServiceNode {
  service: string;
  incident_count: number;
  families: FamilyNode[];
  other_incident_ids: string[];
}

export interface MemoryOverview {
  totals: {
    incidents_learned: number;
    fix_attempts: number;
    worked: number;
    failed: number;
    partial: number;
    families: number;
    live_incidents_learned: number;
    hindsight_memories: number | null;
    hindsight_observations: number | null;
  };
  services: ServiceNode[];
  growth: { at: string; incidents_learned: number; fixes_recorded: number }[];
  recent_learned: LearnedExperience[];
}

export interface RecallStepData {
  matched: MatchedIncident[];
  recalled: RecalledMemory[];
  unavailable?: boolean;
}

export interface EvidenceStepData {
  worked: number;
  failed: number;
  worked_fixes: FixRecord[];
  failed_fixes: FixRecord[];
}

export type StreamEvent =
  | { type: "step"; step: InvestigationStep; data: Record<string, unknown> }
  | { type: "diagnosis"; diagnosis: Diagnosis; diagnosis_id: number; alert_retained?: boolean }
  | { type: "error"; error: string; message: string };

export interface ApiError {
  error: string;
  message: string;
}

export interface PastIncident {
  id: string;
  title: string;
  service: string;
  occurred_at: string | null;
  relevance: number | null;
  learned_live: boolean;
  root_cause: string | null;
  fix: string | null;
  worked: string[];
  failed: string[];
}

export interface AskAnswer {
  question: string;
  answer: string;
  incidents: PastIncident[];
  recalled_count: number;
  memory_unavailable: boolean;
  latency_ms: number;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };
