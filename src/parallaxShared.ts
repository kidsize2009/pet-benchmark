import { access, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Shared layout for the Parallax depth-map A/B benchmark. Everything a run writes lives under
// out/parallax-bench/, which the repo's .gitignore already covers ("out/") — resized inputs, raw
// provider outputs, derived depth maps, the blind key and the report are therefore never committed.
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const benchDir = path.join(root, "out", "parallax-bench");
export const inputDir = path.join(benchDir, "input");
export const rawDir = path.join(benchDir, "raw");
export const depthRawDir = path.join(benchDir, "depth-raw");
export const depthReadyDir = path.join(benchDir, "depth-ready");
export const resultsPath = path.join(benchDir, "results.json");
export const keyPath = path.join(benchDir, "key.json");
export const conventionsPath = path.join(benchDir, "conventions.json");
export const comparePath = path.join(benchDir, "compare.html");

// Source photos live OUTSIDE the repo and are only ever read; originals are never copied into it.
export const DEFAULT_PHOTOS_DIR = "C:\\MyProjects\\_parallax_photos";

// Identical preprocessing for BOTH models so the comparison is fair: longest side 1536 px, JPEG q90.
export const LONGEST_SIDE = 1536;
export const JPEG_QUALITY = 90;
export const EXPECTED_PHOTOS = 20;

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);

export type ModelId = "depth-anything-v2" | "marigold-v2";

export type ModelSpec = {
  id: ModelId;
  endpoint: string;
  /** Planning estimate only, used for the pre-spend print. fal responses carry no price field, so
   * the real per-call cost must be read from the fal dashboard (Usage). */
  estUsdPerCall: number;
  /** Exact field names taken from each endpoint's published OpenAPI schema (notes inline). */
  buildInput: (imageUrl: string) => Record<string, unknown>;
};

export const MODELS: ModelSpec[] = [
  {
    // Schema (OpenAPI, Oct 2026): input has ONE required field `image_url`; output is `{ image }`.
    // No size or format option exists, so the provider picks the output resolution (recorded per call).
    id: "depth-anything-v2",
    endpoint: "fal-ai/image-preprocessors/depth-anything/v2",
    estUsdPerCall: 0.005,
    buildInput: (imageUrl) => ({ image_url: imageUrl }),
  },
  {
    // Schema (OpenAPI, Oct 2026): required `image_url`; optional `prediction_type`
    // ("depth" | "see-through-depth" | "normals" | "albedo", default "depth"), `image_size`
    // (OMITTED here on purpose: the default is the input dimensions rounded to the nearest multiple
    // of 16, which keeps Marigold's output at input size), `seed`, `enable_safety_checker`
    // (left at its default true). Output is `{ image, seed }`, documented as a COLORIZED
    // Spectral-colormap PNG — "a viewable image, not a lossless numeric tensor". There is no
    // raw/grayscale option, which is why parallaxNormalize.ts inverts the colormap LUT.
    id: "marigold-v2",
    endpoint: "fal-ai/marigold-v2",
    estUsdPerCall: 0.03,
    buildInput: (imageUrl) => ({ prediction_type: "depth", image_url: imageUrl }),
  },
];

export const modelById = (id: string): ModelSpec => {
  const found = MODELS.find((model) => model.id === id);
  if (!found) throw new Error(`Unknown model id: ${id}`);
  return found;
};

export type PhotoEntry = { id: string; file: string; absolutePath: string };

/**
 * Lists the source photos deterministically and gives each a stable ASCII slug (`p01`, `p02`, …).
 * Names in the source folder include Cyrillic and spaces, so slugs keep every downstream path
 * shell- and URL-safe while `file` preserves the original name for the report.
 */
export async function listPhotos(dir: string, limit?: number): Promise<PhotoEntry[]> {
  const names = (await readdir(dir))
    .filter((name) => IMAGE_EXT.has(path.extname(name).toLowerCase()))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const entries = names.map((file, index) => ({
    id: `p${String(index + 1).padStart(2, "0")}`,
    file,
    absolutePath: path.join(dir, file),
  }));
  return limit === undefined ? entries : entries.slice(0, limit);
}

export const exists = async (file: string): Promise<boolean> => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Temp file then rename, so an interrupted run never leaves truncated JSON behind. */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await rename(temp, file);
}

export async function ensureDirs(...dirs: string[]): Promise<void> {
  for (const dir of dirs) await mkdir(dir, { recursive: true });
}

/**
 * Runs `work` over `items` with at most `concurrency` in flight (the brief allows sequential or <= 2).
 * Hands out no new work once `stop` returns true — the budget guard uses this for a hard halt.
 */
export async function pool<Item>(
  items: Item[],
  concurrency: number,
  stop: () => boolean,
  work: (item: Item) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      if (stop()) return;
      const index = cursor++;
      if (index >= items.length) return;
      await work(items[index]!);
    }
  });
  await Promise.all(workers);
}

/** Strips the API key from any message before it can reach a log line or results.json. */
export const redact = (value: unknown, apiKey: string): string => {
  const message = value instanceof Error ? value.message : String(value);
  return (apiKey ? message.split(apiKey).join("[redacted]") : message).replace(/\s+/g, " ").slice(0, 500);
};

/**
 * Billing/access failures that must abort the whole run at once instead of retrying: HTTP 402,
 * 403 (fal commonly answers "balance … locked"), or a message naming balance, credits, quota,
 * payment or a locked account.
 */
export function isBlockedError(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  if (status === 402 || status === 403) return true;
  return /\balance\b|insufficient|locked|payment|quota|credits|unauthorized/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

export const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

export const mean = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
