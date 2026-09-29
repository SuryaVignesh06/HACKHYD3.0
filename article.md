# Remember What Failed: Building an Incident Agent That Can't Make Up Its Own Past

The worst thing an on-call engineer can do at 2 AM isn't failing to find the fix. It's confidently applying a fix that already failed three times, because the person who learned that lesson is asleep, has changed teams, or wrote it down in a Slack thread nobody can find.

We built FRIDAY to close that gap. It's a desktop agent: you press Ctrl+Space, it reads the error on your screen, recalls the incidents your team has already handled, checks your repository for the setting those incidents changed, and tells you what to try first and what not to try. When you resolve the incident, what you learned goes back into memory. The next person with the same error starts from your answer instead of from zero.

The retrieval part turned out to be the easy half. The hard half, and the subject of this post, is making sure the agent never cites a past incident that doesn't support the claim it's making. An agent that invents history is worse than one with no history at all.

## How it hangs together

The system has four parts, and each one is deliberately boring:

- **An Electron shell.** It owns the global shortcut, a small overlay card, and the few native things a web page can't do. It reads the foreground window to figure out which IDE and folder you're in, reads the screen with Windows' built-in OCR only after you say yes, and shows a native consent dialog before the backend may read a project folder.
- **A FastAPI backend.** It orchestrates each investigation as a stream of steps: parse, recall, evidence, inspect, reflect, diagnosis. The UI fills in live as each step finishes.
- **[Hindsight](https://github.com/vectorize-io/hindsight)**, which holds everything the team has learned. Incidents, every fix attempt with its outcome, and postmortems all live in one memory bank.
- **An LLM on OpenRouter.** Its job is deliberately narrow. It formats evidence into a structured diagnosis and writes answers from evidence it is handed. It never supplies knowledge of its own.

That last constraint shaped everything else. CLAUDE.md, the file that tells our coding assistant how to work in the repo, says it plainly: "The LLM never invents knowledge." Memory is Hindsight's job. Current state is the project's job. The model only turns both into readable text.

## Why memory had to be a real memory system

We started where everyone starts: embeddings in a vector store, top-k chunks pasted into a prompt. It answered "have we seen this before?" reasonably well. It couldn't answer "did restarting the pods help last time?", which is the question that actually matters during an outage.

What we needed looked less like document retrieval and more like [agent memory](https://vectorize.io/what-is-agent-memory): facts pulled out of events, stored with the time they happened, and searchable by meaning and by time. Hindsight gives us three operations that map almost one-to-one onto the incident lifecycle:

- **retain**, when something happens (an alert, a fix attempt, a postmortem);
- **recall**, when a new incident arrives;
- **reflect**, when we want the memory system itself to reason across what it recalled.

The [Hindsight docs](https://hindsight.vectorize.io/) push you to write memories as natural language rather than JSON, because the system pulls facts out of the text. That one piece of advice changed how we log fix attempts. Every attempt becomes a sentence that names the incident, the service, the date, and the outcome:

```python
def format_attempt_memory(incident: IncidentFacts, attempt: AttemptFacts) -> str:
    when = attempt.created_at or incident.started_at
    sentence = (
        f"During {incident.id} on {incident.service} ({human_date(when)}), the on-call engineer tried: "
        f"{attempt.action}. Outcome: {OUTCOME_WORDS[attempt.outcome]}."
    )
    if attempt.notes:
        sentence += f" {attempt.notes}"
    return sentence
```

It looks trivial. It's the most important function in the codebase. A failed attempt stored as "During INC-030 on payments-api (Aug 12), the on-call engineer tried: Rolling restart of payments-api pods. Outcome: failed." is something recall can find and reflect can reason about. The same data as `{"outcome": 0}` is not.

We also configure the memory bank itself, not just what goes into it. The bank has a mission, a disposition that leans skeptical, and a set of directives that act as hard rules for reflect:

```python
BANK_DISPOSITION = {"skepticism": 4, "literalism": 3, "empathy": 2}
DIRECTIVES: list[tuple[str, str]] = [
    ("cite-incident-ids", "Always cite incident IDs (for example, INC-030) for every claim."),
    ("warn-failed-fixes", "Always warn when a proposed fix failed in a past incident, and name that incident."),
    ("rollback-for-destructive", "Never suggest a destructive command without a rollback step."),
    ("no-strong-match", "If no past incident is a strong match, say so plainly instead of guessing."),
]
```

"Say so plainly instead of guessing" is the single most valuable line of configuration we wrote.

## The core problem: memory makes hallucination more convincing

Here is the part nobody warns you about. Once an agent has real memory, its mistakes stop looking like mistakes. A hallucinated answer with no citations looks like a guess. A hallucinated answer that cites INC-034 looks like evidence.

We saw this directly. For an alert about a TLS SNI mismatch on our search API, the formatter wrote that the problem "matches the failure mechanism in INC-034 and INC-014." Neither incident had anything to do with TLS. Both had been recalled, both had high relevance scores for unrelated reasons, and the model stitched them into a confident story.

Relevance scores alone didn't save us either. One stray memory scored 0.94 against an alert it had nothing to do with. Hindsight's reflect verdict and the formatter's verdict were each right most of the time, and each wrong on a different subset of runs.

So we stopped trusting any single signal and made agreement a requirement:

```python
def confirm_precedent(candidates: set[str], hindsight_strong: bool | None, llm_strong: bool,
                      llm_ids: list[str]) -> tuple[bool, set[str]]:
    named = candidates & set(llm_ids)
    strong = hindsight_strong is not False and llm_strong and bool(named)
    return strong, (candidates if strong else set())
```

A precedent counts only when all three hold:

- Hindsight's reflect didn't say "no";
- the formatter judged the failure mechanism to be the same;
- the formatter named at least one incident whose relevance cleared our citation floor of 0.75.

If any of those fails, the set of citable incidents is empty. With nothing citable, there's no "try this first", no "avoid this", confidence is capped at 0.4, and the summary has to start with "No strong precedent in memory."

## Verifying every claim after the model speaks

Confirming a precedent is only the gate. Every individual claim still gets checked. The rule we enforce in `services/evidence.py` is simple to state and fiddly to implement:

- Every incident ID the model produces is kept only if recall actually returned it.
- A "try first" suggestion keeps an incident as evidence only if that incident's attempt log contains a fix that **worked**.
- An "avoid" warning keeps an incident only if its attempt log contains an attempt that **failed**.
- An avoid item with no surviving evidence is deleted.

The trick that made this workable was to stop letting the model cite incidents in free form. The formatter sees the fix log with stable references:

```
ATTEMPT LOG (ref | outcome | action | notes):
  INC-030#1 | FAILED | Rolling restart of payments-api pods | pool refilled within minutes
  INC-030#2 | WORKED | Raised REDIS_MAX_POOL from 20 to 50 and rolled back worker concurrency
```

It must cite `INC-030#1`, not "INC-030". The backend maps each reference back to the real row in the attempts table. If the model puts a worked attempt under "avoid", the reference resolves to the wrong outcome and the claim is dropped. The model literally can't point an Avoid card at a fix that succeeded.

Free text gets the same treatment. `scrub_unverified` drops any sentence in the summary that names an incident outside the verified set. The TLS example above now comes out as an honest "No strong precedent in memory", followed by an explanation built from the alert alone.

This is also why we retain the alert only after the first diagnosis finishes, not when the incident is created. Early on we retained at creation, and the new incident promptly recalled itself as its own best precedent, at very high relevance.

## Grounding answers in three places, labelled

The diagnosis pipeline handles "here's an error". Engineers also ask questions: "Where do I fix this?", "Why shouldn't I restart Redis?", "What did we do last time?". Those go through a separate path that builds context from three places and labels every fact with where it came from.

What's on screen and what the project contains right now are built deterministically, straight from what FRIDAY read. The history is the only part the model writes, and only for incidents it is allowed to cite:

```python
for item in draft.history[:MAX_HISTORY]:
    summary = scrub_unverified(item.text, citable)
    if item.incident_id in citable and summary:
        history.append(EvidenceItem(source="HINDSIGHT", text=summary, incident_id=item.incident_id))
```

The project facts come from a finder that is deliberately dumb. It pulls config identifiers out of past fixes (`REDIS_MAX_POOL`, `PAYMENTS_WORKER_CONCURRENCY`), searches the authorized folder for where they're assigned today, and reports file, line, and current value. There's no model involved. If the setting isn't in your repo, the answer says the project didn't show where to fix it, rather than inventing a path.

## What it looks like in practice

A typical run: payments-api starts logging `redis.exceptions.ConnectionError: Too many connections` in a terminal inside the IDE. I press Ctrl+Space and start a screen-reading session. The card docks to the corner and a pale blue border shows the screen is being read.

A few seconds later the card says "I've seen this before." It shows:

- the incidents it matched, with relevance scores;
- a Try First of "Raise REDIS_MAX_POOL from 20 to 50 and roll back worker concurrency", backed by the incidents where that fix worked;
- an Avoid card for rolling pod restarts, which failed in several past incidents;
- a pointer to `deploy/helm/payments-api/values-prod.yaml`, line 19, where `REDIS_MAX_POOL` is currently `"20"`.

I edit the value. The service picks up the new config and the errors stop. FRIDAY notices the error is gone from the screen and asks "Did this fix work?" I click Worked, then Resolve and learn. The postmortem draft becomes a retained memory.

The next time the same failure shows up, worded differently and with a different pod name, the headline changes to "I remember this one." It cites the incident we resolved minutes earlier, and flags it as learned in this app rather than seeded history. That's the whole loop: recall, understand, fix, retain.

The opposite case matters just as much. Ask "Why shouldn't I restart the pods?" when memory holds no failed restart for that failure, and the prompt rules require the answer to say so. It won't borrow a failure from an unrelated incident.

## Lessons learned

**1. Store outcomes, not documents.** Our retrieval got useful the day we started retaining each fix attempt as its own sentence with an explicit outcome. "What failed" is the most valuable thing a team knows, and almost no knowledge base records it.

**2. Make the model cite by reference, then check the reference.** Free-form citations can't be verified. `INC-030#1` can. Give the model stable handles to rows you control, and fact-checking becomes a dictionary lookup.

**3. No single confidence signal is trustworthy on its own.** Relevance scores, the memory system's verdict, and the formatter's judgement each failed on different cases. Requiring them to agree cost us some true positives. It removed almost all of the confident nonsense.

**4. Saying "I don't know from our history" is a feature.** We built an explicit no-precedent path with capped confidence and no claims. Engineers trusted the tool more once they had seen it decline.

**5. Timing of writes matters as much as reads.** Retaining too early made incidents recall themselves. Think about when a memory becomes true, not just what it says.

The most useful thing we did was design the agent so it can't fake its own past. What Hindsight gives us is not a magic answer. It's a structured, time-aware record of what the team did and how it turned out. When the rest of the system refuses to go beyond that record, you get an assistant that gets better as your team does.
