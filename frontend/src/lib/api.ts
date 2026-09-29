// Typed client for every backend endpoint. Failures come back as readable ApiError values, never throws.
import type {
  ApiError,
  ApiResult,
  AskAnswer,
  AssistAnswer,
  AttemptLogged,
  DemoAlert,
  Diagnosis,
  ExperienceCaptured,
  IncidentCreated,
  IncidentDetail,
  IncidentSummary,
  LearningPoint,
  MemoryEvent,
  MemoryOverview,
  MemoryStats,
  ProjectContext,
  ProjectOut,
  Outcome,
  PatternsResponse,
  PostmortemDraft,
  ResolveRequest,
  SeedResult,
  StreamEvent,
} from "./types";

export const API_BASE: string = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

const UNREACHABLE: ApiError = {
  error: "backend_unreachable",
  message: `The backend is not reachable at ${API_BASE}. Start it with uvicorn on port 8000.`,
};

function isApiError(value: unknown): value is ApiError {
  return typeof value === "object" && value !== null && "error" in value && "message" in value;
}

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    return {
      ok: false,
      error: isApiError(body) ? body : { error: `http_${response.status}`, message: `Request failed (${response.status}).` },
    };
  }
  return { ok: true, data: body as T };
}

const post = <T>(path: string, payload?: unknown): Promise<ApiResult<T>> =>
  request<T>(path, { method: "POST", body: payload === undefined ? undefined : JSON.stringify(payload) });

export const api = {
  health: () => request<{ status: string }>("/api/health"),
  stats: () => request<MemoryStats>("/api/memory/stats"),
  demoAlerts: () => request<DemoAlert[]>("/api/demo-alerts"),
  learning: () => request<LearningPoint[]>("/api/learning"),
  patterns: () => request<PatternsResponse>("/api/patterns"),
  incidents: () => request<IncidentSummary[]>("/api/incidents"),
  incident: (id: string) => request<IncidentDetail>(`/api/incidents/${encodeURIComponent(id)}`),
  createIncident: (payload: { alert_text: string; service?: string; severity?: string; project_id?: number; origin?: string }) =>
    post<IncidentCreated>("/api/incidents", payload),
  projects: () => request<ProjectOut[]>("/api/projects"),
  projectContext: (id: number) => request<ProjectContext>(`/api/projects/${id}/context`),
  memoryEvents: (limit = 30) => request<MemoryEvent[]>(`/api/memory/events?limit=${limit}`),
  memoryOverview: () => request<MemoryOverview>("/api/memory/overview"),
  ask: (question: string) => post<AskAnswer>("/api/memory/ask", { question }),
  assist: (payload: { question: string; screen_text?: string; incident_id?: string; project_id?: number }) =>
    post<AssistAnswer>("/api/assist", payload),
  seedMemory: () => post<SeedResult>("/api/memory/seed"),
  resetDemo: () => post<{ memories: number; live_incidents_removed: number; log: string[] }>("/api/demo/reset", { confirm: "reset" }),
  readScreen: (imageDataUrl: string) =>
    post<{ found: boolean; summary: string; text: string; model: string }>("/api/context/screen", { image_data_url: imageDataUrl }),
  logAttempt: (id: string, payload: { action: string; outcome: Outcome; notes?: string }) =>
    post<AttemptLogged>(`/api/incidents/${encodeURIComponent(id)}/attempts`, payload),
  postmortemDraft: (id: string) => post<PostmortemDraft>(`/api/incidents/${encodeURIComponent(id)}/postmortem-draft`),
  resolve: (id: string, payload: ResolveRequest) =>
    post<ExperienceCaptured>(`/api/incidents/${encodeURIComponent(id)}/resolve`, payload),
};

/** Fields added in later backend versions default to empty, so an older backend degrades instead of crashing views. */
function withDiagnosisDefaults(d: Diagnosis): Diagnosis {
  return {
    ...d,
    hypotheses: d.hypotheses ?? [],
    avoid: d.avoid ?? [],
    cited_incidents: d.cited_incidents ?? [],
    matched: (d.matched ?? []).map((m) => ({ ...m, learned_live: m.learned_live ?? false })),
    recalled: d.recalled ?? [],
    steps: d.steps ?? [],
    findings: d.findings ?? [],
    unknowns: d.unknowns ?? [],
    worked_fixes: d.worked_fixes ?? [],
    failed_fixes: d.failed_fixes ?? [],
    memory_unavailable: d.memory_unavailable ?? false,
  };
}

/**
 * Streams the investigation as NDJSON events. Every failure is delivered as an "error" event,
 * so callers only handle events.
 */
export async function streamDiagnosis(
  incidentId: string,
  memory: boolean,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(
      `${API_BASE}/api/incidents/${encodeURIComponent(incidentId)}/diagnose?memory=${memory}`,
      { method: "POST", signal },
    );
  } catch {
    if (!signal?.aborted) onEvent({ type: "error", ...UNREACHABLE });
    return;
  }
  if (!response.ok || !response.body) {
    onEvent({ type: "error", error: `http_${response.status}`, message: "The investigation could not be started." });
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const event = JSON.parse(line) as StreamEvent;
          if (event.type === "diagnosis") event.diagnosis = withDiagnosisDefaults(event.diagnosis);
          if (event.type !== "step") finished = true;
          onEvent(event);
        }
        newline = buffer.indexOf("\n");
      }
    }
  } catch {
    if (!signal?.aborted) {
      onEvent({ type: "error", error: "stream_interrupted", message: "The connection to the backend was interrupted." });
    }
    return;
  }
  if (!finished && !signal?.aborted) {
    onEvent({ type: "error", error: "stream_incomplete", message: "The investigation ended without a diagnosis." });
  }
}
