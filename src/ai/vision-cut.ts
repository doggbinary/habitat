import type { AssetRect, Tileset } from '../core/doc';
import { parseCutReply, type CutPiece } from './cut-boxes';

const KEY = 'habitat-vision-key';
/** Longest side sent to the model. The boxes are scaled back onto the real sheet. */
const MAX_EDGE = 1280;

export function storedVisionKey(): string {
  try {
    return localStorage.getItem(KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

export function saveVisionKey(key: string): void {
  localStorage.setItem(KEY, key.trim());
}

export function clearVisionKey(): void {
  localStorage.removeItem(KEY);
}

export class VisionCutError extends Error {
  constructor(
    message: string,
    readonly retryKey: boolean,
  ) {
    super(message);
  }
}

/** A PNG of the sheet, shrunk so a large page still uploads, plus how to scale boxes back. */
export function sheetSnapshot(tileset: Tileset): { dataUrl: string; width: number; height: number; scale: number } | null {
  const image = tileset.image;
  if (!image || tileset.imgW < 2 || tileset.imgH < 2) return null;
  const scale = Math.min(1, MAX_EDGE / Math.max(tileset.imgW, tileset.imgH));
  const width = Math.max(1, Math.round(tileset.imgW * scale));
  const height = Math.max(1, Math.round(tileset.imgH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, 0, 0, width, height);
  return { dataUrl: canvas.toDataURL('image/png'), width, height, scale };
}

/**
 * Asks a vision model to mark each object and floor square on the sheet.
 * Boxes come back in the sheet's own pixels.
 */
export async function cutSheetWithVision(tileset: Tileset, apiKey: string): Promise<CutPiece[]> {
  const shot = sheetSnapshot(tileset);
  if (!shot) throw new VisionCutError('This sheet has no picture to look at.', false);

  const reply = await requestCut(shot.dataUrl, shot.width, shot.height, apiKey);
  const pieces = parseCutReply(reply, shot.width, shot.height);
  if (pieces.length === 0) throw new VisionCutError('Nothing on this sheet was marked, so the old cut was kept.', false);

  const back = 1 / shot.scale;
  return pieces.map((piece) => ({
    x: Math.round(piece.x * back),
    y: Math.round(piece.y * back),
    w: Math.max(2, Math.round(piece.w * back)),
    h: Math.max(2, Math.round(piece.h * back)),
    floor: piece.floor,
  }));
}

async function requestCut(dataUrl: string, width: number, height: number, apiKey: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        temperature: 0,
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt(width, height) },
              { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
            ],
          },
        ],
      }),
    });
  } catch {
    throw new VisionCutError('The cut could not be sent. Check the connection and try again.', false);
  }

  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string };
    choices?: { message?: { content?: string } }[];
  } | null;
  if (response.status === 401 || response.status === 403) {
    throw new VisionCutError('That API key was rejected. Paste a new one.', true);
  }
  if (!response.ok) {
    throw new VisionCutError(body?.error?.message || `The cut failed (${response.status}).`, false);
  }
  const text = body?.choices?.[0]?.message?.content;
  if (!text) throw new VisionCutError('The reply was empty, so the old cut was kept.', false);
  return text;
}

function prompt(width: number, height: number): string {
  return [
    `This is a game tilesheet, ${width} by ${height} pixels.`,
    'Mark every placeable thing. Return JSON only, no explanation:',
    '{"pieces":[{"x":0,"y":0,"w":32,"h":48,"floor":false}]}',
    'x, y, w and h are pixels in this image, tight to the visible pixels.',
    'A house, tree, character, lamp or piece of furniture is one box, even when it covers many grid squares. Do not slice one object into cells.',
    'Repeating floor, ground, water, paving and wall squares are each their own box with floor true.',
    'Two objects that touch are still two boxes. Do not include empty background.',
    'Never return one box around the whole sheet.',
  ].join(' ');
}

/** Floor squares first, in the order the palette already shows ground. */
export function arrangeCut(pieces: CutPiece[]): { assets: AssetRect[]; ground: number[] } {
  const floor = pieces.filter((piece) => piece.floor).map(strip);
  const objects = pieces.filter((piece) => !piece.floor).map(strip);
  return {
    assets: [...floor, ...objects],
    ground: floor.map((_, index) => index),
  };
}

function strip(piece: CutPiece): AssetRect {
  return { x: piece.x, y: piece.y, w: piece.w, h: piece.h };
}
