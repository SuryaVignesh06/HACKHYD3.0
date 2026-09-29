// "Read my screen": one capture of the display, taken only after the engineer says yes, read on this computer with
// Windows' built-in OCR (Windows.Media.Ocr). The overlay excludes itself from that one capture, the image is
// deleted as soon as it has been read, and only the error lines are handed back to the overlay.
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopCapturer, screen, type BrowserWindow } from "electron";

export interface ScreenReading {
  ok: boolean;
  found: boolean;
  text: string; // the error lines, most important first
  lineCount: number; // lines of text recognised on screen
  ms: number;
  message?: string;
}

const OCR_SCRIPT = `
param([string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { [Console]::Out.WriteLine('OCR_UNAVAILABLE'); exit 2 }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$stream.Dispose()
[Console]::OutputEncoding = [Text.Encoding]::UTF8
foreach ($line in $result.Lines) { [Console]::Out.WriteLine($line.Text) }
`;

const ERROR_LINE =
  /(\b[\w.]*(Error|Exception)\b|Traceback|\bFATAL\b|\bERROR\b|\bCRITICAL\b|panic:|\bfailed\b|Too many connections|timed out|timeout|refused|denied|OOMKilled|x509|\bSEV[123]\b|\[FIRING\])/i;
const CONTEXT_LINE = /^(File\s|at\s|line\s\d+|in\s\w+|raise\s|Caused by|\s)|(\.py|\.ts|\.js|\.go|\.java)\b.*\bline\b/i;
const MAX_LINES = 20;

/** OCR splits code tokens ("get _ idempotency _ key", "values-prod . yaml", "4. 2s"); join them back. */
export function normalise(line: string): string {
  return line
    .replace(/Ø/g, "0")
    .replace(/(\w)\s+_\s+(?=\w)/g, "$1_")
    .replace(/(\w)\s+\.\s+(?=[A-Za-z])/g, "$1.")
    .replace(/(\w)\.\s+(?=[a-z_])/g, "$1.")
    .replace(/(\d)\.\s+(?=\d)/g, "$1.")
    .replace(/(\d)\s*:\s*(?=\d)/g, "$1:")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** The error block on screen: every line that reads like an error, plus the stack lines right after it. */
export function extractErrors(lines: string[]): string[] {
  const picked: string[] = [];
  const clean = lines.map(normalise).filter(Boolean);
  for (let i = 0; i < clean.length && picked.length < MAX_LINES; i++) {
    const line = clean[i]!;
    if (!ERROR_LINE.test(line) || line.length < 12) continue;
    if (!picked.includes(line)) picked.push(line);
    for (let j = i + 1; j < Math.min(clean.length, i + 4); j++) {
      const next = clean[j]!;
      if (!CONTEXT_LINE.test(next) && !ERROR_LINE.test(next)) break;
      if (!picked.includes(next)) picked.push(next);
      i = j;
    }
  }
  return picked.slice(0, MAX_LINES);
}

function runOcr(imagePath: string): Promise<string[]> {
  const scriptPath = join(tmpdir(), "oncall-copilot-ocr.ps1");
  writeFileSync(scriptPath, OCR_SCRIPT, "utf-8");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Path", imagePath], {
      windowsHide: true,
    });
    let out = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (out.includes("OCR_UNAVAILABLE")) reject(new Error("Windows OCR has no language pack for your display language."));
      else if (code !== 0) reject(new Error("Windows OCR could not read the capture."));
      else resolve(out.split(/\r?\n/));
    });
  });
}

export async function readScreen(overlay: BrowserWindow | null): Promise<ScreenReading> {
  const started = Date.now();
  if (process.platform !== "win32") {
    return { ok: false, found: false, text: "", lineCount: 0, ms: 0, message: "Screen reading uses Windows OCR and is only available on Windows." };
  }
  const display = overlay ? screen.getDisplayMatching(overlay.getBounds()) : screen.getPrimaryDisplay();
  const imagePath = join(tmpdir(), `oncall-copilot-screen-${Date.now()}.png`);
  try {
    // Exclude the overlay from this one capture so the agent reads the engineer's screen, not its own card.
    overlay?.setContentProtection(true);
    await new Promise((resolve) => setTimeout(resolve, 180));
    const scale = display.scaleFactor || 1;
    const width = Math.min(4000, Math.round(display.size.width * scale));
    const height = Math.round((display.size.height / display.size.width) * width);
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height } });
    overlay?.setContentProtection(false);
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) {
      return { ok: false, found: false, text: "", lineCount: 0, ms: Date.now() - started, message: "No screen was available to capture." };
    }
    writeFileSync(imagePath, source.thumbnail.toPNG());
    const lines = (await runOcr(imagePath)).map((l) => l.trim()).filter(Boolean);
    const errors = extractErrors(lines);
    return { ok: true, found: errors.length > 0, text: errors.join("\n"), lineCount: lines.length, ms: Date.now() - started };
  } catch (exc) {
    return { ok: false, found: false, text: "", lineCount: 0, ms: Date.now() - started, message: exc instanceof Error ? exc.message : "Screen reading failed." };
  } finally {
    overlay?.setContentProtection(false);
    rmSync(imagePath, { force: true });
  }
}
