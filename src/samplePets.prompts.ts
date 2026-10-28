export const COMMON = `Realistic smartphone photo, natural light, everyday home or outdoor setting, slightly imperfect like a real phone snapshot — not a studio shot, not CGI, not illustration. Vertical 9:16. Composition: a single pet occupies the lower two thirds of the frame; the upper third is calm, uncluttered, slightly darker background with no important details (space for a lock-screen clock). The whole head, both ears and the face are fully inside the frame, not cropped. Sharp focus on the eyes, eyes open and clearly visible. No people, no hands, no text, no watermark, no collar tags with text, no extra animals.`;

export type SamplePetPrompt = {
  presetKey: string;
  name: string;
  prompt: string;
};

export const SAMPLE_PETS: SamplePetPrompt[] = [
  {
    presetKey: "gentle",
    name: "Milo",
    prompt:
      "A tricolor Pembroke Welsh Corgi sitting upright on a light wooden floor in a bright living room, facing the camera, head straight, large ears up and alert, mouth closed, calm curious expression. Soft daylight from a window on the side. Plain light wall behind.",
  },
  {
    presetKey: "glance",
    name: "Luna",
    prompt:
      "A grey-brown tabby cat sitting on a windowsill indoors, body facing the camera, head turned three-quarters to the left, looking away toward the window, calm and attentive, ears forward. Soft daylight, plain neutral wall and a softly blurred window frame behind.",
  },
  {
    presetKey: "cozy",
    name: "Buster",
    prompt:
      "A Beagle lying on its side on a soft knitted blanket on a sofa, relaxed, chest and belly clearly visible, head resting on the blanket but lifted slightly, eyes open, calm. Warm indoor evening light, a soft cushion and plain wall behind.",
  },
  {
    presetKey: "sleepy",
    name: "Biscuit",
    prompt:
      "A ginger (orange) cat curled up in a round fluffy pet bed, head raised, awake but drowsy, eyelids half-closed, mouth closed, relaxed face clearly visible. Warm cozy lamp light, softly blurred room behind.",
  },
  {
    presetKey: "breeze",
    name: "Daisy",
    prompt:
      "A Golden Retriever with long fluffy fur sitting in a summer meadow with tall grass and small wildflowers, facing the camera, mouth closed or slightly open, calm happy expression. Late afternoon light, green trees and soft foliage softly blurred behind, no bright sky in the upper third.",
  },
  {
    presetKey: "dreamy",
    name: "Mochi",
    prompt:
      "A fluffy white-and-grey Ragdoll cat with blue eyes sitting calmly on a sofa in the evening, facing the camera, still and relaxed. Behind the cat, warm out-of-focus string fairy lights create soft round bokeh dots in the middle of the background; the very top of the frame stays darker and calm. Warm, low ambient light, cat clearly lit.",
  },
  {
    presetKey: "renaissance",
    name: "Duke",
    prompt:
      "A Cavalier King Charles Spaniel (Blenheim, chestnut and white) sitting upright and looking straight at the camera, a dignified portrait pose, head and chest clearly visible, long silky ears, calm noble expression. Plain dark neutral wall behind, soft side window light.",
  },
];
