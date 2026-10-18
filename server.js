// Jarvis Phase 1 — localhost HUD server.
//
// Serves the (reused) prototype UI from public/ and exposes the small /api
// surface the window.claude shim calls: Google sign-in, Gmail/Calendar reads,
// a streaming Claude proxy, and the weather/news feeds. Secrets stay in the
// Keychain; only text the user types reaches Claude; every tool call is logged.
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureCoreSecrets, hasCoreSecrets } from "./lib/secrets.js";
import * as google from "./lib/google.js";
import { runTurn, mapError } from "./lib/claude.js";
import { getWeather, getNews, getTravel } from "./lib/feeds.js";
import { synthesise, transcribe, warmUp } from "./lib/voice.js";
import * as wake from "./lib/wake.js";
import * as apple from "./lib/apple.js";
import { profile, DEFAULT_LOCATION } from "./lib/profile.js";
import * as demo from "./lib/demo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const AUDIT_LOG = path.join(__dirname, "jarvis-audit.log");
const PORT = Number(process.env.PORT) || 4173;
const REDIRECT_URI = `http://localhost:${PORT}/api/auth/callback`;
// Loopback only: the API serves your mail, so it must not be reachable from the network.
const HOST = "127.0.0.1";
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ---------- audit log (CLAUDE.md rule: log every tool call) ----------
async function audit(tool, inputs, summary) {
  const line = `${new Date().toISOString()}\t${tool}\t${trunc(JSON.stringify(inputs))}\t${trunc(summary)}\n`;
  fsp.appendFile(AUDIT_LOG, line).catch(() => {});
}
const trunc = (s, n = 200) => (s && s.length > n ? s.slice(0, n) + "…" : s || "");

// ---------- helpers ----------
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 2_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
// Raw request body (the mic clip for /api/stt), capped so a stray upload can't fill memory.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.join(PUBLIC_DIR, rel);
  // Keep reads inside public/.
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "forbidden" });
  try {
    const data = await fsp.readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

// ---------- request handling ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // Only answer requests addressed to this machine by name. Blocks DNS-rebinding
  // pages (a hostile site whose domain resolves to 127.0.0.1) from reading the API.
  if (!ALLOWED_HOSTS.has(req.headers.host)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("Forbidden");
  }

  try {
    // Auth gate: opening the app while not signed in starts Google sign-in.
    if (p === "/" && req.method === "GET" && !demo.enabled && !(await google.isConnected())) {
      res.writeHead(302, { Location: "/api/auth/google" });
      return res.end();
    }

    if (p === "/api/auth/status" && req.method === "GET") {
      return sendJson(res, 200, { connected: demo.enabled || (await google.isConnected()) });
    }

    if (p === "/api/auth/google" && req.method === "GET") {
      const authUrl = await google.buildAuthUrl(REDIRECT_URI);
      res.writeHead(302, { Location: authUrl });
      return res.end();
    }

    if (p === "/api/auth/callback" && req.method === "GET") {
      const code = url.searchParams.get("code");
      const err = url.searchParams.get("error");
      if (err || !code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        return res.end(`<p>Sign-in was cancelled or failed (${err || "no code"}). <a href="/api/auth/google">Try again</a>.</p>`);
      }
      await google.exchangeCode(code, REDIRECT_URI);
      await audit("google.signin", {}, "connected");
      res.writeHead(302, { Location: "/" });
      return res.end();
    }

    if (p === "/api/gmail/search" && req.method === "POST") {
      const input = await readJson(req);
      const payload = demo.enabled ? demo.gmailSearch(input) : await google.gmailSearch(input);
      await audit("search_email", { query: input.query }, `${payload.threads.length} threads`);
      return sendJson(res, 200, payload);
    }

    if (p === "/api/gmail/message" && req.method === "POST") {
      const input = await readJson(req);
      const payload = demo.enabled ? demo.gmailThread(input) : await google.gmailThread(input);
      await audit("read_email", { id: input.id }, `${payload.messages.length} messages`);
      return sendJson(res, 200, payload);
    }

    if (p === "/api/calendar/events" && req.method === "POST") {
      const input = await readJson(req);
      const payload = demo.enabled ? demo.calendarEvents(input) : await google.calendarEvents(input);
      // Approved Apple calendars join the same list. If they fail, Google still shows.
      let appleCount = 0;
      if (!demo.enabled) try {
        const extra = await apple.appleEvents(google.toRfc3339London(input.startTime), google.toRfc3339London(input.endTime));
        appleCount = extra.length;
        payload.events = [...payload.events, ...extra];
      } catch (e) {
        await audit("list_apple_calendar", {}, `failed: ${e.message}`);
      }
      await audit("list_calendar", { startTime: input.startTime, endTime: input.endTime }, `${payload.events.length - appleCount} Google + ${appleCount} Apple events`);
      return sendJson(res, 200, payload);
    }

    // Name and short bio for the assistant's prompts (config/profile.json).
    if (p === "/api/profile" && req.method === "GET") {
      const { name, firstName, about } = demo.enabled ? demo.profile : profile();
      return sendJson(res, 200, { name, firstName, about });
    }

    if (p === "/api/feeds/weather" && req.method === "GET") {
      return sendJson(res, 200, await getWeather(demo.enabled ? DEFAULT_LOCATION : undefined));
    }
    if (p === "/api/feeds/news" && req.method === "GET") {
      return sendJson(res, 200, demo.enabled ? demo.news() : await getNews());
    }
    if (p === "/api/feeds/travel" && req.method === "GET") {
      return sendJson(res, 200, demo.enabled ? demo.travel() : await getTravel());
    }

    // Apple Reminders and Notes (approved accounts only; see lib/apple.js).
    if (p === "/api/apple/reminders" && req.method === "GET") {
      const data = demo.enabled ? demo.reminders() : await apple.appleReminders();
      await audit("list_reminders", {}, `${data.reminders.length} open`);
      return sendJson(res, 200, data);
    }
    if (p === "/api/apple/notes/search" && req.method === "POST") {
      const { query, limit } = await readJson(req);
      const data = demo.enabled ? demo.searchNotes(query) : await apple.searchNotes(query, limit);
      await audit("search_notes", { query }, `${data.notes.length} notes`);
      return sendJson(res, 200, data);
    }
    if (p === "/api/apple/notes/read" && req.method === "POST") {
      const { id } = await readJson(req);
      const note = demo.enabled ? demo.readNote(id) : await apple.readNote(id);
      await audit("read_note", { id }, `"${note.title}", ${note.text.length} chars`);
      return sendJson(res, 200, note);
    }

    // Theme changes are UI-only, but Jarvis can make them, so they're logged like any tool call.
    if (p === "/api/ui/theme" && req.method === "POST") {
      const { theme, by } = await readJson(req);
      if (!["arc", "mark", "graphite"].includes(theme)) return sendJson(res, 400, { code: "invalid_request", message: "unknown theme" });
      await audit("set_theme", { theme, by: by === "click" ? "click" : "jarvis" }, "applied");
      return sendJson(res, 200, { ok: true });
    }

    // Voice: both run locally (Kokoro, Whisper); audio never leaves the Mac.
    if (p === "/api/tts" && req.method === "POST") {
      const { text } = await readJson(req);
      const clean = String(text || "").trim().slice(0, 600);
      if (!clean) return sendJson(res, 400, { code: "invalid_request", message: "no text" });
      const wav = await synthesise(clean);
      res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "no-store" });
      return res.end(wav);
    }
    if (p === "/api/stt" && req.method === "POST") {
      const wav = await readBody(req, 2_000_000); // ~60 s at 16 kHz mono
      const text = await transcribe(wav);
      await audit("transcribe", { bytes: wav.length }, `${text.length} chars`);
      return sendJson(res, 200, { text });
    }

    // Hands-free HUDs hold this stream open; while any do, the wake word
    // listener runs and each "Hey Jarvis" is pushed down it.
    if (p === "/api/events" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const unsubscribe = wake.subscribe((ev) => {
        if (ev.event === "wake") audit("wake_word", {}, `score ${ev.score}`);
        res.write(`event: wake-${ev.event}\ndata: ${JSON.stringify(ev)}\n\n`);
      });
      const ping = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => { clearInterval(ping); unsubscribe(); });
      return;
    }

    if (p === "/api/chat" && req.method === "POST") {
      return handleChat(req, res);
    }

    if (req.method === "GET") return serveStatic(res, p);
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method not allowed");
  } catch (e) {
    const code = e.code || "upstream_error";
    const status = code === "needs_reauth" || code === "server_not_connected" ? 401 : 500;
    sendJson(res, status, { code, message: e.message });
  }
});

// ---------- /api/chat: one streamed Claude turn over Server-Sent Events ----------
async function handleChat(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { code: "invalid_request", message: "bad JSON" });
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Abort the model stream if the browser navigates away or hits Stop.
  const ac = new AbortController();
  req.on("close", () => ac.abort());

  try {
    const turn = await runTurn(
      {
        messages: body.messages,
        tools: body.tools,
        system: body.system,
        effort: body.effort || "low",
        maxTokens: body.maxTokens || 8000,
      },
      { onText: (delta) => send("text", { delta }), signal: ac.signal },
    );
    const textLen = (turn.content || []).filter((b) => b.type === "text").reduce((n, b) => n + (b.text?.length || 0), 0);
    await audit("chat", { turns: body.messages?.length, tools: (body.tools || []).map((t) => t.name) }, `${turn.stop_reason}, ${textLen} chars`);
    send("done", { content: turn.content, stop_reason: turn.stop_reason, usage: turn.usage });
  } catch (e) {
    send("error", { code: mapError(e), message: e.message || String(e) });
  } finally {
    res.end();
  }
}

// ---------- startup ----------
async function main() {
  if (!demo.enabled && !(await hasCoreSecrets())) {
    if (!process.stdin.isTTY) {
      console.error("Missing secrets. Run `node server.js` in a terminal once to enter them.");
      process.exit(1);
    }
    console.log("First run — let's store your keys securely in the macOS Keychain.\n");
    await ensureCoreSecrets();
    console.log("");
  }
  server.listen(PORT, HOST, () => {
    const where = `http://localhost:${PORT}`;
    console.log(`Jarvis is running at ${where}${demo.enabled ? " (demo mode: made-up data, Google not used)" : ""}`);
    warmUp();
    if (!demo.enabled) google.isConnected().then((connected) => {
      if (!connected) console.log("Open it in your browser and it'll take you through Google sign-in (read-only).");
    });
  });
}

// Exit cleanly on Ctrl+C or kill, so the Whisper and wake word helpers stop too.
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));

main();
