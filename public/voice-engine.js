// Jarvis's voice engine. Loaded before app.js; exposes window.JarvisVoice.
//
// Speech out: text is split into sentences, each one is turned into audio by
// the local server (Kokoro) and played in order, fetching the next sentence
// while the current one plays.
// Speech in: the mic is captured at 16 kHz in an AudioWorklet, a simple
// energy-based detector finds where you start and stop talking, and the clip
// goes to the local server (Whisper) as a WAV. Audio never leaves this Mac.
(() => {
  "use strict";

  // ---------- speech out ----------
  let outCtx = null;
  let outTap = null;    // AnalyserNode on George's voice, for the core animation
  let gen = 0;          // bumped on every speak/stop so stale playback bails out
  let playing = null;   // { ac: AbortController, source: AudioBufferSourceNode|null }

  function sentences(text) {
    const parts = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
    const out = []; let cur = "";
    for (const p of parts) { if ((cur + p).length > 220 && cur) { out.push(cur.trim()); cur = p; } else cur += p; }
    if (cur.trim()) out.push(cur.trim());
    return out.filter(s => /[a-z0-9]/i.test(s));
  }

  async function fetchSpeech(text, signal) {
    const res = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal });
    if (!res.ok) throw new Error(`tts ${res.status}`);
    return res.arrayBuffer();
  }

  async function speak(text, { onStart, onEnd, onError } = {}) {
    stop();
    const my = ++gen;
    const ac = new AbortController();
    playing = { ac, source: null };
    const parts = sentences(text);
    try {
      outCtx ||= new AudioContext();
      if (outCtx.state === "suspended") await outCtx.resume();
      if (!outTap) { outTap = outCtx.createAnalyser(); outTap.fftSize = 512; outTap.smoothingTimeConstant = 0.7; outTap.connect(outCtx.destination); }
      let next = parts.length ? fetchSpeech(parts[0], ac.signal) : null;
      for (let i = 0; i < parts.length; i++) {
        const wav = await next;
        if (my !== gen) return;
        next = i + 1 < parts.length ? fetchSpeech(parts[i + 1], ac.signal) : null;
        next?.catch(() => {}); // surfaced when awaited
        const audio = await outCtx.decodeAudioData(wav);
        if (my !== gen) return;
        if (i === 0) onStart?.();
        await new Promise(resolve => {
          const s = outCtx.createBufferSource();
          s.buffer = audio; s.connect(outTap); s.onended = resolve;
          playing.source = s; s.start();
        });
        if (my !== gen) return;
      }
      playing = null;
      onEnd?.();
    } catch (e) {
      if (my !== gen || e.name === "AbortError") return;
      playing = null;
      onError?.(e);
    }
  }

  function stop() {
    gen++;
    if (!playing) return;
    playing.ac.abort();
    try { playing.source?.stop(); } catch {}
    playing = null;
  }

  // A short, soft two-note cue so you know Jarvis heard the wake word.
  function chime() {
    try {
      outCtx ||= new AudioContext();
      const t = outCtx.currentTime;
      [[660, 0], [880, 0.09]].forEach(([hz, at]) => {
        const o = outCtx.createOscillator(), g = outCtx.createGain();
        o.frequency.value = hz; o.connect(g); g.connect(outCtx.destination);
        g.gain.setValueAtTime(0.0001, t + at);
        g.gain.exponentialRampToValueAtTime(0.12, t + at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.16);
        o.start(t + at); o.stop(t + at + 0.18);
      });
    } catch {}
  }

  // ---------- speech in ----------
  const RATE = 16000, FRAME = 1280;          // 80 ms frames
  const PRE_ROLL = 4;                        // keep ~320 ms before speech starts
  const END_SILENCE = 10;                    // ~800 ms of quiet ends a turn
  const WAIT_FOR_SPEECH = 100;               // give up after ~8 s of nothing
  const MAX_FRAMES = 375;                    // 30 s cap

  let mic = null; // { ctx, stream, node, listeners:Set }

  async function openMic() {
    if (mic) return mic;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ctx = new AudioContext({ sampleRate: RATE });
    if (ctx.state === "suspended") await ctx.resume();
    await ctx.audioWorklet.addModule("mic-worklet.js");
    const node = new AudioWorkletNode(ctx, "mic-capture");
    const src = ctx.createMediaStreamSource(stream);
    src.connect(node);
    const tap = ctx.createAnalyser(); tap.fftSize = 512; tap.smoothingTimeConstant = 0.6;
    src.connect(tap); // read-only tap for the core animation; nothing is played back
    node.connect(ctx.destination); // keeps the worklet running; it outputs silence
    const listeners = new Set();
    node.port.onmessage = e => listeners.forEach(fn => fn(e.data));
    mic = { ctx, stream, node, listeners, tap };
    return mic;
  }

  function closeMic() {
    if (!mic || mic.listeners.size) return;
    mic.stream.getTracks().forEach(t => t.stop());
    mic.ctx.close();
    mic = null;
  }

  const rms = f => { let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i]; return Math.sqrt(s / f.length); };

  // Start a recording. Returns { started, done, stop(), cancel() } straight away;
  // `done` resolves to a WAV Blob, or null if nothing was said or it was cancelled.
  // hold: true records until stop() (push-to-talk); otherwise it ends on silence.
  function listen({ hold = false } = {}) {
    let finish, frames = [], pre = [], heard = false, quiet = 0, waited = 0, floor = 0.004, fn = null;
    const done = new Promise(r => { finish = r; });
    let ended = false;
    const end = keep => {
      if (ended) return; ended = true;
      if (fn && mic) mic.listeners.delete(fn);
      finish(keep && frames.length ? toWav(frames) : null);
    };
    const started = openMic().then(m => {
      if (ended) return;
      fn = f => {
        const level = rms(f);
        const speech = level > Math.max(floor * 3, 0.012);
        if (!speech && !heard) floor = floor * 0.95 + level * 0.05; // track background noise
        if (hold) { frames.push(f); if (speech) heard = true; if (frames.length >= MAX_FRAMES) end(true); return; }
        if (!heard) {
          pre.push(f); if (pre.length > PRE_ROLL) pre.shift();
          if (speech) { heard = true; frames = pre.slice(); }
          else if (++waited >= WAIT_FOR_SPEECH) end(false);
          return;
        }
        frames.push(f);
        quiet = speech ? 0 : quiet + 1;
        if (quiet >= END_SILENCE || frames.length >= MAX_FRAMES) end(true);
      };
      m.listeners.add(fn);
    }, e => { end(false); throw e; });
    return {
      started, done,
      stop: () => end(heard),
      cancel: () => end(false),
    };
  }

  function toWav(frames) {
    const n = frames.reduce((a, f) => a + f.length, 0);
    const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE");
    str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, n * 2, true);
    let o = 44;
    for (const f of frames) for (let i = 0; i < f.length; i++, o += 2) { const s = Math.max(-1, Math.min(1, f[i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    return new Blob([buf], { type: "audio/wav" });
  }

  async function transcribe(wav) {
    const res = await fetch("/api/stt", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
    if (!res.ok) throw new Error(`stt ${res.status}`);
    return (await res.json()).text || "";
  }

  const supported = !!(navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode);

  // Live analysers for the core animation: the mic while recording, George while speaking.
  const taps = () => ({ mic: mic && mic.listeners.size ? mic.tap : null, out: playing ? outTap : null });

  window.JarvisVoice = { taps, speak, stop, chime, listen, transcribe, closeMic, supported, speaking: () => !!playing };
})();
