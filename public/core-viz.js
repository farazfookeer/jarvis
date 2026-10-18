// Jarvis's core: a 3D particle wave filling the dial, behind the centre text.
//
// Glowing particles ride slowly morphing streams, seen with depth of field.
// It reacts to Jarvis's state (read from the dial's class: listening, thinking,
// speaking), to live sound (JarvisVoice.taps()): when George speaks, low tones
// make the waves surge and the flow quicken, higher tones make the particles
// sparkle. It flares on the wake word (JarvisCore.flare()). Colours follow the
// theme. It slows down when idle, stops when the page is hidden, and holds
// still under "Reduce motion".
(() => {
  "use strict";
  const dial = document.getElementById("dial");
  const svg = dial?.querySelector("svg");
  if (!dial || !svg) return;

  // Dial geometry, in the SVG's own units (viewBox 560 x 440).
  const VB_W = 560, CX = 280, CY = 215;

  const canvas = document.createElement("canvas");
  canvas.className = "core";
  canvas.setAttribute("aria-hidden", "true");
  svg.after(canvas);
  const ctx = canvas.getContext("2d");
  let scale = 1, dpr = 1;

  function resize() {
    const r = svg.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = r.width + "px";
    canvas.style.height = r.height + "px";
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    scale = (r.width / VB_W) * dpr;
  }
  new ResizeObserver(resize).observe(svg);
  resize();

  // ---------- theme colours ----------
  let rgb = [79, 214, 230], light = false;
  function parseColour(c) {
    c = c.trim();
    let m = c.match(/^#([0-9a-f]{6})$/i);
    if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
    m = c.match(/rgba?\(([^)]+)\)/);
    if (m) return m[1].split(",").slice(0, 3).map(Number);
    return null;
  }
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    rgb = parseColour(cs.getPropertyValue("--glow")) || rgb;
    const bg = parseColour(cs.getPropertyValue("--bg")) || [0, 0, 0];
    light = (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) > 140;
  }
  new MutationObserver(readTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  readTheme();
  const col = a => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
  // A hotter, whiter version of the glow for the bright core while speaking.
  const hot = a => `rgba(${Math.round(rgb[0] + (255 - rgb[0]) * 0.55)},${Math.round(rgb[1] + (255 - rgb[1]) * 0.55)},${Math.round(rgb[2] + (255 - rgb[2]) * 0.55)},${a})`;

  // ---------- state and sound ----------
  const state = () => {
    const c = dial.classList;
    return c.contains("speaking") ? "speaking" : c.contains("listening") ? "listening" : c.contains("thinking") ? "thinking" : "idle";
  };
  const td = new Uint8Array(256), fd = new Uint8Array(256);
  let level = 0, low = 0, high = 0, flareAt = -1e9;
  function readSound(st) {
    const taps = window.JarvisVoice?.taps?.() || {};
    const a = st === "listening" ? taps.mic : st === "speaking" ? taps.out : null;
    if (!a) { level *= 0.9; low *= 0.9; high *= 0.9; return; }
    a.getByteTimeDomainData(td);
    a.getByteFrequencyData(fd);
    let sum = 0;
    for (let i = 0; i < td.length; i++) { const v = (td[i] - 128) / 128; sum += v * v; }
    const band = (from, to) => { let s = 0; for (let i = from; i < to; i++) s += fd[i]; return s / ((to - from) * 255); };
    // Fast attack, slower release, so syllables read as breaths of light.
    const follow = (cur, v) => cur + (v - cur) * (v > cur ? 0.5 : 0.12);
    level = follow(level, Math.min(1, Math.sqrt(sum / td.length) * 4));
    low = follow(low, Math.min(1, band(2, 14) * 1.6));     // voice body
    high = follow(high, Math.min(1, band(30, 90) * 3));    // consonants, sibilance
  }

  const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  // ---------- particle wave ----------
  // Thousands of glowing particles in 3D, seen through a camera with depth of
  // field: near ones are large soft discs, far ones tiny sharp points. Most
  // ride streams that follow slowly morphing curves (ribbons, loops, fine
  // filaments); the rest drift freely. The whole field turns slowly for
  // parallax. Speaking makes the waves surge, the flow quicken and the
  // particles brighten; higher tones make them sparkle.
  const FOCUS = 0, CAM = 620, BLURS = 6;
  let sprites = null, spriteKey = "", wt = 0, yaw = 0;

  // Pre-rendered particle images, from a sharp point (0) to a soft disc (BLURS - 1).
  function buildSprites() {
    const base = light ? mix(rgb, [0, 0, 0], 0.25) : rgb;
    const core = light ? mix(rgb, [0, 0, 0], 0.4) : mix(rgb, [255, 255, 255], 0.55);
    sprites = Array.from({ length: BLURS }, (_, b) => {
      const n = 64, cv = document.createElement("canvas"); cv.width = cv.height = n;
      const c = cv.getContext("2d"), g = c.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
      const k = b / (BLURS - 1);                       // 0 sharp, 1 very soft
      if (k === 0) {
        g.addColorStop(0, rgba(core, 1)); g.addColorStop(0.2, rgba(base, 1)); g.addColorStop(0.32, rgba(base, 0.45)); g.addColorStop(0.6, rgba(base, 0.08)); g.addColorStop(1, rgba(base, 0));
      } else {
        // Bokeh: a flat disc with a soft edge, a touch brighter at the rim.
        const edge = 0.62 + 0.25 * (1 - k);
        g.addColorStop(0, rgba(base, 0.6)); g.addColorStop(edge * 0.9, rgba(base, 0.62)); g.addColorStop(edge, rgba(base, 0.5)); g.addColorStop(1, rgba(base, 0));
      }
      c.fillStyle = g; c.fillRect(0, 0, n, n);
      return cv;
    });
    spriteKey = `${rgb}:${light}`;
  }

  // Streams: each a curve in 3D whose shape drifts over time.
  const STREAMS = Array.from({ length: 6 }, (_, k) => ({
    A: 150 + Math.random() * 120, B: 90 + Math.random() * 90, C: 120 + Math.random() * 120,
    a: 1 + Math.floor(Math.random() * 2), b: 1 + Math.floor(Math.random() * 3), c: 1 + Math.floor(Math.random() * 2),
    p: Math.random() * 6, q: Math.random() * 6, r: Math.random() * 6,
    w: (0.05 + Math.random() * 0.08) * (k % 2 ? 1 : -1), flow: 0.03 + Math.random() * 0.05,
  }));
  const streamAt = (s, u, t, amp) => [
    s.A * amp * Math.sin(s.a * u + s.p + t * s.w),
    s.B * amp * Math.sin(s.b * u + s.q + t * s.w * 1.3),
    s.C * amp * Math.cos(s.c * u + s.r + t * s.w * 0.8),
  ];
  const PARTS = [];
  for (let i = 0; i < 3000; i++) {
    const free = Math.random() < 0.36;
    const tight = Math.random() < 0.55;                   // filament lines vs looser ribbons
    const sp = free ? 0 : tight ? 0.6 + Math.random() * 1.8 : 6 + Math.random() * 22;
    const g = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
    PARTS.push(free
      ? { free: true, x: (Math.random() - 0.5) * 640, y: (Math.random() - 0.5) * 460, z: (Math.random() - 0.5) * 560, vx: (Math.random() - 0.5) * 6, vy: (Math.random() - 0.5) * 4, tw: Math.random() * 6, m: 0.5 + Math.random() * 0.6 }
      : { s: STREAMS[i % STREAMS.length], u: Math.random() * Math.PI * 2, ox: g() * sp, oy: g() * sp, oz: g() * sp, tw: Math.random() * 6, m: 0.7 + Math.random() * 0.5 });
  }

  function drawWave(t, dt, st, flare) {
    if (!sprites || spriteKey !== `${rgb}:${light}`) buildSprites();
    const S = scale, W = canvas.width, H = canvas.height;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = light ? "source-over" : "lighter";

    const flowK = { idle: 1, listening: 1.6, thinking: 4, speaking: 2 }[st] + low * 6 + flare * 4;
    wt += dt * (1 + low * 2.5 + (st === "thinking" ? 1.5 : 0));
    yaw += dt * (0.05 + (st === "thinking" ? 0.25 : 0) + low * 0.12);
    const amp = 1 + low * 0.22 + flare * 0.2 - (st === "thinking" ? 0.18 : 0);
    const surge = low * 16 + flare * 10;
    const glow = (light ? 0.65 : 1.15) + low * 0.6 + level * 0.2 + flare * 0.6;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);

    for (const p of PARTS) {
      let x, y, z;
      if (p.free) {
        p.x += p.vx * dt * flowK; p.y += p.vy * dt * flowK;
        if (p.x > 320) p.x -= 640; else if (p.x < -320) p.x += 640;
        if (p.y > 230) p.y -= 460; else if (p.y < -230) p.y += 460;
        x = p.x; y = p.y; z = p.z;
      } else {
        p.u += p.s.flow * flowK * dt;
        const [bx, by, bz] = streamAt(p.s, p.u, wt, amp);
        x = bx + p.ox; y = by + p.oy + Math.sin(p.u * 6 - wt * 5) * surge; z = bz + p.oz;
      }
      // Turn the field, then project through the camera.
      const rx = x * cy + z * sy, rz = -x * sy + z * cy;
      const persp = CAM / (CAM + rz);
      if (persp <= 0) continue;
      const sx = CX + rx * persp, syy = CY + y * persp;
      const blur = rz < FOCUS ? Math.min(1, Math.max(0, -rz - 60) / 200) : Math.min(0.35, Math.max(0, rz - 120) / 400);
      const level_ = Math.min(BLURS - 1, Math.round(blur * (BLURS - 1)));
      const size = (rz < FOCUS ? 1.6 + blur * 16 : 1.6 + blur * 2) * persp * p.m;
      // Fade at the edges of the dial, and calm the area behind the centre text.
      const ex = (sx - CX) / 280, ey = (syy - CY) / 215, vign = Math.max(0, 1 - Math.max(0, Math.hypot(ex, ey) - 0.6) / 0.3);   // gone before the canvas edge
      const tx = (sx - CX) / 92, ty = (syy - CY - 8) / 108, e = tx * tx + ty * ty;
      const calm = e >= 1 ? 1 : 0.2 + 0.8 * e;
      const tw = 0.75 + 0.25 * Math.sin(t * (1.2 + high * 10) + p.tw);
      const a = Math.min(1, glow * tw * vign * calm * (level_ ? 0.6 - blur * 0.2 : 1));
      if (a < 0.02) continue;
      ctx.globalAlpha = a;
      const d = size * S * (level_ ? 1 : 3.4);
      ctx.drawImage(sprites[level_], sx * S - d / 2, syy * S - d / 2, d, d);
    }
    ctx.globalAlpha = 1;
  }

  // ---------- loop ----------
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let on = true, last = performance.now(), lastDraw = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (!on) return;
    const st = state();
    // 30 fps when idle, full rate when active; hardly any when motion is reduced.
    const minGap = reduced.matches ? 500 : st === "idle" ? 33 : 0;
    if (now - lastDraw < minGap) return;
    lastDraw = now;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    readSound(st);
    const flare = Math.max(0, 1 - (now - flareAt) / 900);
    drawWave(reduced.matches ? 0 : now / 1000, reduced.matches ? 0.016 : dt, st, flare);
  }
  requestAnimationFrame(frame);

  function setOn(v) {
    on = !!v;
    document.documentElement.dataset.core = on ? "on" : "off"; // lets CSS hide the dial rings
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  window.JarvisCore = { setOn, isOn: () => on, flare: () => { flareAt = performance.now(); } };
})();
