import { BRIGHT_MAX_HZ, BRIGHT_MIN_HZ } from './types';

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

export const midiToHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
export const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440);

const BRIGHT_RATIO = Math.log(BRIGHT_MAX_HZ / BRIGHT_MIN_HZ);
export const brightToHz = (b: number): number => BRIGHT_MIN_HZ * Math.exp(clamp(b, 0, 1) * BRIGHT_RATIO);
export const hzToBright = (hz: number): number =>
  clamp(Math.log(Math.max(hz, BRIGHT_MIN_HZ) / BRIGHT_MIN_HZ) / BRIGHT_RATIO, 0, 1);

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function noteName(midi: number): string {
  const r = Math.round(midi);
  return `${NOTE_NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`;
}

export function median(values: ArrayLike<number>): number {
  const arr = Array.from(values).filter((v) => Number.isFinite(v));
  if (arr.length === 0) return NaN;
  arr.sort((a, b) => a - b);
  const mid = arr.length >> 1;
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

/** Peak absolute sample value. */
export function peak(buf: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > p) p = a;
  }
  return p;
}

export function round(x: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(x * f) / f;
}
