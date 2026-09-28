# About On-Call Copilot

## 1. What it is

On-Call Copilot is an incident response agent that remembers every production outage a team has handled, and uses that memory to resolve the next one faster.

**One-line pitch:** Remember what failed, not just what worked. When an incident opens, the Copilot tells you which past incidents match, what the real root cause was, which fix worked, and which fixes already failed. Every warning is checked against the incidents where the fix actually failed.

Monitoring tools tell you what is happening. Generic AI tells you what might work. On-Call Copilot remembers what your team already tried.

Think of it as a senior site reliability engineer who has been on the team for a year, never forgets an outage, and is awake at 3 AM when you are paged.

## 2. The problem it solves

- **Knowledge is scattered.** What the team learned from past incidents lives in old postmortems, Slack threads and the heads of a few senior engineers.
- **The on-call engineer was not there last time.** At 3 AM the person holding the pager is often the one who never saw this failure before, and the engineer who fixed it may have left the company.
- **Teams repeat their mistakes.** The same bad restart, the same wrong rollback and the same missed config change get tried again, incident after incident.
- **Generic AI gives generic advice.** A normal chatbot says "check the logs, restart the service" because it knows nothing about your systems or your history.

## 3. What it does, step by step

1. **An alert comes in.** The engineer pastes an alert, log line or stack trace into the console.
2. **It recalls.** The Copilot searches its memory for past incidents with the same symptoms, service, error signature and timing.
3. **It reasons.** It reflects across those incidents and works out what is most likely happening.
4. **It answers with evidence.** The engineer gets:
   - the likely root cause, with a confidence score
   - the fix to try first
   - the fixes to avoid, because they failed before
   - the incident IDs every claim is based on
5. **The engineer logs what they try.** One click records "tried this, worked" or "tried this, failed". Each entry goes straight into memory.
6. **The incident is resolved.** A short postmortem, pre-filled from the session, is saved into memory.
7. **It gets smarter.** The next similar alert benefits from everything learned in this one.

```
   alert pasted
        |
        v
   RECALL similar past incidents  <-------------------+
        |                                             |
        v                                             |
   REFLECT across them -> cited diagnosis             |
        |                                             |
        v                                             |
   engineer tries fixes -> RETAIN each attempt -------+
        |                                             |
        v                                             |
   incident resolved -> RETAIN postmortem ------------+
```

## 4. Who uses it

**Primary user: the on-call engineer.** A backend or SRE engineer at a SaaS company of 20 to 200 people, handling production incidents without a dedicated incident team.

> Priya is a backend engineer who is on call this week. At 2:40 AM she is paged: `payments-api` p99 latency has hit 4 seconds. She knows her own services well, but not this one. The engineer who fixed this last time has left. She needs to know: has this happened before, what was it, and what should I try first?

**Secondary user: the engineering manager.** They want recurring failure patterns surfaced so they can argue for a permanent fix instead of another patch.

## 5. Where it is used

| Setting | How the Copilot fits in |
| --- | --- |
| Live incident response | A console open next to the pager, dashboards and logs. It is the first thing the engineer checks after an alert fires. |
| Closing an incident | It drafts the postmortem from what happened during the session, so writing it takes minutes, not an hour. |
| Onboarding new on-call engineers | New team members get the team's full incident history from their first shift. |
| Reliability reviews | Managers see which failure modes keep coming back and how much time they cost. |

The Copilot gives advice and people take action. It never runs commands on infrastructure.

## 6. Usage scenarios

### Scenario A: a repeat incident at 2:40 AM

- **Situation:** `payments-api` p99 latency is at 4.2 s, and the logs show `redis.exceptions.ConnectionError: Too many connections`.
- **What the engineer does:** pastes the alert and clicks Diagnose.
- **What the Copilot says:** "This matches INC-030 (Aug 12) and INC-037 (Sep 3): Redis connection pool exhaustion after a deploy raised worker concurrency. Restarting pods failed both times. The fix that worked was to raise REDIS_MAX_POOL from 20 to 50 and roll back the worker concurrency change."
- **Outcome:** the engineer skips the dead-end restart and applies the known fix within minutes.

### Scenario B: avoiding a dead end

- **Situation:** `ledger-worker` Kafka consumer lag is at 184,322 on consumer group `ledger-cg`, right after a deploy.
- **What the engineer does:** pastes the alert. Their instinct is to scale up the consumers.
- **What the Copilot says:** scaling consumers up failed in past incidents from the same family. Roll back the batch-size config change from the deploy instead.
- **Outcome:** about 30 minutes saved that would have gone into a fix already proven not to work.

### Scenario C: something never seen before

- **Situation:** `search-api` is returning 502s after a CDN config change. Nothing like this is in memory.
- **What the Copilot says:** it states plainly that there is no strong precedent, and gives a low-confidence answer instead of inventing one.
- **Outcome:** the engineer trusts the tool more, because it does not overclaim. After the incident is resolved, the fix is in memory for next time.

### Scenario D: learning live

- **Situation:** continuing Scenario C, the engineer logs one fix that failed and one that worked, then resolves the incident with a postmortem.
- **What happens next:** the same CDN failure hits a different service, checkout-web, with differently worded logs. The Copilot cites the search-api incident it just learned from, answers with higher confidence, and warns against purging the CDN cache because that failed last time.
- **Outcome:** the Copilot gets measurably better from a single resolved incident, and applies that experience to a different service. The first incident was solved by an engineer. The second was solved using what the team learned from the first.

### Scenario E: onboarding a new on-call engineer

- **Situation:** a new engineer joins the on-call rotation in their second month.
- **What happens:** every incident they face comes with the team's history attached: what broke, what was tried, and what worked.
- **Outcome:** the knowledge of senior engineers stays with the team after they move on.

### Scenario F: finding recurring patterns (stretch feature)

- **Situation:** an engineering manager is preparing a quarterly reliability review.
- **What happens:** the Patterns page shows recurring failure modes with counts, for example "Redis pool exhaustion: 4 incidents in payments-api".
- **Outcome:** the manager has evidence to fund a permanent fix.

### Scenario G: asking the history (stretch feature)

- **Situation:** before a Postgres upgrade, an engineer asks "What broke after the last Postgres upgrade?"
- **What happens:** the Copilot answers from memory and cites the relevant incidents.
- **Outcome:** the team can explore past incidents without digging through old documents.

## 7. Memory on vs memory off

The console has a Memory on/off toggle, so the difference is shown live instead of claimed. Here is the same alert, `payments-api` p99 at 4.2 s with Redis timeouts, in both modes:

| Mode | Answer |
| --- | --- |
| Memory off | "Check CPU and memory, look at recent deploys, consider restarting the service." |
| Memory on | "Matches INC-030 (Aug 12) and INC-037 (Sep 3): Redis pool exhaustion after a deploy raised concurrency. Restarting pods failed both times. The fix that worked: raise REDIS_MAX_POOL from 20 to 50 and roll back the worker concurrency change." |

Without memory the Copilot is a generic chatbot. With memory it behaves like a senior engineer who was there.

## 8. How it works under the hood

- **Hindsight (memory)** holds all team knowledge. It stores every incident, fix attempt and postmortem, recalls similar ones and reasons across them.
- **The language model (NVIDIA Nemotron 3 via OpenRouter)** only formats. It turns what Hindsight returns into a structured diagnosis, drafts postmortems and produces the memory-off baseline. It never invents knowledge, and it may only cite incident IDs that memory actually returned.
- **FastAPI backend** handles the requests and keeps the incident list in SQLite.
- **React frontend** is a dark console in the style of an SRE tool, with a "Why I think this" panel that shows the recalled memories behind every answer.

| User moment | Hindsight call |
| --- | --- |
| Loading the team's past incidents | `retain_batch` |
| A new incident is created | `retain` (alert) |
| Diagnosing an alert | `recall` + `reflect` |
| Logging a fix attempt | `retain` (fix-attempt, with outcome) |
| Resolving the incident | `retain` (postmortem) |
| Asking the history (stretch) | `reflect` |
| Patterns page (stretch) | `list_memories` (observations) + `reflect` |

Every claim in the UI links to a source incident. No citation means no claim.

## 9. Why it matters

- **Faster diagnosis.** Mean time to diagnosis goes from minutes of guessing to seconds for known failure modes.
- **Fewer repeated mistakes.** The Copilot remembers failed fixes, not just facts, and warns you away from them.
- **Knowledge that never leaves.** Incident knowledge stays with the team when people change roles or leave.
- **A real product path.** Every SaaS team has on-call. The next step is a Slack bot or a PagerDuty and Datadog integration that attaches a diagnosis to every page.
- **It passes the "$50 a month" test.** One hour of payments downtime costs far more than a seat license, so a team would clearly pay for this.

## Hackathon fit

Built for "AI Agents That Learn Using Hindsight" (HackwithHyderabad 3.0, Vectorize).

- **Officially validated idea.** The problem statement lists an "Incident Response Agent" under Engineering and DevOps as a real business use case.
- **Memory is the star.** Take away Hindsight and the Copilot becomes a generic chatbot. The Memory on/off toggle proves this live.
- **Visible learning curve.** A strip on the console shows confidence and citations rising with each diagnosis, from a cautious first answer to a confident, cited one after a single resolved incident.
- **Long-term recall.** Every recalled memory shows its age ("7 weeks ago"), so recall from weeks back is visible.
- **Beyond a basic incident bot.** It learns from failed fixes, not just successful ones, and it says honestly when nothing matches.

## 10. What it is not

- It does not run commands or change infrastructure. People stay in control.
- The MVP has no real PagerDuty, Datadog or Grafana integrations. Alerts are pasted in.
- It has no login, multi-team support or billing.

## 11. The demo company: Nimbus Pay

The demo runs on synthetic history from Nimbus Pay, a fictional payments SaaS company with 60 people. It runs Kubernetes on AWS, Postgres 15, Redis 7 and Kafka, with six services: `payments-api`, `checkout-web`, `ledger-worker`, `notifications-svc`, `auth-service` and `search-api`.

The memory holds 45 incidents (INC-001 to INC-045) from March to September 2026:

| Recurring failure family | Incidents | Fix that failed | Fix that worked |
| --- | --- | --- | --- |
| Redis pool exhaustion after a concurrency change | 4 | Restart pods | Raise REDIS_MAX_POOL, roll back worker concurrency |
| Kafka consumer lag after a deploy | 3 | Scale consumers up | Roll back the batch-size config |
| Postgres lock from a long migration | 3 | Kill the blocking query | Run migrations with lock_timeout, off-peak |
| Memory leak, OOMKilled pods | 3 | Raise the memory limit | Pin the template-cache library version |
| Third-party rate limits | 3 | Retry harder | Exponential backoff plus queueing |
| TLS certificate expiry | 2 | Manual renewal (the problem came back) | cert-manager auto-renew |

The other 27 are one-off incidents, such as DNS failures, bad feature flags, full disks and CDN outages. They are realistic noise, so recall has to tell the real matches apart.

The two latest Redis incidents in the examples above are INC-030 (12 August 2026) and INC-037 (3 September 2026). The other two Redis incidents are INC-003 and INC-014.
