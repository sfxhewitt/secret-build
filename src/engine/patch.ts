import { normalizeCurve } from './curve';
import type { Curve, Patch } from './types';
import { PITCH_MAX, PITCH_MIN, WAVEFORMS } from './types';
import { clamp } from './util';

export const MAX_DURATION = 8;
export const MIN_DURATION = 0.03;

export function defaultPatch(): Patch {
  return {
    version: 1,
    name: 'Untitled',
    duration: 0.5,
    pitch: [
      { t: 0, v: 72 },
      { t: 1, v: 60 },
    ],
    amp: [
      { t: 0, v: 0 },
      { t: 0.05, v: 1 },
      { t: 1, v: 0 },
    ],
    noise: [
      { t: 0, v: 0 },
      { t: 1, v: 0 },
    ],
    bright: [
      { t: 0, v: 0.6 },
      { t: 1, v: 0.4 },
    ],
    wave: 'square',
    transpose: 0,
    contour: 1,
    quantize: false,
    vibratoRate: 6,
    vibratoDepth: 0,
    resonance: 0.2,
    sub: 0,
    drive: 0,
    crush: 0,
    echoMix: 0,
    echoTime: 0.18,
    echoFeedback: 0.35,
    reverbMix: 0,
    reverbSize: 0.5,
    reverse: false,
    seed: 1,
  };
}

export function clonePatch(p: Patch): Patch {
  return JSON.parse(JSON.stringify(p)) as Patch;
}

const num = (v: unknown, fallback: number, lo: number, hi: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;

function curve(v: unknown, fallback: Curve, lo: number, hi: number): Curve {
  if (!Array.isArray(v)) return fallback;
  const pts = v
    .filter((p): p is { t: number; v: number } => !!p && typeof p === 'object' && 't' in p && 'v' in p)
    .map((p) => ({ t: Number(p.t), v: clamp(Number(p.v), lo, hi) }))
    .slice(0, 256);
  const cleaned = normalizeCurve(pts, fallback[0]?.v ?? lo);
  return cleaned.length >= 2 ? cleaned : fallback;
}

/**
 * Validates untrusted input (a share link, a library entry, an imported file)
 * and returns a safe Patch. Unknown or out-of-range fields fall back to defaults.
 */
export function sanitizePatch(input: unknown): Patch {
  const d = defaultPatch();
  if (!input || typeof input !== 'object') return d;
  const o = input as Record<string, unknown>;
  return {
    version: 1,
    name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 60) : d.name,
    duration: num(o.duration, d.duration, MIN_DURATION, MAX_DURATION),
    pitch: curve(o.pitch, d.pitch, PITCH_MIN, PITCH_MAX),
    amp: curve(o.amp, d.amp, 0, 1),
    noise: curve(o.noise, d.noise, 0, 1),
    bright: curve(o.bright, d.bright, 0, 1),
    wave: WAVEFORMS.includes(o.wave as never) ? (o.wave as Patch['wave']) : d.wave,
    transpose: num(o.transpose, d.transpose, -36, 36),
    contour: num(o.contour, d.contour, 0, 3),
    quantize: typeof o.quantize === 'boolean' ? o.quantize : d.quantize,
    vibratoRate: num(o.vibratoRate, d.vibratoRate, 0.5, 30),
    vibratoDepth: num(o.vibratoDepth, d.vibratoDepth, 0, 3),
    resonance: num(o.resonance, d.resonance, 0, 1),
    sub: num(o.sub, d.sub, 0, 1),
    drive: num(o.drive, d.drive, 0, 1),
    crush: num(o.crush, d.crush, 0, 1),
    echoMix: num(o.echoMix, d.echoMix, 0, 1),
    echoTime: num(o.echoTime, d.echoTime, 0.02, 1),
    echoFeedback: num(o.echoFeedback, d.echoFeedback, 0, 0.9),
    reverbMix: num(o.reverbMix, d.reverbMix, 0, 1),
    reverbSize: num(o.reverbSize, d.reverbSize, 0, 1),
    reverse: typeof o.reverse === 'boolean' ? o.reverse : d.reverse,
    seed: num(o.seed, d.seed, 0, 2 ** 31 - 1) | 0,
  };
}
