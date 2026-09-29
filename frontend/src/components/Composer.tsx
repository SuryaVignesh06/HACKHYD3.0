// "Ask FRIDAY anything": paste an alert to investigate it, ask a question to search team memory, speak it, or
// attach a screenshot of the error. Errors open an incident; anything else is answered from memory.
import { forwardRef, useImperativeHandle, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { ArrowUp, CornerDownLeft, ImageUp, Loader2, Mic, Square } from "lucide-react";
import { api } from "../lib/api";
import type { Voice } from "../lib/voice";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export interface ComposerHandle {
  focus: () => void;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const Composer = forwardRef<ComposerHandle, {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (text: string) => void;
  busy: boolean;
  voice: Voice;
}>(function Composer({ value, onChange, onSubmit, busy, voice }, ref) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({ focus: () => textRef.current?.focus() }), []);

  const canSend = value.trim().length > 0 && !busy;

  function send() {
    if (!canSend) return;
    setNotice(null);
    onSubmit(value.trim());
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter adds a line for multi-line logs. Ctrl/Cmd+Enter always sends.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
      e.preventDefault();
      send();
    }
  }

  async function onImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) {
      setNotice("Use a PNG or JPEG screenshot.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setNotice("That image is over 6 MB. Crop it to the error and try again.");
      return;
    }
    setReading(true);
    setNotice(null);
    try {
      const result = await api.readScreen(await readAsDataUrl(file));
      if (!result.ok) {
        setNotice(result.error.message);
      } else if (!result.data.found) {
        setNotice(`No error found in the screenshot (read by ${result.data.model}). Paste the text instead.`);
      } else {
        onChange(result.data.text.trim());
        setNotice(`Read from your screenshot by ${result.data.model}. Check it, then send.`);
        textRef.current?.focus();
      }
    } catch {
      setNotice("The screenshot could not be read from disk.");
    } finally {
      setReading(false);
    }
  }

  const rows = Math.min(6, Math.max(1, value.split("\n").length));

  return (
    <div className="mx-auto w-full max-w-5xl">
      {(notice || voice.error || voice.partial) && (
        <p className={`mb-2 px-4 text-xs ${voice.error ? "text-severity" : "text-muted"}`}>{voice.error ?? (voice.partial ? `Hearing: ${voice.partial}` : notice)}</p>
      )}
      <div
        className={`flex items-end gap-2 rounded-[28px] border bg-[#0d0d0d] p-2 shadow-[0_20px_60px_rgba(0,0,0,0.6)] transition-colors ${
          voice.listening ? "border-white/40" : "border-white/[0.09] focus-within:border-white/20"
        }`}
      >
        <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => void onImage(e)} />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={reading || busy}
          aria-label="Read an error from a screenshot"
          title="Read an error from a screenshot (PNG or JPEG)"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03] text-ink transition-colors hover:bg-white/[0.07] disabled:opacity-40"
        >
          {reading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ImageUp className="h-[18px] w-[18px]" aria-hidden="true" />}
        </button>
        <div className="flex min-w-0 flex-1 items-end rounded-[22px] bg-white/[0.035] pl-4 pr-2">
          <textarea
            ref={textRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            rows={rows}
            placeholder={voice.listening ? "Listening..." : "Ask FRIDAY anything, or paste an alert, log or stack trace..."}
            aria-label="Ask FRIDAY"
            className="max-h-40 min-w-0 flex-1 resize-none bg-transparent py-3 text-sm leading-5 text-ink placeholder:text-muted/80 focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          <span className="mb-2 ml-2 hidden shrink-0 items-center gap-1 rounded-lg border border-white/[0.06] bg-white/[0.04] px-2 py-1 text-[11px] text-muted sm:flex">
            {IS_MAC ? "Cmd" : "Ctrl"} <CornerDownLeft className="h-3 w-3" aria-hidden="true" />
          </span>
        </div>
        {voice.supported && (
          <button
            type="button"
            onClick={() => (voice.listening || voice.starting ? voice.stop() : voice.start())}
            aria-label={voice.listening ? "Stop listening" : "Speak"}
            title={voice.listening ? "Stop" : "Speak (offline speech recognition)"}
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border transition-colors ${
              voice.listening ? "border-white/40 bg-white/10 text-ink" : "border-white/[0.08] bg-white/[0.03] text-muted hover:text-ink"
            }`}
          >
            {voice.listening ? (
              <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
            ) : voice.starting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Mic className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={send}
          disabled={!canSend}
          aria-label="Send"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-success text-black shadow-[0_0_20px_rgba(53,208,111,0.35)] transition-[filter,opacity] hover:brightness-110 disabled:opacity-35 disabled:shadow-none"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ArrowUp className="h-5 w-5" strokeWidth={2.5} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
});

export default Composer;
