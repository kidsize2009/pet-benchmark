type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function nestedVideoUrl(value: unknown): unknown {
  return asObject(asObject(value)?.video)?.url;
}

export function extractVideoUrl(response: unknown): string {
  const root = asObject(response);
  const data = asObject(root?.data);
  const candidates = [
    nestedVideoUrl(data),
    nestedVideoUrl(root),
    nestedVideoUrl(asObject(data?.output)),
  ];
  const url = candidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  if (url) return url;

  const keys = root ? Object.keys(root) : [];
  throw new Error(`fal response did not contain video.url (top-level keys: ${keys.join(", ") || "(none)"})`);
}
