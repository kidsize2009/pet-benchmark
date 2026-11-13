// Follow-me, mobile 9:16 720p: three Seedance 2.0 clips on Replicate for ONE photo.
//   left  - head turns toward the left side of the frame (no end frame)
//   right - head turns toward the right side of the frame (no end frame)
//   idle  - breathing + one blink, start frame = end frame = the photo
//
// Run from the repo root (C:\MyProjects\pet-benchmark):
//   node src/follow-916.mjs "C:\MyProjects\_follow_photos\ragdoll-916.png"
// Safe to re-run: a clip that already has a prediction id is never resubmitted,
// it is polled / downloaded instead. The token is read from .env and never printed.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "out", "follow-916");
const STATE = path.join(OUT, "state.json");
const API = "https://api.replicate.com/v1";
const CREATE_URL = `${API}/models/bytedance/seedance-2.0/predictions`;
const DURATION = 4, USD_PER_SEC = 0.18, CAP_USD = 2.5;

const TURN = (side) => `Locked camera. The pet starts looking straight into the camera. It slowly turns only its head toward the ${side} side of the frame, about 30 degrees, at a constant steady speed, and holds that pose until the end. Eyes stay open the whole time, no blinking. Ears, mouth and body stay still. Preserve the exact pet identity, fur pattern and background. No morphing, no new objects.`;
const IDLE = "Locked camera. The pet keeps its head completely still in exactly the original pose, looking straight into the camera. It breathes calmly: the chest rises and falls slowly. Halfway through it blinks once, slowly. Ears, mouth and tongue stay as they are. Ends in exactly the original pose. Preserve the exact pet identity, fur pattern and background. No head movement, no morphing, no new objects.";
const CLIPS = [
  { name: "left", prompt: TURN("left"), endFrame: false },
  { name: "right", prompt: TURN("right"), endFrame: false },
  { name: "idle", prompt: IDLE, endFrame: true },
];

const photoPath = process.argv[2];
if (!photoPath || !existsSync(photoPath)) {
  console.error('Usage: node src/follow-916.mjs "C:\\path\\to\\photo.png"   (photo not found)');
  process.exit(1);
}

async function readToken() {
  const env = await readFile(path.join(root, ".env"), "utf8");
  const m = env.match(/^\s*REPLICATE_API_TOKEN\s*=\s*["']?([^"'\r\n]+)["']?\s*$/m);
  if (!m) throw new Error("REPLICATE_API_TOKEN not found in .env");
  return m[1].trim();
}
const TOKEN = await readToken();
const redact = (t) => String(t).split(TOKEN).join("[redacted]").slice(0, 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function call(method, url, body) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 60000);
  try {
    const res = await fetch(url, { method, signal: ctl.signal,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return [res.status, await res.text()];
  } finally { clearTimeout(t); }
}

await mkdir(OUT, { recursive: true });
const state = existsSync(STATE) ? JSON.parse(await readFile(STATE, "utf8")) : { photo: photoPath, jobs: {} };
if (state.photo !== photoPath) {
  console.error(`state.json belongs to another photo (${state.photo}). Move out/follow-916 away first.`);
  process.exit(1);
}
const save = () => writeFile(STATE, JSON.stringify(state, null, 2));
const spent = () => Object.values(state.jobs).filter((j) => j.status === "done").length * DURATION * USD_PER_SEC;

const buf = await readFile(photoPath);
const uri = `data:${/\.png$/i.test(photoPath) ? "image/png" : "image/jpeg"};base64,${buf.toString("base64")}`;

// 1) create the missing predictions (all three run in parallel on Replicate)
for (const c of CLIPS) {
  const job = state.jobs[c.name];
  if (job?.predictionId) continue;
  const booked = Object.values(state.jobs).filter((j) => j.predictionId && j.status !== "failed").length;
  if ((booked + 1) * DURATION * USD_PER_SEC > CAP_USD) { log(`cap $${CAP_USD} reached, not creating ${c.name}`); break; }
  const input = { image: uri, prompt: c.prompt, duration: DURATION, resolution: "720p",
    aspect_ratio: "9:16", generate_audio: false, ...(c.endFrame ? { last_frame_image: uri } : {}) };
  let code, text;
  try { [code, text] = await call("POST", CREATE_URL, { input }); }
  catch (e) { log(`create ${c.name}: no answer from Replicate. STOP. Check replicate.com/predictions before re-running.`); process.exit(1); }
  if (code < 200 || code >= 300) {
    log(`CREATE FAILED ${code} for ${c.name}: ${redact(text)}`);
    log("Stopped. A rejected create is not billed."); await save(); process.exit(1);
  }
  const p = JSON.parse(text);
  state.jobs[c.name] = { predictionId: p.id, status: "submitted", file: null };
  await save();                                 // id saved BEFORE polling: never resubmitted
  log(`created ${c.name}: ${p.id}`);
}

// 2) poll + download
const pending = () => CLIPS.filter((c) => state.jobs[c.name]?.predictionId && !["done", "failed"].includes(state.jobs[c.name].status));
for (let i = 0; i < 300 && pending().length; i++) {
  for (const c of pending()) {
    const job = state.jobs[c.name];
    let code, text;
    try { [code, text] = await call("GET", `${API}/predictions/${job.predictionId}`); } catch { continue; }
    if (code !== 200) continue;
    const p = JSON.parse(text);
    if (p.status === "failed" || p.status === "canceled") {
      job.status = "failed"; job.error = redact(p.error || p.status); await save();
      log(`${c.name} ${p.status}: ${job.error}`); continue;
    }
    if (p.status !== "succeeded") continue;
    const url = Array.isArray(p.output) ? p.output[0] : p.output;
    const res = await fetch(url);
    if (!res.ok) { log(`${c.name}: download ${res.status}, will retry`); continue; }
    const file = path.join(OUT, `${c.name}.mp4`);
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    job.status = "done"; job.file = file; await save();
    log(`DONE ${c.name} -> out\\follow-916\\${c.name}.mp4`);
  }
  if (pending().length) { if (i % 10 === 0) log(`waiting: ${pending().map((c) => c.name).join(", ")}`); await sleep(4000); }
}
const done = CLIPS.filter((c) => state.jobs[c.name]?.status === "done").map((c) => c.name);
log(`finished: ${done.length}/3 done (${done.join(", ") || "none"}), spent ≈ $${spent().toFixed(2)}`);
if (done.length < 3) { log("Not all clips are done: re-run the same command (it only polls/downloads, never resubmits)."); process.exitCode = 1; }
