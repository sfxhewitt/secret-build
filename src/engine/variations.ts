import { normalizeCurve } from './curve';
import { MAX_DURATION, MIN_DURATION } from './patch';
import { makeRng } from './rng';
import type { Curve, Patch } from './types';
import { PITCH_MAX, PITCH_MIN } from './types';
import { clamp, round } from './util';

function jitterCurve(
  c: Curve,
  rng: () => number,
  opts: { add?: number; mul?: number; tilt?: number; time?: number; lo: number; hi: number },
): Curve {
  const tilt = (rng() - 0.5) * 2 * (opts.tilt ?? 0);
  const pts = c.map((p, i) => {
    let v = p.v * (1 + (rng() - 0.5) * 2 * (opts.mul ?? 0)) + (rng() - 0.5) * 2 * (opts.add ?? 0) + tilt * (p.t - 0.5);
    v = clamp(v, opts.lo, opts.hi);
    const interior = i > 0 && i < c.length - 1;
    const t = interior ? clamp(p.t + (rng() - 0.5) * 2 * (opts.time ?? 0), 0.001, 0.999) : p.t;
    return { t: round(t, 4), v: round(v, 3) };
  });
  return normalizeCurve(pts, opts.lo);
}

/**
 * Produces a natural-sounding sibling of a patch: same gesture, slightly
 * different performance. Game audio needs several takes of every sound so that
 * repeats do not sound robotic; this makes them on demand.
 */
export function mutate(patch: Patch, seed: number, amount = 0.5): Patch {
  const rng = makeRng(seed * 7919 + 17);
  const a = clamp(amount, 0, 1);
  return {
    ...patch,
    duration: round(clamp(patch.duration * (1 + (rng() - 0.5) * 0.4 * a), MIN_DURATION, MAX_DURATION), 3),
    transpose: clamp(patch.transpose + Math.round((rng() - 0.5) * 5 * a), -36, 36),
    pitch: jitterCurve(patch.pitch, rng, { add: 1.2 * a, tilt: 4 * a, time: 0.03 * a, lo: PITCH_MIN, hi: PITCH_MAX }),
    amp: jitterCurve(patch.amp, rng, { mul: 0.2 * a, time: 0.03 * a, lo: 0, hi: 1 }),
    noise: jitterCurve(patch.noise, rng, { add: 0.1 * a, lo: 0, hi: 1 }),
    bright: jitterCurve(patch.bright, rng, { add: 0.12 * a, tilt: 0.1 * a, lo: 0, hi: 1 }),
    drive: round(clamp(patch.drive + (rng() - 0.5) * 0.2 * a, 0, 1), 3),
    vibratoRate: round(clamp(patch.vibratoRate * (1 + (rng() - 0.5) * 0.4 * a), 0.5, 30), 2),
    seed: (Math.floor(rng() * 2147483646) + 1) | 0,
  };
}

export function makeVariations(patch: Patch, count: number, amount: number, baseSeed = 1): Patch[] {
  return Array.from({ length: count }, (_, i) => ({
    ...mutate(patch, baseSeed + i, amount),
    name: `${patch.name} ${String.fromCharCode(65 + (i % 26))}`,
  }));
}
