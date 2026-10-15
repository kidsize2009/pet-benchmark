import { fal } from "@fal-ai/client";
import { config as loadEnv } from "dotenv";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { models } from "../models.js";
import { downloadFile } from "./media.js";
import { extractVideoUrl } from "./fal-result.js";

async function main(): Promise<void> {
  const [modelId, requestId, outputPath, ...extra] = process.argv.slice(2);
  if (!modelId || !requestId || !outputPath || extra.length > 0) {
    throw new Error("Usage: npm run recover -- <model_id> <request_id> <output.mp4>");
  }
  const model = models.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error(`Unknown model id ${modelId}. Choose: ${models.map((candidate) => candidate.id).join(", ")}`);

  loadEnv({ path: new URL("../.env", import.meta.url) });
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) throw new Error("FAL_KEY is missing. Add it to tools/pet-benchmark/.env; the key is never printed.");
  fal.config({ credentials: apiKey });
  const response = await fal.queue.result(model.endpoint, { requestId });
  const videoUrl = extractVideoUrl(response);
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await downloadFile(videoUrl, outputPath);
  console.log(JSON.stringify({ keys: Object.keys(response), outputPath }));
}

loadEnv({ path: new URL("../.env", import.meta.url) });
const apiKey = process.env.FAL_KEY ?? "";

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(apiKey ? message.split(apiKey).join("[redacted]") : message);
  process.exitCode = 1;
});
