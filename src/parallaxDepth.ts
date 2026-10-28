import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config as loadEnv } from "dotenv";
import { fal } from "@fal-ai/client";
import {
  DEFAULT_PHOTOS_DIR,
  EXPECTED_PHOTOS,
  JPEG_QUALITY,
  LONGEST_SIDE,
  MODELS,
  benchDir,
  ensureDirs,
  exists,
  inputDir,
  isBlockedError,
  listPhotos,
  mean,
  median,
  pool,
  rawDir,
  readJson,
  redact,
  resultsPath,
  writeJson,
  type ModelSpec,
  type PhotoEntry,
} from "./parallaxShared.js";

// Parallax depth A/B runner: resizes every source photo to one identical input, uploads it ONCE and
// feeds the same URL to both models, then records latency/request id/output size per call.
//
//   npm run parallax:depth                      # dry plan + resize only: no network, no spend
//   npm run parallax:depth -- --execute         # actually call fal and spend credits
//   npm run parallax:depth -- --execute --limit 2 --models marigold-v2
//
// FAL_KEY is loaded exactly like the other runners in this repo (dotenv from ../.env) and is never
// printed; every error string is scrubbed of it before it is logged or persisted.

const MAX_SUCCESS_PER_MODEL = 20; // hard cap from the brief
const MAX_RETRIES = 2; // per photo, per model -> at most 3 attempts
const DEFAULT_CONCURRENCY = 2; // the brief allows sequential or concurrency <= 2

type FalImage = { url?: string; width?: number | null; height?: number | null; content_type?: string | null };

export type ResultRow = {
  model: string;
  photo: string; // original filename from the source folder
  photoId: string;
  requestId: string | null;
  latencyMs: number | null;
  width: number | null;
  height: number | null;
  status: string;
  attempts: number;
  output: string | null;
  estUsd: number;
  error: string | null;
};

type Options = {
  execute: boolean;
  photosDir: string;
  limit: number | null;
  concurrency: number;
  models: ModelSpec[];
};

function parseArgs(argv: string[]): Options {
  let execute = false;
  let photosDir = DEFAULT_PHOTOS_DIR;
  let limit: number | null = null;
  let concurrency = DEFAULT_CONCURRENCY;
  let modelIds: string[] | null = null;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === "--execute") execute = true;
    else if (flag === "--photos") photosDir = argv[++index]!;
    else if (flag === "--limit") limit = Number(argv[++index]);
    else if (flag === "--concurrency") concurrency = Math.min(DEFAULT_CONCURRENCY, Math.max(1, Number(argv[++index])));
    else if (flag === "--models") modelIds = String(argv[++index]).split(",").map((id) => id.trim()).filter(Boolean);
    else if (flag === "--help" || flag === "-h") {
      console.log("Usage: npm run parallax:depth -- [--execute] [--photos DIR] [--limit N] [--concurrency 1|2] [--models id,id]");
      process.exit(0);
    } else throw new Error(`Unknown option: ${flag}`);
  }
  const selected = modelIds === null ? MODELS : modelIds.map((id) => {
    const model = MODELS.find((candidate) => candidate.id === id);
    if (!model) throw new Error(`Unknown model ${id}. Expected one of: ${MODELS.map((m) => m.id).join(", ")}`);
    return model;
  });
  return { execute, photosDir, limit, concurrency, models: selected };
}

/** Longest side 1536 px, JPEG q90, never enlarged. EXIF rotation is applied so both models see the same pixels. */
async function prepareInputs(photos: PhotoEntry[]): Promise<void> {
  await ensureDirs(inputDir);
  for (const photo of photos) {
    const target = path.join(inputDir, `${photo.id}.jpg`);
    if (await exists(target)) continue;
    const bytes = await readFile(photo.absolutePath);
    await sharp(bytes, { failOn: "none" })
      .rotate()
      .resize({ width: LONGEST_SIDE, height: LONGEST_SIDE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toFile(target);
  }
}

const rawPath = (model: ModelSpec, photo: PhotoEntry): string => path.join(rawDir, model.id, `${photo.id}.png`);

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`output download failed HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const photos = await listPhotos(options.photosDir, options.limit ?? undefined);
  if (photos.length === 0) throw new Error(`No images found in ${options.photosDir}`);
  if (photos.length < EXPECTED_PHOTOS) {
    console.log(`!! only ${photos.length} photos found in ${options.photosDir} (expected ${EXPECTED_PHOTOS}) — continuing with what exists`);
  } else if (photos.length > EXPECTED_PHOTOS) {
    console.log(`!! ${photos.length} photos found; --limit N to narrow the run`);
  }

  // Local, free, and required either way: both models must get byte-identical inputs.
  await prepareInputs(photos);

  const plannedCalls = photos.length * options.models.length;
  const estimate = options.models.reduce((sum, model) => sum + model.estUsdPerCall * photos.length, 0);
  console.log("\n=== parallax depth A/B plan ===");
  console.log(`Photos: ${photos.length}   Models: ${options.models.map((m) => m.id).join(", ")}`);
  for (const model of options.models) {
    console.log(`  - ${model.id}  [${model.endpoint}]  ~$${model.estUsdPerCall.toFixed(3)}/call x ${photos.length}`);
  }
  console.log(`Planned calls: ${plannedCalls}   Estimated spend: $${estimate.toFixed(3)}`);
  console.log(`Caps: <= ${MAX_SUCCESS_PER_MODEL} successful calls/model, <= ${MAX_RETRIES} retries per photo per model, hard stop on 402/403/balance/locked.`);
  console.log("fal responses carry no price — read the real cost per model from the fal dashboard (Usage).");

  if (!options.execute) {
    console.log("\nDRY PLAN only — inputs resized, no network calls, $0 spent. Re-run with --execute.");
    return;
  }

  loadEnv({ path: path.join(benchDir, "..", "..", ".env") });
  const apiKey = process.env["FAL_KEY"] ?? "";
  if (!apiKey) throw new Error("FAL_KEY missing in tools/pet-benchmark/.env; it is never printed.");
  fal.config({ credentials: apiKey });

  await ensureDirs(rawDir, ...options.models.map((model) => path.join(rawDir, model.id)));

  // Carry over anything from a previous run so a re-run never re-bills a finished job.
  const priorRows = await readJson<ResultRow[]>(resultsPath, []);
  const rows = new Map<string, ResultRow>(priorRows.map((row) => [`${row.model}::${row.photoId}`, row]));
  const successes = new Map<string, number>(options.models.map((model) => [model.id, 0]));

  // One upload per photo, reused by BOTH models.
  const uploads = new Map<string, string>();
  const uploadErrors = new Map<string, string>();
  for (const photo of photos) {
    const file = path.join(inputDir, `${photo.id}.jpg`);
    try {
      uploads.set(photo.id, await fal.storage.upload(new File([await readFile(file)], `${photo.id}.jpg`, { type: "image/jpeg" })));
      console.log(`uploaded ${photo.id} (${photo.file})`);
    } catch (error) {
      const message = redact(error, apiKey);
      uploadErrors.set(photo.id, message);
      console.log(`[upload fail] ${photo.id}: ${message.slice(0, 120)}`);
      if (isBlockedError(error)) throw new Error(`upload blocked (billing/access) — halting: ${message.slice(0, 120)}`);
    }
  }

  let halted = false;
  let persistChain: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    persistChain = persistChain.then(() => writeJson(resultsPath, [...rows.values()]));
    return persistChain;
  };

  const jobs = options.models.flatMap((model) => photos.map((photo) => ({ model, photo })));

  await pool(jobs, options.concurrency, () => halted, async ({ model, photo }) => {
    const key = `${model.id}::${photo.id}`;
    const target = rawPath(model, photo);

    // Resume: an existing raw PNG means this call was already paid for.
    if (await exists(target)) {
      const meta = await sharp(target).metadata();
      rows.set(key, {
        model: model.id, photo: photo.file, photoId: photo.id,
        requestId: rows.get(key)?.requestId ?? null,
        latencyMs: rows.get(key)?.latencyMs ?? null,
        width: meta.width ?? null, height: meta.height ?? null,
        status: "ok-existing", attempts: rows.get(key)?.attempts ?? 0,
        output: path.relative(benchDir, target).replace(/\\/g, "/"),
        estUsd: 0, error: null,
      });
      successes.set(model.id, (successes.get(model.id) ?? 0) + 1);
      await persist();
      return;
    }

    if (halted) return;

    // Hard cap: at most MAX_SUCCESS_PER_MODEL successful calls per model.
    if ((successes.get(model.id) ?? 0) >= MAX_SUCCESS_PER_MODEL) {
      rows.set(key, { model: model.id, photo: photo.file, photoId: photo.id, requestId: null, latencyMs: null, width: null, height: null, status: "capped", attempts: 0, output: null, estUsd: 0, error: `per-model success cap (${MAX_SUCCESS_PER_MODEL}) reached` });
      await persist();
      return;
    }

    const imageUrl = uploads.get(photo.id);
    if (!imageUrl) {
      rows.set(key, { model: model.id, photo: photo.file, photoId: photo.id, requestId: null, latencyMs: null, width: null, height: null, status: "upload-failed", attempts: 0, output: null, estUsd: 0, error: uploadErrors.get(photo.id) ?? "upload unavailable" });
      await persist();
      return;
    }

    let attempts = 0;
    let lastError = "";
    while (attempts <= MAX_RETRIES && !halted) {
      attempts++;
      const started = Date.now();
      try {
        const result = await fal.subscribe(model.endpoint, { input: model.buildInput(imageUrl), logs: false });
        const data = result.data as { image?: FalImage; images?: FalImage[] };
        const image = data.image ?? data.images?.[0];
        if (!image?.url) throw new Error("response contained no image url");
        const bytes = await download(image.url);
        const meta = await sharp(bytes).metadata();
        await writeFile(target, bytes);
        await writeFile(target.replace(/\.png$/, ".json"), JSON.stringify({ requestId: result.requestId, image, photo: photo.file }, null, 2), "utf8");
        const latencyMs = Date.now() - started;
        rows.set(key, {
          model: model.id, photo: photo.file, photoId: photo.id,
          requestId: result.requestId ?? null, latencyMs,
          width: meta.width ?? image.width ?? null, height: meta.height ?? image.height ?? null,
          status: "ok", attempts,
          output: path.relative(benchDir, target).replace(/\\/g, "/"),
          estUsd: model.estUsdPerCall, error: null,
        });
        successes.set(model.id, (successes.get(model.id) ?? 0) + 1);
        console.log(`ok  ${model.id}  ${photo.id}  ${latencyMs}ms  ${meta.width ?? "?"}x${meta.height ?? "?"}  attempt ${attempts}`);
        await persist();
        return;
      } catch (error) {
        lastError = redact(error, apiKey);
        if (isBlockedError(error)) {
          halted = true;
          console.log(`[budget] HALT — billing/access response from fal (${lastError.slice(0, 140)}). No further calls.`);
          rows.set(key, { model: model.id, photo: photo.file, photoId: photo.id, requestId: null, latencyMs: null, width: null, height: null, status: "blocked", attempts, output: null, estUsd: 0, error: lastError });
          await persist();
          return;
        }
        console.log(`retry ${model.id} ${photo.id} attempt ${attempts}: ${lastError.slice(0, 140)}`);
      }
    }
    rows.set(key, { model: model.id, photo: photo.file, photoId: photo.id, requestId: null, latencyMs: null, width: null, height: null, status: "failed", attempts, output: null, estUsd: 0, error: lastError });
    await persist();
  });

  await persist();
  const all = [...rows.values()].filter((row) => options.models.some((model) => model.id === row.model) && photos.some((photo) => photo.id === row.photoId));

  console.log("\n=== parallax depth summary ===");
  for (const model of options.models) {
    const mine = all.filter((row) => row.model === model.id);
    const okLatencies = mine.filter((row) => row.status.startsWith("ok") && row.latencyMs !== null).map((row) => row.latencyMs as number);
    const failures = mine.filter((row) => !row.status.startsWith("ok"));
    console.log(`${model.id}: ok=${mine.length - failures.length}/${photos.length} (new=${mine.filter((r) => r.status === "ok").length}, resumed=${mine.filter((r) => r.status === "ok-existing").length}) avg=${okLatencies.length ? Math.round(mean(okLatencies)! / 100) / 10 : "n/a"}s median=${okLatencies.length ? Math.round(median(okLatencies)! / 100) / 10 : "n/a"}s failures=${failures.length}${halted ? " [HALTED]" : ""}`);
    for (const row of failures.slice(0, 10)) console.log(`   - ${row.photoId} ${row.status}: ${(row.error ?? "").slice(0, 140)}`);
  }
  console.log(`Results -> ${resultsPath}`);
  console.log(`Raw outputs -> ${rawDir}`);
  console.log(`Estimated spend $${all.reduce((sum, row) => sum + row.estUsd, 0).toFixed(3)} — read the real cost from the fal dashboard (Usage).`);
  console.log("Next: npm run parallax:normalize");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
