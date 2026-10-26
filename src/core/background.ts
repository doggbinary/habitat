/** Shadow pixels are see-through and dark; glass and highlights are see-through and light. */
const SHADOW_MAX_ALPHA = 235;
const SHADOW_MAX_VALUE = 120;
const SOLID_ALPHA = 250;

/**
 * Takes the drop shadows out from under a pack's objects. Packs paint them
 * as see-through dark pixels. A see-through dark pixel right against a solid
 * one is the object's soft outline and stays; the rest is shadow and is
 * cleared. Returns whether anything changed.
 */
export function clearShadows(rgba: Uint8ClampedArray, w: number, h: number): boolean {
  const solid = (i: number) => rgba[i * 4 + 3] >= SOLID_ALPHA;
  const doomed: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const at = i * 4;
      const a = rgba[at + 3];
      if (a === 0 || a > SHADOW_MAX_ALPHA) continue;
      if (Math.max(rgba[at], rgba[at + 1], rgba[at + 2]) >= SHADOW_MAX_VALUE) continue;
      const outline = (x > 0 && solid(i - 1)) || (x < w - 1 && solid(i + 1)) || (y > 0 && solid(i - w)) || (y < h - 1 && solid(i + w));
      if (!outline) doomed.push(at);
    }
  }
  // Cleared afterwards, so a pixel's neighbours are judged as the pack drew them.
  for (const at of doomed) rgba[at + 3] = 0;
  return doomed.length > 0;
}

const isWhite = (rgba: Uint8ClampedArray, i: number) =>
  rgba[i * 4 + 3] > 24 && rgba[i * 4] > 245 && rgba[i * 4 + 1] > 245 && rgba[i * 4 + 2] > 245;

/** How far into an object its edge was blended with the white, in pixels. */
const EDGE = 2;

/**
 * Some packs paint their objects on solid white instead of leaving them
 * transparent. This clears that white: the white reachable from the
 * picture's edge goes, and the grey rim where an outline was blended into
 * it keeps only its dark part, so nothing sits in a light halo. White inside
 * an object is kept. Only for sheets with no real transparency where white
 * is a large share of the picture; returns whether anything changed.
 */
export function clearWhiteBackdrop(rgba: Uint8ClampedArray, w: number, h: number): boolean {
  const total = w * h;
  let clear = 0;
  let white = 0;
  for (let i = 0; i < total; i++) {
    if (rgba[i * 4 + 3] <= 24) clear += 1;
    else if (isWhite(rgba, i)) white += 1;
  }
  if (total === 0 || clear / total > 0.02 || white / total < 0.15) return false;

  // Distance from the backdrop: 0 is backdrop, 1..EDGE the rim, beyond untouched.
  const far = EDGE + 1;
  const dist = new Uint8Array(total).fill(far);
  let queue: number[] = [];
  const reach = (i: number) => {
    if (dist[i] === 0 || !isWhite(rgba, i)) return;
    dist[i] = 0;
    queue.push(i);
  };
  for (let x = 0; x < w; x++) {
    reach(x);
    reach((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    reach(y * w);
    reach(y * w + w - 1);
  }
  const neighbours = (i: number, visit: (j: number) => void) => {
    const x = i % w;
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (i >= w) visit(i - w);
    if (i < total - w) visit(i + w);
  };
  while (queue.length > 0) neighbours(queue.pop()!, reach);

  let ring = [];
  for (let i = 0; i < total; i++) if (dist[i] === 0) ring.push(i);
  for (let d = 1; d <= EDGE; d++) {
    queue = [];
    for (const i of ring) {
      neighbours(i, (j) => {
        if (dist[j] !== far) return;
        dist[j] = d;
        queue.push(j);
      });
    }
    ring = queue;
  }

  for (let i = 0; i < total; i++) {
    const at = i * 4;
    if (dist[i] === 0) {
      rgba[at + 3] = 0;
      continue;
    }
    if (dist[i] === far) continue;
    const r = rgba[at];
    const g = rgba[at + 1];
    const b = rgba[at + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) >= 24) continue;
    // A grey rim pixel is some dark ink laid over white; keep only the ink.
    const ink = (255 - Math.min(r, g, b)) / 255;
    if (ink <= 0) {
      rgba[at + 3] = 0;
      continue;
    }
    for (let c = 0; c < 3; c++) rgba[at + c] = Math.round(255 - (255 - rgba[at + c]) / ink);
    rgba[at + 3] = Math.round(rgba[at + 3] * ink);
  }
  return true;
}
