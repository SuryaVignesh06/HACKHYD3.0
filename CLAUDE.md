# CLAUDE.md — On-Call Copilot

Version 2.0 is a desktop-first engineering memory agent (tagline: "Your engineering team's memory, always one shortcut away"). The desktop design, decisions and deviations are in `docs/DESKTOP_AGENT.md`; read it before changing the desktop, overlay, project access or inspect code.

This file tells Claude Code how to work in this repository. Read it fully before every task. The full product spec is in `docs/PRD.md`. The phase-by-phase build plan is in `docs/BUILD_PHASES.md`.

---

## 1. What we are building

On-Call Copilot is an incident response agent that remembers every production incident a team has handled. An engineer pastes an alert, log or stack trace. The agent recalls similar past incidents from Hindsight memory, reasons over them, and returns:

- the likely root cause, with confidence
- the fix to try first
- fixes to avoid because they failed before
- the incident IDs it relied on

Every fix attempt and every postmortem is retained back into memory, so the agent improves with each resolved incident.

The one loop that must be undeniable (everything else is secondary): incident -> recall past experience -> compare what failed and what worked -> evidence-backed action -> human records the outcome -> retain -> better answer on the next incident. Positioning line: "Remember what failed, not just what worked." Scope decisions, including what was deliberately cut (LLM tool-calling loops, invented similarity numbers, knowledge-graph visuals), are in `docs/PRD.md` section 11. Do not re-add cut items.

This is a hackathon submission for "AI Agents That Learn Using Hindsight" (HackwithHyderabad 3.0, Vectorize). Hindsight memory must be central and visible. The judging weights are:

| Criterion | Weight | What judges look for |
| --- | --- | --- |
| Innovation | 30% | A fresh take on a real problem that goes beyond obvious chatbot territory |
| Use of Hindsight memory | 25% | Memory is central to the value, and the agent clearly improves over time |
| Technical implementation | 20% | Clean, well-architected, functional code that handles edge cases |
| User experience | 15% | Intuitive to use, and the demo tells a compelling story |
| Real-world impact | 10% | Solves a genuine problem, with a path to real adoption |

### 1.1 Hackathon requirements (from the official problem statement)

These are non-negotiable. Check every phase against them.

- **Hindsight is mandatory.** All memory goes through Hindsight. Hindsight Cloud is the default; the open-source version is an allowed fallback.
- **Any LLM is allowed.** The problem statement suggests Groq; we use OpenRouter with NVIDIA's free Nemotron 3 models (Super primary, Ultra fallback). The agent must handle function-calling and JSON errors without crashing (see section 7).
- **Memory is the star, not a feature.** There must be a clear before and after: without memory the agent is generic, and with memory it is dramatically better.
- **Show the learning curve.** The agent must visibly get better across interactions: the first answer is generic or cautious, and later answers are confident, specific and cited.
- **Recall context from days or weeks ago.** Recalled memories must show how old they are ("3 weeks ago") so judges can see long-term memory at work.
- **Value within 60 seconds.** The demo opens with the problem, then the agent solving it, then the agent getting smarter.
- **Realistic data.** Real-sounding names, numbers and error logs. The data is the number one thing that makes the project look real.
- **Tight scope.** One workflow, one persona, one value proposition, done brilliantly.
- **Submission:** a GitHub repo with clean, documented code, a demo video, a live demo to the judges, an explanation of how Hindsight memory is used, and an article, social post and video from every team member, as the official content guide describes.

## 2. Golden rules

1. Build one phase at a time, following `docs/BUILD_PHASES.md`. Do not start the next phase until the current phase's "Done when" check passes and you have shown the output.
2. No placeholder code. No `TODO`, no `pass`, no `// implement later`, no mock responses in production paths. Every function you write must work.
3. No emojis anywhere: code, UI copy, commits or docs.
4. Icons: Lucide only (`lucide-react`). No other icon libraries, no inline emoji icons.
5. Type everything. Use TypeScript strict mode on the frontend and Pydantic models plus type hints on the backend.
6. Never hardcode secrets. All keys come from `.env`, and `.env.example` documents every variable.
7. Keep it simple. Prefer fewer files and fewer abstractions. Do not add libraries not listed in section 4 without asking.
8. Every claim the agent makes in the UI must cite an incident ID. No citation means no claim.
9. The demo must never show a stack trace or a blank screen. Every failure path degrades to a readable state.
10. After each phase:
    - run the relevant checks
    - update `README.md` if setup changed
    - propose a commit message in the form `phase-N: short description`

## 3. Repository layout

```
oncall-copilot/
  CLAUDE.md
  README.md
  .env.example
  docs/
    PRD.md
    BUILD_PHASES.md
  data/
    incidents.json
    postmortems.json
    demo_alerts.json
  scripts/
    generate_data.py        # optional helper used in phase 1
    validate_data.py
    seed_hindsight.py
    reset_bank.py
  backend/
    pyproject.toml or requirements.txt
    app/
      main.py               # FastAPI app, CORS, router registration
      config.py             # settings from env (pydantic-settings)
      db.py                 # SQLModel engine + session
      models.py             # SQLModel tables + Pydantic API schemas
      routers/
        incidents.py
        patterns.py
        projects.py         # authorized projects (desktop header required), project context, memory event log
        context.py          # screen reading on request
        memory.py           # Memory page overview
        demo.py             # Reset demo
      services/
        memory.py           # the ONLY module that imports hindsight_client
        llm.py              # the ONLY module that calls OpenRouter (text and vision)
        diagnosis.py        # orchestrates parse -> recall -> evidence -> inspect -> reflect -> LLM format
        evidence.py         # deterministic verification rules (citations, precedent, scrub)
        project_context.py  # read-only, scoped access to authorized project folders; the Check here finder
        redaction.py        # secret redaction applied before every retain
      seeding.py            # seed and Reset demo, shared by scripts and POST /api/demo/reset
    tests/
  desktop/                  # Electron shell: console window, global-shortcut overlay, native bridge
    src/main.ts             # windows, shortcut, consent dialog, open-at-line, screen capture
    src/preload.ts          # the only bridge exposed to the web UI (window.copilot)
    src/activeWindow.ts     # foreground window via a long-lived PowerShell helper (Windows)
  demo/nimbus-pay/          # fictional project the agent inspects; scripts/run_payments_api.py simulates the service
  frontend/
    package.json
    vite.config.ts
    tailwind.config.ts
    src/
      main.tsx
      App.tsx
      lib/api.ts            # typed API client
      lib/types.ts          # mirrors backend schemas
      pages/Console.tsx
      pages/History.tsx
      pages/IncidentDetail.tsx
      components/           # AlertInput, DiagnosisCard, MemoryPanel, ActionLog, ResolveDrawer, MemoryToggle, TopBar, LearningCurve
```

## 4. Tech stack (fixed)

**Backend**

- Python 3.11 or newer (the dev machine runs 3.14; keep code 3.11-compatible)
- FastAPI and Uvicorn
- Pydantic v2 and pydantic-settings
- SQLModel on SQLite
- `hindsight-client`
- `httpx` (also used to call OpenRouter's OpenAI-compatible API; no LLM SDK)
- `pytest`

**Desktop**

- Electron 33 with TypeScript (`desktop/`), sandboxed renderer, context isolation, one preload bridge. No other desktop libraries.

**Frontend**

- React 18, Vite and TypeScript
- Tailwind CSS
- Framer Motion
- `lucide-react`
- The fetch API; no axios

**Services and hosting**

- Memory: Hindsight Cloud (`https://ui.hindsight.vectorize.io`). Fallback: self-hosted open-source Hindsight (`https://github.com/vectorize-io/hindsight`); switching only means changing `HINDSIGHT_BASE_URL`, so no code may assume Cloud-only features.
- LLM: OpenRouter (`https://openrouter.ai/api/v1/chat/completions`), free tier:
  - primary: `nvidia/nemotron-3-super-120b-a12b:free` (measured 3-9 s for a diagnosis; Ultra hit a 15 s deadline twice, so the order was swapped in Phase 3)
  - fallback: `nvidia/nemotron-3-ultra-550b-a55b:free`
  - Free models are rate limited by OpenRouter (roughly 20 requests per minute, and a small daily cap on accounts that have never bought credits). Keep dev and test calls lean, and mock the LLM in pytest.
- Hosting: Vercel for the frontend, Render or Railway for the backend

## 5. Environment variables

```
HINDSIGHT_BASE_URL=        # from the Hindsight Cloud dashboard
HINDSIGHT_API_KEY=         # from the Hindsight Cloud dashboard
HINDSIGHT_BANK_ID=nimbus-oncall
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL_PRIMARY=nvidia/nemotron-3-super-120b-a12b:free
LLM_MODEL_FALLBACK=nvidia/nemotron-3-ultra-550b-a55b:free
DATABASE_URL=sqlite:///./oncall.db
FRONTEND_ORIGIN=http://localhost:5173
VITE_API_BASE_URL=http://localhost:8000
```

## 6. Hindsight usage (the most important section)

All Hindsight calls live in `backend/app/services/memory.py`. Use the async methods (`aretain`, `arecall`, `areflect`) inside FastAPI.

Client setup:

```python
from hindsight_client import Hindsight

client = Hindsight(base_url=settings.HINDSIGHT_BASE_URL, api_key=settings.HINDSIGHT_API_KEY, timeout=30.0)
```

### 6.1 Bank configuration

Create the bank once, from `seed_hindsight.py` or `reset_bank.py`.

- `bank_id`: `nimbus-oncall`
- `name`: `Nimbus On-Call Memory`
- `mission`: "I am the on-call memory for Nimbus Pay. I track production incidents, their root causes, the fixes that worked, and the fixes that failed. I help on-call engineers diagnose new incidents quickly by recalling similar past incidents."
- `disposition`: `{"skepticism": 4, "literalism": 3, "empathy": 2}`

Directives are hard rules for reflect. Use the directives API if available in the installed client version; otherwise put them into the mission text.

- Always cite incident IDs (for example, INC-030) for every claim.
- Always warn when a proposed fix failed in a past incident.
- Never suggest a destructive command without a rollback step.
- If no past incident is a strong match, say so plainly instead of guessing.

### 6.2 Memory conventions

Every retained memory must carry these fields:

| Field | Value |
| --- | --- |
| `document_id` | The incident ID, for example `INC-030` |
| `timestamp` | The real event time (for seeded history, the backdated `resolved_at`) |
| `context` | One of: `alert`, `fix-attempt`, `postmortem`, `runbook` |
| `metadata` | `{"service": ..., "severity": ..., "outcome": ...}`, where `outcome` only applies to fix attempts |

Write content as clear natural-language sentences that include the incident ID, the service, the date and the error signature. Hindsight extracts facts from the text, so write it like a good postmortem, not like raw JSON.

### 6.3 Calls and where they are used

| Moment | Call | Parameters |
| --- | --- | --- |
| Seed history | `retain_batch` | One item per postmortem, conventions above |
| First memory-on diagnosis finishes | `aretain` | `context="alert"`, `retain_async=True`. Not at creation: retaining first made the incident recall and reflect on itself |
| Diagnose | `arecall` | `query=alert_text`, `types=["world","experience","observation"]`, `budget="mid"`, `max_tokens=4096`, `include_chunks=True` |
| Diagnose | `areflect` | `query="Diagnose this incident. Give the likely root cause, the fix to try first, and any fixes that failed in similar past incidents. Cite incident IDs."`, `context=<service + alert_text>`, `budget="low"` (measured: 8.9 s at low, 15.5 s at mid). Start it concurrently with recall; stream recall first. |
| Fix attempt logged | `aretain` | `context="fix-attempt"`, `metadata.outcome` = `worked`, `failed` or `partial` |
| Incident resolved | `aretain` | `context="postmortem"` |
| Ask the history (stretch) | `areflect` | Free-form query |
| Patterns (stretch) | `list_memories(type="observation")` plus `areflect` | |

Verify every method name and parameter against the installed `hindsight-client` version before relying on it. Docs:

- https://hindsight.vectorize.io/sdks/python
- https://hindsight.vectorize.io/developer/api/quickstart

If a parameter does not exist in the installed version, adapt to it and note the change in `README.md`.

## 7. LLM usage

All LLM calls go to OpenRouter over `httpx` and live in `backend/app/services/llm.py`. The LLM never invents knowledge: it only formats the recall results and the reflect answer into the `Diagnosis` schema, drafts postmortems from session data, and produces the memory-off baseline answer.

Structured output:

- Put the JSON schema in the system prompt and instruct "reply with one JSON object only".
- Do **not** send `response_format`: in testing (2026-09-28), Nemotron 3 Super returned an empty `{}` with JSON mode on, and the free Ultra endpoint does not list it as supported.
- Send `"reasoning": {"enabled": false}`, and enforce a total deadline with `asyncio.wait_for` (15 s primary, 20 s fallback): OpenRouter sends keep-alive whitespace, so the httpx read timeout never fires.
- Extract the JSON robustly: strip code fences, then take the outermost `{...}` before validating.
- Treat HTTP 429 (rate limit) and 503 (`provider_overloaded`, seen on Super in testing) as retryable errors that trigger the fallback model.
- Parse and validate with the Pydantic `Diagnosis` model.

Failure handling, in this order:

1. Primary model call.
2. On an OpenRouter error, a timeout or a Pydantic validation error, retry once with the fallback model.
3. If that also fails, return `Diagnosis(summary=<reflect text>, confidence=null, degraded=True, ...)`, and have the UI show a plain text card.

Log each failure with the model name and error type. Never surface raw exceptions to the client.

## 8. Core schemas

```python
class Hypothesis(BaseModel):
    cause: str
    confidence: float          # 0.0 to 1.0
    evidence: list[str]        # verified incident IDs

class FixSuggestion(BaseModel):
    action: str
    source: str | None         # incident ID it came from
    evidence: list[str]        # incident IDs where this fix WORKED, verified against the attempts table

class AvoidFix(BaseModel):
    action: str
    why: str
    evidence: list[str]        # incident IDs where this fix FAILED, verified against the attempts table

class RecalledMemory(BaseModel):
    text: str
    type: str                  # world | experience | observation
    incident_id: str | None
    occurred_at: datetime | None
    relevance: float | None    # Hindsight reranker score, 0.0 to 1.0; never invented

class MatchedIncident(BaseModel):
    id: str
    title: str | None
    relevance: float           # best relevance among this incident's recalled memories
    occurred_at: datetime | None

class InvestigationStep(BaseModel):
    name: Literal["parse", "recall", "evidence", "reflect", "diagnosis"]
    detail: str                # e.g. "69 memories, 4 incidents"
    duration_ms: int

class Diagnosis(BaseModel):
    summary: str
    confidence: float | None
    hypotheses: list[Hypothesis]
    try_first: FixSuggestion | None
    avoid: list[AvoidFix]
    cited_incidents: list[str]
    matched: list[MatchedIncident]
    recalled: list[RecalledMemory]
    steps: list[InvestigationStep]
    strong_match: bool         # a precedent was confirmed (see the precedent rule below)
    memory_enabled: bool
    degraded: bool = False
    latency_ms: int
```

**Evidence rule (enforced in `services/evidence.py`, covered by tests):** after the LLM formats a diagnosis, every incident ID it produced is kept only if recall returned it, and each `try_first.evidence` or `avoid.evidence` ID is kept only if that incident's attempt log has an attempt with outcome `worked` or `failed` respectively. An Avoid item with no verified evidence is removed. `cited_incidents` is recomputed from what survives. Every count shown in the UI comes from these verified lists.

The LLM cites attempts by reference (`INC-030#1`), and the backend maps each reference to the real attempt, so an Avoid item can only point at an attempt that actually failed. Free text is checked too: any sentence in the summary or an Avoid "why" that names an incident outside the verified set is removed (`scrub_unverified`). In testing the model once wrote "matches the failure mechanism in INC-034 and INC-014" about an unrelated alert.

**Precedent rule (`confirm_precedent`):** reranker relevance alone is noisy (one stray memory scored 0.94 for an unrelated alert), and either model's verdict alone varied between runs. A precedent is confirmed only when Hindsight's reflect verdict is not negative, the formatter judges the failure mechanism to be the same, and it names at least one incident with relevance of 0.75 or more. Without a confirmed precedent nothing is citable: no Try First, no Avoid, confidence at most 0.4, and the summary starts with "No strong precedent in memory."

## 9. Frontend design rules

- **Look:** a dark SRE console in the style of Linear or Datadog, not a chatbot.
  - Background: pure black `#000000`, no colour pools (user decision, 2026-09-29: "everything pure dark black")
  - Cards: pure black fill with an Apple-style "liquid glass" outline: a 1px gradient rim (`::after` with a mask) bright at the top-left and bottom-right corners, an inner top highlight, and backdrop blur so floating glass still lenses what is behind it. Use the `.glass` class (panels, cards), `.glass-strong` (overlay, drawers, toasts, tooltips) and `.glass-well` (inputs, code, logs inside glass), all defined in `frontend/src/index.css`. Do not hand-roll other card backgrounds.
  - Borders: the gradient rim built into the glass classes; plain borders are white at 6 to 10% opacity
  - Text: ink `#EDEDED`, muted `#9A9A9A`
  - Severity accent: red `#EF4444`
  - Memory accent: teal `#14B8A6`
  - Success: green `#22C55E`
- **Fonts:** Inter for UI, JetBrains Mono for logs, alert text and incident IDs.
- **Layout of the Console page:**
  - Top bar with a memory count and the Memory on/off toggle
  - Left column: incident input (signal simulator, pasted alert, demo chips)
  - Centre: diagnosis with a Try First card (outcome buttons: Worked, Didn't work, Note) and an Avoid card, each listing the verified incidents
  - Under the diagnosis: the investigation timeline (parse, recall, evidence, reflect, diagnosis), each step with its detail and duration, filling in live from the stream
  - Right column: "Why I think this": matched incidents with relevance percentage, then memory cards
  - Bottom: learning-curve strip and "Resolve incident"
- **Motion:** memory cards slide and fade in one by one as recall returns (Framer Motion, a stagger of 60–80 ms). Keep all motion subtle, 150–250 ms.
- **Memory off state:** show a muted grey card labelled "Without memory".
- **Loading:** render each streamed step as it arrives. Recall cards within 2 s; while reflect runs, the timeline shows "Hindsight is reasoning over N matching incidents" with a running timer. Never a bare spinner.
- **Experience Captured:** after resolve, a card shows the pattern, the working fix, the failed fixes, the exact text retained into Hindsight, and the memory count before and after.
- **Simulator (P1):** "Simulate incident" replays the demo alert's `signals` over about 4 s, then opens the incident. It is visibly labelled "Simulated signals".
- **Honest numbers:** relevance, counts, durations and confidence are always computed from real responses. Never hardcode or invent statistics in UI copy.
- **Empty state:** "No similar incidents in memory yet. This one will be the first."
- **Resolve:** submitting shows the toast "Saved to memory. The next similar incident will know this."
- **Incident IDs:** always render as clickable monospace chips.
- **Memory age:** every recalled memory card shows both the absolute date and the relative age, for example "Aug 12 · 7 weeks ago".
- **Learning curve:** the Console shows a compact learning-curve strip: confidence and number of cited incidents for each diagnosis in the session, so judges watch the agent improve.
- **Accessibility:** visible focus rings, sufficient contrast, keyboard-submittable forms.

### 9.1 Desktop overlay rules

- The overlay opens immediately on the shortcut and loads context asynchronously (measured 109 ms to open).
- States: idle, context, investigating, diagnosis, resolve, learned. The first view must be understandable in 5 seconds; Known / Likely / Unknown and related incidents sit behind "Why this?".
- Every status is a real operation: "Project inspected" only after the backend read the project; "Saved to Hindsight" only when retain succeeded. The active application line says "unavailable" rather than guessing.
- Project access only through the native consent dialog; the backend rejects project registration without the `X-OnCall-Client: desktop` header and reads only inside registered roots.
- The screen is captured only when the engineer clicks "Read the error from my screen". Clipboard text is used only when it looks like an error, and the overlay says it was used.
- Never execute fixes. The agent recommends; the engineer acts and records the outcome.

## 10. Data rules

The synthetic dataset spec is in `docs/PRD.md`, section 7.

- The company is Nimbus Pay. There are 45 incidents, dated March to September 2026, organised into 6 recurring failure families plus 27 one-offs.
- IDs are `INC-001` to `INC-045`, in chronological order.
- Use realistic error strings, consistent timelines and fictional engineer names. Never use real companies' internal data.
- Do not put the 3 demo alerts in memory until they are used live.
- On startup the backend imports `postmortems.json` attempts into the SQLite `attempts` table, so the evidence check covers seeded history as well as live attempts.
- Everything retained into Hindsight passes through `services/redaction.py` first (keys, tokens, passwords, credentials in URLs, private keys).
- Tests never read the live `demo/nimbus-pay` folder (it is edited during demos); they use the `demo_project` fixture, a pristine copy.

## 11. Commands

```
# backend
cd backend && pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
pytest

# data and memory
python scripts/validate_data.py
python scripts/reset_bank.py        # wipes and reseeds nimbus-oncall
python scripts/seed_hindsight.py

# frontend
cd frontend && npm install && npm run dev
npm run build && npm run typecheck

# desktop (needs backend and frontend running)
cd desktop && npm install && npm start
python scripts/reset_demo.py        # Reset demo: bank, live incidents, demo project
```

## 12. Definition of done for the whole project

- The 3-minute demo in `docs/PRD.md`, section 8, runs end to end on the deployed URL.
- The Memory on/off toggle shows a clearly different answer for the same alert.
- Resolving an incident measurably changes the diagnosis for the next similar alert, and the learning-curve strip shows it.
- Every submission requirement in section 1.1 is met.
- `README.md` covers:
  - the problem
  - the architecture
  - setup in 5 commands
  - a "How Hindsight memory is used" section mapping every call to a feature
  - a link to the demo video