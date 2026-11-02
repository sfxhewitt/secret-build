import { withAlpha } from './lanes';

export interface WaveformOptions {
  color: string;
  playhead?: number | null; // 0..1
  /** Optional 0..1 marker drawn as a faint vertical line (e.g. end of dry sound). */
  marker?: number | null;
}

/** Draws a min/max waveform overview into a canvas sized by CSS. */
export function drawWaveform(canvas: HTMLCanvasElement, samples: Float32Array | null, opts: WaveformOptions): void {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const hgt = Math.max(1, Math.round(rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  if (canvas.width !== w * dpr || canvas.height !== hgt * dpr) {
    canvas.width = w * dpr;
    canvas.height = hgt * dpr;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  const mid = hgt / 2;
  ctx.strokeStyle = withAlpha(opts.color, 0.25);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid + 0.5);
  ctx.lineTo(w, mid + 0.5);
  ctx.stroke();
  if (!samples || samples.length === 0) return;

  let peakAll = 0;
  for (let i = 0; i < samples.length; i++) peakAll = Math.max(peakAll, Math.abs(samples[i]));
  const scale = peakAll > 0 ? (0.92 * mid) / peakAll : 0;
  const per = samples.length / w;
  const grad = ctx.createLinearGradient(0, 0, 0, hgt);
  grad.addColorStop(0, opts.color);
  grad.addColorStop(0.5, withAlpha(opts.color, 0.85));
  grad.addColorStop(1, opts.color);
  ctx.fillStyle = grad;
  for (let x = 0; x < w; x++) {
    const s = Math.floor(x * per);
    const e = Math.min(samples.length, Math.max(s + 1, Math.floor((x + 1) * per)));
    let mn = 0;
    let mx = 0;
    for (let i = s; i < e; i++) {
      const v = samples[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const top = mid - mx * scale;
    const bot = mid - mn * scale;
    ctx.fillRect(x, top, 1, Math.max(1, bot - top));
  }
  if (opts.marker !== null && opts.marker !== undefined && opts.marker > 0 && opts.marker < 1) {
    const x = Math.round(opts.marker * w) + 0.5;
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = withAlpha(opts.color, 0.5);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, hgt);
    ctx.stroke();
    ctx.restore();
  }
  if (opts.playhead !== null && opts.playhead !== undefined && opts.playhead >= 0 && opts.playhead <= 1) {
    const x = Math.round(opts.playhead * w) + 0.5;
    const css = getComputedStyle(canvas);
    ctx.strokeStyle = css.getPropertyValue('--playhead').trim() || '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, hgt);
    ctx.stroke();
  }
}
