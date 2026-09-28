# BUILD_PHASES.md — Claude Code build instructions

## How to use this file

Run one phase per Claude Code session. Paste the phase's prompt exactly as written. Do not move on until the "Done when" check passes.

Before phase 0, place these files in the repo:

- `CLAUDE.md` at the repo root
- `docs/PRD.md`
- `docs/BUILD_PHASES.md`

Every prompt assumes Claude Code has read `CLAUDE.md`.

---

## Phase 0 — Setup and scaffold (about 2 h)

**Do this yourself first**

1. Sign up at https://ui.hindsight.vectorize.io.
2. Register, then add promo code `MEMHACK99` in the billing section ($50 of credits).
3. Copy the API base URL and API key from the Hindsight Cloud dashboard.
4. Create an OpenRouter API key at https://openrouter.ai/keys (done; it is in `.env` as `OPENROUTER_API_KEY`).
5. Create an empty GitHub repo named `oncall-copilot` and clone it.
6. Join the Hindsight Community Slack for questions about the client API.
7. Optional fallback: note how to run open-source Hindsight locally (https://github.com/vectorize-io/hindsight) in case Cloud credits or uptime become a problem during the demo.

**Prompt**

```
Read CLAUDE.md and docs/PRD.md fully.

Implement Phase 0 only:
1. Create the full folder structure from CLAUDE.md section 3 (empty packages are fine, but no placeholder logic).
2. backend: requirements.txt with the section 4 stack, app/config.py using pydantic-settings for every variable in section 5, app/main.py with a FastAPI app, CORS for FRONTEND_ORIGIN, and GET /api/health.
3. frontend: Vite + React + TypeScript strict + Tailwind + Framer Motion + lucide-react. Set up the color tokens and fonts (Inter, JetBrains Mono) from CLAUDE.md section 9. App.tsx renders a dark shell with a top bar showing "On-Call Copilot".
4. .env.example with every variable, .gitignore (env, db, node_modules, venv, dist).
5. scripts/hindsight_smoke.py: connects with HINDSIGHT_BASE_URL and HINDSIGHT_API_KEY, retains "Smoke test memory for On-Call Copilot" into bank "smoke-test", recalls it, prints the result, then exits 0 on success.
6. README.md skeleton with setup steps.

Verify the hindsight-client method names against the installed package before writing the smoke script.
Stop when the Done-when checks pass and show me the output.
```

**Done when**

- `python scripts/hindsight_smoke.py` prints the recalled smoke memory.
- `GET /api/health` returns `{"status":"ok"}`.
- `npm run dev` shows the dark shell.

---

## Phase 1 — Synthetic dataset (about 4 h)

**Prompt**

```
Read docs/PRD.md section 7 and CLAUDE.md section 10.

Implement Phase 1 only: create the synthetic dataset for Nimbus Pay.

1. data/incidents.json: exactly 45 incidents, INC-001 to INC-045, chronological from 2026-03-02 to 2026-09-20. Fields: id, title, service, severity, started_at, resolved_at (ISO 8601 with timezone), alert_text, on_call (one of 8 fictional engineers).
2. data/postmortems.json: one per incident. Fields: incident_id, summary, root_cause, timeline (list of {time, event}), attempts (list of {action, outcome: worked|failed|partial, notes}), fix, follow_ups, ttr_minutes.
3. Follow the 6 recurring families exactly as in the PRD table, with these requirements:
   - Redis family: spread the four Redis incidents across the timeline, with the last two dated 2026-08-12 and 2026-09-03. In both of those, "restart payments-api pods" is an attempt with outcome failed, and "raise REDIS_MAX_POOL from 20 to 50 and roll back worker concurrency" worked.
   - Give each family a distinct, realistic error signature in alert_text (for example "redis.exceptions.ConnectionError: Too many connections", "consumer group ledger-cg lag=184322", "OOMKilled exit code 137", "canceling statement due to lock timeout", "429 Too Many Requests from api.sendgrid.com", "x509: certificate has expired").
   - Later incidents in a family should reference earlier ones in their postmortems ("same as INC-0xx; follow-up was never done").
4. 27 one-off incidents with varied, realistic causes.
5. data/demo_alerts.json: exactly 3 alerts (DEMO-A, DEMO-B, DEMO-C) as described in PRD section 7. They must NOT appear in incidents.json.
6. scripts/validate_data.py: checks counts, ID format and order, that every incident has a postmortem, that resolved_at > started_at, that ttr_minutes matches the timestamps within 2 minutes, that family counts match the PRD, and that demo alerts are not in the history. Prints a summary table.

Write realistic, human postmortems: wrong first guesses, messy timelines. No lorem ipsum, no repeated boilerplate.
Stop when validate_data.py passes and show me its output plus the full postmortems for the two latest Redis incidents.
```

**Note:** done. The last two Redis incidents are INC-030 (2026-08-12) and INC-037 (2026-09-03), and docs/PRD.md, CLAUDE.md and ABOUT.md now use these IDs.

**Done when**

- `validate_data.py` passes.
- The two Redis postmortems read like real engineering writing.

---

## Phase 2 — Memory layer (about 4 h)

**Prompt**

```
Read CLAUDE.md section 6 carefully.

Implement Phase 2 only:
1. backend/app/services/memory.py: an async MemoryService wrapping hindsight-client. Methods:
   - ensure_bank()
   - retain_alert(incident)
   - retain_attempt(incident, attempt)
   - retain_postmortem(incident, postmortem)
   - recall_similar(alert_text, service) -> list[RecalledMemory]
   - reflect_diagnosis(alert_text, service) -> str
   - reflect_free(query) -> str
   - memory_count() -> int
   Each method follows the conventions in section 6.2 exactly, and each retained memory is written as clear natural-language sentences including the incident ID, service, date and error signature. Map recall results to RecalledMemory, extracting incident_id from document_id or the text.
2. Timeouts and errors: wrap every call; on failure, raise a typed MemoryUnavailable error that callers can turn into a readable UI state.
3. scripts/seed_hindsight.py: creates the bank with the mission, disposition and directives from section 6.1, then retain_batch-es every postmortem with timestamp = resolved_at. Uses retain_async=False so recall works right after. Prints progress.
4. scripts/reset_bank.py: deletes the nimbus-oncall bank if the client supports it (otherwise creates a fresh bank id with a suffix and prints the new id to put in .env), then runs the seed.
5. scripts/memory_probe.py: runs recall and reflect for DEMO-A, DEMO-B and DEMO-C and prints the top 5 recalled memories (incident ID, date, type, text) and the reflect answer for each.
6. pytest tests for the mapping and content-formatting helpers (no network).

Verify every hindsight-client method and parameter against the installed version first.
Stop when memory_probe.py runs and show me the full output.
```

**Done when**

- For DEMO-A, the top recalled memories include both late Redis incidents.
- For DEMO-A, reflect mentions that restarting pods failed.
- For DEMO-C, there is no strong match.

If recall quality is weak, tune the retained text (more explicit error signatures and service names) and reseed. Do not move on until DEMO-A is clearly right.

---

## Phase 3 — Diagnosis API (about 6 h)

**Prompt**

```
Read CLAUDE.md sections 7 and 8 and docs/PRD.md sections 4, 5 and 11.

Implement Phase 3 only:
1. app/models.py: SQLModel tables (incidents, attempts, diagnoses) and all Pydantic schemas from CLAUDE.md section 8, plus request/response models for every endpoint.
2. app/db.py and startup table creation. On startup, if the incidents table is empty, import data/incidents.json as resolved history rows AND every postmortem attempt into the attempts table, so the evidence check covers history.
3. app/services/llm.py: LLMService (OpenRouter over httpx) with
   - format_diagnosis(alert_text, service, recalled, matched, attempts_by_incident, reflect_text) -> Diagnosis
   - baseline_diagnosis(alert_text, service) -> Diagnosis (memory off; must not mention incident IDs)
   - draft_postmortem(incident, attempts, diagnosis) -> PostmortemDraft
   Follow the CLAUDE.md section 7 call rules for Nemotron, include the JSON schema in the system prompt, validate with Pydantic, apply primary -> fallback -> degraded. The prompt gives the LLM the attempt log (action + outcome) of each matched incident and forbids citing any ID not in the matched list.
4. app/services/evidence.py: pure functions implementing the CLAUDE.md section 8 evidence rule (verify IDs against recall and the attempt log, drop unverified Avoid items, recompute cited_incidents), plus matched_incidents(recalled) that groups recalled memories by incident and takes the best reranker relevance.
5. app/services/diagnosis.py: the investigation orchestrator as an async generator of NDJSON events, one per step: parse (no LLM), recall, evidence, reflect (budget "low", started concurrently with recall), diagnosis. Each event carries the step's detail and duration_ms; the final event carries the full Diagnosis. Save the diagnosis row.
6. app/routers/incidents.py: every endpoint in PRD section 5 except /api/patterns. POST /diagnose returns a StreamingResponse (application/x-ndjson).
7. MemoryUnavailable -> a readable {"step":"error","error":"memory_unavailable","message":"..."} event (or HTTP 503 on non-streaming endpoints); LLM total failure -> a degraded Diagnosis, never a 500.
8. pytest: evidence rule unit tests (unverified IDs dropped, Avoid without failed evidence removed, counts correct) and endpoint tests with Hindsight and the LLM mocked at the service boundary (mocks only in tests).

Stop when these checks work and show me the outputs:
- create an incident from DEMO-A
- stream diagnose with memory=true: print each event as it arrives with timestamps
- diagnose with memory=false (generic, no IDs)
```

**Done when**

- Memory on for DEMO-A: Avoid "restart pods" with verified evidence [INC-003, INC-014, INC-030, INC-037]; Try First with verified worked evidence; matched incidents show real relevance values.
- The recall event arrives within about 2 s and the final diagnosis within about 20 s (measured: 12-19 s).
- Memory off returns valid JSON with no incident IDs.

---

## Phase 4 — Learning loop (about 4 h)

**Prompt**

```
Implement Phase 4 only: the learning loop.
1. POST /api/incidents/{id}/attempts: saves the attempt and retains it via MemoryService.retain_attempt, written like "During INC-0xx on payments-api (2026-09-28), the on-call engineer tried: <action>. Outcome: <outcome>. <notes>".
2. POST /api/incidents/{id}/postmortem-draft: returns an LLM-drafted postmortem from the incident, its attempts and its latest diagnosis.
3. POST /api/incidents/{id}/resolve: saves the root cause, fix, ttr_minutes and follow-ups, marks the incident resolved, retains the postmortem (including its failed and worked attempts), and returns the Experience Captured payload: pattern (root cause in one line), worked fixes, failed fixes, the exact retained text, and memory_count before and after.
4. GET /api/memory/stats also returns the observation count (list_memories type="observation").
5. scripts/learning_check.py: the proof script. It
   a) resets the bank
   b) creates an incident from DEMO-C (search-api) and diagnoses it (expect low confidence, "no strong precedent", no Avoid)
   c) logs "purged the CDN cache: failed" and "fixed the CDN origin host header / SNI: worked", then resolves with a realistic postmortem
   d) waits for retention to finish
   e) creates an incident from DEMO-C's follow_up_alert (checkout-web, different wording) and diagnoses it
   f) prints both diagnoses side by side and asserts the second cites the resolved incident, has higher confidence, and has a verified Avoid for the cache purge
Stop when learning_check.py passes and show me the side-by-side output.
```

**Done when**

- `learning_check.py` shows the agent learned from one resolved incident and applied it to a different service.

---

## Phase 5 — Frontend (about 8 h)

**Prompt**

```
Read CLAUDE.md section 9 and docs/PRD.md section 6 fully.

Implement Phase 5 only: the complete frontend.
1. src/lib/types.ts mirrors the backend schemas; src/lib/api.ts is a typed client for every endpoint with error handling that returns typed error states.
2. Pages: Console (default route), History, IncidentDetail. Use react-router.
3. P0 components (build and verify these first):
   - TopBar: product name, bank name, memory count from /api/memory/stats, and MemoryToggle (a teal switch labelled "Memory").
   - AlertInput: monospace textarea, service and severity selects, three DemoAlert chips from /api/demo-alerts, and a "Diagnose" button (Cmd/Ctrl+Enter submits).
   - InvestigationTimeline: consumes the NDJSON stream (fetch + ReadableStream reader) and renders parse, recall, evidence, reflect, diagnosis as they arrive, each with its detail and duration; the running step shows a live timer and context text ("Hindsight is reasoning over 4 matching incidents").
   - DiagnosisCard: summary + confidence bar, hypotheses with evidence chips, a green Try First card with outcome buttons (Worked, Didn't work, Note) that record and retain the attempt, and a red Avoid card listing each fix with "Failed in N incidents" and the verified chips. Degraded mode: plain text card. Memory off: muted grey card labelled "Without memory".
   - MemoryPanel "Why I think this": matched incidents with relevance percentage, date and relative age, then memory cards (incident chip, type badge, text) with staggered entrance; the empty-state copy is from CLAUDE.md.
   - Compare view: the same incident diagnosed with memory off and on, side by side, with an impact row computed from the two payloads (incidents cited, verified warnings, has Try First).
   - LearningCurve: a compact strip from GET /api/learning (confidence and verified citation count per diagnosis; plain SVG or Tailwind bars, no chart library). Memory-off diagnoses render grey.
   - ResolveDrawer + ExperienceCaptured: the drawer loads the postmortem draft with editable fields; on submit, show the Experience Captured card from the resolve response and the toast "Saved to memory. The next similar incident will know this."
   - History: incidents newest first; rows open IncidentDetail with the alert, attempts, diagnoses and postmortem.
4. P1, only after the P0 demo clicks through end to end:
   - IncidentSimulator: "Simulate incident" on a demo chip replays its signals over about 4 s, labelled "Simulated signals", then creates the incident and starts the diagnosis.
   - Patterns page: GET /api/patterns (observations grouped by service they mention, plus the patterns reflect answer with incident chips). Implement the backend endpoint in this phase.
5. Never a blank screen. Responsive to 1280 px as the primary target; must not break at 768 px.
Lucide icons only. No emojis. No placeholder copy.
Stop when the full 3-minute demo in docs/PRD.md section 8 can be clicked through end to end in the browser. Walk me through it step by step with what you verified.
```

**Done when**

- You personally click through the whole demo in PRD section 8 twice without errors.
- Every number on screen can be traced to a response field (no hardcoded statistics).

---

## Phase 6 — Polish, deploy, submit (about 4 h)

**Prompt**

```
Implement Phase 6 only:
1. Polish: consistent spacing, focus rings, hover states, transition timings per CLAUDE.md section 9, a favicon using a Lucide icon rendered to SVG, and the page title "On-Call Copilot".
2. Error states: test with Hindsight unreachable (wrong URL) and the OpenRouter key invalid; both must show readable UI states.
3. Deploy config: a render.yaml (or railway.json) for the backend and vercel.json for the frontend, with the env vars documented. Note that SQLite is fine for the demo, but the data resets on redeploy, so run the seed on start.
4. README.md final: problem, a 60-second pitch, an architecture diagram (Mermaid), setup in 5 commands, a "How Hindsight memory is used" section that maps every retain/recall/reflect call to a feature (from CLAUDE.md section 6.3), the demo script, a demo video link placeholder heading, and the team.
5. docs/HINDSIGHT_USAGE.md: a standalone, judge-friendly explanation of the memory design with the before/after example and the learning-curve result from learning_check.py.
6. Code cleanliness pass (judges check for "clean, documented code"): module docstrings on every backend module, no dead code, consistent naming, and pytest plus typecheck both green.
7. Check every item in CLAUDE.md section 1.1 and PRD section 10, and list any that are still open.
Stop and show me the final README and the checklist status.
```

**Done when**

- The live URLs work from a phone.
- The demo video is recorded.
- The content deliverables are started: an article, social post and video per team member, following the official content guide (see the PRD checklist).

---

## Rescue prompts

- **Bug:** "Reproduce the bug first with a failing test or script, then fix it, then show the passing run. Do not change unrelated files."
- **Recall quality is bad:** "Run scripts/memory_probe.py, show the output, then improve how memories are written in memory.py (more explicit service, error signature, outcome), reseed, and rerun the probe."
- **The model invents IDs:** "Tighten the llm.py system prompt, and confirm the post-parse filter drops any cited ID not in the recalled set. Add a test."
- **Scope creep:** "Stop. Re-read CLAUDE.md section 2. Finish the current phase's Done-when check before anything else."