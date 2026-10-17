import { fal } from "@fal-ai/client";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { config as loadEnv } from "dotenv";
import { readdir, readFile, writeFile, mkdir, access, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { models, type ModelConfig } from "../models.js";
import { presetDurations, presets, type PresetName } from "../presets.js";
import { calculateEndpointSsim, calculateMinimumConsecutiveSsim, calculateMinimumSsimToFirstFrame, calculateSsimBetweenFrames, cropToPortrait, downloadFile, getVideoFrameCount, makeClip, makeThreeSecondClip, readFocusFile, verifyFfmpeg } from "./media.js";
import { extractVideoUrl } from "./fal-result.js";
import { makePingpong } from "./loopfix.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportColumns = ["photo", "model", "preset", "loop", "seconds_generated", "cost_usd", "latency_s", "success", "error", "ssim_first_last", "ssim_min_consecutive", "ssim_min_vs_first", "output_path", "request_id"];
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);
type CliOptions = { photos: string; out: string; limit?: number; only?: string; concurrency: number; preset: PresetName; duration?: number; dryRun: boolean; yes: boolean; loop: boolean; loopOnly: boolean; maxUsd?: number; modelIds?: string[] };
type Job = { photo: string; photoPath: string; model: ModelConfig; preset: PresetName; loop: boolean; generatedSeconds: number; preserveDuration: boolean; cost: number; outputPath: string; relativeOutputPath: string };
type ReportRow = Record<string, string>;

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { photos: "photos", out: "out", concurrency: 3, preset: "subtle_life", dryRun: false, yes: false, loop: false, loopOnly: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const value = () => {
      const next = args[++index];
      if (!next || next.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      return next;
    };
    if (arg === "--photos") options.photos = value();
    else if (arg === "--out") options.out = value();
    else if (arg === "--limit") options.limit = positiveInteger(value(), "--limit");
    else if (arg === "--only") options.only = value();
    else if (arg === "--concurrency") options.concurrency = positiveInteger(value(), "--concurrency");
    else if (arg === "--models") {
      options.modelIds = value().split(",").map((modelId) => modelId.trim()).filter(Boolean);
      if (options.modelIds.length === 0) throw new Error("--models must contain at least one model id");
    }
    else if (arg === "--preset") {
      const selected = value();
      if (!(selected in presets)) throw new Error(`Unknown preset ${selected}. Choose: ${Object.keys(presets).join(", ")}`);
      options.preset = selected as PresetName;
    } else if (arg === "--duration") options.duration = positiveInteger(value(), "--duration");
    else if (arg === "--max-usd") options.maxUsd = nonNegativeNumber(value(), "--max-usd");
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--loop") options.loop = true;
    else if (arg === "--loop-only") options.loopOnly = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run benchmark -- [--photos DIR] [--out DIR] [--limit N] [--only TEXT] [--models ID,ID] [--preset NAME] [--duration SECONDS] [--loop [--loop-only]] [--concurrency N] [--dry-run | --yes] [--max-usd X]");
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.dryRun && options.yes) throw new Error("Use either --dry-run or --yes, not both");
  if (options.loopOnly && !options.loop) throw new Error("--loop-only requires --loop");
  return options;
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${option} must be a positive integer`);
  return parsed;
}

function nonNegativeNumber(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${option} must be a non-negative number`);
  return parsed;
}

function formatEstimate(amount: number): string {
  return Number(amount.toFixed(4)) === Number(amount.toFixed(5))
    ? amount.toFixed(4)
    : amount.toFixed(5);
}

function photoId(filename: string): string {
  return path.parse(filename).name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function csvEscapeRows(rows: ReportRow[]): string {
  return stringify(rows, { header: true, columns: reportColumns });
}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

async function readReport(reportPath: string): Promise<ReportRow[]> {
  if (!(await exists(reportPath))) return [];
  return parse(await readFile(reportPath, "utf8"), { columns: true, skip_empty_lines: true }) as ReportRow[];
}

function jobKey(row: ReportRow): string {
  return `${row.photo}|${row.model}|${row.preset}|${row.loop}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

async function writeGallery(outDir: string, rows: ReportRow[], columns: string[]): Promise<void> {
  const photos = [...new Set(rows.map((row) => row.photo))].sort();
  const titleCells = columns.map((column) => `<th>${escapeHtml(column.replaceAll("|", " / "))}</th>`).join("");
  const tableRows = await Promise.all(photos.map(async (photo) => {
    const cells = await Promise.all(columns.map(async (column) => {
      const row = rows.find((item) => item.photo === photo && `${item.model}|${item.preset}|${item.loop}` === column && item.success === "true");
      if (!row || !row.output_path) return "<td></td>";
      const relative = path.relative(outDir, path.resolve(root, row.output_path)).split(path.sep).join("/");
      if (!(await exists(path.resolve(outDir, relative)))) return "<td></td>";
      return `<td><video muted loop autoplay playsinline controls preload="metadata" src="${escapeHtml(relative)}"></video><div>$${Number(row.cost_usd).toFixed(4)}</div></td>`;
    }));
    return `<tr><th>${escapeHtml(photo)}</th>${cells.join("")}</tr>`;
  }));
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pet video benchmark</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#202522;background:#f3f5f1}h1{font-size:22px}main{overflow:auto}table{border-collapse:collapse;min-width:100%;background:white}th,td{border:1px solid #d8ded8;padding:10px;text-align:left;vertical-align:top}thead th{position:sticky;top:0;background:#e8eee8}tbody th{position:sticky;left:0;background:#f7f9f6}video{display:block;width:180px;max-width:30vw;aspect-ratio:9/16;background:#111;object-fit:contain;margin-bottom:6px}</style></head>
<body><h1>Pet video benchmark</h1><main><table><thead><tr><th>Photo</th>${titleCells}</tr></thead><tbody>${tableRows.join("")}</tbody></table></main></body></html>`;
  await writeFile(path.join(outDir, "index.html"), html, "utf8");
}

function buildInput(job: Job, imageUrl: string): Record<string, unknown> {
  const input: Record<string, unknown> = { image_url: imageUrl, prompt: presets[job.preset] };
  if (job.model.duration === null || job.model.durationValueType === null) {
    throw new Error(`${job.model.id} is enabled but duration is not configured in models.ts`);
  }
  input.duration = job.model.durationValueType === "string" ? String(job.generatedSeconds) : job.generatedSeconds;
  if (job.model.resolution) input.resolution = job.model.resolution;
  if (job.model.aspectRatio) input.aspect_ratio = job.model.aspectRatio;
  if (job.model.generateAudio !== undefined) input.generate_audio = job.model.generateAudio;
  if (job.loop) input.end_image_url = imageUrl;
  return input;
}

function isPingpongPreset(preset: PresetName): boolean {
  return preset.endsWith("_pp");
}

function redact(message: string, apiKey: string): string {
  return apiKey ? message.split(apiKey).join("[redacted]") : message;
}

function errorStatus(error: unknown, queueStatus?: string): string {
  if (error !== null && typeof error === "object" && "status" in error) {
    const status = error.status;
    if (typeof status === "number" || typeof status === "string") return String(status);
  }
  return queueStatus ?? "unknown";
}

async function runJob(job: Job, imageUrl: string, apiKey: string): Promise<ReportRow> {
  const started = Date.now();
  const rawPath = `${job.outputPath}.download.mp4`;
  const forwardPath = `${job.outputPath}.forward.mp4`;
  const row: ReportRow = {
    photo: job.photo,
    model: job.model.id,
    preset: job.preset,
    loop: String(job.loop),
    seconds_generated: String(job.generatedSeconds),
    cost_usd: job.cost.toFixed(6),
    latency_s: "",
    success: "false",
    error: "",
    ssim_first_last: "",
    ssim_min_consecutive: "",
    ssim_min_vs_first: "",
    output_path: job.relativeOutputPath,
    request_id: "",
  };
  let queueStatus: string | undefined;
  try {
    let lastLoggedStatus: string | undefined;
    let lastLoggedAt = 0;
    const result = await fal.subscribe(job.model.endpoint, {
      input: buildInput(job, imageUrl),
      logs: false,
      onQueueUpdate(update) {
        queueStatus = update.status;
        const status = update.status;
        const now = Date.now();
        if (status !== lastLoggedStatus && now - lastLoggedAt >= 30_000) {
          console.log(`  ${job.photo} / ${job.model.id} / ${job.preset}${job.loop ? " / loop" : ""}: ${update.status}`);
          lastLoggedAt = now;
          lastLoggedStatus = status;
        }
      },
    });
    row.request_id = result.requestId;
    const rawDir = path.join(root, "out", "raw");
    await mkdir(rawDir, { recursive: true });
    const rawName = `${job.photo}__${job.model.id}__${job.preset}${job.loop ? "__loop" : ""}.json`;
    await writeFile(path.join(rawDir, rawName), JSON.stringify({ requestId: result.requestId, response: result }, null, 2), "utf8");
    const videoUrl = extractVideoUrl(result);
    await downloadFile(videoUrl, rawPath);
    if (isPingpongPreset(job.preset)) {
      await makeThreeSecondClip(rawPath, forwardPath);
      const frameCount = await getVideoFrameCount(forwardPath, 30);
      await makePingpong(forwardPath, job.outputPath, frameCount);
    } else if (job.preserveDuration) {
      await makeClip(rawPath, job.outputPath, job.generatedSeconds);
    } else {
      await makeThreeSecondClip(rawPath, job.outputPath);
    }
    row.latency_s = ((Date.now() - started) / 1000).toFixed(2);
    row.success = "true";
    row.error = "";
    try {
      const [endpointSsim, minimumConsecutiveSsim, minimumVsFirst] = await Promise.all([
        isPingpongPreset(job.preset) || job.preserveDuration
          ? calculateSsimBetweenFrames(job.outputPath, 0, "last")
          : calculateEndpointSsim(job.outputPath),
        calculateMinimumConsecutiveSsim(job.outputPath, 30),
        job.preset.endsWith("_v4")
          ? calculateMinimumSsimToFirstFrame(job.outputPath, 30)
          : Promise.resolve(null),
      ]);
      row.ssim_first_last = endpointSsim === null ? "" : endpointSsim.toFixed(6);
      row.ssim_min_consecutive = minimumConsecutiveSsim === null ? "" : minimumConsecutiveSsim.toFixed(6);
      row.ssim_min_vs_first = minimumVsFirst === null ? "" : minimumVsFirst.toFixed(6);
      console.log(`  SSIM ${job.photo} / ${job.preset}: min_vs_first=${row.ssim_min_vs_first || "n/a"}, first_last=${row.ssim_first_last || "n/a"}`);
    } catch (error) {
      row.error = `SSIM failed: ${error instanceof Error ? error.message : String(error)}`.replace(/\s+/g, " ").slice(0, 1500);
    }
  } catch (error) {
    await rm(job.outputPath, { force: true });
    row.latency_s = ((Date.now() - started) / 1000).toFixed(2);
    const message = error instanceof Error ? error.message : String(error);
    const statusSuffix = ` (status: ${errorStatus(error, queueStatus)})`;
    const sanitizedMessage = redact(message, apiKey).replace(/\s+/g, " ");
    row.error = `${sanitizedMessage.slice(0, Math.max(0, 1500 - statusSuffix.length))}${statusSuffix}`;
    console.error(`  FAILED ${job.photo} / ${job.model.id}: ${row.error}`);
  } finally {
    await rm(rawPath, { force: true });
    await rm(forwardPath, { force: true });
  }
  return row;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const photosDir = path.resolve(root, options.photos);
  const outDir = path.resolve(root, options.out);
  loadEnv({ path: path.join(root, ".env") });
  const apiKey = process.env.FAL_KEY ?? "";

  const configuredModelIds = new Set(models.map((model) => model.id));
  const requestedModelIds = options.modelIds ? new Set(options.modelIds) : undefined;
  for (const modelId of requestedModelIds ?? []) {
    if (!configuredModelIds.has(modelId)) throw new Error(`Unknown model id ${modelId}. Choose: ${models.map((model) => model.id).join(", ")}`);
  }
  const enabledModels = models.filter((model) => model.enabled && (!requestedModelIds || requestedModelIds.has(model.id)));
  if (requestedModelIds && enabledModels.length !== requestedModelIds.size) {
    const disabled = [...requestedModelIds].filter((modelId) => !enabledModels.some((model) => model.id === modelId));
    throw new Error(`Selected models are disabled: ${disabled.join(", ")}`);
  }
  for (const model of enabledModels) {
    if (model.duration === null || model.durationValueType === null) throw new Error(`${model.id} is enabled but duration is not configured in models.ts`);
  }
  const photos = (await readdir(photosDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => ({ name: photoId(entry.name), file: entry.name, fullPath: path.join(photosDir, entry.name) }))
    .sort((a, b) => a.file.localeCompare(b.file))
    .filter((photo) => options.only === undefined || photo.file.toLowerCase().includes(options.only.toLowerCase()))
    .slice(0, options.limit);
  if (photos.length === 0) {
    const filterDescription = options.only === undefined ? "" : ` matching --only ${options.only}`;
    throw new Error(`No supported images found${filterDescription} in ${photosDir}`);
  }
  if (new Set(photos.map((photo) => photo.name)).size !== photos.length) throw new Error("Photo filenames must have unique names without their extensions");

  const focusPoints = await readFocusFile(path.join(photosDir, "focus.json"));
  const existingRows = await readReport(path.join(outDir, "report.csv"));
  const jobs: Job[] = [];
  for (const photo of photos) {
    for (const model of enabledModels) {
      const variants = options.loopOnly
        ? model.supportsEndFrame && !isPingpongPreset(options.preset) ? [true] : []
        : [false, ...(options.loop && model.supportsEndFrame && !isPingpongPreset(options.preset) ? [true] : [])];
      for (const loop of variants) {
        const generatedSeconds = options.duration ?? presetDurations[options.preset] ?? model.duration!;
        const preserveDuration = options.duration !== undefined || presetDurations[options.preset] !== undefined;
        const filename = `${model.id}_${options.preset}${loop ? "_loop" : ""}.mp4`;
        const outputPath = path.join(outDir, photo.name, filename);
        const relativeOutputPath = path.relative(root, outputPath).split(path.sep).join("/");
        jobs.push({ photo: photo.name, photoPath: photo.fullPath, model, preset: options.preset, loop, generatedSeconds, preserveDuration, cost: generatedSeconds * model.pricePerSecond, outputPath, relativeOutputPath });
      }
    }
  }

  const pendingJobs: Job[] = [];
  for (const job of jobs) {
    if (await exists(job.outputPath)) {
      console.log(`SKIP exists ${job.relativeOutputPath}`);
      continue;
    }
    pendingJobs.push(job);
  }
  const estimate = pendingJobs.reduce((total, job) => total + job.cost, 0);
  const estimatedSpend = Number(estimate.toFixed(6));
  for (const job of pendingJobs) {
    const details = [
      job.loop ? "end_image_url=same cropped 9:16 start image" : "",
      isPingpongPreset(job.preset) ? "post-process=pingpong" : "",
    ].filter(Boolean);
    console.log(`${options.dryRun ? "PLAN" : "JOB"} ${job.photo} | ${job.model.id} | ${job.preset}${job.loop ? " | loop" : ""} | ${job.generatedSeconds}s | $${formatEstimate(job.cost)}${details.length ? ` | ${details.join(" | ")}` : ""}`);
  }
  console.log(`Estimated total for ${pendingJobs.length} pending jobs: $${formatEstimate(estimate)}`);
  if (options.dryRun) return;
  if (!options.yes) throw new Error("Real runs require --yes (or use --dry-run)");
  if (!apiKey) throw new Error("FAL_KEY is missing. Add it to tools/pet-benchmark/.env; the key is never printed.");
  if (options.maxUsd !== undefined && estimatedSpend > options.maxUsd) {
    throw new Error(`Estimated spend $${estimatedSpend.toFixed(4)} exceeds --max-usd $${options.maxUsd.toFixed(4)}; no jobs submitted`);
  }

  await verifyFfmpeg();
  fal.config({ credentials: apiKey });
  await mkdir(outDir, { recursive: true });
  const focus = focusPoints;
  const photoUploads = new Map<string, Promise<{ imageUrl?: string; error?: string }>>();
  const reportMap = new Map(existingRows.map((row) => [jobKey(row), row]));
  const columns = [...new Set([...jobs.map((job) => `${job.model.id}|${job.preset}|${job.loop}`), ...existingRows.map((row) => `${row.model}|${row.preset}|${row.loop}`)])];
  let cursor = 0;
  let reportWrite = Promise.resolve();
  const workers = Array.from({ length: Math.min(options.concurrency, pendingJobs.length) }, async () => {
    while (cursor < pendingJobs.length) {
      const job = pendingJobs[cursor++];
      try {
        let uploadPromise = photoUploads.get(job.photo);
        if (!uploadPromise) {
          uploadPromise = (async () => {
            try {
              const inputPath = path.join(outDir, job.photo, "input_9x16.jpg");
              await mkdir(path.dirname(inputPath), { recursive: true });
              await cropToPortrait(job.photoPath, inputPath, focus[job.photo] ?? focus[path.basename(job.photoPath)] ?? { x: 0.5, y: 0.5 });
              const image = await fal.storage.upload(new File([await readFile(inputPath)], "input_9x16.jpg", { type: "image/jpeg" }));
              return { imageUrl: image };
            } catch (error) {
              return { error: error instanceof Error ? error.message : String(error) };
            }
          })();
          photoUploads.set(job.photo, uploadPromise);
        }
        const upload = await uploadPromise;
        if (upload.error) console.error(`  FAILED ${job.photo} / ${job.model.id}: ${redact(upload.error, apiKey)}`);
        const row = upload.error
          ? { photo: job.photo, model: job.model.id, preset: job.preset, loop: String(job.loop), seconds_generated: String(job.generatedSeconds), cost_usd: job.cost.toFixed(6), latency_s: "0", success: "false", error: redact(upload.error, apiKey).slice(0, 1500), ssim_first_last: "", ssim_min_consecutive: "", ssim_min_vs_first: "", output_path: job.relativeOutputPath, request_id: "" }
          : await runJob(job, upload.imageUrl!, apiKey);
        reportMap.set(jobKey(row), row);
        reportWrite = reportWrite.then(() => writeFile(path.join(outDir, "report.csv"), csvEscapeRows([...reportMap.values()]), "utf8"));
        await reportWrite;
      } catch (error) {
        console.error(`Unexpected job error (${job.photo}/${job.model.id}): ${redact(String(error), apiKey)}`);
      }
    }
  });
  await Promise.all(workers);
  const finalRows = [...reportMap.values()];
  await writeGallery(outDir, finalRows, columns);
  const failures = finalRows.filter((row) => row.success !== "true").length;
  console.log(`Finished: ${finalRows.filter((row) => row.success === "true").length} successful, ${failures} failed. Report: ${path.join(outDir, "report.csv")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});