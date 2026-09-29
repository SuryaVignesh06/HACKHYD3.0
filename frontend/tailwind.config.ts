import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Monochrome UI. Colour is reserved for semantic state only.
        bg: "#101010",
        surface: "#101010",
        border: "rgba(255, 255, 255, 0.12)",
        glass: "#101010",
        severity: "#FF4D4D",
        memory: "#F5F5F5",
        success: "#35D06F",
        muted: "#9A9A9A",
        ink: "#F5F5F5",
        // Keep legacy utility names inside the restricted semantic palette.
        amber: { 300: "#FF6B6B", 400: "#FF4D4D" },
        slate: { 300: "#FFFFFF", 400: "#FFFFFF" },
        teal: { 500: "#F5F5F5", 900: "#101010" },
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
