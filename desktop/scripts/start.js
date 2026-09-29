// Starts Electron with ELECTRON_RUN_AS_NODE cleared. Terminals launched from VS Code or other Electron
// apps can inherit that variable, which makes Electron behave like plain Node and fail to open windows.
const { spawn } = require("node:child_process");
const electron = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ["."], { stdio: "inherit", env, cwd: require("node:path").join(__dirname, "..") });

process.on("SIGINT", () => {
  if (!child.killed) child.kill("SIGINT");
});
process.on("SIGTERM", () => {
  if (!child.killed) child.kill("SIGTERM");
});

child.on("exit", (code) => process.exit(code ?? 0));
