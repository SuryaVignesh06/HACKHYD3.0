# On-Call Copilot — Product Requirements Document

Version 2.0, 28 September 2026. Hackathon: "AI Agents That Learn Using Hindsight" (Vectorize).

Version 2.0 folds in the "10/10 upgrade plan" review. What was adopted, what was cut and why is in section 11.

---

## 1. Overview

On-Call Copilot is an incident-response agent that remembers what an engineering team learned the hard way: what failed, what worked, and why. It uses that experience during the next incident.

**One-line pitch:** Remember what failed, not just what worked.

**Differentiator:** Monitoring tools tell you what is happening. Generic AI tells you what might work. On-Call Copilot remembers what your team already tried.

**The problem**

- Incident knowledge lives in scattered postmortems, Slack threads and senior engineers' heads.
- At 3 AM, the on-call engineer is often the one person who was not there last time.
- Teams re-debug the same failure modes, repeating the same bad restart and the same wrong rollback.
- Generic LLM assistants give generic advice because they have no history.

**The loop we must make undeniable**

```
incident -> recall past experience -> compare what failed and what worked
         -> evidence-backed action -> human records the outcome
         -> retain -> better answer on the next incident
```

**Fit with the problem statement**

- The official problem statement lists the "Incident Response Agent" under Engineering and DevOps, so the use case is validated as a real business problem.
- **The $50/month test:** one hour of payments downtime costs a fintech far more than a seat license.
- **Risk:** other teams may pick the same idea. Innovation (30%) comes from what a basic incident bot does not do:
  - failed fixes as first-class memory, with warnings verified against the fix-attempt log
  - an honest "no strong precedent" when nothing matches
  - a live Memory on/off comparison
  - a visible learning curve, where one resolved incident changes the next answer

## 2. Users and user stories

**Primary user:** the on-call backend or SRE engineer at a 20–200 person SaaS company.

**Persona:** Priya, a backend engineer on call this week, is paged at 2:40 AM because `payments-api` p99 latency has hit 4 s. Marcus, the engineer who fixed this the last three times, has left.

**Secondary user:** an engineering manager who wants recurring failure patterns surfaced.

| # | As an on-call engineer, I want to... | So that... |
| --- | --- | --- |
| U1 | get a diagnosis the moment an incident opens | I have a starting point in seconds |
| U2 | see which past incidents match, how relevant they are, and when they happened | I can trust the suggestion |
| U3 | be warned about fixes that failed before, with the incidents where they failed | I don't waste 30 minutes on a dead end |
| U4 | record whether the suggested fix worked, in one click | the agent learns from this incident too |
| U5 | close the incident with a pre-filled postmortem and see what was learned | the experience is retained for next time |
| U6 | see recurring failure patterns across incidents | I can argue for a permanent fix |

## 3. How Hindsight memory is used

Hindsight holds all team knowledge. The LLM only formats memory output into a typed diagnosis, drafts postmortems and produces the memory-off baseline.

1. An incident opens (from the signal simulator or a pasted alert). `retain` stores the alert.
2. `recall` finds relevant past experience: facts, experiences and observations, each with a relevance score.
3. The evidence step checks the fix-attempt log of every recalled incident: which fixes worked and which failed.
4. `reflect` reasons across the recalled incidents under the bank's directives.
5. The LLM formats recall, evidence and reflect into a `Diagnosis`; every claim must cite a verified incident ID.
6. The engineer records outcomes. `retain` stores each fix attempt with its outcome.
7. Resolve: `retain` stores the postmortem. Hindsight consolidates observations, which feed the next recall and the Patterns page.

**Bank:** `nimbus-oncall`, with the mission, directives and disposition in `CLAUDE.md` section 6.1.

| Moment | Call | What goes in or comes out |
| --- | --- | --- |
| Seed history | `retain_batch` | 45 past postmortems with backdated timestamps |
| First memory-on diagnosis finishes | `retain` (context `alert`) | The alert text (retained after the investigation so the incident never matches itself) |
| Diagnose | `recall` | Relevant memories with reranker relevance, shown in "Why I think this" |
| Diagnose | `reflect` | Ranked root causes, fix to try first, fixes to avoid, cited IDs |
| Outcome recorded | `retain` (context `fix-attempt`) | "During INC-046 the on-call engineer tried: restart pods. Outcome: FAILED." |
| Incident resolved | `retain` (context `postmortem`) | Root cause, working fix, failed fixes, time to resolve, follow-ups |
| Patterns page | `list_memories(type=observation)` plus `reflect` | Recurring failure modes Hindsight consolidated on its own |

**Before and after, shown live**

| Mode | Answer for DEMO-A (payments-api p99 4.2 s, Redis Too many connections) |
| --- | --- |
| Memory off | "Check CPU and memory, look at recent deploys, consider restarting the service." |
| Memory on | "Matches INC-030 (Aug 12) and INC-037 (Sep 3): Redis pool exhaustion after a deploy raised concurrency. Avoid restarting pods: it failed in INC-003, INC-014, INC-030 and INC-037. Try first: raise REDIS_MAX_POOL and roll back the worker concurrency change (worked in INC-030 and INC-037)." |

## 4. Feature scope

**P0: the loop (must ship, in this order)**

1. **Diagnosis pipeline with a live investigation timeline.** `diagnose` streams real steps as they finish: alert parsed, recall done (N memories, M incidents), evidence checked (X failed fixes, Y working fixes), reflect done, diagnosis ready. Each step shows its duration.
2. **Evidence-verified Try First and Avoid.** Each item carries the incident IDs it relies on. The backend keeps an ID only if that incident's fix-attempt log has a matching outcome: `worked` for Try First, `failed` for Avoid. The card says "Failed in 4 incidents: INC-003, INC-014, INC-030, INC-037". No verified ID means the item is dropped.
3. **"Why I think this" panel.** Matched incidents with Hindsight's reranker relevance as a percentage, date, relative age and type badges, then the recalled memory snippets. Relevance is Hindsight's own score; nothing is invented.
4. **Human in the loop on the Try First card.** "Worked", "Didn't work" and "Note" buttons record the outcome and retain it immediately. The agent never executes anything.
5. **Resolve and Experience Captured.** The drawer is pre-filled by the LLM. Submitting retains the postmortem and shows an Experience Captured card: the pattern, the working fix, the failed fixes, and the exact text sent to Hindsight, with the memory count before and after.
6. **Memory on/off comparison.** The same incident is diagnosed both ways, side by side, with a computed impact row: incidents cited, verified warnings, and whether a Try First exists.
7. **Learning-curve strip.** Every diagnosis in the session with its confidence and number of verified citations.
8. **Seed and reset scripts** (done), plus incident history (list and detail).

**P1: agent feel and organisational memory (after the P0 demo runs end to end)**

9. **Incident signal simulator.** "Simulate incident" on a demo alert replays its scripted monitoring signals for about 4 seconds (p99 rising, error rate, Redis errors), then opens the incident and starts the diagnosis automatically. It is frontend-only and uses the `signals` field in `demo_alerts.json`. The UI labels it as a simulation.
10. **Patterns page.** Hindsight's consolidated observations, listed by the service they mention, plus one reflect answer: "What failure patterns keep recurring, and which fixes failed each time?" Each pattern cites incident IDs.

**Stretch:** "Ask the history" (free-form reflect).

**Out of scope:** real PagerDuty, Datadog or Kubernetes integrations; executing commands; LLM tool-calling loops (see section 11); authentication, multi-tenancy and billing.

## 5. Architecture

- **Web app:** React 18, Vite, TypeScript, Tailwind, Framer Motion, Lucide.
- **Backend:** FastAPI with:
  - an investigation orchestrator (`services/diagnosis.py`) that runs the steps and streams them
  - a memory service (`services/memory.py`, Hindsight)
  - an evidence step (`services/evidence.py`, which checks claims against the attempts table)
  - an LLM service (`services/llm.py`, OpenRouter)
  - an incident store (SQLite)
- **External services:** Hindsight Cloud and OpenRouter (`nvidia/nemotron-3-ultra-550b-a55b:free`, fallback `nvidia/nemotron-3-super-120b-a12b:free`).

**Diagnosis pipeline (`POST /api/incidents/{id}/diagnose?memory=true`, streamed as NDJSON)**

1. `step: parse`: service, severity and error signature pulled from the alert without an LLM.
2. `step: recall`: `arecall` (about 1 s). The event carries the recalled memories and matched incidents, and the UI renders the memory cards immediately.
3. `step: evidence`: fix-attempt outcomes for every matched incident, loaded from SQLite (history is imported from `postmortems.json`, and live attempts are added as they are logged).
4. `step: reflect`: `areflect` at budget `low` (measured 9-12 s) with a `response_schema` asking for Hindsight's own verdict: `strong_precedent` and `matching_incident_ids`. It starts in parallel with step 2 and is reported when it finishes.
5. `step: diagnosis`: the LLM formats everything into a `Diagnosis`. The evidence step then drops any cited or evidence ID that recall did not return or the attempt log does not support.
6. Failure handling: fallback model, then a degraded card with the raw reflect text. Hindsight down gives a readable `memory_unavailable` event. The stream never ends silently.
7. `memory=false` skips recall, evidence and reflect and sends only the alert to the LLM.

**Data model (SQLite)**

| Table | Fields |
| --- | --- |
| incidents | id, title, service, severity, status, alert_text, created_at, resolved_at, root_cause, fix, ttr_minutes |
| attempts | id, incident_id, action, outcome (worked, failed, partial), notes, created_at |
| diagnoses | id, incident_id, memory_enabled, payload_json, recalled_ids, latency_ms, created_at |

**API**

| Method and path | Does |
| --- | --- |
| POST /api/incidents | Create an incident from alert text; retain the alert |
| POST /api/incidents/{id}/diagnose?memory=true | Investigation pipeline, streamed as NDJSON events |
| POST /api/incidents/{id}/attempts | Record a fix outcome; retain it |
| POST /api/incidents/{id}/postmortem-draft | LLM drafts a postmortem from the session |
| POST /api/incidents/{id}/resolve | Save and retain the postmortem; returns the Experience Captured payload |
| GET /api/incidents, GET /api/incidents/{id} | History list and detail |
| GET /api/memory/stats | Memory count and observation count |
| GET /api/demo-alerts | The 3 demo alerts with their signal scripts |
| GET /api/learning | Diagnoses in order, for the learning-curve strip |
| GET /api/patterns | P1: observations plus the patterns reflect answer |

## 6. UI and UX

A dark SRE command centre, not a chatbot. Design rules are in `CLAUDE.md` section 9.

| Region | Contents |
| --- | --- |
| Top bar | Product name, bank name, memory count, Memory on/off toggle |
| Left | Incident: signal simulator or pasted alert, service, severity, demo chips |
| Centre | Diagnosis: summary and confidence, hypotheses, green Try First card with outcome buttons, red Avoid card with the incidents where each fix failed |
| Right | "Why I think this": matched incidents with relevance, then memory cards |
| Under the centre | Investigation timeline: each step with its duration, filling in live |
| Bottom | Learning-curve strip and the "Resolve incident" button |

**UX rules**

- Recall cards appear within 2 s. The full diagnosis arrives in about 12-20 s (measured in Phase 3; reflect is 9-12 s of that), and every second is covered by a live timeline step. There is never a bare spinner.
- Every claim links to a verified incident. No citation, no claim.
- Every recalled memory shows its date and relative age ("7 weeks ago").
- Numbers on screen are computed from real data: relevance, counts, durations and confidence. No invented statistics.
- Memory off shows a muted "Without memory" card.
- Empty and error states are designed, never blank.

## 7. Synthetic dataset

**Company:** Nimbus Pay, a 60-person payments SaaS on Kubernetes (AWS ap-south-1), Postgres 15, Redis 7 and Kafka. Six services: `payments-api`, `checkout-web`, `ledger-worker`, `notifications-svc`, `auth-service`, `search-api`. Eight fictional engineers rotate on call.

**45 incidents, INC-001 to INC-045, 2 March to 20 September 2026** (built and validated in Phase 1)

| Family | Incidents | Fix that failed | Fix that worked |
| --- | --- | --- | --- |
| Redis pool exhaustion after a concurrency change | INC-003, INC-014, INC-030, INC-037 | Restart pods (failed in all 4) | Raise REDIS_MAX_POOL 20 to 50, roll back worker concurrency |
| Kafka consumer lag after a deploy | INC-007, INC-018, INC-034 | Scale consumers up | Roll back the batch-size config |
| Postgres lock from a migration | INC-004, INC-015, INC-025 | Kill the blocking query (Job retried it) | Cancel cleanly, re-run off-peak with lock_timeout |
| Memory leak, OOMKilled | INC-009, INC-019, INC-028 | Raise the memory limit | Pin template-cache to an exact version |
| Third-party rate limits | INC-011, INC-022, INC-040 | Retry harder | Exponential backoff plus queueing |
| TLS certificate expiry | INC-008, INC-023 | Manual renewal (recurred after 90 days) | cert-manager auto-renew |
| One-offs, including near-miss distractors | 27 | varies | varies |

**Demo alerts** (`data/demo_alerts.json`, never in memory until used live):

1. **DEMO-A:** `payments-api` p99 4.2 s, `redis.exceptions.ConnectionError: Too many connections`, concurrency raised 8 to 24. Strong match.
2. **DEMO-B:** `ledger-worker` lag 184,322 on `ledger-cg` after a deploy. Matches the Kafka family.
3. **DEMO-C:** `search-api` 502s after a CDN origin change (TLS SNI mismatch). No precedent. Its `follow_up_alert` is the same failure on **checkout-web**, worded differently, so the learning proof also shows the agent applying what it learned to a different service.

Each demo alert has a `signals` script for the simulator.

## 8. Demo script (3 minutes)

| Time | Beat | Shown |
| --- | --- | --- |
| 0:00–0:15 | The pain | 2:40 AM. Priya is paged. Marcus, who fixed this three times, has left. |
| 0:15–0:30 | Detect | "Simulate incident" on DEMO-A: signals stream in, INC-046 opens, the investigation starts |
| 0:30–0:45 | Memory off | Generic advice that includes "restart the service" |
| 0:45–1:25 | Memory on | Timeline fills live; recall shows INC-037, INC-014, INC-030 with relevance; Avoid: restart pods, failed in 4 incidents; Try First: raise the pool and roll back concurrency; impact row next to the memory-off answer |
| 1:25–1:50 | Human acts, agent learns | Priya clicks "Worked" on Try First, resolves; the Experience Captured card shows what was retained and the memory count going up |
| 1:50–2:40 | Learning proof | DEMO-C: "No strong precedent", low confidence. Log "purged CDN cache: failed" and "fixed origin SNI host: worked", resolve. The checkout-web follow-up alert now gets a confident answer citing INC-047 and warns against purging the cache. The learning strip jumps. |
| 2:40–3:00 | Close | "The first incident was solved by an engineer. The second was solved using what the team learned from the first." Loop diagram and Hindsight slide. |

**Demo safety:** run `reset_bank.py` before every take, use preset chips only, warm up OpenRouter once before judging, and record a fallback video.

## 9. Judging fit and risks

| Criterion | How we score |
| --- | --- |
| Innovation (30%) | Failed fixes are first-class memory, and warnings are checked against the attempt log, not generated |
| Hindsight (25%) | Recall, reflect and retain are the product loop; directives, disposition and observations used; live on/off; one resolved incident visibly changes the next answer |
| Technical (20%) | Streamed investigation pipeline, typed schemas, citation and evidence verification in code, fallback model, graceful degradation, seed, reset and probe scripts, tests |
| UX (15%) | SRE command centre, live timeline, "Why I think this", Experience Captured, a 3-minute story |
| Impact (10%) | Every SaaS team has on-call; clear path to a Slack or PagerDuty product |

| Risk | Fallback |
| --- | --- |
| Reflect latency (8.9 s at budget low) | Stream recall first, run reflect in parallel with the evidence step, and keep a timeline step visible the whole time |
| LLM JSON errors or free-tier 429/503 | Fallback model, then a degraded card with the reflect text; warm up before judging; $10 of OpenRouter credits raises the daily cap |
| Reflect names a real ID with the wrong story (seen once in the DEMO-C probe) | Evidence verification drops IDs not in recall or not supported by the attempt log |
| Hindsight Cloud down or out of credits | Open-source Hindsight locally; change `HINDSIGHT_BASE_URL` and reseed |
| Recall picks the wrong incident | Distinct family signatures (verified in the Phase 2 probe); rerun `memory_probe.py` after any data change |
| Scope creep | P1 only after the P0 demo runs end to end; section 11 lists what was cut |

## 10. Submission checklist

- [ ] Public GitHub repo with clean, documented code and a README covering the problem, architecture, setup and Hindsight usage
- [ ] 3-minute demo video following section 8
- [ ] Live demo to the judges from the deployed URL
- [ ] Written explanation of how Hindsight memory is used (`docs/HINDSIGHT_USAGE.md`)
- [ ] Article, social post and video from every team member, per the official content guide
- [ ] Project shared through the content-guide challenges; re-read the guide before submitting

**Resources:** Hindsight docs https://hindsight.vectorize.io/, GitHub https://github.com/vectorize-io/hindsight, Cloud https://ui.hindsight.vectorize.io (promo `MEMHACK99`), the Hindsight Community Slack, and inspiration at https://github.com/vectorize-io/self-driving-agents.

## 11. Upgrade review: adopted, changed, cut

| Proposal from the upgrade plan | Decision | Reason |
| --- | --- | --- |
| Failed fixes as the signature feature | Adopted, strengthened | Avoid and Try First are checked in code against the attempt log, so counts like "failed in 4 incidents" are real |
| Evidence-based diagnosis, "Why I think this" | Adopted | Matched incidents with Hindsight relevance, verified counts and the most recent match date |
| Agent investigation timeline | Adopted as P0 | Real streamed steps with durations. It also hides the 9 s reflect latency, which was the open problem after Phase 2 |
| Memory on/off A/B | Kept, plus a computed impact row | Already in the plan; the impact row uses the two real diagnoses |
| Human in the loop (approve, reject with reason) | Adopted as outcome buttons on Try First | Same memory value with no extra screen; the reason goes in the note |
| Experience Captured card | Adopted | Shows the exact text retained and the memory count change, which makes retain visible |
| Synthetic incident detector | Adopted as P1, frontend-only | Replays scripted signals from `demo_alerts.json`. No backend detector service is needed for the story |
| Pattern detection | Adopted as P1 Patterns page | Uses Hindsight's own consolidated observations, which counts toward the Hindsight criterion |
| DEMO-C should generalise | Adopted | The follow-up alert moves to checkout-web, so the learning proof also crosses services |
| Final demo line | Adopted | "The first incident was solved by an engineer. The second was solved using what the team learned from the first." |
| LLM tool-calling agent (search_incidents, get_postmortem and so on) | Cut | The problem statement warns about function-calling errors; free Nemotron models are rate limited; each tool round trip adds 2–7 s. The deterministic pipeline shows the same agent steps reliably |
| Similarity percentages like "INC-042 96%" | Changed | Only Hindsight's real reranker relevance is shown, and only real incident IDs |
| "7 incidents, 4 successes, 3 failures" copy | Changed | Every count is computed from recall and the attempt log; the Redis family really has 4 failed restarts |
| "Scale pods failed" for Redis | Cut | Not in our data; we don't invent failures |
| Knowledge evolution tree, month-by-month experience graph | Cut | High build cost; the Patterns page and learning strip prove the same thing with real data |
| Learning Progress bars for incidents 1 to 20 | Cut | There are not 20 live incidents in a demo; the learning strip shows the real session |
| Dataset expansion | Not needed | Phase 1 data already has wrong first guesses, failed and worked attempts, follow-ups never done, and cross-references |
| INC-042 and INC-051 contradiction | Already fixed | Docs use INC-030 and INC-037 |
| Emoji icons in the mockups | Cut | CLAUDE.md rule 3; Lucide icons only |
