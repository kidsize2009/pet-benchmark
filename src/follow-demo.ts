// tools/pet-benchmark/src/follow-demo.ts
// Prototype: "pet turns its head toward the viewer" — Replicate (Seedance 2.0
// image-to-video) generation, then frame extraction, per-photo sequence
// manifests and contact sheets for out/follow-demo/.
// Model slug: bytedance/seedance-2.0 (exact slug from petmotion2's Replicate
// client src/lib/replicate.server.ts). Input schema read from the Replicate API
// before calling: image, prompt, duration, resolution, aspect_ratio,
// generate_audio, last_frame_image — field names differ from fal and are NOT
// copied from fal. No end frame, duration 4 s, 720p, audio off.
// REPLICATE_API_TOKEN is loaded from .env via dotenv (same as this repo and
// petmotion2). Read inside functions only, NEVER printed or logged.
// Sequential, resumable via state.json. Budget guards: max 10 successful
// predictions, max 2 retries per clip, hard cap $9 ($0.18/s basis), hard stop
// on 402 / billing / "insufficient credit". Each invocation is time-bounded;
// re-run until exit 2, then `npx tsx src/follow-demo.ts frames`.

import { config as loadEnv } from "dotenv";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: path.join(root, ".env") });

const TOKEN = process.env.REPLICATE_API_TOKEN;
if (!TOKEN || !TOKEN.startsWith("r8_")) {
  throw new Error(
    "REPLICATE_API_TOKEN is missing or invalid. Add it to tools/pet-benchmark/.env, e.g.:\n  REPLICATE_API_TOKEN=r8_...\n" +
      "The token is read from .env only and is never printed.",
  );
}

// ------------------------------------------------------------------ config
const API = "https://api.replicate.com/v1";
const MODEL = "bytedance/seedance-2.0";
const CREATE_URL = `${API}/models/${MODEL}/predictions`;
const predictionUrl = (id: string) => `${API}/predictions/${encodeURIComponent(id)}`;

const DURATION_SEC = 4;
const RESOLUTION = "720p";
const GENERATE_AUDIO = false;
const ESTIMATE_USD_PER_CLIP = DURATION_SEC * 0.18;
const MAX_SPEND_USD = 9;
const MAX_SUCCESSFUL = 10;
const MAX_RETRIES_PER_CLIP = 2;
const POLL_INTERVAL_MS = 3000;
const PER_INVOCATION_CAP_MS = 4 * 60 * 1000;

const FOLLOW_DEMO = path.join(root, "out", "follow-demo");
const CLIPS_DIR = path.join(FOLLOW_DEMO, "clips");
const ASSETS_DIR = path.join(FOLLOW_DEMO, "assets");
const SHEETS_DIR = path.join(FOLLOW_DEMO, "sheets");
const STATE_PATH = path.join(FOLLOW_DEMO, "state.json");
const LOG_PATH = path.join(FOLLOW_DEMO, "generate-log.json");
const PHOTOS_INDEX_PATH = path.join(FOLLOW_DEMO, "photos.json");

// Originals live outside the repo and are never copied into it.
const PHOTO_DIR = "C:\\MyProjects\\_follow_photos";

const BILLING_KEYS = ["402", "insufficient", "credit", "billing", "quota", "past due", "balance"];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const nowISO = () => new Date().toISOString();
function redactSecrets(text: string): string {
  let out = text;
  if (TOKEN) out = out.split(TOKEN).join("[redacted]");
  return out.slice(0, 500);
}
function isBillingFailure(status: number, body: string): boolean {
  if (status === 402 || status === 401 || status === 403) return true;
  const low = body.toLowerCase();
  return BILLING_KEYS.some((k) => low.includes(k));
}

function photoId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function aspectFor(w: number, h: number): "16:9" | "9:16" | "1:1" {
  const r = w / h;
  if (r > 1.3) return "16:9";
  if (r < 0.77) return "9:16";
  return "1:1";
}

const PROMPT_LEFT =
  "Locked camera. The pet starts looking straight into the camera. It slowly turns only its head toward the left side of the frame, about 30 degrees, at a constant steady speed, and holds that pose until the end. Eyes stay open the whole time, no blinking. Ears, mouth and body stay still. Preserve the exact pet identity, fur pattern and background. No morphing, no new objects.";
const PROMPT_RIGHT = PROMPT_LEFT.replace("left side of the frame", "right side of the frame");

type JobStatus = "pending" | "submitted" | "done" | "failed" | "skipped";
type Job = {
  photo: string;
  photoFile: string;
  photoId: string;
  direction: "left" | "right";
  aspect: string;
  prompt: string;
  status: JobStatus;
  predictionId: string | null;
  attempts: number;
  clipPath: string | null;
  durationSec: number | null;
  costUsd: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
type PhotoEntry = { id: string; file: string; w: number; h: number; aspect: string };
type State = {
  photos: PhotoEntry[];
  jobs: Job[];
  halted: boolean;
  haltReason: string | null;
  successful: number;
  spendUsd: number;
  log: string[];
};

function emptyState(): State {
  return { photos: [], jobs: [], halted: false, haltReason: null, successful: 0, spendUsd: 0, log: [] };
}

let state: State = emptyState();
function logLine(message: string): void {
  const line = `${nowISO()} ${message}`;
  state.log.push(line);
  console.log(line);
}
async function saveState(): Promise<void> {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}
async function saveLog(): Promise<void> {
  await writeFile(LOG_PATH, JSON.stringify(state.log, null, 2), "utf8");
}

// ------------------------------------------------------------------ ffmpeg
function runCommand(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(`${stdout}\n${stderr}`);
      else reject(new Error(`${binary} ${args.join(" ")} exited ${code}: ${stderr.slice(-1200)}`));
    });
  });
}

async function ffprobeDuration(clip: string): Promise<number | null> {
  try {
    const out = await runCommand("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", clip,
    ]);
    const seconds = Number(out.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

async function ffprobeFps(clip: string): Promise<number | null> {
  try {
    const out = await runCommand("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate",
      "-of", "default=noprint_wrappers=1:nokey=1", clip,
    ]);
    const [num, den] = out.trim().split("/").map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) return num / den;
    return null;
  } catch {
    return null;
  }
}

async function extractFrames(clip: string, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await runCommand("ffmpeg", ["-y", "-i", clip, "-qscale:v", "2", path.join(outDir, "frame_%04d.jpg")]);
}

// ------------------------------------------------------------------ Replicate
function replicateHeaders(): HeadersInit {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
}

async function createPrediction(photoBuffer: Buffer, direction: "left" | "right", aspect: string): Promise<{ id: string }> {
  const base64 = photoBuffer.toString("base64");
  const body = JSON.stringify({
    input: {
      image: `data:image/png;base64,${base64}`,
      prompt: direction === "left" ? PROMPT_LEFT : PROMPT_RIGHT,
      duration: DURATION_SEC,
      resolution: RESOLUTION,
      aspect_ratio: aspect,
      generate_audio: GENERATE_AUDIO,
      // no last_frame_image: no end frame
    },
  });
  let waits = 0;
  for (;;) {
    let res: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        res = await fetch(CREATE_URL, { method: "POST", headers: replicateHeaders(), body, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      logLine(`create unconfirmed (no response) direction=${direction}`);
      throw new Error("create_unconfirmed");
    }
    const bodyText = await res.text().catch(() => "");
    if (res.status === 429) {
      // Throttled create: no prediction exists, nothing billed. Honour Retry-After, never halt on pure throttle.
      const retryAfter = res.headers.get("retry-after");
      let waitMs = 5000;
      if (retryAfter) {
        const s = Number(retryAfter);
        waitMs = Number.isFinite(s) ? Math.min(Math.max(s, 0) * 1000, 5000) : 5000;
      }
      logLine(`create throttled (429) direction=${direction} wait=${waitMs}ms waits=${waits + 1} detail=${redactSecrets(bodyText)}`);
      if (waits >= 3) throw new Error("create_throttled");
      waits++;
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) {
      logLine(`create failed [${res.status}] direction=${direction} detail=${redactSecrets(bodyText)}`);
      if (isBillingFailure(res.status, bodyText)) throw new Error(`billing_rejection status=${res.status}`);
      throw new Error(`create_rejected status=${res.status}`);
    }
    let prediction: { id?: string };
    try {
      prediction = JSON.parse(bodyText);
    } catch {
      throw new Error("create_unconfirmed");
    }
    if (!prediction.id) throw new Error("create_unconfirmed");
    logLine(`create ok direction=${direction} predictionId=${prediction.id} aspect=${aspect}`);
    return { id: prediction.id };
  }
}

async function pollPrediction(predictionId: string): Promise<{ status: "succeeded" | "failed" | "canceled" | "pending"; outputUrl: string | null; error: string | null }> {
  let res: Response | null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      res = await fetch(predictionUrl(predictionId), { headers: { Authorization: `Bearer ${TOKEN}` }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res) return { status: "pending", outputUrl: null, error: null };
    if (res.status === 429) {
      return { status: "pending", outputUrl: null, error: null }; // throttle on poll = signal loss, stay pending
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logLine(`poll failed [${res.status}] predictionId=${predictionId} detail=${redactSecrets(text)}`);
      if (isBillingFailure(res.status, text)) throw new Error(`billing_rejection status=${res.status}`);
      return { status: "pending", outputUrl: null, error: null };
    }
    let prediction: { status?: string; output?: string | string[] | null; error?: string | null };
    try {
      prediction = await res.json();
    } catch {
      return { status: "pending", outputUrl: null, error: null };
    }
    const st = (prediction.status ?? "").toLowerCase();
    if (st === "succeeded") {
      const output = prediction.output;
      const url = typeof output === "string" ? output : Array.isArray(output) ? output.find((x) => typeof x === "string") ?? null : null;
      if (!url) return { status: "failed", outputUrl: null, error: "no output url" };
      return { status: "succeeded", outputUrl: url, error: null };
    }
    if (st === "failed" || st === "canceled") {
      return { status: st, outputUrl: null, error: prediction.error ?? `${st}ed` };
    }
    return { status: "pending", outputUrl: null, error: null };
  } catch (e) {
    if ((e as Error).message.includes("billing_rejection")) throw e;
    logLine(`poll transport error predictionId=${predictionId} ${redactSecrets(String(e))}`);
    return { status: "pending", outputUrl: null, error: null };
  }
}

async function downloadClip(url: string, destination: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(destination, buffer);
  logLine(`downloaded clip ${path.basename(destination)} ${Math.round(buffer.length / 1024)} kB`);
}

// ------------------------------------------------------------------ job pipeline
function clipPath(photoId: string, direction: "left" | "right"): string {
  return path.join(CLIPS_DIR, `${photoId}-${direction}.mp4`);
}

async function ensureDirs(): Promise<void> {
  await mkdir(FOLLOW_DEMO, { recursive: true });
  await mkdir(CLIPS_DIR, { recursive: true });
  await mkdir(ASSETS_DIR, { recursive: true });
  await mkdir(SHEETS_DIR, { recursive: true });
}

async function loadPhotos(): Promise<PhotoEntry[]> {
  const files = (await readdir(PHOTO_DIR)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort();
  const entries: PhotoEntry[] = [];
  for (const file of files) {
    const meta = await sharp(path.join(PHOTO_DIR, file)).metadata();
    if (!meta.width || !meta.height) continue;
    entries.push({ id: photoId(file), file, w: meta.width, h: meta.height, aspect: aspectFor(meta.width, meta.height) });
  }
  return entries;
}

function initJobs(photos: PhotoEntry[]): Job[] {
  const jobs: Job[] = [];
  for (const photo of photos) {
    for (const direction of ["left", "right"] as const) {
      jobs.push({
        photo: photo.id,
        photoFile: photo.file,
        photoId: photo.id,
        direction,
        aspect: photo.aspect,
        prompt: direction === "left" ? PROMPT_LEFT : PROMPT_RIGHT,
        status: "pending",
        predictionId: null,
        attempts: 0,
        clipPath: null,
        durationSec: null,
        costUsd: null,
        error: null,
        createdAt: nowISO(),
        updatedAt: nowISO(),
      });
    }
  }
  return jobs;
}

async function runOneJob(job: Job, photoBuffer: Buffer): Promise<"terminal" | "timecap"> {
  const deadline = Date.now() + PER_INVOCATION_CAP_MS;
  const logPrefix = `job ${job.photoId}/${job.direction} attempt=${job.attempts + 1}/${MAX_RETRIES_PER_CLIP + 1}`;

  if (job.status === "pending") {
    if (state.successful >= MAX_SUCCESSFUL) {
      state.halted = true;
      state.haltReason = "max_successful";
      return "terminal";
    }
    if (state.spendUsd + ESTIMATE_USD_PER_CLIP > MAX_SPEND_USD) {
      state.halted = true;
      state.haltReason = "budget_cap";
      return "terminal";
    }
    try {
      const { id } = await createPrediction(photoBuffer, job.direction, job.aspect);
      job.predictionId = id;
      job.status = "submitted";
      job.attempts++;
      job.updatedAt = nowISO();
      await saveState();
    } catch (e) {
      const message = (e as Error).message;
      job.attempts++;
      job.updatedAt = nowISO();
      if (message.includes("billing_rejection")) {
        state.halted = true;
        state.haltReason = "billing";
        logLine(`HALTS billing ${logPrefix}`);
        await saveState();
        return "terminal";
      }
      if (job.attempts <= MAX_RETRIES_PER_CLIP && (message === "create_rejected" || message === "create_throttled" || message === "create_unconfirmed")) {
        logLine(`${logPrefix} ${message} → retry on next invocation`);
        await saveState();
        return "terminal";
      }
      job.status = "failed";
      job.error = message;
      logLine(`${logPrefix} failed: ${message}`);
      await saveState();
      return "terminal";
    }
  }

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (Date.now() >= deadline - 1000) break;
    try {
      const result = await pollPrediction(job.predictionId!);
      if (result.status === "pending") continue;
      if (result.status === "succeeded" && result.outputUrl) {
        const clip = clipPath(job.photoId, job.direction);
        await downloadClip(result.outputUrl, clip);
        const duration = await ffprobeDuration(clip);
        job.durationSec = duration ?? DURATION_SEC;
        job.costUsd = Number(((job.durationSec ?? DURATION_SEC) * 0.18).toFixed(4));
        state.spendUsd = Number((state.spendUsd + (job.costUsd ?? 0)).toFixed(4));
        job.status = "done";
        state.successful++;
        job.updatedAt = nowISO();
        await saveState();
        logLine(`${logPrefix} done duration=${job.durationSec}s cost=$${job.costUsd} spend=$${state.spendUsd}`);
        return "terminal";
      }
      if (job.attempts <= MAX_RETRIES_PER_CLIP) {
        logLine(`${logPrefix} ${result.status} (${result.error}) → retry on next invocation`);
        job.attempts++;
        job.predictionId = null;
        job.status = "pending";
        job.updatedAt = nowISO();
        await saveState();
        return "terminal";
      }
      job.status = "failed";
      job.error = result.error ?? result.status;
      job.updatedAt = nowISO();
      await saveState();
      logLine(`${logPrefix} failed after retries: ${result.error}`);
      return "terminal";
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes("billing_rejection")) {
        state.halted = true;
        state.haltReason = "billing";
        await saveState();
        return "terminal";
      }
      logLine(`${logPrefix} poll error: ${redactSecrets(message)}`);
      continue;
    }
  }
  return "timecap";
}

async function generate(): Promise<number> {
  await ensureDirs();
  let loaded: State | null = null;
  try {
    loaded = JSON.parse(await readFile(STATE_PATH, "utf8")) as State;
  } catch {
    /* fresh start */
  }
  if (loaded) state = loaded;
  if (state.photos.length === 0) {
    state.photos = await loadPhotos();
    state.jobs = initJobs(state.photos);
    await saveState();
    logLine(`photos: ${state.photos.map((p) => `${p.id} ${p.w}x${p.h} ${p.aspect}`).join("  ")}`);
    logLine(`jobs: ${state.jobs.length} (${state.photos.length} photos x 2 directions)`);
    await saveLog();
  }

  let exitCode = 2;
  for (const job of state.jobs) {
    if (state.halted) break;
    if (job.status === "done" || job.status === "failed") continue;
    const photoEntry = state.photos.find((p) => p.id === job.photoId)!;
    const photoBuffer = await readFile(path.join(PHOTO_DIR, photoEntry.file));
    const result = await runOneJob(job, photoBuffer);
    await saveState();
    await saveLog();
    exitCode = 0;
    if (result === "timecap") break;
  }
  if (state.halted) {
    logLine(`HALTED: ${state.haltReason} successful=${state.successful} spend=$${state.spendUsd}`);
  }
  const pending = state.jobs.filter((j) => j.status === "pending" || j.status === "submitted").length;
  if (!state.halted && pending > 0) exitCode = 0;
  logLine(`generate pass end: successful=${state.successful} failed=${state.jobs.filter((j) => j.status === "failed").length} pending=${pending} spend=$${state.spendUsd}`);
  await saveState();
  await saveLog();
  return exitCode;
}

// ------------------------------------------------------------------ frames, manifests, contact sheets
async function buildFramesAndSheets(): Promise<void> {
  await ensureDirs();
  const photosIndex: PhotoEntry[] = [];
  for (const photo of state.photos) {
    const leftDir = path.join(ASSETS_DIR, photo.id, "left");
    const rightDir = path.join(ASSETS_DIR, photo.id, "right");
    const leftJob = state.jobs.find((j) => j.photoId === photo.id && j.direction === "left")!;
    const rightJob = state.jobs.find((j) => j.photoId === photo.id && j.direction === "right")!;

    if (leftJob.status === "done" && leftJob.clipPath) {
      await extractFrames(leftJob.clipPath, leftDir);
    }
    if (rightJob.status === "done" && rightJob.clipPath) {
      await extractFrames(rightJob.clipPath, rightDir);
    }

    const leftFrames = (await readdir(leftDir).catch(() => [])).filter((f) => /^frame_\d+\.jpg$/i.test(f)).sort();
    const rightFrames = (await readdir(rightDir).catch(() => [])).filter((f) => /^frame_\d+\.jpg$/i.test(f)).sort();

    // ONE ordered sequence per photo: LEFT reversed (full left -> center) +
    // RIGHT without its first frame (center -> full right).
    const ordered = [
      ...leftFrames.map((f, i) => ({ source: "left" as const, file: path.join(leftDir, f), rel: `assets/${photo.id}/left/${f}`, sourceIndex: i })),
      ...rightFrames.slice(1).map((f, i) => ({ source: "right" as const, file: path.join(rightDir, f), rel: `assets/${photo.id}/right/${f}`, sourceIndex: i + 1 })),
    ];
    const leftReversed = ordered.slice(0, leftFrames.length).reverse();
    const sequenceFinal = [...leftReversed, ...ordered.slice(leftFrames.length)];
    const centerIndex = leftFrames.length - 1;

    const fps = (leftJob.durationSec && leftJob.durationSec > 0) ? leftFrames.length / leftJob.durationSec : 24;
    const framesManifest = sequenceFinal.map((entry, index) => ({
      index,
      file: `/out/follow-demo/${entry.rel}`,
      source: entry.source,
      sourceIndex: entry.sourceIndex,
      seconds: Number((index / fps).toFixed(3)),
    }));

    const manifest = {
      photo: photo.id,
      photoFile: photo.file,
      size: { w: photo.w, h: photo.h },
      aspect: photo.aspect,
      clips: { left: `/out/follow-demo/clips/${photo.id}-left.mp4`, right: `/out/follow-demo/clips/${photo.id}-right.mp4` },
      durationSec: DURATION_SEC,
      fps: Number(fps.toFixed(3)),
      frameCount: sequenceFinal.length,
      centerIndex,
      frames: framesManifest,
    };
    await writeFile(path.join(ASSETS_DIR, photo.id, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    // Contact sheet: every 6th frame of the sequence, one image for blink/morph review.
    const sheetFrames = framesManifest.filter((f, i) => i % 6 === 0);
    const tileW = 224;
    const cols = Math.min(8, sheetFrames.length);
    const rows = Math.ceil(sheetFrames.length / cols);
    const tileH = Math.round(tileW * (photo.h / photo.w));
    const sheet = sharp({
      create: { width: cols * tileW + (cols + 1) * 8, height: rows * tileH + (rows + 1) * 8, channels: 3, background: { r: 0, g: 0, b: 0 } },
    });
    const composeOps: any[] = [];
    for (let s = 0; s < sheetFrames.length; s++) {
      const col = s % cols;
      const row = Math.floor(s / cols);
      composeOps.push({
        input: sheetFrames[s].file,
        left: 8 + col * (tileW + 8),
        top: 8 + row * (tileH + 8),
        tile: { width: tileW, height: tileH, fit: "cover", gravity: "center" },
      });
    }
    if (composeOps.length) {
      await sheet.composite(composeOps).jpeg({ quality: 85 }).toFile(path.join(SHEETS_DIR, `${photo.id}.jpg`));
    }
    logLine(`sheet ${photo.id}: ${sheetFrames.length} tiles -> sheets/${photo.id}.jpg`);

    photosIndex.push(photo);
  }
  await writeFile(PHOTOS_INDEX_PATH, JSON.stringify(photosIndex, null, 2), "utf8");
  logLine(`frames + manifests + sheets done for ${photosIndex.length} photos`);
}

// ------------------------------------------------------------------ main
async function main(): Promise<void> {
  const mode = process.argv.slice(2).find((a) => !a.startsWith("-")) || "generate";
  if (mode === "generate") {
    const code = await generate();
    process.exitCode = code;
  } else if (mode === "frames") {
    await buildFramesAndSheets();
  } else {
    throw new Error(`Unknown mode: ${mode} (use "generate" or "frames")`);
  }
}

main().catch((error) => {
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  console.error(message.slice(0, 400));
  process.exitCode = 1;
});





