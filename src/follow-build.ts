// tools/pet-benchmark/src/follow-build.ts
//
// Step 3 of the "pet turns its head toward the viewer" prototype.
//
// For each of the 4 kept photos (snow cat skipped):
//   1. Extract every frame of the LEFT and RIGHT clips (ffmpeg, high-quality JPEG)
//      into out/follow-demo/assets/<id>/left/ and /right/.
//   2. Compute per-frame turn progress:
//        motion[i] = mean abs grayscale diff between consecutive frames
//                    inside the head region (upper 45% height, central 70% width)
//        progress  = cumsum(motion) normalised to 0..1  (frame 1 = 0 = centre)
//   3. Trim ends: keep frame 1 (centre); drop frames with progress < 0.03
//      (leading stillness) and progress > 0.97 (trailing stillness).
//   4. Build ONE ordered sequence:
//        LEFT reversed (progress TURN_LIMIT..0, signed negative) +
//        centre (progress 0) +
//        RIGHT (progress 0..TURN_LIMIT, signed positive)
//      so sequence signed-progress is monotonic (-1..0..+1).
//   5. Write manifest.json (per-frame signed progress, clip frame, seconds).
//   6. Contact sheet: every 6th sequence frame, labelled with clip frame no. &
//      progress, into out/follow-demo/sheets/<id>.jpg.
//
// The full trimmed range (progress ~0.03..0.97, signed ~-0.97..+0.97) is stored
// in the manifest; the page applies a TURN_LIMIT slider (default 0.5) to select
// the active window, so the slider is genuinely tunable 0.2..1.0.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FOLLOW_DEMO = path.join(root, "out", "follow-demo");
const CLIPS_DIR = path.join(FOLLOW_DEMO, "clips");
const ASSETS_DIR = path.join(FOLLOW_DEMO, "assets");
const SHEETS_DIR = path.join(FOLLOW_DEMO, "sheets");
const STATE_PATH = path.join(FOLLOW_DEMO, "state.json");

const HEAD_TOP_FRAC = 0.45;      // head region: upper 45% of frame
const HEAD_CENTER_FRAC = 0.70;   // head region: central 70% of width
const PROGRESS_LEAD_DROP = 0.03; // drop leading frames below this progress
const PROGRESS_TRAIL_DROP = 0.97;// drop trailing frames above this progress
const MOTION_SMALL_W = 96;       // head region resize width for motion measurement

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runCommand(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code: number | null) =>
      code === 0 ? resolve(`${stdout}\n${stderr}`) : reject(new Error(`${binary} ${args.join(" ")} exited ${code}: ${stderr.slice(-1200)}`))
    );
  });
}

async function ffprobeDim(clip: string): Promise<{ w: number; h: number }> {
  const out = await runCommand("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", clip,
  ]);
  const [w, h] = out.trim().split(",").map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h)) throw new Error(`ffprobe dims failed for ${clip}: ${out}`);
  return { w, h };
}

async function extractFrames(clip: string, outDir: string): Promise<number> {
  await mkdir(outDir, { recursive: true });
  await runCommand("ffmpeg", ["-y", "-i", clip, "-qscale:v", "2", path.join(outDir, "frame_%04d.jpg")]);
  const files = (await readdir(outDir)).filter((f) => /^frame_\d+\.jpg$/i.test(f)).sort();
  return files.length;
}

// Grayscale bytes of the head region, resized small for fast motion measurement.
async function headBytes(framePath: string, w: number, h: number): Promise<Buffer> {
  const left = Math.round((1 - HEAD_CENTER_FRAC) * w / 2);
  const top = 0;
  const width = Math.round(HEAD_CENTER_FRAC * w);
  const height = Math.round(HEAD_TOP_FRAC * h);
  const outH = Math.max(1, Math.round(MOTION_SMALL_W * (height / width)));
  return sharp(framePath)
    .extract({ left, top, width, height })
    .resize(MOTION_SMALL_W, outH)
    .greyscale()
    .raw()
    .toBuffer();
}

function meanAbsDiff(a: Buffer, b: Buffer): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

type FrameInfo = {
  index: number;
  file: string;
  clipFrame: number;
  progress: number;      // unsigned clip progress 0..1
  signedProgress: number;// -progress (left) / 0 (centre) / +progress (right)
  source: "left" | "right" | "centre";
  seconds: number;
};

// Process one clip: extract frames, compute per-frame progress, trim ends,
// return kept frames (incl. centre) plus the centre frame info.
async function processClip(
  clip: string,
  outDir: string,
  sign: -1 | 1,
  sourceName: "left" | "right"
): Promise<{ frames: FrameInfo[]; centre: FrameInfo | null; totalFrames: number }> {
  const n = await extractFrames(clip, outDir);
  const meta = await sharp(path.join(outDir, "frame_0001.jpg")).metadata();
  const w = meta.width!;
  const h = meta.height!;
  // progress indexed by clipFrame (1-based); prog[1] = 0 (centre), prog[n] = 1 (full turn)
  const prog = new Array<number>(n + 1);
  const cumsum = new Array<number>(n + 1);
  prog[1] = 0;
  cumsum[1] = 0;
  let prev: Buffer | null = null;
  let cum = 0;
  for (let c = 2; c <= n; c++) {
    const cur = await headBytes(path.join(outDir, `frame_${String(c).padStart(4, "0")}.jpg`), w, h);
    const m = prev ? meanAbsDiff(prev, cur) : 0;
    cum += m;
    cumsum[c] = cum;
    prev = cur;
  }
  const total = cumsum[n];
  for (let c = 1; c <= n; c++) prog[c] = total > 0 ? cumsum[c] / total : 0;

  // Trim: keep clipFrame 1 (centre) always; for c>=2 keep if in [LEAD, TRAIL].
  const kept: number[] = [1];
  for (let c = 2; c <= n; c++) {
    if (prog[c] >= PROGRESS_LEAD_DROP && prog[c] <= PROGRESS_TRAIL_DROP) kept.push(c);
  }

  const frames: FrameInfo[] = kept.map((c) => ({
    index: c - 1,
    file: path.join(outDir, `frame_${String(c).padStart(4, "0")}.jpg`),
    clipFrame: c,
    progress: prog[c],
    signedProgress: sign * prog[c],
    source: sourceName,
    seconds: 0,
  }));
  const centre = frames.find((f) => f.clipFrame === 1) ?? null;
  return { frames, centre, totalFrames: n };
}

// Build the merged sequence for one photo:
//   LEFT kept frames (progress ascending) reversed  -> signed -progress  (most-left .. near-centre)
//   + centre (clipFrame 1, signed 0)
//   + RIGHT kept frames (progress ascending)        -> signed +progress  (near-centre .. most-right)
// Result is monotonic in signedProgress (-1 .. 0 .. +1).
function buildSequence(
  left: { frames: FrameInfo[]; centre: FrameInfo | null },
  right: { frames: FrameInfo[]; centre: FrameInfo | null },
  fps: number
): FrameInfo[] {
  const leftTurn = left.frames.filter((f) => f.clipFrame !== 1).reverse(); // progress desc
  const centre = left.centre ?? right.centre;
  const rightTurn = right.frames.filter((f) => f.clipFrame !== 1); // progress asc
  const seq: FrameInfo[] = [
    ...leftTurn.map((f) => ({ ...f, signedProgress: -Math.abs(f.signedProgress) })),
    centre ? { ...centre, signedProgress: 0, source: "centre" as const } : null,
    ...rightTurn.map((f) => ({ ...f, signedProgress: Math.abs(f.signedProgress) })),
  ].filter(Boolean) as FrameInfo[];
  let i = 0;
  for (const f of seq) {
    f.index = i;
    f.seconds = Number((i / fps).toFixed(3));
    i++;
  }
  return seq;
}

async function contactSheet(seq: FrameInfo[], photoId: string, w: number, h: number): Promise<void> {
  await mkdir(SHEETS_DIR, { recursive: true });
  const tiles = seq.filter((f, idx) => idx % 6 === 0);
  if (tiles.length === 0) return;
  const tileW = 160;
  const cols = Math.min(8, tiles.length);
  const rows = Math.ceil(tiles.length / cols);
  const tileH = Math.round(tileW * (h / w));
  const sheet = sharp({
    create: {
      width: cols * tileW + (cols + 1) * 8,
      height: rows * tileH + (rows + 1) * 8 + 24,
      channels: 3,
      background: { r: 20, g: 20, b: 20 },
    },
  });
  const ops: any[] = [];
  let t = 0;
  for (const f of tiles) {
    const col = t % cols;
    const row = Math.floor(t / cols);
    const tileBuf = await sharp(f.file).resize(tileW, tileH, { fit: "cover" }).toBuffer();
    ops.push({ input: tileBuf, left: 8 + col * (tileW + 8), top: 8 + row * (tileH + 8) });
    t++;
  }
  if (ops.length) await sheet.composite(ops).jpeg({ quality: 85 }).toFile(path.join(SHEETS_DIR, `${photoId}.jpg`));
  const labels = tiles.map((f) => ({
    tileIndex: tiles.indexOf(f),
    seqIndex: f.index,
    clipFrame: f.clipFrame,
    signedProgress: Number(f.signedProgress.toFixed(3)),
    progress: Number(f.progress.toFixed(3)),
    source: f.source,
  }));
  await writeFile(path.join(SHEETS_DIR, `${photoId}.labels.json`), JSON.stringify(labels, null, 2), "utf8");
  console.log(`sheet ${photoId}: ${tiles.length} tiles -> sheets/${photoId}.jpg`);
}

async function main(): Promise<void> {
  const raw = JSON.parse(await readFile(STATE_PATH, "utf8")) as any;
  const jobs: any[] = raw.jobs ?? [];
  const done = jobs.filter((j: any) => j.status === "done");
  const skippedSnowCat = "file-00000000b82881f4920564827bf088ba-pn";
  const photos = [...new Set(done.map((j: any) => String(j.photoId)))].filter((id: string) => id !== skippedSnowCat);
  console.log(`kept photos: ${photos.length} -> ${photos.join(", ")}`);

  await mkdir(ASSETS_DIR, { recursive: true });

  const photosList: any[] = raw.photos ?? [];

  for (const photoId of photos) {
    const leftJob = jobs.find((j: any) => String(j.photoId) === photoId && j.direction === "left" && j.status === "done");
    const rightJob = jobs.find((j: any) => String(j.photoId) === photoId && j.direction === "right" && j.status === "done");
    if (!leftJob || !rightJob) {
      console.log(`skip ${photoId}: missing done left/right`);
      continue;
    }
    const photoEntry = photosList.find((p: any) => String(p.id) === photoId);
    const leftClip = path.join(CLIPS_DIR, `${photoId}-left.mp4`);
    const rightClip = path.join(CLIPS_DIR, `${photoId}-right.mp4`);
    const leftDir = path.join(ASSETS_DIR, photoId, "left");
    const rightDir = path.join(ASSETS_DIR, photoId, "right");

    const { frames: leftFrames, centre: leftCentre, totalFrames: leftTotal } = await processClip(leftClip, leftDir, -1, "left");
    const { frames: rightFrames, centre: rightCentre, totalFrames: rightTotal } = await processClip(rightClip, rightDir, +1, "right");

    const fps = (leftTotal || rightTotal || 0) > 0 ? Math.max(leftTotal, rightTotal) / 4 : 24;
    const seq = buildSequence({ frames: leftFrames, centre: leftCentre }, { frames: rightFrames, centre: rightCentre }, fps);

    const meta = await sharp(seq[0].file).metadata();
    const w = meta.width!;
    const h = meta.height!;

    const framesManifest = seq.map((f) => ({
      index: f.index,
      file: `/out/follow-demo/${path.relative(FOLLOW_DEMO, f.file).split(path.sep).join("/")}`,
      source: f.source,
      clipFrame: f.clipFrame,
      progress: Number(f.progress.toFixed(4)),
      signedProgress: Number(f.signedProgress.toFixed(4)),
      seconds: f.seconds,
    }));

    const manifest = {
      photo: photoId,
      photoFile: photoEntry?.file ?? photoId,
      size: { w: photoEntry?.w ?? 0, h: photoEntry?.h ?? 0 },
      clipSize: { w, h },
      aspect: photoEntry?.aspect ?? "16:9",
      durationSec: 4,
      fps: Number(fps.toFixed(3)),
      frameCount: seq.length,
      centreIndex: seq.findIndex((f) => f.source === "centre"),
      trimmed: { leadDrop: PROGRESS_LEAD_DROP, trailDrop: PROGRESS_TRAIL_DROP },
      frames: framesManifest,
    };
    const photoAssetDir = path.join(ASSETS_DIR, photoId);
    await mkdir(photoAssetDir, { recursive: true });
    await writeFile(path.join(photoAssetDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    await contactSheet(seq, photoId, w, h);

    const first = seq[0];
    const last = seq[seq.length - 1];
    console.log(
      `${photoId}: frames=${seq.length} centreIndex=${manifest.centreIndex} ` +
      `range [${first.signedProgress.toFixed(2)}..${last.signedProgress.toFixed(2)}] ` +
      `leftKept=${leftFrames.length} rightKept=${rightFrames.length} fps=${fps.toFixed(2)}`
    );
  }
  console.log("BUILD DONE");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

