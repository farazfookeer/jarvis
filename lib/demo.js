// Demo mode (DEMO=1): made-up inbox, calendar, reminders, notes and news, so
// Jarvis can be tried, and screenshotted, without a Google account or any
// real data. Weather and TfL are live public feeds. Chat still uses Claude if
// a key is stored, but only ever sees this fake data.
import { toRfc3339London } from "./google.js";

export const enabled = process.env.DEMO === "1";

export const profile = {
  name: "Alex Morgan",
  firstName: "Alex",
  about: "Alex is a product manager in London who likes short, direct answers.",
};

// "YYYY-MM-DD" in London, offset by whole days.
const day = (offset = 0) =>
  new Date(Date.now() + offset * 864e5).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
const at = (offset, hhmm) => toRfc3339London(`${day(offset)}T${hhmm}:00`);
const hoursAgo = (h) => new Date(Date.now() - h * 36e5);
// Emails and events use fixed clock times on real dates, so the demo reads like mid-afternoon.
const sent = (e) => new Date(at(...e.when));

const EMAILS = [
  { id: "d1", from: "Priya Shah <priya@example.com>", subject: "Roadmap review: notes before this afternoon", snippet: "I've pulled together the open questions from last week. Could you look at the pricing section before we meet at 3:30?", when: [0, "13:42"], unread: true },
  { id: "d2", from: "Tom Okafor <tom@example.net>", subject: "Climbing tonight?", snippet: "Still on for 6:30 in Hackney? I can bring the spare harness.", when: [0, "12:18"], unread: true },
  { id: "d3", from: "Oak and Ivy Studio <billing@example.com>", subject: "Your invoice INV-2041", snippet: "Thanks for your order. Your invoice for the October workshop is attached.", when: [0, "10:05"] },
  { id: "d4", from: "Lena Fischer <lena@example.org>", subject: "Draft proposal for the workshop", snippet: "Here is the first draft. I kept it to two pages and left the budget blank for now.", when: [0, "08:31"], unread: true },
  { id: "d5", from: "Riverside Library <no-reply@example.org>", subject: "Your reserved book is ready", snippet: "The book you reserved is ready to collect. We'll hold it for seven days.", when: [-1, "18:10"] },
  { id: "d6", from: "Sam Patel <sam@example.com>", subject: "Re: flat viewing times", snippet: "Saturday at 2 works for the agent. I'll send the address in the morning.", when: [-1, "11:47"] },
  { id: "d7", from: "Maya Chen <maya@example.net>", subject: "Lunch next week?", snippet: "It's been ages. Are you free on Tuesday or Wednesday?", when: [-2, "16:20"] },
  { id: "d8", from: "Weekly Product <hello@example.com>", subject: "Five ideas for better discovery interviews", snippet: "This week: how to ask about the past instead of the future.", when: [-3, "09:00"] },
];

export function gmailSearch({ query = "in:inbox", pageSize = 15 } = {}) {
  const q = String(query).toLowerCase();
  const list = EMAILS.filter((e) => !q.includes("is:unread") || e.unread).slice(0, pageSize);
  return {
    threads: list.map((e) => ({
      id: e.id,
      messageCount: 1,
      viewUrl: null,
      messages: [{
        sender: e.from,
        subject: e.subject,
        snippet: e.snippet,
        date: sent(e).toUTCString(),
        internalDate: String(sent(e).getTime()),
        labelIds: ["INBOX", ...(e.unread ? ["UNREAD"] : [])],
      }],
    })),
  };
}

export function gmailThread({ id } = {}) {
  const e = EMAILS.find((x) => x.id === id) || EMAILS[0];
  return {
    id: e.id,
    subject: e.subject,
    viewUrl: null,
    messages: [{ from: e.from, to: "Alex Morgan <alex@example.com>", date: sent(e).toUTCString(), body: `Hi Alex,\n\n${e.snippet}\n\nThanks,\n${e.from.split(" ")[0]}` }],
  };
}

export function calendarEvents() {
  const ev = (id, summary, offset, start, end, location) => ({
    id, summary, location, status: "confirmed",
    start: { dateTime: at(offset, start) }, end: { dateTime: at(offset, end) },
  });
  return {
    events: [
      ev("c1", "Team stand-up", 0, "09:30", "09:45", "Video call"),
      ev("c2", "Design review: onboarding", 0, "11:00", "12:00", "Room 4"),
      ev("c3", "Lunch with Maya", 0, "13:00", "14:00", "Borough Market"),
      ev("c4", "Roadmap review", 0, "15:30", "16:30", "Video call"),
      ev("c5", "Climbing with Tom", 0, "18:30", "20:00", "Hackney"),
      { id: "c6", summary: "Sam's birthday", status: "confirmed", start: { date: day(1) }, end: { date: day(2) } },
      ev("c7", "Workshop planning", 1, "10:00", "11:30", "Room 2"),
      ev("c8", "Flat viewing", 3, "14:00", "14:45", "Bethnal Green"),
    ],
  };
}

export function reminders() {
  const due = (offset, hhmm) => new Date(at(offset, hhmm)).toISOString();
  return {
    updatedAt: Date.now(),
    reminders: [
      { title: "Pay the electricity bill", list: "Home", due: due(1, "09:00"), dueHasTime: true, notes: "", priority: 0 },
      { title: "Renew passport", list: "Admin", due: due(3, "12:00"), dueHasTime: false, notes: "", priority: 0 },
      { title: "Book train to Edinburgh", list: "Travel", due: null, dueHasTime: false, notes: "", priority: 0 },
      { title: "Water the plants", list: "Home", due: null, dueHasTime: false, notes: "", priority: 0 },
    ],
  };
}

const NOTES = [
  { id: "n1", account: "Demo", title: "Workshop ideas", modified: hoursAgo(30).toISOString(), text: "Start with a ten minute warm-up. Keep groups to four. End with one decision per group." },
];
export function searchNotes(query) {
  const q = String(query || "").toLowerCase();
  return { notes: NOTES.filter((n) => (n.title + " " + n.text).toLowerCase().includes(q)).map(({ text, ...n }) => ({ ...n, snippet: text.slice(0, 120) })) };
}
export function readNote(id) {
  const n = NOTES.find((x) => x.id === id);
  if (!n) throw Object.assign(new Error("Note not found."), { code: "apple_unavailable" });
  return n;
}

export function news() {
  const d = (h) => hoursAgo(h).toISOString();
  return {
    updatedAt: Date.now(),
    items: [
      { kind: "AI", source: "Demo feed", title: "Open model tops a new coding benchmark", url: null, date: d(1) },
      { kind: "Tech", source: "Demo feed", title: "Chip makers race to cut the power cost of AI data centres", url: null, date: d(2) },
      { kind: "AI", source: "Demo feed", title: "Researchers show small models can plan multi-step tasks", url: null, date: d(3) },
      { kind: "Tech", source: "Demo feed", title: "City trials contactless payments on night buses", url: null, date: d(5) },
      { kind: "AI", source: "Demo feed", title: "New guidance on using AI in regulated industries", url: null, date: d(7) },
      { kind: "Tech", source: "Demo feed", title: "Why more teams are moving builds to ARM laptops", url: null, date: d(9) },
    ],
  };
}

export function travel() {
  return {
    updatedAt: Date.now(),
    source: "TfL",
    lines: 15,
    disrupted: [{ line: "District", status: "Minor Delays", reason: "Minor delays between Earl's Court and Wimbledon." }],
  };
}
