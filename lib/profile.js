// Who Jarvis works for, and where. Read from config/profile.json (git-ignored;
// copy config/profile.example.json). Everything is optional: with no file,
// Jarvis is a generic assistant with London weather.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = path.join(ROOT, "config", "profile.json");
const DEFAULT_LOCATION = { name: "London", lat: 51.5074, lon: -0.1278 };

export function profile() {
  let c = {};
  try {
    c = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  } catch {}
  const name = typeof c.name === "string" ? c.name.trim() : "";
  const loc = c.location || {};
  const location = Number.isFinite(loc.lat) && Number.isFinite(loc.lon)
    ? { name: String(loc.name || ""), lat: loc.lat, lon: loc.lon }
    : DEFAULT_LOCATION;
  return {
    name,
    firstName: name.split(/\s+/)[0] || "",
    about: typeof c.about === "string" ? c.about.trim() : "",
    location,
  };
}
