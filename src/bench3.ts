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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, "out", "bench3");
const bench2Dir = path.join(root, "out", "bench2");
const ffmpegPath = createRequire(import.meta.url)("ffmpeg-static") as string | null ?? "ffmpeg";
const endpoint = "fal-ai/kling-video/o3/standard/image-to-video";
const clipCost = 0.336;
const headRois = {
  gentle: { x: 0.27, y: 0.36, width: 0.46, height: 0.30 },
  glance: { x: 0.08, y: 0.34, width: 0.84, height: 0.48 },
  cozy: { x: 0.34, y: 0.40, width: 0.58, height: 0.38 },
} as const;

const cases = [
  {
    id: "gentle_k_a",
    photo: "s_gentle.jpg.jpg",
    photoPath: path.join(root, "photos-samples", "s_gentle.jpg.jpg"),
    headRoi: headRois.gentle,
    endFrame: true,
    prompt: "The pet turns its head slightly to the left, then back to the center, then slightly to the right. Its ears move, it blinks twice and its mouth relaxes. Then it returns exactly to the original pose. Locked camera, natural movement, clearly visible but gentle.",
  },
  {
    id: "gentle_k_b",
    photo: "s_gentle.jpg.jpg",
    photoPath: path.join(root, "photos-samples", "s_gentle.jpg.jpg"),
    headRoi: headRois.gentle,
    endFrame: true,
    prompt: "The pet tilts its head clearly to one side with curiosity, ears perk up and turn, it blinks slowly twice, then tilts its head to the other side and settles back into exactly the original pose. Locked camera, natural lifelike movement, clearly visible motion.",
  },
  {
    id: "glance_k_a",
    photo: "s_glance.jpg.jpg",
    photoPath: path.join(root, "photos-samples", "s_glance.jpg.jpg"),
    headRoi: headRois.glance,
    endFrame: true,
    prompt: "The pet looks at the camera, then its gaze moves to the side and up, its head follows with a visible turn of about 15 degrees, then it looks back at the camera and blinks slowly. It ends in exactly the original pose. Locked camera, natural movement.",
  },
  {
    id: "glance_k_b",
    photo: "s_glance.jpg.jpg",
    photoPath: path.join(root, "photos-samples", "s_glance.jpg.jpg"),
    headRoi: headRois.glance,
    endFrame: true,
    prompt: "The pet turns its head clearly to look to the left, holds the look for a moment, then looks to the right, then back to the camera and blinks. Ears follow the movement. Ends in exactly the original pose. Locked camera, lifelike movement.",
  },
  {
    id: "cozy_k_a",
    photo: "s_cozy.jpg.jpg",
    photoPath: path.join(root, "photos-samples", "s_cozy.jpg.jpg"),
    headRoi: headRois.cozy,
    endFrame: true,
    prompt: "The pet breathes slowly and visibly, its chest and body rising and falling, its head shifts slightly as it settles deeper, it blinks slowly twice and an ear twitches, then returns to the original pose. Locked camera, relaxed natural movement.",
  },
  {
    id: "cozy_k_b",
    photo: "s_cozy.jpg.jpg",
    photoPath: path.join(root, "photos-samples", "s_cozy.jpg.jpg"),
    headRoi: headRois.cozy,
    endFrame: true,
    prompt: "The pet stretches its head slightly forward and nuzzles into the blanket, body rising and falling with deep breaths, eyes slowly close and half open again, ears twitch, then it settles back into exactly the original pose. Locked camera, clearly visible relaxed movement.",
  },
  {
    id: "gentle_k_b_free",
    photo: "s_gentle.jpg.jpg",
    photoPath: path.join(root, "photos-samples", "s_gentle.jpg.jpg"),
    headRoi: headRois.gentle,
    endFrame: false,
    prompt: "The pet tilts its head clearly to one side with curiosity, ears perk up and turn, it blinks slowly twice, then tilts its head to the other side and settles back into exactly the original pose. Locked camera, natural lifelike movement, clearly visible motion.",
  },
] as const;
type PromptCase = typeof cases[number];
type RunRow = {
  kind: "run" | "reference";
  promptVersion: string;
  photo: string;
  output: string;
  endpoint: string;
  requestId: string;
  endFrame: boolean;
  headRoi: { x: number; y: number; width: number; height: number };
  generationSeconds: number | null;
  estimatedCost: number;
  actualCost: number | null;
  width: number | null;
  height: number | null;
  minSsimVsFirst: number | null;
  firstLastSsim: number | null;
  maxFrameDiff: number | null;
  maxHeadPixelDeviation: number | null;
  error: string;
  raw?: unknown;
};

function parseOptions(args: string[]): { dryRun: boolean; reportOnly: boolean; noEndFrame: Set<string> } {
  const options = { dryRun: false, reportOnly: false, noEndFrame: new Set<string>() };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--dry-run") options.dryRun = true;
    else if (args[index] === "--report-only") options.reportOnly = true;
    else if (args[index] === "--no-end-frame") {
      const caseId = args[++index];
      if (!caseId) throw new Error("--no-end-frame requires a prompt case id");
      if (!cases.some((item) => item.id === caseId)) throw new Error(`Unknown prompt case: ${caseId}`);
      options.noEndFrame.add(caseId);
    } else if (args[index] === "--help" || args[index] === "-h") {
      console.log("Usage: npm run bench3 -- [--dry-run] [--no-end-frame CASE_ID]");
      process.exit(0);
    } else throw new Error(`Unknown option: ${args[index]}`);
  }
  return options;
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

function round(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(4);
}

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

async function runFfmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stderr) : reject(new Error(stderr.slice(-1800))));
  });
}

async function getDimensions(videoPath: string): Promise<{ width: number; height: number }> {
  const output = await runFfmpeg(["-i", videoPath, "-f", "null", "-"]);
  const match = output.match(/Video: [^\n,]+[^\n]*?,\s*(\d{2,5})x(\d{2,5})/);
  if (!match) throw new Error(`Cannot read video dimensions: ${videoPath}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

async function maxHeadPixelDeviation(videoPath: string, roi: PromptCase["headRoi"]): Promise<number | null> {
  const { width, height } = await getDimensions(videoPath);
  const left = Math.floor(width * roi.x);
  const top = Math.floor(height * roi.y);
  const cropWidth = Math.max(2, Math.floor(width * roi.width / 2) * 2);
  const cropHeight = Math.max(2, Math.floor(height * roi.height / 2) * 2);
  const frameBytes = cropWidth * cropHeight * 3;
  const args = [
    "-i", videoPath,
    "-vf", `fps=30,crop=${cropWidth}:${cropHeight}:${left}:${top},format=rgb24`,
    "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ];
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
        if (!first) {
          first = Buffer.from(frame);
          continue;
        }
        for (let index = 0; index < frameBytes; index++) {
          const difference = Math.abs(frame[index]! - first[index]!);
          if (difference > maxDifference) maxDifference = difference;
        }
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr.slice(-1800)));
      else if (!first) resolve(null);
      else resolve(maxDifference);
    });
  });
}

function buildInput(imageUrl: string, item: PromptCase, omitEndFrame: boolean): Record<string, unknown> {
  return {
    image_url: imageUrl,
    ...(!omitEndFrame && item.endFrame ? { end_image_url: imageUrl } : {}),
    prompt: item.prompt,
    duration: "4",
    generate_audio: false,
  };
}

function printDryRun(noEndFrame: Set<string>): void {
  console.log("prompt_version\tphoto\tendpoint\tduration\taudio\tend_image_url\testimated_cost");
  for (const item of cases) {
    const omitEndFrame = item.endFrame && noEndFrame.has(item.id);
    const hasEndFrame = item.endFrame && !omitEndFrame;
    console.log(`${item.id}\t${item.photo}\t${endpoint}\t4s\toff\t${hasEndFrame ? "same image URL" : "omitted"}\t$${clipCost.toFixed(3)}`);
  }
  console.log(`Total: ${cases.length} clips x $${clipCost.toFixed(3)} = $${(cases.length * clipCost).toFixed(3)}.`);
  console.log("Head pixel ROI (normalized x,y,w,h): gentle=(0.27,0.36,0.46,0.30); glance=(0.08,0.34,0.84,0.48); cozy=(0.34,0.40,0.58,0.38). Metric is max absolute RGB channel difference (0..255) from frame 1 across 30-fps frames.");
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

async function createEightFrameContactSheet(rows: RunRow[]): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bench3-sheet-"));
  const tileWidth = 160;
  const tileHeight = 284;
  const labelWidth = 300;
  const composites: OverlayOptions[] = [];
  try {
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex]!;
      const file = path.join(row.kind === "reference" ? bench2Dir : outputDir, row.output);
      if (!(await exists(file))) continue;
      const info = await runFfmpeg(["-i", file, "-vf", "fps=30,showinfo", "-f", "null", "-"]);
      const matches = [...info.matchAll(/\bn:\s*(\d+)/g)];
      const frameCount = Number(matches.at(-1)?.[1] ?? 0) + 1;
      const y = rowIndex * tileHeight;
      const label = Buffer.from(`<svg width="${labelWidth}" height="${tileHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#f2f3ef"/><text x="12" y="30" font-family="Arial" font-size="16" fill="#202522">${row.kind === "reference" ? "REF " : ""}${row.promptVersion}</text><text x="12" y="56" font-family="Arial" font-size="13" fill="#202522">${row.photo}</text><text x="12" y="82" font-family="Arial" font-size="13" fill="#202522">${row.width}x${row.height} end=${row.endFrame}</text></svg>`);
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

async function addReferences(rows: RunRow[]): Promise<void> {
  const reportPath = path.join(bench2Dir, "run.json");
  if (!(await exists(reportPath))) return;
  const referenceRows = JSON.parse(await readFile(reportPath, "utf8")) as Array<Record<string, unknown>>;
  for (const preset of ["gentle_v4", "glance_v4", "cozy_v3"]) {
    const source = referenceRows.find((item) => item.model === "kling-o3-standard" && item.preset === preset && item.output);
    if (!source) continue;
    const output = String(source.output);
    const file = path.join(bench2Dir, path.basename(output));
    if (!(await exists(file))) continue;
    const roiKey = preset === "gentle_v4" ? "gentle" : preset === "glance_v4" ? "glance" : "cozy";
    const roi = headRois[roiKey];
    const [dimensions, minSsim, endpointSsim, minConsecutive, headDeviation] = await Promise.all([
      getDimensions(file),
      calculateMinimumSsimToFirstFrame(file, 30),
      calculateSsimBetweenFrames(file, 0, "last"),
      calculateMinimumConsecutiveSsim(file, 30),
      maxHeadPixelDeviation(file, roi),
    ]);
    rows.push({
      kind: "reference",
      promptVersion: preset,
      photo: path.basename(String(source.photo ?? preset)),
      output: path.basename(file),
      endpoint,
      requestId: String(source.requestId ?? ""),
      endFrame: true,
      headRoi: roi,
      generationSeconds: typeof source.generationSeconds === "number" ? source.generationSeconds : null,
      estimatedCost: clipCost,
      actualCost: null,
      width: dimensions.width,
      height: dimensions.height,
      minSsimVsFirst: minSsim,
      firstLastSsim: endpointSsim,
      maxFrameDiff: minConsecutive === null ? null : 1 - minConsecutive,
      maxHeadPixelDeviation: headDeviation,
      error: "",
    });
  }
}

function printTable(rows: RunRow[]): void {
  console.log("kind\tprompt\tminSSIM_vs_first\tfirst_last_SSIM\tmax_frame_diff\tmax_head_pixel_dev_0_255\ttime_s\tend_frame");
  for (const row of rows) {
    console.log(`${row.kind}\t${row.promptVersion}\t${round(row.minSsimVsFirst)}\t${round(row.firstLastSsim)}\t${round(row.maxFrameDiff)}\t${row.maxHeadPixelDeviation ?? "n/a"}\t${row.generationSeconds?.toFixed(1) ?? "n/a"}\t${row.endFrame}`);
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.dryRun) {
    printDryRun(options.noEndFrame);
    return;
  }
  if (options.reportOnly) {
    const runPath = path.join(outputDir, "run.json");
    if (!(await exists(runPath))) throw new Error("No bench3 run.json found");
    const rows = JSON.parse(await readFile(runPath, "utf8")) as RunRow[];
    await addReferences(rows);
    await writeFile(runPath, JSON.stringify(rows, null, 2), "utf8");
    await createEightFrameContactSheet(rows);
    printTable(rows);
    return;
  }
  loadEnv({ path: path.join(root, ".env") });
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) throw new Error("FAL_KEY is missing; it will not be printed.");
  await mkdir(path.join(outputDir, "raw"), { recursive: true });
  for (const item of cases) {
    const target = path.join(outputDir, `kling-o3-standard_${item.id}_loop.mp4`);
    if (await exists(target)) throw new Error(`Refusing to overwrite existing output: ${target}`);
    if (!(await exists(item.photoPath))) throw new Error(`Missing input photo: ${item.photoPath}`);
  }

  const rows: RunRow[] = [];
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bench3-crops-"));
  try {
    const uploaded = new Map<string, string>();
    for (const item of cases) {
      if (uploaded.has(item.photo)) continue;
      const cropPath = path.join(tempDir, item.photo.replace(/\.jpg\.jpg$/, ".jpg"));
      await cropToPortrait(item.photoPath, cropPath);
      const image = new File([await readFile(cropPath)], path.basename(cropPath), { type: "image/jpeg" });
      uploaded.set(item.photo, await fal.storage.upload(image));
    }
    for (const item of cases) {
      const filename = `kling-o3-standard_${item.id}_loop.mp4`;
      const target = path.join(outputDir, filename);
      const roi = headRois[item.id.startsWith("gentle") ? "gentle" : item.id.startsWith("glance") ? "glance" : "cozy"];
      const row: RunRow = {
        kind: "run", promptVersion: item.id, photo: item.photo, output: filename, endpoint,
        requestId: "", endFrame: item.endFrame && !options.noEndFrame.has(item.id), headRoi: roi,
        generationSeconds: null, estimatedCost: clipCost, actualCost: null, width: null, height: null,
        minSsimVsFirst: null, firstLastSsim: null, maxFrameDiff: null, maxHeadPixelDeviation: null, error: "",
      };
      try {
        const imageUrl = uploaded.get(item.photo)!;
        const result = await waitForResult(buildInput(imageUrl, item, options.noEndFrame.has(item.id)), apiKey);
        row.requestId = result.requestId;
        row.generationSeconds = result.seconds;
        row.raw = result.result;
        row.actualCost = actualCostFromResponse(result.result);
        await writeFile(path.join(outputDir, "raw", `${item.id}__${result.requestId}.json`), JSON.stringify({ requestId: result.requestId, response: result.result, prompt: item.prompt }, null, 2), "utf8");
        const response = await fetch(extractVideoUrl(result.result));
        if (!response.ok) throw new Error(`Video download HTTP ${response.status}`);
        await writeFile(target, Buffer.from(await response.arrayBuffer()));
        const [dimensions, minSsim, endpointSsim, minConsecutive, headDeviation] = await Promise.all([
          getDimensions(target),
          calculateMinimumSsimToFirstFrame(target, 30),
          calculateSsimBetweenFrames(target, 0, "last"),
          calculateMinimumConsecutiveSsim(target, 30),
          maxHeadPixelDeviation(target, roi),
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
      console.log(`${row.promptVersion}: ${row.error || `done ${row.generationSeconds?.toFixed(1)}s`}`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
  await addReferences(rows);
  await createEightFrameContactSheet(rows);
  printTable(rows);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});