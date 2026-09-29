// Mic input for the overlay composer. Desktop: Windows' offline speech recognition through the preload bridge
// (with a real microphone level). Browser: the Web Speech API when the browser provides it. Otherwise the mic
// button is hidden rather than pretending to listen.
import { useCallback, useEffect, useRef, useState } from "react";
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

export interface Voice {
  supported: boolean;
  listening: boolean;
  starting: boolean;
  level: number; // 0..1, only from the desktop recognizer
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

  useEffect(() => {
    if (!native || !desktop?.onVoice) return;
    return desktop.onVoice((event: VoiceEvent) => {
      if (event.type === "ready") {
        setStarting(false);
        setListening(true);
      } else if (event.type === "level") {
        setLevel(Math.min(1, event.value / 60));
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
  }, [native]);

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

  return { supported, listening, starting, level, partial, error, start, stop };
}
