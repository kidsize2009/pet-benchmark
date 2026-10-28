import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  MODELS,
  benchDir,
  depthRawDir,
  depthReadyDir,
  ensureDirs,
  inputDir,
  rawDir,
  readJson,
  writeJson,
  conventionsPath,
  resultsPath,
  mean,
  median,
  type ModelSpec,
} from "./parallaxShared.js";

// Turns the raw provider outputs into parallax-ready depth maps.
//   npm run parallax:normalize
// Steps, applied IDENTICALLY to both models:
//   1) get one scalar per pixel in 0..1: a grayscale read when the provider returns gray, or a
//      colormap inversion when it returns a colorized visualization (see COLORMAP section below);
//   2) force the NEAR = BRIGHT convention (detect by comparing the central subject region against the
//      median of the image border; invert when the subject comes out darker);
//   3) stretch 0..1 over the 1st..99th percentile;
//   4) write depth-raw/ (normalized only) and depth-ready/ (grey dilation 11 px + Gaussian sigma 4).
//
// COLORMAP inversion (Marigold V2). Its schema has no raw/grayscale option: `prediction_type: "depth"`
// returns a Spectral-colormap PNG ("a viewable image, not a lossless numeric tensor"), so the scalar has
// to be recovered from the colours. Method, in the order it is applied:
//   a) every raw output is collected and its exact colour set read. Each image yields 256 colours and the
//      union over all 20 images is also exactly 256 -> the provider renders one shared 256-level LUT whose
//      full range every image happens to use, so the LUT can be read off the data instead of guessed.
//   b) the 256 colours are ordered by projecting each onto the ColorBrewer/matplotlib `Spectral` anchor
//      curve (#9E0142 -> #D53E41 -> #F46D43 -> #FDAE61 -> #FEE08B -> #FFFFBF -> #E6F598 -> #ABDDA4 ->
//      #66C2A5 -> #3288BD -> #5E4FA2, piecewise linear, densely sampled). The curve is 1-D in RGB, so the
//      projection position gives an unambiguous ordering; quality is reported as distance-to-curve and the
//      largest gap between consecutive positions (both must stay small for the inversion to be trustworthy).
//   c) the rank in that order IS the quantized depth level: level = rank / (colourCount - 1).
//      Pixels whose colour is not in the recovered map fall back to the nearest curve position and are
//      counted as `curveFallbacks` (0 expected).
// A hand-typed 256-entry LUT was tried first and rejected: it matched 0% of the real colours, so this
// data-driven recovery is used instead and is validated against the other model per photo (Pearson r).

const CENTER_BOX = { x0: 0.25, x1: 0.75, y0: 0.25, y1: 0.75 }; // "the pet region" proxy: central 50% x 50%
const BORDER_THICKNESS = 0.04; // outer band used as the "far background" reference
const PERCENTILE_LOW = 1;
const PERCENTILE_HIGH = 99;
const DILATE_WINDOW = 11; // grey dilation with an 11x11 square structuring element (radius 5)
const BLUR_SIGMA = 4;
const GRAY_TOLERANCE = 0.995; // share of pixels with r == g == b for a map to count as grayscale
const CORRELATION_SAMPLES = 400_000; // stride-sampled pixels for the cross-model check

// ColorBrewer "Spectral" 11-class anchors, the data matplotlib's Spectral colormap is derived from.
const SPECTRAL_ANCHORS: [number, number, number][] = [
  [158, 1, 66], [213, 62, 65], [244, 109, 67], [253, 174, 97], [254, 224, 139],
  [255, 255, 191], [230, 245, 152], [171, 221, 164], [102, 194, 165], [50, 136, 189], [94, 79, 162],
];
const CURVE_PER_SEGMENT = 512;
const SPECTRAL_CURVE: [number, number, number][] = (() => {
  const curve: [number, number, number][] = [];
  for (let segment = 0; segment < SPECTRAL_ANCHORS.length - 1; segment++) {
    const a = SPECTRAL_ANCHORS[segment]!;
    const b = SPECTRAL_ANCHORS[segment + 1]!;
    for (let step = 0; step < CURVE_PER_SEGMENT; step++) {
      const t = step / CURVE_PER_SEGMENT;
      curve.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  curve.push(SPECTRAL_ANCHORS[SPECTRAL_ANCHORS.length - 1]!);
  return curve;
})();

const colorKey = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b;
const keyRgb = (key: number): [number, number, number] => [(key >> 16) & 255, (key >> 8) & 255, key & 255];

/** Nearest point on the Spectral curve, as its normalized position 0..1 plus the RGB distance. */
function projectOnCurve(rgb: [number, number, number]): { position: number; distance: number } {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < SPECTRAL_CURVE.length; index++) {
    const c = SPECTRAL_CURVE[index]!;
    const distance = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return { position: bestIndex / (SPECTRAL_CURVE.length - 1), distance: Math.sqrt(bestDistance) };
}

type RawImage = { width: number; height: number; channels: number; data: Buffer };

async function readRaw(file: string): Promise<RawImage> {
  const { data, info } = await sharp(await readFile(file))
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, channels: info.channels, data: Buffer.from(data) };
}

/** Palette + grayscale/colour decision over every raw output of one model. */
type ModelPalette = {
  colormapped: boolean;
  grayShare: number;
  paletteSize: number;
  unionSize: number;
  perImagePaletteSizes: number[];
  meanDistanceToCurve: number;
  maxDistanceToCurve: number;
  maxLevelGap: number;
  ends: { first: [number, number, number]; last: [number, number, number] };
  levels: Map<number, number>;
};

function buildPalette(images: RawImage[]): ModelPalette {
  const union = new Set<number>();
  const perImagePaletteSizes: number[] = [];
  let equalRgb = 0;
  let sampled = 0;
  for (const image of images) {
    const { width, height, channels, data } = image;
    const total = width * height;
    const stride = Math.max(1, Math.floor(total / 200_000));
    for (let pixel = 0; pixel < total; pixel += stride) {
      const base = pixel * channels;
      const r = data[base]!;
      const g = channels > 1 ? data[base + 1]! : r;
      const b = channels > 2 ? data[base + 2]! : r;
      if (r === g && g === b) equalRgb++;
      sampled++;
    }
    for (let pixel = 0; pixel < total; pixel++) {
      const base = pixel * channels;
      union.add(colorKey(data[base]!, channels > 1 ? data[base + 1]! : data[base]!, channels > 2 ? data[base + 2]! : data[base]!));
      if (union.size > 8192) break; // a real depth LUT is far smaller; this only guards a runaway image
    }
    perImagePaletteSizes.push(paletteSizeOf(image));
  }
  const grayShare = sampled === 0 ? 0 : equalRgb / sampled;
  const colormapped = grayShare < GRAY_TOLERANCE;

  // Order the observed colours along the colormap curve; the rank is the quantized depth level.
  const projected = [...union].map((key) => {
    const { position, distance } = projectOnCurve(keyRgb(key));
    return { key, position, distance };
  });
  const distances = projected.map((entry) => entry.distance);
  projected.sort((a, b) => a.position - b.position);
  const gaps = projected.slice(1).map((entry, index) => entry.position - projected[index]!.position);
  const levels = new Map<number, number>();
  const divisor = Math.max(1, projected.length - 1);
  projected.forEach((entry, index) => levels.set(entry.key, index / divisor));

  return {
    colormapped,
    grayShare,
    paletteSize: projected.length,
    unionSize: union.size,
    perImagePaletteSizes,
    meanDistanceToCurve: distances.length === 0 ? 0 : distances.reduce((a, b) => a + b, 0) / distances.length,
    maxDistanceToCurve: distances.length === 0 ? 0 : Math.max(...distances),
    maxLevelGap: gaps.length === 0 ? 0 : Math.max(...gaps),
    ends: {
      first: keyRgb(projected[0]?.key ?? 0),
      last: keyRgb(projected[projected.length - 1]?.key ?? 0),
    },
    levels,
  };
}

function paletteSizeOf(image: RawImage): number {
  const set = new Set<number>();
  const { width, height, channels, data } = image;
  for (let pixel = 0; pixel < width * height; pixel++) {
    const base = pixel * channels;
    set.add(colorKey(data[base]!, channels > 1 ? data[base + 1]! : data[base]!, channels > 2 ? data[base + 2]! : data[base]!));
    if (set.size > 8192) break;
  }
  return set.size;
}

type Scalar = { width: number; height: number; values: Float32Array };

/** One scalar per pixel: the gray level, or the recovered colormap depth level. */
function toScalar(image: RawImage, palette: ModelPalette): { scalar: Scalar; curveFallbacks: number } {
  const { width, height, channels, data } = image;
  const values = new Float32Array(width * height);
  let curveFallbacks = 0;
  for (let pixel = 0; pixel < width * height; pixel++) {
    const base = pixel * channels;
    if (!palette.colormapped) {
      values[pixel] = data[base]! / 255;
      continue;
    }
    const r = data[base]!;
    const g = channels > 1 ? data[base + 1]! : r;
    const b = channels > 2 ? data[base + 2]! : r;
    const level = palette.levels.get(colorKey(r, g, b));
    if (level === undefined) {
      curveFallbacks++;
      values[pixel] = projectOnCurve([r, g, b]).position;
    } else {
      values[pixel] = level;
    }
  }
  return { scalar: { width, height, values }, curveFallbacks };
}

/**
 * NEAR = BRIGHT measurement: the central subject region should be brighter (larger depth value) than the
 * median of the outer border band. Pure observation — the caller decides and applies the inversion.
 */
function measureNearIsBright(scalar: Scalar): { nearWasBright: boolean; centerMean: number; borderMedian: number } {
  const { width, height, values } = scalar;
  const x0 = Math.floor(width * CENTER_BOX.x0);
  const x1 = Math.ceil(width * CENTER_BOX.x1);
  const y0 = Math.floor(height * CENTER_BOX.y0);
  const y1 = Math.ceil(height * CENTER_BOX.y1);
  const thickness = Math.max(1, Math.round(Math.min(width, height) * BORDER_THICKNESS));

  let centerSum = 0;
  let centerCount = 0;
  const border: number[] = [];
  for (let y = 0; y < height; y++) {
    const inBorderRow = y < thickness || y >= height - thickness;
    for (let x = 0; x < width; x++) {
      const value = values[y * width + x]!;
      const inCenter = x >= x0 && x < x1 && y >= y0 && y < y1;
      const inBorder = inBorderRow || x < thickness || x >= width - thickness;
      if (inCenter && !inBorder) {
        centerSum += value;
        centerCount++;
      } else if (inBorder && !inCenter) {
        border.push(value);
      }
    }
  }
  const centerMean = centerCount === 0 ? 0 : centerSum / centerCount;
  border.sort((a, b) => a - b);
  const borderMedian = border.length === 0 ? 0 : median(border)!;
  return { nearWasBright: centerMean > borderMedian, centerMean, borderMedian };
}

/** In-place flip so NEAR = BRIGHT holds for every map of a model that emitted NEAR = DARK. */
function invertInPlace(scalar: Scalar): void {
  for (let index = 0; index < scalar.values.length; index++) scalar.values[index] = 1 - scalar.values[index]!;
}

/** Stretches the range so the 1st percentile maps to 0 and the 99th to 1, clamping the tails. */
function percentileStretch(scalar: Scalar): { values: Uint8Array; low: number; high: number } {
  const BINS = 2048;
  const histogram = new Int32Array(BINS);
  for (const value of scalar.values) {
    const bin = Math.min(BINS - 1, Math.max(0, Math.floor(value * BINS)));
    histogram[bin]!++;
  }
  const total = scalar.values.length;
  const at = (percentile: number): number => {
    const target = (total * percentile) / 100;
    let running = 0;
    for (let bin = 0; bin < BINS; bin++) {
      running += histogram[bin]!;
      if (running >= target) return bin / BINS;
    }
    return 1;
  };
  const low = at(PERCENTILE_LOW);
  const high = at(PERCENTILE_HIGH);
  const span = Math.max(1e-6, high - low);
  const out = new Uint8Array(total);
  for (let index = 0; index < total; index++) {
    const stretched = (scalar.values[index]! - low) / span;
    out[index] = Math.round(Math.min(1, Math.max(0, stretched)) * 255);
  }
  return { values: out, low, high };
}

/**
 * Sliding maximum of one 1-D line using a monotonic deque, so an 11 px grey dilation stays
 * O(count) per line instead of O(count * window). Border semantics are "replicate": the window for
 * pixel i covers [max(0, i - radius), min(count - 1, i + radius)], which the sweep handles by clamping
 * the deque's left edge once the right edge has run past the end of the line.
 */
function dilateLine(line: Uint8Array, window: number): Uint8Array {
  const count = line.length;
  const radius = Math.floor(window / 2);
  const out = new Uint8Array(count);
  const deque = new Int32Array(count);
  let head = 0;
  let tail = 0;
  const push = (index: number): void => {
    while (tail > head && line[deque[tail - 1]!]! <= line[index]!) tail--;
    deque[tail++] = index;
  };
  for (let right = 0; right < count; right++) {
    push(right);
    while (deque[head]! <= right - window) head++;
    const centre = right - radius;
    if (centre >= 0) out[centre] = line[deque[head]!]!;
  }
  for (let centre = Math.max(0, count - radius); centre < count; centre++) {
    while (tail > head && deque[head]! < centre - radius) head++;
    out[centre] = line[deque[head]!]!;
  }
  return out;
}

/** Square grey dilation: max over a DILATE_WINDOW x DILATE_WINDOW neighbourhood, separable as a row pass then a column pass. */
function dilateSquare(source: Uint8Array, width: number, height: number, window: number): Uint8Array {
  const byRows = new Uint8Array(source.length);
  for (let y = 0; y < height; y++) byRows.set(dilateLine(source.subarray(y * width, (y + 1) * width), window), y * width);

  const out = new Uint8Array(source.length);
  const column = new Uint8Array(height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) column[y] = byRows[y * width + x]!;
    const dilated = dilateLine(column, window);
    for (let y = 0; y < height; y++) out[y * width + x] = dilated[y]!;
  }
  return out;
}

const writeGray = async (file: string, values: Uint8Array, width: number, height: number): Promise<void> => {
  await sharp(Buffer.from(values), { raw: { width, height, channels: 1 } }).greyscale().png({ compressionLevel: 6 }).toFile(file);
};

/** Resamples `image` to the given size so two maps of slightly different output size can be compared. */
async function resized(image: { width: number; height: number; values: Uint8Array }, width: number, height: number): Promise<{ width: number; height: number; values: Uint8Array }> {
  if (image.width === width && image.height === height) return image;
  const data = await sharp(Buffer.from(image.values), { raw: { width: image.width, height: image.height, channels: 1 } })
    .resize(width, height, { fit: "fill" })
    .raw()
    .toBuffer();
  return { width, height, values: new Uint8Array(data) };
}

const meanOf = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);

/**
 * Cross-model agreement, computed on the normalized NEAR = BRIGHT maps at native resolution: two
 * credible depth maps of the same photo must be strongly positively correlated. A weak or negative r
 * means one of the two decoders is wrong, so this is the guard for the colormap inversion.
 */
function pearsonAligned(a: { width: number; height: number; values: Uint8Array }, b: { width: number; height: number; values: Uint8Array }): number {
  if (a.width !== b.width || a.height !== b.height) return Number.NaN;

  const stride = Math.max(1, Math.floor(a.values.length / CORRELATION_SAMPLES));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let index = 0; index < a.values.length; index += stride) {
    xs.push(a.values[index]!);
    ys.push(b.values[index]!);
  }
  const n = xs.length;
  if (n < 100) return Number.NaN;
  const meanX = meanOf(xs);
  const meanY = meanOf(ys);
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let index = 0; index < n; index++) {
    const dx = xs[index]! - meanX;
    const dy = ys[index]! - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  return denX === 0 || denY === 0 ? 0 : num / Math.sqrt(denX * denY);
}

type PhotoStat = {
  photoId: string;
  model: string;
  decoded: { width: number; height: number; colormapped: boolean; grayShare: number; curveFallbacks: number; uniqueColors: number };
  convention: { nearWasBright: boolean; centerMean: number; borderMedian: number; inverted: boolean };
  stretch: { p1: number; p99: number };
  output: { width: number; height: number; rawPath: string; readyPath: string };
};

type Prepared = { stat: PhotoStat; normalized: { width: number; height: number; values: Uint8Array } | null };

type ConventionChoice = { photos: number; votedNearDark: number; modelEmitsNearBright: boolean };

async function processModel(model: ModelSpec, photoIds: string[]): Promise<{ stats: PhotoStat[]; normalized: Map<string, { width: number; height: number; values: Uint8Array }>; palette: ModelPalette | null; choice: ConventionChoice | null }> {
  await ensureDirs(path.join(depthRawDir, model.id), path.join(depthReadyDir, model.id));
  const sources = photoIds.map((photoId) => ({ photoId, file: path.join(rawDir, model.id, `${photoId}.png`) }));

  // Pass 1: read every raw output once to recover the model's colour->level map (or confirm grayscale).
  const images: RawImage[] = [];
  const present: { photoId: string; file: string; image: RawImage }[] = [];
  for (const entry of sources) {
    try {
      const image = await readRaw(entry.file);
      images.push(image);
      present.push({ photoId: entry.photoId, file: entry.file, image });
    } catch {
      console.log(`skip ${model.id} ${entry.photoId} (no raw output)`);
    }
  }
  if (images.length === 0) return { stats: [], normalized: new Map(), palette: null, choice: null };
  const palette = buildPalette(images);
  if (palette.colormapped) {
    console.log(
      `${model.id}: COLORIZED output (no raw option in the schema) — recovered ${palette.paletteSize}-level LUT | grayShare=${(palette.grayShare * 100).toFixed(2)}% union=${palette.unionSize} meanCurveDist=${palette.meanDistanceToCurve.toFixed(2)} maxCurveDist=${palette.maxDistanceToCurve.toFixed(2)} maxLevelGap=${palette.maxLevelGap.toFixed(5)} ends rgb(${palette.ends.first.join(",")})->rgb(${palette.ends.last.join(",")})`
    );
  } else {
    console.log(`${model.id}: grayscale output, no inversion needed | grayShare=${(palette.grayShare * 100).toFixed(2)}% palette=${palette.unionSize} levels`);
  }

  // Pass 2a: one NEAR = BRIGHT vote per photo, decided ONCE for the whole model. A per-photo flip would
  // mis-orient the off-center and dark-framing shots (an off-center pet sits in the border band), so the
  // majority verdict is what gets applied to every image of that model.
  const probes = present.map((entry) => ({ ...entry, probe: measureNearIsBright(toScalar(entry.image, palette).scalar) }));
  const votedNearDark = probes.filter((entry) => !entry.probe.nearWasBright).length;
  const modelEmitsNearBright = votedNearDark * 2 < probes.length;
  const choice: ConventionChoice = { photos: probes.length, votedNearDark, modelEmitsNearBright };
  console.log(
    `${model.id}: near=bright vote ${probes.length - votedNearDark}/${probes.length} -> provider convention is NEAR=${modelEmitsNearBright ? "BRIGHT (maps kept as-is)" : "DARK (every map inverted)"}`
  );

  // Pass 2b: decode again, orient by the model-level decision, stretch, write raw + ready.
  const stats: PhotoStat[] = [];
  const normalized = new Map<string, { width: number; height: number; values: Uint8Array }>();
  for (const { photoId, image, probe } of probes) {
    const { scalar, curveFallbacks } = toScalar(image, palette);
    if (!modelEmitsNearBright) invertInPlace(scalar);
    const stretch = percentileStretch(scalar);
    const rawOut = path.join(depthRawDir, model.id, `${photoId}.png`);
    await writeGray(rawOut, stretch.values, scalar.width, scalar.height);

    const dilated = dilateSquare(stretch.values, scalar.width, scalar.height, DILATE_WINDOW);
    const readyOut = path.join(depthReadyDir, model.id, `${photoId}.png`);
    const prepared = await sharp(Buffer.from(dilated), { raw: { width: scalar.width, height: scalar.height, channels: 1 } })
      .greyscale()
      .blur({ sigma: BLUR_SIGMA })
      .greyscale()
      .png({ compressionLevel: 6 })
      .toBuffer();
    await writeFile(readyOut, prepared);
    const preparedMeta = await sharp(prepared).metadata();

    normalized.set(photoId, { width: scalar.width, height: scalar.height, values: stretch.values });
    stats.push({
      photoId,
      model: model.id,
      decoded: { width: scalar.width, height: scalar.height, colormapped: palette.colormapped, grayShare: +(palette.grayShare * 100).toFixed(2), curveFallbacks, uniqueColors: paletteSizeOf(image) },
      convention: {
        nearWasBright: probe.nearWasBright,
        centerMean: +probe.centerMean.toFixed(4),
        borderMedian: +probe.borderMedian.toFixed(4),
        inverted: !modelEmitsNearBright,
      },
      stretch: { p1: +stretch.low.toFixed(4), p99: +stretch.high.toFixed(4) },
      output: {
        width: preparedMeta.width ?? scalar.width,
        height: preparedMeta.height ?? scalar.height,
        rawPath: path.relative(benchDir, rawOut).replace(/\\/g, "/"),
        readyPath: path.relative(benchDir, readyOut).replace(/\\/g, "/"),
      },
    });
    console.log(
      `ok ${model.id} ${photoId} ${scalar.width}x${scalar.height} ${palette.colormapped ? "colormap->level" : "gray"} vote=${probe.nearWasBright ? "near=bright" : "near=dark"} applied=${modelEmitsNearBright ? "kept" : "inverted"} p1=${stretch.low.toFixed(3)} p99=${stretch.high.toFixed(3)} fallbacks=${curveFallbacks}`
    );
  }
  return { stats, normalized, palette, choice };
}

async function main(): Promise<void> {
  await ensureDirs(benchDir, depthRawDir, depthReadyDir);
  const photoIds = (await readdir(inputDir))
    .filter((name) => name.toLowerCase().endsWith(".jpg"))
    .map((name) => path.parse(name).name)
    .sort();
  if (photoIds.length === 0) throw new Error("No resized inputs found — run npm run parallax:depth first.");

  const prepared = new Map<string, Prepared>();
  const palettes = new Map<string, ModelPalette | null>();
  const choices = new Map<string, ConventionChoice | null>();
  const normalizedByModel = new Map<string, Map<string, { width: number; height: number; values: Uint8Array }>>();
  for (const model of MODELS) {
    const result = await processModel(model, photoIds);
    normalizedByModel.set(model.id, result.normalized);
    palettes.set(model.id, result.palette);
    choices.set(model.id, result.choice);
    for (const stat of result.stats) prepared.set(`${model.id}::${stat.photoId}`, { stat, normalized: result.normalized.get(stat.photoId) ?? null });
  }

  const [first, second] = MODELS;
  const correlations: { photoId: string; r: number | null }[] = [];
  if (first && second) {
    const mapA = normalizedByModel.get(first.id) ?? new Map<string, { width: number; height: number; values: Uint8Array }>();
    const mapB = normalizedByModel.get(second.id) ?? new Map<string, { width: number; height: number; values: Uint8Array }>();
    for (const photoId of photoIds) {
      const a = mapA.get(photoId);
      const b = mapB.get(photoId);
      const r = a && b ? pearsonAligned(a, await resized(b, a.width, a.height)) : Number.NaN;
      correlations.push({ photoId, r: Number.isFinite(r) ? +r.toFixed(4) : null });
      if (Number.isFinite(r)) console.log(`validate ${photoId} pearson(${first.id}, ${second.id}) = ${r.toFixed(3)} after both forced to NEAR=BRIGHT`);
    }
  }
  const finiteR = correlations.map((entry) => entry.r).filter((value): value is number => value !== null);

  const results = await readJson<Array<{ photoId: string; file: string }>>(resultsPath, []);
  const fileNames = new Map(results.map((entry) => [entry.photoId, entry.file]));

  const summary = MODELS.map((model) => {
    const stats = photoIds.map((photoId) => prepared.get(`${model.id}::${photoId}`)?.stat).filter((stat): stat is PhotoStat => Boolean(stat));
    const palette = palettes.get(model.id) ?? null;
    const choice = choices.get(model.id) ?? null;
    const offVotes = stats.filter((stat) => !stat.convention.nearWasBright).length;
    const fallbacks = stats.reduce((sum, stat) => sum + stat.decoded.curveFallbacks, 0);
    return {
      model: model.id,
      processed: stats.length,
      outputKind: palette?.colormapped ? "colorized (Spectral colormap PNG; schema offers no raw/grayscale option)" : "grayscale",
      inversion: palette?.colormapped
        ? `recovered ${palette.paletteSize}-level LUT from the union of the model's own palettes, ordered by projection onto the ColorBrewer/matplotlib Spectral anchor curve; scalar = rank/(levels-1)`
        : "not needed (r == g == b, red channel used directly)",
      graySharePercent: palette ? +(palette.grayShare * 100).toFixed(2) : null,
      paletteLevels: palette?.colormapped ? palette.paletteSize : null,
      unionPaletteSize: palette?.unionSize ?? null,
      lutEnds: palette?.colormapped ? { level0: palette.ends.first, level1: palette.ends.last } : null,
      meanDistanceToCurve: palette?.colormapped ? +palette.meanDistanceToCurve.toFixed(3) : null,
      maxDistanceToCurve: palette?.colormapped ? +palette.maxDistanceToCurve.toFixed(3) : null,
      maxLevelGap: palette?.colormapped ? +palette.maxLevelGap.toFixed(5) : null,
      curveFallbackPixels: fallbacks,
      nearBrightVotes: choice ? `${choice.photos - choice.votedNearDark}/${choice.photos}` : "n/a",
      rawDepthConvention: choice === null ? "n/a" : choice.modelEmitsNearBright ? "NEAR = BRIGHT in the provider output (maps used as-is)" : "NEAR = DARK in the provider output (every map inverted)",
      perPhotoOffConventionVotes: offVotes,
    };
  });

  await writeJson(conventionsPath, {
    generatedAt: new Date().toISOString(),
    params: { longestSide: 1536, jpegQuality: 90, percentileLow: PERCENTILE_LOW, percentileHigh: PERCENTILE_HIGH, dilateWindowPx: DILATE_WINDOW, blurSigma: BLUR_SIGMA, nearConvention: "NEAR = BRIGHT" },
    summary,
    crossModelCorrelation: {
      models: MODELS.map((model) => model.id),
      description: "Pearson r between the two normalized maps of the same photo, both already forced to NEAR = BRIGHT, sampled at native resolution. A strong POSITIVE r validates the colormap inversion; a value near 0 would mean one decoder is wrong.",
      values: correlations,
      meanR: finiteR.length === 0 ? null : +meanOf(finiteR).toFixed(4),
      photosCompared: finiteR.length,
    },
    perPhoto: photoIds.map((photoId) => ({
      photoId,
      file: fileNames.get(photoId) ?? null,
      models: Object.fromEntries(MODELS.map((model) => [model.id, prepared.get(`${model.id}::${photoId}`)?.stat ?? null])),
    })),
  });

  console.log("\n=== normalization summary ===");
  for (const entry of summary) console.log(JSON.stringify(entry));
  console.log(`cross-model Pearson r after forcing NEAR=BRIGHT: mean ${finiteR.length ? meanOf(finiteR).toFixed(3) : "n/a"} over ${finiteR.length} photos (min ${finiteR.length ? Math.min(...finiteR).toFixed(3) : "n/a"})`);
  console.log(`Conventions/stats -> ${conventionsPath}`);
  console.log("Next: npm run parallax:compare");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
