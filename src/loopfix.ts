import { spawn } from "node:child_process";
import { readdir, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { calculateAverageConsecutiveSsim, calculateSsimBetweenFrames, getVideoDurationSeconds, getVideoFrameCount } from "./media.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ffmpegPath = createRequire(import.meta.url)("ffmpeg-static") as string | null;
const ffmpegBinary = ffmpegPath ?? "ffmpeg";
const outputDir = path.join(root, "out", "loopfix");
const frameRate = 30;
const targetSize = "1080:1920";
type ClipResult = { name: string; input: string; xfade: string; pingpong: string; xfadePreview: string; pingpongPreview: string; originalSsim: number | null; xfadeSsim: number | null; pingpongSsim: number | null; baselineSsim: number | null; duration: number };

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBinary, args, { windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-1800)}`));
    });
  });
}

function parseArgs(args: string[]): { input: string; overlap: number } {
  const input = args[0];
  if (!input) throw new Error("Usage: npm run loopfix -- <input.mp4|folder> [--overlap 0.5]");
  let overlap = 0.5;
  for (let index = 1; index < args.length; index++) {
    if (args[index] !== "--overlap") throw new Error(`Unknown option: ${args[index]}`);
    const value = Number(args[++index]);
    if (!Number.isFinite(value) || value <= 0) throw new Error("--overlap must be a positive number of seconds");
    overlap = value;
  }
  return { input, overlap };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

async function makeXfade(input: string, output: string, duration: number, overlap: number, frameCount: number): Promise<void> {
  const headFrames = Math.round(overlap * frameRate);
  const headStart = headFrames;
  const tailStart = Math.round((duration - overlap) * frameRate);
  const prefixFrames = tailStart - headStart;
  const transitionFrames = headFrames;
  const seamFrame = headFrames;
  const blend = ((transitionFrames - 1) / frameRate).toFixed(6);
  const outputFrames = prefixFrames + transitionFrames + 1;
  const normalize = `fps=${frameRate},scale=${targetSize}:force_original_aspect_ratio=decrease,pad=${targetSize}:-1:-1,setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS`;
  const graph = `[0:v]${normalize},split=4[base][tailSrc][headSrc][seamSrc];[base]trim=start_frame=${headStart}:end_frame=${tailStart},setpts=PTS-STARTPTS,settb=AVTB[basecut];[tailSrc]trim=start_frame=${tailStart}:end_frame=${frameCount},setpts=PTS-STARTPTS,settb=AVTB[tail];[headSrc]trim=start_frame=0:end_frame=${headFrames},setpts=PTS-STARTPTS,settb=AVTB[head];[tail][head]xfade=transition=fade:duration=${blend}:offset=0,settb=AVTB[blend];[blend]trim=end_frame=${transitionFrames},setpts=PTS-STARTPTS[fadepart];[seamSrc]trim=start_frame=${seamFrame}:end_frame=${seamFrame + 1},setpts=PTS-STARTPTS,settb=AVTB[seam];[basecut][fadepart][seam]concat=n=3:v=1:a=0,fps=${frameRate},trim=end_frame=${outputFrames},setpts=PTS-STARTPTS[out]`;
  await runFfmpeg(["-y", "-i", input, "-filter_complex", graph, "-map", "[out]", "-an", "-r", String(frameRate), "-fps_mode", "cfr", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output]);
}

async function makeThreeLoopPreview(input: string, output: string): Promise<void> {
  await runFfmpeg(["-y", "-stream_loop", "2", "-i", input, "-an", "-c", "copy", "-movflags", "+faststart", output]);
}

async function makePingpong(input: string, output: string, frameCount: number): Promise<void> {
  const normalize = `fps=${frameRate},scale=${targetSize}:force_original_aspect_ratio=decrease,pad=${targetSize}:-1:-1,setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS`;
  const graph = `[0:v]${normalize},split=2[forward][reverseSrc];[reverseSrc]reverse,setpts=PTS-STARTPTS,trim=start_frame=1:end_frame=${frameCount - 1},setpts=PTS-STARTPTS,settb=AVTB[backward];[forward]settb=AVTB[forwardNorm];[forwardNorm][backward]concat=n=2:v=1:a=0,fps=${frameRate},setpts=PTS-STARTPTS[out]`;
  await runFfmpeg(["-y", "-i", input, "-filter_complex", graph, "-map", "[out]", "-an", "-r", String(frameRate), "-fps_mode", "cfr", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output]);
}

async function writeGallery(results: ClipResult[]): Promise<void> {
  const relative = (file: string) => escapeHtml(path.relative(outputDir, file).split(path.sep).join("/"));
  const rows = results.map((clip) => `<tr><th>${escapeHtml(clip.name)}</th><td><video muted loop autoplay playsinline controls preload="metadata" src="${relative(clip.input)}"></video></td><td><video muted loop autoplay playsinline controls preload="metadata" src="${relative(clip.xfade)}"></video><a href="${relative(clip.xfadePreview)}">3x preview</a></td><td><video muted loop autoplay playsinline controls preload="metadata" src="${relative(clip.pingpong)}"></video><a href="${relative(clip.pingpongPreview)}">3x preview</a></td></tr>`).join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loopfix comparison</title><style>body{font:14px system-ui,sans-serif;margin:24px;color:#202522;background:#f3f5f1}h1{font-size:22px}main{overflow:auto}table{border-collapse:collapse;min-width:100%;background:#fff}th,td{border:1px solid #d8ded8;padding:10px;text-align:left;vertical-align:top}thead th{position:sticky;top:0;background:#e8eee8}video{display:block;width:180px;max-width:30vw;aspect-ratio:9/16;background:#111;object-fit:contain}a{display:inline-block;margin-top:6px;color:#145a52}</style></head><body><h1>Loopfix comparison</h1><main><table><thead><tr><th>Clip</th><th>Original</th><th>Xfade + 3x preview</th><th>Pingpong + 3x preview</th></tr></thead><tbody>${rows}</tbody></table></main></body></html>`;
  await writeFile(path.join(outputDir, "index.html"), html, "utf8");
}

async function main(): Promise<void> {
  const { input, overlap } = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(process.cwd(), input);
  let files: string[];
  try {
    const entries = await readdir(inputPath, { withFileTypes: true });
    files = entries.filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".mp4").map((entry) => path.join(inputPath, entry.name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
    files = [inputPath];
  }
  if (files.length === 0) throw new Error(`No .mp4 files found in ${inputPath}`);

  await mkdir(outputDir, { recursive: true });
  const results: ClipResult[] = [];
  const exampleDuration = 3.04;
  const exampleFrameCount = 91;
  const exampleHeadFrames = Math.round(overlap * frameRate);
  const exampleHeadStart = exampleHeadFrames;
  const exampleTailStart = Math.round((exampleDuration - overlap) * frameRate);
  const examplePrefixFrames = exampleTailStart - exampleHeadStart;
  const exampleTransitionFrames = exampleHeadFrames;
  const exampleSeamFrame = exampleHeadFrames;
  const exampleBlend = ((exampleTransitionFrames - 1) / frameRate).toFixed(6);
  const exampleNormalize = `fps=${frameRate},scale=${targetSize}:force_original_aspect_ratio=decrease,pad=${targetSize}:-1:-1,setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS`;
  const exampleFrames = examplePrefixFrames + exampleTransitionFrames + 1;
  const exampleGraph = `[0:v]${exampleNormalize},split=4[base][tailSrc][headSrc][seamSrc];[base]trim=start_frame=${exampleHeadStart}:end_frame=${exampleTailStart},setpts=PTS-STARTPTS,settb=AVTB[basecut];[tailSrc]trim=start_frame=${exampleTailStart}:end_frame=${exampleFrameCount},setpts=PTS-STARTPTS,settb=AVTB[tail];[headSrc]trim=start_frame=0:end_frame=${exampleHeadFrames},setpts=PTS-STARTPTS,settb=AVTB[head];[tail][head]xfade=transition=fade:duration=${exampleBlend}:offset=0,settb=AVTB[blend];[blend]trim=end_frame=${exampleTransitionFrames},setpts=PTS-STARTPTS[fadepart];[seamSrc]trim=start_frame=${exampleSeamFrame}:end_frame=${exampleSeamFrame + 1},setpts=PTS-STARTPTS,settb=AVTB[seam];[basecut][fadepart][seam]concat=n=3:v=1:a=0,fps=${frameRate},trim=end_frame=${exampleFrames},setpts=PTS-STARTPTS[out]`;
  console.log(`XFADE example D=${exampleDuration.toFixed(6)} T=${overlap.toFixed(6)}: prefix frames [${exampleHeadStart},${exampleTailStart})=${examplePrefixFrames}, xfade offset=0 duration=${exampleBlend}s/${exampleTransitionFrames} frames, append exact frame=${exampleSeamFrame} (t=T), output=${exampleFrames} frames (${(exampleFrames / frameRate).toFixed(6)}s; continuous target D-T=${(exampleDuration - overlap).toFixed(6)}s); filtergraph: ${exampleGraph}`);
  for (const file of files) {
    const name = path.parse(file).name;
    const xfade = path.join(outputDir, `${name}_xfade.mp4`);
    const pingpong = path.join(outputDir, `${name}_pingpong.mp4`);
    const xfadePreview = path.join(outputDir, `preview_${name}_xfade.mp4`);
    const pingpongPreview = path.join(outputDir, `preview_${name}_pingpong.mp4`);
    const duration = await getVideoDurationSeconds(file);
    const frameCount = await getVideoFrameCount(file, frameRate);
    if (overlap * 2 >= duration) throw new Error(`Overlap ${overlap}s must be less than half of ${name} duration (${duration.toFixed(3)}s)`);
    await makeXfade(file, xfade, duration, overlap, frameCount);
    await makePingpong(file, pingpong, frameCount);
    await Promise.all([makeThreeLoopPreview(xfade, xfadePreview), makeThreeLoopPreview(pingpong, pingpongPreview)]);
    const [originalSsim, xfadeSsim, pingpongSsim, baselineSsim] = await Promise.all([
      calculateSsimBetweenFrames(file, "last", 0),
      calculateSsimBetweenFrames(xfade, "last", 0),
      calculateSsimBetweenFrames(pingpong, "last", 0),
      calculateAverageConsecutiveSsim(file, frameRate),
    ]);
    results.push({ name, input: file, xfade, pingpong, xfadePreview, pingpongPreview, originalSsim, xfadeSsim, pingpongSsim, baselineSsim, duration });
  }
  await writeGallery(results);
  console.log("file\toriginal wrap SSIM\txfade wrap SSIM\tpingpong wrap SSIM\toriginal consecutive SSIM\tduration");
  for (const clip of results) {
    console.log(`${clip.name}\t${clip.originalSsim?.toFixed(4) ?? "n/a"}\t${clip.xfadeSsim?.toFixed(4) ?? "n/a"}\t${clip.pingpongSsim?.toFixed(4) ?? "n/a"}\t${clip.baselineSsim?.toFixed(4) ?? "n/a"}\t${clip.duration.toFixed(3)}s`);
  }
  console.log(`Gallery: ${path.join(outputDir, "index.html")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
