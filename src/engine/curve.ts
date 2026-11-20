import type { Curve, Point } from './types';
import { clamp } from './util';

/**
 * Returns a cleaned copy of a curve: finite values only, sorted by time,
 * times clamped to 0..1 and guaranteed to have points at t=0 and t=1.
 */
export function normalizeCurve(curve: Curve, fallback = 0): Curve {
  const pts = curve
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .map((p) => ({ t: clamp(p.t, 0, 1), v: p.v }))
    .sort((a, b) => a.t - b.t);
  if (pts.length === 0) return [{ t: 0, v: fallback }, { t: 1, v: fallback }];
  if (pts[0].t > 0) pts.unshift({ t: 0, v: pts[0].v });
  if (pts[pts.length - 1].t < 1) pts.push({ t: 1, v: pts[pts.length - 1].v });
  return pts;
}

/** Linear interpolation of a (sorted) curve at time t. */
export function evalCurve(curve: Curve, t: number): number {
  const n = curve.length;
  if (n === 0) return 0;
  if (t <= curve[0].t) return curve[0].v;
  if (t >= curve[n - 1].t) return curve[n - 1].v;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = curve[lo];
  const b = curve[hi];
  const span = b.t - a.t;
  return span <= 0 ? b.v : a.v + ((t - a.t) / span) * (b.v - a.v);
}

/**
 * Samples a curve at `n` evenly spaced times in O(n + points), which is what the
 * synthesiser uses per audio block.
 */
export function sampleCurve(curve: Curve, n: number): Float32Array {
  const out = new Float32Array(n);
  if (n === 0) return out;
  if (curve.length === 0) return out;
  let seg = 0;
  const last = curve.length - 1;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    while (seg < last - 1 && curve[seg + 1].t <= t) seg++;
    const a = curve[seg];
    const b = curve[Math.min(seg + 1, last)];
    if (t <= a.t || a === b) out[i] = a.v;
    else if (t >= b.t) out[i] = b.v;
    else out[i] = a.v + ((t - a.t) / (b.t - a.t)) * (b.v - a.v);
  }
  return out;
}

function perpendicularDistance(p: Point, a: Point, b: Point, valueScale: number): number {
  // Distance measured in the value axis at p.t (vertical error), which is what
  // matters perceptually for an envelope.
  const span = b.t - a.t;
  const interp = span <= 0 ? a.v : a.v + ((p.t - a.t) / span) * (b.v - a.v);
  return Math.abs(p.v - interp) / valueScale;
}

function rdp(points: Point[], tolerance: number, valueScale: number): Point[] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpendicularDistance(points[i], points[s], points[e], valueScale);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tolerance) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Simplifies arbitrary (sorted) points with Ramer-Douglas-Peucker in the value axis. */
export function simplifyPoints(points: Point[], tolerance: number, valueScale = 1): Point[] {
  return rdp(points, tolerance, valueScale);
}

/**
 * Converts a dense per-frame series into a compact, editable breakpoint curve.
 * The tolerance is raised until the result fits within `maxPoints`.
 */
export function simplifySeries(
  values: ArrayLike<number>,
  opts: { tolerance: number; maxPoints: number; valueScale?: number; digits?: number },
): Curve {
  const n = values.length;
  const valueScale = opts.valueScale ?? 1;
  const digits = opts.digits ?? 3;
  if (n === 0) return [{ t: 0, v: 0 }, { t: 1, v: 0 }];
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) pts.push({ t: n === 1 ? 0 : i / (n - 1), v: values[i] });
  if (n === 1) pts.push({ t: 1, v: values[0] });
  let tol = opts.tolerance;
  let out = rdp(pts, tol, valueScale);
  let guard = 0;
  while (out.length > opts.maxPoints && guard++ < 40) {
    tol *= 1.35;
    out = rdp(pts, tol, valueScale);
  }
  const f = Math.pow(10, digits);
  return out.map((p) => ({ t: Math.round(p.t * 10000) / 10000, v: Math.round(p.v * f) / f }));
}

/** Mean absolute difference between two curves sampled at n points. */
export function curveDistance(a: Curve, b: Curve, n = 200): number {
  const sa = sampleCurve(a, n);
  const sb = sampleCurve(b, n);
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(sa[i] - sb[i]);
  return s / n;
}
