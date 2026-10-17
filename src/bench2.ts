import { config as loadEnv } from "dotenv";
import { mkdir, readFile, writeFile, access, mkdtemp, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import sharp, { type OverlayOptions } from "sharp";
import { fal } from "@fal-ai/client";
import { presets } from "../presets.js";
import { calculateMinimumConsecutiveSsim, calculateMinimumSsimToFirstFrame, calculateSsimBetweenFrames, cropToPortrait } from "./media.js";
import { extractVideoUrl } from "./fal-result.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, "out", "bench2");
const ffmpegPath = createRequire(import.meta.url)("ffmpeg-static") as string | null ?? "ffmpeg";
const promptByPreset = {
  gentle_v4: presets.gentle_v4,
  glance_v4: presets.glance_v4,
  cozy_v3: presets.cozy_v3,
};
const cases = [
  { preset: "gentle_v4", photo: "s_gentle.jpg.jpg", file: path.join(root, "photos-samples", "s_gentle.jpg.jpg") },
  { preset: "glance_v4", photo: "s_glance.jpg.jpg", file: path.join(root, "photos-samples", "s_glance.jpg.jpg") },
  { preset: "cozy_v3", photo: "s_cozy.jpg.jpg", file: path.join(root, "photos-samples", "s_cozy.jpg.jpg") },
] as const;
type ModelId = "kling-o3-standard" | "pixverse-v6-transition" | "minimax-h3-max-turbo" | "seedance-2-mini";
type Model = { id: ModelId; endpoint: string; price: number; input: (imageUrl: string, preset: keyof typeof promptByPreset) => Record<string, unknown> };
const models: Model[] = [
  {
    id: "minimax-h3-max-turbo",
    endpoint: "minimax/h3-max-turbo/image-to-video",
    price: 0.065,
    input: (imageUrl, preset) => ({ prompt: promptByPreset[preset], prompt_expansion_mode: "disabled", duration: 4, resolution: "480P", image_url: imageUrl, end_image_url: imageUrl }),
  },
  {
    id: "kling-o3-standard",
    endpoint: "fal-ai/kling-video/o3/standard/image-to-video",
    price: 0.336,
    input: (imageUrl, preset) => ({ image_url: imageUrl, end_image_url: imageUrl, prompt: promptByPreset[preset], duration: "4", generate_audio: false }),
  },
  {
    id: "pixverse-v6-transition",
    endpoint: "fal-ai/pixverse/v6/transition",
    price: 0.18,
    input: (imageUrl, preset) => ({ first_image_url: imageUrl, end_image_url: imageUrl, prompt: promptByPreset[preset], duration: 4, resolution: "720p", aspect_ratio: "9:16", generate_audio_switch: false, thinking_type: "disabled" }),
  },
  {
    id: "seedance-2-mini",
    endpoint: "bytedance/seedance-2.0/mini/image-to-video",
    price: 0.6188,
    input: (imageUrl, preset) => ({ image_url: imageUrl, end_image_url: imageUrl, prompt: promptByPreset[preset], duration: "4", resolution: "720p", aspect_ratio: "9:16", generate_audio: false }),
  },
];
type RunRow = {
  model: string;
  preset: string;
  output: string;
  endpoint: string;
  requestId: string;
  generationSeconds: number | null;
  estimatedCost: number;
  actualCost: number | null;
  width: number | null;
  height: number | null;
  minSsimVsFirst: number | null;
  firstLastSsim: number | null;
  maxFrameDiff: number | null;
  error: string;
  raw: unknown;
};

function safeError(value: unknown, apiKey: string): string {
  const message = value instanceof Error ? value.message : String(value);
  return (apiKey ? message.split(apiKey).join("[redacted]") : message).replace(/\s+/g, " ").slice(0, 1600);
}

function costFromResponse(value: unknown): number | null {
  if (value === null || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value)) {
    if (/^(actual_)?(billed_)?cost(_usd)?$|^amount_charged$|^charged_usd$/i.test(key) && typeof nested === "number") return nested;
    if (nested !== null && typeof nested === "object") {
      const found = costFromResponse(nested);
      if (found !== null) return found;
    }
  }
  return null;
}

async function fileExists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
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
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let output = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(output.slice(-1600))));
  });
}

type QueueReceipt = { request_id?: string; status?: string; status_url?: string; response_url?: string };

async function findSavedQueue(model: Model, preset: keyof typeof promptByPreset): Promise<{ requestId: string; queue: QueueReceipt } | undefined> {
  const rawDir = path.join(outputDir, "raw");
  for (const name of await readdir(rawDir)) {
    if (!name.startsWith(`${model.id}__`) || !name.endsWith("__submitted.json")) continue;
    const saved = JSON.parse(await readFile(path.join(rawDir, name), "utf8")) as { requestId?: string; queue?: QueueReceipt; input?: Record<string, unknown> };
    if (saved.input?.prompt === promptByPreset[preset] && saved.requestId && saved.queue?.status_url && saved.queue.response_url) {
      return { requestId: saved.requestId, queue: saved.queue };
    }
  }
  return undefined;
}

async function submitOnce(
  model: Model,
  input: Record<string, unknown>,
  apiKey: string,
  savedQueue: { requestId: string; queue: QueueReceipt } | undefined,
  onSubmitted: (requestId: string) => Promise<void>,
): Promise<{ requestId: string; generationSeconds: number; resumed: boolean; result: unknown }> {
  const started = Date.now();
  let requestId: string;
  let queueInfo: QueueReceipt;
  if (savedQueue) {
    requestId = savedQueue.requestId;
    queueInfo = savedQueue.queue;
    await onSubmitted(requestId);
    console.log(`  Resuming existing request ${requestId}; no new submit.`);
  } else {
    const submit = await apiRequest(`https://queue.fal.run/${model.endpoint}`, apiKey, { method: "POST", body: JSON.stringify(input) });
    if (!submit.response.ok) {
      throw new Error(`Submit rejected HTTP ${submit.response.status}: ${JSON.stringify(submit.body).slice(0, 1200)}`);
    }
    queueInfo = submit.body as QueueReceipt;
    requestId = queueInfo.request_id ?? "";
    if (!requestId) throw new Error(`Queue accepted response without request_id; keys: ${Object.keys(queueInfo).join(",")}`);
    await onSubmitted(requestId);
    await writeFile(path.join(outputDir, "raw", `${model.id}__${requestId}__submitted.json`), JSON.stringify({ requestId, queue: queueInfo, input }, null, 2), "utf8");
  }

  let lastStatus = "";
  while (true) {
    const statusUrl = new URL(queueInfo.status_url!);
    statusUrl.searchParams.set("logs", "0");
    const statusResult = await apiRequest(statusUrl.toString(), apiKey);
    if (!statusResult.response.ok) throw new Error(`Status request failed HTTP ${statusResult.response.status}: ${JSON.stringify(statusResult.body).slice(0, 1000)}; requestId=${requestId}`);
    const status = statusResult.body as { status?: string; error?: unknown; logs?: unknown };
    if (status.status !== lastStatus) {
      console.log(`  ${model.id} ${requestId}: ${status.status ?? "unknown"}`);
      lastStatus = status.status ?? "unknown";
    }
    if (status.status === "COMPLETED") break;
    if (status.status === "FAILED") throw new Error(`Queue failed: ${JSON.stringify(status).slice(0, 1400)}; requestId=${requestId}`);
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  const result = await apiRequest(queueInfo.response_url!, apiKey);
  if (!result.response.ok) throw new Error(`Result request failed HTTP ${result.response.status}: ${JSON.stringify(result.body).slice(0, 1200)}; requestId=${requestId}`);
  return { requestId, generationSeconds: (Date.now() - started) / 1000, resumed: Boolean(savedQueue), result: result.body };
}

async function inspectVideo(file: string): Promise<{ width: number; height: number }> {
  const output = await runFfmpeg(["-i", file, "-f", "null", "-"]);
  const match = output.match(/Video: [^\n,]+[^\n]*?,\s*(\d{2,5})x(\d{2,5})/);
  if (!match) throw new Error(`Unable to read video dimensions: ${file}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

async function stripAudio(input: string, output: string): Promise<void> {
  await runFfmpeg(["-y", "-i", input, "-map", "0:v:0", "-c:v", "copy", "-an", "-movflags", "+faststart", output]);
}

async function main(): Promise<void> {
  if (process.argv.includes("--contact-sheet-only")) {
    const runPath = path.join(outputDir, "run.json");
    if (!(await fileExists(runPath))) throw new Error("No bench2 run.json found");
    const rows = JSON.parse(await readFile(runPath, "utf8")) as RunRow[];
    await createContactSheet(rows, outputDir);
    printRows(rows, rows.filter((row) => row.error === "" && row.width !== null).length);
    return;
  }
  loadEnv({ path: path.join(root, ".env") });
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) throw new Error("FAL_KEY is missing; it will not be printed.");
  const selectedModels = [models[0]!, models[1]!, models[2]!, models[3]!];
  const planned = [
    ...selectedModels.flatMap((model) => cases.map((item) => ({ model, item }))).filter(({ model, item }) => model.id !== "seedance-2-mini" || item.preset === "gentle_v4"),
  ];
  await mkdir(path.join(outputDir, "raw"), { recursive: true });
  for (const { model, item } of planned) {
    const filename = `${model.id}_${item.preset}_loop.mp4`;
    const target = path.join(outputDir, filename);
    if (await fileExists(target)) throw new Error(`Refusing to overwrite existing output: ${target}`);
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bench2-crops-"));
  const runPath = path.join(outputDir, "run.json");
  const rows: RunRow[] = await fileExists(runPath) ? JSON.parse(await readFile(runPath, "utf8")) as RunRow[] : [];
  try {
    for (const { model, item } of planned) {
      const target = path.join(outputDir, `${model.id}_${item.preset}_loop.mp4`);
      const previous = rows.find((row) => row.model === model.id && row.preset === item.preset);
      if (await fileExists(target) && !(previous?.error === "" && previous.width !== null)) {
        throw new Error(`Refusing to overwrite unverified output: ${target}`);
      }
    }
    const uploaded = new Map<string, string>();
    for (const item of cases) {
      const cropPath = path.join(tempDir, item.photo.replace(/\.jpg\.jpg$/, ".jpg"));
      await cropToPortrait(item.file, cropPath);
      const image = new File([await readFile(cropPath)], path.basename(cropPath), { type: "image/jpeg" });
      uploaded.set(item.preset, await fal.storage.upload(image));
    }

    for (const { model, item } of planned) {
      const filename = `${model.id}_${item.preset}_loop.mp4`;
      const target = path.join(outputDir, filename);
      const previousRow = rows.find((saved) => saved.model === model.id && saved.preset === item.preset);
      if (previousRow?.width !== null && previousRow?.error === "" && await fileExists(target)) continue;
      const estimatedCost = model.price;
      const row: RunRow = previousRow ?? { model: model.id, preset: item.preset, output: filename, endpoint: model.endpoint, requestId: "", generationSeconds: null, estimatedCost, actualCost: null, width: null, height: null, minSsimVsFirst: null, firstLastSsim: null, maxFrameDiff: null, error: "", raw: null };
      row.error = "";
      try {
        const imageUrl = uploaded.get(item.preset)!;
        const savedQueue = await findSavedQueue(model, item.preset);
        const submission = await submitOnce(model, model.input(imageUrl, item.preset), apiKey, savedQueue, async (requestId) => {
          row.requestId = requestId;
          const existingIndex = rows.findIndex((saved) => saved.model === model.id && saved.preset === item.preset);
          if (existingIndex >= 0) rows[existingIndex] = row;
          else rows.push(row);
          await writeFile(runPath, JSON.stringify(rows, null, 2), "utf8");
        });
        row.requestId = submission.requestId;
        row.generationSeconds = submission.resumed ? null : submission.generationSeconds;
        row.raw = submission.result;
        row.actualCost = costFromResponse(submission.result);
        await writeFile(path.join(outputDir, "raw", `${model.id}__${item.preset}__${submission.requestId}.json`), JSON.stringify({ requestId: submission.requestId, response: submission.result }, null, 2), "utf8");
        const videoUrl = extractVideoUrl(submission.result);
        const response = await fetch(videoUrl);
        if (!response.ok) throw new Error(`Video download failed HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        const downloaded = `${target}.download.mp4`;
        await writeFile(downloaded, buffer);
        if (model.id === "minimax-h3-max-turbo") await stripAudio(downloaded, target);
        else await writeFile(target, buffer);
        await rm(downloaded, { force: true });
        const dims = await inspectVideo(target);
        row.width = dims.width;
        row.height = dims.height;
        const [minimum, endpoint, minConsecutive] = await Promise.all([
          calculateMinimumSsimToFirstFrame(target, 30),
          calculateSsimBetweenFrames(target, 0, "last"),
          calculateMinimumConsecutiveSsim(target, 30),
        ]);
        row.minSsimVsFirst = minimum;
        row.firstLastSsim = endpoint;
        row.maxFrameDiff = minConsecutive === null ? null : 1 - minConsecutive;
      } catch (error) {
        row.error = safeError(error, apiKey);
        if (model.id === "minimax-h3-max-turbo" && /HTTP 4\d\d|aspect|ratio|image|invalid.*input|validation/i.test(row.error)) {
          if (!rows.includes(row)) rows.push(row);
          await writeFile(runPath, JSON.stringify(rows, null, 2), "utf8");
          throw new Error(`MiniMax H3 Max Turbo rejected the 9:16 input; stopped before remaining jobs. ${row.error}`);
        }
      }
      const existingIndex = rows.findIndex((saved) => saved.model === model.id && saved.preset === item.preset);
      if (existingIndex >= 0) rows[existingIndex] = row;
      else rows.push(row);
      await writeFile(runPath, JSON.stringify(rows, null, 2), "utf8");
      const actual = row.actualCost === null ? `estimate $${row.estimatedCost.toFixed(4)} (API billed cost unavailable)` : `billed $${row.actualCost.toFixed(4)}`;
      console.log(`${row.model} / ${row.preset}: ${row.error ? `ERROR ${row.error}` : `OK ${actual}, ${row.generationSeconds!.toFixed(1)}s, ${row.width}x${row.height}`}`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  const successful = rows.filter((row) => row.error === "" && row.width !== null);
  await createContactSheet(rows, outputDir);
  printRows(rows, successful.length);
}

function printRows(rows: RunRow[], successfulCount: number): void {
  console.log("model\tpreset\tminSSIM_vs_first\tfirst_vs_last\tmax_frame_diff\tactual/estimated_cost\tgeneration_s\taspect\terror");
  for (const row of rows) {
    const cost = row.actualCost === null ? `~$${row.estimatedCost.toFixed(4)}` : `$${row.actualCost.toFixed(4)}`;
    const aspect = row.width && row.height ? `${row.width}:${row.height} (${(row.width / row.height).toFixed(4)})` : "n/a";
    console.log(`${row.model}\t${row.preset}\t${row.minSsimVsFirst?.toFixed(4) ?? "n/a"}\t${row.firstLastSsim?.toFixed(4) ?? "n/a"}\t${row.maxFrameDiff?.toFixed(4) ?? "n/a"}\t${cost}\t${row.generationSeconds?.toFixed(1) ?? "n/a"}\t${aspect}\t${row.error || ""}`);
  }
  console.log(`Successful outputs: ${successfulCount}/${rows.length}; contact sheet: ${path.join(outputDir, "contact-sheet.jpg")}`);
}

async function createContactSheet(rows: RunRow[], outDir: string): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bench2-sheet-"));
  const tileWidth = 180;
  const tileHeight = 320;
  const labelWidth = 320;
  const composites: OverlayOptions[] = [];
  try {
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex]!;
      const source = path.join(outDir, row.output);
      let tiles: Buffer[] = [];
      if (await fileExists(source)) {
        const frameCountText = await runFfmpeg(["-i", source, "-vf", "fps=30,showinfo", "-f", "null", "-"]);
        const frameMatches = [...frameCountText.matchAll(/\bn:\s*(\d+)/g)];
        const frameCount = Number(frameMatches.at(-1)?.[1] ?? 0) + 1;
        for (let index = 0; index < 6; index++) {
          const frame = Math.round(index * (frameCount - 1) / 5);
          const png = path.join(tempDir, `${rowIndex}-${index}.png`);
          await runFfmpeg(["-y", "-i", source, "-vf", `fps=30,select=eq(n\\,${frame})`, "-frames:v", "1", png]);
          tiles.push(await sharp(png).resize(tileWidth, tileHeight, { fit: "contain", background: "#111" }).jpeg({ quality: 86 }).toBuffer());
        }
      } else {
        tiles = await Promise.all(Array.from({ length: 6 }, () => sharp({ create: { width: tileWidth, height: tileHeight, channels: 3, background: "#666" } }).jpeg().toBuffer()));
      }
      const label = Buffer.from(`<svg width="${labelWidth}" height="${tileHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#f2f3ef"/><text x="16" y="34" font-family="Arial" font-size="18" fill="#202522">${row.model}</text><text x="16" y="62" font-family="Arial" font-size="16" fill="#202522">${row.preset}</text><text x="16" y="96" font-family="Arial" font-size="14" fill="#8b2727">${row.error ? "FAILED" : `${row.width}x${row.height}`}</text></svg>`);
      const y = rowIndex * tileHeight;
      composites.push({ input: label, left: 0, top: y });
      tiles.forEach((tile, tileIndex) => composites.push({ input: tile, left: labelWidth + tileIndex * tileWidth, top: y }));
    }
    await sharp({ create: { width: labelWidth + tileWidth * 6, height: tileHeight * rows.length, channels: 3, background: "#111" } })
      .composite(composites)
      .jpeg({ quality: 88 })
      .toFile(path.join(outDir, "contact-sheet.jpg"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});