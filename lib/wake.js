// "Hey Jarvis" wake word: runs wakeword/listen.py (openWakeWord, on this Mac)
// as a child process and relays its events. The listener only runs while at
// least one HUD has hands-free on, so the mic isn't held open otherwise.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON = path.join(ROOT, ".venv-wake", "bin", "python");
const SCRIPT = path.join(ROOT, "wakeword", "listen.py");

let proc = null;
const subscribers = new Set(); // fn(event) per hands-free HUD

function broadcast(ev) {
  for (const fn of subscribers) fn(ev);
}

function start() {
  if (proc) return;
  if (!fs.existsSync(PYTHON)) {
    broadcast({ event: "error", message: "Wake word isn't set up. Run: npm run setup-wake" });
    return;
  }
  // -I: isolated mode, so nothing from the working directory is imported by accident.
  proc = spawn(PYTHON, ["-I", SCRIPT], { stdio: ["ignore", "pipe", "pipe"] });
  const me = proc;
  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
    try { broadcast(JSON.parse(line)); } catch { /* ignore stray output */ }
  });
  proc.stderr.on("data", () => {}); // library warnings; errors arrive as JSON events
  proc.on("exit", (code) => {
    if (proc !== me) return;
    proc = null;
    if (subscribers.size && code !== 0 && code !== null) broadcast({ event: "error", message: "Wake word listener stopped." });
  });
}

function stop() {
  if (!proc) return;
  const p = proc;
  proc = null;
  p.kill();
}

// Subscribe a HUD; returns the unsubscribe function. First in starts the
// listener, last out stops it.
export function subscribe(fn) {
  subscribers.add(fn);
  start();
  return () => {
    subscribers.delete(fn);
    if (!subscribers.size) stop();
  };
}

process.on("exit", stop);
