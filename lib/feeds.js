// Weather (Open-Meteo) and AI/tech news (RSS). Both are cached in memory and
// refreshed lazily — the HUD polls these endpoints every few minutes, so we
// don't want to hit the sources on every poll.
//
// Shapes match what the prototype's renderWeather()/renderNews() read:
//   weather: { location, source, updatedAt, now:{temp,condition}, days:[{day,max,min,condition,rain}] }
//   news:    { updatedAt, items:[{kind, source, title, url, date}] }
import { profile } from "./profile.js";

const WEATHER_TTL = 30 * 60 * 1000; // 30 min
const NEWS_TTL = 20 * 60 * 1000; // 20 min

// A few reliable RSS 2.0 feeds. kind groups them in the UI; source is the label.
const NEWS_FEEDS = [
  { url: "https://techcrunch.com/tag/artificial-intelligence/feed/", source: "TechCrunch", kind: "AI" },
  { url: "https://www.theregister.com/headlines.atom", source: "The Register", kind: "Tech" },
  { url: "https://hnrss.org/frontpage", source: "Hacker News", kind: "Tech" },
];

// TfL's open Unified API (no key needed at this volume). Tube, Elizabeth line,
// Overground and DLR, refreshed every few minutes.
const TFL_URL = "https://api.tfl.gov.uk/Line/Mode/tube,elizabeth-line,overground,dlr/Status";
const TRAVEL_TTL = 5 * 60 * 1000; // 5 min
// Severities that aren't trouble: Good Service, No Issues, Information, Service Closed (overnight).
const TFL_OK = new Set([10, 18, 19, 20]);

let weatherCache = { at: 0, data: null };
let travelCache = { at: 0, data: null };
let newsCache = { at: 0, data: null };

export async function getWeather(loc = profile().location) {
  if (weatherCache.data && Date.now() - weatherCache.at < WEATHER_TTL) return weatherCache.data;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&current=temperature_2m,weather_code` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=Europe/London&forecast_days=4`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const d = await res.json();
  const days = (d.daily?.time || []).map((iso, i) => ({
    day: new Date(`${iso}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short" }),
    max: Math.round(d.daily.temperature_2m_max[i]),
    min: Math.round(d.daily.temperature_2m_min[i]),
    condition: wmo(d.daily.weather_code[i]),
    rain: d.daily.precipitation_probability_max?.[i] ?? 0,
  }));
  const data = {
    location: loc.name,
    source: "Open-Meteo",
    updatedAt: Date.now(),
    now: { temp: Math.round(d.current?.temperature_2m ?? 0), condition: wmo(d.current?.weather_code) },
    days,
  };
  weatherCache = { at: Date.now(), data };
  return data;
}

export async function getNews() {
  if (newsCache.data && Date.now() - newsCache.at < NEWS_TTL) return newsCache.data;

  // Fetch each feed into its own (date-sorted) bucket.
  const buckets = await Promise.all(
    NEWS_FEEDS.map(async (feed) => {
      try {
        const res = await fetch(feed.url, { headers: { "User-Agent": "Jarvis/0.1 (personal assistant)" } });
        if (!res.ok) return [];
        const items = parseFeed(await res.text(), feed);
        items.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
        return items.slice(0, 8);
      } catch {
        return []; // A single flaky feed shouldn't blank the whole panel.
      }
    }),
  );

  // Interleave round-robin so every live source is represented, rather than
  // letting the one feed with the freshest dates fill the whole panel.
  const items = [];
  for (let i = 0; items.length < 12; i++) {
    let added = false;
    for (const bucket of buckets) {
      if (bucket[i]) {
        items.push(bucket[i]);
        added = true;
        if (items.length >= 12) break;
      }
    }
    if (!added) break; // every bucket exhausted
  }

  const data = { updatedAt: Date.now(), items };
  newsCache = { at: Date.now(), data };
  return data;
}

// Shape: { updatedAt, source, lines: n, disrupted: [{ line, status, reason }] }.
// An empty `disrupted` means good service across the network.
export async function getTravel() {
  if (travelCache.data && Date.now() - travelCache.at < TRAVEL_TTL) return travelCache.data;
  const res = await fetch(TFL_URL, { headers: { "User-Agent": "Jarvis/0.1 (personal assistant)" } });
  if (!res.ok) throw new Error(`TfL ${res.status}`);
  const lines = await res.json();
  const disrupted = [];
  for (const l of lines) {
    const bad = (l.lineStatuses || []).filter((st) => !TFL_OK.has(st.statusSeverity));
    if (!bad.length) continue;
    // A line can carry several statuses; the lowest severity number is the worst.
    bad.sort((a, b) => a.statusSeverity - b.statusSeverity);
    disrupted.push({
      line: l.name,
      status: bad[0].statusSeverityDescription,
      reason: String(bad[0].reason || "").replace(/^[^:]{0,40}:\s*/, "").replace(/\s+/g, " ").trim().slice(0, 300),
    });
  }
  const data = { updatedAt: Date.now(), source: "TfL", lines: lines.length, disrupted };
  travelCache = { at: Date.now(), data };
  return data;
}

// Minimal RSS + Atom parser. We only need title / link / date per entry, so a
// tolerant tag-grab beats pulling in an XML dependency for three known feeds.
function parseFeed(xml, feed) {
  const isAtom = /<entry[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml);
  const blocks = xml.split(isAtom ? /<entry[\s>]/i : /<item[\s>]/i).slice(1);
  const items = [];
  for (const b of blocks) {
    const title = clean(pick(b, "title"));
    if (!title) continue;
    const link = isAtom ? pickAttr(b, "link", "href") || pick(b, "id") : pick(b, "link");
    const rawDate = pick(b, "pubDate") || pick(b, "updated") || pick(b, "published");
    const date = rawDate ? new Date(rawDate).toISOString().slice(0, 10) : "";
    items.push({ kind: feed.kind, source: feed.source, title, url: /^https?:\/\//.test(link) ? link : "", date });
  }
  return items;
}

function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1].trim() : "";
}
function pickAttr(block, tag, attr) {
  const m = block.match(new RegExp(`<${tag}[^>]*\\b${attr}="([^"]+)"`, "i"));
  return m ? m[1] : "";
}
function clean(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// World Meteorological Organization weather codes → short text.
function wmo(code) {
  const map = {
    0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
    80: "Light showers", 81: "Showers", 82: "Violent showers",
    85: "Snow showers", 86: "Snow showers", 95: "Thunderstorm", 96: "Thunderstorm", 99: "Thunderstorm",
  };
  return map[code] ?? "—";
}
