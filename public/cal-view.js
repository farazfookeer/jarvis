// In-app calendar event view. Clicking an event in the Today panel opens its
// details in a Jarvis-style modal (same look as the email reader) instead of a
// new Google Calendar tab. Exposes window.JarvisCalView.show(event).
// Event text is inserted with textContent only; the description arrives as
// HTML from Google and is flattened to plain text first.
(() => {
  "use strict";
  const TZ = "Europe/London";
  let lastFocused = null;

  const backdrop = document.createElement("div");
  backdrop.className = "mv-backdrop";
  backdrop.innerHTML = `
    <div class="mv-panel" role="dialog" aria-modal="true" aria-label="Calendar event">
      <div class="mv-head">
        <div class="mv-subject"></div>
        <button class="mv-close" aria-label="Close" title="Close">&#10005;</button>
      </div>
      <div class="mv-scroll"></div>
      <div class="mv-foot"><a class="mv-join" target="_blank" rel="noopener">Join call</a><a class="mv-open" target="_blank" rel="noopener"></a></div>
    </div>`;
  document.body.appendChild(backdrop);
  const elTitle = backdrop.querySelector(".mv-subject");
  const elScroll = backdrop.querySelector(".mv-scroll");
  const elOpen = backdrop.querySelector(".mv-open");
  const elJoin = backdrop.querySelector(".mv-join");

  function close() {
    backdrop.classList.remove("open");
    elScroll.innerHTML = "";
    lastFocused?.focus?.();
  }
  backdrop.addEventListener("click", e => { if (e.target === backdrop) close(); });
  backdrop.querySelector(".mv-close").addEventListener("click", close);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && backdrop.classList.contains("open")) close(); });

  const https = u => (typeof u === "string" && /^https:\/\//.test(u) ? u : null);
  const fmt = (d, opts) => d.toLocaleString("en-GB", { timeZone: TZ, ...opts });

  function toText(html) {
    // DOMParser builds an inert document: no scripts run and no images load.
    const doc = new DOMParser().parseFromString(String(html).replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n"), "text/html");
    return (doc.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  }

  function row(label, value) {
    if (!value) return;
    const box = document.createElement("div");
    box.className = "mv-msg";
    const meta = document.createElement("div");
    meta.className = "mv-meta";
    const l = document.createElement("span");
    l.className = "mv-from";
    l.textContent = label;
    meta.append(l);
    const body = document.createElement("div");
    body.className = "mv-body";
    body.textContent = value;
    box.append(meta, body);
    elScroll.appendChild(box);
  }

  // ev: the parsed event from app.js ({ title, start, end, allDay, where, url, source, raw }).
  function show(ev) {
    lastFocused = document.activeElement;
    const raw = ev.raw || {};
    elTitle.textContent = ev.title || "Untitled";
    elScroll.innerHTML = "";

    let when;
    if (ev.allDay) when = fmt(ev.start, { weekday: "long", day: "numeric", month: "long" }) + ", all day";
    else when = fmt(ev.start, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) + (ev.end ? " to " + fmt(ev.end, { hour: "2-digit", minute: "2-digit" }) : "");
    row("When", when);
    row("Where", ev.where);
    row("Calendar", ev.source);

    const people = (raw.attendees || []).map(a => {
      const status = { accepted: "going", declined: "not going", tentative: "maybe", needsAction: "no reply yet" }[a.responseStatus] || "";
      return `${a.displayName || a.email}${a.self ? " (you)" : ""}${a.organizer ? ", organiser" : ""}${status ? `: ${status}` : ""}`;
    });
    row("Attendees", people.join("\n"));
    if (!people.length && raw.organizer && !raw.organizer.self) row("Organiser", raw.organizer.displayName || raw.organizer.email);
    row("Notes", raw.description ? toText(raw.description) : raw.notes || "");

    const join = https(raw.hangoutLink) || https((raw.conferenceData?.entryPoints || []).find(p => p.entryPointType === "video")?.uri);
    elJoin.href = join || "#";
    elJoin.hidden = !join;
    const open = https(ev.url);
    elOpen.href = open || "#";
    elOpen.textContent = ev.source && ev.source !== "Google Calendar" ? "" : "Open in Google Calendar";
    elOpen.hidden = !open;

    backdrop.classList.add("open");
    backdrop.querySelector(".mv-close").focus();
  }

  window.JarvisCalView = { show };
})();
