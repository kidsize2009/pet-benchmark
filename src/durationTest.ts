import { fal } from "@fal-ai/client";
import { calculateSsimBetweenFrames, downloadFile, getVideoDurationSeconds } from "./media.js";
import { config as loadEnv } from "dotenv";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { access, mkdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const photosDir = path.join(root, "photos-duration");
const outRoot = path.join(root, "out", "duration-test");
const clipsDir = path.join(outRoot, "clips");
const phoneDir = path.join(outRoot, "phone");

const REPLICATE_MODEL = "bytedance/seedance-2.0";
const REPLICATE_SEED = 1234;
const RESOLUTION = "720p";
const ASPECT_RATIO = "9:16";
const GENERATE_AUDIO = false;
const USD_PER_SEC = 0.18;
const PLANNED_PREDICTIONS = 15;
const HARD_CAP = 18;
const MAX_RETRIES_PER_JOB = 1;
const THROTTLE_FALLBACK_MS = 25_000;
const MAX_THROTTLE_WAITS = 20;
const LOOP_SECONDS = 20;
const ALLOWED_DURATIONS = [4, 5, 6];

type Variant = "A" | "B";
const PRESETS = ["gentle", "glance", "breeze"] as const;
type Preset = (typeof PRESETS)[number];

const PROMPTS: Record<Preset, Record<Variant, string>> = {
  gentle: {
    A: "The pet keeps its head almost still. It makes a very small head tilt of a few degrees, blinks once, one ear moves slightly, then it returns to exactly the original pose. Locked camera, subtle motion only.",
    B: "The pet keeps its head almost still. It makes a very small head tilt of a few degrees to one side, blinks once, one ear moves slightly, then a second small tilt toward the other side and a soft slow blink, then it returns to exactly the original pose. Locked camera, subtle motion only.",
  },
  glance: {
    A: "The pet stays in its original pose. Only its eyes shift gently toward the camera with a tiny head movement, then one soft blink, and the gaze returns to the original direction. Locked camera, subtle motion only, ends in exactly the original pose.",
    B: "The pet stays in its original pose. Its eyes shift gently toward the camera with a tiny head movement and one soft blink, then its gaze drifts slightly to the side as if noticing something, and finally returns to the original direction. Locked camera, subtle motion only, ends in exactly the original pose.",
  },
  breeze: {
    A: "Preserve the exact pet identity, fur pattern and composition. A light breeze gently moves the fur, whiskers and ear tips; background foliage sways slightly. One slow blink. The pet stays in the same position and ends in exactly the starting pose. Static camera. No morphing, no new objects.",
    B: "Preserve the exact pet identity, fur pattern and composition. A light breeze comes in two soft gusts, gently moving the fur, whiskers and ear tips; background foliage sways slightly. One slow blink and a small sniff of the air. The pet stays in the same position and ends in exactly the starting pose. Static camera. No morphing, no new objects.",
  },
};

type Job = { preset: Preset; duration: number; variant: Variant; prompt: string };

const JOBS: Job[] = PRESETS.flatMap((preset) => [
  { preset, duration: 4, variant: "A" as Variant },
  { preset, duration: 5, variant: "A" as Variant },
  { preset, duration: 5, variant: "B" as Variant },
  { preset, duration: 6, variant: "A" as Variant },
  { preset, duration: 6, variant: "B" as Variant },
].map((j) => ({ ...j, prompt: PROMPTS[preset][j.variant] })));

type ManifestItem = {
  preset: Preset;
  duration: number;
  variant: Variant;
  prompt: string;
  file: string;
  predictionId: string;
  width: number | null;
  height: number | null;
  fps: number | null;
  realDurationSec: number | null;
  fileSizeBytes: number;
  generationTimeSec: number;
  estimatedCostUsd: number;
  loopSeamSsim: number | null;
};

const ffmpegBinary = (createRequire(import.meta.url)("ffmpeg-static") as string | null) ?? "ffmpeg";

function runFfmpeg(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegBinary, args, { windowsHide: true });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (out += c));
    child.stderr.on("data", (c: string) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
    child.on("error", () => resolve({ code: -1, out }));
  });
}

async function ffmpegOk(args: string[]): Promise<void> {
  const r = await runFfmpeg(["-y", "-hide_banner", ...args]);
  if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.out.slice(-600)}`);
}

async function probeVideo(p: string) {
  const { out } = await runFfmpeg(["-i", p]);
  const res = out.match(/Video:.*?,\s*(\d{2,5})x(\d{2,5})/);
  const fps = out.match(/(\d+(?:\.\d+)?)\s*fps/);
  let durationSec: number | null = null;
  try {
    durationSec = Math.round((await getVideoDurationSeconds(p)) * 100) / 100;
  } catch {
    durationSec = null;
  }
  return { width: res ? Number(res[1]) : null, height: res ? Number(res[2]) : null, fps: fps ? Number(fps[1]) : null, durationSec };
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const est = (d: number) => Math.round(d * USD_PER_SEC * 100) / 100;
const clipBase = (j: { preset: string; duration: number; variant: string }) => `${j.preset}-${j.duration}s-${j.variant}`;

async function nextFreeClipPath(j: Job): Promise<{ file: string; index: number }> {
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${clipBase(j)}.mp4` : `${clipBase(j)}-${i}.mp4`;
    if (!(await exists(path.join(clipsDir, name)))) return { file: name, index: i };
  }
}

function parseArgs(argv: string[]) {
  const o: { dryRun: boolean; only?: Preset; duration?: number } = { dryRun: false };
  for (const a of argv) {
    if (a === "--dry-run") o.dryRun = true;
    else if (a.startsWith("--only=")) {
      const v = a.slice(7) as Preset;
      if (!PRESETS.includes(v)) throw new Error(`--only must be one of ${PRESETS.join("|")}`);
      o.only = v;
    } else if (a.startsWith("--duration=")) {
      const v = Number(a.slice(11));
      if (!ALLOWED_DURATIONS.includes(v)) throw new Error("--duration must be 4|5|6");
      o.duration = v;
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return o;
}

async function findPhotos(): Promise<Record<Preset, string>> {
  const res = {} as Record<Preset, string>;
  for (const p of PRESETS) {
    const hit = [".jpg", ".png"].map((e) => path.join(photosDir, p + e));
    let found: string | undefined;
    for (const h of hit) if (await exists(h)) { found = h; break; }
    if (!found) throw new Error(`Missing photo for preset "${p}" in photos-duration/ (.jpg or .png). Stopping.`);
    res[p] = found;
  }
  return res;
}

async function checkSchema(token: string): Promise<string> {
  const r = await fetch(`https://api.replicate.com/v1/models/${REPLICATE_MODEL}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Schema fetch failed [${r.status}]. Stopping.`);
  const j = (await r.json()) as any;
  const d = j?.latest_version?.openapi_schema?.components?.schemas?.Input?.properties?.duration;
  if (!d) throw new Error("Could not read 'duration' from the model input schema. Stopping.");
  const min = d.minimum ?? -Infinity;
  const max = d.maximum ?? Infinity;
  const intOk = d.type === "integer";
  const ok = intOk && ALLOWED_DURATIONS.every((x) => x >= min && x <= max) && (!d.enum || ALLOWED_DURATIONS.every((x) => d.enum.includes(x)));
  const msg = `duration: type=${d.type} min=${d.minimum} max=${d.maximum}${d.enum ? ` enum=${JSON.stringify(d.enum)}` : ""}`;
  if (!ok) throw new Error(`Schema does not allow 4/5/6 s (${msg}). Stopping.`);
  return msg;
}

type RepPrediction = { id: string; status: string; output?: unknown; error?: string | null };

let paidCalls = 0;
function budgetCheck(label: string) {
  if (paidCalls >= HARD_CAP) throw new Error(`Paid-call cap (${HARD_CAP}) reached before ${label}. Aborting.`);
  paidCalls++;
}

async function genReplicate(imageUrl: string, prompt: string, duration: number, token: string): Promise<{ url: string; id: string }> {
  const createUrl = `https://api.replicate.com/v1/models/${REPLICATE_MODEL}/predictions`;
  const body = JSON.stringify({
    input: {
      image: imageUrl,
      last_frame_image: imageUrl,
      prompt,
      duration,
      resolution: RESOLUTION,
      aspect_ratio: ASPECT_RATIO,
      generate_audio: GENERATE_AUDIO,
      seed: REPLICATE_SEED,
    },
  });
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  let res: Response;
  for (let waited = 0; ; waited++) {
    res = await fetch(createUrl, { method: "POST", headers, body });
    if (res.status === 429 && waited < MAX_THROTTLE_WAITS) {
      const ra = Number(res.headers.get("retry-after"));
      const ms = Number.isFinite(ra) && ra > 0 ? Math.ceil(ra * 1000) + 500 : THROTTLE_FALLBACK_MS;
      console.log(`  429 throttled; waiting ${Math.round(ms / 1000)}s (not counted as paid)`);
      await sleep(ms);
      continue;
    }
    break;
  }
  if (!res.ok) throw new Error(`Replicate create failed [${res.status}]: ${(await res.text()).slice(0, 200)}`);
  budgetCheck("replicate clip");
  let p = (await res.json()) as RepPrediction;
  const id = p.id;
  const deadline = Date.now() + 20 * 60 * 1000;
  while (p.status !== "succeeded") {
    if (p.status === "failed" || p.status === "canceled") throw new Error(`Replicate prediction ${p.status}: ${String(p.error ?? "unknown")}`);
    if (Date.now() > deadline) throw new Error("Replicate prediction timed out");
    await sleep(4000);
    const poll = await fetch(`https://api.replicate.com/v1/predictions/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!poll.ok) throw new Error(`Replicate poll failed [${poll.status}]`);
    p = (await poll.json()) as RepPrediction;
  }
  const out = Array.isArray(p.output) ? p.output[0] : p.output;
  if (typeof out !== "string" || !out) throw new Error("Replicate prediction returned no output URL");
  return { url: out, id };
}

async function readManifest(): Promise<ManifestItem[]> {
  try {
    return JSON.parse(await readFile(path.join(outRoot, "manifest.json"), "utf8")) as ManifestItem[];
  } catch {
    return [];
  }
}

async function writeManifest(m: ManifestItem[]) {
  await writeFile(path.join(outRoot, "manifest.json"), JSON.stringify(m, null, 2));
}

function printPlan(jobs: Job[], photos: Record<Preset, string>) {
  console.log(`Model: ${REPLICATE_MODEL}  params: resolution=${RESOLUTION} aspect_ratio=${ASPECT_RATIO} generate_audio=${GENERATE_AUDIO} seed=${REPLICATE_SEED} image=last_frame_image=same URL`);
  let total = 0;
  jobs.forEach((j, i) => {
    total += est(j.duration);
    console.log(`${String(i + 1).padStart(2)}. ${clipBase(j)}  duration=${j.duration}  photo=${path.basename(photos[j.preset])}  est=$${est(j.duration).toFixed(2)}`);
    console.log(`      prompt: ${j.prompt}`);
  });
  console.log(`Planned predictions: ${jobs.length} (cap ${HARD_CAP}, max ${MAX_RETRIES_PER_JOB} retry/job)  estimated total: $${total.toFixed(2)}`);
}

// ---------- phone / gallery ----------

const LABEL_ORDER: { d: number; v: Variant; label: string }[] = [
  { d: 4, v: "A", label: "4s" },
  { d: 5, v: "A", label: "5s A" },
  { d: 5, v: "B", label: "5s B" },
  { d: 6, v: "A", label: "6s A" },
  { d: 6, v: "B", label: "6s B" },
];

function latest(m: ManifestItem[], preset: Preset, d: number, v: Variant): ManifestItem | undefined {
  const items = m.filter((x) => x.preset === preset && x.duration === d && x.variant === v);
  return items[items.length - 1];
}

async function makeLoop(item: ManifestItem): Promise<string> {
  const src = path.join(clipsDir, item.file);
  const name = item.file.replace(/\.mp4$/, "-loop.mp4");
  const dst = path.join(phoneDir, name);
  if (await exists(dst)) return dst;
  // First and last frames are identical, so drop the last frame to avoid a doubled frame at the loop seam.
  const frames = Math.round((item.realDurationSec ?? item.duration) * (item.fps ?? 24)) - 1;
  const tmp = path.join(phoneDir, `_tmp_${item.file}`);
  await ffmpegOk(["-i", src, "-an", "-vf", `trim=end_frame=${frames},setpts=PTS-STARTPTS`, "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", tmp]);
  try {
    await ffmpegOk(["-stream_loop", "-1", "-i", tmp, "-t", String(LOOP_SECONDS), "-an", "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart", dst]);
  } finally {
    await rm(tmp, { force: true });
  }
  return dst;
}

async function makeCompare(preset: Preset, loops: string[]) {
  const dst = path.join(phoneDir, `${preset}-compare.mp4`);
  if (await exists(dst)) return;
  const font = "C\\:/Windows/Fonts/arial.ttf";
  const chains = loops.map((_, i) => `[${i}:v]scale=216:384,setsar=1,drawtext=fontfile='${font}':text='${LABEL_ORDER[i].label}':fontcolor=white:fontsize=30:box=1:boxcolor=black@0.6:boxborderw=6:x=(w-text_w)/2:y=12[v${i}]`);
  const graph = `${chains.join(";")};${loops.map((_, i) => `[v${i}]`).join("")}hstack=inputs=${loops.length}[out]`;
  const args = loops.flatMap((l) => ["-i", l]);
  await ffmpegOk([...args, "-filter_complex", graph, "-map", "[out]", "-t", String(LOOP_SECONDS), "-an", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart", dst]);
}

function buildIndexHtml(m: ManifestItem[]): string {
  const rows = PRESETS.map((preset) => {
    const cells = LABEL_ORDER.map((c) => {
      const it = latest(m, preset, c.d, c.v);
      if (!it) return `<div class="cell"><div class="lbl">${c.label}</div><div class="missing">missing</div></div>`;
      const loop = `phone/${it.file.replace(/\.mp4$/, "-loop.mp4")}`;
      const ssim = it.loopSeamSsim == null ? "n/a" : it.loopSeamSsim.toFixed(4);
      return `<div class="cell"><div class="lbl">${c.label}</div><div class="frame"><video src="${loop}" muted loop playsinline preload="auto"></video><div class="clock"><span>10:26</span></div></div><div class="seam">seam SSIM ${ssim}</div></div>`;
    }).join("");
    return `<section><h2>${preset}</h2><div class="row" data-row>${cells}</div></section>`;
  }).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Duration test</title><style>
body{background:#111;color:#eee;font-family:system-ui,sans-serif;margin:16px}
.row{display:flex;gap:10px;align-items:flex-start}
.cell{flex:1;min-width:0;text-align:center}
.lbl{font-weight:600;margin-bottom:4px}
.frame{position:relative;aspect-ratio:9/16;background:#000}
video{width:100%;height:100%;object-fit:cover;display:block}
.clock{display:none;position:absolute;left:0;right:0;top:0;height:33.3%;align-items:center;justify-content:center;color:#fff;font-size:min(7vw,64px);font-weight:300;text-shadow:0 1px 8px rgba(0,0,0,.5);pointer-events:none}
body.lock .clock{display:flex}
.seam{font-size:12px;color:#aaa;margin-top:4px}
.missing{aspect-ratio:9/16;display:flex;align-items:center;justify-content:center;background:#222}
label{cursor:pointer}
</style></head><body>
<h1>Seedance 2.0 duration test</h1>
<label><input type="checkbox" id="lock"> Lock-screen overlay</label>
${rows}
<script>
const vids=[...document.querySelectorAll("video")];
document.getElementById("lock").onchange=e=>document.body.classList.toggle("lock",e.target.checked);
function syncAll(){vids.forEach(v=>{v.currentTime=0;v.play().catch(()=>{});});}
let ready=0;vids.forEach(v=>v.addEventListener("canplaythrough",()=>{if(++ready===vids.length)syncAll();},{once:true}));
setInterval(()=>{const t=vids[0]&&vids[0].currentTime;vids.forEach(v=>{if(Math.abs(v.currentTime-t)>0.15)v.currentTime=t;});},2000);
</script></body></html>`;
}

async function buildPhone(m: ManifestItem[]) {
  await mkdir(phoneDir, { recursive: true });
  for (const preset of PRESETS) {
    const loops: string[] = [];
    for (const c of LABEL_ORDER) {
      const it = latest(m, preset, c.d, c.v);
      if (it) loops.push(await makeLoop(it));
    }
    if (loops.length === LABEL_ORDER.length) await makeCompare(preset, loops);
    else console.log(`  ${preset}: compare skipped (${loops.length}/5 clips)`);
  }
  await writeFile(path.join(outRoot, "index.html"), buildIndexHtml(m));
}

// ---------- main ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const photos = await findPhotos();
  let jobs = JOBS.filter((j) => (!opts.only || j.preset === opts.only) && (!opts.duration || j.duration === opts.duration));
  if (jobs.length === 0) throw new Error("No jobs selected.");

  if (opts.dryRun) {
    printPlan(jobs, photos);
    console.log("Dry run: no API calls made.");
    return;
  }

  loadEnv({ path: path.join(root, ".env") });
  const falKey = process.env.FAL_KEY ?? "";
  const token = process.env.REPLICATE_API_TOKEN ?? "";
  if (!falKey) throw new Error("FAL_KEY is missing in the existing environment. Stopping.");
  if (!token) throw new Error("REPLICATE_API_TOKEN is missing in the existing environment. Stopping.");
  fal.config({ credentials: falKey });

  console.log(`Schema check OK: ${await checkSchema(token)}`);
  printPlan(jobs, photos);

  await mkdir(clipsDir, { recursive: true });
  const manifest = await readManifest();
  const urlCache = new Map<Preset, string>();
  let failed = 0;
  let retries = 0;

  for (const job of jobs) {
    let done = false;
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_JOB && !done; attempt++) {
      if (attempt > 0) retries++;
      try {
        if (!urlCache.has(job.preset)) {
          const abs = photos[job.preset];
          const buf = await readFile(abs);
          urlCache.set(job.preset, await fal.storage.upload(new Blob([buf], { type: abs.endsWith(".png") ? "image/png" : "image/jpeg" })));
        }
        console.log(`[${clipBase(job)}] attempt ${attempt + 1}`);
        const t0 = Date.now();
        const r = await genReplicate(urlCache.get(job.preset)!, job.prompt, job.duration, token);
        const genSec = Math.round((Date.now() - t0) / 100) / 10;
        const { file } = await nextFreeClipPath(job);
        const dst = path.join(clipsDir, file);
        await downloadFile(r.url, dst);
        const probe = await probeVideo(dst);
        const seam = await calculateSsimBetweenFrames(dst, 0, "last");
        manifest.push({
          preset: job.preset,
          duration: job.duration,
          variant: job.variant,
          prompt: job.prompt,
          file,
          predictionId: r.id,
          width: probe.width,
          height: probe.height,
          fps: probe.fps,
          realDurationSec: probe.durationSec,
          fileSizeBytes: (await stat(dst)).size,
          generationTimeSec: genSec,
          estimatedCostUsd: est(job.duration),
          loopSeamSsim: seam,
        });
        await writeManifest(manifest);
        console.log(`  done ${file} ${probe.width}x${probe.height} ${probe.fps}fps ${probe.durationSec}s seam=${seam} gen=${genSec}s`);
        done = true;
      } catch (e) {
        console.log(`  failed: ${(e as Error).message.replace(token, "***").slice(0, 300)}`);
        if (paidCalls >= HARD_CAP) break;
      }
    }
    if (!done) failed++;
  }

  await buildPhone(manifest);
  const cost = manifest.filter((x) => jobs.some((j) => j.preset === x.preset && j.duration === x.duration && j.variant === x.variant)).reduce((s, x) => s + x.estimatedCostUsd, 0);
  console.log(`Finished: ${jobs.length - failed}/${jobs.length} ok, ${failed} failed, ${retries} retries, paid predictions created=${paidCalls}, est cost of delivered clips $${cost.toFixed(2)}`);
  console.log(`Output: ${outRoot}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
