"""Read-only access to a folder the engineer explicitly authorized.

Every path is resolved and checked to lie inside the project root (no traversal, no symlink escape).
Nothing here writes to the project. The finder is deterministic: it looks for the config identifiers
that past fixes changed (for example REDIS_MAX_POOL in INC-030) and reports where they are set now.
"""

import re
import subprocess
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.models import CodeFinding, GitContext, LogContext, SnippetLine

SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".idea", ".vscode",
             "target", ".pytest_cache", ".mypy_cache", "coverage"}
TEXT_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".java", ".kt", ".rb", ".rs", ".cs", ".yaml", ".yml",
                 ".json", ".toml", ".ini", ".cfg", ".conf", ".env", ".properties", ".tf", ".sh", ".md", ".txt", ".sql",
                 ".log", ".dockerfile"}
CONFIG_SUFFIXES = {".yaml", ".yml", ".env", ".toml", ".ini", ".cfg", ".conf", ".properties", ".json", ".tf"}
MAX_FILE_BYTES = 512 * 1024
MAX_FILES = 4000
MAX_FINDINGS = 4

IDENTIFIER = re.compile(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b")
DOTTED = re.compile(r"\b[a-z]+(?:\.[a-z]+){2,}\b")
NOT_CONFIG = {"INC", "SEV1", "SEV2", "SEV3", "HTTP_1", "UTF_8"}
DOTTED_TLDS = (".com", ".io", ".internal", ".net", ".org", ".py", ".ts", ".js", ".yaml", ".yml", ".json")
ERROR_LINE = re.compile(r"\b(ERROR|FATAL|CRITICAL|Traceback|Exception|panic|OOMKilled|x509)\b|Error:", re.IGNORECASE)
CONTEXT_LINE = re.compile(r"^\s+(File |at |raise |\S+Error)")
WARN_LINE = re.compile(r"\bWARN(ING)?\b")
TIMESTAMP = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2}|Z)?)")


class ProjectAccessError(Exception):
    """A path was outside the authorized project, or the project folder is unavailable."""


@dataclass(frozen=True)
class SearchHit:
    path: Path
    line: int
    text: str
    term: str


def validate_root(root_path: str) -> Path:
    root = Path(root_path).expanduser().resolve()
    if not root.is_dir():
        raise ProjectAccessError(f"{root_path} is not a folder.")
    if root.parent == root or root == Path.home().resolve():
        raise ProjectAccessError("Choose a project folder, not a drive root or your whole home folder.")
    return root


def inside(root: Path, candidate: Path) -> Path:
    resolved = candidate.resolve()
    if resolved != root and root not in resolved.parents:
        raise ProjectAccessError("That path is outside the authorized project.")
    return resolved


def iter_files(root: Path) -> Iterator[Path]:
    count = 0
    stack = [root]
    while stack and count < MAX_FILES:
        folder = stack.pop()
        try:
            entries = sorted(folder.iterdir())
        except OSError:
            continue
        for entry in entries:
            if entry.is_symlink():
                continue
            if entry.is_dir():
                if entry.name not in SKIP_DIRS:
                    stack.append(entry)
                continue
            name = entry.name.lower()
            if entry.suffix.lower() in TEXT_SUFFIXES or name.startswith(".env") or name == "dockerfile":
                try:
                    if entry.stat().st_size <= MAX_FILE_BYTES:
                        count += 1
                        yield entry
                except OSError:
                    continue


def read_lines(path: Path) -> list[str]:
    try:
        return path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []


def search(root: Path, terms: list[str], max_hits: int = 60) -> list[SearchHit]:
    hits: list[SearchHit] = []
    if not terms:
        return hits
    for path in iter_files(root):
        if path.suffix.lower() == ".log":
            continue
        for number, line in enumerate(read_lines(path), start=1):
            for term in terms:
                if term in line:
                    hits.append(SearchHit(path=path, line=number, text=line, term=term))
                    if len(hits) >= max_hits:
                        return hits
    return hits


def snippet(path: Path, line: int, radius: int = 2) -> list[SnippetLine]:
    lines = read_lines(path)
    start, end = max(1, line - radius), min(len(lines), line + radius)
    return [SnippetLine(no=n, text=lines[n - 1]) for n in range(start, end + 1)]


def count_files(root: Path) -> int:
    return sum(1 for _ in iter_files(root))


def _parse_ts(text: str) -> datetime | None:
    match = TIMESTAMP.match(text)
    if not match:
        return None
    try:
        return datetime.fromisoformat(match.group(1).replace("Z", "+00:00"))
    except ValueError:
        return None


def recent_log_errors(root: Path, minutes: int = 15, max_lines: int = 16) -> LogContext | None:
    """The newest error block from the project's log files, if any error is recent."""
    candidates = [p for p in iter_files(root) if p.suffix.lower() == ".log"]
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    for path in candidates[:5]:
        lines = read_lines(path)
        keep: list[str] = []
        errors = 0
        latest: str | None = None
        for index, line in enumerate(lines):
            ts = _parse_ts(line)
            if ts is not None and ts.tzinfo is not None and ts < cutoff:
                continue
            is_error = bool(ERROR_LINE.search(line))
            is_warning = bool(WARN_LINE.search(line))
            is_trace = bool(CONTEXT_LINE.search(line)) and bool(keep) and index > 0
            if is_error or is_warning or is_trace:
                keep.append(line)
            if is_error and ts is not None and not line.startswith(" "):
                errors += 1
                latest = ts.isoformat()
            elif is_error and ts is None and not line.startswith(" "):
                errors += 1
        if errors:
            return LogContext(path=str(path.relative_to(root)).replace("\\", "/"), lines=keep[-max_lines:],
                              error_count=errors, latest=latest)
    return None


def git_context(root: Path) -> GitContext | None:
    try:
        branch = subprocess.run(["git", "-C", str(root), "rev-parse", "--abbrev-ref", "HEAD"],
                                capture_output=True, text=True, timeout=3)
        log = subprocess.run(["git", "-C", str(root), "log", "-5", "--pretty=%h %s"],
                             capture_output=True, text=True, timeout=3)
    except (OSError, subprocess.SubprocessError):
        return None
    if branch.returncode != 0 or log.returncode != 0:
        return None
    return GitContext(branch=branch.stdout.strip(), recent_commits=[c for c in log.stdout.splitlines() if c.strip()])


def config_identifiers(text: str) -> list[str]:
    found: list[str] = []
    for match in IDENTIFIER.findall(text):
        if match not in NOT_CONFIG and match not in found:
            found.append(match)
    for match in DOTTED.findall(text):
        if not match.endswith(DOTTED_TLDS) and match not in found:
            found.append(match)
    return found


def _assigned_value(line: str, identifier: str) -> str | None:
    match = re.search(rf"{re.escape(identifier)}\s*[:=]\s*[\"']?([^\"'#,\s]+)", line)
    return match.group(1) if match else None


def _changes(identifier: str, iid: str, text: str) -> list[str]:
    changes: list[str] = []
    for match in re.finditer(rf"{re.escape(identifier)}[^.;]*?\bfrom\s+(\S+?)\s+to\s+(\S+?)[\s.,;)]", text):
        change = f"{iid}: {identifier} from {match.group(1)} to {match.group(2)}"
        if change not in changes:
            changes.append(change)
    return changes


def find_findings(root: Path, history: dict[str, str]) -> list[CodeFinding]:
    """history maps an incident ID to its fix, root cause and attempt text. Returns places in the project
    where identifiers from those past fixes are set today, most-referenced identifiers first."""
    mentions: dict[str, list[str]] = {}
    for iid, text in history.items():
        for identifier in config_identifiers(text):
            mentions.setdefault(identifier, []).append(iid)
    ranked = sorted(mentions, key=lambda ident: len(mentions[ident]), reverse=True)
    hits = search(root, ranked)
    findings: list[CodeFinding] = []
    seen: set[str] = set()
    # Assignments in config files first, then assignments in code, then any other mention.
    def priority(hit: SearchHit) -> tuple[int, int]:
        assigned = _assigned_value(hit.text, hit.term) is not None
        config = hit.path.suffix.lower() in CONFIG_SUFFIXES
        return (0 if assigned and config else 1 if assigned else 2, ranked.index(hit.term))

    for hit in sorted(hits, key=priority):
        if hit.term in seen or len(findings) >= MAX_FINDINGS:
            continue
        seen.add(hit.term)
        value = _assigned_value(hit.text, hit.term)
        related = mentions[hit.term]
        changes = [c for iid in related for c in _changes(hit.term, iid, history[iid])]
        rel_path = str(hit.path.relative_to(root)).replace("\\", "/")
        if value is not None:
            note = f"{hit.term} is {value} here."
        else:
            note = f"{hit.term} is used here."
        note += f" It was part of the fix in {', '.join(related)}." if related else ""
        findings.append(CodeFinding(
            path=rel_path, abs_path=str(hit.path), line=hit.line, identifier=hit.term, current_value=value,
            snippet=snippet(hit.path, hit.line), related_incidents=related, history=changes[:4], note=note,
        ))
    return findings
