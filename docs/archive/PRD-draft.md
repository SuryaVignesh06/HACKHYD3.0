# On-Call Copilot — PRD

Sep 28, 2026 · @surya vignesh

## Overview

On-Call Copilot is an incident response agent that remembers every outage your team has fought, and uses that memory to resolve the next one faster.

**One-line pitch:** Paste an alert or error log, and the Copilot tells you which past incident this matches, what the real root cause was, which fix worked, and which fix wasted time last time.

**The problem**

- Incident knowledge lives in scattered postmortems, Slack threads and the heads of senior engineers.
- At 3 AM, the on-call engineer is often the one person who was not there last time.
- Teams re-debug the same failure modes: the same bad restart, the same wrong rollback, the same missed config.
- Generic LLM assistants give generic advice ("check logs, restart the service") because they have no history.

**The solution**

An agent built on Hindsight that retains every incident, every attempted fix and every postmortem. It recalls similar incidents by symptom, service, error signature and time. It reflects across them to produce a ranked diagnosis. It gets measurably better with every incident the team resolves.

**Hackathon fit:** memory is not a feature here, it is the entire value. Without memory the agent is ChatGPT; with memory it behaves like a senior SRE who has been on the team for a year.

**Working name:** On-Call Copilot (alternatives: Postmortem, Déjà Vu, Runbook Memory).

## Target user and user stories

The primary user is the on-call backend or SRE engineer at a 20–200 person SaaS company, who handles production incidents without a dedicated incident team.

**Persona: Priya, backend engineer, on-call this week**

- 2 years at the company; knows her own services well, others only partly.
- Gets paged at 2:40 AM for `payments-api` p99 latency spiking to 4 s.
- The last time this happened, a senior engineer fixed it, and he has since left.
- She needs: "Has this happened before, what was it, and what should I try first?"

**Secondary user:** the engineering manager who wants recurring failure patterns surfaced ("Redis pool exhaustion has caused 4 incidents in 3 months").

**Core user stories**

| # | As an on-call engineer, I want to… | So that… |
| --- | --- | --- |
| U1 | paste an alert, log or stack trace and get a diagnosis | I get a starting point in seconds |
| U2 | see which past incidents match, with dates and similarity | I trust the suggestion and can read the history |
| U3 | be warned about fixes that failed before | I don't waste 30 minutes on a dead end |
| U4 | log what I tried and whether it worked, during the incident | the agent learns from this incident too |
| U5 | close the incident with a short postmortem | the root cause and fix are retained for next time |
| U6 | ask free-form questions ("what broke after the last Postgres upgrade?") | I can explore history without digging through docs |
| U7 | see recurring patterns across incidents | I can argue for a permanent fix, not another patch |

## How Hindsight memory is used

Hindsight is the agent's brain: every incident, fix attempt and postmortem is retained, recalled on the next alert, and reasoned over with reflect. The LLM (Groq) only formats and converses; all team knowledge comes from memory.

&#91;embedded content: memory loop · 6 steps, 3 Hindsight operations\]

The top row runs while an incident is live; the bottom row runs as the engineer works and after resolution. Consolidated observations such as "restarting payments-api does not fix pool exhaustion" flow back into the next recall.

**Memory bank design**

- One bank per team: `nimbus-oncall` (the demo company, see the dataset section).
- Every memory carries `document_id` = the incident ID (INC-042), a real `timestamp`, a `context` label (alert, fix-attempt, postmortem, runbook) and `metadata` (service, severity, outcome).
- Bank mission: "I am the on-call memory for Nimbus. I track incidents, root causes, fixes that worked and fixes that failed."
- Directives (hard rules for reflect): always cite incident IDs; always warn when a proposed fix failed before; never suggest a destructive command without a rollback step.
- Disposition: skepticism 4 of 5, so it does not overclaim a match on thin evidence.

**Every Hindsight call in the product**

| Moment | Call | What goes in or comes out |
| --- | --- | --- |
| Seed history (setup script) | `retain_batch` | 40–60 past incidents and postmortems with backdated timestamps |
| New alert pasted | `recall` (types: world, experience, observation; budget mid) | Top matching incidents, shown in the Memory panel with dates |
| Diagnosis | `reflect` with the alert as `context` | Ranked root-cause hypotheses, fix to try first, fixes to avoid, cited IDs |
| Engineer logs a step | `retain` (context fix-attempt, metadata outcome) | "Restarted pods on INC-061: latency back to 4 s in 20 min, failed" |
| Incident resolved | `retain` (context postmortem) | Root cause, working fix, time to resolve, follow-ups |
| Ask the history | `reflect` | Free-form Q&A: "What broke after the last Postgres upgrade?" |
| Patterns page | `list_memories` (type observation) + `reflect` | Recurring failure modes and their incident counts |

**The before/after judges must see**

| Same alert: payments-api p99 at 4.2 s, Redis timeouts | Answer |
| --- | --- |
| Memory off | "Check CPU and memory, look at recent deploys, consider restarting the service." |
| Memory on | "Matches INC-042 (Aug 12) and INC-051 (Sep 3): Redis pool exhaustion after a deploy raised concurrency. Restarting pods failed both times. Fix that worked: raise maxPoolSize from 20 to 50 and roll back the worker concurrency change." |

The UI ships a **Memory on/off toggle** so this contrast is shown live, not claimed.

## Feature scope

The MVP is one workflow done brilliantly: alert in, memory-backed diagnosis out, outcome retained. Everything else is stretch.

**MVP (must ship)**

1. **Incident console:** paste an alert, log or stack trace, or pick one of the preset demo alerts.
2. **Memory-backed diagnosis card:** likely root cause with confidence, "try this first" fix, "avoid, failed before" warnings, and cited incident IDs.
3. **Memory panel ("Why I think this"):** the recalled memories with incident ID, date, type (fact, experience, observation) and the matching snippet.
4. **Fix attempt log:** during the incident, the engineer logs "tried X, worked or failed" in one click; each entry is retained immediately.
5. **Resolve and postmortem:** a short form (root cause, fix, time to resolve) that the LLM pre-fills from the session; submit retains it.
6. **Memory on/off toggle:** reruns the same alert without recall/reflect to show the generic answer side by side.
7. **Incident history:** a list of past incidents with service, severity, date and root cause.
8. **Seed script:** loads the synthetic incident history into Hindsight with backdated timestamps.

**Stretch (only if MVP is polished)**

- **Patterns page:** recurring failure modes with counts ("Redis pool exhaustion: 4 incidents, 3 services").
- **Ask the history:** free-form chat over the whole incident memory.
- **Learning curve widget:** memory hits and time-to-diagnosis across demo incidents.
- **Slack-style webhook:** post an alert via a URL to show real integration potential.

**Out of scope**

- Real PagerDuty, Datadog or Grafana integrations.
- Running commands on infrastructure; the Copilot advises, humans act.
- Authentication, multi-tenant teams and billing.
- Mobile layout beyond basic responsiveness.

## Architecture, stack, data and API

A React front end talks to a FastAPI backend that orchestrates Hindsight (memory) and Groq (language). SQLite only holds what the UI lists; all knowledge lives in Hindsight.

&#91;embedded content: system architecture · web app, FastAPI, Hindsight, Groq\]

The seed script loads the synthetic history once; after that, every memory is created by real use of the app.

**Tech stack**

| Layer | Choice | Why |
| --- | --- | --- |
| Front end | React 18, Vite, TypeScript, Tailwind, Framer Motion, Lucide icons | Your core stack; fast to build a polished console |
| Backend | Python 3.11, FastAPI, Pydantic v2, SQLModel on SQLite | Simple, typed, async |
| Memory | Hindsight Cloud via `hindsight-client` (async `arecall`, `areflect`, `aretain`) | Required tech; no infra to run |
| LLM | Groq: `openai/gpt-oss-120b`, fallback `qwen/qwen3-32b` | Fast, free tier, recommended by organisers |
| Hosting | Vercel (front end), Render or Railway (backend) | Free tiers, live URL for judges |

**Diagnosis pipeline (POST /diagnose)**

1. `arecall(bank_id, query=alert_text, types=["world","experience","observation"], budget="mid", max_tokens=4096, include_chunks=True)`.
2. `areflect(bank_id, query="Diagnose this incident: likely root cause, fix to try first, fixes that failed before", context=alert_text + service)`.
3. Groq call with a JSON schema: turn the recall results and reflect answer into the `Diagnosis` object below.
4. Validate with Pydantic. On a malformed or failed tool call, retry once on the fallback model; if that fails, return the raw reflect text in a plain card. The demo never shows a stack trace.
5. Memory off mode skips steps 1 and 2 and sends only the alert to Groq.

**Diagnosis object**

```json
{
  "summary": "Redis connection pool exhaustion in payments-api",
  "confidence": 0.82,
  "hypotheses": [{"cause": "...", "confidence": 0.82, "evidence": ["INC-042", "INC-051"]}],
  "try_first": {"action": "Raise REDIS_MAX_POOL from 20 to 50", "source": "INC-051"},
  "avoid": [{"action": "Restart payments-api pods", "why": "Failed in INC-042 and INC-051"}],
  "cited_incidents": ["INC-042", "INC-051"],
  "memories_used": 7
}
```

**Data model (SQLite)**

| Table | Key fields |
| --- | --- |
| incidents | id, title, service, severity, status, alert\_text, created\_at, resolved\_at, root\_cause, fix, ttr\_minutes |
| attempts | id, incident\_id, action, outcome (worked, failed, partial), notes, created\_at |
| diagnoses | id, incident\_id, memory\_enabled, payload\_json, recalled\_ids, latency\_ms |

**API endpoints**

| Method and path | Does |
| --- | --- |
| POST /api/incidents | Create an incident from alert text; retain the alert |
| POST /api/incidents/{id}/diagnose?memory=true | Run the pipeline above |
| POST /api/incidents/{id}/attempts | Log a fix attempt; retain it with its outcome |
| POST /api/incidents/{id}/resolve | Save the postmortem; retain it |
| GET /api/incidents, GET /api/incidents/{id} | History list and detail |
| POST /api/ask | Free-form reflect over the bank (stretch) |
| GET /api/patterns | Observations grouped into failure modes (stretch) |

**Repo layout**

```
oncall-copilot/
  backend/   app/main.py, routers/, services/memory.py, services/llm.py, models.py
  frontend/  src/pages, src/components, src/lib/api.ts
  data/      incidents.json, postmortems.json, demo_alerts.json
  scripts/   seed_hindsight.py, reset_bank.py
  README.md  setup, architecture, how Hindsight is used, demo script
```

## UI and UX

The product is a dark, calm incident console with three screens; the memory panel is always visible so judges see memory at work, not just its result.

**Visual direction:** dark UI (near-black background, one red severity accent, one teal "memory" accent), Inter plus JetBrains Mono for logs, Lucide icons, subtle Framer Motion for memory cards sliding in as they are recalled. It should look like a real SRE tool (think Linear or Datadog), not a chatbot.

**Screen 1: Incident console (the demo lives here)**

| Region | Contents |
| --- | --- |
| Top bar | Product name, bank name (nimbus-oncall), memory count, Memory on/off toggle |
| Left, alert input | Paste box for alert, log or stack trace; service and severity pickers; preset demo alert chips |
| Centre, diagnosis | Summary with confidence, ranked hypotheses, green "Try first" card, red "Avoid: failed before" card, cited incident chips |
| Right, memory panel | "Why I think this": recalled memories with incident ID, date, type badge and snippet; clicking a chip opens that incident |
| Bottom, action log | Buttons: "Tried this, worked", "Tried this, failed", free-text note; then "Resolve incident" |

**Screen 2: Resolve drawer**

A side drawer with a postmortem form pre-filled by the LLM from the session: root cause, fix, time to resolve, follow-ups. One click retains it, with a toast: "Saved to memory: the next similar incident will know this."

**Screen 3: Incident history**

A table of incidents (ID, date, service, severity, root cause, time to resolve) with a detail view showing the alert, attempts and postmortem. Stretch: a Patterns tab with recurring failure modes.

**UX rules**

- The first diagnosis must appear in under 6 seconds; show recalled memory cards streaming in while reflect runs.
- Every claim in the diagnosis links to a source incident. No citation, no claim.
- Memory off mode shows a muted, grey card labelled "Without memory" so the contrast is instant.
- Empty and error states are designed: "No similar incidents in memory yet. This one will be the first."

## Synthetic dataset

The demo runs on 45 realistic incidents from a fictional fintech, Nimbus Pay, spread over March to September 2026 and built around 6 recurring failure families so memory has real patterns to find.

**The company:** Nimbus Pay, a 60-person payments SaaS. Kubernetes on AWS, Postgres 15, Redis 7, Kafka. Six services: `payments-api`, `checkout-web`, `ledger-worker`, `notifications-svc`, `auth-service`, `search-api`. Eight fictional engineers rotate on-call.

**Recurring failure families (the memory gold)**

| Family | Incidents | Service | Fix that failed | Fix that worked |
| --- | --- | --- | --- | --- |
| Redis pool exhaustion after concurrency change | 4 | payments-api | Restart pods | Raise REDIS\_MAX\_POOL, roll back worker concurrency |
| Kafka consumer lag after deploy | 3 | ledger-worker | Scale consumers up | Roll back the batch-size config |
| Postgres lock from long migration | 3 | payments-api, auth-service | Kill the blocking query | Run migrations with lock\_timeout in off-peak window |
| Memory leak, OOMKilled pods | 3 | notifications-svc | Raise memory limit | Pin the template-cache library version |
| Third-party rate limits | 3 | notifications-svc, checkout-web | Retry harder | Exponential backoff plus queueing |
| TLS certificate expiry | 2 | auth-service | Manual renewal (worked once, recurred) | cert-manager auto-renew |

The other 27 incidents are one-offs (DNS blip, bad feature flag, disk full, CDN outage) that act as realistic noise, so recall has to discriminate.

**Files**

- `incidents.json`: id, title, service, severity (SEV1 to SEV3), started\_at, resolved\_at, alert\_text, on\_call engineer.
- `postmortems.json`: incident\_id, summary, root\_cause, timeline, attempts (action + outcome), fix, follow\_ups.
- `demo_alerts.json`: the 3 live demo alerts, not in memory until used.

**Realism checklist**

- Real-looking log lines: `redis.exceptions.ConnectionError: Too many connections`, `kafka consumer group ledger-cg lag=184,322`, `OOMKilled exit code 137`.
- Consistent timelines: detection, mitigation and resolution times that add up; SEV1 resolved in 25–90 minutes.
- Human texture in postmortems: wrong first guesses, a rollback that made things worse, a follow-up that was never done (which explains the repeat).
- Generate with Claude Code from this family table, then hand-check the 6 families since the demo depends on them.

**Seeding:** `scripts/seed_hindsight.py` sends each postmortem through `retain_batch` with `timestamp` = resolved\_at, `document_id` = incident ID, `context` = "postmortem" and service and severity in `metadata`. `scripts/reset_bank.py` wipes and reseeds before every demo run.

## Demo script

The demo tells one story in 3 minutes: a new on-call engineer at 2:40 AM, a generic AI that fails her, and a memory-powered Copilot that behaves like a senior SRE.

**The 60-second version (for the video opening and the judges' first look)**

1. "It's 2:40 AM. Priya is paged: payments-api latency at 4 seconds. The engineer who fixed this last time has left." (0:00–0:10)
2. Paste the alert with **Memory off**: generic advice, restart the service. (0:10–0:20)
3. Flip **Memory on**, same alert: memory cards slide in, it names INC-042 and INC-051, says restarting failed twice, and gives the exact fix. (0:20–0:45)
4. "Every incident your team resolves makes it smarter." Show the memory count ticking up. (0:45–1:00)

**Full 3-minute flow**

| Time | Beat | What judges see |
| --- | --- | --- |
| 0:00–0:20 | The pain | Persona, 2:40 AM page, senior engineer gone |
| 0:20–0:50 | Before memory | Memory off: generic, useless advice |
| 0:50–1:40 | With memory | Recall of 2 matching incidents, "avoid restart" warning, exact fix with citations |
| 1:40–2:10 | It learns live | Priya logs "raised pool to 50, worked", resolves; postmortem pre-filled and retained |
| 2:10–2:40 | Learning proof | A new, never-seen alert (TLS expiry variant): first answer is cautious; after one resolved example, a similar alert gets a confident, cited answer |
| 2:40–3:00 | Impact | "Mean time to diagnosis: minutes to seconds. Tribal knowledge that never leaves." Architecture slide, Hindsight logo |

**Demo safety**

- Run `reset_bank.py` before every take so the memory state is identical.
- Keep the 3 demo alerts as preset chips; no live typing under pressure.
- Record a fallback video in case the live demo's Wi-Fi or Groq fails.

## Build plan with Claude Code

Build in 7 phases, about 30–36 focused hours; each phase ends with something runnable, so you can stop at any point and still have a demo.

| Phase | Claude Code task | Done when | Est. |
| --- | --- | --- | --- |
| 0. Setup | Sign up for Hindsight Cloud, apply MEMHACK99, get a Groq key; scaffold the repo, `.env.example`, README skeleton | `hindsight-client` retains and recalls "hello" | 2 h |
| 1. Data | Generate the 45 incidents, postmortems and 3 demo alerts from the family table | JSON files pass a schema check; the 6 families read as real | 4 h |
| 2. Memory layer | `services/memory.py`, bank creation with mission and directives, `seed_hindsight.py`, `reset_bank.py` | A recall for a Redis alert returns INC-042 and INC-051 | 4 h |
| 3. Diagnosis API | FastAPI routes, recall + reflect + Groq JSON pipeline, fallback model, memory off mode | curl returns a valid Diagnosis object in under 6 s | 6 h |
| 4. Learning loop | Attempts and resolve endpoints that retain; postmortem pre-fill | A resolved incident changes the next similar diagnosis | 4 h |
| 5. Front end | Console, memory panel, action log, resolve drawer, history page, toggle | The 3-minute demo runs end to end in the browser | 8 h |
| 6. Polish and ship | Motion, empty and error states, deploy to Vercel and Render, README with Hindsight explanation, demo video | Live URL works from a phone; video recorded | 4 h |

**How to drive Claude Code**

- Put this PRD in the repo as `docs/PRD.md` and a short `CLAUDE.md` with the stack, folder layout and rules (typed code, no placeholders, Lucide icons only).
- Give it one phase per session: "Read docs/PRD.md. Implement Phase 2 only. Stop when the done-when check passes and show me the output."
- Ask it to write a test or a script for each done-when check, so you verify, not trust.
- Commit after every phase with a clear message; judges read commit history.

**Team split (if 2–3 people)**

- Person A: backend, Hindsight and Groq pipeline (phases 2–4).
- Person B: front end and motion (phase 5).
- Person C or shared: dataset, demo script, video, article and social posts.

## Judging fit, risks and submission

The project is designed to score on all five criteria, with memory (25%) and innovation (30%) carrying the pitch.

| Criterion | Weight | How On-Call Copilot scores |
| --- | --- | --- |
| Innovation | 30% | Learns from failed fixes, not just stored facts; warns you away from dead ends |
| Use of Hindsight | 25% | Memory is the product; live on/off toggle; retain, recall, reflect, observations and bank directives all used |
| Technical implementation | 20% | Typed FastAPI, validated JSON output, fallback model, graceful degradation, reset and seed scripts |
| User experience | 15% | Real SRE-tool look, memory panel with citations, a 3-minute story |
| Real-world impact | 10% | Downtime is expensive; every SaaS team has on-call; clear path to a paid Slack or PagerDuty integration |

**Risks and fallbacks**

| Risk | Fallback |
| --- | --- |
| Groq function-calling errors or malformed JSON | Retry on the fallback model, then show the raw reflect text |
| Hindsight latency makes the demo slow | Stream recall cards first; use budget "low" for reflect in the live demo |
| Recall returns the wrong incident | Tune the 6 families to have distinct error signatures; test the 3 demo alerts repeatedly |
| Data looks fake | Hand-edit the family postmortems; include real error strings and messy timelines |
| Scope creep | Stretch features only after the 3-minute demo runs end to end |

**Submission checklist**

- [ ] Public GitHub repo with a clean README: problem, architecture diagram, setup in 5 commands, how Hindsight is used
- [ ] Demo video (3 minutes) following the demo script
- [ ] Live deployed URL for the judges' demo
- [ ] Written explanation of Hindsight usage (can reuse the memory section of this PRD)
- [ ] Article from every team member (e.g. "I built an on-call engineer that never forgets an outage")
- [ ] Social media post from every team member with a short screen recording
- [ ] Video from every team member per the content guide (your Dev With Surya channel fits here)
- [ ] Re-check the official content guide for exact requirements before submitting

**Sources**

- [Hindsight overview: memory types, recall strategies, bank mission and directives](https://hindsight.vectorize.io/)
- [Hindsight Python client: retain, recall, reflect, create\_bank](https://hindsight.vectorize.io/sdks/python)
- Hackathon problem statement PDF (attached by Surya)
