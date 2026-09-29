// The overlay's orb: a WebGL wireframe sphere with a travelling wave and a Fresnel rim.
// Adapted from "Plasma Ring" by Originkit (supplied by the user), rewritten for framer-motion, a fixed size,
// a transparent background and live state props (colors, speed, wave and a microphone level).
import { useEffect, useRef } from "react";
import { animate, motionValue } from "framer-motion";

const DPR_CAP = 1.5;
const FOV_DEG = 42;
const TAU = Math.PI * 2;
const MAX_COLORS = 5;
const RADIUS = 280;
const TILT = 20;
const RIM_POWER = 3;
const WAVE_LENGTH = 200;
const WAVE_DIRECTION = 45;
const HOVER_RADIUS = 35;
const HOVER_PUSH = 90;
const ORBIT_DAMPING = 50;
const CAM_FAR = 2100;
const CAM_PER_SCALE = 15;

const VERT = `
precision highp float;
attribute vec2 aPolar;
attribute vec2 aRnd;
uniform vec2  uRes;
uniform float uFocal;
uniform float uTime;
uniform float uRadius;
uniform float uWaveHeight;
uniform float uWaveLength;
uniform float uWaveSpeed;
uniform vec2  uWaveDir;
uniform float uCamDist;
uniform float uCamYaw;
uniform float uCamPitch;
uniform float uTilt;
uniform float uRimPower;
uniform float uCenter;
uniform float uColorCount;
uniform vec3  uColors[${MAX_COLORS}];
uniform vec3  uHotspot;
uniform vec3  uCamDir;
uniform vec3  uHoverDir;
uniform float uHoverRadius;
uniform float uHoverPush;
uniform float uHoverActive;
varying vec3  vCol;
varying float vAlpha;

vec3 rampColor(float x) {
  float p  = clamp(x, 0.0, 1.0) * max(uColorCount - 1.0, 0.0);
  float i0 = floor(p);
  float f  = p - i0;
  vec3 a = uColors[0];
  vec3 b = uColors[0];
  for (int i = 0; i < ${MAX_COLORS}; i++) {
    if (float(i) == i0)       a = uColors[i];
    if (float(i) == i0 + 1.0) b = uColors[i];
  }
  return mix(a, b, f);
}

void main() {
  float phi = aPolar.x;
  float theta = aPolar.y;
  float sp = sin(phi); float cp2 = cos(phi);
  float st = sin(theta); float ct = cos(theta);
  vec3 norm = vec3(cp2 * ct, sp, cp2 * st);
  vec3 pos  = norm * uRadius;

  float wFreq = 6.2831853 / max(100.0, uWaveLength);
  float proj1 = norm.x * uWaveDir.x + norm.z * uWaveDir.y;
  float proj2 = norm.x * uWaveDir.y - norm.z * uWaveDir.x;
  float ts = uTime * (uWaveSpeed / 120.0);
  float wave1 = sin(proj1 * wFreq * 800.0 + ts * 1.2) * cos(norm.y * wFreq * 600.0 + ts * 0.3);
  float wave2 = sin(proj2 * wFreq * 600.0 + norm.y * 1.5 - ts * 0.5);
  pos += norm * ((wave1 + wave2 * 0.5) * uWaveHeight);

  float hFalloff = mix(22.0, 1.5, clamp(uHoverRadius / 100.0, 0.0, 1.0));
  float hDot = max(0.0, dot(norm, uHoverDir));
  float hEffect = exp(-(1.0 - hDot) * hFalloff) * uHoverActive;
  pos += norm * hEffect * uHoverPush;

  float cy = cos(uCamYaw); float sy = sin(uCamYaw);
  float tp = uCamPitch + uTilt;
  float ctp = cos(tp); float stp = sin(tp);
  float x1 = pos.x * cy + pos.z * sy;
  float z1 = -pos.x * sy + pos.z * cy;
  float y2 = pos.y * ctp - z1 * stp;
  float z2 = pos.y * stp + z1 * ctp;
  float rz = uCamDist - z2;
  if (rz < 1.0) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); vAlpha = 0.0; vCol = vec3(0.0); return; }

  gl_Position = vec4((x1 * uFocal / rz) / (uRes.x * 0.5), (y2 * uFocal / rz) / (uRes.y * 0.5), 0.0, 1.0);

  float rimDot = abs(dot(norm, uCamDir));
  float fresnel = pow(max(1.0 - rimDot, 0.0), uRimPower);
  fresnel = max(fresnel, uCenter * rimDot);
  float finalAlpha = max(fresnel, hEffect * 0.95);
  float bri = 0.50 + aRnd.x * 0.50;
  float t = sp * 0.5 + 0.5;
  vec3 baseCol = rampColor(1.0 - t);
  float polar = min(pow(abs(sp), 4.0), 1.0);
  vCol = mix(baseCol, uHotspot, polar * 0.88);
  vAlpha = finalAlpha * bri;
}
`;

const FRAG = `
precision highp float;
varying vec3  vCol;
varying float vAlpha;
void main() { gl_FragColor = vec4(vCol * vAlpha, vAlpha); }
`;

function parseColor(input: string): [number, number, number] {
  let h = input.trim().replace("#", "");
  if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
  h = h.padEnd(6, "0");
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function program(gl: WebGLRenderingContext): WebGLProgram | null {
  const compile = (type: number, src: string) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  return gl.getProgramParameter(prog, gl.LINK_STATUS) ? prog : null;
}

export interface OrbProps {
  size: number;
  colors: readonly string[];
  /** Wave speed, 100 is calm. */
  speed?: number;
  waveHeight?: number;
  /** Live 0..1 microphone level; swells the wave while the engineer speaks. */
  level?: number;
  /** Mesh density; lower for small orbs. Capped so the index buffer fits 16 bits. */
  density?: number;
  /** Zoom; higher fills more of the canvas. */
  scale?: number;
  interactive?: boolean;
  className?: string;
}

export default function Orb({ size, colors, speed = 100, waveHeight = 20, level = 0, density = 110, scale = 78, interactive = true, className = "" }: OrbProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hoverMV = useRef(motionValue(0)).current;
  const live = useRef({ colors, speed, waveHeight, level, density: Math.min(density, 120), scale, interactive });
  live.current = { colors, speed, waveHeight, level, density: Math.min(density, 120), scale, interactive };
  const smooth = useRef({ speed, wave: waveHeight });

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const gl = canvas.getContext("webgl", { alpha: true, antialias: false, premultipliedAlpha: true, depth: false });
    if (!gl) return; // no WebGL: the soft glow behind the canvas still renders
    const prog = program(gl);
    if (!prog) return;

    const U = (name: string) => gl.getUniformLocation(prog, name);
    const u = {
      res: U("uRes"), focal: U("uFocal"), time: U("uTime"), radius: U("uRadius"), waveHeight: U("uWaveHeight"),
      waveLength: U("uWaveLength"), waveSpeed: U("uWaveSpeed"), waveDir: U("uWaveDir"), camDist: U("uCamDist"),
      camYaw: U("uCamYaw"), camPitch: U("uCamPitch"), tilt: U("uTilt"), rimPow: U("uRimPower"), center: U("uCenter"),
      colorCount: U("uColorCount"), colors: U("uColors[0]"), hotspot: U("uHotspot"), camDir: U("uCamDir"),
      hoverDir: U("uHoverDir"), hoverRadius: U("uHoverRadius"), hoverPush: U("uHoverPush"), hoverActive: U("uHoverActive"),
    };
    const aPolar = gl.getAttribLocation(prog, "aPolar");
    const aRnd = gl.getAttribLocation(prog, "aRnd");
    const polarBuf = gl.createBuffer();
    const rndBuf = gl.createBuffer();
    const idxBuf = gl.createBuffer();
    let built = -1;
    let indexCount = 0;

    const build = (d: number) => {
      const nTheta = Math.max(60, Math.round(d * 2.5));
      const nPhi = Math.max(40, Math.round(d * 1.8));
      const count = nTheta * nPhi;
      const polar = new Float32Array(count * 2);
      const rnd = new Float32Array(count * 2);
      const random = mulberry32(0xc0ffee7);
      let i = 0;
      for (let ti = 0; ti < nTheta; ti++) {
        const theta = ((ti + 0.5) / nTheta) * TAU;
        for (let pi = 0; pi < nPhi; pi++) {
          polar[i * 2] = ((pi + 0.5) / nPhi - 0.5) * Math.PI;
          polar[i * 2 + 1] = theta;
          rnd[i * 2] = random();
          rnd[i * 2 + 1] = random();
          i++;
        }
      }
      indexCount = (nTheta * (nPhi - 1) + nPhi * nTheta) * 2;
      const idx = new Uint16Array(indexCount);
      let k = 0;
      for (let ti = 0; ti < nTheta; ti++) {
        for (let pi = 0; pi < nPhi - 1; pi++) {
          idx[k++] = ti * nPhi + pi;
          idx[k++] = ti * nPhi + pi + 1;
        }
      }
      for (let pi = 0; pi < nPhi; pi++) {
        for (let ti = 0; ti < nTheta; ti++) {
          idx[k++] = ti * nPhi + pi;
          idx[k++] = ((ti + 1) % nTheta) * nPhi + pi;
        }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, polarBuf);
      gl.bufferData(gl.ARRAY_BUFFER, polar, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, rndBuf);
      gl.bufferData(gl.ARRAY_BUFFER, rnd, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      built = d;
    };

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    let dpr = 1;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      const w = Math.max(1, Math.round((canvas.clientWidth || 1) * dpr));
      const h = Math.max(1, Math.round((canvas.clientHeight || 1) * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const cam = { yaw: 0, pitch: 0, yawV: 0, pitchV: 0 };
    const drag = { active: false, x: 0, y: 0 };
    const hov = { target: 0, miss: 1, dir: [0, 1, 0] as [number, number, number], mx: 0, my: 0 };
    let hoverAnim: { stop: () => void } | null = null;
    const gate = (to: number) => {
      if (hov.target === to) return;
      hov.target = to;
      hoverAnim?.stop();
      hoverAnim = animate(hoverMV, to, { type: "tween", duration: 0.85, ease: [0, 0, 0.58, 1] });
    };
    const onDown = (e: PointerEvent) => {
      if (!live.current.interactive) return;
      drag.active = true;
      drag.x = e.clientX;
      drag.y = e.clientY;
      host.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!live.current.interactive) return;
      const r = host.getBoundingClientRect();
      hov.mx = e.clientX - r.left;
      hov.my = e.clientY - r.top;
      gate(1);
      if (!drag.active) return;
      const k = Math.PI / 180;
      cam.yawV += (e.clientX - drag.x) * k;
      cam.pitchV += (e.clientY - drag.y) * k;
      drag.x = e.clientX;
      drag.y = e.clientY;
    };
    const onLeave = () => gate(0);
    const onUp = () => {
      drag.active = false;
    };
    host.addEventListener("pointerdown", onDown);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);
    window.addEventListener("pointerup", onUp);

    const hit = (focal: number, pitch: number, dist: number): [number, number, number] | null => {
      const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), ctp = Math.cos(pitch), stp = Math.sin(pitch);
      const ox = -sy * ctp * dist, oy = stp * dist, oz = cy * ctp * dist;
      const dcx = (hov.mx * dpr - canvas.width / 2) / focal;
      const dcy = (canvas.height / 2 - hov.my * dpr) / focal;
      let dx = dcx * cy + dcy * sy * stp + sy * ctp;
      let dy = dcy * ctp - stp;
      let dz = dcx * sy - dcy * cy * stp - cy * ctp;
      const len = Math.hypot(dx, dy, dz);
      dx /= len; dy /= len; dz /= len;
      const b = ox * dx + oy * dy + oz * dz;
      const disc = b * b - (ox * ox + oy * oy + oz * oz - RADIUS * RADIUS);
      if (disc < 0) return null;
      const t = -b - Math.sqrt(disc);
      if (t < 0) return null;
      const hx = ox + t * dx, hy = oy + t * dy, hz = oz + t * dz;
      const hl = Math.hypot(hx, hy, hz) || 1;
      return [hx / hl, hy / hl, hz / hl];
    };

    const palette = new Float32Array(MAX_COLORS * 3);
    let raf = 0;
    let last = performance.now();
    let elapsed = 0;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const L = live.current;
      // Ease speed and wave toward their targets so state changes glide instead of jumping.
      const ease = 1 - Math.pow(0.02, dt);
      smooth.current.speed += (L.speed - smooth.current.speed) * ease;
      smooth.current.wave += (L.waveHeight + L.level * 40 - smooth.current.wave) * Math.min(1, ease * 3);
      elapsed += reduced ? dt * 0.2 : dt;
      if (L.density !== built) build(L.density);

      const damp = 1 - Math.pow(ORBIT_DAMPING / 100, dt * 10);
      cam.yaw += cam.yawV * damp + (reduced ? 0 : dt * 0.12 * (smooth.current.speed / 100));
      cam.pitch += cam.pitchV * damp;
      cam.yawV *= 1 - damp * 1.4;
      cam.pitchV *= 1 - damp * 1.4;

      const focal = canvas.height / (2 * Math.tan(((FOV_DEG / 2) * Math.PI) / 180));
      const pitch = cam.pitch + (TILT * Math.PI) / 180;
      const dist = CAM_FAR - CAM_PER_SCALE * L.scale;
      let active = hoverMV.get() * hov.miss;
      if (active > 0.001) {
        const h = hit(focal, pitch, dist);
        if (h) {
          hov.dir = h;
          hov.miss = Math.min(1, hov.miss / 0.8);
        } else {
          hov.miss *= 0.8;
        }
        active = hoverMV.get() * hov.miss;
      }

      const pal = L.colors.length ? L.colors.slice(0, MAX_COLORS) : ["#14B8A6"];
      for (let i = 0; i < MAX_COLORS; i++) {
        const [r, g, b] = parseColor(pal[Math.min(i, pal.length - 1)] ?? "#14B8A6");
        palette[i * 3] = r;
        palette[i * 3 + 1] = g;
        palette[i * 3 + 2] = b;
      }
      const [tr, tg, tb] = parseColor(pal[0] ?? "#14B8A6");
      const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), ctp = Math.cos(pitch), stp = Math.sin(pitch);
      const waveSpeed = (smooth.current.speed / 50) * 120;
      const angle = (WAVE_DIRECTION * Math.PI) / 180;

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.uniform2f(u.res, canvas.width, canvas.height);
      gl.uniform1f(u.focal, focal);
      gl.uniform1f(u.time, elapsed * (waveSpeed / 50));
      gl.uniform1f(u.radius, RADIUS);
      gl.uniform1f(u.waveHeight, smooth.current.wave);
      gl.uniform1f(u.waveLength, WAVE_LENGTH);
      gl.uniform1f(u.waveSpeed, waveSpeed);
      gl.uniform2f(u.waveDir, Math.sin(angle), Math.cos(angle));
      gl.uniform1f(u.camDist, dist);
      gl.uniform1f(u.camYaw, cam.yaw);
      gl.uniform1f(u.camPitch, cam.pitch);
      gl.uniform1f(u.tilt, (TILT * Math.PI) / 180);
      gl.uniform1f(u.rimPow, RIM_POWER);
      gl.uniform1f(u.center, 1);
      gl.uniform1f(u.colorCount, pal.length);
      gl.uniform3fv(u.colors, palette);
      gl.uniform3f(u.hotspot, Math.min(1, tr * 0.6 + 0.8), Math.min(1, tg * 0.4 + 0.7), Math.min(1, tb * 0.5 + 0.8));
      gl.uniform3f(u.camDir, -sy * ctp, stp, cy * ctp);
      gl.uniform3f(u.hoverDir, hov.dir[0], hov.dir[1], hov.dir[2]);
      gl.uniform1f(u.hoverRadius, HOVER_RADIUS);
      gl.uniform1f(u.hoverPush, HOVER_PUSH);
      gl.uniform1f(u.hoverActive, active);
      gl.bindBuffer(gl.ARRAY_BUFFER, polarBuf);
      gl.enableVertexAttribArray(aPolar);
      gl.vertexAttribPointer(aPolar, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, rndBuf);
      gl.enableVertexAttribArray(aRnd);
      gl.vertexAttribPointer(aRnd, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
      gl.drawElements(gl.LINES, indexCount, gl.UNSIGNED_SHORT, 0);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      hoverAnim?.stop();
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("pointerup", onUp);
      // Buffers and the program are released with the canvas. Losing the context here would break a remount of the
      // same canvas (React StrictMode mounts effects twice in development).
      gl.deleteBuffer(polarBuf);
      gl.deleteBuffer(rndBuf);
      gl.deleteBuffer(idxBuf);
      gl.deleteProgram(prog);
    };
  }, [hoverMV]);

  const first = colors[0] ?? "#14B8A6";
  const lastColor = colors[colors.length - 1] ?? first;
  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className={`relative shrink-0 ${interactive ? "cursor-grab active:cursor-grabbing" : ""} ${className}`}
      style={{ width: size, height: size }}
    >
      <div
        className="pointer-events-none absolute inset-[12%] rounded-full blur-2xl transition-[background] duration-700"
        style={{ background: `radial-gradient(circle at 35% 30%, ${first}40, transparent 60%), radial-gradient(circle at 70% 75%, ${lastColor}38, transparent 62%)` }}
      />
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />
    </div>
  );
}

/** Orb palettes per agent state. Teal is the memory accent (CLAUDE.md section 9). */
export const ORB = {
  idle: { colors: ["#14B8A6", "#3B82F6", "#8B5CF6"], speed: 90, waveHeight: 9 },
  listening: { colors: ["#2DD4BF", "#22D3EE", "#A78BFA"], speed: 140, waveHeight: 14 },
  thinking: { colors: ["#2DD4BF", "#14B8A6", "#6366F1"], speed: 260, waveHeight: 20 },
  success: { colors: ["#22C55E", "#14B8A6", "#3B82F6"], speed: 110, waveHeight: 8 },
  warning: { colors: ["#F59E0B", "#EF4444", "#8B5CF6"], speed: 120, waveHeight: 10 },
  off: { colors: ["#9A9A9A", "#6B7280", "#A3A3A3"], speed: 70, waveHeight: 7 },
} as const;
