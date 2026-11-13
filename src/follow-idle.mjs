// Idle (breathing + one blink) clips for the follow demo, Replicate Seedance 2.0.
// Run from tools/pet-benchmark:
//   node src/follow-idle.mjs --one   -> sends ONLY the first photo (format check)
//   node src/follow-idle.mjs         -> the remaining photos
// Safe to re-run: a job that already has a prediction id is never resubmitted,
// it is polled/downloaded instead. The token is read from .env and never printed.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEMO = path.join(root, "out", "follow-demo");
const STATE = path.join(DEMO, "state.json");
const CLIPS = path.join(DEMO, "clips");
const PHOTO_DIR = "C:\\MyProjects\\_follow_photos";
const SKIP = "file-00000000b82881f4920564827bf088ba-pn";
const ORDER = ["n46yfixophpcf5fhncwn3a-png", "file-0000000016e081f4833ba05ab8c2e27c-pn",
  "file-00000000761c81f4a2e5be776c53d0f5-pn", "file-0000000099548246b7cc35eddaeb3e69-pn"];
const API = "https://api.replicate.com/v1";
const CREATE_URL = `${API}/models/bytedance/seedance-2.0/predictions`;
const DURATION = 4, USD_PER_SEC = 0.18, CAP_USD = 4, MAX_DONE = 4;
const PROMPT = "Locked camera. The pet keeps its head completely still in exactly the original pose, looking straight into the camera. It breathes calmly: the chest rises and falls slowly. Halfway through it blinks once, slowly. Ears, mouth and tongue stay as they are. Ends in exactly the original pose. Preserve the exact pet identity, fur pattern and background. No head movement, no morphing, no new objects.";

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
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(url, { method, signal: ctl.signal,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return [res.status, await res.text()];
  } finally { clearTimeout(t); }
}

const state = JSON.parse(await readFile(STATE, "utf8"));
const save = () => writeFile(STATE, JSON.stringify(state, null, 2));
// drop the old failed idle jobs that never got a prediction id (422, nothing billed)
state.jobs = state.jobs.filter((j) => !(j.direction === "idle" && !j.predictionId));
const idleJob = (id) => state.jobs.find((j) => j.direction === "idle" && j.photoId === id);
const idleSpend = () => state.jobs.filter((j) => j.direction === "idle" && j.status === "done")
  .reduce((s, j) => s + (j.costUsd || 0), 0);
await save();
await mkdir(CLIPS, { recursive: true });

const onlyOne = process.argv.includes("--one");
const targets = onlyOne ? ORDER.slice(0, 1) : ORDER;
let exitCode = 0;

for (const id of targets) {
  if (id === SKIP) continue;
  const photo = state.photos.find((p) => p.id === id);
  if (!photo) { log("photo not in state:", id); continue; }
  let job = idleJob(id);
  if (job?.status === "done") { log("already done", id); continue; }
  if (!job) {
    const done = state.jobs.filter((j) => j.direction === "idle" && j.status === "done").length;
    if (done >= MAX_DONE) { log("max idle clips reached"); break; }
    if (idleSpend() + DURATION * USD_PER_SEC > CAP_USD) { log(`idle cap $${CAP_USD} reached`); break; }
    const buf = await readFile(path.join(PHOTO_DIR, photo.file));
    const mime = /\.png$/i.test(photo.file) ? "image/png" : "image/jpeg";
    const uri = `data:${mime};base64,${buf.toString("base64")}`;
    const input = { image: uri, last_frame_image: uri, prompt: PROMPT, duration: DURATION,
      resolution: "720p", aspect_ratio: photo.aspect, generate_audio: false };
    const [code, text] = await call("POST", CREATE_URL, { input });
    if (code < 200 || code >= 300) {
      log(`CREATE FAILED ${code} for ${id}: ${redact(text)}`);
      log("Stopping. Nothing was billed for a rejected create.");
      exitCode = 1; break;
    }
    const p = JSON.parse(text);
    job = { photo: id, photoFile: photo.file, photoId: id, direction: "idle", aspect: photo.aspect,
      prompt: PROMPT, status: "submitted", predictionId: p.id, attempts: 1, clipPath: null,
      durationSec: DURATION, costUsd: 0, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    state.jobs.push(job); await save();          // id saved BEFORE polling: never resubmitted
    log(`created ${id} prediction=${p.id} (status ${p.status})`);
  }
  // poll (max ~12 min)
  let out = null;
  for (let i = 0; i < 240; i++) {
    let code, text;
    try { [code, text] = await call("GET", `${API}/predictions/${job.predictionId}`); }
    catch (e) { log("poll transport error, retrying"); await sleep(5000); continue; }
    if (code !== 200) { log(`poll ${code}, retrying`); await sleep(5000); continue; }
    const p = JSON.parse(text);
    if (p.status === "succeeded") { out = Array.isArray(p.output) ? p.output[0] : p.output; break; }
    if (p.status === "failed" || p.status === "canceled") {
      job.status = "failed"; job.error = redact(p.error || p.status); await save();
      log(`prediction ${p.status} for ${id}: ${job.error}`); break;
    }
    if (i % 10 === 0) log(`${id}: ${p.status}...`);
    await sleep(3000);
  }
  if (!out) { if (job.status !== "failed") log(`still running ${id} — re-run later to fetch it`); exitCode = 1; continue; }
  const res = await fetch(out);
  if (!res.ok) { log(`download ${res.status} for ${id} — re-run soon (links expire ~1h)`); exitCode = 1; continue; }
  const clip = path.join(CLIPS, `${id}-idle.mp4`);
  await writeFile(clip, Buffer.from(await res.arrayBuffer()));
  job.status = "done"; job.clipPath = clip; job.costUsd = DURATION * USD_PER_SEC;
  job.updatedAt = new Date().toISOString(); await save();
  log(`DONE ${id} -> clips\\${id}-idle.mp4  idle spend so far $${idleSpend().toFixed(2)}`);
}
log(`finished. idle clips done: ${state.jobs.filter((j) => j.direction === "idle" && j.status === "done").length}, idle spend ≈ $${idleSpend().toFixed(2)}`);
process.exitCode = exitCode;
