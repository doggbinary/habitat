import type { RGBAImage } from './image';

/**
 * PNG reading and writing on raw bytes. Extraction has to work on the sheet
 * exactly as stored: a browser canvas premultiplies alpha, which nudges the
 * colour of every half-transparent pixel, so neither decoding nor encoding
 * goes through one. zlib is passed in: Node has it built in, browsers have
 * CompressionStream.
 */
export interface Zlib {
  inflate: (data: Uint8Array) => Promise<Uint8Array>;
  deflate: (data: Uint8Array) => Promise<Uint8Array>;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export class PngError extends Error {}

function readU32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && SIGNATURE.every((v, i) => bytes[i] === v);
}

/** Adam7 passes: start x, start y, step x, step y. */
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

export async function decodePng(bytes: Uint8Array, zlib: Zlib): Promise<RGBAImage> {
  if (!isPng(bytes)) throw new PngError('Not a PNG file');
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const len = readU32(bytes, pos);
    const kind = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') {
      width = readU32(data, 0);
      height = readU32(data, 4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (kind === 'PLTE') palette = data;
    else if (kind === 'tRNS') trns = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!channels || width === 0 || height === 0) throw new PngError('Unsupported PNG layout');
  if (![1, 2, 4, 8, 16].includes(depth)) throw new PngError('Unsupported PNG bit depth');
  if (type === 3 && !palette) throw new PngError('Indexed PNG without a palette');

  const raw = await zlib.inflate(concat(idat));
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const out = new Uint8ClampedArray(width * height * 4);
  const max = (1 << Math.min(depth, 8)) - 1;

  // tRNS for grey and truecolour names one colour as fully transparent.
  const key16 = (i: number) => (trns && trns.length >= i * 2 + 2 ? (trns[i * 2] << 8) | trns[i * 2 + 1] : -1);
  const greyKey = type === 0 ? key16(0) : -1;
  const rgbKey = type === 2 ? [key16(0), key16(1), key16(2)] : null;

  const sample = (line: Uint8Array, index: number): number => {
    if (depth === 8) return line[index];
    if (depth === 16) return (line[index * 2] << 8) | line[index * 2 + 1];
    const bit = index * depth;
    return (line[bit >> 3] >> (8 - depth - (bit & 7))) & max;
  };
  const to8 = (v: number) => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / max));

  let offset = 0;
  const passes = interlace ? ADAM7 : [[0, 0, 1, 1]];
  for (const [sx, sy, dx, dy] of passes) {
    const pw = Math.ceil((width - sx) / dx);
    const ph = Math.ceil((height - sy) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const stride = Math.ceil((pw * bitsPerPixel) / 8);
    let prev = new Uint8Array(stride);
    for (let row = 0; row < ph; row++) {
      const filter = raw[offset];
      const line = raw.slice(offset + 1, offset + 1 + stride);
      offset += stride + 1;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        let v = line[i];
        if (filter === 1) v += a;
        else if (filter === 2) v += b;
        else if (filter === 3) v += (a + b) >> 1;
        else if (filter === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        line[i] = v & 255;
      }
      const y = sy + row * dy;
      for (let col = 0; col < pw; col++) {
        const x = sx + col * dx;
        const o = (y * width + x) * 4;
        const s = col * channels;
        if (type === 3) {
          const p = sample(line, col);
          out[o] = palette![p * 3];
          out[o + 1] = palette![p * 3 + 1];
          out[o + 2] = palette![p * 3 + 2];
          out[o + 3] = trns && p < trns.length ? trns[p] : 255;
        } else if (type === 0) {
          const raw16 = sample(line, s);
          const g = to8(raw16);
          out.set([g, g, g, raw16 === greyKey ? 0 : 255], o);
        } else if (type === 4) {
          const g = to8(sample(line, s));
          out.set([g, g, g, to8(sample(line, s + 1))], o);
        } else if (type === 2) {
          const r = sample(line, s);
          const g = sample(line, s + 1);
          const b = sample(line, s + 2);
          const keyed = rgbKey && r === rgbKey[0] && g === rgbKey[1] && b === rgbKey[2];
          out.set([to8(r), to8(g), to8(b), keyed ? 0 : 255], o);
        } else {
          out.set([to8(sample(line, s)), to8(sample(line, s + 1)), to8(sample(line, s + 2)), to8(sample(line, s + 3))], o);
        }
      }
      prev = line;
    }
  }
  return { width, height, data: out };
}

let crcTable: Uint32Array | null = null;
function crc32(parts: Uint8Array[]): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const data of parts) for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u32(v: number): Uint8Array {
  return new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
}

function chunk(kind: string, body: Uint8Array): Uint8Array {
  const name = new Uint8Array([...kind].map((c) => c.charCodeAt(0)));
  return concat([u32(body.length), name, body, u32(crc32([name, body]))]);
}

/** RGBA, 8 bits per channel, every value written exactly as given. */
export async function encodePng(image: RGBAImage, zlib: Zlib): Promise<Uint8Array> {
  const { width, height, data } = image;
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width), 0);
  ihdr.set(u32(height), 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return concat([
    new Uint8Array(SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', await zlib.deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function pipeThrough(data: Uint8Array, stream: GenericTransformStream): Promise<Uint8Array> {
  const piped = new Blob([data as BlobPart]).stream().pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

/** zlib from the platform's compression streams, available in browsers and Node alike. */
export const streamZlib: Zlib = {
  inflate: (data) => pipeThrough(data, new DecompressionStream('deflate')),
  deflate: (data) => pipeThrough(data, new CompressionStream('deflate')),
};
