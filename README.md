# On-Call Copilot

**Your engineering team's memory, always one shortcut away.**

On-Call Copilot is a desktop incident-response agent that remembers what your team learned the hard way: what failed, what worked, and why. When something breaks, press the shortcut. The Copilot reads your current context, recalls the team's past incidents from [Hindsight](https://hindsight.vectorize.io/), checks your project for the settings those incidents changed, and tells you:

- what is most likely happening, with the incidents that show it
- the fix to try first, and where it worked before
- the fixes to avoid, and where they failed
- where to look in your own code or config (file, line, current value)

You apply the fix, mark it Worked, and Resolve and learn: the experience is retained in Hindsight, and the next similar incident recalls it.

Built for "AI Agents That Learn Using Hindsight" (HackwithHyderabad 3.0). Product overview: [ABOUT.md](ABOUT.md). Desktop design and decisions: [docs/DESKTOP_AGENT.md](docs/DESKTOP_AGENT.md). Spec: [docs/PRD.md](docs/PRD.md).

## The problem

Engineering knowledge is scattered across past incidents, chat threads, logs, code and postmortems. At 3 AM the on-call engineer is often the one person who was not there last time, and teams repeat the same failed fix: the same pod restart, the same wrong rollback. A generic AI gives generic advice because it has no history.

## How it works

```
Desktop context (active window, project logs, clipboard, screen on request)
      |
Electron overlay (global shortcut)
      |
FastAPI agent ---- Hindsight: recall -> reflect -> retain
      |
Evidence engine: fix-attempt log + authorized project files
      |
LLM (formats only; every citation verified in code)
      |
Try first / Avoid / Check here  ->  engineer decides and acts
      |
Outcome + postmortem  ->  Hindsight retain  ->  better next incident
```

| Step | What happens | Where |
| --- | --- | --- |
| Context | Active application and window title, the authorized project's recent log errors, error-like clipboard text, or the screen read by a vision model when you ask | `desktop/src`, `routers/projects.py`, `routers/context.py` |
| Recall | Hindsight `recall` returns relevant memories with its own relevance score | `services/memory.py` |
| Evidence | The fix log of every matched incident: what worked, what failed | `services/diagnosis.py` |
| Inspect | The settings that past fixes changed (for example `REDIS_MAX_POOL`) are searched in your authorized project; the file, line and current value are shown | `services/project_context.py` |
| Reflect | Hindsight `reflect` reasons across the incidents and returns its own verdict on whether a real precedent exists | `services/memory.py` |
| Diagnosis | The LLM formats it; the backend keeps only claims backed by a recalled incident and a real attempt with the right outcome | `services/evidence.py` |
| Retain | Fix outcomes and the postmortem are retained (secrets redacted first); the next incident recalls them | `routers/incidents.py`, `services/redaction.py` |

### Why Hindsight

Hindsight is the memory: it stores every incident, attempt and postmortem, extracts facts, consolidates observations across incidents on its own, recalls by meaning with a relevance score, and reflects across memories under the bank's mission, directives and skeptical disposition. The LLM is not the memory. It only turns what Hindsight returns, plus the fix log and the project findings, into a structured answer, and the backend verifies every incident it cites.

## Desktop agent

```bash
cd desktop && npm install && npm start      # needs the backend on :8000 and the frontend dev server on :5173
```

- Press **Ctrl + Space** anywhere to open the overlay (set `ONCALL_SHORTCUT` in `.env` to change it; `Control+Shift+Space` avoids VS Code's own Ctrl+Space). Escape or the shortcut closes it. It opened in 109 ms in testing.
- **Connect project** asks with a native dialog (Allow once, Always allow, Cancel). The agent only reads inside connected folders, never writes, and rejects paths outside them.
- **Open file** jumps to the line in VS Code when its CLI is installed; otherwise the file opens in the default app and the UI says the line is not selected.
- **Read the error from my screen** captures the screen only when you click it and extracts the visible error with a vision model (`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`, fallback `google/gemma-4-31b-it:free`).
- The desktop app is Windows-first: active-window detection uses a Windows API. On other platforms the overlay says the active application is unavailable.

### Demo project

`demo/nimbus-pay` is a small fictional slice of the Nimbus Pay repo. `python demo/nimbus-pay/scripts/run_payments_api.py` simulates payments-api: with 24 workers and `REDIS_MAX_POOL: "20"` in `deploy/helm/payments-api/values-prod.yaml` it logs `redis.exceptions.ConnectionError: Too many connections`; fix the file and the errors stop. `scripts/deploy.py --set KEY=VALUE` simulates a new release (for the second incident).

**Reset demo** (Memory page, or `python scripts/reset_demo.py`) reseeds Hindsight, removes demo incidents and restores the demo project config. Connected projects are kept.

### Verified end to end (2026-09-28, live Hindsight and OpenRouter)

1. Project connected, simulator logging Redis errors; the overlay detected the project (9 files) and the error block in `logs/payments-api.log`.
2. Investigate: "I've seen this before." Try first: set `REDIS_MAX_POOL` and roll back `PAYMENTS_WORKER_CONCURRENCY` (worked in INC-030, INC-037). Avoid: pod restart (failed in INC-030, INC-037). Check here: `deploy/helm/payments-api/values-prod.yaml:19 REDIS_MAX_POOL: "20"`, with "INC-030: REDIS_MAX_POOL from 20 to 50".
3. The config was fixed and the simulator recovered (p99 373 ms). Worked, then Resolve and learn: retained, memory 225 to 228.
4. A new release raised concurrency to 32: the second diagnosis cited **INC-046** (the incident learned a minute earlier) for both the Try first and Check here.

## Status

| Phase | State |
| --- | --- |
| 0. Setup and scaffold | Done |
| 1. Synthetic dataset | Done |
| 2. Memory layer | Done |
| 3. Diagnosis API | Done |
| 4. Learning loop | Done |
| 5. Frontend | Done (including the P1 simulator and Patterns page) |
| 2.0 Desktop agent | Core done: overlay, shortcut, project access, inspect step, Resolve and learn, second-incident proof. Extras done: screen reading, Memory page, memory event log, Reset demo |
| 6. Polish and ship | Not started |

## Setup

You need Python 3.11 or newer (developed on 3.14) and Node 20 or newer.

```bash
cp .env.example .env                       # then fill in HINDSIGHT_API_KEY and OPENROUTER_API_KEY
python -m venv backend/.venv && backend/.venv/Scripts/pip install -r backend/requirements.txt   # on macOS/Linux: backend/.venv/bin/pip
backend/.venv/Scripts/python scripts/reset_bank.py      # creates the nimbus-oncall bank and loads 45 past incidents
cd backend && .venv/Scripts/python -m uvicorn app.main:app --reload --port 8000
cd frontend && npm install && npm run dev  # http://localhost:5173
```

## Scripts

| Script | Does |
| --- | --- |
| `scripts/generate_data.py` | Rebuilds `data/*.json` from the hand-written incident specs |
| `scripts/validate_data.py` | Checks counts, IDs, timelines, failure families and demo-alert isolation |
| `scripts/hindsight_smoke.py` | Retains and recalls one memory in a throwaway `smoke-test` bank |
| `scripts/seed_hindsight.py` | Configures the bank (mission, disposition, directives) and retains all 45 postmortems |
| `scripts/reset_bank.py` | Deletes the bank and reseeds it; run this before every demo take |
| `scripts/memory_probe.py` | Runs recall and reflect for DEMO-A, DEMO-B and DEMO-C and prints the results |
| `scripts/stream_diagnosis.py` | Creates an incident from a demo alert on the running backend and prints the investigation stream live (`DEMO-A`, `--memory off`, `--follow-up`) |

| `scripts/reset_demo.py` | Reset demo: reseeds the bank, removes live incidents and memory events, restores `demo/nimbus-pay` |
| `scripts/learning_check.py` | The learning proof: resets, diagnoses DEMO-C, records a failed and a worked fix, resolves, then diagnoses the follow-up alert on a different service and asserts the agent learned |

`reset_bank.py` also removes live incidents from SQLite. Restart the backend after running it.

## Learning loop (Phase 4 result)

`scripts/learning_check.py` on a freshly reset bank:

| | Before: DEMO-C on search-api | After one resolved incident: follow-up on checkout-web |
| --- | --- | --- |
| Precedent | None ("No strong precedent in memory.") | Confirmed: INC-046, relevance 97% |
| Confidence | 0.40 | 0.95 |
| Try first | none | Revert the CDN origin host header and SNI (worked in INC-046) |
| Avoid | none | Purging the CDN cache (failed in INC-046) |

Resolving INC-046 took the bank from 224 to 235 memories. The follow-up alert used different wording ("server name does not match certificate" instead of "SNI mismatch") on a different service, and it was still matched.

## Frontend

`cd frontend && npm install && npm run dev`, then open http://localhost:5173 with the backend running on port 8000.

| Page | What it shows |
| --- | --- |
| Console (`/`) | Demo alerts, each with a radio button that replays simulated monitoring signals before the incident opens; the diagnosis with a Try First card (Worked and Didn't work buttons) and an Avoid card listing the incidents where each fix failed; the live investigation timeline; "Why I think this" with matched incidents, Hindsight relevance and memory age; the action log; the learning-curve strip; and Resolve, which leads to Experience Captured |
| Memory on/off | Toggling memory after a diagnosis runs the other mode on the same incident and shows both side by side, with a memory-impact table computed from the two answers |
| History (`/history`) | All incidents, filterable, each opening a detail page with alert, attempts, diagnoses and postmortem |
| Patterns (`/patterns`) | Hindsight observations that span several incidents, plus a reflect answer over the whole bank, with incident IDs as chips |

Every incident ID anywhere in the UI is a chip that opens that incident in a side drawer without leaving the console.

## Diagnosis API

`POST /api/incidents/{id}/diagnose?memory=true` streams NDJSON events, one per investigation step, then the final diagnosis:

| Step | What happens | Measured (Phase 3) |
| --- | --- | --- |
| parse | Service, severity and error signature pulled from the alert, no LLM | under 1 ms |
| recall | Hindsight `arecall`; memories grouped by incident with Hindsight's reranker relevance | 0.7-2 s (one outlier at 6 s) |
| evidence | Fix-attempt log of every matched incident loaded from SQLite | under 5 ms |
| reflect | Hindsight `areflect` (budget low, started in parallel with recall) plus a structured precedent verdict | 9-12 s |
| diagnosis | LLM formats everything; the backend verifies every citation against recall and the attempt log | 3-9 s |

Live results on a freshly reset bank:

| Alert | Result | Total |
| --- | --- | --- |
| DEMO-A, memory off | Generic advice ("restart Redis if safe"), no incident IDs | 3.7 s |
| DEMO-A, memory on | Precedent confirmed. Try First: roll back concurrency and raise REDIS_MAX_POOL in the Helm values (worked in 4 incidents). Avoid: pod restart (failed in INC-003, INC-014, INC-030, INC-037), Redis failover (INC-014), and kubectl-only fixes (INC-030, INC-037) | 19 s |
| DEMO-B | Precedent confirmed. Try First: roll back LEDGER_BATCH_SIZE to 500. Avoid: scaling consumers (INC-007, INC-018). The INC-035 distractor was matched at 93% but not cited | 16 s |
| DEMO-C | "No strong precedent in memory.", confidence 0.35, no claims | 12 s |

Run the backend tests with `cd backend && .venv/Scripts/python -m pytest`.

## How Hindsight memory is used

All Hindsight calls live in [backend/app/services/memory.py](backend/app/services/memory.py).

| Moment | Call | Notes |
| --- | --- | --- |
| Seed history | `aretain_batch` | One item per postmortem: `document_id` = incident ID, `timestamp` = resolved time, `context` = `postmortem`, `metadata` = service and severity |
| Bank setup | `acreate_bank`, `acreate_directive` | Mission, disposition (skepticism 4, literalism 3, empathy 2) and four directives: cite incident IDs, warn about failed fixes, pair destructive commands with a rollback, say plainly when nothing matches |
| First diagnosis of a new incident | `aretain` | `context` = `alert`, `retain_async=True`, retained after the investigation so the incident never matches itself |
| Diagnose | `arecall` | Types world, experience and observation; budget mid; chunks included; the reranker score becomes the relevance shown in the UI |
| Diagnose | `areflect` | Budget low, service and alert as context, `response_schema` for Hindsight's own `strong_precedent` verdict |
| Fix attempt | `aretain` | `context` = `fix-attempt`, `metadata.outcome` = worked, failed or partial, `retain_async=True` so the outcome buttons stay fast |
| Resolve | `aretain` | `context` = `postmortem`, synchronous so the next diagnosis already knows; the response carries the retained text and the memory count before and after |
| Memory count | `alist_memories` | Total memories and observations in the bank, for the top bar and Experience Captured |
| Patterns page | `alist_memories(type="observation")` + `areflect` | Cross-incident observations Hindsight consolidated on its own, plus a reflect answer cached per memory count |

### Adaptations to hindsight-client 0.10.1

- Live retains for an incident that already has memories use `update_mode="append"`. Without it, retaining a fix attempt with the same `document_id` could replace the incident's earlier alert memory.
- Directives use the real directives API (`acreate_directive`), not the mission text. Untagged directives apply to every reflect call.
- Disposition is passed as `disposition_skepticism`, `disposition_literalism` and `disposition_empathy`.

### Measured results (Phase 2, 2026-09-28)

| Demo alert | Recall | Reflect |
| --- | --- | --- |
| DEMO-A, Redis pool exhaustion | Top results are INC-037, INC-014 and INC-030 | Cites INC-003, INC-014, INC-030 and INC-037 and warns that restarting pods failed every time |
| DEMO-B, Kafka lag after deploy | Top results are INC-034, INC-018 and INC-007 | Recommends rolling back the batch size to 500 and warns that scaling consumers failed in INC-007 and INC-018 |
| DEMO-C, CDN 502s on search-api | Only loosely related search-api incidents | States that no past incident matches the SNI mismatch |

Latency for DEMO-A: recall 0.9 s, reflect 8.9 s at budget low and 15.5 s at budget mid.

## LLM

The LLM only formats memory results into a structured diagnosis, drafts postmortems and produces the memory-off baseline. It runs on OpenRouter's free NVIDIA models: `nvidia/nemotron-3-super-120b-a12b:free` as primary and `nvidia/nemotron-3-ultra-550b-a55b:free` as fallback. Super was consistently faster in testing, and Ultra twice missed the 15 s deadline. See CLAUDE.md section 7 for the call rules.
