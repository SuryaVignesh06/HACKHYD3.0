// Voice input for the overlay's mic button: Windows' built-in offline speech recognition (System.Speech),
// run in a short-lived PowerShell process only while the engineer holds the mic open. Audio never leaves the
// machine and nothing is recorded to disk. The transcript goes into the composer for the engineer to edit.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type VoiceEvent =
  | { type: "ready" }
  | { type: "level"; value: number } // 0..100 microphone level, drives the orb
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "error"; message: string }
  | { type: "done" };

const MAX_SECONDS = 60;

const SCRIPT = `
param([string]$StopFile, [int]$MaxSeconds)
$ErrorActionPreference = 'Stop'
function Say([string]$line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }
try {
  Add-Type -AssemblyName System.Speech
  $culture = [System.Globalization.CultureInfo]::new('en-US')
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($culture)
  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $engine.SetInputToDefaultAudioDevice()
} catch {
  Say ('ERROR ' + $_.Exception.Message)
  exit 1
}
Register-ObjectEvent -InputObject $engine -EventName SpeechRecognized -SourceIdentifier final | Out-Null
Register-ObjectEvent -InputObject $engine -EventName SpeechHypothesized -SourceIdentifier partial | Out-Null
Register-ObjectEvent -InputObject $engine -EventName AudioLevelUpdated -SourceIdentifier level | Out-Null
$engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
Say 'READY'
$deadline = (Get-Date).AddSeconds($MaxSeconds)
$stopping = $null
while ($true) {
  foreach ($ev in @(Get-Event)) {
    switch ($ev.SourceIdentifier) {
      'final'   { Say ('FINAL ' + $ev.SourceEventArgs.Result.Text) }
      'partial' { Say ('PARTIAL ' + $ev.SourceEventArgs.Result.Text) }
      'level'   { Say ('LEVEL ' + $ev.SourceEventArgs.AudioLevel) }
    }
    Remove-Event -EventIdentifier $ev.EventIdentifier
  }
  if ($null -eq $stopping -and ((Test-Path $StopFile) -or (Get-Date) -gt $deadline)) {
    $engine.RecognizeAsyncStop()
    $stopping = (Get-Date).AddMilliseconds(900)
  }
  if ($null -ne $stopping -and (Get-Date) -gt $stopping) { break }
  Start-Sleep -Milliseconds 50
}
$engine.Dispose()
Say 'DONE'
`;

let proc: ChildProcessWithoutNullStreams | null = null;
let stopFile = "";

export function voiceSupported(): boolean {
  return process.platform === "win32";
}

export function startVoice(onEvent: (event: VoiceEvent) => void): { ok: boolean; message: string } {
  if (!voiceSupported()) return { ok: false, message: "Voice input uses Windows speech recognition and is only available on Windows." };
  if (proc) return { ok: false, message: "The microphone is already listening." };
  const scriptPath = join(tmpdir(), "oncall-copilot-voice.ps1");
  writeFileSync(scriptPath, SCRIPT, "utf-8");
  stopFile = join(tmpdir(), `oncall-copilot-voice-stop-${Date.now()}`);
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-StopFile", stopFile, "-MaxSeconds", String(MAX_SECONDS)],
    { windowsHide: true },
  );
  proc = child;
  let buffer = "";
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    proc = null;
    if (existsSync(stopFile)) rmSync(stopFile, { force: true });
    onEvent({ type: "done" });
  };
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line === "READY") onEvent({ type: "ready" });
      else if (line === "DONE") finish();
      else if (line.startsWith("LEVEL ")) onEvent({ type: "level", value: Number(line.slice(6)) || 0 });
      else if (line.startsWith("PARTIAL ")) onEvent({ type: "partial", text: line.slice(8) });
      else if (line.startsWith("FINAL ")) onEvent({ type: "final", text: line.slice(6) });
      else if (line.startsWith("ERROR ")) onEvent({ type: "error", message: `Microphone unavailable: ${line.slice(6)}` });
    }
  });
  child.on("error", () => {
    onEvent({ type: "error", message: "Could not start Windows speech recognition." });
    finish();
  });
  child.on("exit", finish);
  return { ok: true, message: "Listening" };
}

/** Asks the recognizer to finish the current phrase and stop; the process exits on its own shortly after. */
export function stopVoice(): void {
  if (!proc || !stopFile) return;
  writeFileSync(stopFile, "stop", "utf-8");
  const child = proc;
  setTimeout(() => {
    if (proc === child) child.kill();
  }, 4000);
}
