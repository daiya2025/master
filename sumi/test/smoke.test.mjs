// Runs the Electron app headlessly (Xvfb when available) with a fake Claude backend
// and fails if any smoke check fails. Usage: node test/smoke.test.mjs
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const electron = require("electron");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.SUMI_SMOKE_DIR ?? path.join(root, "smoke-out");

const args = [electron, ".", "--smoke", "--no-sandbox", "--disable-gpu"];
let cmd = args[0];
let cmdArgs = args.slice(1);
if (process.platform === "linux" && !process.env.DISPLAY && existsSync("/usr/bin/xvfb-run")) {
  cmd = "xvfb-run";
  cmdArgs = ["-a", "-s", "-screen 0 1400x900x24", ...args];
}

const child = spawn(cmd, cmdArgs, {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, SUMI_FAKE_CLAUDE: "1", SUMI_SMOKE_DIR: outDir, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
});
let output = "";
child.stdout.on("data", (d) => {
  output += d;
  process.stdout.write(d);
});
child.stderr.on("data", (d) => {
  const s = d.toString();
  if (!/dbus|Fontconfig|MESA|libva|gbm|sandbox|GPU process|DevTools|viz|egl|vulkan|gl_|ANGLE|dri|XDG/i.test(s)) process.stderr.write(s);
});
const timer = setTimeout(() => {
  console.error("smoke test timed out");
  child.kill("SIGKILL");
  process.exit(1);
}, 90_000);
child.on("exit", (code) => {
  clearTimeout(timer);
  const ok = code === 0 && output.includes("SMOKE OK");
  console.log(ok ? "\nsmoke test passed" : `\nsmoke test failed (exit ${code})`);
  process.exit(ok ? 0 : 1);
});
