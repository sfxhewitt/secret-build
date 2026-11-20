import { clamp } from './util';

/** Soft clipper. `amount` 0..1. */
export function applyDrive(buf: Float32Array, amount: number): void {
  if (amount <= 0) return;
  const g = 1 + amount * 9;
  const norm = 1 / Math.tanh(g);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * g) * norm;
}

/** Bit depth + sample-rate reduction. `amount` 0..1. */
export function applyCrush(buf: Float32Array, amount: number): void {
  if (amount <= 0) return;
  const bits = 16 - amount * 12.5;
  const levels = Math.pow(2, bits - 1);
  const hold = 1 + Math.floor(amount * amount * 22);
  let held = 0;
  for (let i = 0; i < buf.length; i++) {
    if (i % hold === 0) held = Math.round(buf[i] * levels) / levels;
    buf[i] = held;
  }
}

/** Tail length (seconds) an echo needs to decay by 60 dB. */
export function echoTail(time: number, feedback: number, mix: number): number {
  if (mix <= 0) return 0;
  const fb = clamp(feedback, 0.01, 0.9);
  return Math.min(4, time * (1 + Math.log(0.001) / Math.log(fb)));
}

/** Feedback delay with a gentle low-pass in the loop, so repeats darken naturally. */
export function applyEcho(buf: Float32Array, sampleRate: number, time: number, feedback: number, mix: number): void {
  if (mix <= 0) return;
  const d = Math.max(1, Math.round(time * sampleRate));
  const line = new Float32Array(d);
  let idx = 0;
  let lp = 0;
  const fb = clamp(feedback, 0, 0.9);
  for (let i = 0; i < buf.length; i++) {
    const delayed = line[idx];
    lp += 0.45 * (delayed - lp);
    line[idx] = buf[i] + lp * fb;
    idx = (idx + 1) % d;
    buf[i] = buf[i] + delayed * mix;
  }
}

export function reverbTail(size: number, mix: number): number {
  return mix <= 0 ? 0 : 0.4 + size * 3.2;
}

const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];

/** Mono Schroeder/Moorer-style reverb (Freeverb topology). */
export function applyReverb(buf: Float32Array, sampleRate: number, size: number, mix: number): void {
  if (mix <= 0) return;
  const scale = sampleRate / 44100;
  const feedback = 0.7 + clamp(size, 0, 1) * 0.27;
  const damp = 0.25;
  const combs = COMBS.map((l) => ({ buf: new Float32Array(Math.round(l * scale)), idx: 0, store: 0 }));
  const aps = ALLPASSES.map((l) => ({ buf: new Float32Array(Math.round(l * scale)), idx: 0 }));
  const gain = 0.015;
  for (let i = 0; i < buf.length; i++) {
    const input = buf[i] * gain;
    let out = 0;
    for (const c of combs) {
      const y = c.buf[c.idx];
      c.store = y * (1 - damp) + c.store * damp;
      c.buf[c.idx] = input + c.store * feedback;
      c.idx = (c.idx + 1) % c.buf.length;
      out += y;
    }
    for (const a of aps) {
      const bufout = a.buf[a.idx];
      a.buf[a.idx] = out + bufout * 0.5;
      a.idx = (a.idx + 1) % a.buf.length;
      out = bufout - out;
    }
    buf[i] = buf[i] * (1 - mix * 0.5) + out * mix * 3;
  }
}
