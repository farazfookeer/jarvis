// window.claude shim — the bridge that lets the (unchanged) prototype run
// outside claude.ai. It implements the same surface the prototype expects from
// window.claude.use(...), backed by this app's own local /api endpoints.
//
// The one piece of real logic here is the chat loop: Claude runs server-side
// one turn at a time, and this shim drives the agentic loop in the browser —
// streaming the reply, executing the prototype's client-side tools when the
// model asks, and feeding the results back until the model is done.
(() => {
  "use strict";

  // ---------- Claude (sample) ----------
  // POST one turn to /api/chat and read the Server-Sent Events stream.
  async function runTurnRemote(messages, { tools, system, effort, maxTokens, onText, signal } = {}) {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        messages,
        system,
        effort,
        maxTokens,
        tools: tools?.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      }),
    });
    if (!res.ok || !res.body) {
      let info = {};
      try { info = await res.json(); } catch {}
      throw withCode(info.code || "upstream_error", info.message || `chat ${res.status}`);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let result = null;
    let failure = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = parseFrame(frame);
          if (!ev) continue;
          if (ev.event === "text") onText?.(ev.data.delta);
          else if (ev.event === "done") result = ev.data;
          else if (ev.event === "error") failure = ev.data;
        }
      }
    } catch (e) {
      if (signal?.aborted || e.name === "AbortError") throw withCode("cancelled", "stopped");
      throw withCode("upstream_error", e.message);
    }
    if (failure) throw withCode(failure.code || "upstream_error", failure.message);
    if (!result) throw withCode("empty_completion", "no response");
    return result; // { content, stop_reason, usage }
  }

  function parseFrame(frame) {
    let event = "message";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return null;
    try { return { event, data: JSON.parse(data) }; } catch { return null; }
  }

  // The prototype calls sample(messagesOrPrompt, { onText, tools, signal }) and
  // expects { text }; it also uses sample.json(prompt) for a parsed object.
  async function sample(input, opts = {}) {
    const messages = normalizeMessages(input);
    const tools = opts.tools || [];
    let streamed = "";
    const onText = (delta) => {
      streamed += delta;
      opts.onText?.({ text: streamed });
    };

    for (let step = 0; step < 8; step++) {
      const turn = await runTurnRemote(messages, {
        tools,
        onText,
        signal: opts.signal,
        effort: opts.effort || "low",
      });

      if (turn.stop_reason === "refusal") throw withCode("refused", "declined");

      if (turn.stop_reason !== "tool_use") {
        const text = textOf(turn.content) || streamed;
        return { text };
      }

      // Tool use: echo the assistant content back verbatim (thinking blocks
      // included — Opus 5.5 requires it), run the tools, return their results.
      messages.push({ role: "assistant", content: turn.content });
      const results = [];
      for (const block of turn.content) {
        if (block.type !== "tool_use") continue;
        const tool = tools.find((t) => t.name === block.name);
        let content, isError = false;
        try {
          if (!tool) throw new Error(`unknown tool ${block.name}`);
          const out = await tool.execute(block.input || {});
          content = typeof out === "string" ? out : JSON.stringify(out);
        } catch (e) {
          content = `Error: ${e.message || e}`;
          isError = true;
        }
        results.push({ type: "tool_result", tool_use_id: block.id, content, is_error: isError });
      }
      messages.push({ role: "user", content: results });
    }
    return { text: streamed };
  }

  // Brainstorm uses this; the prompt already asks for JSON, so we parse the
  // final text (tolerating ```json fences).
  sample.json = async (prompt, opts = {}) => {
    const turn = await runTurnRemote(normalizeMessages(prompt), { effort: "medium", maxTokens: 16000 });
    if (turn.stop_reason === "refusal") throw withCode("refused", "declined");
    const text = textOf(turn.content);
    try {
      return JSON.parse(stripFences(text));
    } catch {
      throw withCode("invalid_json", "could not parse JSON");
    }
  };

  const normalizeMessages = (input) =>
    typeof input === "string"
      ? [{ role: "user", content: input }]
      : input.map((m) => ({ role: m.role, content: m.content }));
  const textOf = (content) => (content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const stripFences = (s) => s.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();

  // ---------- MCP (Gmail + Calendar) ----------
  async function callTool(server, tool, input) {
    const route =
      tool === "search_threads" ? "/api/gmail/search" :
      tool === "list_events" ? "/api/calendar/events" :
      tool === "get_thread" ? "/api/gmail/message" :
      tool === "search_notes" ? "/api/apple/notes/search" :
      tool === "read_note" ? "/api/apple/notes/read" : null;
    if (!route) throw withCode("tool_error", `unknown tool ${tool}`);

    const res = await fetch(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input || {}),
    });
    if (res.status === 401) {
      // Grant is gone — restart sign-in.
      window.location.assign("/api/auth/google");
      throw withCode("needs_reauth", "reconnecting");
    }
    if (!res.ok) {
      let info = {};
      try { info = await res.json(); } catch {}
      const e = withCode(info.code || "upstream_error", info.message || `tool ${res.status}`);
      e.retryable = res.status >= 500;
      throw e;
    }
    return { payload: await res.json(), cache: { storedAt: Date.now() } };
  }

  const mcp = {
    callTool,
    watchTool(server, tool, input, cb, opts = {}) {
      let stopped = false;
      let timer = null;
      const interval = opts.refetchInterval || 180000;
      const tick = async () => {
        if (stopped) return;
        try {
          cb({ type: "data", result: await callTool(server, tool, input) });
        } catch (e) {
          cb({ type: "error", error: { code: e.code || "upstream_error", message: e.message, retryable: e.retryable } });
        }
        if (!stopped) timer = setTimeout(tick, interval);
      };
      tick();
      return () => { stopped = true; if (timer) clearTimeout(timer); };
    },
  };

  // ---------- db (weather + news feeds) ----------
  const db = {
    doc(docPath) {
      const route =
        docPath === "feeds/weather" ? "/api/feeds/weather" :
        docPath === "feeds/news" ? "/api/feeds/news" :
        docPath === "feeds/travel" ? "/api/feeds/travel" :
        docPath === "feeds/reminders" ? "/api/apple/reminders" : null;
      return {
        onSnapshot(cb, errCb) {
          let stopped = false;
          let timer = null;
          const tick = async () => {
            if (stopped) return;
            try {
              if (!route) throw new Error("unknown feed");
              const res = await fetch(route);
              if (!res.ok) throw new Error(`feed ${res.status}`);
              const data = await res.json();
              cb({ exists: true, data: () => data });
            } catch (e) {
              errCb?.(e);
            }
            if (!stopped) timer = setTimeout(tick, 300000);
          };
          tick();
          return () => { stopped = true; if (timer) clearTimeout(timer); };
        },
      };
    },
  };

  // ---------- downloads (brainstorm export) ----------
  const downloads = {
    async save({ filename, data }) {
      const blob = new Blob([data], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename || "jarvis-export.md";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
  };

  // ---------- permissions (connector management) — a no-op locally ----------
  const permissions = { async manage() {} };

  // ---------- expose window.claude ----------
  const caps = { mcp, sample, db, downloads, permissions };
  window.claude = { use: async (name) => caps[name] ?? null };

  function withCode(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
  }
})();
