// Mic input for the overlay composer. Desktop: Windows' offline speech recognition through the preload bridge
// (with a real microphone level). Browser: the Web Speech API when the browser provides it. Otherwise the mic
// button is hidden rather than pretending to listen. While listening, the microphone is also analysed locally
// (Web Audio, nothing recorded or sent) so the orb follows the speaker's loudness, pitch and brightness.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { desktop, type VoiceEvent } from "./desktop";

interface BrowserRecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface BrowserRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<BrowserRecognitionResult>;
}
interface BrowserRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: BrowserRecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => BrowserRecognition;

function browserRecognition(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Live features of the engineer's voice, each 0..1. Written every animation frame; read by the orb without re-renders. */
export interface AudioFeatures {
  /** Loudness (RMS mapped from -60 dB to -12 dB). */
  level: number;
  /** Fundamental frequency on a log scale, 80 Hz to 400 Hz. Held at its last value between voiced sounds. */
  pitch: number;
  /** Spectral centroid, 0 Hz to 4 kHz: higher for bright or sibilant sounds. */
  brightness: number;
  /** True while the analyser is running. */
  live: boolean;
}

const PITCH_MIN_HZ = 80;
const PITCH_MAX_HZ = 400;

/** Autocorrelation pitch estimate over the analysis window; null when the frame is not clearly voiced. */
function detectPitch(buf: Float32Array, sampleRate: number): number | null {
  const n = Math.min(buf.length, 1024);
  const minLag = Math.floor(sampleRate / PITCH_MAX_HZ);
  const maxLag = Math.min(Math.floor(sampleRate / PITCH_MIN_HZ), buf.length - n);
  let energy = 0;
  for (let i = 0; i < n; i += 2) energy += buf[i]! * buf[i]!;
  if (energy < 1e-4) return null;
  let bestLag = -1;
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < n; i += 2) sum += buf[i]! * buf[i + lag]!;
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  return bestLag > 0 && best / energy > 0.55 ? sampleRate / bestLag : null;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Analyses the default microphone while `active`; the returned ref is updated in place every frame. */
function useAudioFeatures(active: boolean, onLevel: (level: number) => void): MutableRefObject<AudioFeatures> {
  const features = useRef<AudioFeatures>({ level: 0, pitch: 0.4, brightness: 0, live: false });
  const onLevelRef = useRef(onLevel);
  onLevelRef.current = onLevel;

  useEffect(() => {
    if (!active || !navigator.mediaDevices?.getUserMedia) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let lastReport = 0;
    void navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } })
      .then((media) => {
        if (cancelled) {
          media.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = media;
        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.5;
        ctx.createMediaStreamSource(media).connect(analyser);
        const time = new Float32Array(analyser.fftSize);
        const freq = new Uint8Array(analyser.frequencyBinCount);
        const binHz = ctx.sampleRate / analyser.fftSize;
        const sampleRate = ctx.sampleRate;
        features.current.live = true;
        const tick = (now: number) => {
          raf = requestAnimationFrame(tick);
          analyser.getFloatTimeDomainData(time);
          let sq = 0;
          for (let i = 0; i < time.length; i++) sq += time[i]! * time[i]!;
          const rms = Math.sqrt(sq / time.length);
          const level = clamp01((20 * Math.log10(rms + 1e-8) + 60) / 48);
          const f = features.current;
          f.level = level;
          if (level > 0.12) {
            const hz = detectPitch(time, sampleRate);
            if (hz) f.pitch = clamp01(Math.log2(hz / PITCH_MIN_HZ) / Math.log2(PITCH_MAX_HZ / PITCH_MIN_HZ));
          }
          analyser.getByteFrequencyData(freq);
          let weighted = 0;
          let total = 0;
          for (let i = 1; i < freq.length; i++) {
            weighted += i * binHz * freq[i]!;
            total += freq[i]!;
          }
          f.brightness = total > 0 && level > 0.05 ? clamp01(weighted / total / 4000) : 0;
          if (now - lastReport > 90) {
            lastReport = now;
            onLevelRef.current(level);
          }
        };
        raf = requestAnimationFrame(tick);
      })
      .catch(() => {
        // Without mic access for analysis the orb falls back to the recognizer's level; transcription is unaffected.
      });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
      Object.assign(features.current, { level: 0, brightness: 0, live: false });
    };
  }, [active]);

  return features;
}

export interface Voice {
  supported: boolean;
  listening: boolean;
  starting: boolean;
  level: number; // 0..1, from the analyser, or the desktop recognizer when analysis is unavailable
  /** Per-frame voice features for the orb. */
  audio: MutableRefObject<AudioFeatures>;
  partial: string;
  error: string | null;
  start: () => void;
  stop: () => void;
}

/** onText receives each finished phrase; the caller appends it to the composer for the engineer to edit. */
export function useVoice(onText: (text: string) => void): Voice {
  const [listening, setListening] = useState(false);
  const [starting, setStarting] = useState(false);
  const [level, setLevel] = useState(0);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const browserRef = useRef<BrowserRecognition | null>(null);
  const native = Boolean(desktop?.voiceSupported && desktop.voiceStart);
  const supported = native || (!desktop && browserRecognition() !== null);
  const audio = useAudioFeatures(listening, setLevel);

  useEffect(() => {
    if (!native || !desktop?.onVoice) return;
    return desktop.onVoice((event: VoiceEvent) => {
      if (event.type === "ready") {
        setStarting(false);
        setListening(true);
      } else if (event.type === "level") {
        if (!audio.current.live) setLevel(Math.min(1, event.value / 60));
      } else if (event.type === "partial") {
        setPartial(event.text);
      } else if (event.type === "final") {
        setPartial("");
        if (event.text.trim()) onTextRef.current(event.text.trim());
      } else if (event.type === "error") {
        setError(event.message);
      } else {
        setStarting(false);
        setListening(false);
        setLevel(0);
        setPartial("");
      }
    });
  }, [native, audio]);

  const start = useCallback(() => {
    setError(null);
    setPartial("");
    if (native && desktop?.voiceStart) {
      setStarting(true);
      void desktop.voiceStart().then((r) => {
        if (!r.ok) {
          setStarting(false);
          setError(r.message);
        }
      });
      return;
    }
    const Ctor = browserRecognition();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (!result) continue;
        if (result.isFinal) onTextRef.current(result[0].transcript.trim());
        else interim += result[0].transcript;
      }
      setPartial(interim);
    };
    rec.onerror = (e) => setError(e.error === "not-allowed" ? "Microphone permission was denied." : `Voice input failed (${e.error}).`);
    rec.onend = () => {
      setListening(false);
      setPartial("");
    };
    browserRef.current = rec;
    rec.start();
    setListening(true);
  }, [native]);

  const stop = useCallback(() => {
    if (native) desktop?.voiceStop?.();
    browserRef.current?.stop();
    browserRef.current = null;
  }, [native]);

  useEffect(() => () => stop(), [stop]);

  return { supported, listening, starting, level, audio, partial, error, start, stop };
}
