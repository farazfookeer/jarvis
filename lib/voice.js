// Local voice: Kokoro for speech out, whisper.cpp for speech in.
//
// Both run on this Mac; audio never leaves it (CLAUDE.md rule). Model files
// come from their official Hugging Face pages and are checked against the
// SHA256 published there before use.
//
//  - Kokoro (kokoro-js, ONNX on CPU) turns a sentence into a WAV. The browser
//    asks for one sentence at a time so playback starts quickly.
//  - whisper.cpp runs as `whisper-server` (Homebrew build, Metal on Apple
//    Silicon), kept warm on a loopback port so each request skips model load.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { profile } from "./profile.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODELS = path.join(ROOT, "models");

// ---------- pinned model files (path, SHA256 from Hugging Face) ----------
export const VOICE = "bm_george";
const KOKORO_REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";
const KOKORO_FILES = [
  // dtype "q8" loads onnx/model_quantized.onnx into the transformers.js cache.
  { file: path.join(MODELS, "hf", KOKORO_REPO, "onnx", "model_quantized.onnx"), sha256: "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478" },
  // kokoro-js reads voices from its own package folder in Node.
  { file: path.join(ROOT, "node_modules", "kokoro-js", "voices", `${VOICE}.bin`), sha256: "c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc" },
];
const WHISPER_MODEL = {
  file: path.join(MODELS, "ggml-large-v3-turbo-q5_0.bin"),
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
  sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
};
const WHISPER_PORT = 8178;

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}
async function verify({ file, sha256: want }) {
  const got = await sha256(file);
  if (got !== want) throw voiceError(`Checksum mismatch for ${path.basename(file)}. Delete it and restart to download it again.`);
}

// ---------- speech out (Kokoro) ----------
let ttsPromise = null;
function loadTts() {
  ttsPromise ??= (async () => {
    // transformers.js caches downloads here (git-ignored) instead of inside node_modules.
    const { env } = await import("@huggingface/transformers");
    env.cacheDir = path.join(MODELS, "hf");
    const { KokoroTTS } = await import("kokoro-js");
    const tts = await KokoroTTS.from_pretrained(KOKORO_REPO, { dtype: "q8", device: "cpu" });
    await Promise.all(KOKORO_FILES.map(verify));
    return tts;
  })().catch((e) => {
    ttsPromise = null; // let the next request retry
    throw e;
  });
  return ttsPromise;
}

// One sentence or short paragraph in, a 24 kHz mono WAV buffer out.
export async function synthesise(text) {
  const tts = await loadTts();
  const audio = await tts.generate(text, { voice: VOICE });
  return Buffer.from(audio.toWav());
}

// ---------- speech in (whisper.cpp) ----------
let whisper = null; // { proc, ready: Promise }

async function startWhisper() {
  if (!fs.existsSync(WHISPER_MODEL.file)) {
    throw voiceError(`Whisper model missing. Download it with:\n  curl -L -o models/${path.basename(WHISPER_MODEL.file)} ${WHISPER_MODEL.url}`);
  }
  await verify(WHISPER_MODEL);
  const proc = spawn("whisper-server", [
    "-m", WHISPER_MODEL.file,
    "--host", "127.0.0.1",
    "--port", String(WHISPER_PORT),
    "-l", "en",
    "-nt",
    // Names Whisper wouldn't otherwise know how to spell.
    "--prompt", ["Jarvis", profile().firstName].filter(Boolean).join(", ") + ".",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  proc.on("error", () => {}); // reported via the ready promise below
  proc.on("exit", () => { if (whisper?.proc === proc) whisper = null; });
  process.on("exit", () => proc.kill());

  // Ready once the HTTP port answers.
  for (let i = 0; i < 60; i++) {
    if (proc.exitCode !== null) throw voiceError("whisper-server stopped on start. Is whisper-cpp installed (brew install whisper-cpp)?");
    try {
      await fetch(`http://127.0.0.1:${WHISPER_PORT}/`);
      return proc;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  proc.kill();
  throw voiceError("whisper-server didn't start in time.");
}

function ensureWhisper() {
  if (!whisper) {
    const ready = startWhisper();
    whisper = { ready };
    ready.catch(() => { whisper = null; });
  }
  return whisper.ready;
}

// Whisper invents these on silence or noise; treat them as "nothing said".
const HALLUCINATIONS = /^(\[?(blank_audio|music|silence|inaudible)\]?|\(.*\)|thank you\.?|thanks for watching!?|you)$/i;

// 16 kHz mono 16-bit WAV in, text out.
export async function transcribe(wav) {
  await ensureWhisper();
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");
  form.append("response_format", "json");
  form.append("temperature", "0");
  const res = await fetch(`http://127.0.0.1:${WHISPER_PORT}/inference`, { method: "POST", body: form });
  if (!res.ok) throw voiceError(`whisper-server ${res.status}`);
  const text = String((await res.json()).text || "").replace(/\s+/g, " ").trim();
  return HALLUCINATIONS.test(text) ? "" : text;
}

// Warm both engines at startup so the first reply isn't slow. Failures are
// reported once here and again, plainly, when the voice is actually used.
export function warmUp(log = console.log) {
  loadTts().then(() => log("Voice ready (Kokoro, George)."), (e) => log(`Voice out unavailable: ${e.message}`));
  ensureWhisper().then(() => log("Speech recognition ready (Whisper)."), (e) => log(`Speech in unavailable: ${e.message}`));
}

function voiceError(message) {
  const e = new Error(message);
  e.code = "voice_unavailable";
  return e;
}
