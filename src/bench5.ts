import { config as loadEnv } from "dotenv";
import { mkdir, readFile, writeFile, access, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import sharp, { type OverlayOptions } from "sharp";
import { fal } from "@fal-ai/client";
import { cropToPortrait, calculateMinimumConsecutiveSsim, calculateMinimumSsimToFirstFrame, calculateSsimBetweenFrames } from "./media.js";
import { extractVideoUrl } from "./fal-result.js";
import { presets, type PresetName } from "../presets.js";
import { models } from "../models.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, "out", "bench5");
const previewDir = path.join(outputDir, "preview");
const ffmpegPath = createRequire(import.meta.url)("ffmpeg-static") as string | null ?? "ffmpeg";
const model = models.find((item) => item.id === "seedance-2-720p-5s")!;
const endpoint = model.endpoint;
const pricePerSecond = model.pricePerSecond;
const budgetLimit = 7.5;
// Normalized head-area ROI for the max pixel deviation metric.
const headRoi = { x: 0.15, y: 0.25, width: 0.7, height: 0.45 };

type Clip = { id: string; photo: string; preset: PresetName; duration: number };
const clips: Clip[] = [
  { id: "breeze", photo: "photos-samples/s_breeze.jpg.jpg", preset: "breeze", duration: 5 },
  { id: "dreamy", photo: "photos-samples/s_dreamy.jpg.jpg", preset: "dreamy", duration: 5 },
  { id: "renaissance", photo: "photos-samples/s_renaissance.jpg.jpg.png", preset: "renaissance_a", duration: 5 },
  { id: "sleepy", photo: "photos-480/crops/p05_blackcat.jpg", preset: "sleepy_v1", duration: 4 },
  { id: "cozy_strong", photo: "photos-480/crops/p06_lab.jpg", preset: "cozy_s1", duration: 4 },
];
const clipCost = (clip: Clip): number => clip.duration * pricePerSecond;
const totalCost = clips.reduce((sum, clip) => sum + clipCost(clip), 0);
const photoPath = (clip: Clip): string => path.join(root, ...clip.photo.split("/"));
const outputName = (clip: Clip): string => `seedance-2-720p_${clip.id}_loop.mp4`;

type RunRow = {
  clip: string; photo: string; preset: string; duration: number; output: string; endpoint: string;
  requestId: string; generationSeconds: number | null; estimatedCost: number; actualCost: number | null;
  width: number | null; height: number | null; minSsimVsFirst: number | null; firstLastSsim: number | null;
  maxFrameDiff: number | null; maxHeadPixelDeviation: number | null; error: string; raw?: unknown;
};

function parseOptions(args: string[]): { dryRun: boolean; reportOnly: boolean; yes: boolean } {
  const options = { dryRun: false, reportOnly: false, yes: false };
  for (const arg of args) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--report-only") options.reportOnly = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run bench5 -- [--dry-run | --report-only | --yes]");
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

const round = (value: number | null): string => (value === null ? "n/a" : value.toFixed(4));

function safeError(value: unknown, apiKey: string): string {
  const message = value instanceof Error ? value.message : String(value);
  return (apiKey ? message.split(apiKey).join("[redacted]") : message).replace(/\s+/g, " ").slice(0, 1600);
}

function actualCostFromResponse(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value)) {
    if (/^(actual_)?(billed_)?cost(_usd)?$|^amount_charged$|^charged_usd$/i.test(key) && typeof nested === "number") return nested;
    if (nested && typeof nested === "object") {
      const found = actualCostFromResponse(nested);
      if (found !== null) return found;
    }
  }
  return null;
}

async function apiRequest(url: string, apiKey: string, init: RequestInit = {}): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Key ${apiKey}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
  const text = await response.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 1500) }; }
  return { response, body };
}

function runFfmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stderr) : reject(new Error(stderr.slice(-1800)))));
  });
}

async function getDimensions(videoPath: string): Promise<{ width: number; height: number }> {
  const output = await runFfmpeg(["-i", videoPath, "-f", "null", "-"]);
  const match = output.match(/Video: [^\n,]+[^\n]*?,\s*(\d{2,5})x(\d{2,5})/);
  if (!match) throw new Error(`Cannot read video dimensions: ${videoPath}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

async function maxHeadPixelDeviation(videoPath: string): Promise<number | null> {
  const { width, height } = await getDimensions(videoPath);
  const left = Math.floor(width * headRoi.x);
  const top = Math.floor(height * headRoi.y);
  const cropWidth = Math.max(2, Math.floor(width * headRoi.width / 2) * 2);
  const cropHeight = Math.max(2, Math.floor(height * headRoi.height / 2) * 2);
  const frameBytes = cropWidth * cropHeight * 3;
  const args = ["-i", videoPath, "-vf", `fps=30,crop=${cropWidth}:${cropHeight}:${left}:${top},format=rgb24`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let first: Buffer | undefined;
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let maxDifference = 0;
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdout.on("data", (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= frameBytes) {
        const frame = pending.subarray(0, frameBytes);
        pending = pending.subarray(frameBytes);
        if (!first) { first = Buffer.from(frame); continue; }
        for (let index = 0; index < frameBytes; index++) {
          const difference = Math.abs(frame[index]! - first[index]!);
          if (difference > maxDifference) maxDifference = difference;
        }
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr.slice(-1800)));
      else resolve(first ? maxDifference : null);
    });
  });
}

function buildInput(imageUrl: string, clip: Clip): Record<string, unknown> {
  return {
    image_url: imageUrl,
    end_image_url: imageUrl,
    prompt: presets[clip.preset],
    duration: String(clip.duration),
    resolution: model.resolution,
    aspect_ratio: model.aspectRatio,
    generate_audio: false,
  };
}

async function writeRenaissancePreview(): Promise<{ source: string; crop: string }> {
  const clip = clips.find((item) => item.id === "renaissance")!;
  const meta = await sharp(photoPath(clip)).rotate().metadata();
  await mkdir(previewDir, { recursive: true });
  const preview = path.join(previewDir, "renaissance_crop.jpg");
  await cropToPortrait(photoPath(clip), preview);
  const ratio = (meta.width ?? 0) / (meta.height ?? 1);
  return { source: `${meta.width}x${meta.height} (ratio ${ratio.toFixed(4)} vs 9:16 = 0.5625)`, crop: preview };
}

async function printDryRun(): Promise<void> {
  console.log("clip\tphoto\tpreset\tduration\tcost");
  for (const clip of clips) {
    console.log(`${clip.id}\t${clip.photo}\t${clip.preset}\t${clip.duration}s\t$${clipCost(clip).toFixed(3)}`);
  }
  console.log(`Total: ${clips.reduce((sum, clip) => sum + clip.duration, 0)} s x $${pricePerSecond}/s = $${totalCost.toFixed(2)} (limit $${budgetLimit.toFixed(2)}).`);
  console.log(`Endpoint: ${endpoint}; ${model.resolution}, ${model.aspectRatio}, audio off, end_image_url = same frame.`);
  for (const clip of clips) {
    if (!(await exists(photoPath(clip)))) console.log(`MISSING photo: ${clip.photo}`);
  }
  const preview = await writeRenaissancePreview();
  console.log(`Renaissance source: ${preview.source}; preview: ${preview.crop}`);
  if (totalCost > budgetLimit) console.log("WARNING: total exceeds budget limit; real run would be refused.");
}

async function waitForResult(input: Record<string, unknown>, apiKey: string): Promise<{ requestId: string; seconds: number; result: unknown }> {
  const started = Date.now();
  const submit = await apiRequest(`https://queue.fal.run/${endpoint}`, apiKey, { method: "POST", body: JSON.stringify(input) });
  if (!submit.response.ok) throw new Error(`Submit rejected HTTP ${submit.response.status}: ${JSON.stringify(submit.body).slice(0, 1200)}`);
  const queue = submit.body as { request_id?: string; status_url?: string; response_url?: string };
  if (!queue.request_id || !queue.status_url || !queue.response_url) throw new Error(`Accepted response missing queue fields: ${Object.keys(queue).join(",")}`);
  await writeFile(path.join(outputDir, "raw", `${queue.request_id}__submitted.json`), JSON.stringify({ requestId: queue.request_id, queue, input }, null, 2), "utf8");
  let lastStatus = "";
  while (true) {
    const statusUrl = new URL(queue.status_url);
    statusUrl.searchParams.set("logs", "0");
    const statusResponse = await apiRequest(statusUrl.toString(), apiKey);
    if (!statusResponse.response.ok) throw new Error(`Status HTTP ${statusResponse.response.status}: request ${queue.request_id}`);
    const status = statusResponse.body as { status?: string };
    if (status.status !== lastStatus) {
      console.log(`  ${queue.request_id}: ${status.status ?? "unknown"}`);
      lastStatus = status.status ?? "unknown";
    }
    if (status.status === "COMPLETED") break;
    if (status.status === "FAILED") throw new Error(`Queue failed for request ${queue.request_id}`);
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  const result = await apiRequest(queue.response_url, apiKey);
  if (!result.response.ok) throw new Error(`Result HTTP ${result.response.status}: request ${queue.request_id}`);
  return { requestId: queue.request_id, seconds: (Date.now() - started) / 1000, result: result.body };
}

async function createContactSheet(rows: RunRow[]): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bench5-sheet-"));
  const tileWidth = 160;
  const tileHeight = 284;
  const labelWidth = 300;
  const composites: OverlayOptions[] = [];
  try {
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex]!;
      const file = path.join(outputDir, row.output);
      if (!(await exists(file))) continue;
      const info = await runFfmpeg(["-i", file, "-vf", "fps=30,showinfo", "-f", "null", "-"]);
      const matches = [...info.matchAll(/\bn:\s*(\d+)/g)];
      const frameCount = Number(matches.at(-1)?.[1] ?? 0) + 1;
      const y = rowIndex * tileHeight;
      const label = Buffer.from(`<svg width="${labelWidth}" height="${tileHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#f2f3ef"/><text x="12" y="30" font-family="Arial" font-size="16" fill="#202522">${row.clip}</text><text x="12" y="56" font-family="Arial" font-size="13" fill="#202522">${row.preset}</text><text x="12" y="82" font-family="Arial" font-size="13" fill="#202522">${row.width}x${row.height} ${row.duration}s</text></svg>`);
      composites.push({ input: label, left: 0, top: y });
      for (let index = 0; index < 8; index++) {
        const frameNumber = Math.round(index * (frameCount - 1) / 7);
        const png = path.join(tempDir, `${rowIndex}-${index}.png`);
        await runFfmpeg(["-y", "-i", file, "-vf", `fps=30,select=eq(n\\,${frameNumber})`, "-frames:v", "1", png]);
        const tile = await sharp(png).resize(tileWidth, tileHeight, { fit: "contain", background: "#111" }).jpeg({ quality: 86 }).toBuffer();
        composites.push({ input: tile, left: labelWidth + index * tileWidth, top: y });
      }
    }
    await sharp({ create: { width: labelWidth + 8 * tileWidth, height: tileHeight * rows.length, channels: 3, background: "#111" } })
      .composite(composites)
      .jpeg({ quality: 88 })
      .toFile(path.join(outputDir, "contact-sheet.jpg"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function printTable(rows: RunRow[]): void {
  console.log("clip\tpreset\tduration\tminSSIM_vs_first\tfirst_last_SSIM\tmax_frame_diff\tmax_head_pixel_dev_0_255\ttime_s\tcost\terror");
  for (const row of rows) {
    console.log(`${row.clip}\t${row.preset}\t${row.duration}s\t${round(row.minSsimVsFirst)}\t${round(row.firstLastSsim)}\t${round(row.maxFrameDiff)}\t${row.maxHeadPixelDeviation ?? "n/a"}\t${row.generationSeconds?.toFixed(1) ?? "n/a"}\t$${(row.actualCost ?? row.estimatedCost).toFixed(3)}\t${row.error}`);
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.dryRun) return printDryRun();
  if (options.reportOnly) {
    const runPath = path.join(outputDir, "run.json");
    if (!(await exists(runPath))) throw new Error("No bench5 run.json found");
    const rows = JSON.parse(await readFile(runPath, "utf8")) as RunRow[];
    await createContactSheet(rows);
    printTable(rows);
    return;
  }
  if (!options.yes) throw new Error("Real run spends fal credits; rerun with --yes after confirmation (or use --dry-run).");
  if (totalCost > budgetLimit) throw new Error(`Estimated $${totalCost.toFixed(2)} exceeds limit $${budgetLimit.toFixed(2)}`);
  loadEnv({ path: path.join(root, ".env") });
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) throw new Error("FAL_KEY is missing; it will not be printed.");
  fal.config({ credentials: apiKey });
  await mkdir(path.join(outputDir, "raw"), { recursive: true });
  for (const clip of clips) {
    const target = path.join(outputDir, outputName(clip));
    if (await exists(target)) throw new Error(`Refusing to overwrite existing output: ${target}`);
    if (!(await exists(photoPath(clip)))) throw new Error(`Missing input photo: ${photoPath(clip)}`);
  }

  const rows: RunRow[] = [];
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bench5-crops-"));
  try {
    for (const clip of clips) {
      const filename = outputName(clip);
      const target = path.join(outputDir, filename);
      const row: RunRow = {
        clip: clip.id, photo: clip.photo, preset: clip.preset, duration: clip.duration, output: filename, endpoint,
        requestId: "", generationSeconds: null, estimatedCost: clipCost(clip), actualCost: null, width: null, height: null,
        minSsimVsFirst: null, firstLastSsim: null, maxFrameDiff: null, maxHeadPixelDeviation: null, error: "",
      };
      try {
        const cropPath = path.join(tempDir, `${clip.id}.jpg`);
        await cropToPortrait(photoPath(clip), cropPath);
        const image = new File([await readFile(cropPath)], path.basename(cropPath), { type: "image/jpeg" });
        const imageUrl = await fal.storage.upload(image);
        const result = await waitForResult(buildInput(imageUrl, clip), apiKey);
        row.requestId = result.requestId;
        row.generationSeconds = result.seconds;
        row.raw = result.result;
        row.actualCost = actualCostFromResponse(result.result);
        await writeFile(path.join(outputDir, "raw", `${clip.id}__${result.requestId}.json`), JSON.stringify({ requestId: result.requestId, response: result.result, prompt: presets[clip.preset] }, null, 2), "utf8");
        const response = await fetch(extractVideoUrl(result.result));
        if (!response.ok) throw new Error(`Video download HTTP ${response.status}`);
        await writeFile(target, Buffer.from(await response.arrayBuffer()));
        const [dimensions, minSsim, endpointSsim, minConsecutive, headDeviation] = await Promise.all([
          getDimensions(target),
          calculateMinimumSsimToFirstFrame(target, 30),
          calculateSsimBetweenFrames(target, 0, "last"),
          calculateMinimumConsecutiveSsim(target, 30),
          maxHeadPixelDeviation(target),
        ]);
        row.width = dimensions.width;
        row.height = dimensions.height;
        row.minSsimVsFirst = minSsim;
        row.firstLastSsim = endpointSsim;
        row.maxFrameDiff = minConsecutive === null ? null : 1 - minConsecutive;
        row.maxHeadPixelDeviation = headDeviation;
      } catch (error) {
        row.error = safeError(error, apiKey);
      }
      rows.push(row);
      await writeFile(path.join(outputDir, "run.json"), JSON.stringify(rows, null, 2), "utf8");
      console.log(`${row.clip}: ${row.error || `done ${row.generationSeconds?.toFixed(1)}s`}`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
  await createContactSheet(rows.filter((row) => !row.error));
  printTable(rows);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
