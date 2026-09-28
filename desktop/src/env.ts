// Reads the repo-root .env so the desktop app shares configuration with the backend and frontend.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function loadDotEnv(): Record<string, string> {
  const file = join(__dirname, "..", "..", ".env");
  if (!existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, "utf-8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match?.[1] && match[2] !== undefined) values[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return values;
}

const fileEnv = loadDotEnv();
const read = (key: string, fallback: string): string => process.env[key] ?? fileEnv[key] ?? fallback;

export const config = {
  frontendUrl: read("ONCALL_FRONTEND_URL", "http://localhost:5173"),
  apiBase: read("VITE_API_BASE_URL", "http://localhost:8000"),
  // Ctrl+Space is the requested default. It also triggers suggestions in VS Code, so Ctrl+Shift+Space is the safe alternative.
  shortcut: read("ONCALL_SHORTCUT", "Control+Space"),
  captureDir: process.env.ONCALL_SELFTEST_DIR ?? "",
};
