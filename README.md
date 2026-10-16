# Pet video benchmark

Standalone Node.js/TypeScript runner. It crops pet photos to portrait 9:16, uploads each crop once to fal storage, submits one job per enabled model/preset/variant, normalizes standard successful videos to 90 frames at 30 fps (3 seconds), and writes `out/report.csv` plus `out/index.html`. The `_v3` presets request and preserve their full 6-second duration; `_v4` presets preserve their full 5-second duration; `_s2` presets preserve their full 4-second duration. Presets ending in `_pp` are post-processed with the same pingpong transform used by `loopfix`.

## Requirements

- Node.js 20 or newer
- `npm install` downloads a platform-specific ffmpeg binary with `libx264` and the `ssim` filter
- A fal.ai key in this folder's ignored `.env` file for real runs
- Add input images to `photos/` (`jpg`, `jpeg`, `png`, `webp`, or `bmp`)

Copy `.env.example` to `.env` and set `FAL_KEY`. The key is not printed by the runner. Keep photos and output local; `.gitignore` excludes `photos/`, `out/`, `.env`, dependencies, and build output.

Optional `photos/focus.json` uses input filename or basename keys, with normalized focus coordinates:

```json
{
  "milo.jpg": { "x": 0.62, "y": 0.43 }
}
```

Coordinates are in the source image's oriented coordinate space, from 0 to 1. If omitted, crop is centered.

## fal API fields

The request fields below are taken from each endpoint's published OpenAPI schema. Optional fields not listed are omitted.

| Model | Request fields used | Cost duration |
| --- | --- | --- |
| Kling O3 Standard | `image_url`, `prompt`, `duration: "4"` (or `"6"` for `_v3` and `"5"` for `_v4` presets), `generate_audio: false`; loop variant also sets `end_image_url` to the same cropped image | 4 s (or 6 s for `_v3` and 5 s for `_v4`) |
| Kling O3 Pro | `image_url`, `prompt`, `duration: "3"`, `generate_audio: false`; loop variant also sets `end_image_url` | 3 s |
| Happy Horse | `image_url`, `prompt`, `duration: 3`, `resolution: "720p"` | 3 s |
| Seedance 2.0 | `image_url`, `prompt`, `duration: "4"`, `resolution: "720p"`, `generate_audio: false`, `aspect_ratio: "9:16"`; loop variant also sets `end_image_url` to the same cropped image | 4 s ($0.3024/s; `_s2` presets preserve all 4 s) |
| Grok Imagine | Disabled. Its schema has `image_url`, `prompt`, integer `duration`, `resolution`, and `aspect_ratio`, but documents no supported duration range. Set a verified duration in `models.ts` before enabling. | Not estimated while disabled |

Kling O3 Standard, Kling O3 Pro, and Happy Horse have no `resolution` or `aspect_ratio` input fields; they receive the 9:16 crop as their start image. Happy Horse has no `generate_audio` or `end_image_url` field, so it has no loop run; any generated audio is discarded from the final clip. `_pp` presets do not request an end frame and instead use the existing pingpong post-process. Failed jobs record the error message and status in the report. All final MP4s have no audio regardless of model support. Prices and durations live in `models.ts`; a failed/blocked request may still incur charges, so report costs are estimates based on requested generation seconds.

Schema references: [Kling O3 Pro](https://fal.ai/models/fal-ai/kling-video/o3/pro/image-to-video/api), [Happy Horse](https://fal.ai/models/alibaba/happy-horse/image-to-video/api), [Seedance 2.0](https://fal.ai/models/bytedance/seedance-2.0/image-to-video/api), [Grok Imagine](https://fal.ai/models/xai/grok-imagine-video/image-to-video/api).

## Commands

Run from `tools/pet-benchmark`:

```powershell
npm install
npm run benchmark -- --dry-run --limit 2
npm run benchmark -- --dry-run --limit 1 --models kling-o3-pro
npm run benchmark -- --yes --limit 3 --max-usd 6
npm run recover -- kling-o3-pro <request_id> out/recovered/result.mp4
npm run loopfix -- manual --overlap 0.5
```

The dry run spends nothing and does not require `FAL_KEY`. Before a real run, copy `.env.example` to `.env` and set the key. `--max-usd` checks the estimated pending batch before submitting any requests; outputs already present are excluded from that estimate.

Useful options:

```text
--preset subtle_life|cozy_light|gentle|gentle_pp|breeze|breeze_pp|dreamy|dreamy_pp|cozy|cozy_pp|glance|glance_pp|gentle_v2|breeze_v2|cozy_v2|glance_v2|dreamy_v2|gentle_v3|breeze_v3|cozy_v3|glance_v3|dreamy_v3|breeze_v4|dreamy_v4|breeze_s2|dreamy_s2   Default: subtle_life
--loop                            Adds same-image end-frame runs where supported
--loop-only                       With --loop, create only end-frame loop jobs
--concurrency N                   Default: 3
--limit N                         Process the first N photos
--only TEXT                       Use only photos whose filename contains TEXT (case-insensitive; applied before --limit)
--models ID,ID                    Restrict jobs to the listed model ids
--photos DIR                      Default: photos
--out DIR                         Default: out
--dry-run                         Print jobs and estimate; submit nothing
--yes                             Required for real runs
--max-usd X                       Reject a batch whose estimate exceeds X
```

Existing output files are skipped. `report.csv` records requested generation seconds and estimated cost, latency, success/error, endpoint SSIM, and output path. `index.html` is a local static gallery; open it in a browser after a run.

Completed fal responses are saved as JSON in `out/raw/` with their request IDs before the video URL is parsed. If a result was not downloaded, `npm run recover -- <model_id> <request_id> <output.mp4>` fetches the existing queue result without submitting a new generation request.