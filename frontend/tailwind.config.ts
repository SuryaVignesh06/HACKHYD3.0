import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Pure black canvas, with Apple-style liquid glass surfaces (see .glass in index.css).
        bg: "#000000",
        surface: "rgba(255, 255, 255, 0.05)",
        border: "rgba(255, 255, 255, 0.10)",
        glass: "#777777",
        severity: "#EF4444",
        memory: "#14B8A6",
        success: "#22C55E",
        muted: "#9A9A9A",
        ink: "#EDEDED",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      borderRadius: {
        glass: "18px",
      },
    },
  },
  plugins: [],
} satisfies Config;
