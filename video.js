// Renders the FRIDAY explainer video (video.mp4, about 2.5 minutes) with no extra dependencies:
//   1. narration: each script line is spoken by a built-in Windows voice (video/tts.ps1) and timed from its WAV;
//   2. picture: video/scene.html draws every frame deterministically for a time t (HTML, SVG and Canvas plus real
//      captures of the FRIDAY UI in video/assets), driven frame by frame in headless Edge over the DevTools protocol;
//   3. ffmpeg encodes the frames, the narration and a quiet synthesized pad into video.mp4.
// Usage: node video.js            full render
//        node video.js --problem  the problem-statement video (video/problem.html, silent, timed by word count) -> problem.mp4
//        node video.js --preview  every 6th frame at 5 fps, for a quick look (video-preview.mp4)
//        node video.js --still 42 one frame at t = 42 s (video-still.png)
"use strict";
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = __dirname;
const DIR = path.join(ROOT, "video");
const BUILD = path.join(DIR, "build");
const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
const INTRO = 4.2; // seconds of title before the first line
const GAP = 0.5; // pause between lines
const SECTION_GAP = 1.8; // pause between the two speakers
const OUTRO = 5.0;
const VOICES = { workflow: { voice: "Microsoft Mark", rate: 0.98 }, architecture: { voice: "Microsoft Zira", rate: 1.0 } };

// Each line: what the voice says (say) and what the caption shows (text). Scenes in scene.html key off the ids.
const SCRIPT = [
  ["workflow", "w1", "Here's how FRIDAY works."],
  ["workflow", "w2", "We connect FRIDAY to our IDE, like VS Code or Antigravity."],
  ["workflow", "w3", "When an error occurs, we simply press Ctrl + Space.", "When an error occurs, we simply press Control plus Space."],
  ["workflow", "w4", "FRIDAY opens as a small popup, where we can ask a question using voice or text."],
  ["workflow", "w5", "FRIDAY understands the current error and retrieves similar incidents from its memory."],
  ["workflow", "w6", "It shows us what worked before, what failed, and the solution that actually fixed the problem."],
  ["workflow", "w7", "It can also point us to the exact file and line where we need to make the change."],
  ["workflow", "w8", "We apply the fix, and once the issue is solved, we click Resolve & Learn.", "We apply the fix, and once the issue is solved, we click Resolve and Learn."],
  ["workflow", "w9", "FRIDAY saves that experience back into memory."],
  ["workflow", "w10", "So the next time the same problem happens, FRIDAY already knows what to do."],
  ["workflow", "w11", "Fix it once. Remember it forever."],
  ["architecture", "a1", "Now, let's look at how FRIDAY works behind the scenes."],
  ["architecture", "a2", "FRIDAY is a desktop application that connects with the developer's IDE and project."],
  ["architecture", "a3", "When we trigger FRIDAY, it collects the relevant context, like the current error, code, and project information."],
  ["architecture", "a4", "That context goes to our AI layer, which works with Hindsight as the long-term engineering memory."],
  ["architecture", "a5", "Hindsight stores previous incidents, successful fixes, failed attempts, and lessons learned."],
  ["architecture", "a6", "FRIDAY retrieves the most relevant memories and combines them with the current project context."],
  ["architecture", "a7", "It then generates a solution and points the developer to the relevant code."],
  ["architecture", "a8", "After the developer confirms the fix, FRIDAY sends the outcome back to Hindsight."],
  ["architecture", "a9", "This creates a continuous learning loop:"],
  ["architecture", "a10", "Recall → Understand → Fix → Retain.", "Recall. Understand. Fix. Retain."],
  ["architecture", "a11", "So FRIDAY doesn't just answer questions."],
  ["architecture", "a12", "It builds a memory of how your team engineers."],
].map(([speaker, id, text, say]) => ({ speaker, id, text, say: (say ?? text).replace(/FRIDAY/g, "Friday") }));

// The problem-statement video: no narration track (the team records its own voice), so each line lasts as long as it
// takes to say at a relaxed pace.
const PROBLEM = [
  ["p1", "At 2 AM, production breaks."],
  ["p2", "An engineer sees an error, opens logs, searches old Slack messages, checks documentation, and tries to remember how the team solved something similar months ago."],
  ["p3", "The problem is that engineering knowledge is scattered and forgotten."],
  ["p4", "Past incidents, failed fixes, successful solutions, code changes, and postmortems contain valuable experience, but when the same problem happens again, engineers often start from zero."],
  ["p5", "Existing AI coding assistants can explain the error in front of you, but they don't truly understand what your team has already learned."],
  ["p6", "That creates a critical gap:"],
  ["p7", "The organization has memory, but the engineer can't access it when they need it most."],
  ["p8", "This is the problem we are solving with FRIDAY."],
  ["p9", "FRIDAY is an AI engineering agent that can understand the engineer's current screen, search the team's accumulated experience, inspect the actual codebase, and provide an answer based on what has worked, and what has failed, before."],
  ["p10", "And when the engineer solves a new problem, FRIDAY remembers that experience for the next incident."],
].map(([id, text]) => ({ speaker: "problem", id, text }));
const WORDS_PER_SECOND = 2.55;
const MODE = process.argv.includes("--problem")
  ? { script: PROBLEM, scene: "problem.html", out: "problem", audio: false, intro: 1.2 }
  : { script: SCRIPT, scene: "scene.html", out: "video", audio: true, intro: INTRO };

/** Silent mode: each line lasts its word count at a speaking pace. */
function timeByWords() {
  let t = MODE.intro;
  for (const line of MODE.script) {
    line.start = +t.toFixed(3);
    line.end = +(t + line.text.split(/\s+/).length / WORDS_PER_SECOND + 0.3).toFixed(3);
    t = line.end + 0.7;
  }
  return +(t - 0.7 + OUTRO).toFixed(3);
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${cmd} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

/** WAV length in seconds, from the header's byte rate and data chunk size. */
function wavSeconds(file) {
  const buf = fs.readFileSync(file);
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") byteRate = buf.readUInt32LE(offset + 16);
    if (id === "data") return size / byteRate;
    offset += 8 + size + (size % 2);
  }
  throw new Error(`No audio data in ${file}`);
}

/** Speaks every line once; cached by voice and text, so re-renders are fast. */
function narrate() {
  const dir = path.join(BUILD, "voice");
  fs.mkdirSync(dir, { recursive: true });
  const jobs = [];
  for (const line of SCRIPT) {
    const { voice, rate } = VOICES[line.speaker];
    const key = createHash("sha1").update(`${voice}|${rate}|${line.say}`).digest("hex").slice(0, 10);
    line.wav = path.join(dir, `${line.id}-${key}.wav`);
    if (!fs.existsSync(line.wav)) jobs.push({ voice, rate, text: line.say, out: line.wav });
  }
  if (jobs.length) {
    console.log(`Narrating ${jobs.length} line(s)...`);
    const jobFile = path.join(BUILD, "tts-jobs.json");
    fs.writeFileSync(jobFile, JSON.stringify(jobs), "utf-8");
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(DIR, "tts.ps1"), "-Jobs", jobFile]);
  }
  let t = INTRO;
  let speaker = SCRIPT[0].speaker;
  for (const line of SCRIPT) {
    if (line.speaker !== speaker) {
      t += SECTION_GAP;
      speaker = line.speaker;
    }
    line.start = +t.toFixed(3);
    line.end = +(t + wavSeconds(line.wav)).toFixed(3);
    t = line.end + GAP;
  }
  return +(t - GAP + OUTRO).toFixed(3);
}

/** Narration placed at each line's start, over a quiet synthesized pad that fades in and out. */
function mixAudio(total) {
  const out = path.join(BUILD, "audio.wav");
  const inputs = SCRIPT.flatMap((l) => ["-i", l.wav]);
  const delays = SCRIPT.map((l, i) => `[${i}:a]aresample=48000,aformat=channel_layouts=mono,adelay=${Math.round(l.start * 1000)}[v${i}]`);
  const voices = SCRIPT.map((_, i) => `[v${i}]`).join("");
  const n = SCRIPT.length;
  const pad =
    `aevalsrc='0.030*sin(2*PI*110*t)*(0.6+0.4*sin(2*PI*0.07*t))+0.022*sin(2*PI*164.81*t)*(0.6+0.4*sin(2*PI*0.05*t+1))` +
    `+0.018*sin(2*PI*220*t)*(0.5+0.5*sin(2*PI*0.09*t+2))+0.012*sin(2*PI*329.63*t)*(0.5+0.5*sin(2*PI*0.04*t+3))'` +
    `:s=48000:d=${total},lowpass=f=900,afade=t=in:d=3,afade=t=out:st=${Math.max(0, total - 4)}:d=4[pad]`;
  const filter = `${delays.join(";")};${voices}amix=inputs=${n}:normalize=0:duration=longest,apad=whole_dur=${total}[voice];${pad};` +
    `[voice][pad]amix=inputs=2:normalize=0:duration=first,volume=1.6,alimiter=limit=0.95[out]`;
  run("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filter, "-map", "[out]", "-ac", "2", "-t", String(total), out]);
  return out;
}

function findEdge() {
  const candidates = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error("Microsoft Edge or Google Chrome is needed to draw the frames.");
  return found;
}

/** A minimal DevTools protocol client over Node's built-in WebSocket. */
async function devtools(browserPath) {
  const port = 9600 + Math.floor(Math.random() * 300);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "friday-video-"));
  const proc = spawn(browserPath, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--hide-scrollbars", "--mute-audio",
    "--force-device-scale-factor=1", "--allow-file-access-from-files", `--window-size=${WIDTH},${HEIGHT}`,
    // A headless page is never on screen; without these the browser eventually throttles it and stops producing frames.
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--disable-features=CalculateNativeWinOcclusion", "about:blank",
  ], { stdio: "ignore" });
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === "page");
    } catch {
      // the browser is still starting
    }
  }
  if (!target) throw new Error("The headless browser did not start.");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const waiter = msg.id !== undefined ? pending.get(msg.id) : null;
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message));
    else waiter.resolve(msg.result);
  };
  const send = (method, params = {}, timeoutMs = 20000) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => {
        pending.delete(n);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(n, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const close = () => {
    try {
      ws.close();
    } catch {}
    proc.kill();
    setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 800);
  };
  return { send, close };
}

async function openScene(timeline) {
  const html = fs.readFileSync(path.join(DIR, MODE.scene), "utf-8").replace("/*TIMELINE*/null", JSON.stringify(timeline));
  const page = path.join(DIR, "scene.build.html");
  fs.writeFileSync(page, html, "utf-8");
  const cdp = await devtools(findEdge());
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: pathToFileURL(page).href });
  for (let i = 0; i < 200; i++) {
    const ready = await cdp.send("Runtime.evaluate", { expression: "window.__ready === true", returnByValue: true });
    if (ready.result.value) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const failed = await cdp.send("Runtime.evaluate", { expression: "window.__error || ''", returnByValue: true });
  if (failed.result.value) throw new Error(`scene.html: ${failed.result.value}`);
  return cdp;
}

async function frameAt(cdp, t, format = "jpeg") {
  const rendered = await cdp.send("Runtime.evaluate", { expression: `render(${t.toFixed(4)})`, returnByValue: true });
  if (rendered.exceptionDetails) throw new Error(`render(${t}) failed: ${rendered.exceptionDetails.exception?.description}`);
  // A capture that stalls is retried after bringing the page forward, rather than hanging the render.
  for (let attempt = 1; ; attempt++) {
    try {
      const shot = await cdp.send("Page.captureScreenshot", { format, quality: format === "jpeg" ? 93 : undefined, optimizeForSpeed: true }, 5000);
      return Buffer.from(shot.data, "base64");
    } catch (err) {
      if (attempt >= 4) throw err;
      process.stdout.write(`\n  capture at t=${t.toFixed(2)} stalled, retrying\n`);
      await cdp.send("Page.bringToFront").catch(() => undefined);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  fs.mkdirSync(BUILD, { recursive: true });
  const total = MODE.audio ? narrate() : timeByWords();
  const timeline = { fps: FPS, total, lines: MODE.script.map(({ speaker, id, text, start, end }) => ({ speaker, id, text, start, end })) };
  console.log(`Timeline: ${total.toFixed(1)} s, ${MODE.script.length} lines`);

  if (args[0] === "--bench") {
    const cdp = await openScene(timeline);
    for (const t of (args[1] ? args[1].split(",").map(Number) : [2, 20, 35, 50, 62, 75, 95, 120])) {
      const started = Date.now();
      for (let i = 0; i < 5; i++) await frameAt(cdp, t + i / FPS);
      console.log(`t=${t}s  ${((Date.now() - started) / 5).toFixed(0)} ms/frame`);
    }
    cdp.close();
    return;
  }

  if (args[0] === "--still") {
    const cdp = await openScene(timeline);
    fs.writeFileSync(path.join(ROOT, "video-still.png"), await frameAt(cdp, Number(args[1] ?? 10), "png"));
    cdp.close();
    console.log("Wrote video-still.png");
    return;
  }

  const preview = args[0] === "--preview";
  const step = preview ? 6 : 1;
  const outFps = FPS / step;
  const audio = MODE.audio ? mixAudio(total) : null;
  const output = path.join(ROOT, `${MODE.out}${preview ? "-preview" : ""}.mp4`);
  const ffmpeg = spawn("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(outFps), "-c:v", "mjpeg", "-i", "-", ...(audio ? ["-i", audio] : []),
    "-c:v", "libx264", "-preset", preview ? "veryfast" : "slow", "-crf", preview ? "26" : "17", "-pix_fmt", "yuv420p",
    "-r", String(outFps), ...(audio ? ["-c:a", "aac", "-b:a", "192k", "-shortest"] : ["-an"]), "-movflags", "+faststart", output,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  const encoded = new Promise((resolve, reject) => ffmpeg.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`)))));

  const cdp = await openScene(timeline);
  const frames = Math.ceil(total * FPS);
  const started = Date.now();
  try {
    for (let f = 0; f < frames; f += step) {
      const jpeg = await frameAt(cdp, f / FPS);
      if (!ffmpeg.stdin.write(jpeg)) await new Promise((r) => ffmpeg.stdin.once("drain", r));
      if (f % (FPS * 5) < step) {
        const done = f / frames;
        const eta = done > 0 ? ((Date.now() - started) / done - (Date.now() - started)) / 1000 : 0;
        process.stdout.write(`\r  frame ${f}/${frames}  ${(done * 100).toFixed(0)}%  about ${Math.round(eta)} s left   `);
      }
    }
  } finally {
    cdp.close();
    ffmpeg.stdin.end();
  }
  await encoded;
  console.log(`\nWrote ${path.relative(ROOT, output)} (${total.toFixed(1)} s) in ${Math.round((Date.now() - started) / 1000)} s`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
