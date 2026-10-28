import { fal } from "@fal-ai/client";
import { extractVideoUrl } from "./fal-result.js";
import { calculateSsimBetweenFrames, downloadFile, getVideoDurationSeconds } from "./media.js";
import { config as loadEnv } from "dotenv";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const picksPath = path.join(root, "out", "sample-pets", "picks.json");
const picksBase = path.join(root, "out", "sample-pets");
const outRoot = path.join(root, "out", "sample-clips");

// Shared, identical video settings for BOTH providers.
const DURATION_SEC = 4;
const RESOLUTION = "720p";
const ASPECT_RATIO = "9:16";
const GENERATE_AUDIO = false;

// fal Seedance 2.0 (standard) queue model id + portrait model, mirrored from production
// (src/lib/generation.server.ts PROVIDERS.seedance and the renaissance portrait edit call).
const FAL_VIDEO_MODEL = "bytedance/seedance-2.0/image-to-video";
const FAL_PORTRAIT_MODEL = "fal-ai/nano-banana/edit";
const FAL_USD_PER_SEC = 0.3034; // task-specified estimate basis for fal.

// Replicate official ByteDance Seedance 2.0 (standard).
const REPLICATE_MODEL = "bytedance/seedance-2.0";
const REPLICATE_SEED = 1234; // fal Seedance has no seed input, so a shared seed is impossible; fixed for Replicate only.
// Replicate limits prediction CREATION to ~6/min (burst 1); serialize + back off on 429 without charging the paid cap.
const REPLICATE_THROTTLE_WAIT_MS = 25_000;
const REPLICATE_MAX_THROTTLE_WAITS = 10;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const PORTRAIT_PROMPT =
  "Transform this photo into a classic Renaissance oil painting portrait of the same pet. Keep the pet's identity exactly: same face, fur color and pattern, markings, eye color and ears. Dress the pet in an elegant 16th-century noble costume (velvet, lace collar, small jewel). Dark warm studio background, soft candlelight from the side. It must look like a real painting, not a photograph: visible brush strokes, oil texture and craquelure, painterly and not photorealistic. The pet looks toward the viewer, face and eyes clearly visible, centered, full-bleed vertical 9:16 composition that fills the whole canvas, no white or empty margins, no borders, no frame, no text, no extra animals or objects.";

const VIDEO_PROMPTS: Record<string, string> = {
  gentle:
    "The pet keeps its head almost still. It makes a very small head tilt of a few degrees, blinks once, one ear moves slightly, then it returns to exactly the original pose. Locked camera, subtle motion only.",
  glance:
    "The pet stays in its original pose. Only its eyes shift gently toward the camera with a tiny head movement, then one soft blink, and the gaze returns to the original direction. Locked camera, subtle motion only, ends in exactly the original pose.",
  cozy:
    "The pet lies calmly and breathes slowly and deeply: the chest visibly rises and falls, the head moves very slightly, the ears twitch a little, one slow long blink, then it settles back into exactly the original pose. Locked camera, natural lifelike movement.",
  sleepy:
    "The pet slowly opens its mouth in a big yawn, then closes it, blinks slowly, then settles back into exactly the original pose. Locked camera, subtle motion only.",
  breeze:
    "Preserve the exact pet identity, fur pattern and composition. A light breeze gently moves the fur, whiskers and ear tips; background foliage sways slightly. One slow blink. The pet stays in the same position and ends in exactly the starting pose. Static camera. No morphing, no new objects.",
  dreamy:
    "Preserve the exact pet identity, fur pattern, colors and composition. Keep exposure, lighting and colors constant. Only the out-of-focus background lights shimmer very slightly. The pet breathes calmly and blinks once, very slowly. Ends in exactly the starting pose. Static camera. No light leaks, no lens flare, no glow, no color shift, no morphing, no new objects.",
  renaissance:
    "A classic oil painting portrait that gently comes to life. The pet's eyes glance to the side as if checking that nobody is watching, one ear twitches slightly, then it looks back at the viewer and blinks slowly once. The image stays a painting: visible brush strokes, oil texture and craquelure remain, the pet and costume stay exactly the same. Very soft candlelight flicker. Locked camera, ends in exactly the original pose. No photorealism, no morphing, no new objects.",
};
const PRESET_KEYS = Object.keys(VIDEO_PROMPTS);

// ---- Cost guard ----
const HARD_REQUEST_CAP = 20; // paid model calls incl. retries (portrait + videos).
const CONCURRENCY = 3;
const MAX_RETRIES_PER_JOB = 1;

type Provider = "fal" | "replicate";
type CliOptions = { dryRun: boolean; onlyPreset?: string; provider?: Provider };

type ManifestItem = {
  provider: Provider;
  presetKey: string;
  inputFile: string;
  model: string;
  parameters: Record<string, unknown>;
  seed: number | null;
  seedHonored: boolean;
  requestId: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  file: string | null;
  fileBytes: number | null;
  generationSec: number | null;
  costUsd: number | null;
  costBasis: "estimated" | "actual" | "not-reported";
  loopSeamSsim: number | null;
  createdAt: string;
};

const paidCalls = { count: 0, retries: 0, failures: 0 };
function budgetCheck(label: string): void {
  if (paidCalls.count >= HARD_REQUEST_CAP) {
    throw new Error(`Paid-call cap (${HARD_REQUEST_CAP}) reached before ${label}. Aborting to protect spend.`);
  }
  paidCalls.count++;
}

const ffmpegBinary = (createRequire(import.meta.url)("ffmpeg-static") as string | null) ?? "ffmpeg";

function runFfmpegCapture(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegBinary, args, { windowsHide: true });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (out += c));
    child.stderr.on("data", (c: string) => (out += c));
    child.on("close", () => resolve(out));
    child.on("error", () => resolve(out));
  });
}

async function probeVideo(videoPath: string): Promise<{ width: number | null; height: number | null; fps: number | null; durationSec: number | null }> {
  const out = await runFfmpegCapture(["-i", videoPath]);
  const resMatch = out.match(/Video:.*?,\s*(\d{2,5})x(\d{2,5})/);
  const fpsMatch = out.match(/(\d+(?:\.\d+)?)\s*fps/);
  let durationSec: number | null = null;
  try {
    durationSec = Math.round((await getVideoDurationSeconds(videoPath)) * 100) / 100;
  } catch {
    durationSec = null;
  }
  return {
    width: resMatch ? Number(resMatch[1]) : null,
    height: resMatch ? Number(resMatch[2]) : null,
    fps: fpsMatch ? Number(fpsMatch[1]) : null,
    durationSec,
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function nextFreePath(dir: string, base: string, ext: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  let index = 1;
  while (index < 1000) {
    const name = index === 1 ? `${base}${ext}` : `${base}-${index}${ext}`;
    const abs = path.join(dir, name);
    if (!(await exists(abs))) return abs;
    index++;
  }
  throw new Error(`No free index under ${dir} for ${base}`);
}

function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = { dryRun: false };
  for (const arg of args) {
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg.startsWith("--only=")) opts.onlyPreset = arg.slice("--only=".length).trim() || undefined;
    else if (arg.startsWith("--provider=")) {
      const v = arg.slice("--provider=".length).trim();
      if (v !== "fal" && v !== "replicate") throw new Error("--provider must be fal|replicate");
      opts.provider = v;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run sample-clips -- [--dry-run] [--only=<presetKey>] [--provider=fal|replicate]");
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

async function readPicks(): Promise<Record<string, string>> {
  if (!(await exists(picksPath))) throw new Error(`picks.json not found at ${picksPath}. Stopping.`);
  const raw = JSON.parse(await readFile(picksPath, "utf8")) as Record<string, string>;
  const keys = PRESET_KEYS;
  for (const k of keys) if (!raw[k]) throw new Error(`picks.json missing entry for preset "${k}". Stopping.`);
  if (Object.keys(raw).length !== 7) throw new Error(`picks.json must have exactly 7 entries, found ${Object.keys(raw).length}. Stopping.`);
  return raw;
}

async function uploadToFal(absPath: string): Promise<string> {
  const buf = await readFile(absPath);
  const type = absPath.endsWith(".png") ? "image/png" : "image/jpeg";
  return fal.storage.upload(new Blob([buf], { type }));
}

// fal: Seedance 2.0 image-to-video with end_image_url == image_url (seamless loop).
async function genFalClip(videoUrl: string, prompt: string): Promise<{ url: string; requestId: string }> {
  budgetCheck("fal clip");
  const input = {
    image_url: videoUrl,
    end_image_url: videoUrl,
    prompt,
    duration: String(DURATION_SEC),
    resolution: RESOLUTION,
    aspect_ratio: ASPECT_RATIO,
    generate_audio: GENERATE_AUDIO,
  };
  const result = await fal.subscribe(FAL_VIDEO_MODEL, { input, logs: false });
  return { url: extractVideoUrl(result.data), requestId: result.requestId };
}

async function genPortrait(sourceAbs: string): Promise<string> {
  const portraitPath = path.join(outRoot, "renaissance-portrait.jpg");
  if (await exists(portraitPath)) return portraitPath; // never overwrite; reuse existing shared portrait.
  budgetCheck("renaissance portrait");
  const url = await uploadToFal(sourceAbs);
  const result = await fal.subscribe(FAL_PORTRAIT_MODEL, {
    input: { prompt: PORTRAIT_PROMPT, image_urls: [url], aspect_ratio: "9:16", output_format: "jpeg", num_images: 1 },
    logs: false,
  });
  const data = result.data as { images?: { url?: string }[] };
  const imageUrl = data.images?.[0]?.url;
  if (!imageUrl) throw new Error("nano-banana/edit returned no image");
  await mkdir(outRoot, { recursive: true });
  const jpg = await sharp(await (await fetch(imageUrl)).arrayBuffer()).jpeg({ quality: 92 }).toBuffer();
  await writeFile(portraitPath, jpg);
  return portraitPath;
}

type RepPrediction = {
  id: string;
  status: string;
  output?: unknown;
  urls?: { get?: string };
  error?: string | null;
  metrics?: { predict_time?: number } & Record<string, unknown>;
  [k: string]: unknown;
};

function replicateOutputUrl(p: RepPrediction): string {
  if (typeof p.output === "string" && p.output) return p.output;
  if (Array.isArray(p.output) && typeof p.output[0] === "string" && p.output[0]) return p.output[0];
  throw new Error("Replicate prediction returned no output URL");
}

// Scan a Replicate prediction for any numeric cost/billing figure returned by the API.
function replicateCostFromPrediction(p: RepPrediction): number | null {
  const candidates: unknown[] = [p.cost, p.billing, p.billing_cost, (p.metrics as Record<string, unknown> | undefined)?.cost];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
    if (typeof c === "string") {
      const n = Number(c.replace(/[^0-9.]/g, ""));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

async function genReplicateClip(imageUrl: string, prompt: string, token: string): Promise<{ url: string; prediction: RepPrediction }> {
  // Public models are run by name through the model predictions endpoint; /v1/predictions needs a raw
  // `version` and rejects `model`, which is what produced the earlier 422.
  const createUrl = `https://api.replicate.com/v1/models/${REPLICATE_MODEL}/predictions`;
  const createBody = JSON.stringify({
    input: {
      image: imageUrl,
      last_frame_image: imageUrl,
      prompt,
      duration: DURATION_SEC,
      resolution: RESOLUTION,
      aspect_ratio: ASPECT_RATIO,
      generate_audio: GENERATE_AUDIO,
      seed: REPLICATE_SEED,
    },
  });
  let createRes: Response | undefined;
  // A 429 is a rate-limit rejection that creates no prediction and is never billed, so waiting and
  // retrying it does NOT consume the one allowed generation retry or the paid-call cap.
  for (let waited = 0; ; waited++) {
    createRes = await fetch(createUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: createBody,
    });
    if (createRes.status === 429 && waited < REPLICATE_MAX_THROTTLE_WAITS) {
      console.log(`  replicate create throttled (429); waiting ${REPLICATE_THROTTLE_WAIT_MS / 1000}s before retry`);
      await sleep(REPLICATE_THROTTLE_WAIT_MS);
      continue;
    }
    break;
  }
  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`Replicate create failed [${createRes.status}]: ${body.slice(0, 200)}`);
  }
  // Charge the paid-call cap only once a (billed) prediction actually exists.
  budgetCheck("replicate clip");
  let prediction = (await createRes.json()) as RepPrediction;
  const deadline = Date.now() + 20 * 60 * 1000;
  while (prediction.status !== "succeeded") {
    if (prediction.status === "failed" || prediction.status === "canceled") {
      throw new Error(`Replicate prediction ${prediction.status}: ${String(prediction.error ?? "unknown")}`);
    }
    if (Date.now() > deadline) throw new Error("Replicate prediction timed out");
    await new Promise((r) => setTimeout(r, 4000));
    const poll = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!poll.ok) throw new Error(`Replicate poll failed [${poll.status}]`);
    prediction = (await poll.json()) as RepPrediction;
  }
  return { url: replicateOutputUrl(prediction), prediction };
}

async function runWithConcurrency<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const runners = Array.from({ length: Math.max(1, limit) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next !== undefined) await worker(next);
    }
  });
  await Promise.all(runners);
}

async function readManifest(): Promise<ManifestItem[]> {
  const p = path.join(outRoot, "manifest.json");
  if (!(await exists(p))) return [];
  try {
    const parsed = JSON.parse(await readFile(p, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as ManifestItem[]) : [];
  } catch (e) {
    throw new Error(`Failed to parse existing manifest.json: ${e instanceof Error ? e.message : String(e)}`);
  }
}

type Job = { provider: Provider; presetKey: string };

async function runJob(job: Job, picks: Record<string, string>, replicateToken: string, manifest: ManifestItem[]): Promise<void> {
  const isRenaissance = job.presetKey === "renaissance";
  // Determine the source image and its fal-hosted URL (renaissance uses the shared portrait).
  const sourceAbs = isRenaissance ? await genPortrait(path.join(picksBase, picks.renaissance)) : path.join(picksBase, picks[job.presetKey]);
  const hostedUrl = await uploadToFal(sourceAbs);

  const dir = path.join(outRoot, job.provider);
  const prompt = VIDEO_PROMPTS[job.presetKey];
  const parameters =
    job.provider === "fal"
      ? {
          model: FAL_VIDEO_MODEL,
          image_url: hostedUrl,
          end_image_url: hostedUrl,
          prompt,
          duration: String(DURATION_SEC),
          resolution: RESOLUTION,
          aspect_ratio: ASPECT_RATIO,
          generate_audio: GENERATE_AUDIO,
        }
      : {
          model: REPLICATE_MODEL,
          image: hostedUrl,
          last_frame_image: hostedUrl,
          prompt,
          duration: DURATION_SEC,
          resolution: RESOLUTION,
          aspect_ratio: ASPECT_RATIO,
          generate_audio: GENERATE_AUDIO,
          seed: REPLICATE_SEED,
        };

  let attempt = 0;
  for (;;) {
    attempt++;
    const t0 = Date.now();
    try {
      let videoUrl = "";
      let requestId = "";
      let costUsd: number | null = null;
      let costBasis: ManifestItem["costBasis"] = "not-reported";
      if (job.provider === "fal") {
        const r = await genFalClip(hostedUrl, prompt);
        videoUrl = r.url;
        requestId = r.requestId;
        costUsd = Math.round(DURATION_SEC * FAL_USD_PER_SEC * 10000) / 10000;
        costBasis = "estimated";
      } else {
        const r = await genReplicateClip(hostedUrl, prompt, replicateToken);
        videoUrl = r.url;
        requestId = r.prediction.id;
        const actual = replicateCostFromPrediction(r.prediction);
        if (actual !== null) {
          costUsd = actual;
          costBasis = "actual";
        }
      }
      const outFile = await nextFreePath(dir, job.presetKey, ".mp4");
      await downloadFile(videoUrl, outFile);
      const genSec = Math.round((Date.now() - t0) / 100) / 10;
      const probe = await probeVideo(outFile);
      const seam = await calculateSsimBetweenFrames(outFile, 0, "last").catch(() => null);
      const fileRel = path.relative(outRoot, outFile).split(path.sep).join("/");
      const item: ManifestItem = {
        provider: job.provider,
        presetKey: job.presetKey,
        inputFile: isRenaissance ? "out/sample-clips/renaissance-portrait.jpg" : `out/sample-pets/${picks[job.presetKey]}`,
        model: job.provider === "fal" ? FAL_VIDEO_MODEL : REPLICATE_MODEL,
        parameters,
        seed: job.provider === "replicate" ? REPLICATE_SEED : null,
        seedHonored: job.provider === "replicate",
        requestId,
        durationSec: probe.durationSec,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        file: fileRel,
        fileBytes: (await stat(outFile)).size,
        generationSec: genSec,
        costUsd,
        costBasis,
        loopSeamSsim: seam,
        createdAt: new Date().toISOString(),
      };
      manifest.push(item);
      console.log(`${job.provider}/${job.presetKey} ok -> ${fileRel} ${probe.width}x${probe.height}@${probe.fps} seam=${seam?.toFixed(3) ?? "?"} ${costBasis}=$${costUsd ?? "?"}`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt <= MAX_RETRIES_PER_JOB && paidCalls.count < HARD_REQUEST_CAP) {
        paidCalls.retries++;
        console.log(`${job.provider}/${job.presetKey} attempt ${attempt} failed, retrying: ${message.replace(/\s+/g, " ").slice(0, 160)}`);
        continue;
      }
      paidCalls.failures++;
      console.log(`${job.provider}/${job.presetKey} FAILED after ${attempt} attempt(s): ${message.replace(/\s+/g, " ").slice(0, 160)}`);
      return;
    }
  }
}

function buildGallery(manifest: ManifestItem[], picks: Record<string, string>): string {
  const byProvider = (presetKey: string, provider: Provider) => manifest.find((m) => m.presetKey === presetKey && m.provider === provider) ?? null;
  const rows = PRESET_KEYS.map((presetKey) => {
    const falItem = byProvider(presetKey, "fal");
    const repItem = byProvider(presetKey, "replicate");
    // Randomize A/B provider assignment per row (blind test), stable for this build.
    const falIsA = Math.random() < 0.5;
    const aItem = falIsA ? falItem : repItem;
    const bItem = falIsA ? repItem : falItem;
    return {
      presetKey,
      photo: `../sample-pets/${picks[presetKey]}`,
      mapping: { A: falIsA ? "fal" : "replicate", B: falIsA ? "replicate" : "fal" },
      A: aItem ? { file: aItem.file, costUsd: aItem.costUsd, costBasis: aItem.costBasis, seam: aItem.loopSeamSsim, resolution: aItem.width && aItem.height ? `${aItem.width}x${aItem.height}` : null, fps: aItem.fps, durationSec: aItem.durationSec } : null,
      B: bItem ? { file: bItem.file, costUsd: bItem.costUsd, costBasis: bItem.costBasis, seam: bItem.loopSeamSsim, resolution: bItem.width && bItem.height ? `${bItem.width}x${bItem.height}` : null, fps: bItem.fps, durationSec: bItem.durationSec } : null,
    };
  });
  const embedded = JSON.stringify(rows);
  const picksJson = JSON.stringify(picks, null, 2);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PetMotion fal vs Replicate blind test</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font-family: Inter, Segoe UI, Roboto, Arial, sans-serif; background: #111318; color: #f3f5f8; }
  .wrap { max-width: 1200px; margin: 0 auto; padding: 20px; }
  h1 { margin: 0 0 6px; font-size: 24px; }
  .sub { margin: 0 0 16px; color: #b8c0cc; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 16px; }
  button { border: 0; background: #3d7dff; color: #fff; border-radius: 8px; padding: 8px 12px; font-weight: 600; cursor: pointer; }
  button:hover { background: #3065cc; }
  button.ghost { background: #2b3340; }
  .rows { display: grid; gap: 20px; }
  .row { background: #1a1f29; border: 1px solid #2b3340; border-radius: 12px; padding: 14px; }
  .row-title { margin: 0 0 12px; font-size: 18px; }
  .media { display: grid; grid-template-columns: 220px 1fr 1fr; gap: 12px; align-items: start; }
  .cell { background: #000; border-radius: 10px; overflow: hidden; border: 1px solid #2b3340; }
  .cell .label { padding: 6px 8px; font-size: 13px; color: #c2ccdc; background: #161b24; }
  .photo, .vid { width: 100%; aspect-ratio: 9 / 16; object-fit: cover; display: block; background: #000; }
  .stack { position: relative; }
  .overlay { position: absolute; inset: 0; pointer-events: none; display: none; }
  .overlay.on { display: block; }
  .clock-line { position: absolute; left: 0; right: 0; top: 33.333%; border-top: 2px dashed rgba(255,255,255,0.7); }
  .clock { position: absolute; top: 8%; left: 8%; font-size: clamp(26px,5vw,44px); font-weight: 700; color: rgba(255,255,255,0.95); text-shadow: 0 2px 8px rgba(0,0,0,0.6); }
  .vote { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }
  .vote .chosen { outline: 2px solid #62f4a8; }
  .rev { color: #ffd479; font-size: 13px; min-height: 16px; margin-top: 8px; }
  pre { background: #0d1118; border: 1px solid #2b3340; border-radius: 8px; padding: 10px; overflow: auto; }
</style>
</head>
<body>
<div class="wrap">
  <h1>fal (production) vs Replicate — blind A/B</h1>
  <p class="sub">Same photos, same Seedance 2.0 standard params (720p, 9:16, 4s, end frame = start frame). A/B provider is randomized per row.</p>
  <div class="toolbar">
    <label><input id="overlayToggle" type="checkbox"> Lock-screen overlay</label>
    <button id="syncBtn" class="ghost" type="button">Replay all in sync</button>
    <button id="revealBtn" type="button">Reveal</button>
    <button id="copyBtn" type="button">Copy results</button>
    <span id="tally" class="sub"></span>
  </div>
  <div id="rows" class="rows"></div>
  <h2>Results JSON</h2>
  <pre id="outPre">${picksJson}</pre>
</div>
<script>
const rows = ${embedded};
const votes = {};
const rowsEl = document.getElementById("rows");
const overlayToggle = document.getElementById("overlayToggle");
const revealBtn = document.getElementById("revealBtn");
const syncBtn = document.getElementById("syncBtn");
const copyBtn = document.getElementById("copyBtn");
const outPre = document.getElementById("outPre");
const tallyEl = document.getElementById("tally");
let revealed = false;

function money(c){ if(!c||c.costUsd==null) return "n/a"; return "$"+c.costUsd.toFixed(4)+" ("+c.costBasis+")"; }
function seam(c){ return c&&c.seam!=null ? c.seam.toFixed(3) : "n/a"; }

function cell(label, spec){
  const wrap=document.createElement("div"); wrap.className="cell";
  const box=document.createElement("div"); box.className="stack";
  if(spec.kind==="photo"){
    const img=document.createElement("img"); img.className="photo"; img.src=spec.src||""; img.alt=label; box.appendChild(img);
  } else if(spec.src){
    const v=document.createElement("video"); v.className="vid"; v.src=spec.src; v.muted=true; v.loop=true; v.autoplay=true; v.playsInline=true; v.setAttribute("playsinline",""); v.preload="auto"; box.appendChild(v);
  } else {
    const d=document.createElement("div"); d.className="vid"; d.style.display="grid"; d.style.placeItems="center"; d.style.color="#888"; d.textContent="no clip"; box.appendChild(d);
  }
  const ov=document.createElement("div"); ov.className="overlay"; ov.innerHTML='<div class="clock-line"></div><div class="clock">10:26</div>'; box.appendChild(ov);
  const lab=document.createElement("div"); lab.className="label";
  let extra = label;
  if(spec.meta) extra = label+" · "+(spec.meta.resolution||"?")+" @"+(spec.meta.fps||"?")+"fps · "+(spec.meta.durationSec||"?")+"s";
  lab.textContent=extra; wrap.appendChild(box); wrap.appendChild(lab);
  return wrap;
}

function applyOverlay(){
  for(const ov of document.querySelectorAll(".overlay")) ov.classList.toggle("on", overlayToggle.checked);
}

function fillReveal(row){
  const a=row.mapping.A, b=row.mapping.B;
  const ac=row.A, bc=row.B;
  return "A = "+a+"  ["+(ac?money(ac):"-")+", seam "+seam(ac)+"]   |   B = "+b+"  ["+(bc?money(bc):"-")+", seam "+seam(bc)+"]";
}

function updateTally(){
  let a=0,b=0,s=0;
  for(const v of Object.values(votes)){ if(v==="A")a++; else if(v==="B")b++; else if(v==="Same")s++; }
  tallyEl.textContent = "A better: "+a+" · B better: "+b+" · Same: "+s;
}

function refreshOut(){
  const mapping={}; for(const r of rows) mapping[r.presetKey]=r.mapping;
  const picksMap={}; for(const r of rows) picksMap[r.presetKey]=r.photo.replace("../sample-pets/","");
  outPre.textContent = JSON.stringify({picks: picksMap, mapping, votes}, null, 2);
}

function render(){
  rowsEl.innerHTML = "";
  for(const row of rows){
    const sec = document.createElement("section"); sec.className="row";
    sec.innerHTML = '<h3 class="row-title">'+row.presetKey+'</h3>';
    const media = document.createElement("div"); media.className="media";
    media.appendChild(cell("source photo", {kind:"photo", src:row.photo}));
    media.appendChild(cell("A", {kind:"video", src:row.A&&row.A.file, meta:row.A}));
    media.appendChild(cell("B", {kind:"video", src:row.B&&row.B.file, meta:row.B}));
    sec.appendChild(media);

    const vote = document.createElement("div"); vote.className="vote";
    for(const opt of ["A","B","Same"]){
      const b=document.createElement("button"); b.type="button"; b.textContent = opt==="Same" ? "Same" : opt+" better";
      b.dataset.opt=opt;
      if(votes[row.presetKey]===opt) b.classList.add("chosen");
      b.addEventListener("click",()=>{ votes[row.presetKey]=opt; vote.querySelectorAll("button").forEach(x=>x.classList.remove("chosen")); b.classList.add("chosen"); updateTally(); refreshOut(); });
      vote.appendChild(b);
    }
    sec.appendChild(vote);

    const rev=document.createElement("div"); rev.className="rev";
    rev.textContent = revealed ? fillReveal(row) : "";
    sec.appendChild(rev);
    rowsEl.appendChild(sec);
  }
  applyOverlay();
}

overlayToggle.addEventListener("change", applyOverlay);
revealBtn.addEventListener("click", ()=>{ revealed=!revealed; revealBtn.textContent = revealed ? "Hide" : "Reveal"; render(); });
syncBtn.addEventListener("click", ()=>{ for(const v of rowsEl.querySelectorAll("video")){ try{ v.currentTime=0; v.play(); }catch(e){} } });
copyBtn.addEventListener("click", async ()=>{ refreshOut(); try{ await navigator.clipboard.writeText(outPre.textContent); }catch(e){} });

// Keep A/B videos in sync when both are ready.
document.addEventListener("play", (e)=>{ const t=e.target; if(t && t.tagName==="VIDEO"){ const row=t.closest(".row"); if(!row) return; const vids=row.querySelectorAll("video"); if(vids.length===2 && Math.abs(vids[0].currentTime-vids[1].currentTime)>0.15){ vids[1].currentTime=vids[0].currentTime; } }}, true);

render();
refreshOut();
</script>
</body>
</html>`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  loadEnv({ path: path.join(root, ".env") });
  const falKey = process.env.FAL_KEY ?? "";
  const replicateToken = process.env.REPLICATE_API_TOKEN ?? "";
  if (!falKey) throw new Error("FAL_KEY is missing in the existing environment. Stopping without changes to .env.");
  if (!replicateToken) throw new Error("REPLICATE_API_TOKEN is missing in the existing environment. Stopping without changes to .env.");
  fal.config({ credentials: falKey });

  const picks = await readPicks();

  const providers: Provider[] = options.provider ? [options.provider] : ["fal", "replicate"];
  const presets = options.onlyPreset ? PRESET_KEYS.filter((k) => k === options.onlyPreset) : PRESET_KEYS;
  if (presets.length === 0 || (options.onlyPreset && presets.length !== 1)) throw new Error(`Unknown preset key "${options.onlyPreset}". Available: ${PRESET_KEYS.join(", ")}`);

  const jobs: Job[] = [];
  for (const provider of providers) for (const presetKey of presets) jobs.push({ provider, presetKey });

  const needPortrait = presets.includes("renaissance");
  const portraitAlready = await exists(path.join(outRoot, "renaissance-portrait.jpg"));

  console.log(`Providers: ${providers.join(", ")}   Presets: ${presets.length}   Jobs: ${jobs.length}`);
  console.log(`fal params:      ${JSON.stringify({ model: FAL_VIDEO_MODEL, end_frame_param: "end_image_url", duration: String(DURATION_SEC), resolution: RESOLUTION, aspect_ratio: ASPECT_RATIO, generate_audio: GENERATE_AUDIO, seed: "not supported by fal" })}`);
  console.log(`Replicate params: ${JSON.stringify({ model: REPLICATE_MODEL, last_frame_param: "last_frame_image", duration: DURATION_SEC, resolution: RESOLUTION, aspect_ratio: ASPECT_RATIO, generate_audio: GENERATE_AUDIO, seed: REPLICATE_SEED })}`);
  console.log(`Portrait model:  ${FAL_PORTRAIT_MODEL} (9:16 jpeg x1) ${needPortrait ? (portraitAlready ? "(reusing existing)" : "(1 paid call)") : "(not needed)"}`);

  const portraitCalls = needPortrait && !portraitAlready ? 1 : 0;
  const plannedPaid = jobs.length + portraitCalls;
  const falClipCount = providers.includes("fal") ? presets.length : 0;
  const estFal = falClipCount * DURATION_SEC * FAL_USD_PER_SEC;
  console.log(`Planned paid calls: ${plannedPaid} (cap ${HARD_REQUEST_CAP}, up to ${MAX_RETRIES_PER_JOB} retry/job)   fal estimate: $${estFal.toFixed(4)} (${falClipCount} x ${DURATION_SEC}s x $${FAL_USD_PER_SEC}/s)   Replicate: cost reported per prediction post-run.`);

  if (options.dryRun) {
    for (const j of jobs) console.log(`  plan ${j.provider}/${j.presetKey} input=${j.presetKey === "renaissance" ? "out/sample-clips/renaissance-portrait.jpg" : picks[j.presetKey]}`);
    console.log("Dry run complete. No API calls were made.");
    return;
  }

  await mkdir(outRoot, { recursive: true });
  const manifest = await readManifest();

  const worker = async (job: Job): Promise<void> => { await runJob(job, picks, replicateToken, manifest); };
  // fal (queue-backed) runs 3-wide; Replicate runs 1-wide so prediction creation stays inside the
  // 6/min rate limit instead of tripping 429 throttling.
  const falJobs = jobs.filter((j) => j.provider === "fal");
  const repJobs = jobs.filter((j) => j.provider === "replicate");
  await Promise.all([
    runWithConcurrency(falJobs, CONCURRENCY, worker),
    runWithConcurrency(repJobs, 1, worker),
  ]);

  await writeFile(path.join(outRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  const html = buildGallery(manifest, picks);
  await writeFile(path.join(outRoot, "index.html"), html, "utf8");

  console.log(`\nPaid calls used: ${paidCalls.count}/${HARD_REQUEST_CAP}   retries: ${paidCalls.retries}   failures: ${paidCalls.failures}`);
  console.log(`Manifest: out/sample-clips/manifest.json`);
  console.log(`Gallery:  out/sample-clips/index.html`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const key = process.env.FAL_KEY ?? "";
  const token = process.env.REPLICATE_API_TOKEN ?? "";
  console.error(message.split(key).join("[redacted]").split(token).join("[redacted]").slice(0, 400));
  process.exitCode = 1;
});
