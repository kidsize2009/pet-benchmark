import { fal } from "@fal-ai/client";
import { config as loadEnv } from "dotenv";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";
import { COMMON, SAMPLE_PETS, type SamplePetPrompt } from "./samplePets.prompts.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = path.join(root, "out", "sample-pets");
const hardRequestCap = 25;
const variantsPerPreset = 3;
const concurrencyLimit = 3;
const maxRetriesPerJob = 1;

const primaryModel = "fal-ai/flux-pro/v1.1-ultra";
const fallbackModel = "fal-ai/nano-banana";
const fluxCostPerImageUsd = 0.06;
const fallbackCostPerImageUsd = 0;

type CliOptions = {
  dryRun: boolean;
  onlyPreset?: string;
};

type JobPlan = {
  presetKey: string;
  name: string;
  prompt: string;
  finalPrompt: string;
  variant: number;
  seed: number;
  outputFileAbs: string;
  outputFileRelPosix: string;
};

type ManifestItem = {
  presetKey: string;
  name: string;
  file: string;
  model: string;
  seed: number;
  requestId: string;
  width: number | null;
  height: number | null;
  prompt: string;
  createdAt: string;
};

type GeneratorStats = {
  requests: number;
  retries: number;
  failures: number;
  usedFallback: boolean;
  blockedOrBlankOrWrongAspect: string[];
  estimateUsd: number;
};

function parseArgs(args: string[]): CliOptions {
  let dryRun = false;
  let onlyPreset: string | undefined;
  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("--only=")) {
      const value = arg.slice("--only=".length).trim();
      if (!value) throw new Error("--only requires a non-empty preset key");
      onlyPreset = value;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run sample-pets -- [--dry-run] [--only=<presetKey>]");
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return { dryRun, onlyPreset };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function nextFreeOutputPath(
  presetKey: string,
  reservedIndexes: Set<number>,
): Promise<{ abs: string; relPosix: string }> {
  const dir = path.join(outRoot, presetKey);
  await mkdir(dir, { recursive: true });
  let index = 1;
  while (true) {
    if (reservedIndexes.has(index)) {
      index++;
      continue;
    }
    const name = `${presetKey}-${index}.jpg`;
    const abs = path.join(dir, name);
    if (!(await exists(abs))) {
      reservedIndexes.add(index);
      return {
        abs,
        relPosix: path.relative(outRoot, abs).split(path.sep).join("/"),
      };
    }
    index++;
  }
}

function buildFinalPrompt(basePrompt: string): string {
  return `${basePrompt}\n\n${COMMON}`;
}

function makeSeed(): number {
  return randomInt(1, 2_147_483_647);
}

function estimatedCostForModel(model: string, imageCount: number): number {
  if (model === primaryModel) return imageCount * fluxCostPerImageUsd;
  return imageCount * fallbackCostPerImageUsd;
}

function buildInput(model: string, finalPrompt: string, seed: number): Record<string, unknown> {
  if (model === primaryModel) {
    return {
      prompt: finalPrompt,
      aspect_ratio: "9:16",
      raw: true,
      output_format: "jpeg",
      num_images: 1,
      seed,
      safety_tolerance: "2",
    };
  }
  return {
    prompt: finalPrompt,
    aspect_ratio: "9:16",
    output_format: "jpeg",
    num_images: 1,
    seed,
    safety_tolerance: "4",
    limit_generations: true,
  };
}

function shouldFallback(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return (
    normalized.includes("not found") ||
    normalized.includes("does not exist") ||
    normalized.includes("unknown model") ||
    normalized.includes("raw") ||
    normalized.includes("unrecognized field") ||
    normalized.includes("invalid input")
  );
}

async function downloadToFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, buffer);
}

function extractImage(data: unknown): { url: string; width: number | null; height: number | null; nsfw: boolean | null } {
  if (!data || typeof data !== "object") throw new Error("Missing response data");
  const imageList = (data as { images?: unknown }).images;
  if (!Array.isArray(imageList) || imageList.length < 1) throw new Error("Response did not contain images[0]");
  const first = imageList[0] as { url?: unknown; width?: unknown; height?: unknown };
  if (typeof first?.url !== "string" || first.url.length === 0) throw new Error("Response image URL was missing");
  const width = typeof first.width === "number" ? first.width : null;
  const height = typeof first.height === "number" ? first.height : null;
  const flags = (data as { has_nsfw_concepts?: unknown }).has_nsfw_concepts;
  const nsfw = Array.isArray(flags) && typeof flags[0] === "boolean" ? flags[0] : null;
  return { url: first.url, width, height, nsfw };
}

function hasWrongAspect(width: number | null, height: number | null): boolean {
  if (!width || !height) return false;
  const ratio = width / height;
  const target = 9 / 16;
  return Math.abs(ratio - target) > 0.03;
}

async function runWithConcurrency<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next) await worker(next);
    }
  });
  await Promise.all(runners);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function buildGalleryHtml(manifest: ManifestItem[], prompts: SamplePetPrompt[]): string {
  const grouped = new Map<string, ManifestItem[]>();
  for (const item of manifest) {
    const list = grouped.get(item.presetKey) ?? [];
    list.push(item);
    grouped.set(item.presetKey, list);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => a.file.localeCompare(b.file));
  }

  const rows = prompts.map((prompt) => {
    const list = grouped.get(prompt.presetKey) ?? [];
    return {
      presetKey: prompt.presetKey,
      title: `${prompt.presetKey[0].toUpperCase()}${prompt.presetKey.slice(1)} · ${prompt.name}`,
      items: list,
    };
  });

  const embedded = JSON.stringify(rows);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>PetMotion Sample Pets Gallery</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: Inter, Segoe UI, Roboto, Arial, sans-serif; background: #111318; color: #f3f5f8; }
    .wrap { max-width: 1400px; margin: 0 auto; padding: 20px; }
    h1 { margin: 0 0 6px; font-size: 24px; }
    .sub { margin: 0 0 16px; color: #b8c0cc; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 16px; }
    button { border: 0; background: #3d7dff; color: white; border-radius: 8px; padding: 8px 12px; font-weight: 600; cursor: pointer; }
    button:hover { background: #3065cc; }
    .rows { display: grid; gap: 18px; }
    .row { background: #1a1f29; border: 1px solid #2b3340; border-radius: 12px; padding: 12px; }
    .row-title { margin: 0 0 10px; font-size: 16px; color: #dce3f0; }
    .cards { display: grid; grid-template-columns: repeat(3, minmax(180px, 1fr)); gap: 12px; }
    .card { position: relative; border-radius: 10px; overflow: hidden; border: 2px solid transparent; background: #000; cursor: pointer; }
    .card.selected { border-color: #62f4a8; box-shadow: 0 0 0 2px rgba(98, 244, 168, 0.25); }
    .thumb { width: 100%; aspect-ratio: 9 / 16; object-fit: cover; display: block; }
    .meta { padding: 8px; font-size: 12px; color: #c2ccdc; background: #161b24; }
    .overlay { position: absolute; inset: 0; pointer-events: none; display: none; }
    .overlay.on { display: block; }
    .clock-line { position: absolute; left: 0; right: 0; top: 33.333%; border-top: 2px dashed rgba(255,255,255,0.75); }
    .clock { position: absolute; top: 6%; left: 7%; font-size: clamp(30px, 6vw, 58px); line-height: 1; font-weight: 700; color: rgba(255,255,255,0.95); text-shadow: 0 2px 8px rgba(0,0,0,0.6); }
    .date { position: absolute; top: 17%; left: 7%; font-size: clamp(10px, 1.6vw, 15px); color: rgba(255,255,255,0.9); text-shadow: 0 2px 6px rgba(0,0,0,0.6); }
    pre { background: #0d1118; border: 1px solid #2b3340; border-radius: 8px; padding: 10px; overflow: auto; min-height: 56px; color: #d2deef; }
    dialog { border: 0; padding: 0; width: min(92vw, 520px); background: #000; border-radius: 12px; }
    dialog::backdrop { background: rgba(0,0,0,0.8); }
    .zoom { width: 100%; max-height: 90vh; object-fit: contain; display: block; }
    .zoom-close { position: absolute; top: 12px; right: 12px; background: rgba(17,19,24,0.9); border: 1px solid rgba(255,255,255,0.25); }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>PetMotion sample pets</h1>
    <p class="sub">Pick one best image per preset row.</p>
    <div class="toolbar">
      <label><input id="overlayToggle" type="checkbox" checked> Lock-screen overlay</label>
      <button id="copyBtn" type="button">Copy picks</button>
    </div>
    <div id="rows" class="rows"></div>
    <h2>Picks JSON</h2>
    <pre id="picksPre">{}</pre>
  </div>
  <dialog id="zoomDialog">
    <div style="position:relative">
      <button class="zoom-close" id="zoomClose" type="button">Close</button>
      <img id="zoomImg" class="zoom" alt="Zoomed pet sample">
    </div>
  </dialog>
  <script>
    const rowsData = ${embedded};
    const rowsEl = document.getElementById("rows");
    const overlayToggle = document.getElementById("overlayToggle");
    const copyBtn = document.getElementById("copyBtn");
    const picksPre = document.getElementById("picksPre");
    const zoomDialog = document.getElementById("zoomDialog");
    const zoomImg = document.getElementById("zoomImg");
    const zoomClose = document.getElementById("zoomClose");
    const picks = {};

    function render() {
      rowsEl.innerHTML = "";
      for (const row of rowsData) {
        const wrapper = document.createElement("section");
        wrapper.className = "row";
        const title = document.createElement("h3");
        title.className = "row-title";
        title.textContent = row.title;
        wrapper.appendChild(title);
        const cards = document.createElement("div");
        cards.className = "cards";

        for (const item of row.items) {
          const card = document.createElement("article");
          card.className = "card";
          card.dataset.presetKey = row.presetKey;
          card.dataset.file = item.file;
          if (picks[row.presetKey] === item.file) card.classList.add("selected");

          const img = document.createElement("img");
          img.className = "thumb";
          img.src = item.file;
          img.alt = row.title + " " + item.file.split("/").pop();

          const overlay = document.createElement("div");
          overlay.className = "overlay" + (overlayToggle.checked ? " on" : "");
          overlay.innerHTML = '<div class="clock-line"></div><div class="clock">10:26</div><div class="date">Tue, October 28</div>';

          const meta = document.createElement("div");
          meta.className = "meta";
          meta.textContent = (item.model + " · seed " + item.seed);

          card.appendChild(img);
          card.appendChild(overlay);
          card.appendChild(meta);

          img.addEventListener("click", (event) => {
            if (picks[row.presetKey] === item.file) {
              zoomImg.src = item.file;
              zoomDialog.showModal();
              return;
            }
            picks[row.presetKey] = item.file;
            for (const sibling of cards.querySelectorAll(".card")) sibling.classList.remove("selected");
            card.classList.add("selected");
            picksPre.textContent = JSON.stringify(picks, null, 2);
          });

          card.addEventListener("dblclick", (event) => {
            event.stopPropagation();
            zoomImg.src = item.file;
            zoomDialog.showModal();
          });

          cards.appendChild(card);
        }
        wrapper.appendChild(cards);
        rowsEl.appendChild(wrapper);
      }
    }

    overlayToggle.addEventListener("change", () => {
      for (const overlay of document.querySelectorAll(".overlay")) {
        overlay.classList.toggle("on", overlayToggle.checked);
      }
    });

    copyBtn.addEventListener("click", async () => {
      const text = JSON.stringify(picks, null, 2);
      picksPre.textContent = text;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
      }
    });

    zoomClose.addEventListener("click", () => zoomDialog.close());
    zoomDialog.addEventListener("click", (event) => {
      if (event.target === zoomDialog) zoomDialog.close();
    });

    picksPre.textContent = JSON.stringify(picks, null, 2);
    render();
  </script>
</body>
</html>`;
}

async function readExistingManifest(): Promise<ManifestItem[]> {
  const manifestPath = path.join(outRoot, "manifest.json");
  if (!(await exists(manifestPath))) return [];
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as ManifestItem[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse existing manifest.json: ${message}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  loadEnv({ path: path.join(root, ".env") });
  const apiKey = process.env.FAL_KEY ?? "";
  if (!apiKey) {
    throw new Error("FAL_KEY is missing in the existing environment setup. Stopping without changes to .env.");
  }
  fal.config({ credentials: apiKey });

  const prompts = options.onlyPreset
    ? SAMPLE_PETS.filter((item) => item.presetKey === options.onlyPreset)
    : SAMPLE_PETS;
  if (prompts.length === 0) {
    throw new Error(`Unknown preset key "${options.onlyPreset}". Available: ${SAMPLE_PETS.map((item) => item.presetKey).join(", ")}`);
  }

  const plannedJobs: JobPlan[] = [];
  const reservedByPreset = new Map<string, Set<number>>();
  for (const pet of prompts) {
    const reserved = reservedByPreset.get(pet.presetKey) ?? new Set<number>();
    reservedByPreset.set(pet.presetKey, reserved);
    for (let variant = 1; variant <= variantsPerPreset; variant++) {
      const outputPath = await nextFreeOutputPath(pet.presetKey, reserved);
      plannedJobs.push({
        presetKey: pet.presetKey,
        name: pet.name,
        prompt: pet.prompt,
        finalPrompt: buildFinalPrompt(pet.prompt),
        variant,
        seed: makeSeed(),
        outputFileAbs: outputPath.abs,
        outputFileRelPosix: outputPath.relPosix,
      });
    }
  }

  const expectedCount = prompts.length * variantsPerPreset;
  if (plannedJobs.length !== expectedCount) {
    throw new Error(`Planning failed: expected ${expectedCount} jobs, got ${plannedJobs.length}`);
  }

  const selectedModel = primaryModel;
  const initialEstimate = estimatedCostForModel(selectedModel, plannedJobs.length);
  console.log(`Planned jobs: ${plannedJobs.length}`);
  console.log(`Model target: ${selectedModel}`);
  console.log(`Estimated total cost (USD): ${initialEstimate.toFixed(2)}`);
  for (const job of plannedJobs) {
    console.log(`${job.presetKey}#${job.variant} seed=${job.seed} -> out/sample-pets/${job.outputFileRelPosix}`);
  }

  if (options.dryRun) {
    console.log("Dry run complete. No API calls were made.");
    return;
  }

  await mkdir(outRoot, { recursive: true });
  const manifest = await readExistingManifest();
  const stats: GeneratorStats = {
    requests: 0,
    retries: 0,
    failures: 0,
    usedFallback: false,
    blockedOrBlankOrWrongAspect: [],
    estimateUsd: 0,
  };

  let effectiveModel = primaryModel;

  await runWithConcurrency(plannedJobs, concurrencyLimit, async (job) => {
    let attempt = 0;
    let done = false;
    while (!done) {
      if (stats.requests >= hardRequestCap) {
        throw new Error(`Request cap exceeded (${hardRequestCap}). Aborting.`);
      }
      attempt++;
      stats.requests++;
      const currentModel = effectiveModel;
      const input = buildInput(currentModel, job.finalPrompt, job.seed);
      try {
        const result = await fal.subscribe(currentModel, { input, logs: false });
        const image = extractImage(result.data);
        await mkdir(path.dirname(job.outputFileAbs), { recursive: true });
        await downloadToFile(image.url, job.outputFileAbs);
        const createdAt = new Date().toISOString();
        const item: ManifestItem = {
          presetKey: job.presetKey,
          name: job.name,
          file: job.outputFileRelPosix,
          model: currentModel,
          seed: job.seed,
          requestId: result.requestId,
          width: image.width,
          height: image.height,
          prompt: job.finalPrompt,
          createdAt,
        };
        manifest.push(item);
        stats.estimateUsd += estimatedCostForModel(currentModel, 1);
        if (hasWrongAspect(image.width, image.height)) {
          stats.blockedOrBlankOrWrongAspect.push(`out/sample-pets/${job.outputFileRelPosix} wrong aspect ${String(image.width)}x${String(image.height)}`);
        }
        if (image.nsfw === true) {
          stats.blockedOrBlankOrWrongAspect.push(`out/sample-pets/${job.outputFileRelPosix} flagged NSFW`);
        }
        done = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const canFallback = effectiveModel === primaryModel && shouldFallback(message);
        if (canFallback) {
          effectiveModel = fallbackModel;
          stats.usedFallback = true;
          if (attempt <= 1) {
            continue;
          }
        }
        if (attempt <= maxRetriesPerJob) {
          stats.retries++;
          continue;
        }
        stats.failures++;
        stats.blockedOrBlankOrWrongAspect.push(`out/sample-pets/${job.outputFileRelPosix} failed: ${message.replace(/\s+/g, " ").slice(0, 160)}`);
        done = true;
      }
    }
  });

  const manifestPath = path.join(outRoot, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  const recentManifest = manifest.filter((item) => plannedJobs.some((job) => job.outputFileRelPosix === item.file));
  const html = buildGalleryHtml(recentManifest, prompts);
  const htmlPath = path.join(outRoot, "index.html");
  await writeFile(htmlPath, html, "utf8");

  console.log(`Completed images: ${recentManifest.length}/${plannedJobs.length}`);
  console.log(`Requests sent: ${stats.requests}`);
  console.log(`Retries used: ${stats.retries}`);
  console.log(`Failures: ${stats.failures}`);
  console.log(`Model used: ${stats.usedFallback ? `${primaryModel} -> ${fallbackModel}` : primaryModel}`);
  console.log(`Estimated cost (USD): ${stats.estimateUsd.toFixed(2)}`);
  console.log(`Manifest: ${path.relative(root, manifestPath).split(path.sep).join("/")}`);
  console.log(`Gallery: ${path.relative(root, htmlPath).split(path.sep).join("/")}`);
  if (stats.blockedOrBlankOrWrongAspect.length > 0) {
    console.log("Review items:");
    for (const item of stats.blockedOrBlankOrWrongAspect) console.log(`- ${item}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
