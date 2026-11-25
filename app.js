"use strict";
/* SenecaTalk Avatar Studio, phone version. Everything runs in the browser; nothing is uploaded. */
const $ = (id) => document.getElementById(id);
const FPS = 30, PAD_FRAC = 0.2;
const DEF_SIZE = { "corner|16:9": 0.42, "corner|9:16": 0.30, "centered|16:9": 0.74, "centered|9:16": 0.50 };
const SHAKE_DEFAULTS = { intensity: 1, speed: 14, threshold: 0.12 };
const DEFAULTS = {
  layout: "corner", aspect: "9:16", side: "left", size: null, ax: null, ay: null, outline: true,
  bgType: "color", bgColor: "#ece7de", gameVol: 0.3, ...SHAKE_DEFAULTS,
};
let st = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("avatarStudioPhone") || "{}") };
if (st.bgType !== "color") st.bgType = "color"; // chosen files do not survive a restart

const cv = $("cv"), ctx = cv.getContext("2d"), bg = $("bg");
const avatar = { true: new Image(), false: new Image() };
avatar.true.src = "avatar-outline.png"; avatar.false.src = "avatar.png";
const bgImage = new Image();
let avatarAspect = 0.645;
avatar.false.onload = () => {
  // The image carries transparent padding of PAD_FRAC x avatar height on every side.
  const h = avatar.false.naturalHeight / (1 + 2 * PAD_FRAC), w = avatar.false.naturalWidth - 2 * PAD_FRAC * h;
  avatarAspect = w / h; lay = layout();
};

let ac = null, nodes = null;          // audio graph, built on the first tap
let voice = null, voiceGain = 1;      // decoded take and its levelling gain
let track = [], lay = null;
let cur = null, t0 = 0, pausedT = 0;  // playback
let rec = null, exporting = false, wake = null, resultFile = null;

// ---------- helpers ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
function status(msg, isError) { $("status").textContent = msg; $("status").classList.toggle("error", !!isError); }
function save() { localStorage.setItem("avatarStudioPhone", JSON.stringify(st)); }
const sizeNow = () => st.size || DEF_SIZE[`${st.layout}|${st.aspect}`];
const duration = () => (voice ? voice.duration : 0);
const playing = () => !!cur;
const now = () => (cur ? Math.min(duration(), ac.currentTime - t0) : pausedT);
const hasVideo = () => st.bgType === "video" && !!bg.src;
async function keepAwake(on) {
  try { if (on && "wakeLock" in navigator) wake = await navigator.wakeLock.request("screen"); else if (!on && wake) { await wake.release(); wake = null; } } catch { /* optional */ }
}

// ---------- layout (same numbers as the PC app) ----------
function layout() {
  const wide = st.aspect === "16:9", W = wide ? 1920 : 1080, H = wide ? 1080 : 1920;
  const hA = Math.round(sizeNow() * H), wA = Math.round(hA * avatarAspect);
  let x, y;
  if (st.layout === "corner") {
    const m = Math.round(0.025 * W);
    x = st.side === "left" ? m : W - m - wA; y = H - hA - Math.round(0.02 * H);
  } else { x = Math.round((W - wA) / 2); y = Math.round((wide ? 0.03 : 0.14) * H); }
  if (st.ax != null && st.ay != null) {
    x = clamp(Math.round(st.ax * W - wA / 2), -wA / 2, W - wA / 2);
    y = clamp(Math.round(st.ay * H - hA / 2), -hA / 2, H - hA / 2);
  }
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  return { W, H, x, y, wA, hA };
}

// ---------- shake (same method as the PC app) ----------
function mulberry(seed) { return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function monoSamples(buf) {
  const n = buf.length, out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / buf.numberOfChannels; }
  return out;
}
function envelope(samples, rate) {
  const hop = Math.round(rate / 100), win = hop * 3, n = Math.max(1, Math.floor(samples.length / hop));
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; const a = i * hop, b = Math.min(samples.length, a + win); for (let j = a; j < b; j++) s += samples[j] * samples[j]; rms[i] = Math.sqrt(s / win); }
  const voiced = Array.from(rms).filter((v) => v > 1e-4).sort((a, b) => a - b);
  const ref = voiced.length ? voiced[Math.min(voiced.length - 1, Math.floor(voiced.length * 0.95))] : 1;
  const att = Math.exp(-1 / (100 * 0.015)), rel = Math.exp(-1 / (100 * 0.090)), env = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.min(1, rms[i] / Math.max(ref, 1e-6)), c = v > prev ? att : rel;
    prev = c * prev + (1 - c) * v;
    env[i] = Math.pow(clamp((prev - st.threshold) / (1 - st.threshold), 0, 1), 0.7);
  }
  return { env, ref };
}
function computeTrack() {
  track = [];
  if (!voice) return;
  const { env } = envelope(monoSamples(voice), voice.sampleRate);
  const frames = Math.floor(env.length * FPS / 100), rnd = mulberry(7), keys = [];
  for (let i = 0; i < Math.floor((frames / FPS) * st.speed) + 3; i++) keys.push([rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1]);
  for (let f = 0; f < frames; f++) {
    const t = f / FPS, amp = env[Math.min(env.length - 1, Math.round(t * 100))];
    const pos = t * st.speed, i0 = Math.floor(pos); let fr = pos - i0; fr = fr * fr * (3 - 2 * fr);
    const a = keys[i0], b = keys[i0 + 1];
    track.push([0, 1, 2].map((k) => (a[k] * (1 - fr) + b[k] * fr) * (k < 2 ? 0.011 : 1.1) * st.intensity * amp));
  }
}

// ---------- sound ----------
async function ensureAudio() {
  if (!ac) {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    const hp = ac.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 70;
    const vGain = ac.createGain(), gGain = ac.createGain(), master = ac.createGain(), out = ac.createMediaStreamDestination();
    hp.connect(vGain); vGain.connect(master); gGain.connect(master);
    master.connect(ac.destination); master.connect(out);
    ac.createMediaElementSource(bg).connect(gGain);
    nodes = { hp, vGain, gGain, master, out };
  }
  if (ac.state !== "running") await ac.resume();
  nodes.gGain.gain.value = st.gameVol;
}
async function loadVoice(blob) {
  await ensureAudio();
  const data = await blob.arrayBuffer();
  voice = await new Promise((ok, bad) => ac.decodeAudioData(data, ok, bad));
  const mono = monoSamples(voice), { ref } = envelope(mono, voice.sampleRate);
  let peak = 0; for (let i = 0; i < mono.length; i++) peak = Math.max(peak, Math.abs(mono[i]));
  voiceGain = clamp(Math.min(0.16 / Math.max(ref, 1e-4), 0.95 / Math.max(peak, 1e-4)), 0.25, 8);
  pausedT = 0; computeTrack(); syncControls();
  $("seek").max = duration();
}
function stop(atEnd) {
  if (cur) { cur.onended = null; try { cur.stop(); } catch { /* already stopped */ } cur = null; }
  if (atEnd) pausedT = 0;
  bg.pause(); $("play").textContent = "▶ Play";
}
async function play(from) {
  await ensureAudio();
  stop();
  const src = ac.createBufferSource(); src.buffer = voice; src.connect(nodes.hp);
  nodes.vGain.gain.value = voiceGain;
  t0 = ac.currentTime - from; src.start(0, from); cur = src;
  src.onended = () => { if (cur === src) { stop(true); if (exporting) finishExport(); } };
  if (hasVideo()) { bg.currentTime = from % (bg.duration || 1); bg.play().catch(() => {}); }
  $("play").textContent = "❚❚ Pause";
}
$("play").addEventListener("click", () => { if (playing()) { pausedT = now(); stop(); } else play(pausedT >= duration() - 0.05 ? 0 : pausedT); });
$("seek").addEventListener("input", () => { const t = parseFloat($("seek").value); if (playing()) play(t); else { pausedT = t; if (hasVideo()) bg.currentTime = t % (bg.duration || 1); } });

// ---------- recording ----------
$("rec").addEventListener("click", async () => {
  if (rec) { rec.recorder.stop(); return; }
  try {
    await ensureAudio(); stop();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const analyser = ac.createAnalyser(); analyser.fftSize = 1024;
    const micSrc = ac.createMediaStreamSource(stream); micSrc.connect(analyser);
    const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m));
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {}), parts = [];
    recorder.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop()); micSrc.disconnect(); bg.pause(); keepAwake(false);
      rec = null; $("rec").textContent = "● Record"; $("rec").classList.remove("recording");
      status("Processing your take…");
      try { await loadVoice(new Blob(parts, { type: recorder.mimeType })); status(`Recorded ${fmt(duration())}. Tap Play to preview.`); }
      catch (e) { status("That take could not be read. Try again.", true); }
    };
    if (hasVideo()) { bg.currentTime = 0; bg.play().catch(() => {}); } // talk over the gameplay
    recorder.start(); keepAwake(true);
    rec = { recorder, analyser, buf: new Float32Array(analyser.fftSize), started: performance.now(), env: 0, max: 0.05, a: [0, 0, 0], b: [0, 0, 0], key: 0 };
    $("rec").textContent = "■ Stop"; $("rec").classList.add("recording");
    status("Recording… speak now.");
  } catch (e) {
    status("Microphone not available. Allow the microphone for this app in Safari, then try again.", true);
  }
});
function liveShake(ms) {
  rec.analyser.getFloatTimeDomainData(rec.buf);
  let s = 0; for (const v of rec.buf) s += v * v;
  const rms = Math.sqrt(s / rec.buf.length);
  rec.max = Math.max(rec.max * 0.9995, rms);
  const level = Math.min(1, rms / rec.max);
  rec.env += (level - rec.env) * (level > rec.env ? 0.6 : 0.15);
  const amp = Math.pow(Math.max(0, (rec.env - st.threshold) / (1 - st.threshold)), 0.7);
  const pos = (ms / 1000) * st.speed, k = Math.floor(pos);
  if (k !== rec.key) { rec.key = k; rec.a = rec.b; rec.b = [0, 0, 0].map(() => Math.random() * 2 - 1); }
  let f = pos - k; f = f * f * (3 - 2 * f);
  return rec.a.map((v, i) => (v * (1 - f) + rec.b[i] * f) * (i < 2 ? 0.011 : 1.1) * st.intensity * amp);
}

// ---------- files ----------
$("voiceFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  status("Reading the recording…");
  try { await loadVoice(f); status(`Loaded ${fmt(duration())}. Tap Play to preview.`); showTab("layout"); }
  catch { status("That file could not be read as sound.", true); }
  e.target.value = "";
});
$("videoFile").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  if (bg.src) URL.revokeObjectURL(bg.src);
  bg.src = URL.createObjectURL(f); bg.load();
  $("videoName").textContent = f.name; st.bgType = "video"; changed();
  status("Gameplay loaded.");
});
$("imageFile").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  bgImage.src = URL.createObjectURL(f); st.bgType = "image"; changed();
});

// ---------- export ----------
let exp = null;
$("export").addEventListener("click", async () => {
  if (exporting || !voice) return;
  try {
    await ensureAudio(); stop();
    const mime = ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime || !cv.captureStream) throw new Error("This browser cannot record video from the page.");
    const stream = new MediaStream([...cv.captureStream(FPS).getVideoTracks(), ...nodes.out.stream.getAudioTracks()]);
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000, audioBitsPerSecond: 192_000 });
    const parts = [];
    recorder.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    recorder.onstop = () => {
      exporting = false; keepAwake(false); $("prog").hidden = true; $("export").disabled = false; $("rec").disabled = false;
      const type = mime.split(";")[0], ext = type === "video/mp4" ? "mp4" : "webm";
      const blob = new Blob(parts, { type });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
      resultFile = new File([blob], `seneca_${stamp}.${ext}`, { type });
      const url = URL.createObjectURL(blob);
      $("resultVideo").src = url; $("download").href = url; $("download").download = resultFile.name;
      $("share").hidden = !(navigator.canShare && navigator.canShare({ files: [resultFile] }));
      $("result").hidden = false; $("exportNote").hidden = true;
      status(`Export finished: ${(blob.size / 1048576).toFixed(1)} MB.`);
    };
    exp = recorder; exporting = true; $("export").disabled = true; $("rec").disabled = true;
    $("result").hidden = true; $("prog").hidden = false; $("prog").value = 0; keepAwake(true);
    status("Exporting… keep this screen open.");
    recorder.start(1000);
    await play(0);
  } catch (e) { exporting = false; status(e.message, true); $("export").disabled = false; $("rec").disabled = false; }
});
function finishExport() { setTimeout(() => { if (exp && exp.state !== "inactive") exp.stop(); }, 200); }
$("share").addEventListener("click", async () => {
  try { await navigator.share({ files: [resultFile] }); } catch { /* cancelled */ }
});
document.addEventListener("visibilitychange", () => { if (document.hidden && exporting) status("Export was interrupted because the app went to the background. Export again.", true); });

// ---------- controls ----------
function showTab(name) {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => { p.hidden = p.id !== "p-" + name; });
}
$("tabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) showTab(b.dataset.tab); });
function syncControls() {
  document.querySelectorAll(".seg").forEach((seg) => seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", st[seg.dataset.key] === b.dataset.v)));
  $("sideRow").hidden = st.layout !== "corner";
  $("size").value = sizeNow(); $("sizeOut").textContent = Math.round(sizeNow() * 100) + "%";
  $("outline").checked = st.outline;
  $("bgVideoBox").hidden = st.bgType !== "video"; $("bgImageBox").hidden = st.bgType !== "image"; $("bgColorBox").hidden = st.bgType !== "color";
  $("bgColor").value = st.bgColor;
  $("gameVol").value = st.gameVol; $("gameVolOut").textContent = Math.round(st.gameVol * 100) + "%";
  $("intensity").value = st.intensity; $("intensityOut").textContent = st.intensity.toFixed(1) + "×";
  $("speed").value = st.speed; $("speedOut").textContent = st.speed + " /s";
  $("threshold").value = st.threshold; $("thresholdOut").textContent = Math.round(st.threshold * 100) + "%";
  $("play").disabled = $("seek").disabled = $("export").disabled = !voice || exporting;
  if (nodes) nodes.gGain.gain.value = st.gameVol;
}
function changed(recompute) { save(); lay = layout(); if (recompute) computeTrack(); syncControls(); }
document.querySelectorAll(".seg").forEach((seg) => seg.addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const key = seg.dataset.key; st[key] = b.dataset.v;
  if (key === "layout" || key === "aspect") st.size = null;
  if (key !== "bgType") st.ax = st.ay = null;
  changed();
}));
for (const id of ["size", "gameVol"]) $(id).addEventListener("input", () => { st[id] = parseFloat($(id).value); changed(); });
for (const id of ["intensity", "speed", "threshold"]) {
  $(id).addEventListener("input", () => { st[id] = parseFloat($(id).value); syncControls(); });
  $(id).addEventListener("change", () => changed(true));
}
$("outline").addEventListener("change", () => { st.outline = $("outline").checked; changed(); });
$("bgColor").addEventListener("input", () => { st.bgColor = $("bgColor").value; save(); });
$("resetShake").addEventListener("click", () => { Object.assign(st, SHAKE_DEFAULTS); changed(true); });

// ---------- move and pinch the avatar ----------
const pointers = new Map(); let grab = null;
function point(e) { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * lay.W / r.width, (e.clientY - r.top) * lay.H / r.height]; }
cv.addEventListener("pointerdown", (e) => {
  const [px, py] = point(e);
  const slack = lay.hA * 0.15;
  if (px < lay.x - slack || px > lay.x + lay.wA + slack || py < lay.y - slack || py > lay.y + lay.hA + slack) return;
  cv.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [px, py]);
  if (pointers.size === 1) grab = { dx: px - lay.x, dy: py - lay.y };
  else { const [a, b] = [...pointers.values()]; grab = { pinch: Math.hypot(a[0] - b[0], a[1] - b[1]), size: sizeNow() }; }
});
cv.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId) || !grab) return;
  const p = point(e); pointers.set(e.pointerId, p);
  if (grab.pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    if (st.ax == null) { st.ax = (lay.x + lay.wA / 2) / lay.W; st.ay = (lay.y + lay.hA / 2) / lay.H; }
    st.size = clamp(grab.size * Math.hypot(a[0] - b[0], a[1] - b[1]) / grab.pinch, 0.15, 0.95);
  } else if (!grab.pinch) {
    st.ax = (p[0] - grab.dx + lay.wA / 2) / lay.W; st.ay = (p[1] - grab.dy + lay.hA / 2) / lay.H;
  }
  lay = layout();
});
function release(e) { pointers.delete(e.pointerId); if (!pointers.size) { grab = null; changed(); } else grab = null; }
cv.addEventListener("pointerup", release); cv.addEventListener("pointercancel", release);

// ---------- drawing ----------
function cover(src, sw, sh) {
  const s = Math.max(cv.width / sw, cv.height / sh), w = sw * s, h = sh * s;
  ctx.drawImage(src, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
}
function draw(ms) {
  requestAnimationFrame(draw);
  if (!lay) return;
  const t = now(), isPlaying = playing();
  if (st.bgType === "video" && bg.readyState >= 2) {
    if (isPlaying && !rec) { const want = t % (bg.duration || 1); if (Math.abs(bg.currentTime - want) > 0.35 && !bg.seeking) bg.currentTime = want; }
    cover(bg, bg.videoWidth, bg.videoHeight);
  } else if (st.bgType === "image" && bgImage.complete && bgImage.naturalWidth) cover(bgImage, bgImage.naturalWidth, bgImage.naturalHeight);
  else { ctx.fillStyle = st.bgColor; ctx.fillRect(0, 0, cv.width, cv.height); }

  let sh = [0, 0, 0];
  if (rec) sh = liveShake(ms);
  else if (isPlaying && track.length) sh = track[Math.min(track.length - 1, Math.floor(t * FPS))];
  const img = avatar[st.outline];
  if (img.complete && img.naturalWidth) {
    const pad = PAD_FRAC * lay.hA;
    ctx.save();
    ctx.translate(lay.x + lay.wA / 2 + sh[0] * lay.hA, lay.y + lay.hA / 2 + sh[1] * lay.hA);
    ctx.rotate(-sh[2] * Math.PI / 180);
    ctx.drawImage(img, -lay.wA / 2 - pad, -lay.hA / 2 - pad, lay.wA + 2 * pad, lay.hA + 2 * pad);
    ctx.restore();
  }
  if (rec) $("time").textContent = "REC " + fmt((ms - rec.started) / 1000);
  else {
    $("time").textContent = `${fmt(t)} / ${fmt(duration())}`;
    if (isPlaying) { $("seek").value = t; if (exporting) $("prog").value = t / Math.max(0.01, duration()); }
  }
}

// ---------- start ----------
lay = layout(); syncControls(); requestAnimationFrame(draw);
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
