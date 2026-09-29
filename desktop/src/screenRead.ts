// Screen reading for FRIDAY: capture the display, read it with Windows' built-in OCR (Windows.Media.Ocr) on this
// computer, and keep only the lines that look like an error. FRIDAY's own windows are excluded from the capture
// (content protection), each frame is written to a temp file only for the OCR call and deleted straight after, and
// nothing leaves the machine except the error lines the engineer then investigates.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopCapturer, type Display } from "electron";

export interface ScreenText {
  lines: string[]; // every line OCR recognised, top to bottom
  errors: string[]; // the error block(s), most important first
  fingerprint: string | null; // stable identity of the main error across frames
  ms: number;
}

// A long-lived OCR worker: starting PowerShell and loading WinRT per frame costs ~0.8 s, so one process reads
// image paths from stdin and answers each with "L <line>" rows and a closing "END".
const OCR_WORKER = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Say([string]$line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
  function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
} catch {
  Say ('FATAL ' + $_.Exception.Message); exit 1
}
if ($null -eq $engine) { Say 'FATAL Windows OCR has no language pack for your display language.'; exit 2 }
Say 'READY'
while ($true) {
  $path = [Console]::In.ReadLine()
  if ($null -eq $path) { break }
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $stream.Dispose()
    foreach ($line in $result.Lines) { [Console]::Out.WriteLine('L ' + $line.Text) }
    Say 'END'
  } catch {
    Say ('ERR ' + $_.Exception.Message)
    Say 'END'
  }
}
`;

// Strong signals: an exception class, a log level, a crash marker. Case-sensitive on purpose, so prose that merely
// mentions "an error" is not treated as one.
const STRONG = [
  /\b[A-Z][A-Za-z0-9]*(Error|Exception)\b/,
  /\b(Error|Exception|ERROR|FATAL|CRITICAL|PANIC|SEVERE)\b\s*[:\]!]/,
  /(^|\s)(ERROR|FATAL|CRITICAL)\s/,
  /Traceback \(most recent call last\)/,
  /\bpanic:/,
  /\bOOMKilled\b/,
  /\bx509:/,
  /\[FIRING\]/,
  /\bE(CONNREFUSED|CONNRESET|TIMEDOUT|ADDRINUSE|ACCES|NOTFOUND)\b/,
  /\bnpm ERR!/,
  /\bUncaught\b/,
  /Segmentation fault/,
  /\bFAILED\b/,
  /\b(Build|Compilation|Command) failed\b/i,
  /Too many connections/,
  /Connection refused/,
  /Permission denied/,
];
const CONTEXT = /^(File\s"|at\s|raise\s|Caused by|\.\.\.\s\d+\smore)|\.(py|ts|tsx|js|jsx|go|java|rb|rs|cs|kt)(:\d+|",\sline\s\d+)|\bline\s\d+,\sin\s/;
const MAX_ERROR_LINES = 20;
const MAX_LINE_CHARS = 300;

/** OCR splits code tokens ("get _ idempotency _ key", "values-prod . yaml", "4. 2s"); join them back. */
export function normalise(line: string): string {
  return line
    .replace(/Ø/g, "0")
    .replace(/(?<=[\d:+T-])@|@(?=[\d:+-])/g, "0") // terminal fonts: OCR reads a slashed zero as "@"
    .replace(/(\w)\s+_\s+(?=\w)/g, "$1_")
    .replace(/(\w)\s+\.\s+(?=[A-Za-z])/g, "$1.")
    .replace(/(\w)\.\s+(?=[a-z_])/g, "$1.")
    .replace(/(\d)\.\s+(?=\d)/g, "$1.")
    .replace(/(\d)\s*:\s*(?=\d)/g, "$1:")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export const isErrorLine = (line: string): boolean => line.length >= 8 && line.length <= MAX_LINE_CHARS && STRONG.some((re) => re.test(line));

/** The error block on screen: every line that reads like an error, plus the stack lines right after it. */
export function extractErrors(lines: string[]): string[] {
  const picked: string[] = [];
  const clean = lines.map(normalise).filter(Boolean);
  for (let i = 0; i < clean.length && picked.length < MAX_ERROR_LINES; i++) {
    const line = clean[i]!;
    if (!isErrorLine(line)) continue;
    if (!picked.includes(line)) picked.push(line);
    for (let j = i + 1; j < Math.min(clean.length, i + 5); j++) {
      const next = clean[j]!;
      if (!CONTEXT.test(next) && !isErrorLine(next)) break;
      if (!picked.includes(next)) picked.push(next);
      i = j;
    }
  }
  return picked.slice(0, MAX_ERROR_LINES);
}

/**
 * The identity of the error, stable across frames: the exception class and message (or the first error line) with
 * timestamps, numbers and worker names removed, so the same failure scrolling in a terminal is one error.
 */
export function fingerprint(errors: string[]): string | null {
  const first = errors.find(isErrorLine);
  if (!first) return null;
  // The first exception class anywhere in the block: OCR sometimes breaks a long log line in two, and the message
  // after the class is often cut at the terminal's edge, differently on every line.
  for (const line of errors) {
    const klass = /[A-Za-z_.]*[A-Z][A-Za-z0-9]*(Error|Exception)\b/.exec(line);
    if (klass && klass[0].length > 8) return klass[0].toLowerCase();
  }
  const core = first
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?/g, "")
    .replace(/\b(worker|pod|thread|req|request)[-_ ]?[\w-]*\d[\w-]*/gi, "$1")
    .replace(/\d+/g, "#");
  return core.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 140) || null;
}

let worker: ChildProcessWithoutNullStreams | null = null;
let workerReady: Promise<void> | null = null;
let pending: { resolve: (lines: string[]) => void; reject: (e: Error) => void; lines: string[]; error: string | null } | null = null;
let queue: Promise<unknown> = Promise.resolve();

function startWorker(): Promise<void> {
  if (workerReady) return workerReady;
  workerReady = new Promise<void>((resolve, reject) => {
    const scriptPath = join(tmpdir(), "friday-ocr-worker.ps1");
    writeFileSync(scriptPath, OCR_WORKER, "utf-8");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], { windowsHide: true });
    worker = child;
    let buffer = "";
    let ready = false;
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line === "READY") {
          ready = true;
          resolve();
        } else if (line.startsWith("FATAL ")) {
          reject(new Error(line.slice(6)));
        } else if (pending && line.startsWith("L ")) {
          pending.lines.push(line.slice(2));
        } else if (pending && line.startsWith("ERR ")) {
          pending.error = line.slice(4);
        } else if (pending && line === "END") {
          const done = pending;
          pending = null;
          if (done.error) done.reject(new Error(`Windows OCR could not read the capture: ${done.error}`));
          else done.resolve(done.lines);
        }
      }
    });
    const fail = (message: string) => {
      worker = null;
      workerReady = null;
      if (!ready) reject(new Error(message));
      if (pending) {
        pending.reject(new Error(message));
        pending = null;
      }
    };
    child.on("error", () => fail("Could not start Windows OCR."));
    child.on("exit", () => fail("Windows OCR stopped unexpectedly."));
  });
  return workerReady;
}

function ocr(imagePath: string): Promise<string[]> {
  // One frame at a time: the worker answers requests in order.
  const run = queue.then(async () => {
    await startWorker();
    if (!worker) throw new Error("Windows OCR is not running.");
    const child = worker;
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending = null;
        child.kill(); // a stuck OCR call restarts the worker on the next frame
        reject(new Error("Windows OCR timed out."));
      }, 15_000);
      pending = {
        resolve: (lines) => {
          clearTimeout(timer);
          resolve(lines);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        lines: [],
        error: null,
      };
      child.stdin.write(`${imagePath}\n`);
    });
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Warm the OCR worker so the first real read is fast. */
export function warmOcr(): void {
  if (process.platform === "win32") void startWorker().catch(() => undefined);
}

export function stopOcr(): void {
  worker?.kill();
  worker = null;
  workerReady = null;
}

/** Captures one display (FRIDAY's windows excluded by the caller's content protection) and reads its text. */
export async function readDisplay(display: Display): Promise<ScreenText> {
  if (process.platform !== "win32") throw new Error("Screen reading uses Windows OCR and is only available on Windows.");
  const started = Date.now();
  const scale = display.scaleFactor || 1;
  const width = Math.min(3200, Math.round(display.size.width * scale));
  const height = Math.round((display.size.height / display.size.width) * width);
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height } });
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error("No screen was available to capture.");
  const imagePath = join(tmpdir(), `friday-frame-${process.pid}-${Date.now()}.png`);
  try {
    writeFileSync(imagePath, source.thumbnail.toPNG());
    const lines = (await ocr(imagePath)).map((l) => l.trim()).filter(Boolean);
    const errors = extractErrors(lines);
    return { lines, errors, fingerprint: fingerprint(errors), ms: Date.now() - started };
  } finally {
    rmSync(imagePath, { force: true });
  }
}
