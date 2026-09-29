"""Creates an incident from a demo alert on the running backend and prints the diagnosis stream live.

Usage: python scripts/stream_diagnosis.py DEMO-A [--memory off] [--follow-up] [--api http://localhost:8000]
"""

import argparse
import json
import sys
import time

import httpx


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("demo_id", choices=["DEMO-A", "DEMO-B", "DEMO-C", "DEMO-D", "DEMO-E", "DEMO-F"])
    parser.add_argument("--memory", choices=["on", "off"], default="on")
    parser.add_argument("--follow-up", action="store_true", help="use DEMO-C's follow-up alert")
    parser.add_argument("--incident", help="diagnose an existing incident instead of creating one")
    parser.add_argument("--api", default="http://localhost:8000")
    args = parser.parse_args()

    with httpx.Client(base_url=args.api, timeout=120.0) as client:
        incident_id = args.incident
        if incident_id is None:
            demo = next(d for d in client.get("/api/demo-alerts").json() if d["id"] == args.demo_id)
            payload = {"alert_text": demo["follow_up_alert"] if args.follow_up else demo["alert_text"],
                       "service": demo.get("follow_up_service") if args.follow_up else demo["service"]}
            created = client.post("/api/incidents", json=payload).json()
            incident_id = created["id"]
            print(f"created {incident_id}: {created['title']}")

        started = time.perf_counter()
        with client.stream("POST", f"/api/incidents/{incident_id}/diagnose", params={"memory": args.memory == "on"}) as response:
            for line in response.iter_lines():
                if not line.strip():
                    continue
                event = json.loads(line)
                elapsed = time.perf_counter() - started
                if event["type"] == "step":
                    step = event["step"]
                    print(f"[{elapsed:5.1f}s] {step['name']:<9} ({step['duration_ms']} ms) {step['detail']}")
                elif event["type"] == "diagnosis":
                    print(f"[{elapsed:5.1f}s] final diagnosis (alert retained to memory: {event.get('alert_retained', False)}):")
                    print(json.dumps({k: v for k, v in event["diagnosis"].items() if k not in ("recalled", "steps")}, indent=2))
                else:
                    print(f"[{elapsed:5.1f}s] ERROR {event}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
