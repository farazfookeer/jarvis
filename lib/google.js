// Google sign-in (read-only) plus Gmail and Calendar reads.
//
// We talk to Google's REST endpoints directly with fetch rather than pulling in
// the heavy googleapis client — all we need is a read-only list of threads and
// events. The OAuth client is a "Desktop app" type, so a loopback redirect
// (http://localhost:<port>/...) is allowed without pre-registering each URL.
//
// Scopes are read-only and never change in Phase 1: Jarvis can look, not touch.
import { getSecret, setSecret, deleteSecret, KEYS } from "./secrets.js";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
];
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// In-memory access token cache (refresh tokens live in the Keychain).
let accessToken = null;
let accessTokenExpiry = 0;

export async function isConnected() {
  return Boolean(await getSecret(KEYS.GOOGLE_REFRESH_TOKEN));
}

// Step 1 of sign-in: the URL we send the browser to. `prompt=consent` +
// `access_type=offline` ensures Google returns a refresh token we can store.
export async function buildAuthUrl(redirectUri) {
  const clientId = await getSecret(KEYS.GOOGLE_CLIENT_ID);
  if (!clientId) throw authError("Google client ID is not set");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

// Step 2: exchange the one-time code for tokens and persist the refresh token.
export async function exchangeCode(code, redirectUri) {
  const clientId = await getSecret(KEYS.GOOGLE_CLIENT_ID);
  const clientSecret = await getSecret(KEYS.GOOGLE_CLIENT_SECRET);
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw authError(`Token exchange failed: ${data.error_description || data.error || res.status}`);
  if (data.refresh_token) await setSecret(KEYS.GOOGLE_REFRESH_TOKEN, data.refresh_token);
  if (data.access_token) {
    accessToken = data.access_token;
    accessTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  }
  return true;
}

// Trade the stored refresh token for a short-lived access token, cached until
// shortly before it expires. A failed refresh means the grant is gone — clear
// it so the next request restarts sign-in.
async function getAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiry - 60000) return accessToken;
  const refreshToken = await getSecret(KEYS.GOOGLE_REFRESH_TOKEN);
  if (!refreshToken) throw authError("Not connected to Google", "needs_reauth");
  const clientId = await getSecret(KEYS.GOOGLE_CLIENT_ID);
  const clientSecret = await getSecret(KEYS.GOOGLE_CLIENT_SECRET);
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    if (data.error === "invalid_grant") await deleteSecret(KEYS.GOOGLE_REFRESH_TOKEN);
    throw authError(`Token refresh failed: ${data.error || res.status}`, "needs_reauth");
  }
  accessToken = data.access_token;
  accessTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return accessToken;
}

async function googleGet(url) {
  const token = await getAccessToken();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    accessToken = null;
    throw authError("Google rejected the token", "needs_reauth");
  }
  const data = await res.json();
  if (!res.ok) throw authError(`Google API error: ${data.error?.message || res.status}`, "upstream_error");
  return data;
}

// ---------- Gmail ----------
// Returns the { threads: [...] } shape the prototype's parseThreads() expects:
// each thread has messages[] with sender/subject/snippet/date/internalDate/labelIds,
// plus viewUrl and messageCount.
export async function gmailSearch({ query = "in:inbox", pageSize = 15 } = {}) {
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/threads?q=${encodeURIComponent(query)}&maxResults=${pageSize}`;
  const list = await googleGet(listUrl);
  const ids = (list.threads || []).map((t) => t.id);
  const threads = await Promise.all(ids.map((id) => fetchThread(id)));
  return { threads: threads.filter(Boolean) };
}

async function fetchThread(id) {
  const url =
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${id}` +
    `?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
  const t = await googleGet(url);
  const messages = (t.messages || []).map((m) => {
    const headers = Object.fromEntries((m.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
    return {
      sender: headers.from || "",
      subject: headers.subject || "(no subject)",
      snippet: m.snippet || "",
      date: headers.date || null,
      internalDate: m.internalDate || null,
      labelIds: m.labelIds || [],
    };
  });
  return {
    id: t.id,
    messages,
    messageCount: messages.length,
    viewUrl: `https://mail.google.com/mail/u/0/#inbox/${t.id}`,
  };
}

// Full thread for the in-app reader. Returns the whole thread with each
// message's decoded body as PLAIN TEXT — we never hand the email's own HTML to
// the browser, which keeps tracking pixels and junk markup out and honours the
// "email is data, not instructions" rule.
export async function gmailThread({ id } = {}) {
  if (!id) throw authError("No thread id", "tool_error");
  const t = await googleGet(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${id}?format=full`);
  const messages = (t.messages || []).map((m) => {
    const headers = Object.fromEntries((m.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
    return {
      from: headers.from || "",
      to: headers.to || "",
      date: headers.date || null,
      body: extractBody(m.payload) || m.snippet || "",
    };
  });
  return {
    id: t.id,
    subject: Object.fromEntries((t.messages?.[0]?.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value])).subject || "(no subject)",
    messages,
    viewUrl: `https://mail.google.com/mail/u/0/#inbox/${t.id}`,
  };
}

// Walk the MIME tree for a readable body: prefer text/plain, else flatten text/html.
// Exported for unit testing of the extraction logic.
export function extractBody(payload) {
  const plain = findPart(payload, "text/plain");
  if (plain) return decodeB64Url(plain);
  const html = findPart(payload, "text/html");
  if (html) return htmlToText(decodeB64Url(html));
  return "";
}
function findPart(payload, mime) {
  if (!payload) return null;
  if (payload.mimeType === mime && payload.body?.data) return payload.body.data;
  for (const part of payload.parts || []) {
    const found = findPart(part, mime);
    if (found) return found;
  }
  return null;
}
function decodeB64Url(data) {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
const NAMED_ENTITIES = {
  nbsp: " ", pound: "£", euro: "€", cent: "¢", yen: "¥", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  deg: "°", times: "×", middot: "·", bull: "•", lt: "<", gt: ">", quot: '"', apos: "'",
};
const cp = (n) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "");

function htmlToText(html) {
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text).replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => cp(+d))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/&amp;/g, "&"); // last, so a literal &amp; doesn't swallow a following entity
}

// ---------- Calendar ----------
// Returns { events: [...] } (Google's items array) — parseEvents() reads
// summary/start/end/location/htmlLink/attendees/status straight off it.
export async function calendarEvents({ startTime, endTime, orderBy = "startTime", pageSize = 250 } = {}) {
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/primary/events` +
    `?timeMin=${encodeURIComponent(toRfc3339London(startTime))}` +
    `&timeMax=${encodeURIComponent(toRfc3339London(endTime))}` +
    `&singleEvents=true&orderBy=${orderBy}&maxResults=${pageSize}&timeZone=Europe/London`;
  const data = await googleGet(url);
  return { events: data.items || [] };
}

// Google wants RFC3339 with an offset. The prototype sends London wall-clock
// with no offset ("2026-10-08T00:00:00"); append the correct London offset for
// that instant (handles BST/GMT) so boundaries land where the user expects.
export function toRfc3339London(naive) {
  if (!naive) return new Date().toISOString();
  if (/[Z+]|-\d{2}:\d{2}$/.test(naive.slice(10))) return naive; // already has offset
  const approx = new Date(`${naive}Z`);
  const name = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    timeZoneName: "longOffset",
  })
    .formatToParts(approx)
    .find((p) => p.type === "timeZoneName")?.value || "GMT";
  const m = name.match(/GMT([+-]\d{2}:\d{2})/);
  return naive + (m ? m[1] : "+00:00");
}

function authError(message, code = "server_not_connected") {
  const e = new Error(message);
  e.code = code;
  return e;
}
