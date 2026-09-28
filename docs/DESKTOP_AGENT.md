# On-Call Copilot 2.0: desktop engineering memory agent

Tagline: **Your engineering team's memory, always one shortcut away.**

This document records the architecture audit and the staged plan for turning the web console into a desktop-first agent. The web console, History and Patterns stay; the desktop layer is added on top.

## 1. Audit of what exists (before 2.0)

| Layer | State |
| --- | --- |
| Frontend | React 18, Vite, TypeScript strict, Tailwind, Framer Motion, lucide-react. Routes: Console, History, Patterns, incident detail. No Electron. |
| Backend | FastAPI. Routers `incidents.py`, `patterns.py`. Services `memory.py` (only Hindsight importer), `llm.py` (only OpenRouter caller), `evidence.py` (verification rules), `diagnosis.py` (streamed investigation). |
| Hindsight | Bank `nimbus-oncall`: mission, disposition, 4 directives, 45 seeded postmortems. Calls used: `retain_batch`, `retain` (alert, fix-attempt, postmortem), `recall`, `reflect` (with a `response_schema` verdict), `list_memories`. |
| Database | SQLite tables `incidents`, `attempts`, `diagnoses`. History and attempts are imported from `data/` on first start. |
| Diagnosis | parse, then recall (plus reflect in parallel), evidence, reflect verdict, LLM format, then verification (attempt references, precedent rule, free-text scrub). |
| Demo | DEMO-A (Redis), DEMO-B (Kafka), DEMO-C (CDN) plus a follow-up on checkout-web. `reset_bank.py`, `learning_check.py`, `stream_diagnosis.py`. |

The INC-042 and INC-051 mismatch mentioned in the upgrade prompt was already fixed in Phase 1: the Redis precedents are INC-030 (12 Aug) and INC-037 (3 Sep), and live incidents start at INC-046.

## 2. Target flow

```
shortcut -> overlay opens immediately
         -> context: active window, authorized project, project logs, clipboard or selection, screen (vision, on request)
         -> Hindsight recall -> fix log evidence -> project inspection (config and code that past fixes touched)
         -> Hindsight reflect verdict -> diagnosis (Known / Likely / Unknown, Try first, Avoid, Check here)
         -> engineer acts in their editor -> Worked / Didn't work -> Resolve and learn -> Hindsight retain
         -> next similar incident recalls the new experience
```

## 3. Decisions and deviations (read before changing)

| Topic | Decision | Why |
| --- | --- | --- |
| Shortcut | `Ctrl+Space` by default, configurable with `ONCALL_SHORTCUT` in `.env` | The prompt asks for it. Warning: a global `Ctrl+Space` takes over VS Code's "Trigger Suggest" and some Windows input-method switching while the app runs. `Ctrl+Shift+Space` is the safe alternative. |
| "Hold" | The shortcut toggles the overlay (press to open, Escape or press again to close) | Electron global shortcuts fire on press only; there is no key-up event for global hotkeys. |
| Demo project language | `demo/nimbus-pay` keeps `payments-api` in Python with Helm values, not `redis/connectionPool.ts` | The 45 seeded incidents describe redis-py, `idempotency.py` and `REDIS_MAX_POOL` in Helm values. A TypeScript file would contradict the team's own memory. The agent finds `REDIS_MAX_POOL: "20"` in `deploy/helm/payments-api/values-prod.yaml`. |
| How "Check here" is found | Deterministic: the config identifiers that past fixes changed (for example `REDIS_MAX_POOL` in INC-030 and INC-037) are searched in the authorized project, and the current values are shown next to the historical changes | It is grounded and repeatable, it works without a vision model, and it can never point at a file that was not actually read. |
| Error context | Priority: clipboard or selection that looks like an error, then recent errors in the project's `logs/*.log`, then screen capture with a vision model (P1, on request only) | The first two are reliable and fast. Vision is useful but slow and rate-limited on the free tier. |
| IDE chat | No scraping of IDE chat databases. "Capture context" in the overlay takes selected or copied conversation text, which is then turned into a structured experience (P1) | The prompt forbids pretending to read private chats. |
| Project access | The desktop app asks (Allow once, Always allow, Cancel) through a native dialog, and the backend only reads inside registered roots, with path-traversal checks | Never scan arbitrary folders. |
| Memory graph | Built as the Memory page (P1). Earlier this was cut in PRD section 11; the 2.0 prompt explicitly asks for it | User decision. It is built from real data only. |
| Secrets | Every retain goes through a redaction filter first | Memory privacy. |

## 4. Stages

| Stage | Scope | Done when |
| --- | --- | --- |
| A | Demo project `demo/nimbus-pay` with a service simulator that reads the real config and writes real logs | Running the simulator with the pool at 20 and concurrency at 24 logs Redis errors; after the fix it logs healthy latency |
| B | Backend: `projects` table and API with scoped file access, a project context service (tree, search, read, log errors, git), an `inspect` step in the investigation, `findings` and `unknowns` in the diagnosis, secret redaction, a memory event log, and `POST /api/context/incident` | Tests pass; the streamed diagnosis for the demo project includes `REDIS_MAX_POOL` at the right file and line |
| C | Electron shell: main window plus overlay window, global shortcut, active-window detection, clipboard, project consent dialog, open file at line | The app starts, the shortcut opens the overlay, Escape closes it |
| D | Overlay UI: idle, context, recall, investigate, diagnosis, resolution and learning states, with Check here and Open File | The acceptance flow works in the overlay |
| E | Resolve and learn from the overlay, second-incident proof | The second incident's diagnosis cites the incident resolved minutes earlier |
| F (P1) | Screen capture with vision, Memory page, experience growth, conversation capture, system status | Each shows only real operations |

## 5. Status (2026-09-28)

| Stage | Result |
| --- | --- |
| A | Done. The simulator logs the real redis-py error at pool 20 and 24 workers, and logs healthy latency after the fix. |
| B | Done. 49 backend tests. The inspect step finds `REDIS_MAX_POOL: "20"` at `values-prod.yaml:19` with the INC-030 and INC-037 history. |
| C | Done. Electron 33 shell. `Control+Space` registered; the overlay opened in 109 ms. A key press could not be injected from the automation shell (it is not attached to the interactive desktop), so the physical shortcut still needs one manual check. |
| D | Done. All overlay states, verified in the browser and in Electron. |
| E | Done. Live run: resolve, retain (memory 225 to 228), then a second incident whose Try first and Check here cite the incident learned a minute earlier (INC-046). |
| F | Screen reading (vision endpoint and overlay button), Memory page with growth chart and Hindsight activity log, system status and Reset demo are done. The vision path has not been run live, to save free-tier requests. Conversation capture into a structured experience is not built yet. |

Known limits: active-window detection is Windows-only; git context is empty for the demo folder because the repository has no commits yet; "Open file" at a line needs the VS Code `code` command on PATH (present on the dev machine).
