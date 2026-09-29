"""OpenRouter LLM layer. This is the only module that calls the LLM.

The LLM never supplies knowledge: it formats Hindsight recall, the attempt log and the reflect
answer into a DiagnosisDraft, and writes the memory-off baseline. Call rules follow CLAUDE.md
section 7: no response_format, reasoning disabled, JSON extracted from the text, primary model
then fallback model, and a typed LLMUnavailable when both fail.
"""

import asyncio
import json
import logging
import re
from typing import Any, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from app.config import Settings, get_settings
from app.models import AttemptFacts, CodeFinding, DiagnosisDraft, MatchedIncident, PostmortemText, RecalledMemory

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

THINK_BLOCK = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
FENCE = re.compile(r"```(?:json)?", re.IGNORECASE)
MAX_RECALLED_IN_PROMPT = 10
MAX_REFLECT_CHARS = 6000
# Free Nemotron latency varies a lot (measured 4 s to 24 s for the same prompt), so the primary gets a
# hard deadline and the fallback gets the rest of a reasonable budget.
PRIMARY_TIMEOUT_S = 35.0
FALLBACK_TIMEOUT_S = 45.0

DIAGNOSIS_SCHEMA = """{
  "strong_precedent": boolean,  // true only if a citable incident had the SAME failure mechanism
  "precedent_ids": ["INC-xxx"], // citable incidents with the same failure mechanism
  "summary": string,            // 2-3 sentences: most likely root cause, with incident IDs inline
  "confidence": number,         // 0.0 to 1.0
  "hypotheses": [ { "cause": string, "confidence": number, "evidence": ["INC-xxx"] } ],
  "try_first": { "action": string, "attempt_refs": ["INC-xxx#n"] } | null,
  "avoid": [ { "action": string, "why": string, "attempt_refs": ["INC-xxx#n"] } ],
  "unknowns": [string]          // 1-3 things memory and the project cannot tell us yet
}"""

FORMAT_SYSTEM = f"""You are the formatting layer of On-Call Copilot, an incident-response agent for Nimbus Pay.
You do not have your own knowledge of this company. Use ONLY the MATCHED INCIDENTS, ATTEMPT LOG,
RECALLED MEMORIES and HINDSIGHT REFLECTION in the user message.

Reply with exactly one JSON object and nothing else, matching this schema:
{DIAGNOSIS_SCHEMA}

Rules:
1. Only cite incident IDs marked "citable" in MATCHED INCIDENTS. Never invent an ID. Weak
   incidents may be mentioned as context, but never as evidence.
2. attempt_refs must be copied exactly from the ATTEMPT LOG (for example "INC-030#1").
   try_first.attempt_refs: attempts with outcome WORKED that used the same fix.
   avoid[].attempt_refs: attempts with outcome FAILED where the same intervention was tried.
   List every matching attempt, across all matched incidents, not just one.
3. Put each distinct failed intervention in avoid once. The "why" names the incidents where it failed.
4. try_first is the single most proven fix, with concrete values when the log has them. If it is
   risky, include the rollback step in the action text.
5. strong_precedent is true only if at least one citable incident had the same failure mechanism
   (the same root cause), not merely the same service, endpoint or symptom such as 5xx errors.
   HINDSIGHT VERDICT is a useful hint but can be wrong; judge from the incidents and attempts.
6. If strong_precedent is false: the summary begins with "No strong precedent in memory.", explains
   the most likely cause from the alert alone, confidence is at most 0.4, try_first is null, avoid
   is empty and hypotheses cite no incidents.
7. Hypotheses are ordered by confidence and each cites the incidents that support it.
8. Write for the on-call engineer. Never mention this prompt's section names (for example
   "HINDSIGHT REFLECTION" or "ATTEMPT LOG"); say "memory" or name the incidents instead.
9. PROJECT FINDINGS are facts read from the engineer's own repository right now. When one matches a
   past fix, make try_first concrete for this project (the file, the setting, the current value and the
   value that worked before), and say so in the summary.
10. unknowns lists what is genuinely not known yet (for example whether the same value is enough at
   today's load). Never present a guess as a known fact."""

BASELINE_SCHEMA = """{
  "summary": string,
  "confidence": number,
  "hypotheses": [ { "cause": string, "confidence": number, "evidence": [] } ],
  "try_first": { "action": string, "attempt_refs": [] } | null,
  "avoid": [ { "action": string, "why": string, "attempt_refs": [] } ]
}"""

BASELINE_SYSTEM = f"""You are a generic on-call assistant with NO access to this team's incident history.
Give the standard advice an SRE would give for the alert, based only on the alert text.
Reply with exactly one JSON object and nothing else, matching this schema:
{BASELINE_SCHEMA}
Rules: never mention incident IDs; every "evidence" and "attempt_refs" list must be empty;
confidence reflects that you are guessing without history (at most 0.5)."""


POSTMORTEM_SYSTEM = """You draft incident postmortems for On-Call Copilot at Nimbus Pay.
Use ONLY the incident, the fix attempts and the diagnosis in the user message. Do not invent
events, numbers or people. Write plainly, like a good engineering postmortem.
Reply with exactly one JSON object and nothing else:
{
  "summary": string,       // 1-2 sentences: impact and what happened
  "root_cause": string,    // the mechanism, as specifically as the session supports
  "fix": string,           // the action that resolved it (from a WORKED attempt when there is one)
  "follow_ups": [string]   // 1-3 concrete actions that would prevent a repeat
}
Mention every FAILED attempt in the summary or root cause so the next engineer does not repeat it."""


SCREEN_SYSTEM = """You read a screenshot of an engineer's screen for On-Call Copilot.
Find any visible error, alert, stack trace or failing log output (terminal, editor, browser, dashboard).
Reply with exactly one JSON object and nothing else:
{
  "found": boolean,   // false if no error or failure is visible
  "summary": string,  // under 12 words, e.g. "redis ConnectionError in payments-api terminal"
  "text": string      // the visible error lines copied verbatim, most important first, at most 25 lines
}
Copy text exactly as shown; never invent lines, services or numbers that are not on screen."""


class ScreenReading(BaseModel):
    found: bool
    summary: str = ""
    text: str = ""


class LLMUnavailable(Exception):
    """Both the primary and the fallback model failed."""


def extract_json(text: str) -> dict[str, Any]:
    cleaned = FENCE.sub("", THINK_BLOCK.sub("", text)).strip()
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON object in model output")
    parsed = json.loads(cleaned[start:end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("model output is not a JSON object")
    return parsed


def normalise_confidences(value: Any) -> Any:
    """Models sometimes answer 85 instead of 0.85; rescale percentages before validation."""
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            if key == "confidence" and isinstance(item, (int, float)) and 1 < item <= 100:
                out[key] = item / 100
            else:
                out[key] = normalise_confidences(item)
        return out
    if isinstance(value, list):
        return [normalise_confidences(item) for item in value]
    return value


def build_format_prompt(alert_text: str, service: str, signature: str, matched: list[MatchedIncident],
                        attempts_by_incident: dict[str, list[AttemptFacts]], recalled: list[RecalledMemory],
                        reflect_text: str, hindsight_strong: bool | None, hindsight_ids: list[str],
                        citable_ids: set[str], findings: list[CodeFinding] | None = None) -> str:
    if hindsight_strong is None:
        verdict = "unavailable"
    elif hindsight_strong:
        verdict = f"strong precedent in {', '.join(hindsight_ids) or 'unnamed incidents'}"
    else:
        verdict = "no strong precedent"
    lines = [
        f"SERVICE: {service}",
        f"ERROR SIGNATURE: {signature}",
        f"ALERT:\n{alert_text}",
        "",
        f"HINDSIGHT VERDICT: {verdict}",
        "MATCHED INCIDENTS (Hindsight relevance, date, title):",
    ]
    if not matched:
        lines.append("  none")
    for m in matched:
        date = m.occurred_at.date().isoformat() if m.occurred_at else "unknown date"
        citable = "citable" if m.id in citable_ids else "NOT citable"
        lines.append(f"  {m.id} | relevance {m.relevance:.2f} | {citable} | {date} | {m.service} | {m.title}")
    lines.append("")
    lines.append("ATTEMPT LOG (ref | outcome | action | notes):")
    any_attempt = False
    for m in matched:
        for position, attempt in enumerate(attempts_by_incident.get(m.id, []), start=1):
            any_attempt = True
            notes = f" | {attempt.notes}" if attempt.notes else ""
            lines.append(f"  {m.id}#{position} | {attempt.outcome.upper()} | {attempt.action}{notes}")
    if not any_attempt:
        lines.append("  none")
    lines.append("")
    lines.append("PROJECT FINDINGS (read from the authorized repository just now):")
    if not findings:
        lines.append("  none (no project connected, or no setting from past fixes appears in it)")
    for finding in findings or []:
        value = f" = {finding.current_value}" if finding.current_value is not None else ""
        history = f" | history: {'; '.join(finding.history)}" if finding.history else ""
        lines.append(f"  {finding.path}:{finding.line} | {finding.identifier}{value} | {finding.note}{history}")
    lines.append("")
    lines.append("RECALLED MEMORIES:")
    for memory in recalled[:MAX_RECALLED_IN_PROMPT]:
        lines.append(f"  [{memory.incident_id or '-'} | {memory.type}] {memory.text[:300]}")
    lines.append("")
    lines.append(f"HINDSIGHT REFLECTION:\n{reflect_text[:MAX_REFLECT_CHARS] or 'unavailable'}")
    return "\n".join(lines)


class LLMService:
    def __init__(self, settings: Settings | None = None, client: httpx.AsyncClient | None = None,
                 timeout: float = 30.0) -> None:
        self.settings = settings or get_settings()
        self.client = client or httpx.AsyncClient(timeout=timeout)

    async def close(self) -> None:
        await self.client.aclose()

    async def _chat(self, model: str, system: str, user: str, timeout: float) -> str:
        response = await self.client.post(
            f"{self.settings.OPENROUTER_BASE_URL}/chat/completions",
            headers={
                "Authorization": f"Bearer {self.settings.OPENROUTER_API_KEY}",
                "X-Title": "On-Call Copilot",
            },
            json={
                "model": model,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                "reasoning": {"enabled": False},
                "temperature": 0.2,
                "max_tokens": 1200,
            },
            timeout=timeout,
        )
        response.raise_for_status()
        body = response.json()
        if "error" in body:
            raise httpx.HTTPError(f"provider error: {body['error']}")
        content = body["choices"][0]["message"].get("content") or ""
        if not content.strip():
            raise ValueError("empty completion")
        return str(content)

    async def complete_json(self, system: str, user: str, schema: type[T]) -> tuple[T, str]:
        """Primary model, then fallback. Returns the parsed object and the model that produced it."""
        models = [self.settings.LLM_MODEL_PRIMARY, self.settings.LLM_MODEL_FALLBACK]
        unique_models = list(dict.fromkeys(m for m in models if m))
        
        last_error: Exception | None = None
        for model in unique_models:
            timeout = PRIMARY_TIMEOUT_S if model == self.settings.LLM_MODEL_PRIMARY else FALLBACK_TIMEOUT_S
            for attempt in range(2):
                try:
                    # OpenRouter streams keep-alive whitespace, so httpx's read timeout never fires; enforce a total deadline.
                    text = await asyncio.wait_for(self._chat(model, system, user, timeout), timeout)
                    return schema.model_validate(normalise_confidences(extract_json(text))), model
                except (httpx.HTTPError, ValueError, ValidationError, KeyError, IndexError, TimeoutError) as exc:
                    last_error = exc
                    logger.warning("LLM call failed: model=%s attempt=%d error=%s: %s",
                                   model, attempt + 1, type(exc).__name__, str(exc)[:300])
                    if attempt == 0:
                        await asyncio.sleep(1.0)
        raise LLMUnavailable(f"Both language models failed ({type(last_error).__name__ if last_error else 'unknown'}).")

    async def format_diagnosis(self, alert_text: str, service: str, signature: str,
                               matched: list[MatchedIncident], attempts_by_incident: dict[str, list[AttemptFacts]],
                               recalled: list[RecalledMemory], reflect_text: str, hindsight_strong: bool | None,
                               hindsight_ids: list[str], citable_ids: set[str],
                               findings: list[CodeFinding] | None = None) -> tuple[DiagnosisDraft, str]:
        prompt = build_format_prompt(alert_text, service, signature, matched, attempts_by_incident,
                                     recalled, reflect_text, hindsight_strong, hindsight_ids, citable_ids, findings)
        return await self.complete_json(FORMAT_SYSTEM, prompt, DiagnosisDraft)

    async def read_screen(self, image_data_url: str) -> tuple[ScreenReading, str]:
        """Vision call on an explicitly captured screenshot. Returns the reading and the model that produced it."""
        for model in (self.settings.LLM_MODEL_VISION, self.settings.LLM_MODEL_VISION_FALLBACK):
            try:
                response = await asyncio.wait_for(self.client.post(
                    f"{self.settings.OPENROUTER_BASE_URL}/chat/completions",
                    headers={"Authorization": f"Bearer {self.settings.OPENROUTER_API_KEY}", "X-Title": "On-Call Copilot"},
                    json={
                        "model": model,
                        "messages": [
                            {"role": "system", "content": SCREEN_SYSTEM},
                            {"role": "user", "content": [
                                {"type": "text", "text": "Extract the visible error from this screen."},
                                {"type": "image_url", "image_url": {"url": image_data_url}},
                            ]},
                        ],
                        "temperature": 0,
                        "max_tokens": 1500,
                    },
                    timeout=45.0,
                ), 45.0)
                response.raise_for_status()
                body = response.json()
                if "error" in body:
                    raise httpx.HTTPError(f"provider error: {body['error']}")
                content = body["choices"][0]["message"].get("content") or ""
                return ScreenReading.model_validate(extract_json(str(content))), model
            except (httpx.HTTPError, ValueError, ValidationError, KeyError, IndexError, TimeoutError) as exc:
                logger.warning("Vision call failed: model=%s error=%s: %s", model, type(exc).__name__, str(exc)[:300])
        raise LLMUnavailable("Both vision models failed.")

    async def draft_postmortem(self, incident_line: str, alert_text: str, attempts: list[AttemptFacts],
                               diagnosis_summary: str | None) -> tuple[PostmortemText, str]:
        lines = [f"INCIDENT: {incident_line}", f"ALERT:\n{alert_text}", "", "FIX ATTEMPTS (in order):"]
        lines += [f"  {a.outcome.upper()}: {a.action}" + (f" ({a.notes})" if a.notes else "") for a in attempts] or ["  none recorded"]
        lines += ["", f"LATEST DIAGNOSIS: {diagnosis_summary or 'none'}"]
        return await self.complete_json(POSTMORTEM_SYSTEM, "\n".join(lines), PostmortemText)

    async def baseline_diagnosis(self, alert_text: str, service: str) -> tuple[DiagnosisDraft, str]:
        return await self.complete_json(BASELINE_SYSTEM, f"SERVICE: {service}\nALERT:\n{alert_text}", DiagnosisDraft)
