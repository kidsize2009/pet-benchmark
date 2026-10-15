export const presets = {
  subtle_life:
    "Preserve the exact pet identity, fur pattern and composition. One slow natural blink, tiny ear twitch, fur and whiskers moving in a light breeze, gentle breathing. Static camera. No morphing, no new objects.",
  cozy_light:
    "Preserve the exact pet identity, fur pattern and composition. Soft warm light slowly shifting across the scene, a few floating dust particles, gentle breathing, one slow blink. Static camera. No morphing, no new objects.",
} as const;

export type PresetName = keyof typeof presets;