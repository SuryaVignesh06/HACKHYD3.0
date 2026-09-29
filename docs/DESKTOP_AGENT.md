# On-Call Copilot 2.0: desktop engineering memory agent

Tagline: **Your engineering team's memory, always one shortcut away.**

This document records the architecture audit and the staged plan for turning the web console into a desktop-first agent. The web console, History and Patterns stay; the desktop layer is added on top.

## 1. Audit of what exists (before 2.0)

| Layer | State |
| --- | --- |
| Frontend | React 18, Vite, TypeScript strict, Tailwind, Framer Motion, lucide-react. Routes: Console, History, Patterns, incident detail. No Electron. |
| Backend | FastAPI. Routers `incidents.py`, `patterns.py`. Services `memory.py` (only Hindsight importer), `llm.py` (only OpenRouter caller), `evidence.py` (verification rules), `diagnosis.py` (streamed investigation). |
| Hindsight | Bank `nimbus-oncall`: mission, disposition, 4 directives, 45 seeded postmortems. Calls used: `retain_batch`, `retain` (alert, fix-attempt, postmortem), `recall`, `reflect` (with a `response_schema` verdict), `list_memories`. |
| Database | SQLite tables `incidents`, `attempts`, `diagnoses`. History and attempts are imported from `data/` on first start. |
| Diagnosis | parse, then recall (plus reflect in parallel), evidence, reflect verdict, LLM format, then verification (attempt references, precedent rule, free-text scrub). |
| Demo | DEMO-A (Redis), DEMO-B (Kafka), DEMO-C (CDN) plus a follow-up on checkout-web. `reset_bank.py`, `learning_check.py`, `stream_diagnosis.py`. |

The INC-042 and INC-051 mismatch mentioned in the upgrade prompt was already fixed in Phase 1: the Redis precedents are INC-030 (12 Aug) and INC-037 (3 Sep), and live incidents start at INC-046.

## 2. Target flow

```
shortcut -> overlay opens immediately
         -> context: active window, authorized project, project logs, clipboard or selection, screen (vision, on request)
         -> Hindsight recall -> fix log evidence -> project inspection (config and code that past fixes touched)
         -> Hindsight reflect verdict -> diagnosis (Known / Likely / Unknown, Try first, Avoid, Check here)
         -> engineer acts in their editor -> Worked / Didn't work -> Resolve and learn -> Hindsight retain
         -> next similar incident recalls the new experience
```

## 3. Decisions and deviations (read before changing)

| Topic | Decision | Why |
| --- | --- | --- |
| Shortcut | `Ctrl+Space` by default, configurable with `ONCALL_SHORTCUT` in `.env` | The prompt asks for it. Warning: a global `Ctrl+Space` takes over VS Code's "Trigger Suggest" and some Windows input-method switching while the app runs. `Ctrl+Shift+Space` is the safe alternative. |
| "Hold" | The shortcut toggles the overlay (press to open, Escape or press again to close) | Electron global shortcuts fire on press only; there is no key-up event for global hotkeys. |
| Demo project language | `demo/nimbus-pay` keeps `payments-api` in Python with Helm values, not `redis/connectionPool.ts` | The 45 seeded incidents describe redis-py, `idempotency.py` and `REDIS_MAX_POOL` in Helm values. A TypeScript file would contradict the team's own memory. The agent finds `REDIS_MAX_POOL: "20"` in `deploy/helm/payments-api/values-prod.yaml`. |
| How "Check here" is found | Deterministic: the config identifiers that past fixes changed (for example `REDIS_MAX_POOL` in INC-030 and INC-037) are searched in the authorized project, and the current values are shown next to the historical changes | It is grounded and repeatable, it works without a vision model, and it can never point at a file that was not actually read. |
| Error context | Priority: clipboard or selection that looks like an error, then recent errors in the project's `logs/*.log`, then screen capture with a vision model (P1, on request only) | The first two are reliable and fast. Vision is useful but slow and rate-limited on the free tier. |
| IDE chat | No scraping of IDE chat databases. "Capture context" in the overlay takes selected or copied conversation text, which is then turned into a structured experience (P1) | The prompt forbids pretending to read private chats. |
| Project access | The desktop app asks (Allow once, Always allow, Cancel) through a native dialog, and the backend only reads inside registered roots, with path-traversal checks | Never scan arbitrary folders. |
| Memory graph | Built as the Memory page (P1). Earlier this was cut in PRD section 11; the 2.0 prompt explicitly asks for it | User decision. It is built from real data only. |
| Secrets | Every retain goes through a redaction filter first | Memory privacy. |

## 4. Stages

| Stage | Scope | Done when |
| --- | --- | --- |
| A | Demo project `demo/nimbus-pay` with a service simulator that reads the real config and writes real logs | Running the simulator with the pool at 20 and concurrency at 24 logs Redis errors; after the fix it logs healthy latency |
| B | Backend: `projects` table and API with scoped file access, a project context service (tree, search, read, log errors, git), an `inspect` step in the investigation, `findings` and `unknowns` in the diagnosis, secret redaction, a memory event log, and `POST /api/context/incident` | Tests pass; the streamed diagnosis for the demo project includes `REDIS_MAX_POOL` at the right file and line |
| C | Electron shell: main window plus overlay window, global shortcut, active-window detection, clipboard, project consent dialog, open file at line | The app starts, the shortcut opens the overlay, Escape closes it |
| D | Overlay UI: idle, context, recall, investigate, diagnosis, resolution and learning states, with Check here and Open File | The acceptance flow works in the overlay |
| E | Resolve and learn from the overlay, second-incident proof | The second incident's diagnosis cites the incident resolved minutes earlier |
| F (P1) | Screen capture with vision, Memory page, experience growth, conversation capture, system status | Each shows only real operations |

## 5. Status (2026-09-28)

| Stage | Result |
| --- | --- |
| A | Done. The simulator logs the real redis-py error at pool 20 and 24 workers, and logs healthy latency after the fix. |
| B | Done. 49 backend tests. The inspect step finds `REDIS_MAX_POOL: "20"` at `values-prod.yaml:19` with the INC-030 and INC-037 history. |
| C | Done. Electron 33 shell. `Control+Space` registered; the overlay opened in 109 ms. A key press could not be injected from the automation shell (it is not attached to the interactive desktop), so the physical shortcut still needs one manual check. |
| D | Done. All overlay states, verified in the browser and in Electron. |
| E | Done. Live run: resolve, retain (memory 225 to 228), then a second incident whose Try first and Check here cite the incident learned a minute earlier (INC-046). |
| F | Screen reading (vision endpoint and overlay button), Memory page with growth chart and Hindsight activity log, system status and Reset demo are done. The vision path has not been run live, to save free-tier requests. Conversation capture into a structured experience is not built yet. |

Known limits: active-window detection is Windows-only; git context is empty for the demo folder because the repository has no commits yet; "Open file" at a line needs the VS Code `code` command on PATH (present on the dev machine).

## 6. UI and memory upgrade (2026-09-29)

- Redesigned visual system (refined glass, pill buttons, segmented controls, iOS switch) within the section 9 palette and glass classes.
- Diagnosis sections shared by console and overlay (`frontend/src/components/DiagnosisSections.tsx`): Recall, Reflect, Retain lifecycle rail; "I remember this resolution" (only when a cited precedent has `learned_live`); Hindsight memory with successful fixes and failed approaches (`worked_fixes`, `failed_fixes`, from the attempts of recalled incidents at relevance 0.75 or more, and only citable ones once verified); Evidence with a source on every item; What to do next (open file, line, current value read from disk against the historical successful value, apply, verify).
- Resolve and learn in the overlay: Fix worked, Partially worked, Fix failed, Reverted (stored as a failed attempt with the note "Applied, then reverted."), plus outcome notes; worked or partial continues to a reviewable experience before retain.
- Hindsight down: context-only fallback with `memory_unavailable`, never a fabricated recall.
- Idempotent `POST /api/memory/seed`, `DEMO_TOOLS` flag, tagged `oncall.agent` logs, recently learned experiences on the Memory page.
- Kept deviation: the demo project stays Python and Helm (`REDIS_MAX_POOL`), not `redis/connectionPool.ts`, and the Redis precedents stay INC-030 and INC-037 (no INC-042 or INC-051 references), per section 3.

## 7. Overlay UX redesign (2026-09-29, later)

- Opening: the card pops in with a spring ("bubble") from the top-right corner on every shortcut press and plays a short close animation before the window hides (the main process sends `copilot:dismiss` instead of hiding immediately).
- Home: the orb (`frontend/src/components/Orb.tsx`, adapted from the user-supplied Plasma Ring WebGL component, using framer-motion instead of `motion/react`), a greeting, one card for an error found in the clipboard, project logs or screen, example questions, and one composer. Text that looks like an error is investigated; anything else is asked of team memory. A link switches the choice.
- Ask: `POST /api/memory/ask` runs Hindsight recall and reflect together. Every incident the answer names must be one that recall returned (`scrub_unverified_lines`), and each listed incident shows its recorded worked and failed fixes.
- Results: a short headline and summary, then three tabs (Fix, Past incidents, Why) instead of one long scroll. The console uses the same tabs.
- Outcome: one row of buttons (Worked, Partly, Didn't work, Reverted) opens a bottom sheet; worked or partly continues to a reviewable experience before retain.
- An open incident survives pressing the shortcut again, so the engineer can switch to the editor, apply the fix and come back to record the outcome. "New" starts over.
- Mic: Windows' offline System.Speech dictation in the main process (`desktop/src/voice.ts`), only while the mic button is on. The transcript goes into the composer for editing; the live microphone level drives the orb. In a plain browser the Web Speech API is used when available; otherwise the button is hidden. Cloud transcription through OpenRouter was tested and rejected: audio input needs a paid balance (402), and the other free audio models are gated (403).

## 8. Fullscreen blur, screen reading and IDE detection (2026-09-29, latest)

- The overlay window now covers the display with Windows 11 acrylic (`backgroundMaterial: "acrylic"`, opaque window: a transparent one only shows flat grey) plus a dark tint, and the card is centered and smaller (420 px, 500 px for results). It fades in and out at the window level; clicking outside the card or Escape closes it.
- First screen: "Want me to read your screen?" with the IDE, folder and file detected from the foreground window. Yes runs the native folder consent dialog when the detected folder is not authorized yet, then reads the screen while colour waves run around the four display edges.
- Screen reading (`desktop/src/screenRead.ts`): one `desktopCapturer` capture with the overlay excluded through `setContentProtection(true)` for about 200 ms (verified: the overlay's text never appears in the reading, and it is visible to screen recorders the rest of the time), then Windows' built-in OCR (`Windows.Media.Ocr`, offline), then the error lines are extracted and OCR token splits are repaired. The image is deleted immediately. Measured 2.1 s end to end. The cloud vision models were dropped from this path: in testing the free ones were overloaded (502) or rate limited (429).
- IDE detection (`desktop/src/ide.ts`): VS Code family (VS Code, Cursor, Windsurf, Antigravity, VSCodium, Trae, Kiro, Void) via `User/workspaceStorage/*/workspace.json`, JetBrains via `options/recentProjects.xml`; the folder name from the title is matched to a recorded folder, most recently used first. Nothing inside the folder is read before consent.
- If the screen shows no error, the overlay offers recent project log errors or the clipboard, otherwise the composer.
