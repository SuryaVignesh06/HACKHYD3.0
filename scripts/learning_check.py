"""Phase 4 proof: the agent learns from one resolved incident and applies it to a different service.

Runs against the live backend (start uvicorn first). Steps:
  a) reset the Hindsight bank and live SQLite rows (skip with --no-reset)
  b) DEMO-C on search-api: expect "no strong precedent" and no claims
  c) record a failed and a worked fix, draft the postmortem, resolve
  d) the postmortem retain is synchronous, so memory is ready when resolve returns
  e) DEMO-C's follow-up alert on checkout-web, worded differently
  f) print both diagnoses side by side and assert the second one learned
Exits 0 when every assertion passes.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.db import reset_live_data  # noqa: E402
from app.seeding import seed  # noqa: E402
from app.services.memory import MemoryService, MemoryUnavailable  # noqa: E402

FAILED_FIX = {
    "action": "Purged the CDN cache for the search endpoints",
    "outcome": "failed",
    "notes": "502s continued at the same rate; the error is in the TLS handshake to the origin, not in cached content.",
}
WORKED_FIX = {
    "action": "Reverted the CDN origin host header and SNI to search.nimbuspay.io, which the origin certificate covers",
    "outcome": "worked",
    "notes": "Edge 502s dropped to zero within 2 minutes of the CDN config propagating.",
}
POSTMORTEM = {
    "summary": ("search-api returned 502s at the CDN edge for 38% of requests after a CDN origin config change set the "
                "origin host header to search-origin.nimbuspay.io. Purging the CDN cache did not help."),
    "root_cause": ("The CDN sends the origin host header as the TLS SNI. search-origin.nimbuspay.io is not in the origin "
                   "certificate's SAN list, so every TLS handshake from the edge to the origin failed with an SNI mismatch "
                   "and the edge returned 502 Bad Gateway."),
    "fix": "Reverted the CDN origin host header and SNI to search.nimbuspay.io, which the origin certificate covers.",
    "follow_ups": [
        "Validate that every CDN origin host header is covered by the origin certificate SANs before a CDN config change ships.",
        "Alert on edge TLS handshake failures separately from origin 5xx.",
    ],
}


async def reset() -> None:
    memory = MemoryService(timeout=600.0)
    try:
        try:
            await memory.delete_bank()
        except MemoryUnavailable:
            print("bank did not exist; seeding fresh")
        await seed(memory)
    finally:
        await memory.close()
    print(f"removed {reset_live_data()} live incidents from SQLite")


def diagnose(client: httpx.Client, alert_text: str, service: str, label: str) -> tuple[str, dict[str, Any]]:
    created = client.post("/api/incidents", json={"alert_text": alert_text, "service": service}).json()
    incident_id = created["id"]
    print(f"\n{label}: created {incident_id} ({created['title']})")
    final: dict[str, Any] = {}
    with client.stream("POST", f"/api/incidents/{incident_id}/diagnose", params={"memory": True}) as response:
        for line in response.iter_lines():
            if not line.strip():
                continue
            event = json.loads(line)
            if event["type"] == "step":
                print(f"  {event['step']['name']:<9} {event['step']['duration_ms']:>6} ms  {event['step']['detail']}")
            elif event["type"] == "diagnosis":
                final = event["diagnosis"]
            else:
                raise SystemExit(f"investigation failed: {event}")
    return incident_id, final


def column(d: dict[str, Any]) -> list[str]:
    lines = [
        f"strong precedent: {d['strong_match']}",
        f"confidence: {d['confidence']}",
        f"cited: {', '.join(d['cited_incidents']) or 'none'}",
        f"try first: {(d['try_first'] or {}).get('action', 'none')}",
    ]
    if d["try_first"]:
        lines.append(f"  worked in: {', '.join(d['try_first']['evidence'])}")
    for item in d["avoid"] or []:
        lines.append(f"avoid: {item['action']}")
        lines.append(f"  failed in: {', '.join(item['evidence'])}")
    if not d["avoid"]:
        lines.append("avoid: none")
    lines.append(f"summary: {d['summary']}")
    return lines


def side_by_side(left: dict[str, Any], right: dict[str, Any], width: int = 60) -> None:
    import textwrap

    def wrap(lines: list[str]) -> list[str]:
        out: list[str] = []
        for line in lines:
            out += textwrap.wrap(line, width) or [""]
        return out

    a, b = wrap(column(left)), wrap(column(right))
    print("\n" + "BEFORE: DEMO-C, search-api".ljust(width + 3) + "AFTER: follow-up, checkout-web")
    print("-" * width + "   " + "-" * width)
    for i in range(max(len(a), len(b))):
        print((a[i] if i < len(a) else "").ljust(width + 3) + (b[i] if i < len(b) else ""))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default="http://localhost:8000")
    parser.add_argument("--no-reset", action="store_true")
    args = parser.parse_args()

    with httpx.Client(base_url=args.api, timeout=180.0) as client:
        try:
            client.get("/api/health").raise_for_status()
        except httpx.HTTPError:
            print(f"Backend not reachable at {args.api}. Start it with: cd backend && .venv/Scripts/python -m uvicorn app.main:app --port 8000")
            return 1
        if not args.no_reset:
            asyncio.run(reset())

        demo_c = next(d for d in client.get("/api/demo-alerts").json() if d["id"] == "DEMO-C")
        first_id, before = diagnose(client, demo_c["alert_text"], demo_c["service"], "BEFORE")

        print(f"\nrecording outcomes on {first_id}")
        for fix in (FAILED_FIX, WORKED_FIX):
            logged = client.post(f"/api/incidents/{first_id}/attempts", json=fix).json()
            print(f"  {logged['outcome']:<6} {logged['action']} (retained: {logged['memory_retained']})")
        draft = client.post(f"/api/incidents/{first_id}/postmortem-draft").json()
        print(f"  postmortem draft by {draft['drafted_by']}: {draft['root_cause'][:120]}")
        captured = client.post(f"/api/incidents/{first_id}/resolve", json=POSTMORTEM).json()
        print(f"  resolved; memory {captured['memory_count_before']} -> {captured['memory_count_after']} memories")

        second_id, after = diagnose(client, demo_c["follow_up_alert"], demo_c["follow_up_service"], "AFTER")

    side_by_side(before, after)

    checks = [
        ("before: no strong precedent", before["strong_match"] is False),
        ("before: no claims", not before["cited_incidents"] and not before["avoid"]),
        (f"after: strong precedent confirmed", after["strong_match"] is True),
        (f"after: cites the resolved incident {first_id}", first_id in after["cited_incidents"]),
        ("after: higher confidence", (after["confidence"] or 0) > (before["confidence"] or 0)),
        (f"after: verified Avoid for the cache purge from {first_id}",
         any(first_id in a["evidence"] and "cache" in a["action"].lower() for a in after["avoid"])),
    ]
    print()
    for name, ok in checks:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    passed = all(ok for _, ok in checks)
    print(f"\n{'LEARNING CHECK PASSED' if passed else 'LEARNING CHECK FAILED'} ({first_id} -> {second_id})")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
