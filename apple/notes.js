// Read-only Apple Notes access for Jarvis, run with `osascript -l JavaScript`.
// Arguments arrive as argv (never spliced into code), and only accounts the
// server passes in are touched. Locked notes are skipped.
//
//   osascript -l JavaScript apple/notes.js search <accountsCsv> <query> <limit>
//   osascript -l JavaScript apple/notes.js read <accountsCsv> <noteId>
function run(argv) {
  const Notes = Application("Notes");
  const [cmd, accountsCsv, arg, limitArg] = argv;
  const allowed = String(accountsCsv || "").split(",").filter(Boolean);
  const accounts = Notes.accounts().filter(a => allowed.includes(a.name()));

  const iso = d => { try { return d.toISOString(); } catch (e) { return null; } };

  if (cmd === "search") {
    const q = String(arg || "").trim();
    const limit = Math.min(Math.max(parseInt(limitArg, 10) || 8, 1), 20);
    if (!q) return JSON.stringify({ notes: [] });
    const out = [];
    for (const acc of accounts) {
      // Title matches first, then body matches.
      const byName = acc.notes.whose({ name: { _contains: q } })();
      const byBody = acc.notes.whose({ plaintext: { _contains: q } })();
      const seen = new Set();
      for (const n of byName.concat(byBody)) {
        if (out.length >= limit) break;
        const id = n.id();
        if (seen.has(id)) continue;
        seen.add(id);
        if (n.passwordProtected()) continue;
        const text = n.plaintext() || "";
        const i = text.toLowerCase().indexOf(q.toLowerCase());
        const snippet = text.slice(Math.max(0, i - 80), Math.max(0, i - 80) + 240).replace(/\s+/g, " ").trim();
        out.push({ id, title: n.name(), account: acc.name(), modified: iso(n.modificationDate()), snippet });
      }
    }
    out.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
    return JSON.stringify({ notes: out });
  }

  if (cmd === "read") {
    for (const acc of accounts) {
      const hit = acc.notes.whose({ id: String(arg || "") })();
      if (!hit.length) continue;
      const n = hit[0];
      if (n.passwordProtected()) return JSON.stringify({ error: "That note is locked." });
      return JSON.stringify({ id: n.id(), title: n.name(), account: acc.name(), modified: iso(n.modificationDate()), text: (n.plaintext() || "").slice(0, 12000) });
    }
    return JSON.stringify({ error: "Note not found in an approved account." });
  }

  return JSON.stringify({ error: "unknown command" });
}
