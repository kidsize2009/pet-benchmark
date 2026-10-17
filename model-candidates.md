# fal.ai image-to-video candidates for A→A loop wallpapers

**Research date: 2026-10-17.** Sources are public fal.ai model pages, queue OpenAPI schemas, or the public model catalog. No API key or generation was used. A “4-second cost” is the published output price multiplied by four seconds where that duration and resolution are supported. The retry estimate is cost × 1.12; it is a planning estimate, not a fal.ai charge. Prices and features can change.

## Price comparison

Sorted by published 4-second 720p cost where available. “No 4s” means that duration is not supported; a different supported duration is shown only as a reference and is not presented as a 4-second price. 480p costs are included where the model offers that exact resolution.

| 4s 720p rank | Model / exact endpoint ID | 4s 720p base → ×1.12 | 4s 480p base → ×1.12 | End frame / A→A loop |
|---:|---|---:|---:|---|
| 1= | PixVerse V6 Transition — `fal-ai/pixverse/v6/transition` | $0.180 → $0.2016 (audio off) | Not offered; 360p/540p/720p/1080p | Supported: required `first_image_url` and `end_image_url`; fits. |
| 1= | PixVerse V6 I2V — `fal-ai/pixverse/v6/image-to-video` | $0.180 → $0.2016 (audio off) | Not offered; 360p/540p/720p/1080p | **Not supported** by this endpoint; no loop. |
| 3 | PixVerse V5 Transition — `fal-ai/pixverse/v5/transition` | No 4s; 5s at 720p costs $0.200 → $0.224 | Not offered; 360p/540p/720p/1080p | Supported: required `first_image_url` and `end_image_url`; fits, but output duration must be 5s or 8s. |
| 4 | Kling O3 Standard — `fal-ai/kling-video/o3/standard/image-to-video` | $0.336 → $0.37632 (audio off; 4s) | No selectable resolution | Supported: optional `end_image_url`; fits. |
| 5 | Seedance 2.0 Mini — `bytedance/seedance-2.0/mini/image-to-video` | $0.6188 → $0.6931 | $0.2884 → $0.3230 | Supported: optional `end_image_url`; fits. |
| 6 | Seedance 2.0 US I2V — `bytedance/seedance-2.0/us/image-to-video` | $1.2136 → $1.3592 | Not calculated; exact 480p per-second price not published | Supported: optional `end_image_url`; fits. |
| N/A | MiniMax H3 Max Turbo — `minimax/h3-max-turbo/image-to-video` | No 720p tier; 768p 4s is $0.104 → $0.11648 | $0.065 → $0.0728 (promotional rate) | Supported: optional `end_image_url`; fits. |
| N/A | MiniMax Hailuo-02 Standard — `fal-ai/minimax/hailuo-02/standard/image-to-video` | No 720p tier or 4s duration; 512p/768p and 6s/10s only | No 480p tier; 512p is approximately $0.017/s | Supported: optional `end_image_url`; fits at its supported durations. |

The PixVerse V6 audio-on 720p rate is $0.060/s ($0.240 for 4s; $0.2688 with the 1.12 retry factor), rather than the audio-off values in the table. Seedance rates are described as unchanged when audio generation is toggled. See each model’s pricing source below.

### Additional end-frame models under $0.06 per second

The three extra models below plus PixVerse V6 Transition are the additional qualifying candidates found. PixVerse V5 Transition supports end frames but has fixed durations, so a 4-second clip is unavailable.

| Model / endpoint | Published price and 4s comparison | End-frame fit |
|---|---|---|
| MiniMax Hailuo-02 Standard — `fal-ai/minimax/hailuo-02/standard/image-to-video` | Approximately $0.017/s at 512p and $0.045/s at 768p. 4s is unsupported; the schema lists 6s and 10s. | Yes, optional `end_image_url`; not a 4s option. |
| PixVerse V5 Transition — `fal-ai/pixverse/v5/transition` | $0.20 per 5s 720p video ($0.04 per generated second); 5s / $0.20 is the comparable supported clip, not a 4s clip. | Yes, required start and end images. |
| PixVerse V6 Transition — `fal-ai/pixverse/v6/transition` | 720p audio-off $0.045/s; 4s is $0.180. Audio-on is $0.060/s, not below $0.06. | Yes, required start and end images. |

The catalog also lists `fal-ai/minimax/hailuo-02-fast/image-to-video` at approximately $0.017/s and 512p, but its opened schema has no end-frame field, so it is not a loop candidate.

## Candidate details

All listed audio, field names, dimensions, duration, resolution, and price facts were checked on the linked official model page, schema, or catalog page on 2026-10-17. “Not specified” means it was not stated in the opened sources; it is not an assertion that the feature or limit does not exist.

### PixVerse V6 image-to-video

- **Endpoint:** `fal-ai/pixverse/v6/image-to-video`
- **Price:** 360p $0.025/s audio off or $0.035/s on; 540p $0.035/$0.045; 720p $0.045/$0.060; 1080p $0.090/$0.115. The model page/catalog expose those tiers; audio-off 4s 720p is $0.180. [Model page](https://fal.ai/models/fal-ai/pixverse/v6/image-to-video) · [queue schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai%2Fpixverse%2Fv6%2Fimage-to-video) · [public catalog, page 5](https://fal.ai/api/models?page=5)
- **Loop field:** **NOT SUPPORTED**; schema has `image_url` for the starting image and no end/last-frame field.
- **Duration / output:** 1–15 seconds; 360p, 540p, 720p, 1080p. No aspect-ratio field in the opened schema.
- **Audio:** `generate_audio_switch`, default false; the published rates differ by audio setting.
- **Input image:** schema does not specify maximum size or accepted formats.
- **Moderation / restrictions:** `enable_safety_checker` defaults true; relaxed screening is limited to authorized callers. Prompt limit is 2048 UTF-8 bytes. No pet-specific restriction was found in the opened sources.
- **Fit:** Cheap 720p motion generation, but this I2V endpoint cannot constrain the last frame; it does not meet the A→A requirement.

### MiniMax Hailuo “H3 Max Turbo”

- **Endpoint:** `minimax/h3-max-turbo/image-to-video`
- **Price:** promotional through 2026-10-31: 480p $0.01625/s, 768p $0.026/s, 1080p $0.052/s. Catalog post-promotion rates: $0.025/$0.04/$0.08 per second respectively. At the researched date, 4s 480p is $0.065 (retry estimate $0.0728); 4s 768p is $0.104 (retry estimate $0.11648). There is no 720p tier. [Model page](https://fal.ai/models/minimax/h3-max-turbo/image-to-video) · [queue schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax%2Fh3-max-turbo%2Fimage-to-video) · [public catalog, page 1](https://fal.ai/api/models?page=1)
- **Loop field:** optional `end_image_url`; `image_url` is the optional starting image.
- **Duration / output:** requested 0.92–15 seconds; the output may be about 0.7 seconds longer than requested. Resolutions 480p, 768p, 1080p; no aspect-ratio field.
- **Audio:** schema has no audio enable/disable switch. It exposes `target_audio_url`; neither an audio-disable option nor a separate audio price was published.
- **Input image:** size and accepted formats not specified in the opened schema.
- **Moderation / restrictions:** `enable_safety_checker` defaults true; the schema does not state an authorization exception. Prompt maximum is 50,000 characters. No pet-specific restriction was found in the opened sources.
- **Fit:** Cheapest end-frame candidate at the current promotional 480p rate; no exact 720p mode, and the output duration may exceed the requested duration.

### Seedance 2.0 Mini

- **Endpoint:** `bytedance/seedance-2.0/mini/image-to-video`
- **Price:** $0.007 per 1,000 tokens; catalog estimates $0.0721/s at 480p and $0.1547/s at 720p. Thus 4s costs $0.2884 at 480p or $0.6188 at 720p (retry estimates $0.3230 / $0.6931). Audio generation does not change the stated cost. [Model page](https://fal.ai/models/bytedance/seedance-2.0/mini/image-to-video) · [queue schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.0%2Fmini%2Fimage-to-video) · [public catalog, page 6](https://fal.ai/api/models?page=6)
- **Loop field:** optional `end_image_url`.
- **Duration / output:** 4–15 seconds or `auto`; 480p / 720p. Aspect ratios: auto, 21:9, 16:9, 4:3, 1:1, 3:4, 9:16.
- **Audio:** `generate_audio` defaults true; schema states the cost is the same with or without generated audio.
- **Input image:** JPEG, PNG, or WebP; maximum 30 MB for start/end images.
- **Moderation / restrictions:** no safety-checker or moderation field was exposed in the opened schema. No pet-specific restriction was found in the opened sources.
- **Fit:** Supports vertical 9:16 and explicit end images, but is substantially more expensive than the cheapest candidates.

### Kling O3 Standard (current baseline)

- **Endpoint:** `fal-ai/kling-video/o3/standard/image-to-video`
- **Price:** $0.084/s with audio off or $0.112/s with audio on. At the supported 3s option: $0.252 off / $0.336 on. A 4s audio-off clip is $0.336. [Model page](https://fal.ai/models/fal-ai/kling-video/o3/standard/image-to-video) · [queue schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai%2Fkling-video%2Fo3%2Fstandard%2Fimage-to-video) · [public catalog, page 3](https://fal.ai/api/models?page=3)
- **Loop field:** optional `end_image_url`; start image is `image_url`.
- **Duration / output:** duration choices 3–15 seconds. The opened schema has no resolution or aspect-ratio control.
- **Audio:** `generate_audio` defaults false; pricing differs when enabled.
- **Input image:** start/end images up to 50 MB, minimum 300×300 px, aspect ratio 0.40–2.50; accepted formats not specified in the schema.
- **Moderation / restrictions:** safety checker defaults true; disabling requires account authorization. No pet-specific restriction was found in the opened sources.
- **Fit:** Supports A→A and its 3s option is documented; vertical 9:16 is within the documented input ratio bounds, but output resolution/aspect control is not exposed. The catalog title showed “[Pro]” despite the Standard endpoint ID; the endpoint and Standard model page were used here.

### Seedance 2.0 image-to-video (720p baseline)

- **Endpoint found in the current public catalog/schema:** `bytedance/seedance-2.0/us/image-to-video`. The unqualified ID `bytedance/seedance-2.0/image-to-video` supplied in the request was not the endpoint ID returned by the opened catalog/schema.
- **Price:** $0.3034/s at 720p and $0.682/s at 1080p; the catalog also lists $0.014/1,000 tokens at 480p and 720p and $0.008/1,000 tokens at 4K. A 4s 720p clip is $1.2136 (retry estimate $1.3592). No 480p per-second price was published, so no 480p total is calculated. [Model page](https://fal.ai/models/bytedance/seedance-2.0/us/image-to-video) · [queue schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.0%2Fus%2Fimage-to-video) · [public catalog, page 13](https://fal.ai/api/models?page=13)
- **Loop field:** optional `end_image_url`.
- **Duration / output:** 4–15 seconds or `auto`; 480p, 720p, 1080p, 4K. Aspect ratios: auto, 21:9, 16:9, 4:3, 1:1, 3:4, 9:16.
- **Audio:** `generate_audio` defaults true; schema states cost is unchanged with/without audio.
- **Input image:** JPEG, PNG, or WebP; maximum 30 MB.
- **Moderation / restrictions:** no safety-checker or moderation field was exposed in the opened schema. No pet-specific restriction was found in the opened sources.
- **Fit:** Supports 9:16 and an end frame, but has the highest listed 720p cost in this comparison.

## Extra qualifying end-frame candidates

### PixVerse V6 Transition

- **Endpoint:** `fal-ai/pixverse/v6/transition`
- **Price:** V6 tier rates listed above; 720p audio-off $0.045/s and 4s $0.180. [Model page](https://fal.ai/models/fal-ai/pixverse/v6/transition) · [queue schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai%2Fpixverse%2Fv6%2Ftransition) · [public catalog, page 11](https://fal.ai/api/models?page=11)
- **Loop fields:** required `first_image_url` and `end_image_url`.
- **Duration / output:** 1–15 seconds; 360p, 540p, 720p, 1080p. Aspect ratios include 9:16, plus 16:9, 4:3, 1:1, 3:4, 2:3, 3:2, and 21:9.
- **Audio:** audio switch defaults false; published 720p rate is $0.045/s off and $0.060/s on.
- **Input image:** size/formats not specified in schema; model page lists JPG/JPEG, PNG, WebP, GIF, AVIF, HEIC, HEIF.
- **Moderation / restrictions:** safety checker defaults true; relaxed screening is limited to authorized callers. No pet-specific restriction was found in the opened sources.
- **Fit:** Cheapest exact-720p end-frame option found; supports 9:16 and an explicit final image.

### PixVerse V5 Transition

- **Endpoint:** `fal-ai/pixverse/v5/transition`
- **Price:** $0.15 at 360p/540p, $0.20 at 720p, and $0.40 at 1080p for each supported 5s video. At 720p the rate is $0.04/generated second. The endpoint supports 5s or 8s, not 4s. [Model page](https://fal.ai/models/fal-ai/pixverse/v5/transition) · [queue schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai%2Fpixverse%2Fv5%2Ftransition) · [public catalog, page 19](https://fal.ai/api/models?page=19)
- **Loop fields:** required `first_image_url` and `end_image_url`.
- **Duration / output:** 5s or 8s; 360p, 540p, 720p, 1080p. Aspect ratios include 9:16, 16:9, 4:3, 1:1, and 3:4.
- **Audio:** no audio-generation toggle or separate audio rate was exposed in the opened schema/catalog.
- **Input image:** size/formats not stated in schema; model page lists JPG/JPEG, PNG, WebP, GIF, AVIF, HEIC, HEIF.
- **Moderation / restrictions:** safety checker defaults true; relaxed screening is limited to authorized callers. No pet-specific restriction was found in the opened sources.
- **Fit:** Meets the end-frame / vertical-ratio requirement, but cannot produce a 4s output.

### MiniMax Hailuo-02 Standard

- **Endpoint:** `fal-ai/minimax/hailuo-02/standard/image-to-video`
- **Price:** approximately $0.017/s at 512p and $0.045/s at 768p. The opened schema lists 6s and 10s only, so no 4s total is applicable. [Model page/readme](https://fal.ai/models/fal-ai/minimax/hailuo-02/standard/image-to-video) · [queue schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai%2Fminimax%2Fhailuo-02%2Fstandard%2Fimage-to-video) · [public catalog, page 5](https://fal.ai/api/models?page=5)
- **Loop field:** optional `end_image_url`.
- **Duration / output:** schema lists 6s / 10s, 512p / 768p, and no aspect-ratio field. The page/readme says maximum 6 seconds, while the schema enum includes 10 seconds.
- **Audio:** no audio generation/disable field or separate audio rate was exposed in the opened schema/catalog.
- **Input image:** readme specifies JPG/JPEG, PNG, WebP, GIF, AVIF; maximum 20 MB; aspect ratio 2:5–5:2; minimum 300 px on the shorter side.
- **Moderation / restrictions:** safety checker defaults true; relaxed screening is limited to authorized callers. No pet-specific restriction was found in the opened sources.
- **Fit:** Supports an end frame and is inexpensive at 512p, but 4s and exact 9:16 output control are unavailable.

## Recommendation

The **three lowest-price end-frame choices** found are:

1. **MiniMax H3 Max Turbo** at promotional 480p: $0.01625/s, or $0.065 for 4s before retry allowance ($0.0728 at ×1.12). This promotion was listed through 2026-10-31; post-promotion catalog price is $0.025/s. It is the cheapest option, but has no exact 720p mode and may run about 0.7s longer than requested.
2. **MiniMax Hailuo-02 Standard** at 512p: approximately $0.017/s. It supports the end image, but its published durations are 6s/10s, not 4s.
3. **PixVerse V5 Transition** at 720p: $0.20 for a 5s clip ($0.04/s); it supports explicit start/end frames and 9:16 but cannot output 4s.

For a **4-second 720p A→A clip**, PixVerse V6 Transition is the cheapest exact-resolution/duration candidate found: $0.18 with audio off ($0.2016 using the 1.12 retry factor). For a specifically **4-second 480p** A→A clip, H3 Max Turbo is the cheapest candidate found at the current promotional rate. No media generation, API-key use, or repository benchmark was performed.
