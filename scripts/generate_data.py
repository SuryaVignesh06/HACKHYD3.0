"""Builds data/incidents.json, data/postmortems.json and data/demo_alerts.json for Nimbus Pay.

Every incident is hand-written below. The script only turns relative timeline offsets into
absolute ISO 8601 timestamps (IST, +05:30), assigns INC IDs in chronological order and
computes ttr_minutes, so the timelines always add up.
"""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

IST = timezone(timedelta(hours=5, minutes=30))
DATA_DIR = Path(__file__).resolve().parents[1] / "data"

# Spec fields: date, start (HH:MM IST), severity, service, title, on_call, family (or None),
# alert, summary, root_cause, timeline [(minute_offset, event)], attempts [(action, outcome, notes)],
# fix, follow_ups. The last timeline offset is the resolution time.
SPECS: list[dict[str, Any]] = [
    # ------------------------------------------------------------------ March
    {
        "date": "2026-03-02", "start": "14:12", "severity": "SEV3", "service": "notifications-svc",
        "title": "Intermittent DNS resolution failures from notifications-svc",
        "on_call": "Daniel Kowalski", "family": None,
        "alert": (
            "[FIRING] NotificationsSendErrorRate SEV3 notifications-svc\n"
            "error rate 4.1% (threshold 2%) for 10m\n"
            "log: Error: getaddrinfo EAI_AGAIN api.sendgrid.com\n"
            "    at GetAddrInfoReqWrap.onlookup [as oncomplete] (node:dns:107:26)"
        ),
        "summary": "About 4% of outbound email and SMS sends failed for 51 minutes because DNS lookups from notifications-svc pods intermittently timed out.",
        "root_cause": "CoreDNS was running only 2 replicas for a cluster that had grown to 38 nodes. Node.js does not cache DNS, and with the default ndots:5 every external lookup fanned out into 5 queries. CoreDNS hit its CPU limit and dropped UDP queries.",
        "timeline": [
            (0, "Alert fired for notifications-svc send error rate at 4.1%."),
            (6, "Daniel suspected a SendGrid outage; the SendGrid status page was green."),
            (14, "Found EAI_AGAIN errors spread across all notifications-svc pods, not one node."),
            (22, "CoreDNS pods at 100% of their 100m CPU limit, with throttling in the metrics."),
            (31, "Scaled CoreDNS from 2 to 6 replicas and raised its CPU limit to 500m."),
            (40, "Added dnsConfig ndots:2 to the notifications-svc deployment and rolled it out."),
            (51, "Error rate back under 0.1% for 10 minutes; resolved."),
        ],
        "attempts": [
            ("Checked the SendGrid status page and opened a support ticket", "failed", "SendGrid was healthy; this cost 8 minutes."),
            ("Scaled CoreDNS to 6 replicas and raised its CPU limit to 500m", "worked", "Dropped queries stopped within 2 minutes."),
            ("Set dnsConfig ndots:2 on notifications-svc", "worked", "Cut DNS query volume from the service by about 70%."),
        ],
        "fix": "Scaled CoreDNS to 6 replicas with a 500m CPU limit and set ndots:2 on notifications-svc.",
        "follow_ups": ["Install the cluster-proportional-autoscaler for CoreDNS.", "Add a CoreDNS dropped-queries alert."],
    },
    {
        "date": "2026-03-09", "start": "11:03", "severity": "SEV2", "service": "checkout-web",
        "title": "New checkout flow flag rolled out to 100% instead of 10%",
        "on_call": "Sofia Lindqvist", "family": None,
        "alert": (
            "[FIRING] CheckoutConversionDrop SEV2 checkout-web\n"
            "checkout completion rate 41% (7d baseline 78%) for 15m\n"
            "sentry: TypeError: Cannot read properties of undefined (reading 'billingAddress')\n"
            "    at PaymentStep (checkout-v2/PaymentStep.tsx:212)"
        ),
        "summary": "Checkout completion dropped from 78% to 41% for 34 minutes after the checkout-v2 feature flag was set to 100% of traffic instead of the planned 10%.",
        "root_cause": "The flag change in the flag dashboard was entered as 100 in the percentage field during a rushed release. checkout-v2 crashed for saved cards without a billing address, a case that only 10% of traffic would have exposed slowly.",
        "timeline": [
            (0, "Conversion-drop alert fired for checkout-web."),
            (5, "Sofia saw a spike of TypeError in Sentry, all from checkout-v2 components."),
            (9, "Tried rolling back the 10:40 checkout-web deploy; errors continued because the flag was still on."),
            (19, "Rahul pointed out the checkout-v2 flag audit log showed 100% at 10:52."),
            (21, "Flag set back to 0%."),
            (34, "Conversion rate back at baseline; resolved."),
        ],
        "attempts": [
            ("Rolled back the checkout-web deploy from 10:40", "failed", "The code path was controlled by the flag, not the deploy."),
            ("Set the checkout-v2 flag to 0%", "worked", "Errors stopped within a minute."),
        ],
        "fix": "Turned off the checkout-v2 flag, then shipped a null check for billingAddress before re-enabling at 10%.",
        "follow_ups": ["Require a second approver for flag changes above 25%.", "Add a staged rollout preset to the flag dashboard."],
    },
    {
        "date": "2026-03-19", "start": "21:47", "severity": "SEV1", "service": "payments-api",
        "title": "payments-api latency spike from Redis connection pool exhaustion",
        "on_call": "Marcus Oyelaran", "family": "redis-pool-exhaustion",
        "alert": (
            "[FIRING] PaymentsApiHighLatency SEV1 payments-api\n"
            "p99 latency 3.6s (threshold 1.5s) for 5m on POST /v1/charges\n"
            "log: redis.exceptions.ConnectionError: Too many connections\n"
            "  File \"/app/payments/idempotency.py\", line 88, in get_idempotency_key"
        ),
        "summary": "payments-api p99 latency rose to 3.6 s and 2.3% of charge requests failed for 58 minutes. The Redis client connection pool was exhausted after a deploy doubled worker concurrency.",
        "root_cause": "The 21:20 release raised PAYMENTS_WORKER_CONCURRENCY from 8 to 16 gunicorn threads per pod, but REDIS_MAX_POOL stayed at 20. Each request holds a Redis connection for the idempotency check and the rate-limit check, so under evening peak the pool ran out and redis-py raised ConnectionError: Too many connections.",
        "timeline": [
            (0, "Latency alert fired for payments-api, p99 at 3.6 s."),
            (4, "Marcus saw redis.exceptions.ConnectionError: Too many connections in the logs."),
            (9, "Checked the Redis server: 31% CPU, 900 of 10000 maxclients in use. Redis itself was healthy."),
            (15, "Restarted all payments-api pods with a rolling restart."),
            (27, "Latency dropped briefly, then climbed back to 3.4 s within 8 minutes of the restart."),
            (36, "Noticed the 21:20 deploy changed PAYMENTS_WORKER_CONCURRENCY from 8 to 16."),
            (41, "Rolled back the worker concurrency change to 8."),
            (58, "p99 back at 380 ms for 15 minutes; resolved."),
        ],
        "attempts": [
            ("Rolling restart of payments-api pods", "failed", "Fresh pools filled up again within 8 minutes because the concurrency was still 16."),
            ("Rolled back PAYMENTS_WORKER_CONCURRENCY from 16 to 8", "worked", "Pool usage fell to about 60% and latency recovered."),
        ],
        "fix": "Rolled back PAYMENTS_WORKER_CONCURRENCY to 8 so the 20-connection Redis pool was enough again.",
        "follow_ups": [
            "Size REDIS_MAX_POOL from worker concurrency (at least 3 connections per thread) instead of a fixed 20.",
            "Add a Redis client pool utilisation metric and alert at 80%.",
        ],
    },
    {
        "date": "2026-03-25", "start": "15:30", "severity": "SEV2", "service": "payments-api",
        "title": "Charges table locked by a long-running migration",
        "on_call": "Aiko Tanaka", "family": "postgres-migration-lock",
        "alert": (
            "[FIRING] PaymentsApi5xxRate SEV2 payments-api\n"
            "5xx rate 18% (threshold 1%) for 5m\n"
            "log: psycopg.errors.LockNotAvailable: canceling statement due to lock timeout\n"
            "CONTEXT: while updating tuple in relation \"charges\""
        ),
        "summary": "18% of payments-api requests returned 500 for 44 minutes because a schema migration held an ACCESS EXCLUSIVE lock on the charges table during business hours.",
        "root_cause": "Migration 0142 added a column with a volatile default to the 41M-row charges table, which rewrites the table under an ACCESS EXCLUSIVE lock. The migration ran as part of the 15:25 deploy, in peak hours, with no lock_timeout, so every query on charges queued behind it and hit the application's 3 s lock timeout.",
        "timeline": [
            (0, "5xx alert fired for payments-api at 18%."),
            (5, "Aiko found LockNotAvailable errors on the charges table."),
            (9, "pg_stat_activity showed migration 0142 running ALTER TABLE charges for 6 minutes."),
            (12, "Ran pg_terminate_backend on the migration session."),
            (15, "Errors kept going: the table rewrite had to roll back, and the migration Job restarted automatically (backoffLimit 3) and took the lock again."),
            (24, "Deleted the migration Job and terminated the session again; the rollback finished at minute 29."),
            (31, "5xx rate dropped to 0.4%."),
            (44, "Error rate at baseline; resolved. Migration rescheduled."),
        ],
        "attempts": [
            ("Killed the blocking migration query with pg_terminate_backend", "failed", "The rollback kept the lock, and the Kubernetes Job retried the migration, so the outage got longer."),
            ("Deleted the migration Job, then terminated the session", "worked", "The lock was released once the rollback completed."),
        ],
        "fix": "Removed the migration Job, let the rollback finish, and re-ran 0142 at 02:00 as an add-column-without-default plus a batched backfill.",
        "follow_ups": [
            "Run migrations with SET lock_timeout = '2s' and retries.",
            "Move schema migrations out of the deploy pipeline into an off-peak window.",
            "Set backoffLimit 0 on migration Jobs.",
        ],
    },
    {
        "date": "2026-03-29", "start": "03:10", "severity": "SEV3", "service": "ledger-worker",
        "title": "Nightly reconciliation ran twice on the DST change",
        "on_call": "Grace Mensah", "family": None,
        "alert": (
            "[FIRING] LedgerReconciliationDuplicateEntries SEV3 ledger-worker\n"
            "duplicate settlement batches detected: 2 batches for settlement_date=2026-03-28\n"
            "log: WARN reconcile: batch 2026-03-28 already exists, inserting anyway (force=true)"
        ),
        "summary": "The nightly reconciliation job ran twice for 28 March, creating duplicate settlement batches that were caught before the payout file was sent.",
        "root_cause": "The reconciliation CronJob was scheduled at 01:30 Europe/Berlin through a TZ setting in the container. The European DST change on 29 March shifted the clock, and the scheduler's catch-up logic fired the job twice. The job ran with force=true from an old manual rerun script, so the duplicate-batch guard was skipped.",
        "timeline": [
            (0, "Duplicate batch alert fired."),
            (12, "Grace confirmed two batches for 2026-03-28 with identical totals."),
            (20, "Paused the payout export CronJob so the duplicates would not reach the bank."),
            (38, "Deleted the second batch after finance confirmed the first one matched the bank statement."),
            (55, "Re-ran the payout export; resolved."),
        ],
        "attempts": [
            ("Paused the payout export CronJob", "worked", "Stopped duplicate payouts from going out."),
            ("Deleted the duplicate batch after finance sign-off", "worked", "Ledger matched the bank statement again."),
        ],
        "fix": "Removed the duplicate batch, moved the CronJob schedule to UTC and removed force=true from the job args.",
        "follow_ups": ["Make the reconciliation job idempotent per settlement_date.", "Ban TZ-based CronJob schedules in the Helm chart linter."],
    },
    # ------------------------------------------------------------------ April
    {
        "date": "2026-04-03", "start": "09:42", "severity": "SEV3", "service": "ledger-worker",
        "title": "ledger-worker node disk full from debug log volume",
        "on_call": "Tomás Herrera", "family": None,
        "alert": (
            "[FIRING] KubeNodeDiskPressure SEV3 node ip-10-4-17-88.ap-south-1.compute.internal\n"
            "ledger-worker pods evicted: 3\n"
            "log: OSError: [Errno 28] No space left on device: '/tmp/ledger-export-2026-04-03.csv'"
        ),
        "summary": "Three ledger-worker pods were evicted and ledger exports stalled for 37 minutes because one node's disk filled up.",
        "root_cause": "A ledger-worker pod had been left at LOG_LEVEL=DEBUG after an investigation two days earlier. It wrote about 60 GB of container logs to the node's 80 GB root volume, and the kubelet evicted every pod on the node when it hit DiskPressure.",
        "timeline": [
            (0, "DiskPressure alert fired and 3 ledger-worker pods were evicted."),
            (8, "Tomás found a single pod with 58 GB of container logs."),
            (14, "Cordoned and drained the node; pods rescheduled onto healthy nodes."),
            (22, "Reset LOG_LEVEL to INFO on the ledger-worker deployment."),
            (37, "Exports caught up; resolved."),
        ],
        "attempts": [
            ("Deleted old files in /tmp inside the pod", "failed", "The space was used by container logs on the node, not /tmp."),
            ("Drained the node and reset LOG_LEVEL to INFO", "worked", "Pods rescheduled and exports resumed."),
        ],
        "fix": "Drained the node and set LOG_LEVEL back to INFO.",
        "follow_ups": ["Set containerLogMaxSize to 100Mi on all node groups.", "Alert when any deployment runs at DEBUG for more than 6 hours."],
    },
    {
        "date": "2026-04-08", "start": "16:05", "severity": "SEV2", "service": "ledger-worker",
        "title": "Kafka consumer lag on ledger-cg after batch-size change",
        "on_call": "Rahul Deshpande", "family": "kafka-consumer-lag",
        "alert": (
            "[FIRING] KafkaConsumerGroupLag SEV2 ledger-worker\n"
            "consumer group ledger-cg lag=97410 (threshold 20000) on topic payments.settled\n"
            "log: CommitFailedException: Commit cannot be completed since the group has already rebalanced"
        ),
        "summary": "ledger-worker fell 97,410 messages behind on payments.settled for 71 minutes after a deploy raised the consumer batch size. Ledger balances in the dashboard were stale for merchants.",
        "root_cause": "The 15:40 deploy raised max.poll.records from 500 to 5000 to speed up processing. Processing 5000 records took longer than max.poll.interval.ms (300 s) under peak load, so consumers were kicked out of the group, their commits failed, and the group rebalanced over and over, reprocessing the same batches.",
        "timeline": [
            (0, "Consumer lag alert fired at 97,410 on ledger-cg."),
            (7, "Rahul assumed not enough consumers and scaled ledger-worker from 6 to 12 replicas."),
            (19, "Lag kept rising. Logs full of CommitFailedException and constant rebalances."),
            (26, "Scaled to 18 replicas; the topic only has 12 partitions, so 6 consumers sat idle and rebalances got worse."),
            (41, "Aiko spotted max.poll.records=5000 in the 15:40 deploy diff."),
            (44, "Rolled back the batch-size config to 500 and scaled back to 6 replicas."),
            (71, "Lag back under 1,000; resolved."),
        ],
        "attempts": [
            ("Scaled ledger-worker consumers from 6 to 12, then 18 replicas", "failed", "More consumers caused more rebalances, and the 12-partition topic cannot use more than 12 consumers."),
            ("Rolled back max.poll.records from 5000 to 500", "worked", "Rebalances stopped and lag drained in about 25 minutes."),
        ],
        "fix": "Rolled back max.poll.records to 500 and scaled ledger-worker back to 6 replicas.",
        "follow_ups": ["Add a rebalance-rate alert on ledger-cg.", "Load-test consumer config changes against max.poll.interval.ms before release."],
    },
    {
        "date": "2026-04-15", "start": "05:32", "severity": "SEV1", "service": "auth-service",
        "title": "auth-service TLS certificate expired",
        "on_call": "Priya Nair", "family": "tls-cert-expiry",
        "alert": (
            "[FIRING] AuthServiceProbeFailed SEV1 auth-service\n"
            "blackbox probe https://auth.nimbuspay.io/healthz failing from 3 regions\n"
            "client error: x509: certificate has expired or is not yet valid: current time 2026-04-15T00:02:11Z is after 2026-04-15T00:00:00Z"
        ),
        "summary": "Logins and token refreshes failed for all customers for 47 minutes because the TLS certificate on auth.nimbuspay.io expired.",
        "root_cause": "The auth-service certificate was a 90-day Let's Encrypt certificate renewed by hand with certbot on a bastion host. The engineer who used to renew it had moved teams, and the calendar reminder went to their old team alias.",
        "timeline": [
            (0, "Blackbox probe alert fired from all regions."),
            (6, "Priya reproduced x509: certificate has expired with curl."),
            (15, "Found the renewal runbook; the certbot bastion's AWS credentials had been rotated."),
            (29, "Issued a new certificate with certbot using DNS validation from a laptop."),
            (38, "Updated the Kubernetes TLS secret and restarted the ingress controller."),
            (47, "Logins recovered; resolved."),
        ],
        "attempts": [
            ("Manually renewed the certificate with certbot and updated the TLS secret", "worked", "Fixed the outage for now, but the next expiry is again 90 days away with no automation."),
        ],
        "fix": "Manually renewed the Let's Encrypt certificate and replaced the auth-service TLS secret.",
        "follow_ups": ["Move auth-service certificates to cert-manager with automatic renewal.", "Alert 14 days before any certificate expires."],
    },
    {
        "date": "2026-04-22", "start": "13:18", "severity": "SEV2", "service": "notifications-svc",
        "title": "notifications-svc pods OOMKilled in a loop",
        "on_call": "Daniel Kowalski", "family": "memory-leak-oom",
        "alert": (
            "[FIRING] KubePodCrashLooping SEV2 notifications-svc\n"
            "container notifications restarted 14 times in 1h\n"
            "last state: Terminated, Reason: OOMKilled, exit code 137"
        ),
        "summary": "notifications-svc pods were OOMKilled every 20 to 30 minutes, delaying emails and SMS by up to 12 minutes, for 64 minutes before memory limits were raised.",
        "root_cause": "Memory grew steadily from start-up until the 512Mi limit. The team believed the cause was the new marketing template set being larger than before, and raised the limit. The leak itself was not identified during this incident.",
        "timeline": [
            (0, "CrashLoop alert fired with OOMKilled, exit code 137."),
            (10, "Daniel saw memory climbing linearly to 512Mi in Grafana."),
            (22, "Linked the timing to the new marketing template set launched that morning."),
            (35, "Raised the memory limit from 512Mi to 1Gi."),
            (64, "No restarts for 25 minutes; resolved."),
        ],
        "attempts": [
            ("Raised the notifications-svc memory limit from 512Mi to 1Gi", "partial", "Restarts stopped for now, but memory was still growing slowly."),
        ],
        "fix": "Raised the memory limit to 1Gi.",
        "follow_ups": ["Take a heap snapshot from a long-running pod to confirm the template theory."],
    },
    {
        "date": "2026-04-28", "start": "10:25", "severity": "SEV2", "service": "auth-service",
        "title": "JWT signature failures after signing key rotation",
        "on_call": "Sofia Lindqvist", "family": None,
        "alert": (
            "[FIRING] Auth401Spike SEV2 auth-service\n"
            "401 rate 22% on downstream services\n"
            "log: jwt.exceptions.InvalidSignatureError: Signature verification failed (kid=2026-04)"
        ),
        "summary": "22% of API calls across services returned 401 for 29 minutes after auth-service began signing tokens with a new key that downstream services had not fetched yet.",
        "root_cause": "The key rotation published the new key to the JWKS endpoint and started signing with it at the same moment. Downstream services cache the JWKS for 1 hour, so they rejected tokens signed with the new kid.",
        "timeline": [
            (0, "401 spike alert fired."),
            (7, "Sofia saw InvalidSignatureError with kid=2026-04 on payments-api and checkout-web."),
            (13, "Switched auth-service back to signing with kid=2026-03, which was still in every cache."),
            (29, "401 rate at baseline; resolved."),
        ],
        "attempts": [
            ("Reverted auth-service to sign with the previous key kid=2026-03", "worked", "New tokens were accepted everywhere."),
        ],
        "fix": "Reverted signing to the old key, then published the new key 24 hours before switching.",
        "follow_ups": ["Document a two-step key rotation: publish, wait longer than the JWKS cache TTL, then sign."],
    },
    # ------------------------------------------------------------------ May
    {
        "date": "2026-05-06", "start": "18:02", "severity": "SEV2", "service": "notifications-svc",
        "title": "SendGrid rate limiting during payout notification burst",
        "on_call": "Tomás Herrera", "family": "third-party-rate-limit",
        "alert": (
            "[FIRING] NotificationsSendFailures SEV2 notifications-svc\n"
            "failed email sends 31% for 10m\n"
            "log: HTTPError: 429 Too Many Requests from api.sendgrid.com (X-RateLimit-Remaining: 0)"
        ),
        "summary": "31% of emails failed for 49 minutes when the monthly payout notification burst hit SendGrid's rate limit.",
        "root_cause": "The payout run enqueued 180,000 merchant emails at once. notifications-svc sends immediately with a fixed retry of 3 attempts, 1 s apart, so each 429 produced 3 more requests and kept the account over its limit.",
        "timeline": [
            (0, "Send failure alert fired at 31%."),
            (6, "Tomás found 429 Too Many Requests from api.sendgrid.com."),
            (12, "Raised retries from 3 to 10 to push the emails through."),
            (20, "Failures went up to 44%; retries were multiplying traffic."),
            (27, "Set retries back to 3 and paused the payout email queue consumer."),
            (35, "Resumed the queue at 50 messages per second."),
            (49, "Backlog drained; resolved."),
        ],
        "attempts": [
            ("Increased send retries from 3 to 10", "failed", "Retrying harder multiplied the traffic and made the rate limiting worse."),
            ("Paused the queue, then resumed at 50 messages per second", "worked", "Stayed under the SendGrid limit and drained the backlog."),
        ],
        "fix": "Throttled the payout email queue to 50 messages per second.",
        "follow_ups": ["Add exponential backoff with jitter that honours Retry-After.", "Queue bulk sends instead of sending inline."],
    },
    {
        "date": "2026-05-12", "start": "12:40", "severity": "SEV2", "service": "payments-api",
        "title": "PgBouncer client connection limit reached",
        "on_call": "Aiko Tanaka", "family": None,
        "alert": (
            "[FIRING] PaymentsApi5xxRate SEV2 payments-api\n"
            "5xx rate 9% for 5m\n"
            "log: psycopg.OperationalError: FATAL: no more connections allowed (max_client_conn)"
        ),
        "summary": "9% of payments-api requests failed for 33 minutes because PgBouncer reached max_client_conn after the new analytics exporter was deployed.",
        "root_cause": "The new analytics-exporter service connected through the same PgBouncer with a pool of 200 connections, pushing total client connections past max_client_conn=500.",
        "timeline": [
            (0, "5xx alert fired on payments-api."),
            (8, "Aiko found FATAL: no more connections allowed (max_client_conn) from PgBouncer."),
            (15, "SHOW CLIENTS showed 200 connections from analytics-exporter."),
            (19, "Scaled analytics-exporter to 0."),
            (33, "Errors gone; resolved."),
        ],
        "attempts": [
            ("Scaled analytics-exporter to 0", "worked", "Freed 200 client connections immediately."),
        ],
        "fix": "Stopped analytics-exporter and moved it to the read replica with its own PgBouncer.",
        "follow_ups": ["Give each service its own PgBouncer user with a connection cap."],
    },
    {
        "date": "2026-05-19", "start": "17:15", "severity": "SEV3", "service": "search-api",
        "title": "OpenSearch circuit breaker trips on merchant analytics query",
        "on_call": "Grace Mensah", "family": None,
        "alert": (
            "[FIRING] SearchApiErrorRate SEV3 search-api\n"
            "error rate 12% on /v1/transactions/search\n"
            "log: circuit_breaking_exception: [parent] Data too large, data for [<http_request>] would be [4.1gb], which is larger than the limit of [3.9gb]"
        ),
        "summary": "Transaction search failed for 12% of requests for 42 minutes because a new merchant analytics query used a huge terms aggregation.",
        "root_cause": "A dashboard feature shipped a terms aggregation on customer_email with size 100000 across 18 months of data, which tripped the OpenSearch parent circuit breaker.",
        "timeline": [
            (0, "Error rate alert fired."),
            (9, "Grace found circuit_breaking_exception in the OpenSearch logs."),
            (18, "Traced the heavy query to the analytics dashboard endpoint."),
            (24, "Disabled the dashboard widget with its feature flag."),
            (42, "Heap usage normal; resolved."),
        ],
        "attempts": [
            ("Restarted the OpenSearch data nodes one at a time", "failed", "The query came back as soon as dashboards reloaded."),
            ("Disabled the analytics widget flag", "worked", "Heap pressure dropped right away."),
        ],
        "fix": "Disabled the widget, then rewrote the query as a composite aggregation with paging.",
        "follow_ups": ["Cap aggregation size at the search-api layer."],
    },
    {
        "date": "2026-05-27", "start": "20:11", "severity": "SEV1", "service": "payments-api",
        "title": "payments-api latency spike, Redis Too many connections again",
        "on_call": "Tomás Herrera", "family": "redis-pool-exhaustion",
        "alert": (
            "[FIRING] PaymentsApiHighLatency SEV1 payments-api\n"
            "p99 latency 4.0s (threshold 1.5s) for 5m on POST /v1/charges\n"
            "log: redis.exceptions.ConnectionError: Too many connections\n"
            "  File \"/app/payments/ratelimit.py\", line 41, in check_merchant_quota"
        ),
        "summary": "payments-api p99 latency hit 4.0 s with 3.1% of charges failing for 67 minutes. Same failure as INC-003: Redis client pool exhaustion after worker concurrency was raised.",
        "root_cause": "A performance tuning PR raised PAYMENTS_WORKER_CONCURRENCY from 8 to 12. The INC-003 follow-up to size REDIS_MAX_POOL from concurrency was never done, so the pool was still a fixed 20 connections and ran out at evening peak.",
        "timeline": [
            (0, "Latency alert fired, p99 at 4.0 s."),
            (5, "Tomás saw redis.exceptions.ConnectionError: Too many connections."),
            (11, "Suspected the Redis server and failed over to the replica."),
            (20, "No change; the replica was healthy and so was the primary."),
            (24, "Restarted payments-api pods."),
            (35, "Latency came back within 10 minutes of the restart."),
            (46, "Found INC-003 in the postmortem archive. Same error, same cause."),
            (49, "Rolled back PAYMENTS_WORKER_CONCURRENCY from 12 to 8."),
            (67, "p99 back at 400 ms; resolved."),
        ],
        "attempts": [
            ("Failed Redis over to the replica", "failed", "Redis was never the bottleneck; the client-side pool was."),
            ("Rolling restart of payments-api pods", "failed", "Same as INC-003: pools filled up again within 10 minutes."),
            ("Rolled back PAYMENTS_WORKER_CONCURRENCY from 12 to 8", "worked", "Latency recovered in about 15 minutes."),
        ],
        "fix": "Rolled back worker concurrency to 8.",
        "follow_ups": [
            "Actually do the INC-003 follow-up: derive REDIS_MAX_POOL from worker concurrency.",
            "Link the Redis section of the payments runbook to INC-003 and this incident.",
        ],
    },
    # ------------------------------------------------------------------ June
    {
        "date": "2026-06-03", "start": "11:50", "severity": "SEV2", "service": "auth-service",
        "title": "sessions table locked by index migration on auth-service",
        "on_call": "Rahul Deshpande", "family": "postgres-migration-lock",
        "alert": (
            "[FIRING] AuthServiceLoginErrors SEV2 auth-service\n"
            "login error rate 27% for 5m\n"
            "log: sqlalchemy.exc.OperationalError: (psycopg.errors.LockNotAvailable) canceling statement due to lock timeout\n"
            "[SQL: UPDATE sessions SET last_seen_at=... ]"
        ),
        "summary": "27% of logins failed for 52 minutes because an index migration on the auth-service sessions table held a lock at midday.",
        "root_cause": "Migration 0077 used CREATE INDEX without CONCURRENTLY on the 23M-row sessions table, which blocks writes. It ran in the deploy pipeline at 11:45. The INC-004 follow-ups (lock_timeout on migrations, off-peak window) had only been applied to payments-api.",
        "timeline": [
            (0, "Login error alert fired."),
            (6, "Rahul saw LockNotAvailable on sessions."),
            (11, "Killed the migration session with pg_terminate_backend."),
            (14, "The migration Job restarted and blocked again, exactly as in INC-004."),
            (22, "Deleted the Job, then terminated the session."),
            (30, "Errors dropping."),
            (52, "Login error rate normal; resolved."),
        ],
        "attempts": [
            ("Killed the blocking query with pg_terminate_backend", "failed", "The Job retried the migration and took the lock again, as in INC-004."),
            ("Deleted the migration Job, then terminated the session", "worked", "Lock released."),
        ],
        "fix": "Removed the Job and re-ran the index as CREATE INDEX CONCURRENTLY at 02:00 with lock_timeout 2s.",
        "follow_ups": ["Apply the migration runner with lock_timeout and backoffLimit 0 to every service, not only payments-api."],
    },
    {
        "date": "2026-06-09", "start": "14:36", "severity": "SEV2", "service": "checkout-web",
        "title": "Content Security Policy blocked Stripe.js",
        "on_call": "Priya Nair", "family": None,
        "alert": (
            "[FIRING] CheckoutPaymentStepErrors SEV2 checkout-web\n"
            "payment step failures 100% on card payments\n"
            "browser console: Refused to load the script 'https://js.stripe.com/v3' because it violates the following Content Security Policy directive: \"script-src 'self'\""
        ),
        "summary": "Card payments on checkout-web failed for everyone for 26 minutes after a security header change blocked Stripe.js.",
        "root_cause": "A hardening PR tightened the Content-Security-Policy script-src to 'self' and missed the js.stripe.com allowance.",
        "timeline": [
            (0, "Payment step failure alert fired."),
            (5, "Priya reproduced the CSP violation in the browser console."),
            (9, "Rolled back the checkout-web deploy that changed the headers."),
            (26, "Card payments back to normal; resolved."),
        ],
        "attempts": [
            ("Rolled back the checkout-web header change", "worked", "Stripe.js loaded again."),
        ],
        "fix": "Rolled back, then re-shipped the CSP with js.stripe.com and hooks.stripe.com allowed.",
        "follow_ups": ["Ship CSP changes in Report-Only mode for a day first."],
    },
    {
        "date": "2026-06-13", "start": "02:15", "severity": "SEV3", "service": "ledger-worker",
        "title": "Ledger exports to S3 failing with ExpiredToken",
        "on_call": "Daniel Kowalski", "family": None,
        "alert": (
            "[FIRING] LedgerExportFailed SEV3 ledger-worker\n"
            "daily export job failed 3 times\n"
            "log: botocore.exceptions.ClientError: An error occurred (ExpiredToken) when calling the PutObject operation: The security token included in the request is expired"
        ),
        "summary": "The nightly ledger export to S3 failed for 81 minutes because the job used a static access key tied to an expired assumed-role session.",
        "root_cause": "The export job still used credentials copied from a temporary assumed-role session into a Kubernetes secret during a migration months ago, instead of IRSA.",
        "timeline": [
            (0, "Export failure alert fired."),
            (14, "Daniel found ExpiredToken on PutObject."),
            (40, "Annotated the ledger-worker service account with the IRSA role and removed the static secret."),
            (62, "Re-ran the export job."),
            (81, "Export complete; resolved."),
        ],
        "attempts": [
            ("Switched the job to IRSA and removed the static credentials", "worked", "Export succeeded on rerun."),
        ],
        "fix": "Moved the export job to IRSA credentials.",
        "follow_ups": ["Scan all Kubernetes secrets for AWS access keys."],
    },
    {
        "date": "2026-06-17", "start": "15:22", "severity": "SEV2", "service": "ledger-worker",
        "title": "ledger-cg consumer lag after deploy, rebalance storm",
        "on_call": "Grace Mensah", "family": "kafka-consumer-lag",
        "alert": (
            "[FIRING] KafkaConsumerGroupLag SEV2 ledger-worker\n"
            "consumer group ledger-cg lag=142885 (threshold 20000) on topic payments.settled\n"
            "log: WARN consumer poll timeout has expired. This means the time between subsequent calls to poll() was longer than the configured max.poll.interval.ms"
        ),
        "summary": "ledger-cg lag reached 142,885 for 78 minutes after a ledger-worker deploy. Merchant balances were up to 40 minutes stale.",
        "root_cause": "The 15:05 deploy bundled a config refactor that set LEDGER_BATCH_SIZE (max.poll.records) to 4000. Like INC-007, batches took longer than max.poll.interval.ms and the group kept rebalancing. The refactor had silently replaced the value that was restored after INC-007.",
        "timeline": [
            (0, "Consumer lag alert fired at 142,885."),
            (8, "Grace scaled ledger-worker from 6 to 12 replicas."),
            (21, "Lag still climbing; rebalances every 2 to 3 minutes."),
            (33, "Searched Slack and found INC-007; batch size had been changed in the refactor."),
            (38, "Rolled back LEDGER_BATCH_SIZE to 500 and scaled back to 6."),
            (78, "Lag cleared; resolved."),
        ],
        "attempts": [
            ("Scaled ledger-worker consumers from 6 to 12", "failed", "Same as INC-007: more consumers only caused more rebalances."),
            ("Rolled back LEDGER_BATCH_SIZE to 500", "worked", "Rebalances stopped and lag drained."),
        ],
        "fix": "Rolled back the batch-size config to 500.",
        "follow_ups": ["Add a config test that fails the build if LEDGER_BATCH_SIZE is above 1000.", "Add a rebalance-rate alert (still open from INC-007)."],
    },
    {
        "date": "2026-06-24", "start": "10:08", "severity": "SEV2", "service": "notifications-svc",
        "title": "notifications-svc OOMKilled again at 1Gi",
        "on_call": "Sofia Lindqvist", "family": "memory-leak-oom",
        "alert": (
            "[FIRING] KubePodCrashLooping SEV2 notifications-svc\n"
            "container notifications restarted 9 times in 1h\n"
            "last state: Terminated, Reason: OOMKilled, exit code 137"
        ),
        "summary": "notifications-svc pods were OOMKilled at the 1Gi limit for 86 minutes, delaying notifications by up to 15 minutes. The INC-009 limit increase had only delayed the crash.",
        "root_cause": "template-cache 2.4.0, pulled in by a caret range, kept every compiled template variant (per locale and merchant) in an unbounded Map. Memory grew with the number of merchants, not with traffic.",
        "timeline": [
            (0, "CrashLoop alert fired, OOMKilled exit code 137."),
            (7, "Sofia found INC-009, where the limit was raised to 1Gi."),
            (12, "Raised the limit again to 2Gi as a stopgap."),
            (30, "Heap snapshot from a 40-minute-old pod: 610 MB of compiled templates in template-cache."),
            (48, "template-cache changelog: 2.4.0 replaced the LRU with a Map for speed."),
            (60, "Pinned template-cache to ^2.3.4 in package.json and deployed."),
            (86, "Memory flat at 180 MB; resolved."),
        ],
        "attempts": [
            ("Raised the memory limit from 1Gi to 2Gi", "failed", "Memory kept climbing; it would only delay the next crash."),
            ("Pinned template-cache to ^2.3.4", "worked", "Memory stayed flat after the deploy."),
        ],
        "fix": "Pinned template-cache to ^2.3.4 and set the memory limit back to 512Mi.",
        "follow_ups": ["Alert on memory growth slope, not only on OOMKilled."],
    },
    {
        "date": "2026-06-30", "start": "19:44", "severity": "SEV2", "service": "auth-service",
        "title": "Users logged out as Redis session store evicted keys",
        "on_call": "Tomás Herrera", "family": None,
        "alert": (
            "[FIRING] AuthSessionLossSpike SEV2 auth-service\n"
            "forced re-logins 18x baseline\n"
            "log: redis.exceptions.ResponseError: OOM command not allowed when used memory > 'maxmemory'"
        ),
        "summary": "Many customers were logged out and some logins failed for 38 minutes because the auth-service Redis session store hit maxmemory.",
        "root_cause": "The session TTL had been raised from 1 day to 30 days in a product change without resizing the 2 GB Redis node. With maxmemory-policy allkeys-lru, Redis evicted live sessions, then refused writes during peak.",
        "timeline": [
            (0, "Session loss alert fired."),
            (6, "Tomás saw OOM command not allowed on the session Redis."),
            (14, "Scaled the ElastiCache node from 2 GB to 8 GB."),
            (38, "Memory at 31%, logins normal; resolved."),
        ],
        "attempts": [
            ("Resized the session Redis node from 2 GB to 8 GB", "worked", "Writes succeeded again."),
        ],
        "fix": "Resized the session Redis and reduced the session TTL to 14 days.",
        "follow_ups": ["Alert on Redis used_memory above 80% of maxmemory."],
    },
    # ------------------------------------------------------------------ July
    {
        "date": "2026-07-03", "start": "11:12", "severity": "SEV3", "service": "notifications-svc",
        "title": "Twilio delivery webhooks returning 404 after domain move",
        "on_call": "Aiko Tanaka", "family": None,
        "alert": (
            "[FIRING] TwilioWebhookErrors SEV3 notifications-svc\n"
            "Twilio debugger: 11200 HTTP retrieval failure, 404 on https://hooks.nimbuspay.com/twilio/status"
        ),
        "summary": "SMS delivery statuses stopped updating for 58 minutes because Twilio was still calling the old webhook domain.",
        "root_cause": "The webhook domain moved from nimbuspay.com to nimbuspay.io; the Twilio messaging service still pointed at the old URL, and the redirect did not cover POST.",
        "timeline": [
            (0, "Twilio error alert fired."),
            (12, "Aiko found 404s on the old hooks domain."),
            (30, "Updated the status callback URL in the Twilio console."),
            (58, "Backfilled statuses from the Twilio API; resolved."),
        ],
        "attempts": [
            ("Updated the Twilio status callback to hooks.nimbuspay.io", "worked", "New callbacks succeeded."),
        ],
        "fix": "Pointed Twilio at the new webhook domain and backfilled statuses.",
        "follow_ups": ["Manage Twilio webhook config in Terraform."],
    },
    {
        "date": "2026-07-08", "start": "19:03", "severity": "SEV1", "service": "checkout-web",
        "title": "Stripe 429 rate limits during flash sale",
        "on_call": "Rahul Deshpande", "family": "third-party-rate-limit",
        "alert": (
            "[FIRING] CheckoutPaymentFailures SEV1 checkout-web\n"
            "payment intent creation failures 26% for 5m\n"
            "log: StripeRateLimitError: 429 Too Many Requests - rate_limit (request-id req_8Hc2nL0Qf3)"
        ),
        "summary": "During a merchant's flash sale, 26% of payment intent creations failed with Stripe 429s for 44 minutes.",
        "root_cause": "checkout-web created a new PaymentIntent on every render of the payment step and retried failures immediately up to 5 times. The flash sale pushed request rate above the Stripe account limit, and the retries kept it there. Same pattern as the SendGrid incident INC-011.",
        "timeline": [
            (0, "Payment failure alert fired."),
            (5, "Rahul saw StripeRateLimitError 429s."),
            (9, "A teammate suggested raising client retries; Rahul remembered INC-011 and declined."),
            (15, "Deployed a fix to reuse the PaymentIntent per cart instead of creating one per render."),
            (24, "Added exponential backoff with jitter and a server-side queue for intent creation."),
            (44, "Failure rate below 0.5%; resolved."),
        ],
        "attempts": [
            ("Reused PaymentIntents per cart", "partial", "Cut request volume by about 60%."),
            ("Exponential backoff with jitter plus a queue for intent creation", "worked", "429s stopped."),
        ],
        "fix": "Reused PaymentIntents per cart and added exponential backoff with jitter plus queueing.",
        "follow_ups": ["Share the backoff-and-queue client between checkout-web and notifications-svc."],
    },
    {
        "date": "2026-07-14", "start": "05:35", "severity": "SEV1", "service": "auth-service",
        "title": "auth-service TLS certificate expired again",
        "on_call": "Daniel Kowalski", "family": "tls-cert-expiry",
        "alert": (
            "[FIRING] AuthServiceProbeFailed SEV1 auth-service\n"
            "blackbox probe https://auth.nimbuspay.io/healthz failing from 3 regions\n"
            "client error: x509: certificate has expired or is not yet valid: current time 2026-07-14T00:04:52Z is after 2026-07-14T00:00:00Z"
        ),
        "summary": "Logins failed for 39 minutes because the auth-service certificate expired exactly 90 days after the manual renewal in INC-008.",
        "root_cause": "The INC-008 follow-up to move to cert-manager was never done. The manual Let's Encrypt certificate expired again after 90 days, and the 14-day expiry alert was also never created.",
        "timeline": [
            (0, "Probe alert fired."),
            (4, "Daniel found INC-008: same error, 90 days earlier."),
            (11, "Started the manual certbot renewal from INC-008."),
            (20, "Instead installed cert-manager with a Let's Encrypt ClusterIssuer and a Certificate for auth.nimbuspay.io."),
            (33, "cert-manager issued the certificate and updated the secret."),
            (39, "Logins recovered; resolved."),
        ],
        "attempts": [
            ("Manual certbot renewal as in INC-008", "partial", "Would have worked for another 90 days only; abandoned halfway."),
            ("Installed cert-manager with automatic renewal", "worked", "Certificate issued and will renew 30 days before expiry."),
        ],
        "fix": "cert-manager now issues and auto-renews the auth-service certificate.",
        "follow_ups": ["Move every remaining certificate to cert-manager.", "Create the certificate expiry alert from INC-008."],
    },
    {
        "date": "2026-07-18", "start": "09:26", "severity": "SEV3", "service": "payments-api",
        "title": "Bank webhooks rejected because of node clock skew",
        "on_call": "Sofia Lindqvist", "family": None,
        "alert": (
            "[FIRING] BankWebhookRejections SEV3 payments-api\n"
            "webhook signature rejections 8%\n"
            "log: WebhookVerificationError: timestamp outside tolerance (skew 312s)"
        ),
        "summary": "8% of settlement webhooks from the partner bank were rejected for 47 minutes because one node's clock had drifted by 5 minutes.",
        "root_cause": "chronyd had crashed on one node after an OS patch, so its clock drifted. Pods on that node rejected signed webhooks with a 300 s tolerance.",
        "timeline": [
            (0, "Rejection alert fired."),
            (15, "Sofia saw all rejections came from pods on one node."),
            (22, "Found the clock 312 s behind and chronyd dead."),
            (27, "Cordoned and drained the node."),
            (47, "Bank retried the webhooks; resolved."),
        ],
        "attempts": [
            ("Drained the node with the skewed clock", "worked", "Rejections stopped."),
        ],
        "fix": "Drained the node and replaced it.",
        "follow_ups": ["Alert on node clock offset above 1 s."],
    },
    {
        "date": "2026-07-22", "start": "13:05", "severity": "SEV1", "service": "payments-api",
        "title": "refunds table locked by migration during peak",
        "on_call": "Priya Nair", "family": "postgres-migration-lock",
        "alert": (
            "[FIRING] PaymentsApi5xxRate SEV1 payments-api\n"
            "5xx rate 34% for 5m on /v1/refunds and /v1/charges\n"
            "log: psycopg.errors.LockNotAvailable: canceling statement due to lock timeout\n"
            "CONTEXT: while locking tuple in relation \"refunds\""
        ),
        "summary": "34% of payments-api requests failed for 36 minutes when a migration took an ACCESS EXCLUSIVE lock on refunds at lunch peak.",
        "root_cause": "A hotfix migration adding a foreign key to refunds was run by hand from a laptop during peak hours, skipping the off-peak runner built after INC-004 and INC-015, so there was no lock_timeout.",
        "timeline": [
            (0, "5xx alert fired at 34%."),
            (4, "Priya found LockNotAvailable on refunds."),
            (8, "Found INC-004 and INC-015: do not kill the migration first, it makes things worse."),
            (10, "Asked the engineer running the migration to cancel it cleanly from their session."),
            (19, "Lock released after the rollback."),
            (36, "Error rate normal; resolved."),
        ],
        "attempts": [
            ("Cancelled the migration from its own session instead of pg_terminate_backend", "worked", "Clean rollback with no automatic retry."),
            ("Re-ran the migration at 02:00 with lock_timeout 2s and NOT VALID constraint", "worked", "Completed in the off-peak window with no impact."),
        ],
        "fix": "Cancelled the migration and re-ran it off-peak with SET lock_timeout = '2s' and the constraint added as NOT VALID then validated.",
        "follow_ups": ["Block production DDL outside the migration runner with a Postgres role change."],
    },
    {
        "date": "2026-07-27", "start": "16:48", "severity": "SEV2", "service": "search-api",
        "title": "Reindex swapped alias to an empty index",
        "on_call": "Grace Mensah", "family": None,
        "alert": (
            "[FIRING] SearchZeroResultsSpike SEV2 search-api\n"
            "zero-result rate 97% on /v1/transactions/search"
        ),
        "summary": "Transaction search returned no results for 41 minutes because the reindex job swapped the alias before copying finished.",
        "root_cause": "The reindex script ran the _reindex call with wait_for_completion=false and swapped the transactions alias immediately to the new, still empty index.",
        "timeline": [
            (0, "Zero-result alert fired."),
            (7, "Grace saw the alias pointing to transactions-v9 with 0 documents."),
            (11, "Pointed the alias back to transactions-v8."),
            (41, "Reindex finished, alias swapped properly; resolved."),
        ],
        "attempts": [
            ("Swapped the alias back to transactions-v8", "worked", "Search results returned immediately."),
        ],
        "fix": "Reverted the alias and fixed the script to wait for the reindex task and compare document counts.",
        "follow_ups": ["Add a document-count check before any alias swap."],
    },
    {
        "date": "2026-07-31", "start": "12:20", "severity": "SEV1", "service": "payments-api",
        "title": "JPY charges multiplied by 100",
        "on_call": "Aiko Tanaka", "family": None,
        "alert": (
            "[FIRING] PaymentsAmountAnomaly SEV1 payments-api\n"
            "JPY charge amount median 100x the 7d baseline\n"
            "log: charge ch_9KxQ created amount=450000 currency=jpy (cart total 4500)"
        ),
        "summary": "For 33 minutes, JPY charges were created at 100 times the correct amount. 62 customers were overcharged and refunded.",
        "root_cause": "A new amount helper converted all currencies to minor units by multiplying by 100, but JPY is a zero-decimal currency.",
        "timeline": [
            (0, "Amount anomaly alert fired."),
            (6, "Aiko confirmed 450000 JPY for a 4500 JPY cart."),
            (9, "Disabled JPY in the currency allowlist to stop new charges."),
            (18, "Rolled back the payments-api release."),
            (33, "Verified correct amounts and refunded affected charges; resolved."),
        ],
        "attempts": [
            ("Disabled JPY payments", "worked", "Stopped new overcharges."),
            ("Rolled back the payments-api release", "worked", "Amounts correct again."),
        ],
        "fix": "Rolled back and fixed the helper to use ISO 4217 minor-unit exponents.",
        "follow_ups": ["Property tests for amount conversion across zero-decimal and three-decimal currencies."],
    },
    # ------------------------------------------------------------------ August
    {
        "date": "2026-08-05", "start": "08:55", "severity": "SEV2", "service": "notifications-svc",
        "title": "notifications-svc OOMKilled after dependency bump",
        "on_call": "Rahul Deshpande", "family": "memory-leak-oom",
        "alert": (
            "[FIRING] KubePodCrashLooping SEV2 notifications-svc\n"
            "container notifications restarted 11 times in 1h\n"
            "last state: Terminated, Reason: OOMKilled, exit code 137"
        ),
        "summary": "notifications-svc crash-looped with OOMKilled for 61 minutes. The Renovate bot had bumped template-cache to 2.5.1 within the caret range pinned in INC-019.",
        "root_cause": "INC-019 pinned template-cache with ^2.3.4, which still allows 2.5.x. Renovate merged 2.5.1, which has the same unbounded Map as 2.4.0.",
        "timeline": [
            (0, "CrashLoop alert fired."),
            (5, "Rahul raised the memory limit from 512Mi to 1Gi to buy time."),
            (18, "Pods still crashing, just later. Found INC-019."),
            (26, "package-lock showed template-cache 2.5.1 from a Renovate PR on 4 August."),
            (34, "Pinned template-cache to exactly 2.3.4 and added a Renovate ignore rule."),
            (61, "Memory flat; resolved."),
        ],
        "attempts": [
            ("Raised the memory limit from 512Mi to 1Gi", "failed", "Same as INC-009 and INC-019: only delays the crash."),
            ("Pinned template-cache to exactly 2.3.4 with a Renovate ignore rule", "worked", "Memory flat at about 180 MB."),
        ],
        "fix": "Pinned template-cache to the exact version 2.3.4 and blocked Renovate upgrades for it.",
        "follow_ups": ["Replace template-cache with a bounded LRU we own."],
    },
    {
        "date": "2026-08-07", "start": "15:10", "severity": "SEV3", "service": "checkout-web",
        "title": "Product thumbnails failing after Node 22 upgrade",
        "on_call": "Daniel Kowalski", "family": None,
        "alert": (
            "[FIRING] CheckoutImage5xx SEV3 checkout-web\n"
            "500s on /_img resize route 100%\n"
            "log: Error: Could not load the \"sharp\" module using the linux-x64 runtime"
        ),
        "summary": "Product thumbnails on checkout pages failed for 29 minutes after the base image moved to Node 22 without rebuilding the native sharp binary.",
        "root_cause": "node_modules was cached from a Node 20 build layer, so sharp's native binary did not match the Node 22 runtime.",
        "timeline": [
            (0, "Image 500 alert fired."),
            (8, "Daniel found the sharp load error."),
            (13, "Rebuilt the image with the dependency cache cleared."),
            (29, "Thumbnails loading; resolved."),
        ],
        "attempts": [
            ("Rebuilt the container with a clean node_modules", "worked", "sharp loaded correctly."),
        ],
        "fix": "Rebuilt with a clean dependency layer and keyed the CI cache on the Node version.",
        "follow_ups": ["Include the Node version in the CI cache key for every service."],
    },
    {
        "date": "2026-08-12", "start": "02:31", "severity": "SEV1", "service": "payments-api",
        "title": "payments-api p99 at 4 s, Redis pool exhausted after concurrency increase",
        "on_call": "Marcus Oyelaran", "family": "redis-pool-exhaustion",
        "alert": (
            "[FIRING] PaymentsApiHighLatency SEV1 payments-api\n"
            "p99 latency 4.1s (threshold 1.5s) for 5m on POST /v1/charges\n"
            "log: redis.exceptions.ConnectionError: Too many connections\n"
            "  File \"/app/payments/idempotency.py\", line 88, in get_idempotency_key"
        ),
        "summary": "payments-api p99 latency reached 4.1 s and 4% of charges timed out for 52 minutes during the night batch-charge window. Third occurrence of Redis client pool exhaustion (after INC-003 and INC-014).",
        "root_cause": "The 01:50 deploy raised PAYMENTS_WORKER_CONCURRENCY from 8 to 16 for the new subscription billing batch. REDIS_MAX_POOL was still a fixed 20 because the follow-up from INC-003 and INC-014 was never done. Each worker thread holds up to 3 Redis connections at peak, so 16 threads need about 48.",
        "timeline": [
            (0, "Latency alert fired, p99 at 4.1 s."),
            (3, "Marcus saw redis.exceptions.ConnectionError: Too many connections."),
            (8, "Rolling restart of payments-api pods to clear stuck connections."),
            (19, "Latency back at 4 s within 9 minutes of the restart."),
            (24, "Found INC-003 and INC-014. Concurrency had been raised to 16 at 01:50."),
            (27, "Raised REDIS_MAX_POOL from 20 to 50 and rolled back PAYMENTS_WORKER_CONCURRENCY to 8."),
            (38, "Pool utilisation 34%, p99 at 420 ms."),
            (52, "Stable for 14 minutes; resolved."),
        ],
        "attempts": [
            ("Rolling restart of payments-api pods", "failed", "Third time this has failed for this error (INC-003, INC-014). Pools refill within minutes."),
            ("Raised REDIS_MAX_POOL from 20 to 50 and rolled back worker concurrency to 8", "worked", "Pool utilisation fell to 34% and latency recovered in about 11 minutes."),
        ],
        "fix": "Raised REDIS_MAX_POOL from 20 to 50 and rolled back PAYMENTS_WORKER_CONCURRENCY to 8.",
        "follow_ups": [
            "Commit REDIS_MAX_POOL=50 to the Helm values; it was set with kubectl set env during the incident.",
            "Add the pool utilisation alert first proposed in INC-003.",
        ],
    },
    {
        "date": "2026-08-14", "start": "10:37", "severity": "SEV2", "service": "ledger-worker",
        "title": "ledger-worker skipped messages after topic retention change",
        "on_call": "Sofia Lindqvist", "family": None,
        "alert": (
            "[FIRING] LedgerOffsetReset SEV2 ledger-worker\n"
            "log: OffsetOutOfRangeException: Fetch position FetchPosition{offset=88213904} is out of range for partition payments.refunded-4, resetting offset"
        ),
        "summary": "ledger-worker lost 3 hours of refund events for 64 minutes of investigation because topic retention was shortened while the consumer was paused.",
        "root_cause": "A cost-saving change set retention.ms on payments.refunded from 7 days to 2 hours while ledger-worker's refund consumer was paused for maintenance. The committed offsets were deleted and auto.offset.reset=latest skipped the gap.",
        "timeline": [
            (0, "Offset reset alert fired."),
            (14, "Sofia found retention.ms had been changed to 2 hours that morning."),
            (28, "Restored retention to 7 days."),
            (64, "Replayed the missing refunds from the payments-api outbox table; resolved."),
        ],
        "attempts": [
            ("Restored retention and replayed from the outbox table", "worked", "Ledger matched after the replay."),
        ],
        "fix": "Restored 7-day retention and replayed refunds from the outbox.",
        "follow_ups": ["Set auto.offset.reset=none on ledger consumers so gaps fail loudly."],
    },
    {
        "date": "2026-08-18", "start": "22:05", "severity": "SEV2", "service": "auth-service",
        "title": "auth-service down during node group upgrade",
        "on_call": "Tomás Herrera", "family": None,
        "alert": (
            "[FIRING] AuthServiceAvailability SEV2 auth-service\n"
            "available replicas 0/3 for 3m\n"
            "event: Evicted pod auth-service-6c9f7d-x2l8q (node drain ip-10-4-22-19)"
        ),
        "summary": "auth-service had zero ready replicas for about 6 minutes, and logins were degraded for 27 minutes, during an EKS node group AMI upgrade.",
        "root_cause": "auth-service had no PodDisruptionBudget and all 3 replicas were on nodes in the same upgrade batch, so the drain evicted them together.",
        "timeline": [
            (0, "Availability alert fired."),
            (3, "Tomás paused the node group upgrade."),
            (6, "Replicas rescheduled and ready."),
            (27, "Added a PDB and topology spread, resumed the upgrade; resolved."),
        ],
        "attempts": [
            ("Paused the node group upgrade", "worked", "Pods came back on remaining nodes."),
        ],
        "fix": "Added a PodDisruptionBudget (minAvailable 2) and zone topology spread to auth-service.",
        "follow_ups": ["Require a PDB for every Deployment in the Helm linter."],
    },
    {
        "date": "2026-08-21", "start": "18:30", "severity": "SEV3", "service": "search-api",
        "title": "search-api scaled down to 1 replica when metrics-server failed",
        "on_call": "Priya Nair", "family": None,
        "alert": (
            "[FIRING] SearchApiHighLatency SEV3 search-api\n"
            "p95 latency 2.8s for 10m\n"
            "event: HorizontalPodAutoscaler search-api: failed to get cpu utilization: unable to get metrics for resource cpu"
        ),
        "summary": "search-api latency rose to 2.8 s for 45 minutes after the HPA scaled it to its minimum of 1 replica because metrics-server was down.",
        "root_cause": "metrics-server crashed after a certificate rotation. The HPA minReplicas was 1, so without metrics it scaled search-api to 1 pod during the evening peak.",
        "timeline": [
            (0, "Latency alert fired."),
            (9, "Priya saw 1 replica and HPA metric errors."),
            (13, "Scaled search-api to 6 replicas by hand."),
            (45, "Restarted metrics-server with a fixed cert; resolved."),
        ],
        "attempts": [
            ("Manually scaled search-api to 6 replicas", "worked", "Latency recovered."),
            ("Restarted metrics-server with the new kubelet serving certificate", "worked", "HPA working again."),
        ],
        "fix": "Fixed metrics-server and raised search-api minReplicas to 3.",
        "follow_ups": ["Alert when any HPA reports FailedGetResourceMetric."],
    },
    {
        "date": "2026-08-26", "start": "14:14", "severity": "SEV2", "service": "ledger-worker",
        "title": "ledger-cg lag after deploy, batch size raised to 3000",
        "on_call": "Daniel Kowalski", "family": "kafka-consumer-lag",
        "alert": (
            "[FIRING] KafkaConsumerGroupLag SEV2 ledger-worker\n"
            "consumer group ledger-cg lag=211604 (threshold 20000) on topic payments.settled\n"
            "log: CommitFailedException: Commit cannot be completed since the group has already rebalanced and assigned the partitions to another member"
        ),
        "summary": "ledger-cg lag reached 211,604 for 63 minutes after a ledger-worker deploy. Third time a batch-size change caused a rebalance storm (INC-007, INC-018).",
        "root_cause": "An environment override in the production values file set LEDGER_BATCH_SIZE=3000, bypassing the config test added after INC-018, which only checked the default values file.",
        "timeline": [
            (0, "Consumer lag alert fired at 211,604."),
            (4, "Daniel checked the runbook, which links INC-007 and INC-018: do not scale up consumers."),
            (9, "Found LEDGER_BATCH_SIZE=3000 in values-prod.yaml from the 13:50 deploy."),
            (12, "Rolled back the batch-size config to 500."),
            (63, "Lag cleared; resolved."),
        ],
        "attempts": [
            ("Rolled back LEDGER_BATCH_SIZE to 500", "worked", "Rebalances stopped within 2 minutes and lag drained."),
        ],
        "fix": "Rolled back the batch-size config to 500 in values-prod.yaml.",
        "follow_ups": ["Run the batch-size config test against every environment values file."],
    },
    {
        "date": "2026-08-29", "start": "07:50", "severity": "SEV2", "service": "ledger-worker",
        "title": "Kafka broker EBS volume degraded, consumer lag",
        "on_call": "Grace Mensah", "family": None,
        "alert": (
            "[FIRING] KafkaConsumerGroupLag SEV2 ledger-worker\n"
            "consumer group ledger-cg lag=58210 on topic payments.settled\n"
            "AWS Health: EBS volume vol-0c1e degraded performance in ap-south-1a (broker kafka-2)"
        ),
        "summary": "ledger-cg lag reached 58,210 for 72 minutes because one Kafka broker's EBS volume was degraded. No deploy was involved.",
        "root_cause": "An AWS EBS degradation in ap-south-1a slowed disk I/O on broker kafka-2, which led 4 partitions of payments.settled. Fetches from those partitions stalled.",
        "timeline": [
            (0, "Lag alert fired."),
            (10, "Grace confirmed no ledger-worker deploy in the last 3 days, unlike INC-007 and INC-018."),
            (18, "Found high fetch latency only from kafka-2 and an AWS Health event."),
            (26, "Moved partition leadership off kafka-2 with a preferred replica election."),
            (72, "Lag cleared after AWS resolved the volume; resolved."),
        ],
        "attempts": [
            ("Moved partition leadership off broker kafka-2", "worked", "Lag started draining immediately."),
        ],
        "fix": "Shifted partition leadership away from the degraded broker until AWS recovered the volume.",
        "follow_ups": ["Alert on per-broker fetch latency."],
    },
    # ------------------------------------------------------------------ September
    {
        "date": "2026-09-01", "start": "06:00", "severity": "SEV2", "service": "payments-api",
        "title": "Payout scheduler ran on two pods at once",
        "on_call": "Rahul Deshpande", "family": None,
        "alert": (
            "[FIRING] PayoutDuplicateBatch SEV2 payments-api\n"
            "payout batch pb_2026-09-01 created twice\n"
            "log: WARN leader election: lease payout-scheduler renewed by 2 holders"
        ),
        "summary": "Two payments-api pods both ran the payout scheduler; a duplicate payout batch was caught before the bank file was sent. Investigation took 49 minutes.",
        "root_cause": "The leader election lease duration was 15 s with a 10 s renew deadline, and a GC pause of 17 s on the leader let a second pod take over while the first continued.",
        "timeline": [
            (0, "Duplicate batch alert fired."),
            (8, "Rahul held the bank file export."),
            (21, "Found overlapping lease holders in the logs."),
            (35, "Deleted the duplicate batch."),
            (49, "Verified totals; resolved."),
        ],
        "attempts": [
            ("Held the bank file export and removed the duplicate batch", "worked", "No duplicate payouts were sent."),
        ],
        "fix": "Removed the duplicate batch and added a unique constraint on payout batch date.",
        "follow_ups": ["Use a database advisory lock as a second guard for the payout job."],
    },
    {
        "date": "2026-09-03", "start": "21:18", "severity": "SEV1", "service": "payments-api",
        "title": "payments-api p99 at 4.3 s, Redis Too many connections after Helm release",
        "on_call": "Marcus Oyelaran", "family": "redis-pool-exhaustion",
        "alert": (
            "[FIRING] PaymentsApiHighLatency SEV1 payments-api\n"
            "p99 latency 4.3s (threshold 1.5s) for 5m on POST /v1/charges\n"
            "log: redis.exceptions.ConnectionError: Too many connections\n"
            "  File \"/app/payments/ratelimit.py\", line 41, in check_merchant_quota"
        ),
        "summary": "payments-api p99 latency reached 4.3 s and 3.8% of charges failed for 41 minutes at evening peak. Fourth Redis client pool exhaustion incident (INC-003, INC-014, INC-030).",
        "root_cause": "The 20:55 Helm release reset REDIS_MAX_POOL to 20, because the INC-030 fix had been applied with kubectl set env and never committed to the Helm values. The same release raised PAYMENTS_WORKER_CONCURRENCY to 16 again for subscription billing.",
        "timeline": [
            (0, "Latency alert fired, p99 at 4.3 s."),
            (2, "Marcus recognised the error from INC-030."),
            (5, "Tomás, shadowing on-call, restarted the payments-api pods before the plan was agreed."),
            (14, "Latency back at 4.2 s after the restart, as in INC-030."),
            (17, "Found REDIS_MAX_POOL=20 in the running pods; the kubectl change from INC-030 was lost in the Helm release."),
            (19, "Raised REDIS_MAX_POOL from 20 to 50 and rolled back PAYMENTS_WORKER_CONCURRENCY to 8, this time in the Helm values."),
            (29, "p99 at 410 ms."),
            (41, "Stable; resolved."),
        ],
        "attempts": [
            ("Rolling restart of payments-api pods", "failed", "Failed for the fourth time on this error (INC-003, INC-014, INC-030)."),
            ("Raised REDIS_MAX_POOL from 20 to 50 and rolled back worker concurrency to 8, committed to Helm values", "worked", "Recovered in about 10 minutes, and the setting now survives releases."),
        ],
        "fix": "Raised REDIS_MAX_POOL from 20 to 50 and rolled back PAYMENTS_WORKER_CONCURRENCY to 8, committed to the Helm chart values.",
        "follow_ups": [
            "Compute REDIS_MAX_POOL as 3 x PAYMENTS_WORKER_CONCURRENCY in the chart so they cannot drift apart.",
            "Pool utilisation alert: open since INC-003.",
            "Marcus is leaving Nimbus Pay at the end of September; hand over the payments Redis runbook.",
        ],
    },
    {
        "date": "2026-09-05", "start": "13:22", "severity": "SEV3", "service": "checkout-web",
        "title": "Third-party A/B testing script slowed checkout",
        "on_call": "Sofia Lindqvist", "family": None,
        "alert": (
            "[FIRING] CheckoutWebVitals SEV3 checkout-web\n"
            "LCP p75 6.2s (threshold 2.5s) for 30m"
        ),
        "summary": "Checkout page load (LCP p75) rose to 6.2 s for 55 minutes after marketing added a synchronous A/B testing script.",
        "root_cause": "The A/B vendor snippet was added in the tag manager as a blocking script in the head, and the vendor's CDN was slow in India that day.",
        "timeline": [
            (0, "Web vitals alert fired."),
            (18, "Sofia found a render-blocking script from the tag manager."),
            (31, "Disabled the tag in the tag manager."),
            (55, "LCP back to 1.9 s; resolved."),
        ],
        "attempts": [
            ("Disabled the A/B testing tag", "worked", "LCP recovered."),
        ],
        "fix": "Removed the tag; it came back later as an async script.",
        "follow_ups": ["Engineering review for tag manager changes on checkout pages."],
    },
    {
        "date": "2026-09-08", "start": "10:02", "severity": "SEV3", "service": "notifications-svc",
        "title": "Emails sent with raw template variables",
        "on_call": "Aiko Tanaka", "family": None,
        "alert": (
            "[FIRING] NotificationsTemplateRenderWarnings SEV3 notifications-svc\n"
            "missing variable warnings 12,400 in 15m\n"
            "log: WARN render: missing variable first_name in template payout_ready_v3"
        ),
        "summary": "About 12,400 payout emails went out showing {{first_name}} for 31 minutes after a template rename.",
        "root_cause": "The template was updated to use first_name, but the payout event still sent merchant_first_name, and the renderer only warns on missing variables.",
        "timeline": [
            (0, "Warning spike alert fired."),
            (7, "Aiko confirmed the raw variable in a sample email."),
            (11, "Paused the payout email queue."),
            (31, "Reverted the template and resumed; resolved."),
        ],
        "attempts": [
            ("Paused the queue and reverted the template", "worked", "New emails rendered correctly."),
        ],
        "fix": "Reverted the template; renderer now fails on missing variables in production.",
        "follow_ups": ["Contract tests between event payloads and templates."],
    },
    {
        "date": "2026-09-10", "start": "18:40", "severity": "SEV2", "service": "notifications-svc",
        "title": "SendGrid 429s during merchant campaign send",
        "on_call": "Priya Nair", "family": "third-party-rate-limit",
        "alert": (
            "[FIRING] NotificationsSendFailures SEV2 notifications-svc\n"
            "failed email sends 22% for 10m\n"
            "log: HTTPError: 429 Too Many Requests from api.sendgrid.com (X-RateLimit-Remaining: 0)"
        ),
        "summary": "22% of emails failed for 37 minutes when a large merchant scheduled a 250,000-recipient campaign. Same SendGrid limit as INC-011.",
        "root_cause": "Campaign sends went through the transactional path that still retried with a fixed 1 s delay; the shared backoff-and-queue client from INC-022 had only been adopted by checkout-web.",
        "timeline": [
            (0, "Send failure alert fired."),
            (5, "Priya found INC-011 and INC-022; skipped raising retries."),
            (12, "Routed campaign sends through the bulk queue at 50 messages per second."),
            (20, "Enabled exponential backoff with jitter honouring Retry-After in notifications-svc."),
            (37, "Failures under 0.2%; resolved."),
        ],
        "attempts": [
            ("Routed campaign sends through the throttled bulk queue", "worked", "Stayed under the rate limit."),
            ("Enabled exponential backoff with jitter honouring Retry-After", "worked", "Remaining 429s were absorbed."),
        ],
        "fix": "Exponential backoff with jitter plus queueing for all SendGrid sends.",
        "follow_ups": ["Ask SendGrid for a higher limit before large campaigns."],
    },
    {
        "date": "2026-09-12", "start": "09:15", "severity": "SEV2", "service": "auth-service",
        "title": "Login rate limiter locked out users after password reset change",
        "on_call": "Grace Mensah", "family": None,
        "alert": (
            "[FIRING] AuthLoginLockouts SEV2 auth-service\n"
            "429 on POST /v1/login 15x baseline\n"
            "log: RateLimitExceeded: key=login:ip:103.21.x.x limit=5/15m"
        ),
        "summary": "Users behind shared office IPs were locked out of login for 43 minutes after the password reset flow started counting towards the login rate limit.",
        "root_cause": "The new password reset flow called the login endpoint internally, and the rate limiter keyed on client IP, so large offices behind one NAT hit 5 attempts per 15 minutes quickly.",
        "timeline": [
            (0, "Lockout alert fired."),
            (12, "Grace traced the extra attempts to the reset flow."),
            (20, "Raised the per-IP limit to 50 and keyed on user plus IP."),
            (43, "Lockouts gone; resolved."),
        ],
        "attempts": [
            ("Changed the rate limit key to user plus IP and raised the IP limit", "worked", "Legitimate users could log in again."),
        ],
        "fix": "Rate limiter keys on user plus IP, and the reset flow no longer calls the login endpoint.",
        "follow_ups": ["Add office NAT ranges to the rate limiter allowlist review."],
    },
    {
        "date": "2026-09-14", "start": "20:05", "severity": "SEV3", "service": "search-api",
        "title": "Slow search after synonyms file update",
        "on_call": "Tomás Herrera", "family": None,
        "alert": (
            "[FIRING] SearchApiHighLatency SEV3 search-api\n"
            "p99 latency 3.1s (threshold 1s) for 15m on /v1/merchants/search"
        ),
        "summary": "Merchant search p99 was 3.1 s for 48 minutes after a synonyms file with 40,000 entries was deployed.",
        "root_cause": "The synonyms update expanded common words into dozens of terms at query time, making every query a large boolean query.",
        "timeline": [
            (0, "Latency alert fired."),
            (15, "Tomás found the synonyms deploy at 19:50."),
            (22, "Reverted to the previous synonyms file and reloaded the analyzers."),
            (48, "Latency normal; resolved."),
        ],
        "attempts": [
            ("Reverted the synonyms file", "worked", "Latency back to 180 ms."),
        ],
        "fix": "Reverted, then shipped a curated synonyms list of 1,200 entries.",
        "follow_ups": ["Benchmark synonyms changes in staging with production queries."],
    },
    {
        "date": "2026-09-16", "start": "11:48", "severity": "SEV2", "service": "payments-api",
        "title": "payments-api left at DEBUG logging, card metadata in logs",
        "on_call": "Daniel Kowalski", "family": None,
        "alert": (
            "[FIRING] PaymentsApiLogVolume SEV2 payments-api\n"
            "log volume 14x baseline\n"
            "dlp: possible card BIN and last4 pattern detected in payments-api logs"
        ),
        "summary": "payments-api logged request bodies with card BIN and last four digits at DEBUG level for 2 hours before detection; the incident was contained in 56 minutes.",
        "root_cause": "A debugging session set LOG_LEVEL=DEBUG with a runtime override that was not reset, and DEBUG logging includes request bodies.",
        "timeline": [
            (0, "Log volume and DLP alerts fired."),
            (6, "Daniel set LOG_LEVEL back to INFO."),
            (25, "Security confirmed only BIN and last four were logged, no full card numbers."),
            (56, "Purged the affected log indices; resolved."),
        ],
        "attempts": [
            ("Reset LOG_LEVEL to INFO and purged affected logs", "worked", "No further sensitive data logged."),
        ],
        "fix": "Reset logging and purged the affected indices; DEBUG no longer logs request bodies.",
        "follow_ups": ["Redact card fields in the logging middleware at every level."],
    },
    {
        "date": "2026-09-18", "start": "16:33", "severity": "SEV2", "service": "ledger-worker",
        "title": "ledger-worker deserialization failures after schema change",
        "on_call": "Priya Nair", "family": None,
        "alert": (
            "[FIRING] LedgerDeserializationErrors SEV2 ledger-worker\n"
            "dead-letter rate 100% on payments.captured\n"
            "log: SerializationException: Unknown magic byte!"
        ),
        "summary": "All payments.captured events went to the dead-letter topic for 39 minutes because a producer started sending plain JSON instead of Avro.",
        "root_cause": "A payments-api refactor switched the captured-event producer to a JSON serializer by mistake, so messages lacked the schema registry magic byte.",
        "timeline": [
            (0, "Dead-letter alert fired."),
            (9, "Priya saw Unknown magic byte! on every message."),
            (16, "Rolled back the payments-api producer change."),
            (39, "Replayed the dead-letter topic; resolved."),
        ],
        "attempts": [
            ("Rolled back the producer change and replayed the dead-letter topic", "worked", "All events processed."),
        ],
        "fix": "Rolled back the serializer change and replayed dead-lettered events.",
        "follow_ups": ["Schema compatibility check in the payments-api CI pipeline."],
    },
    {
        "date": "2026-09-20", "start": "12:05", "severity": "SEV3", "service": "checkout-web",
        "title": "Stale service worker served old checkout bundle",
        "on_call": "Rahul Deshpande", "family": None,
        "alert": (
            "[FIRING] CheckoutApiVersionMismatch SEV3 checkout-web\n"
            "requests from bundle v412 to API expecting >= v420: 7% of sessions\n"
            "api: 400 Bad Request: unknown field 'shipping_option_id'"
        ),
        "summary": "7% of returning customers got checkout errors for 46 minutes because a service worker kept serving an old JavaScript bundle.",
        "root_cause": "The service worker used a cache-first strategy for index.html, so returning users loaded the old bundle that sent a removed field.",
        "timeline": [
            (0, "Version mismatch alert fired."),
            (14, "Rahul matched the errors to bundle v412."),
            (22, "Shipped a service worker update with skipWaiting and network-first for index.html."),
            (46, "Old bundle sessions under 0.5%; resolved."),
        ],
        "attempts": [
            ("Shipped a network-first service worker with skipWaiting", "worked", "Clients picked up the new bundle."),
        ],
        "fix": "Network-first caching for index.html and a server-side shim for the old field.",
        "follow_ups": ["Keep the API backward compatible for two bundle versions."],
    },
]

DEMO_ALERTS: list[dict[str, Any]] = [
    {
        "id": "DEMO-A",
        "title": "payments-api p99 latency at 4.2 s with Redis connection errors",
        "service": "payments-api",
        "severity": "SEV1",
        "alert_text": (
            "[FIRING] PaymentsApiHighLatency SEV1 payments-api\n"
            "p99 latency 4.2s (threshold 1.5s) for 5m on POST /v1/charges\n"
            "log: redis.exceptions.ConnectionError: Too many connections\n"
            "  File \"/app/payments/idempotency.py\", line 88, in get_idempotency_key\n"
            "recent deploy: payments-api 2026.09.28-1 at 02:05"
        ),
        "expected": "Strong match to the Redis pool exhaustion family. Should cite INC-030 and INC-037, warn that restarting pods failed, point at a worker concurrency change in the 02:05 deploy, and recommend raising REDIS_MAX_POOL and rolling back worker concurrency. The alert itself does not say what the deploy changed; only memory knows that concurrency changes cause this.",
        "signals": [
            {"at_ms": 0, "level": "info", "text": "02:05:12 deploy payments-api 2026.09.28-1"},
            {"at_ms": 900, "level": "warn", "text": "02:38:40 payments-api p99 1.9s (threshold 1.5s)"},
            {"at_ms": 1800, "level": "warn", "text": "02:39:30 payments-api redis client errors 6/s: ConnectionError: Too many connections"},
            {"at_ms": 2700, "level": "critical", "text": "02:40:05 payments-api p99 4.2s, charge failures 3.4%"},
            {"at_ms": 3600, "level": "critical", "text": "02:40:07 PaymentsApiHighLatency SEV1 firing, paging on-call"},
        ],
    },
    {
        "id": "DEMO-B",
        "title": "ledger-worker consumer lag on ledger-cg after deploy",
        "service": "ledger-worker",
        "severity": "SEV2",
        "alert_text": (
            "[FIRING] KafkaConsumerGroupLag SEV2 ledger-worker\n"
            "consumer group ledger-cg lag=184322 (threshold 20000) on topic payments.settled\n"
            "log: CommitFailedException: Commit cannot be completed since the group has already rebalanced\n"
            "recent deploy: ledger-worker 2026.09.28-3 at 15:10"
        ),
        "expected": "Matches the Kafka consumer lag family. Should warn that scaling consumers up failed in INC-007 and INC-018, and recommend rolling back the batch-size config.",
        "signals": [
            {"at_ms": 0, "level": "info", "text": "15:10:02 deploy ledger-worker 2026.09.28-3"},
            {"at_ms": 900, "level": "warn", "text": "15:14:40 ledger-cg rebalances 4 in 5m"},
            {"at_ms": 1800, "level": "warn", "text": "15:18:10 ledger-cg lag=61,904 on payments.settled"},
            {"at_ms": 2700, "level": "critical", "text": "15:24:55 ledger-cg lag=184,322, CommitFailedException rate 12/s"},
            {"at_ms": 3600, "level": "critical", "text": "15:25:00 KafkaConsumerGroupLag SEV2 firing, paging on-call"},
        ],
    },
    {
        "id": "DEMO-C",
        "title": "search-api returning 502s after CDN config change",
        "service": "search-api",
        "severity": "SEV2",
        "alert_text": (
            "[FIRING] SearchApiEdge5xx SEV2 search-api\n"
            "502 Bad Gateway rate 38% at the edge for 5m on /v1/transactions/search\n"
            "cdn log: origin_response_status=502 upstream=search-origin.nimbuspay.io error=\"TLS handshake failed: SNI mismatch\"\n"
            "recent change: CDN origin config updated at 11:40 (origin host header set to search-origin.nimbuspay.io)"
        ),
        "expected": "No strong precedent in memory. The agent should say so plainly and give a low-confidence answer.",
        "signals": [
            {"at_ms": 0, "level": "info", "text": "11:40:03 CDN origin config updated: search origin host header -> search-origin.nimbuspay.io"},
            {"at_ms": 900, "level": "warn", "text": "11:41:20 edge 5xx on /v1/transactions/search 4%"},
            {"at_ms": 1800, "level": "warn", "text": "11:42:45 cdn origin errors: TLS handshake failed: SNI mismatch"},
            {"at_ms": 2700, "level": "critical", "text": "11:44:10 edge 502 rate 38% on search endpoints"},
            {"at_ms": 3600, "level": "critical", "text": "11:44:12 SearchApiEdge5xx SEV2 firing, paging on-call"},
        ],
        "follow_up_service": "checkout-web",
        "follow_up_alert": (
            "[FIRING] CheckoutEdgeErrors SEV2 checkout-web\n"
            "edge 502s on /checkout/* at 27% for 5m\n"
            "cdn log: upstream TLS negotiation error: server name does not match certificate for checkout-origin.nimbuspay.io\n"
            "recent change: CDN origin rule for checkout edited 20 minutes ago"
        ),
    },
]


def build() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    specs = sorted(SPECS, key=lambda s: (s["date"], s["start"]))
    incidents: list[dict[str, Any]] = []
    postmortems: list[dict[str, Any]] = []
    for index, spec in enumerate(specs, start=1):
        incident_id = f"INC-{index:03d}"
        started = datetime.fromisoformat(f"{spec['date']}T{spec['start']}:00").replace(tzinfo=IST)
        ttr = spec["timeline"][-1][0]
        resolved = started + timedelta(minutes=ttr)
        incidents.append({
            "id": incident_id,
            "title": spec["title"],
            "service": spec["service"],
            "severity": spec["severity"],
            "started_at": started.isoformat(),
            "resolved_at": resolved.isoformat(),
            "alert_text": spec["alert"],
            "on_call": spec["on_call"],
            "family": spec["family"],
        })
        postmortems.append({
            "incident_id": incident_id,
            "summary": spec["summary"],
            "root_cause": spec["root_cause"],
            "timeline": [
                {"time": (started + timedelta(minutes=offset)).isoformat(), "event": event}
                for offset, event in spec["timeline"]
            ],
            "attempts": [
                {"action": action, "outcome": outcome, "notes": notes}
                for action, outcome, notes in spec["attempts"]
            ],
            "fix": spec["fix"],
            "follow_ups": spec["follow_ups"],
            "ttr_minutes": ttr,
        })
    return incidents, postmortems


def main() -> None:
    incidents, postmortems = build()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for name, payload in (
        ("incidents.json", incidents),
        ("postmortems.json", postmortems),
        ("demo_alerts.json", DEMO_ALERTS),
    ):
        (DATA_DIR / name).write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"wrote data/{name} ({len(payload)} records)")


if __name__ == "__main__":
    main()
