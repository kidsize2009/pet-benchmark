export const presets = {
  subtle_life:
    "Preserve the exact pet identity, fur pattern and composition. One slow natural blink, tiny ear twitch, fur and whiskers moving in a light breeze, gentle breathing. Static camera. No morphing, no new objects.",
  cozy_light:
    "Preserve the exact pet identity, fur pattern and composition. Soft warm light slowly shifting across the scene, a few floating dust particles, gentle breathing, one slow blink. Static camera. No morphing, no new objects.",
  gentle:
    "Preserve the exact pet identity, fur pattern and composition. One slow natural blink, a tiny ear twitch, soft breathing, fur and whiskers barely moving. The pet ends in exactly the starting pose. Static camera. No morphing, no new objects.",
  gentle_pp:
    "Preserve the exact pet identity, fur pattern and composition. One slow natural blink, a tiny ear twitch, soft breathing, fur and whiskers barely moving. Static camera. No morphing, no new objects.",
  breeze:
    "Preserve the exact pet identity, fur pattern and composition. A light breeze gently moves the fur, whiskers and ear tips; background foliage sways slightly. One slow blink. The pet stays in the same position and ends in exactly the starting pose. Static camera. No morphing, no new objects.",
  breeze_pp:
    "Preserve the exact pet identity, fur pattern and composition. A light breeze gently moves the fur, whiskers and ear tips; background foliage sways slightly. One slow blink. The pet stays in the same position. Static camera. No morphing, no new objects.",
  dreamy:
    "Preserve the exact pet identity, fur pattern, colors and composition. Keep exposure, lighting and colors constant. Only the out-of-focus background lights shimmer very slightly. The pet breathes calmly and blinks once, very slowly. Ends in exactly the starting pose. Static camera. No light leaks, no lens flare, no glow, no color shift, no morphing, no new objects.",
  cozy:
    "Preserve the exact pet identity, fur pattern and composition. The pet is calm and relaxed: slow deep breathing makes the body rise and fall slightly, one lazy slow blink, a barely visible ear twitch. The pet does not move from its place and ends in exactly the starting pose. Static camera. No morphing, no new objects.",
  cozy_pp:
    "Preserve the exact pet identity, fur pattern and composition. The pet is calm and relaxed: slow deep breathing makes the body rise and fall slightly, one lazy slow blink, a barely visible ear twitch. The pet does not move from its place. Static camera. No morphing, no new objects.",
  glance:
    "Preserve the exact pet identity, fur pattern and composition. The pet's eyes shift slightly to the side and back, one slow natural blink, the head moves only a few degrees and returns smoothly. Soft breathing. Ends in exactly the starting pose. Static camera. No morphing, no new objects.",
  glance_pp:
    "Preserve the exact pet identity, fur pattern and composition. The pet's eyes shift slightly to the side and back, one slow natural blink, the head moves only a few degrees and returns smoothly. Soft breathing. Static camera. No morphing, no new objects.",
  gentle_v2:
    "Preserve the exact pet identity, fur pattern and composition. The pet slowly tilts its head to one side with a curious expression, blinks once, its ears move slightly, breathing is clearly visible. Then it returns smoothly to the exact starting pose. Static camera. No morphing, no new objects.",
  breeze_v2:
    "Preserve the exact pet identity, fur pattern and composition. A steady breeze clearly blows: the fur, ear tips and whiskers visibly ripple and flutter, the grass and background foliage sway clearly. The pet blinks once and stays in place, ending in exactly the starting pose. Static camera. No morphing, no new objects.",
  cozy_v2:
    "Preserve the exact pet identity, fur pattern and composition. The pet takes slow, deep, clearly visible breaths: the chest and body rise and fall, the head shifts slightly on its paws, an ear twitches, one slow long blink. Then it settles into exactly the starting pose. Static camera. No morphing, no new objects.",
  glance_v2:
    "Preserve the exact pet identity, fur pattern and composition. The pet looks around attentively: its eyes and head turn clearly to the left, then to the right, then back to the camera, with one blink. Ends in exactly the starting pose. Static camera. No morphing, no new objects.",
  dreamy_v2:
    "Preserve the exact pet identity, fur pattern, colors and composition. The out-of-focus background lights clearly drift and twinkle. The pet slowly turns its head a little and blinks once, then returns to exactly the starting pose. Keep the lighting on the pet constant: no glow, no lens flare, no color shift. Static camera. No morphing, no new objects.",
  sleepy_v1: "The cat slowly opens its mouth in a big yawn, then closes it, blinks slowly and settles.",
  gentle_v3: "The pet tilts its head to one side, then back, blinks once and its ears move.",
  breeze_v3: "A strong breeze blows through the scene: the pet's fur and ears flutter, the grass and trees sway. The pet blinks once.",
  cozy_v3: "The pet breathes slowly and deeply, its body rising and falling, it blinks slowly once and an ear twitches, then settles.",
  glance_v3: "The pet looks to the left, then to the right, then back at the camera and blinks once.",
  dreamy_v3: "The background lights twinkle and drift. The pet turns its head slightly and blinks once.",
  gentle_v4: "The pet keeps its head almost still. It makes a very small head tilt of a few degrees, blinks once, one ear moves slightly, then it returns to exactly the original pose. Locked camera, subtle motion only.",
  glance_v4: "The pet stays in its original pose. Only its eyes shift gently toward the camera with a tiny head movement, then one soft blink, and the gaze returns to the original direction. Locked camera, subtle motion only, ends in exactly the original pose.",
  breeze_v4: "A strong gust of wind hits: the dog's long fur and ears blow sideways and flutter, the tall grass bends and waves, the dog squints and blinks once, then the wind calms.",
  dreamy_v4: "The golden lights in the background twinkle and slowly drift. The dog turns its head slightly toward the lights and blinks once.",
  breeze_s2: "A strong gust of wind blows across the hill: the dog's fur and ears ripple sideways, the grass sways in waves, the dog squints and blinks, then the wind calms.",
  dreamy_s2: "The string lights in the background twinkle and softly shimmer. The dog slowly turns its head toward the lights, blinks once, then looks back at the camera.",
} as const;

export type PresetName = keyof typeof presets;

export const presetDurations: Partial<Record<PresetName, number>> = {
  gentle_v3: 6,
  breeze_v3: 6,
  cozy_v3: 6,
  glance_v3: 6,
  dreamy_v3: 6,
  breeze_v4: 5,
  dreamy_v4: 5,
  breeze_s2: 4,
  dreamy_s2: 4,
};