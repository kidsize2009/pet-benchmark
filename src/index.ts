import { fal } from "@fal-ai/client";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { config as loadEnv } from "dotenv";
import { readdir, readFile, writeFile, mkdir, access, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { models, type ModelConfig } from "../models.js";
import { presets, type PresetName } from "../presets.js";
import { calculateEndpointSsim, cropToPortrait, downloadFile, makeThreeSecondClip, readFocusFile, verifyFfmpeg } from "./media.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportColumns = ["photo", "model", "preset", "loop", "seconds_generated", "cost_usd", "latency_s", "success", "error", "ssim_first_last", "output_path"];
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);
type CliOptions = { photos: string; out: string; limit?: number; concurrency: number; preset: PresetName; dryRun: boolean; yes: boolean; loop: boolean; maxUsd?: number };
type Job = { photo: string; photoPath: string; model: ModelConfig; preset: PresetName; loop: boolean; generatedSeconds: number; cost: number; outputPath: string; relativeOutputPath: string };
type ReportRow = Record<string, string>;

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { photos: "photos", out: "out", concurrency: 3, preset: "subtle_life", dryRun: false, yes: false, loop: false };
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
    else if (arg === "--concurrency") options.concurrency = positiveInteger(value(), "--concurrency");
    else if (arg === "--preset") {
      const selected = value();
      if (!(selected in presets)) throw new Error(`Unknown preset ${selected}. Choose: ${Object.keys(presets).join(", ")}`);
      options.preset = selected as PresetName;
    } else if (arg === "--max-usd") options.maxUsd = nonNegativeNumber(value(), "--max-usd");
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--loop") options.loop = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run benchmark -- [--photos DIR] [--out DIR] [--limit N] [--preset NAME] [--loop] [--concurrency N] [--dry-run | --yes] [--max-usd X]");
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.dryRun && options.yes) throw new Error("Use either --dry-run or --yes, not both");
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
  input.duration = job.model.durationValueType === "string" ? String(job.model.duration) : job.model.duration;
  if (job.model.resolution) input.resolution = job.model.resolution;
  if (job.model.aspectRatio) input.aspect_ratio = job.model.aspectRatio;
  if (job.model.generateAudio !== undefined) input.generate_audio = job.model.generateAudio;
  if (job.loop) input.end_image_url = imageUrl;
  return input;
}

function redact(message: string, apiKey: string): string {
  return apiKey ? message.split(apiKey).join("[redacted]") : message;
}

async function runJob(job: Job, imageUrl: string, apiKey: string): Promise<ReportRow> {
  const started = Date.now();
  const rawPath = `${job.outputPath}.download.mp4`;
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
    output_path: job.relativeOutputPath,
  };
  try {
    const result = await fal.subscribe(job.model.endpoint, {
      input: buildInput(job, imageUrl),
      logs: false,
      onQueueUpdate(update) {
        if (update.status === "IN_QUEUE" || update.status === "IN_PROGRESS") {
          console.log(`  ${job.photo} / ${job.model.id} / ${job.preset}${job.loop ? " / loop" : ""}: ${update.status}`);
        }
      },
    }) as { video?: { url?: string } };
    if (!result.video?.url) throw new Error("fal response did not contain video.url");
    await downloadFile(result.video.url, rawPath);
    await makeThreeSecondClip(rawPath, job.outputPath);
    row.latency_s = ((Date.now() - started) / 1000).toFixed(2);
    row.success = "true";
    row.error = "";
    try {
      const ssim = await calculateEndpointSsim(job.outputPath);
      row.ssim_first_last = ssim === null ? "" : ssim.toFixed(6);
    } catch (error) {
      row.error = `SSIM failed: ${error instanceof Error ? error.message : String(error)}`.replace(/\s+/g, " ").slice(0, 1500);
    }
  } catch (error) {
    await rm(job.outputPath, { force: true });
    row.latency_s = ((Date.now() - started) / 1000).toFixed(2);
    row.error = redact(error instanceof Error ? error.message : String(error), apiKey).replace(/\s+/g, " ").slice(0, 1500);
    console.error(`  FAILED ${job.photo} / ${job.model.id}: ${row.error}`);
  } finally {
    await rm(rawPath, { force: true });
  }
  return row;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const photosDir = path.resolve(root, options.photos);
  const outDir = path.resolve(root, options.out);
  loadEnv({ path: path.join(root, ".env") });
  const apiKey = process.env.FAL_KEY ?? "";

  const enabledModels = models.filter((model) => model.enabled);
  for (const model of enabledModels) {
    if (model.duration === null || model.durationValueType === null) throw new Error(`${model.id} is enabled but duration is not configured in models.ts`);
  }
  const photos = (await readdir(photosDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => ({ name: photoId(entry.name), file: entry.name, fullPath: path.join(photosDir, entry.name) }))
    .sort((a, b) => a.file.localeCompare(b.file))
    .slice(0, options.limit);
  if (photos.length === 0) throw new Error(`No supported images found in ${photosDir}`);
  if (new Set(photos.map((photo) => photo.name)).size !== photos.length) throw new Error("Photo filenames must have unique names without their extensions");

  const focusPoints = await readFocusFile(path.join(photosDir, "focus.json"));
  const existingRows = await readReport(path.join(outDir, "report.csv"));
  const jobs: Job[] = [];
  for (const photo of photos) {
    for (const model of enabledModels) {
      const variants = [false, ...(options.loop && model.supportsEndFrame ? [true] : [])];
      for (const loop of variants) {
        const generatedSeconds = model.duration!;
        const filename = `${model.id}_${options.preset}${loop ? "_loop" : ""}.mp4`;
        const outputPath = path.join(outDir, photo.name, filename);
        const relativeOutputPath = path.relative(root, outputPath).split(path.sep).join("/");
        jobs.push({ photo: photo.name, photoPath: photo.fullPath, model, preset: options.preset, loop, generatedSeconds, cost: generatedSeconds * model.pricePerSecond, outputPath, relativeOutputPath });
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
  for (const job of pendingJobs) console.log(`${options.dryRun ? "PLAN" : "JOB"} ${job.photo} | ${job.model.id} | ${job.preset}${job.loop ? " | loop" : ""} | ${job.generatedSeconds}s | $${job.cost.toFixed(4)}`);
  console.log(`Estimated total for ${pendingJobs.length} pending jobs: $${estimate.toFixed(4)}`);
  if (options.dryRun) return;
  if (!options.yes) throw new Error("Real runs require --yes (or use --dry-run)");
  if (!apiKey) throw new Error("FAL_KEY is missing. Add it to tools/pet-benchmark/.env; the key is never printed.");
  if (options.maxUsd !== undefined && estimate > options.maxUsd) {
    throw new Error(`Estimated spend $${estimate.toFixed(4)} exceeds --max-usd $${options.maxUsd.toFixed(4)}; no jobs submitted`);
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
          ? { photo: job.photo, model: job.model.id, preset: job.preset, loop: String(job.loop), seconds_generated: String(job.generatedSeconds), cost_usd: job.cost.toFixed(6), latency_s: "0", success: "false", error: redact(upload.error, apiKey).slice(0, 1500), ssim_first_last: "", output_path: job.relativeOutputPath }
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