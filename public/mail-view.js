// In-app email reader. Clicking an inbox row opens the thread in a Jarvis-style
// modal instead of a new Gmail tab. Loaded after app.js. The body comes back as
// plain text from the server (no email HTML, so no tracking pixels); we insert
// it with textContent, never innerHTML.
(() => {
  "use strict";
  const GMAIL = "Gmail";
  let mcpPromise = null;
  let lastFocused = null;

  // Build the modal once and reuse it.
  const backdrop = document.createElement("div");
  backdrop.className = "mv-backdrop";
  backdrop.innerHTML = `
    <div class="mv-panel" role="dialog" aria-modal="true" aria-label="Email">
      <div class="mv-head">
        <div class="mv-subject"></div>
        <button class="mv-close" aria-label="Close" title="Close">&#10005;</button>
      </div>
      <div class="mv-scroll"></div>
      <div class="mv-foot"><a class="mv-open" target="_blank" rel="noopener">Open in Gmail</a></div>
    </div>`;
  document.body.appendChild(backdrop);
  const panel = backdrop.querySelector(".mv-panel");
  const elSubject = backdrop.querySelector(".mv-subject");
  const elScroll = backdrop.querySelector(".mv-scroll");
  const elOpen = backdrop.querySelector(".mv-open");

  function open() {
    lastFocused = document.activeElement;
    backdrop.classList.add("open");
    backdrop.querySelector(".mv-close").focus();
  }
  function close() {
    backdrop.classList.remove("open");
    elScroll.innerHTML = "";
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector(".mv-close").addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && backdrop.classList.contains("open")) close(); });

  // Open rows: click, or Enter/Space when focused.
  document.addEventListener("click", (e) => {
    const row = e.target.closest(".item[data-thread-id]");
    if (row) { e.preventDefault(); show(row.dataset.threadId, row.dataset.viewUrl); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest?.(".item[data-thread-id]");
    if (row) { e.preventDefault(); show(row.dataset.threadId, row.dataset.viewUrl); }
  });

  async function show(threadId, viewUrl) {
    if (!threadId) return;
    elSubject.textContent = "Loading…";
    elScroll.innerHTML = `<div class="mv-loading">Fetching the email…</div>`;
    elOpen.href = viewUrl || "#";
    elOpen.style.visibility = viewUrl ? "visible" : "hidden";
    open();
    try {
      mcpPromise = mcpPromise || window.claude.use("mcp");
      const mcp = await mcpPromise;
      if (!mcp) throw new Error("offline");
      const { payload } = await mcp.callTool(GMAIL, "get_thread", { id: threadId });
      render(payload);
    } catch (err) {
      if (err.code === "needs_reauth") return; // shim is already redirecting to sign-in
      elSubject.textContent = "Couldn't open";
      elScroll.innerHTML = "";
      const box = document.createElement("div");
      box.className = "mv-error";
      box.textContent = "This email couldn't be loaded. Try again, or open it in Gmail.";
      elScroll.appendChild(box);
    }
  }

  function render(payload) {
    elSubject.textContent = payload.subject || "(no subject)";
    elOpen.href = payload.viewUrl || elOpen.href;
    elScroll.innerHTML = "";
    for (const m of payload.messages || []) {
      const msg = document.createElement("div");
      msg.className = "mv-msg";
      const meta = document.createElement("div");
      meta.className = "mv-meta";
      const from = document.createElement("span");
      from.className = "mv-from";
      from.textContent = m.from || "";
      const when = document.createElement("span");
      when.textContent = m.date ? new Date(m.date).toLocaleString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
      meta.append(from, when);
      const body = document.createElement("div");
      body.className = "mv-body";
      body.textContent = m.body || "(no text content)"; // textContent: never render email HTML
      msg.append(meta, body);
      elScroll.appendChild(msg);
    }
  }
})();
