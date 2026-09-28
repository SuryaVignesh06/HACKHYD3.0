"""Validates the Nimbus Pay dataset in data/ against the rules in docs/PRD.md section 7.

Exits 1 and lists every problem if any check fails; prints a summary table either way.
"""

import json
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parents[1] / "data"

SERVICES = {"payments-api", "checkout-web", "ledger-worker", "notifications-svc", "auth-service", "search-api"}
SEVERITIES = {"SEV1", "SEV2", "SEV3"}
OUTCOMES = {"worked", "failed", "partial"}
EXPECTED_FAMILIES = {
    "redis-pool-exhaustion": 4,
    "kafka-consumer-lag": 3,
    "postgres-migration-lock": 3,
    "memory-leak-oom": 3,
    "third-party-rate-limit": 3,
    "tls-cert-expiry": 2,
}
FAMILY_SIGNATURES = {
    "redis-pool-exhaustion": "redis.exceptions.ConnectionError: Too many connections",
    "kafka-consumer-lag": "consumer group ledger-cg lag=",
    "postgres-migration-lock": "canceling statement due to lock timeout",
    "memory-leak-oom": "OOMKilled, exit code 137",
    "third-party-rate-limit": "429 Too Many Requests",
    "tls-cert-expiry": "x509: certificate has expired",
}
INC_REF = re.compile(r"INC-(\d{3})")


def load(name: str) -> Any:
    return json.loads((DATA_DIR / name).read_text(encoding="utf-8"))


def main() -> int:
    incidents: list[dict[str, Any]] = load("incidents.json")
    postmortems: list[dict[str, Any]] = load("postmortems.json")
    demo_alerts: list[dict[str, Any]] = load("demo_alerts.json")
    errors: list[str] = []

    if len(incidents) != 45:
        errors.append(f"expected 45 incidents, found {len(incidents)}")
    expected_ids = [f"INC-{i:03d}" for i in range(1, len(incidents) + 1)]
    ids = [inc["id"] for inc in incidents]
    if ids != expected_ids:
        errors.append("incident IDs are not INC-001.. in order")

    starts = [datetime.fromisoformat(inc["started_at"]) for inc in incidents]
    if starts != sorted(starts):
        errors.append("incidents are not in chronological order")
    if starts and (starts[0].date().isoformat() < "2026-03-01" or starts[-1].date().isoformat() > "2026-09-30"):
        errors.append("incidents fall outside March to September 2026")

    pm_by_id = {pm["incident_id"]: pm for pm in postmortems}
    if len(postmortems) != len(incidents) or set(pm_by_id) != set(ids):
        errors.append("every incident needs exactly one postmortem")

    families: Counter[str] = Counter()
    engineers: set[str] = set()
    for inc in incidents:
        iid = inc["id"]
        engineers.add(inc["on_call"])
        if inc["service"] not in SERVICES:
            errors.append(f"{iid}: unknown service {inc['service']}")
        if inc["severity"] not in SEVERITIES:
            errors.append(f"{iid}: unknown severity {inc['severity']}")
        started = datetime.fromisoformat(inc["started_at"])
        resolved = datetime.fromisoformat(inc["resolved_at"])
        if started.tzinfo is None or resolved.tzinfo is None:
            errors.append(f"{iid}: timestamps need a timezone")
        if resolved <= started:
            errors.append(f"{iid}: resolved_at is not after started_at")
        family = inc.get("family")
        if family:
            families[family] += 1
            if FAMILY_SIGNATURES[family] not in inc["alert_text"]:
                errors.append(f"{iid}: alert_text is missing the {family} signature")

        pm = pm_by_id.get(iid)
        if pm is None:
            continue
        actual_ttr = (resolved - started).total_seconds() / 60
        if abs(actual_ttr - pm["ttr_minutes"]) > 2:
            errors.append(f"{iid}: ttr_minutes {pm['ttr_minutes']} does not match timestamps ({actual_ttr:.0f})")
        if inc["severity"] == "SEV1" and not 25 <= pm["ttr_minutes"] <= 90:
            errors.append(f"{iid}: SEV1 resolved in {pm['ttr_minutes']} min, outside 25-90")
        times = [datetime.fromisoformat(step["time"]) for step in pm["timeline"]]
        if times != sorted(times) or times[0] != started or times[-1] != resolved:
            errors.append(f"{iid}: timeline must start at started_at, end at resolved_at and be ordered")
        if not pm["attempts"]:
            errors.append(f"{iid}: postmortem has no attempts")
        for attempt in pm["attempts"]:
            if attempt["outcome"] not in OUTCOMES:
                errors.append(f"{iid}: bad attempt outcome {attempt['outcome']}")
        text = json.dumps({key: value for key, value in pm.items() if key != "incident_id"})
        for ref in INC_REF.findall(text):
            if int(ref) >= int(iid[4:]):
                errors.append(f"{iid}: references INC-{ref}, which is not an earlier incident")

    for family, count in EXPECTED_FAMILIES.items():
        if families[family] != count:
            errors.append(f"family {family}: expected {count}, found {families[family]}")
    one_offs = sum(1 for inc in incidents if not inc.get("family"))
    if one_offs != 27:
        errors.append(f"expected 27 one-off incidents, found {one_offs}")
    if len(engineers) != 8:
        errors.append(f"expected 8 on-call engineers, found {len(engineers)}")

    redis = [inc for inc in incidents if inc.get("family") == "redis-pool-exhaustion"]
    late_redis = [inc for inc in redis if inc["started_at"][:10] in {"2026-08-12", "2026-09-03"}]
    if len(late_redis) != 2:
        errors.append("the last two Redis incidents must be dated 2026-08-12 and 2026-09-03")
    for inc in late_redis:
        attempts = pm_by_id[inc["id"]]["attempts"]
        if not any("restart" in a["action"].lower() and a["outcome"] == "failed" for a in attempts):
            errors.append(f"{inc['id']}: needs a failed pod restart attempt")
        if not any("REDIS_MAX_POOL from 20 to 50" in a["action"] and a["outcome"] == "worked" for a in attempts):
            errors.append(f"{inc['id']}: needs the worked REDIS_MAX_POOL 20 to 50 fix")

    if [d["id"] for d in demo_alerts] != ["DEMO-A", "DEMO-B", "DEMO-C"]:
        errors.append("demo_alerts.json must contain exactly DEMO-A, DEMO-B, DEMO-C")
    for demo in demo_alerts:
        at = [signal["at_ms"] for signal in demo.get("signals", [])]
        if len(at) < 3 or at != sorted(at):
            errors.append(f"{demo['id']}: needs at least 3 simulator signals in time order")
    demo_c = next((d for d in demo_alerts if d["id"] == "DEMO-C"), None)
    if demo_c and demo_c.get("follow_up_service") == demo_c.get("service"):
        errors.append("DEMO-C follow-up must be on a different service to show generalisation")
    history_text = {inc["alert_text"] for inc in incidents}
    for demo in demo_alerts:
        if demo["alert_text"] in history_text or demo["id"] in json.dumps(incidents):
            errors.append(f"{demo['id']} must not appear in incident history")

    print(f"{'Check':<34}{'Value':>10}")
    print("-" * 44)
    print(f"{'Incidents':<34}{len(incidents):>10}")
    print(f"{'Postmortems':<34}{len(postmortems):>10}")
    print(f"{'Date range':<34}{starts[0].date()} to {starts[-1].date()}")
    for family in EXPECTED_FAMILIES:
        members = ", ".join(inc["id"] for inc in incidents if inc.get("family") == family)
        print(f"{'  ' + family:<34}{families[family]:>10}   {members}")
    print(f"{'One-off incidents':<34}{one_offs:>10}")
    print(f"{'On-call engineers':<34}{len(engineers):>10}")
    print(f"{'Severity mix':<34}{dict(sorted(Counter(i['severity'] for i in incidents).items()))}")
    print(f"{'Services':<34}{dict(sorted(Counter(i['service'] for i in incidents).items()))}")
    print(f"{'Demo alerts':<34}{len(demo_alerts):>10}")
    print("-" * 44)
    if errors:
        print(f"FAILED with {len(errors)} problem(s):")
        for error in errors:
            print(f"  - {error}")
        return 1
    print("PASSED: all checks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
