/** A box other assets can line up with. Positions are world pixels. */
export interface AlignBox {
  left: number;
  right: number;
  cx: number;
  top: number;
  bottom: number;
  cy: number;
}

export interface AlignLines {
  vertical: number[];
  horizontal: number[];
}

/**
 * Pulls a box onto the nearest edge or centre of the others, the way Canva
 * does, and reports the lines that match. X and Y snap on their own, so a
 * row can line up before the columns do.
 */
export function snapAlign(
  w: number,
  h: number,
  x: number,
  y: number,
  targets: AlignBox[],
  threshold: number,
): { x: number; y: number } & AlignLines {
  const xs = targets.flatMap((box) => [box.left, box.cx, box.right]);
  const ys = targets.flatMap((box) => [box.top, box.cy, box.bottom]);
  const dx = nearest(x - w / 2, x, x + w / 2, xs, threshold);
  const dy = nearest(y - h / 2, y, y + h / 2, ys, threshold);
  const nx = Math.round(x + dx);
  const ny = Math.round(y + dy);
  return {
    x: nx,
    y: ny,
    vertical: dx === 0 && !close(x - w / 2, x, x + w / 2, xs, threshold) ? [] : matching(nx - w / 2, nx, nx + w / 2, xs),
    horizontal: dy === 0 && !close(y - h / 2, y, y + h / 2, ys, threshold) ? [] : matching(ny - h / 2, ny, ny + h / 2, ys),
  };
}

/** Smallest shift that lands one of `edges` on a target, or 0 when none are close. */
function nearest(a: number, b: number, c: number, targets: number[], threshold: number): number {
  let delta = 0;
  let best = threshold;
  let found = false;
  for (const edge of [a, b, c]) {
    for (const target of targets) {
      const distance = Math.abs(target - edge);
      if (distance <= best) {
        best = distance;
        delta = target - edge;
        found = true;
      }
    }
  }
  return found ? delta : 0;
}

function close(a: number, b: number, c: number, targets: number[], threshold: number): boolean {
  for (const edge of [a, b, c]) {
    for (const target of targets) if (Math.abs(target - edge) <= threshold) return true;
  }
  return false;
}

/** Targets that sit on the box after it has settled. */
function matching(a: number, b: number, c: number, targets: number[]): number[] {
  const lines = new Set<number>();
  for (const edge of [a, b, c]) {
    for (const target of targets) if (Math.abs(target - edge) <= 0.75) lines.add(target);
  }
  return [...lines];
}
