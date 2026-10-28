import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MODELS,
  benchDir,
  comparePath,
  depthReadyDir,
  exists,
  inputDir,
  keyPath,
  readJson,
  resultsPath,
  writeJson,
} from "./parallaxShared.js";

// Builds the blind A/B review page:
//   npm run parallax:compare
// Writes key.json (the ONLY place the A/B -> model mapping exists; never embedded in the page) and a
// single offline compare.html that references the local JPG/PNG files by relative path.
//
// One WebGL context for the whole page. Chrome retires after roughly 16 live contexts, so a per-card
// context (20 cards) silently loses contexts and the page never finishes loading. Here a single canvas
// element is moved into whichever card is active; only that photo's image + two depth maps become
// textures, and they are deleted when another card takes over. Static previews are plain lazy <img>s.

const DEFAULT_SEED = 20261027;

/** mulberry32: small deterministic PRNG so a re-run with the same seed reproduces the exact blind mapping. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VERTEX_SRC = [
  "attribute vec2 aPos;",
  "varying vec2 v;",
  "void main() {",
  "  v = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);",
  "  gl_Position = vec4(aPos, 0.0, 1.0);",
  "}",
].join("\n");

// Exactly the fragment shader from the brief (three depth-reweighted displacement passes).
const FRAGMENT_SRC = [
  "precision highp float;",
  "varying vec2 v;",
  "uniform sampler2D img;",
  "uniform sampler2D dep;",
  "uniform vec2 tilt;",
  "uniform float str;",
  "uniform float focus;",
  "uniform vec4 crop;",
  "void main() {",
  "  vec2 uv=crop.xy+v*crop.zw; float d=texture2D(dep,uv).r; vec2 off=tilt*(d-focus)*str;",
  "  d=texture2D(dep,uv+off).r; off=tilt*(d-focus)*str; d=texture2D(dep,uv+off).r; off=tilt*(d-focus)*str;",
  "  gl_FragColor=texture2D(img,uv+off);",
  "}",
].join("\n");

const STRENGTH_SCALE = 0.065;
const FOCUS = 0.42;
const SAFETY_MARGIN = 0.05; // crop inset so displacement never reveals out-of-frame edges
const PHONE_ASPECT = 9 / 16;
const PREVIEW_LONGEST = 384; // downscaled, lazily loaded static previews (textures load on activation)

type PhotoPayload = {
  id: string;
  file: string;
  input: string;
  depthA: string;
  depthB: string;
  width: number;
  height: number;
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const seedIndex = argv.indexOf("--seed");
  const seed = seedIndex >= 0 && argv[seedIndex + 1] ? Number(argv[seedIndex + 1]) : DEFAULT_SEED;
  if (!Number.isFinite(seed)) throw new Error("--seed must be a number");

  const [firstModel, secondModel] = MODELS;
  if (!firstModel || !secondModel) throw new Error("Expected exactly two models in MODELS");

  const photoIds = (await readdir(inputDir))
    .filter((name) => name.toLowerCase().endsWith(".jpg"))
    .map((name) => path.parse(name).name)
    .sort();
  if (photoIds.length === 0) throw new Error("No inputs — run npm run parallax:depth first.");

  const rows = await readJson<Array<{ photoId: string; file: string; width?: number | null; height?: number | null }>>(resultsPath, []);
  const byId = new Map<string, { file: string; width: number | null; height: number | null }>();
  for (const row of rows) {
    if (!byId.has(row.photoId)) byId.set(row.photoId, { file: row.file, width: row.width ?? null, height: row.height ?? null });
  }

  const readyPath = (modelId: string, photoId: string): string => path.join(depthReadyDir, modelId, `${photoId}.png`);

  // The page must stay blind, so the ready maps are re-published under neutral slot names — a path like
  // depth-ready/marigold-v2/p01.png would hand the evaluator the answer key.
  const abDir = path.join(benchDir, "ab");
  const slotPath = (photoId: string, slot: "A" | "B"): string => path.join(abDir, photoId, `${slot}.png`);
  const slotUrl = (photoId: string, slot: "A" | "B"): string => path.relative(benchDir, slotPath(photoId, slot)).replace(/\\/g, "/");

  const rng = mulberry32(seed);
  const key: { seed: number; generatedAt: string; note: string; photos: { photoId: string; slotA: string; slotB: string }[] } = {
    seed,
    generatedAt: new Date().toISOString(),
    note: "Blind A/B mapping. slotA/slotB are the model ids shown in the page's A/B slots. Do not open this file while rating; it is never embedded in compare.html.",
    photos: [],
  };

  const photos: PhotoPayload[] = [];
  const skipped: string[] = [];
  for (const photoId of photoIds) {
    const depthA = rng() < 0.5 ? firstModel.id : secondModel.id;
    const depthB = depthA === firstModel.id ? secondModel.id : firstModel.id;
    key.photos.push({ photoId, slotA: depthA, slotB: depthB });
    const aSource = readyPath(depthA, photoId);
    const bSource = readyPath(depthB, photoId);
    if (!(await exists(aSource)) || !(await exists(bSource))) {
      skipped.push(photoId);
      continue;
    }
    await mkdir(path.dirname(slotPath(photoId, "A")), { recursive: true });
    await copyFile(aSource, slotPath(photoId, "A"));
    await copyFile(bSource, slotPath(photoId, "B"));
    const meta = byId.get(photoId);
    photos.push({
      id: photoId,
      file: meta?.file ?? photoId,
      input: path.relative(benchDir, path.join(inputDir, `${photoId}.jpg`)).replace(/\\/g, "/"),
      depthA: slotUrl(photoId, "A"),
      depthB: slotUrl(photoId, "B"),
      width: meta?.width ?? 0,
      height: meta?.height ?? 0,
    });
  }
  // The key must describe only what the page actually shows, so ratings always join cleanly.
  key.photos = key.photos.filter((entry) => photos.some((photo) => photo.id === entry.photoId));

  await mkdir(benchDir, { recursive: true });
  await writeJson(keyPath, key);
  await writeFile(
    comparePath,
    renderHtml({ photos, seed, vertex: VERTEX_SRC, fragment: FRAGMENT_SRC, strengthScale: STRENGTH_SCALE, focus: FOCUS, margin: SAFETY_MARGIN, phoneAspect: PHONE_ASPECT, previewLongest: PREVIEW_LONGEST }),
    "utf8",
  );

  console.log(`Blind key (seed ${seed}) -> ${keyPath}`);
  console.log(`Compare page (${photos.length} photos) -> ${comparePath}`);
  if (skipped.length > 0) console.log(`!! skipped photos without both ready depth maps: ${skipped.join(", ")}`);
  console.log("Open the page in a browser, rate A/B blind, Export ratings, then: python out/parallax-bench/score.py");
}

type PageData = {
  photos: PhotoPayload[];
  seed: number;
  vertex: string;
  fragment: string;
  strengthScale: number;
  focus: number;
  margin: number;
  phoneAspect: number;
  previewLongest: number;
};

/**
 * Emits a self-contained page. The client code deliberately avoids backticks and ${} so it can live in
 * one template literal here; model names never appear in the payload — only the A/B slot paths do.
 */
function renderHtml(data: PageData): string {
  const payload = JSON.stringify({
    photos: data.photos,
    vertex: data.vertex,
    fragment: data.fragment,
    strengthScale: data.strengthScale,
    focus: data.focus,
    margin: data.margin,
    phoneAspect: data.phoneAspect,
  });

  const client = [
    "var DATA = JSON.parse(document.getElementById('bench-data').textContent);",
    "var RATINGS_KEY = 'parallax-ratings-v1';",
    "",
    "function loadRatings() { try { return JSON.parse(localStorage.getItem(RATINGS_KEY) || '{}'); } catch (e) { return {}; } }",
    "function saveRatings(all) { localStorage.setItem(RATINGS_KEY, JSON.stringify(all)); updateProgress(); }",
    "var ratings = loadRatings();",
    "",
    "function esc(value) { var text = String(value == null ? '' : value); text = text.split('&').join('&amp;'); text = text.split('<').join('&lt;'); text = text.split('>').join('&gt;'); return text.split(String.fromCharCode(34)).join('&quot;'); }",
    "function csvCell(value) { var text = String(value == null ? '' : value); var q = String.fromCharCode(34); if (text.indexOf(q) >= 0 || text.indexOf(',') >= 0 || text.indexOf('\\n') >= 0 || text.indexOf('\\r') >= 0) { return q + text.split(q).join(q + q) + q; } return text; }",
    "function status(message) { var el = document.getElementById('gl-status'); if (el) el.textContent = message; }",
    "function sizeOf(photo, longest) {",
    "  var w = photo.width || longest, h = photo.height || Math.round(longest * 0.66);",
    "  var k = longest / Math.max(w, h);",
    "  return ' width=\"' + Math.round(w * k) + '\" height=\"' + Math.round(h * k) + '\"';",
    "}",
    "",
    "// ------------------------------------------------------------------ shared viewer",
    "// Exactly one canvas and one WebGL context exist for the whole page. The canvas element itself is",
    "// moved into the active card's .viewer slot, so switching cards never creates another context.",
    "var canvas = document.createElement('canvas');",
    "canvas.id = 'glcanvas';",
    "canvas.style.display = 'none';",
    "document.body.appendChild(canvas);",
    "",
    "var gl = null, program = null, buffer = null, uniforms = null;",
    "var view = null;            // the card currently hosting the canvas",
    "var lastPhoto = null;       // what to reload after a context restore",
    "var textures = null;",
    "var loadToken = 0, lost = false;",
    "var emptyTex = new Uint8Array([0, 0, 0, 255]);",
    "",
    "function makeTexture() {",
    "  var object = gl.createTexture();",
    "  gl.bindTexture(gl.TEXTURE_2D, object);",
    "  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);",
    "  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);",
    "  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);",
    "  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);",
    "  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, emptyTex);",
    "  return object;",
    "}",
    "",
    "function bindTexture(object, image) {",
    "  gl.bindTexture(gl.TEXTURE_2D, object);",
    "  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);",
    "}",
    "",
    "function dropTextures() {",
    "  if (gl && textures) {",
    "    if (textures.A) gl.deleteTexture(textures.A);",
    "    if (textures.B) gl.deleteTexture(textures.B);",
    "    if (textures.img) gl.deleteTexture(textures.img);",
    "  }",
    "  textures = null;",
    "  if (view) { view.ready = false; }",
    "}",
    "",
    "// Async-safe load: a token makes stale callbacks from the previous card harmless.",
    "function loadTextures(photo) {",
    "  loadToken++;",
    "  var token = loadToken;",
    "  dropTextures();",
    "  if (!gl || lost) return;",
    "  var owner = view;",
    "  textures = { A: makeTexture(), B: makeTexture(), img: makeTexture() };",
    "  var targets = [",
    "    [photo.depthA, textures.A, null],",
    "    [photo.depthB, textures.B, null],",
    "    [photo.input, textures.img, 'image']",
    "  ];",
    "  var left = targets.length;",
    "  var failed = false;",
    "  targets.forEach(function (target) {",
    "    var image = new Image();",
    "    image.onload = function () {",
    "      if (token !== loadToken) { gl.deleteTexture(target[1]); return; }",
    "      bindTexture(target[1], image);",
    "      if (target[2] && owner === view) {",
    "        owner.imageAspect = image.naturalWidth / image.naturalHeight;",
    "        layout();",
    "      }",
    "      if (--left === 0) {",
    "        if (failed) {",
    "          status('Could not load the image files for this card (if the address starts with file://, serve this folder over http, e.g. npx serve .)');",
    "        } else if (owner === view) {",
    "          owner.ready = true;",
    "          syncLabel();",
    "        }",
    "      }",
    "    };",
    "    image.onerror = function () {",
    "      if (token !== loadToken) return;",
    "      failed = true;",
    "      if (--left === 0 && owner === view) { dropTextures(); syncLabel(); }",
    "    };",
    "    image.src = target[0];",
    "  });",
    "}",
    "",
    "function initGl() {",
    "  gl = canvas.getContext('webgl', { preserveDrawingBuffer: false, antialias: true, alpha: false });",
    "  if (!gl) { status('WebGL is unavailable in this browser — previews and the rating form still work.'); return false; }",
    "  function shader(type, source) {",
    "    var object = gl.createShader(type);",
    "    gl.shaderSource(object, source);",
    "    gl.compileShader(object);",
    "    if (!gl.getShaderParameter(object, gl.COMPILE_STATUS)) { status('Shader error: ' + gl.getShaderInfoLog(object)); return null; }",
    "    return object;",
    "  }",
    "  var vs = shader(gl.VERTEX_SHADER, DATA.vertex);",
    "  var fs = shader(gl.FRAGMENT_SHADER, DATA.fragment);",
    "  if (!vs || !fs) { gl = null; return false; }",
    "  program = gl.createProgram();",
    "  gl.attachShader(program, vs);",
    "  gl.attachShader(program, fs);",
    "  gl.linkProgram(program);",
    "  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { status('Link error: ' + gl.getProgramInfoLog(program)); gl = null; program = null; return false; }",
    "  gl.useProgram(program);",
    "  buffer = gl.createBuffer();",
    "  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);",
    "  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);",
    "  var attribute = gl.getAttribLocation(program, 'aPos');",
    "  gl.enableVertexAttribArray(attribute);",
    "  gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);",
    "  uniforms = {",
    "    img: gl.getUniformLocation(program, 'img'),",
    "    dep: gl.getUniformLocation(program, 'dep'),",
    "    tilt: gl.getUniformLocation(program, 'tilt'),",
    "    str: gl.getUniformLocation(program, 'str'),",
    "    focus: gl.getUniformLocation(program, 'focus'),",
    "    crop: gl.getUniformLocation(program, 'crop')",
    "  };",
    "  return true;",
    "}",
    "",
    "// Crop rect in image UV. A region of w*imgW by h*imgH pixels fills the canvas without distortion",
    "// when w/h == viewportAspect/imageAspect; it is centred, then inset by the safety margin so the",
    "// parallax displacement can never reveal pixels outside the frame.",
    "function cropRect(viewportAspect, imageAspect, margin) {",
    "  var ratio = viewportAspect / (imageAspect || viewportAspect);",
    "  var width = ratio >= 1 ? 1 : ratio, height = ratio >= 1 ? 1 / ratio : 1;",
    "  var left = (1 - width) / 2, top = (1 - height) / 2;",
    "  var insetX = width * margin, insetY = height * margin;",
    "  return [left + insetX / 2, top + insetY / 2, width - insetX, height - insetY];",
    "}",
    "",
    "function layout() {",
    "  if (!view || !view.slot) return;",
    "  var wrapWidth = view.el.clientWidth;",
    "  var aspect = view.phone ? DATA.phoneAspect : (view.imageAspect || 0.75);",
    "  var height = Math.min(560, Math.max(180, Math.round(wrapWidth / aspect)));",
    "  var width = Math.round(height * aspect);",
    "  var ratio = window.devicePixelRatio || 1;",
    "  canvas.style.width = width + 'px';",
    "  canvas.style.height = height + 'px';",
    "  canvas.width = Math.round(width * ratio);",
    "  canvas.height = Math.round(height * ratio);",
    "  view.size = { width: width, height: height };",
    "}",
    "",
    "function activeView() { return view && canvas.parentElement === view.slot ? view : null; }",
    "",
    "function syncLabel() {",
    "  if (!view) return;",
    "  var message = 'viewer: depth ' + view.side + '  strength ' + view.strength.toFixed(2) + (view.phone ? '  9:16' : '');",
    "  if (!gl) message = '3D viewer unavailable in this browser';",
    "  else if (lost) message = '3D viewer paused - the graphics context was lost';",
    "  else if (!view.ready) message = 'loading 3D viewer...';",
    "  view.el.querySelector('.hint').textContent = message;",
    "}",
    "",
    "function syncCardChrome() {",
    "  cards.forEach(function (card) {",
    "    var on = card === view;",
    "    card.el.classList.toggle('active', on);",
    "    var button = card.el.querySelector('[data-view]');",
    "    if (button) button.hidden = on;",
    "  });",
    "}",
    "",
    "function setActive(next) {",
    "  if (!next || view === next) return;",
    "  if (!gl) { status('3D viewer unavailable in this browser - previews and ratings still work.'); return; }",
    "  if (lost) { status('The 3D viewer is paused because the graphics context was lost; it comes back automatically when the tab is reloaded.'); return; }",
    "  var previous = view;",
    "  view = next;",
    "  dropTextures();",
    "  next.slot.appendChild(canvas);",
    "  layout();",
    "  canvas.style.display = 'block';",
    "  next.tilt = { x: 0, y: 0 };",
    "  next.dragging = false;",
    "  next.ready = false;",
    "  syncCardChrome();",
    "  syncLabel();",
    "  if (previous && previous !== next) previous.el.querySelector('.hint').textContent = previewHint(previous);",
    "  lastPhoto = next.photo;",
    "  loadTextures(next.photo);",
    "}",
    "",
    "function previewHint(card) {",
    "  return 'press View 3D (or click this card) to open the live viewer here';",
    "}",
    "",
    "function draw(time) {",
    "  if (!gl || lost || !view || view !== activeView() || !view.ready || !textures) return;",
    "  var size = view.size;",
    "  if (!size) return;",
    "  if (view.dragging) { view.target = view.dragTilt || view.target; }",
    "  else {",
    "    var phase = time / 1000;",
    "    view.target = { x: Math.sin(phase * 0.7), y: Math.cos(phase * 0.45) * 0.5 };",
    "  }",
    "  view.tilt.x += (view.target.x - view.tilt.x) * 0.08;",
    "  view.tilt.y += (view.target.y - view.tilt.y) * 0.08;",
    "  var depth = view.side === 'A' ? textures.A : textures.B;",
    "  gl.viewport(0, 0, canvas.width, canvas.height);",
    "  gl.useProgram(program);",
    "  gl.activeTexture(gl.TEXTURE0);",
    "  gl.bindTexture(gl.TEXTURE_2D, textures.img);",
    "  gl.uniform1i(uniforms.img, 0);",
    "  gl.activeTexture(gl.TEXTURE1);",
    "  gl.bindTexture(gl.TEXTURE_2D, depth);",
    "  gl.uniform1i(uniforms.dep, 1);",
    "  gl.uniform2f(uniforms.tilt, view.tilt.x * 0.5, view.tilt.y * 0.5);",
    "  gl.uniform1f(uniforms.str, DATA.strengthScale * view.strength);",
    "  gl.uniform1f(uniforms.focus, DATA.focus);",
    "  var crop = cropRect(size.width / size.height, view.imageAspect, DATA.margin);",
    "  gl.uniform4f(uniforms.crop, crop[0], crop[1], crop[2], crop[3]);",
    "  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);",
    "}",
    "",
    "// ------------------------------------------------------------------ card markup + ratings",
    "var cards = [];",
    "",
    "function makeCard(photo, index) {",
    "  var card = { photo: photo, side: 'A', strength: 1, phone: false, tilt: { x: 0, y: 0 }, target: { x: 0, y: 0 }, dragging: false, dragTilt: null, ready: false };",
    "  var wrap = document.createElement('section');",
    "  wrap.className = 'card';",
    "  wrap.innerHTML =",
    "    '<h3>' + (index + 1) + '. ' + esc(photo.id) + '</h3>' +",
    "    '<p class=\"file\">' + esc(photo.file) + '</p>' +",
    "    '<div class=\"strip\">' +",
    "      '<figure><img loading=\"lazy\" decoding=\"async\" alt=\"original ' + esc(photo.id) + '\"' + sizeOf(photo, DATA.previewLongest) + ' src=\"' + esc(photo.input) + '\"></figure>' +",
    "      '<figure><figcaption>depth A</figcaption><img loading=\"lazy\" decoding=\"async\" alt=\"depth A ' + esc(photo.id) + '\"' + sizeOf(photo, DATA.previewLongest) + ' src=\"' + esc(photo.depthA) + '\"></figure>' +",
    "      '<figure><figcaption>depth B</figcaption><img loading=\"lazy\" decoding=\"async\" alt=\"depth B ' + esc(photo.id) + '\"' + sizeOf(photo, DATA.previewLongest) + ' src=\"' + esc(photo.depthB) + '\"></figure>' +",
    "    '</div>' +",
    "    '<div class=\"viewer\" data-view><button type=\"button\" class=\"view\">View 3D</button><div class=\"hint\"></div></div>' +",
    "    '<div class=\"controls\">' +",
    "      '<div class=\"seg\"><button type=\"button\" data-side=\"A\" class=\"on\">A</button><button type=\"button\" data-side=\"B\">B</button></div>' +",
    "      '<label class=\"row\">strength <input type=\"range\" min=\"0\" max=\"2\" step=\"0.05\" value=\"1\"><output>1.00</output></label>' +",
    "      '<label class=\"row\"><input type=\"checkbox\" data-phone> 9:16 phone crop</label>' +",
    "      '<p class=\"tip\">Viewer opens inside this card. Drag on it to look around; release resumes the auto-sway.</p>' +",
    "    '</div>' +",
    "    '<div class=\"rates\"></div>';",
    "  card.el = wrap;",
    "  card.slot = wrap.querySelector('.viewer');",
    "  return card;",
    "}",
    "",
    "function ratingBlock(card) {",
    "  var holder = card.el.querySelector('.rates');",
    "  var labels = [ ['edges', 'Edges/fur'], ['background', 'Background stability'], ['overall', 'Would use as wallpaper'] ];",
    "  var html = '';",
    "  ['A', 'B'].forEach(function (side) {",
    "    html += '<fieldset><legend>Depth ' + side + '</legend>';",
    "    labels.forEach(function (pair) {",
    "      html += '<div class=\"crit\"><span>' + pair[1] + '</span>';",
    "      for (var value = 1; value <= 5; value++) {",
    "        var checked = ratings[card.photo.id] && ratings[card.photo.id][side] && ratings[card.photo.id][side][pair[0]] === value ? ' checked' : '';",
    "        html += '<label class=\"star\"><input type=\"radio\" name=\"' + esc(card.photo.id) + '-' + side + '-' + pair[0] + '\" value=\"' + value + '\"' + checked + '>' + value + '</label>';",
    "      }",
    "      html += '</div>';",
    "    });",
    "    html += '</fieldset>';",
    "  });",
    "  var comment = ratings[card.photo.id] && ratings[card.photo.id].comment ? ratings[card.photo.id].comment : '';",
    "  html += '<label class=\"comment\">Comment <textarea rows=\"2\" placeholder=\"e.g. fur edge on A frays, B keeps the background still\">' + esc(comment) + '</textarea></label>';",
    "  holder.innerHTML = html;",
    "}",
    "",
    "// One delegated listener set for every card: the controls stay per-card (each card remembers its own",
    "// A/B side, strength and crop) while only the canvas is shared.",
    "function bindGrid() {",
    "  var grid = document.getElementById('grid');",
    "  function cardOf(target) {",
    "    var el = target && target.closest ? target.closest('.card') : null;",
    "    return el ? el.__card : null;",
    "  }",
    "  grid.addEventListener('click', function (event) {",
    "    var target = event.target;",
    "    if (target.nodeType === 3) target = target.parentElement;",
    "    var card = cardOf(target);",
    "    if (!card) return;",
    "    if (target.closest('.rates')) return;",
    "    var button = target.closest('button');",
    "    if (button && button.dataset.side) { selectSide(card, button.dataset.side); return; }",
    "    setActive(card);",
    "  });",
    "  grid.addEventListener('input', function (event) {",
    "    var card = cardOf(event.target);",
    "    if (!card) return;",
    "    if (event.target.type === 'range') setStrength(card, event.target);",
    "    else if (event.target.tagName === 'TEXTAREA') saveComment(card, event.target.value);",
    "  });",
    "  grid.addEventListener('change', function (event) {",
    "    var card = cardOf(event.target);",
    "    if (!card) return;",
    "    if (event.target.matches('[data-phone]')) { setPhone(card, event.target.checked); return; }",
    "    if (event.target.type === 'radio') saveRating(card, event.target);",
    "  });",
    "}",
    "",
    "function selectSide(card, side) {",
    "  card.side = side;",
    "  card.el.querySelectorAll('.seg button').forEach(function (button) { button.classList.toggle('on', button.dataset.side === side); });",
    "  syncDepthPreview(card);",
    "  if (card === view) syncLabel();",
    "}",
    "",
    "function syncDepthPreview(card) {",
    "  card.el.querySelectorAll('.strip figure').forEach(function (figure, index) {",
    "    if (index === 0) return;",
    "    figure.classList.toggle('dim', (index === 1 ? 'A' : 'B') !== card.side);",
    "  });",
    "}",
    "",
    "function setStrength(card, slider) {",
    "  card.strength = Number(slider.value);",
    "  var output = card.el.querySelector('output');",
    "  if (output) output.textContent = card.strength.toFixed(2);",
    "  if (card === view) syncLabel();",
    "}",
    "",
    "function setPhone(card, on) {",
    "  card.phone = on;",
    "  if (card === view) { layout(); syncLabel(); }",
    "}",
    "",
    "function saveRating(card, input) {",
    "  var parts = (input.name || '').split('-');",
    "  if (parts.length < 3) return;",
    "  var side = parts[parts.length - 2];",
    "  var criterion = parts[parts.length - 1];",
    "  var record = ratings[card.photo.id] = ratings[card.photo.id] || {};",
    "  var sideRecord = record[side] = record[side] || {};",
    "  sideRecord[criterion] = Number(input.value);",
    "  saveRatings(ratings);",
    "}",
    "",
    "function saveComment(card, value) {",
    "  var record = ratings[card.photo.id] = ratings[card.photo.id] || {};",
    "  if (record.comment === value) return;",
    "  record.comment = value;",
    "  saveRatings(ratings);",
    "}",
    "",
    "// ------------------------------------------------------------------ drag on the single canvas",
    "function pointOf(event) {",
    "  var rect = canvas.getBoundingClientRect();",
    "  var x = (event.touches ? event.touches[0].clientX : event.clientX) - rect.left;",
    "  var y = (event.touches ? event.touches[0].clientY : event.clientY) - rect.top;",
    "  return { x: (x / rect.width) * 2 - 1, y: (y / rect.height) * 2 - 1 };",
    "}",
    "",
    "function startDrag(event) {",
    "  if (!view || lost) return;",
    "  var wasActive = canvas.parentElement === view.slot;",
    "  view.dragging = true;",
    "  moveDrag(event, wasActive);",
    "  if (!wasActive) setActive(view);",
    "}",
    "",
    "function moveDrag(event, forced) {",
    "  if (!view || !view.dragging) return;",
    "  var p = pointOf(event);",
    "  view.dragTilt = { x: Math.max(-1, Math.min(1, p.x)), y: Math.max(-1, Math.min(1, p.y)) };",
    "  if (forced !== false) event.preventDefault();",
    "}",
    "",
    "function endDrag() {",
    "  if (view) view.dragging = false;",
    "}",
    "",
    "canvas.addEventListener('mousedown', startDrag);",
    "canvas.addEventListener('touchstart', startDrag, { passive: false });",
    "canvas.addEventListener('touchmove', function (event) { moveDrag(event); }, { passive: false });",
    "window.addEventListener('mousemove', function (event) { moveDrag(event, false); });",
    "window.addEventListener('mouseup', endDrag);",
    "window.addEventListener('touchend', endDrag);",
    "",
    "// ------------------------------------------------------------------ context loss / restore",
    "canvas.addEventListener('contextlost', function (event) {",
    "  event.preventDefault();",
    "  lost = true;",
    "  if (view) view.ready = false;",
    "  status('The graphics context was lost (too many WebGL apps in this tab?). The 3D viewer pauses; previews and ratings keep working.');",
    "  if (view) syncLabel();",
    "});",
    "canvas.addEventListener('contextrestored', function () {",
    "  lost = false;",
    "  status('');",
    "  if (initGl()) {",
    "    if (view && lastPhoto) { layout(); loadTextures(lastPhoto); syncLabel(); }",
    "    status('');",
    "  } else {",
    "    status('Could not recreate the WebGL context after it was lost.');",
    "  }",
    "});",
    "",
    "// ------------------------------------------------------------------ ratings export",
    "function updateProgress() {",
    "  var done = Object.keys(ratings).filter(function (id) { var record = ratings[id]; return record.A && record.B && record.A.overall && record.B.overall; }).length;",
    "  document.getElementById('progress').textContent = done + ' / ' + DATA.photos.length + ' rated';",
    "}",
    "",
    "function exportCsv() {",
    "  var lines = ['photo,side,edges,background,overall,comment'];",
    "  DATA.photos.forEach(function (photo) {",
    "    var record = ratings[photo.id] || {};",
    "    ['A', 'B'].forEach(function (side) {",
    "      var entry = record[side] || {};",
    "      lines.push([csvCell(photo.id), side, csvCell(entry.edges || ''), csvCell(entry.background || ''), csvCell(entry.overall || ''), csvCell(record.comment || '')].join(','));",
    "    });",
    "  });",
    "  var blob = new Blob([lines.join('\\r\\n')], { type: 'text/csv;charset=utf-8' });",
    "  var link = document.createElement('a');",
    "  link.href = URL.createObjectURL(blob);",
    "  link.download = 'ratings.csv';",
    "  document.body.appendChild(link);",
    "  link.click();",
    "  document.body.removeChild(link);",
    "}",
    "",
    "function applyAll(action) {",
    "  cards.forEach(function (card) {",
    "    if (action === 'A' || action === 'B') { selectSide(card, action); }",
    "    if (action === 'phone') {",
    "      var box = card.el.querySelector('[data-phone]');",
    "      setPhone(card, !card.phone);",
    "      box.checked = card.phone;",
    "    }",
    "  });",
    "}",
    "",
    "function frame(time) {",
    "  draw(time);",
    "  requestAnimationFrame(frame);",
    "}",
    "",
    "function boot() {",
    "  var grid = document.getElementById('grid');",
    "  DATA.photos.forEach(function (photo, index) {",
    "    var card = makeCard(photo, index);",
    "    grid.appendChild(card.el);",
    "    cards.push(card);",
    "  });",
    "  cards.forEach(function (card) {",
    "    card.el.__card = card;",
    "    syncDepthPreview(card);",
    "    card.el.querySelector('.hint').textContent = previewHint(card);",
    "    ratingBlock(card);",
    "  });",
    "  bindGrid();",
    "  document.getElementById('export').addEventListener('click', exportCsv);",
    "  ['A', 'B', 'phone'].forEach(function (action) {",
    "    var button = document.getElementById('all-' + action);",
    "    if (button) button.addEventListener('click', function () { applyAll(action); });",
    "  });",
    "  window.addEventListener('resize', function () { if (view) layout(); });",
    "  updateProgress();",
    "  if (initGl()) setActive(cards[0]);",
    "  requestAnimationFrame(frame);",
    "}",
    "",
    "boot();",
  ];

  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<meta name=\"robots\" content=\"noindex,nofollow\">",
    "<title>Parallax depth A/B (blind)</title>",
    "<style>",
    ":root { color-scheme: dark; }",
    "body { margin: 0; padding: 16px; background: #101214; color: #e8eaed; font: 14px/1.45 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; }",
    "h1 { font-size: 20px; margin: 0 0 4px; }",
    "h3 { font-size: 15px; margin: 0; }",
    ".lede { margin: 0 0 14px; }",
    ".note { color: #9aa0a6; font-size: 12px; max-width: 980px; }",
    ".toolbar { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 0; margin-bottom: 10px; background: rgba(16,18,20,.96); border-bottom: 1px solid #2a2e33; }",
    "#gl-status { color: #e6a23c; font-size: 12px; flex-basis: 100%; min-height: 15px; }",
    "button { background: #2b333c; color: #e8eaed; border: 1px solid #3c4652; border-radius: 8px; padding: 6px 10px; font: inherit; cursor: pointer; }",
    "button:hover { background: #384350; }",
    "#export { background: #1d5b34; border-color: #2b7a46; }",
    "#grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(680px, 1fr)); gap: 16px; }",
    ".card { background: #171a1d; border: 1px solid #2a2e33; border-radius: 12px; padding: 12px; }",
    ".card.active { border-color: #2f6fb3; box-shadow: 0 0 0 1px #2f6fb3 inset; }",
    ".file { margin: 0 0 8px; color: #9aa0a6; font-size: 12px; word-break: break-all; }",
    ".strip { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 10px; }",
    ".strip figure { margin: 0; }",
    ".strip figcaption { font-size: 11px; color: #9aa0a6; margin-bottom: 4px; }",
    ".strip img { width: 100%; height: 132px; object-fit: contain; background: #000; border: 1px solid #2a2e33; border-radius: 8px; display: block; }",
    ".strip .dim { opacity: .32; }",
    ".viewer { min-height: 84px; border: 1px dashed #2a2e33; border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }",
    ".viewer canvas { display: block; border-radius: 10px; background: #000; cursor: grab; touch-action: none; }",
    ".card.active .viewer { border-style: solid; border-color: #2f6fb3; }",
    ".hint { font-size: 12px; color: #9aa0a6; margin: 0; min-height: 16px; }",
    ".controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-top: 6px; }",
    ".seg { display: inline-flex; border: 1px solid #3c4652; border-radius: 8px; overflow: hidden; }",
    ".seg button { border: 0; border-radius: 0; min-width: 42px; }",
    ".seg button.on { background: #2f6fb3; }",
    ".row { display: inline-flex; gap: 6px; align-items: center; }",
    "input[type=range] { width: 130px; }",
    "output { font-variant-numeric: tabular-nums; min-width: 34px; display: inline-block; }",
    ".tip { flex-basis: 100%; margin: 0; font-size: 11px; color: #7f8790; }",
    ".rates { margin-top: 10px; }",
    ".rates fieldset { border: 1px solid #2a2e33; border-radius: 10px; margin: 0 0 8px; padding: 8px 10px; display: inline-block; min-width: 320px; }",
    ".rates legend { font-size: 12px; color: #9aa0a6; padding: 0 4px; }",
    ".crit { display: flex; align-items: center; gap: 6px; font-size: 12px; margin: 3px 0; }",
    ".crit > span { width: 168px; color: #c8ccd1; }",
    ".star { display: inline-flex; align-items: center; gap: 2px; margin-right: 4px; }",
    ".comment { display: block; font-size: 12px; color: #c8ccd1; }",
    "textarea { width: 100%; box-sizing: border-box; background: #0f1214; color: #e8eaed; border: 1px solid #2a2e33; border-radius: 8px; padding: 6px; font: inherit; }",
    "</style>",
    "</head>",
    "<body>",
    "<h1>Parallax depth maps &mdash; blind A/B</h1>",
    "<p class=\"lede\">Same photo, same input size, two depth models. Which side is which is hidden until you score every card.</p>",
    "<div class=\"toolbar\">",
    "  <span id=\"progress\" class=\"note\"></span>",
    "  <button id=\"all-A\" type=\"button\">all &rarr; A</button>",
    "  <button id=\"all-B\" type=\"button\">all &rarr; B</button>",
    "  <button id=\"all-phone\" type=\"button\">toggle 9:16 all</button>",
    "  <button id=\"export\" type=\"button\">Export ratings (ratings.csv)</button>",
    "  <span id=\"gl-status\"></span>",
    "</div>",
    "<div id=\"grid\"></div>",
    "<p class=\"note\">One 3D viewer is shared by the whole page: press <em>View 3D</em> (or click a card) to open it inside that card, and it loads only that photo plus its two depth maps. Ratings are kept in this browser (localStorage), so a reload keeps them. The A/B mapping lives only in key.json &mdash; open it after you finish. If the viewer stays black, your browser is blocking file:// textures: run a local server in this folder (for example <code>npx serve .</code>) and open compare.html through it.</p>",
    "<script id=\"bench-data\" type=\"application/json\">" + payload.replace(/</g, "\\u003c") + "</script>",
    "<script>",
    client.join("\n"),
    "</script>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
