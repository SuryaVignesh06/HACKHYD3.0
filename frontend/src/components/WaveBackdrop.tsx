// Faint contour lines that sweep out from the orb, behind the console. Decorative only: hidden from assistive
// technology, no pointer events, and still under prefers-reduced-motion.
import { useMemo } from "react";

const LINES = 16;

export default function WaveBackdrop() {
  const paths = useMemo(() => {
    const out: { d: string; opacity: number }[] = [];
    for (let i = 0; i < LINES; i++) {
      const t = i / (LINES - 1);
      const spread = 40 + t * 260; // how far the contour dips below the orb
      const lift = 120 - t * 60;
      // Each contour rises from the lower edges, swells around the centre (the orb) and falls away again.
      const d = [
        `M -100 ${420 + t * 380}`,
        `C 260 ${360 + t * 200}, 420 ${lift + spread * 0.2}, 800 ${lift + spread * 0.55}`,
        `S 1340 ${360 + t * 200}, 1700 ${420 + t * 380}`,
      ].join(" ");
      out.push({ d, opacity: 0.025 + (1 - Math.abs(t - 0.35)) * 0.035 });
    }
    return out;
  }, []);

  return (
    <svg
      aria-hidden="true"
      className="wave-backdrop pointer-events-none absolute inset-x-0 top-0 h-[900px] w-full"
      viewBox="0 0 1600 900"
      preserveAspectRatio="xMidYMin slice"
      fill="none"
    >
      <defs>
        <radialGradient id="wave-fade" cx="50%" cy="20%" r="70%">
          <stop offset="0%" stopColor="#fff" stopOpacity="1" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <mask id="wave-mask">
          <rect width="1600" height="900" fill="url(#wave-fade)" />
        </mask>
      </defs>
      <g mask="url(#wave-mask)">
        {paths.map((p, i) => (
          <path key={i} d={p.d} stroke="#ffffff" strokeOpacity={p.opacity} strokeWidth={1} />
        ))}
      </g>
    </svg>
  );
}
