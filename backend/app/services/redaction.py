"""Secret redaction applied to every piece of text before it is retained into Hindsight."""

import re

PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.DOTALL), "[REDACTED PRIVATE KEY]"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"), "[REDACTED KEY]"),
    (re.compile(r"\bhsk_[A-Za-z0-9]{16,}"), "[REDACTED KEY]"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"), "[REDACTED TOKEN]"),
    (re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"), "[REDACTED TOKEN]"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[REDACTED AWS KEY]"),
    (re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*"), "Bearer [REDACTED]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"), "[REDACTED JWT]"),
    (re.compile(r"(?i)\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY)[A-Z0-9_]*)(\s*[:=]\s*)[\"']?[^\s\"',;]+"),
     r"\1\2[REDACTED]"),
    (re.compile(r"(?i)(://[^/\s:@]+:)[^@\s/]+@"), r"\1[REDACTED]@"),
]


def redact(text: str) -> str:
    for pattern, replacement in PATTERNS:
        text = pattern.sub(replacement, text)
    return text
