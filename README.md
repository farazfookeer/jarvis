# Jarvis

A personal AI assistant that runs on your Mac. It's a heads-up display showing your inbox, calendar, reminders, weather, London travel and AI and tech news, with chat, brainstorm and a local voice you can talk to hands-free.

It is **read-only**: it can read your Gmail and calendars but never sends, changes or deletes anything. Your keys stay in the macOS Keychain, the server only listens on your own machine, and all audio is processed locally. Only text goes to the Claude API.

Status: a working personal project. The localhost HUD and the voice loop are built. A menu bar app and confirmed write actions (draft replies, calendar holds) are planned.

## What you need

- **macOS** with **Node 18 or newer** (`node -v`).
- A **Claude API key** from console.anthropic.com.
- A **Google OAuth client** (Desktop app type) with the Gmail and Calendar APIs enabled, read-only.
- For voice: **Homebrew** (`brew install whisper-cpp`) and **Python 3** (from Homebrew or python.org).

## Setup

1. **Claude key:** console.anthropic.com → Settings → API keys → Create key.
2. **Google:** console.cloud.google.com → create a project → APIs & Services → Library → enable **Gmail API** and **Google Calendar API**. Then OAuth consent screen → External → add yourself as a Test user. Then Credentials → Create OAuth client ID → **Desktop app**. Copy the Client ID and Client secret.
3. **Tell Jarvis about you (optional):** copy `config/profile.example.json` to `config/profile.json` and fill in your name, a sentence about yourself, and your location for the weather. Without it, Jarvis is a generic assistant with London weather. The file is git-ignored.
4. **Install and run:**
   ```sh
   npm install
   node server.js
   ```
   On first run it asks, in the terminal, for your Claude key and the Google client ID + secret. They go into your macOS Keychain (nothing is written to disk or committed).
5. Open **http://localhost:4173** . It takes you through Google sign-in (read-only), then the HUD fills in.

## How it works

The UI began as a prototype built for the claude.ai artifact runtime. A small shim (`public/claude-shim.js`) stands in for the claude.ai runtime and talks to a local Node server (`server.js`), which holds the secrets and calls Google and Anthropic on the page's behalf.

```
browser (public/) ──> server.js ──> Google (Gmail, Calendar, read-only)
                                └──> Anthropic (Claude Opus 5.5)
                                └──> Open-Meteo (weather) + RSS (news)
```

- `lib/secrets.js`: reads/writes the Keychain via the macOS `security` command.
- `lib/google.js`: OAuth plus Gmail/Calendar reads.
- `lib/claude.js`: one streamed Claude turn; the browser drives the tool loop.
- `lib/feeds.js`: weather and news, cached.
- `lib/voice.js`: Kokoro speech out, Whisper speech in.
- `lib/wake.js` + `wakeword/listen.py`: the "Hey Jarvis" listener.
- `public/voice-engine.js`: plays speech, records the mic, detects when you stop talking.
- Every Gmail/Calendar/Claude call is logged to `jarvis-audit.log` (git-ignored).

Chat and brainstorm use **Claude Opus 5.5** (`claude-opus-5-5`). To change the model, edit the one constant at the top of `lib/claude.js`.

## Voice

Everything runs on the Mac; only the transcribed text goes to Claude.

- **Speech out:** Kokoro (`kokoro-js`), British voice `bm_george`. Downloads about 90 MB on first run.
- **Speech in:** whisper.cpp (`whisper-server`, Metal). Model, about 570 MB:
  ```sh
  mkdir -p models && curl -L -o models/ggml-large-v3-turbo-q5_0.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
  ```
- **Wake word:** "Hey Jarvis" via openWakeWord in a small Python helper. Set it up once with `npm run setup-wake`.
- Every model file is checked against a pinned SHA256 before use.

How to talk to Jarvis:
- **Tap the mic**, speak, and pause. It sends when you stop.
- **Hold Right Option** while you speak and let go to send (while the Jarvis tab is focused).
- **Hands-free on:** say "Hey Jarvis", wait for the chime, then speak. After a reply, Jarvis listens once more for a follow-up. The wake word listener only runs while hands-free is on and the page is open.

The first time, macOS asks whether Terminal may use the microphone (for the wake word) and Chrome asks for the page. Allow both.

## Apple Calendar, Reminders and Notes

Read-only, and only from accounts listed in `config/apple-sources.json` (copy `config/apple-sources.example.json`; currently iCloud). Leave out a single calendar or list by adding its name to `excludeCalendars`.

1. Build the helper once: `sh apple/build.sh`
2. Restart Jarvis. macOS asks to allow Calendar, Reminders and (on the first notes search) control of Notes. Allow each.

Apple events join the Today panel, open reminders fill the Reminders panel, and Jarvis can search and read notes when you ask.

## London travel

Line status from TfL's open API (Tube, Elizabeth line, Overground, DLR), refreshed every 5 minutes. The HUD shows "Good service" or the disrupted lines; click it for details.

## Troubleshooting

- **`redirect_uri_mismatch` at Google sign-in:** your OAuth client wants the redirect listed explicitly. Create a **Web application** client instead and add `http://localhost:4173/api/auth/callback` as an authorised redirect URI, then re-enter the new client ID/secret (see below).
- **Re-enter a key:** remove the stored item and restart, e.g.
  ```sh
  security delete-generic-password -s jarvis -a claude-api-key
  ```
  (accounts: `claude-api-key`, `google-client-id`, `google-client-secret`, `google-refresh-token`).
- **Wake word never fires:** check System Settings → Privacy & Security → Microphone and allow Terminal (or whichever app runs `node server.js`). Without it macOS gives the listener silence rather than an error.
- **Port in use:** `PORT=5000 node server.js` (then open that port, and update the Google redirect if you registered one).
- **Sign-in loops / "needs reconnecting":** your Google grant lapsed. Delete `google-refresh-token` as above and reload to sign in again.

## Privacy and safety

- **Read-only Google scopes:** `gmail.readonly` and `calendar.readonly`. Nothing can be sent, changed or deleted.
- **Secrets** (Claude key, Google client and refresh token) live only in your macOS Keychain.
- **Local only:** the server binds to `127.0.0.1` and rejects requests for any other host name.
- **Audio never leaves the Mac.** Wake word, speech to text and text to speech all run locally.
- **Email is data, not instructions.** The assistant is told never to follow instructions found in emails, notes or headlines.
- **Audit log:** every tool call is appended to `jarvis-audit.log` (git-ignored). It contains search queries and message IDs, so treat it as private.
- **Apple data** is read only from accounts you list in `config/apple-sources.json`.

Email and calendar text you ask about is sent to the Claude API as part of the conversation. Review [Anthropic's data policies](https://www.anthropic.com/legal) if that matters to you.

## Known limitations

- macOS only (Keychain, EventKit, Apple Notes, Metal for Whisper).
- Times and dates assume the `Europe/London` timezone, and the travel panel uses TfL. Making these configurable would be a welcome contribution.
- The Google OAuth app runs in "Testing" mode, so Google may ask you to sign in again every 7 days.

## Third-party models and licences

Jarvis's own code is MIT licensed (see `LICENSE`). Models are downloaded at setup time, not stored in this repo, and carry their own licences:

- **Kokoro** (speech out): Apache 2.0.
- **Whisper** large-v3-turbo via whisper.cpp (speech in): MIT.
- **openWakeWord** "hey_jarvis" model (wake word): CC BY-NC-SA 4.0, **non-commercial use only**. The openWakeWord code is Apache 2.0.

"Jarvis" is a nickname for the project. It is not affiliated with or endorsed by Marvel or Disney.

## Contributing

Issues and pull requests are welcome. Please keep Jarvis read-only by default, keep secrets out of code and logs, and use British English in UI copy.
