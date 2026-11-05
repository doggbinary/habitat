import { createImage, drawImage, drawLabel, strokeRect, upscale, type RGBAImage } from './image';
import { encodePng, type Zlib } from './png';
import type { FormatGuess } from './formats';
import { extractJson, type VisionClient } from './vision';

/**
 * Names the materials of a recognised autotile sheet with the vision model.
 * The layout itself is never left to the model; it only says what each
 * block depicts. Returns names by slot index, and what each looks like.
 */
export async function nameMaterials(
  client: VisionClient,
  image: RGBAImage,
  guess: FormatGuess,
  zlib: Zlib,
): Promise<{ names: (string | undefined)[]; looks: (string | undefined)[] }> {
  const scale = Math.max(1, Math.min(3, Math.floor(1400 / Math.max(image.width, image.height))));
  const flat = createImage(image.width, image.height, [255, 0, 255, 255]);
  drawImage(flat, image, 0, 0);
  const view = upscale(flat, scale);
  for (const slot of guess.slots) {
    const r = { x: slot.rect.x * scale, y: slot.rect.y * scale, w: slot.rect.w * scale, h: slot.rect.h * scale };
    strokeRect(view, r, [255, 255, 255, 220], 2);
    drawLabel(view, String(slot.index + 1), r.x + 3, r.y + 3, 3, [255, 255, 255, 255], [0, 0, 0, 220]);
  }
  const text = await client.complete({
    system: 'You name terrain materials on game tilesets. Reply with a single JSON object and nothing else.',
    prompt: [
      `This is an ${guess.format.replace('rpgmaker-', 'RPG Maker ').toUpperCase()} tileset (${guess.note}) enlarged ${scale}x. Flat magenta is transparent.`,
      'Each numbered white frame is ONE terrain material whose pieces build edges and corners automatically; do not describe the pieces separately.',
      'For every numbered block that is not empty, give a short descriptive name (1 to 3 words, like "short grass", "wooden planks", "cobblestone path")',
      'and what it looks like: one of "floor", "raised platform", "path", "water", "wall", "roof", "decoration".',
      'Reply as {"materials":[{"block":1,"name":"short grass","looks":"floor"}]}',
    ].join('\n'),
    images: [{ label: 'The sheet with numbered blocks:', png: await encodePng(view, zlib) }],
    maxTokens: 2048,
  });
  const json = extractJson(text) as { materials?: { block?: unknown; name?: unknown; looks?: unknown }[] } | null;
  const names: (string | undefined)[] = [];
  const looks: (string | undefined)[] = [];
  for (const entry of json?.materials ?? []) {
    const index = Number(entry.block) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= guess.slots.length) continue;
    const name = String(entry.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (name) names[index] = name;
    if (typeof entry.looks === 'string') looks[index] = entry.looks.slice(0, 30);
  }
  return { names, looks };
}
