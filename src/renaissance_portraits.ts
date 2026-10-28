import { config as loadEnv } from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp, { type OverlayOptions } from "sharp";
import { fal } from "@fal-ai/client";
import { presets } from "../presets.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: path.join(root, ".env") });
const apiKey = process.env["FAL_KEY"] ?? "";
if (!apiKey) throw new Error("FAL_KEY missing in .env");
fal.config({ credentials: apiKey });

const photosDir = path.resolve(root, "..", "vision-eval", "photos");
const outDir = path.resolve(root, "..", "vision-eval", "manual", "renaissance_portraits");

const PROMPT =
  "Transform this photo into a classic Renaissance oil painting portrait of the same pet. Keep the pet's identity exactly: same face, fur color and pattern, markings, eye color and ears. Dress the pet in an elegant 16th-century noble costume (velvet, lace collar, small jewel). Dark warm studio background, soft candlelight from the side, visible brush strokes and craquelure. The pet looks toward the viewer, face and eyes clearly visible, centered, vertical 9:16 composition, no text, no frame, no extra animals or objects.";

const PHOTOS = ["03", "14", "05", "08", "16", "10"];
const BUDGET_IMAGES = 0.85 * 1.2;
const SEEDANCE_PER_SEC = 0.3024;
const BUDGET_VIDEO = 2.42 * 1.2;

type ImageModel = { id: string; endpoint: string; price: number; input: (url: string) => Record<string, unknown> };
const imageModels: ImageModel[] = [
  { id: "nano-banana", endpoint: "fal-ai/nano-banana/edit", price: 0.039,
    input: (u) => ({ prompt: PROMPT, image_urls: [u], aspect_ratio: "9:16", output_format: "jpeg", num_images: 1 }) },
  { id: "flux-kontext-pro", endpoint: "fal-ai/flux-pro/kontext", price: 0.04,
    input: (u) => ({ prompt: PROMPT, image_url: u, aspect_ratio: "9:16", output_format: "jpeg", num_images: 1 }) },
  { id: "gpt-image-1-medium", endpoint: "fal-ai/gpt-image-1/edit-image", price: 0.063,
    input: (u) => ({ prompt: PROMPT, image_urls: [u], image_size: "1024x1536", quality: "medium", input_fidelity: "high", output_format: "jpeg", num_images: 1 }) },
];

type Row = { model: string; photo: string; seconds: number | null; price: number; error?: string };
const redact = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split(apiKey).join("[redacted]").slice(0, 600);

async function upload(file: string): Promise<string> {
  const buf = await readFile(file);
  return fal.storage.upload(new Blob([buf], { type: file.endsWith(".png") ? "image/png" : "image/jpeg" }));
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function stageImages(): Promise<void> {
  const rows: Row[] = [];
  let spent = 0;
  const planned = imageModels.reduce((s, m) => s + m.price * PHOTOS.length, 0);
  console.log(`planned image cost $${planned.toFixed(3)}`);
  const urls = new Map<string, string>();
  for (const p of PHOTOS) urls.set(p, await upload(path.join(photosDir, `${p}.jpg`)));

  for (const m of imageModels) {
    await mkdir(path.join(outDir, m.id), { recursive: true });
    await Promise.all(PHOTOS.map(async (p) => {
      if (spent + m.price > BUDGET_IMAGES) { rows.push({ model: m.id, photo: p, seconds: null, price: 0, error: "budget stop" }); return; }
      spent += m.price;
      const t0 = Date.now();
      try {
        const result = await fal.subscribe(m.endpoint, { input: m.input(urls.get(p)!), logs: false });
        const data = result.data as { images?: { url: string }[] };
        const url = data.images?.[0]?.url;
        if (!url) throw new Error("no image in response");
        const jpg = await sharp(await download(url)).jpeg({ quality: 92 }).toBuffer();
        await writeFile(path.join(outDir, m.id, `${p}.jpg`), jpg);
        const seconds = Math.round((Date.now() - t0) / 100) / 10;
        rows.push({ model: m.id, photo: p, seconds, price: m.price });
        console.log(`${m.id} ${p} ok ${seconds}s`);
      } catch (e) {
        rows.push({ model: m.id, photo: p, seconds: null, price: m.price, error: redact(e) });
        console.log(`${m.id} ${p} FAILED ${redact(e)}`);
      }
    }));
  }
  await writeFile(path.join(outDir, "results.json"), JSON.stringify(rows, null, 1));
  console.log(`spent (est) $${spent.toFixed(3)}`);
}

async function stageSheets(): Promise<void> {
  const rows = JSON.parse(await readFile(path.join(outDir, "results.json"), "utf8")) as Row[];
  const H = 640, W = 360, cols = 3;
  for (const m of imageModels) {
    const tiles: OverlayOptions[] = [];
    const pairW = W * 2 + 10;
    const rowCount = Math.ceil(PHOTOS.length / cols);
    for (let i = 0; i < PHOTOS.length; i++) {
      const p = PHOTOS[i]!;
      const left = (i % cols) * (pairW + 20) + 10;
      const top = Math.floor(i / cols) * (H + 50) + 10;
      const orig = await sharp(path.join(photosDir, `${p}.jpg`)).resize(W, H, { fit: "contain", background: "#222" }).jpeg().toBuffer();
      const row = rows.find((r) => r.model === m.id && r.photo === p);
      let res: Buffer;
      try { res = await sharp(path.join(outDir, m.id, `${p}.jpg`)).resize(W, H, { fit: "contain", background: "#222" }).jpeg().toBuffer(); }
      catch { res = await sharp({ create: { width: W, height: H, channels: 3, background: "#600" } }).jpeg().toBuffer(); }
      const caption = `${p}  ${row?.seconds ?? "fail"}s  $${row?.price ?? 0}`;
      const svg = Buffer.from(`<svg width="${pairW}" height="36"><text x="4" y="26" font-size="24" font-family="Arial" fill="#fff">${caption}</text></svg>`);
      tiles.push({ input: orig, left, top }, { input: res, left: left + W + 10, top }, { input: svg, left, top: top + H + 4 });
    }
    const width = cols * (pairW + 20) + 10, height = rowCount * (H + 50) + 20;
    await sharp({ create: { width, height, channels: 3, background: "#111" } }).composite(tiles).jpeg({ quality: 88 }).toFile(path.join(outDir, `sheet_${m.id}.jpg`));
  }
  console.log("sheets written");
}

// Usage: tsx src/renaissance_portraits.ts videos <model>:<photo> <model>:<photo>
async function stageVideos(pairs: string[]): Promise<void> {
  const prompt = presets.renaissance_a;
  const cost = 4 * SEEDANCE_PER_SEC * pairs.length;
  console.log(`planned video cost $${cost.toFixed(2)}`);
  if (cost > BUDGET_VIDEO) throw new Error("video budget exceeded");
  await mkdir(path.join(outDir, "clips"), { recursive: true });
  for (const pair of pairs) {
    const [model, photo] = pair.split(":") as [string, string];
    const url = await upload(path.join(outDir, model, `${photo}.jpg`));
    const t0 = Date.now();
    const result = await fal.subscribe("bytedance/seedance-2.0/image-to-video", {
      input: { image_url: url, end_image_url: url, prompt, duration: "4", resolution: "720p", aspect_ratio: "9:16", generate_audio: false },
    });
    const video = (result.data as { video?: { url?: string } }).video?.url;
    if (!video) throw new Error(`no video for ${pair}`);
    await writeFile(path.join(outDir, "clips", `${model}_${photo}.mp4`), await download(video));
    console.log(`${pair} ok ${Math.round((Date.now() - t0) / 100) / 10}s $${(4 * SEEDANCE_PER_SEC).toFixed(2)}`);
  }
}

const [stage, ...rest] = process.argv.slice(2);
try {
  if (stage === "images") await stageImages();
  else if (stage === "sheets") await stageSheets();
  else if (stage === "videos") await stageVideos(rest);
  else console.log("usage: images | sheets | videos <model>:<photo>...");
} catch (e) {
  console.error(redact(e));
  process.exit(1);
}
