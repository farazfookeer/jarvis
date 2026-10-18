// Apple Calendar, Reminders and Notes, read-only, limited to approved accounts.
//
// Which accounts Jarvis may read is the user's decision, recorded in
// config/apple-sources.json (git-ignored; see config/apple-sources.example.json).
// Anything not listed there is never read: Calendar/Reminders IDs are filtered
// here before the helper is asked for them, and results are checked again on
// the way back. Calendar and Reminders go through bin/jarvis-apple (EventKit);
// Notes through apple/notes.js (AppleScript for JavaScript).
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = path.join(ROOT, "bin", "jarvis-apple");
const NOTES_SCRIPT = path.join(ROOT, "apple", "notes.js");
const CONFIG = path.join(ROOT, "config", "apple-sources.json");
const TZ = "Europe/London";

function config() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    return { calendarAccounts: c.calendarAccounts || [], notesAccounts: c.notesAccounts || [], excludeCalendars: c.excludeCalendars || [] };
  } catch {
    return { calendarAccounts: [], notesAccounts: [], excludeCalendars: [] }; // nothing approved: read nothing
  }
}

export function appleEnabled() {
  const c = config();
  return { calendar: c.calendarAccounts.length > 0 && fs.existsSync(HELPER), notes: c.notesAccounts.length > 0 };
}

function runJson(cmd, args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      let data = null;
      try { data = JSON.parse(stdout); } catch { /* fall through */ }
      if (data?.error) return reject(appleError(data.error));
      if (err || !data) return reject(appleError(err?.killed ? "Apple helper timed out" : "Apple helper failed"));
      resolve(data);
    });
  });
}

// Calendar and reminder-list IDs in approved accounts, refreshed every 10 min.
let sourcesCache = { at: 0, data: null };
async function approvedIds() {
  if (!sourcesCache.data || Date.now() - sourcesCache.at > 10 * 60 * 1000) {
    sourcesCache = { at: Date.now(), data: await runJson(HELPER, ["sources"]) };
  }
  const { calendarAccounts, excludeCalendars } = config();
  const ok = new Set(calendarAccounts);
  const skip = new Set(excludeCalendars); // calendar or list titles to leave out, e.g. "Work"
  const cals = (sourcesCache.data.calendars || []).filter((c) => ok.has(c.account) && !skip.has(c.title));
  return {
    calendars: cals.filter((c) => c.kind === "calendar").map((c) => c.id),
    lists: cals.filter((c) => c.kind === "reminders").map((c) => c.id),
    ok,
  };
}

// The helper's ISO parser doesn't take milliseconds.
const isoSeconds = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
const londonDate = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD

// Events between two instants, in the same shape as Google Calendar items so
// the HUD and Jarvis's calendar tool treat both alike.
export async function appleEvents(fromIso, toIso) {
  if (!appleEnabled().calendar) return [];
  const { calendars, ok } = await approvedIds();
  if (!calendars.length) return [];
  const { events = [] } = await runJson(HELPER, ["events", isoSeconds(fromIso), isoSeconds(toIso), calendars.join(",")]);
  return events
    .filter((e) => ok.has(e.account))
    .map((e) => ({
      id: `apple:${e.id}`,
      summary: e.title,
      start: e.allDay ? { date: londonDate(e.start) } : { dateTime: e.start },
      end: e.allDay ? { date: londonDate(e.end) } : { dateTime: e.end },
      location: e.location || undefined,
      notes: e.notes || undefined,
      status: e.status,
      attendees: (e.attendees || []).map((a) => ({ displayName: a.name, self: a.self, responseStatus: a.status })),
      source: `Apple Calendar: ${e.calendar}`,
    }));
}

// Incomplete reminders in approved lists, soonest due first (undated last).
export async function appleReminders() {
  if (!appleEnabled().calendar) return { reminders: [] };
  const { lists, ok } = await approvedIds();
  if (!lists.length) return { reminders: [] };
  const { reminders = [] } = await runJson(HELPER, ["reminders", lists.join(",")]);
  const items = reminders
    .filter((r) => ok.has(r.account))
    .map((r) => ({ title: r.title, list: r.list, due: r.due || null, dueHasTime: !!r.dueHasTime, notes: (r.notes || "").slice(0, 500), priority: r.priority }))
    .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
  return { updatedAt: Date.now(), reminders: items };
}

export async function searchNotes(query, limit = 8) {
  const accounts = config().notesAccounts;
  if (!accounts.length) throw appleError("Notes isn't enabled.");
  const q = String(query || "").trim().slice(0, 100);
  if (!q) return { notes: [] };
  const data = await runJson("osascript", ["-l", "JavaScript", NOTES_SCRIPT, "search", accounts.join(","), q, String(limit)], 30000);
  return { notes: (data.notes || []).filter((n) => accounts.includes(n.account)) };
}

export async function readNote(id) {
  const accounts = config().notesAccounts;
  if (!accounts.length) throw appleError("Notes isn't enabled.");
  const note = await runJson("osascript", ["-l", "JavaScript", NOTES_SCRIPT, "read", accounts.join(","), String(id || "")], 30000);
  if (!accounts.includes(note.account)) throw appleError("Note not found in an approved account.");
  return note;
}

function appleError(message) {
  const e = new Error(message);
  e.code = "apple_unavailable";
  return e;
}
