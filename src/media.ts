import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

export type FocusPoint = { x: number; y: number };
const ffmpegPath = createRequire(import.meta.url)("ffmpeg-static") as string | null;
const ffmpegBinary = ffmpegPath ?? "ffmpeg";

export async function cropToPortrait(
  sourcePath: string,
  outputPath: string,
  focus: FocusPoint = { x: 0.5, y: 0.5 },
): Promise<void> {
  const rotated = await sharp(sourcePath).rotate().toBuffer();
  const { width, height } = await sharp(rotated).metadata();
  if (!width || !height) throw new Error(`Cannot read image dimensions: ${sourcePath}`);

  const cropWidth = width / height > 9 / 16 ? Math.floor((height * 9) / 16) : width;
  const cropHeight = width / height > 9 / 16 ? height : Math.floor((width * 16) / 9);
  const left = Math.max(0, Math.min(width - cropWidth, Math.round(focus.x * width - cropWidth / 2)));
  const top = Math.max(0, Math.min(height - cropHeight, Math.round(focus.y * height - cropHeight / 2)));

  await sharp(rotated)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .resize(1080, 1920, { fit: "fill" })
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(outputPath);
}

function runFfmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBinary, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(`${stdout}\n${stderr}`);
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-1600)}`));
    });
  });
}

export async function verifyFfmpeg(): Promise<void> {
  const [encoders, filters] = await Promise.all([
    runFfmpeg(["-encoders"]),
    runFfmpeg(["-filters"]),
  ]);
  if (!encoders.includes("libx264") || !filters.includes("ssim")) {
    throw new Error("ffmpeg must include the libx264 encoder and ssim filter");
  }
}

export async function makeThreeSecondClip(inputPath: string, outputPath: string): Promise<void> {
  await runFfmpeg([
    "-y",
    "-i", inputPath,
    "-an",
    "-vf", "fps=30,tpad=stop_mode=clone:stop_duration=3,trim=end_frame=90,setpts=PTS-STARTPTS",
    "-frames:v", "90",
    "-t", "3",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    outputPath,
  ]);
}

export async function calculateEndpointSsim(videoPath: string): Promise<number | null> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pet-benchmark-"));
  const firstPath = path.join(tempDir, "first.png");
  const lastPath = path.join(tempDir, "last.png");
  try {
    await runFfmpeg(["-y", "-i", videoPath, "-vf", "select=eq(n\\,0)", "-frames:v", "1", firstPath]);
    await runFfmpeg(["-y", "-i", videoPath, "-vf", "select=eq(n\\,89)", "-frames:v", "1", lastPath]);
    const output = await runFfmpeg([
      "-i", firstPath,
      "-i", lastPath,
      "-lavfi", "ssim",
      "-f", "null",
      "-",
    ]);
    const match = output.match(/All:([0-9.]+)/);
    return match ? Number(match[1]) : null;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function downloadFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status} ${response.statusText})`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

export async function readFocusFile(filePath: string): Promise<Record<string, FocusPoint>> {
  try {
    const content = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("focus.json must be an object keyed by photo filename");
    }
    const focus = parsed as Record<string, FocusPoint>;
    for (const [name, point] of Object.entries(focus)) {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
          point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
        throw new Error(`Invalid focus point for ${name}: x and y must be in 0..1`);
      }
    }
    return focus;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}