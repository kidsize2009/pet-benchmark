export type ModelConfig = {
  id: string;
  endpoint: string;
  enabled: boolean;
  pricePerSecond: number;
  duration: number | null;
  durationValueType: "string" | "number" | null;
  resolution?: string;
  aspectRatio?: string;
  generateAudio?: boolean;
  supportsEndFrame: boolean;
};

export const models: ModelConfig[] = [
  {
    id: "kling-o3-standard",
    endpoint: "fal-ai/kling-video/o3/standard/image-to-video",
    enabled: true,
    pricePerSecond: 0.084,
    duration: 4,
    durationValueType: "string",
    generateAudio: false,
    supportsEndFrame: true,
  },
  {
    id: "kling-o3-pro",
    endpoint: "fal-ai/kling-video/o3/pro/image-to-video",
    enabled: true,
    pricePerSecond: 0.112,
    duration: 3,
    durationValueType: "string",
    generateAudio: false,
    supportsEndFrame: true,
  },
  {
    id: "happy-horse",
    endpoint: "alibaba/happy-horse/image-to-video",
    enabled: true,
    pricePerSecond: 0.14,
    duration: 3,
    durationValueType: "number",
    resolution: "720p",
    supportsEndFrame: false,
  },
  {
    id: "seedance-2",
    endpoint: "bytedance/seedance-2.0/image-to-video",
    enabled: true,
    pricePerSecond: 0.3024,
    duration: 4,
    durationValueType: "string",
    resolution: "720p",
    aspectRatio: "9:16",
    generateAudio: false,
    supportsEndFrame: true,
  },
  {
    id: "grok-imagine",
    endpoint: "xai/grok-imagine-video/image-to-video",
    enabled: false,
    pricePerSecond: 0.07,
    duration: null,
    durationValueType: null,
    resolution: "720p",
    supportsEndFrame: false,
  },
];