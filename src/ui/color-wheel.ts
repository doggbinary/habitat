import { el } from './dom';

/**
 * Procreate-style colour picker: hue around the wheel, saturation from the
 * centre outwards, and value on a separate slider.
 *
 * Two axes on a disc is far easier to aim at with a Pencil than three sliders,
 * and the wheel is a shape people already recognise, so nothing has to be
 * explained.
 */

export interface HSV {
  h: number; // 0-360
  s: number; // 0-1
  v: number; // 0-1
}

export function hsvToRgb({ h, s, v }: HSV): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const seg = Math.floor(h / 60) % 6;
  const [r, g, b] =
    seg === 0 ? [c, x, 0]
    : seg === 1 ? [x, c, 0]
    : seg === 2 ? [0, c, x]
    : seg === 3 ? [0, x, c]
    : seg === 4 ? [x, 0, c]
    : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export function rgbToHsv(r: number, g: number, b: number): HSV {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToHex(hsv: HSV): string {
  const [r, g, b] = hsvToRgb(hsv);
  const part = (n: number) => n.toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

export function hexToHsv(hex: string): HSV {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  return rgbToHsv(
    parseInt(full.slice(0, 2), 16) || 0,
    parseInt(full.slice(2, 4), 16) || 0,
    parseInt(full.slice(4, 6), 16) || 0,
  );
}

export class ColorWheel {
  readonly element: HTMLElement;

  private readonly wheel: HTMLCanvasElement;
  private readonly wheelCtx: CanvasRenderingContext2D;
  private readonly valueSlider: HTMLInputElement;
  private readonly swatch: HTMLElement;
  private readonly readout: HTMLElement;

  private hsv: HSV = { h: 0, s: 0, v: 1 };
  private size = 200;
  /** The wheel's colours never change, so it is drawn once and reused. */
  private wheelRendered = false;

  constructor(
    initial: string,
    private readonly onChange: (hex: string) => void,
  ) {
    this.hsv = hexToHsv(initial);

    this.wheel = el('canvas', { class: 'wheel-canvas' });
    const ctx = this.wheel.getContext('2d');
    if (!ctx) throw new Error('2D canvas is unavailable');
    this.wheelCtx = ctx;

    this.valueSlider = el('input', { class: 'slider', type: 'range', min: 0, max: 100, step: 1 });
    this.valueSlider.value = String(Math.round(this.hsv.v * 100));
    this.valueSlider.addEventListener('input', () => {
      this.hsv.v = Number(this.valueSlider.value) / 100;
      this.emit();
      this.draw();
    });

    this.swatch = el('div', { class: 'wheel-swatch' });
    this.readout = el('span', { class: 'wheel-readout' });

    this.element = el('div', { class: 'color-wheel' }, [
      this.wheel,
      el('div', { class: 'wheel-row' }, [this.swatch, this.readout]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Brightness' }),
        this.valueSlider,
      ]),
    ]);

    this.bind();
  }

  get hex(): string {
    return hsvToHex(this.hsv);
  }

  setColor(hex: string): void {
    this.hsv = hexToHsv(hex);
    this.valueSlider.value = String(Math.round(this.hsv.v * 100));
    this.draw();
  }

  private emit(): void {
    this.onChange(this.hex);
  }

  private bind(): void {
    const pick = (clientX: number, clientY: number) => {
      const rect = this.wheel.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const dx = clientX - rect.left - cx;
      const dy = clientY - rect.top - cy;
      const radius = Math.min(cx, cy);

      const distance = Math.hypot(dx, dy);
      // Past the rim the saturation simply pins, so a drag that slips off the
      // edge keeps working instead of jumping.
      this.hsv.s = Math.min(1, distance / radius);
      let angle = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
      if (angle < 0) angle += 360;
      this.hsv.h = angle;

      this.emit();
      this.draw();
    };

    let active: number | null = null;
    this.wheel.addEventListener(
      'pointerdown',
      (e) => {
        e.preventDefault();
        active = e.pointerId;
        this.wheel.setPointerCapture?.(e.pointerId);
        pick(e.clientX, e.clientY);
      },
      { passive: false },
    );
    this.wheel.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerId !== active) return;
        e.preventDefault();
        pick(e.clientX, e.clientY);
      },
      { passive: false },
    );
    const release = (e: PointerEvent) => {
      if (e.pointerId !== active) return;
      active = null;
      if (this.wheel.hasPointerCapture?.(e.pointerId)) this.wheel.releasePointerCapture(e.pointerId);
    };
    this.wheel.addEventListener('pointerup', release);
    this.wheel.addEventListener('pointercancel', release);
  }

  /** Must be called once the element is in the document and has a width. */
  layout(): void {
    const available = this.element.clientWidth || 240;
    this.size = Math.max(160, Math.min(260, available - 8));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.wheel.style.width = `${this.size}px`;
    this.wheel.style.height = `${this.size}px`;
    this.wheel.width = Math.round(this.size * dpr);
    this.wheel.height = Math.round(this.size * dpr);
    this.wheelCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.wheelRendered = false;
    this.draw();
  }

  private renderWheel(): void {
    const { wheelCtx: ctx } = this;
    const size = this.size;
    const radius = size / 2;

    // Hue sweep first, then a white radial gradient on top for saturation.
    // Painting narrow arcs avoids a per-pixel loop, which matters because
    // this runs on every brightness change.
    ctx.clearRect(0, 0, size, size);
    for (let deg = 0; deg < 360; deg += 1) {
      const start = ((deg - 90.5) * Math.PI) / 180;
      const end = ((deg - 88.5) * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(radius, radius);
      ctx.arc(radius, radius, radius, start, end);
      ctx.closePath();
      ctx.fillStyle = hsvToHex({ h: deg, s: 1, v: this.hsv.v });
      ctx.fill();
    }

    const grad = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius);
    const centre = hsvToHex({ h: 0, s: 0, v: this.hsv.v });
    grad.addColorStop(0, centre);
    grad.addColorStop(1, `${centre}00`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(radius, radius, radius, 0, Math.PI * 2);
    ctx.fill();

    this.wheelRendered = true;
  }

  private draw(): void {
    // The wheel itself depends on value, so it is rebuilt whenever that moves.
    if (!this.wheelRendered) this.renderWheel();
    else this.renderWheel();

    const { wheelCtx: ctx } = this;
    const radius = this.size / 2;
    const angle = ((this.hsv.h - 90) * Math.PI) / 180;
    const x = radius + Math.cos(angle) * this.hsv.s * radius;
    const y = radius + Math.sin(angle) * this.hsv.s * radius;

    // A ring, not a dot, so the colour underneath stays visible.
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const hex = this.hex;
    this.swatch.style.background = hex;
    this.readout.textContent = hex.toUpperCase();
  }
}
