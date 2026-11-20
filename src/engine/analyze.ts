import { simplifySeries } from './curve';
import { fft, hann, medianFilter, resample, smooth } from './dsp';
import type { Analysis, Patch, Waveform } from './types';
import { PITCH_MAX, PITCH_MIN } from './types';
import { brightToHz, clamp, hzToBright, hzToMidi, median, midiToHz } from './util';
import { defaultPatch } from './patch';

export const ANALYSIS_RATE = 22050;
const WIN = 1024;
const HOP = 220; // ~10 ms
const F0_MIN = 55;
const F0_MAX = 2500;
const YIN_THRESHOLD = 0.15;
const SILENCE_DB = -42;
const TRIM_DB = -36;

export interface YinResult {
  f0: number; // Hz, NaN if none
  aperiodicity: number; // 0..1
}

/**
 * YIN pitch estimator (de Cheveigné & Kawahara 2002) with parabolic refinement.
 * `frame` must be at least `tauMax + integration` samples long.
 */
export function yin(frame: Float64Array, sampleRate: number, fMin = F0_MIN, fMax = F0_MAX): YinResult {
  const tauMin = Math.max(2, Math.floor(sampleRate / fMax));
  const tauMax = Math.min(Math.floor(frame.length / 2), Math.ceil(sampleRate / fMin));
  const w = frame.length - tauMax;
  const d = new Float64Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let j = 0; j < w; j++) {
      const diff = frame[j] - frame[j + tau];
      s += diff * diff;
    }
    d[tau] = s;
  }
  // Cumulative mean normalised difference.
  const c = new Float64Array(tauMax + 1);
  c[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau];
    c[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }
  let best = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (c[tau] < YIN_THRESHOLD) {
      while (tau + 1 <= tauMax && c[tau + 1] < c[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) {
    let minV = Infinity;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (c[tau] < minV) {
        minV = c[tau];
        best = tau;
      }
    }
  }
  if (best <= 0) return { f0: NaN, aperiodicity: 1 };
  let refined = best;
  if (best > 1 && best < tauMax) {
    const a = c[best - 1];
    const b = c[best];
    const cc = c[best + 1];
    const denom = a - 2 * b + cc;
    if (denom > 0) refined = best + (0.5 * (a - cc)) / denom;
  }
  return { f0: sampleRate / refined, aperiodicity: clamp(c[best], 0, 1) };
}

/** Measures a recording frame by frame. Accepts any sample rate; mono input. */
export function analyze(input: Float32Array, sampleRate: number): Analysis {
  const sr = ANALYSIS_RATE;
  let x = resample(input, sampleRate, sr);

  // Remove DC and sub-audible rumble with a one-pole high-pass (~40 Hz).
  {
    const out = new Float32Array(x.length);
    const r = Math.exp((-2 * Math.PI * 40) / sr);
    let px = 0;
    let py = 0;
    for (let i = 0; i < x.length; i++) {
      const y = x[i] - px + r * py;
      px = x[i];
      py = y;
      out[i] = y;
    }
    x = out;
  }

  const pad = WIN / 2;
  const padded = new Float64Array(x.length + WIN);
  for (let i = 0; i < x.length; i++) padded[i + pad] = x[i];
  const nFrames = Math.max(1, Math.floor(x.length / HOP) + 1);

  const rms = new Float32Array(nFrames);
  const ap = new Float32Array(nFrames);
  const f0 = new Float32Array(nFrames);
  const centroid = new Float32Array(nFrames);
  const flatness = new Float32Array(nFrames);
  const window = hann(WIN);
  const re = new Float64Array(WIN);
  const im = new Float64Array(WIN);
  const frame = new Float64Array(WIN);
  const binHz = sr / WIN;
  const flatLo = Math.floor(100 / binHz);
  const flatHi = Math.min(WIN / 2 - 1, Math.ceil(8000 / binHz));

  for (let f = 0; f < nFrames; f++) {
    const start = f * HOP; // in padded coordinates the frame is centred on sample f*HOP
    let sq = 0;
    for (let i = 0; i < WIN; i++) frame[i] = padded[start + i] ?? 0;
    // RMS over the central half-window for better time resolution.
    for (let i = WIN / 4; i < (3 * WIN) / 4; i++) sq += frame[i] * frame[i];
    rms[f] = Math.sqrt(sq / (WIN / 2));

    const y = yin(frame, sr);
    f0[f] = y.f0;
    ap[f] = y.aperiodicity;

    for (let i = 0; i < WIN; i++) {
      re[i] = frame[i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    let num = 0;
    let den = 0;
    let logSum = 0;
    let linSum = 0;
    let count = 0;
    for (let k = 1; k < WIN / 2; k++) {
      const mag = Math.hypot(re[k], im[k]);
      num += k * binHz * mag;
      den += mag;
      if (k >= flatLo && k <= flatHi) {
        const p = mag * mag + 1e-12;
        logSum += Math.log(p);
        linSum += p;
        count++;
      }
    }
    centroid[f] = den > 0 ? num / den : 0;
    flatness[f] = count > 0 ? Math.exp(logSum / count) / (linSum / count) : 1;
  }

  // Trim leading/trailing silence.
  let maxRms = 0;
  for (let f = 0; f < nFrames; f++) maxRms = Math.max(maxRms, rms[f]);
  const trimThresh = maxRms * Math.pow(10, TRIM_DB / 20);
  let first = 0;
  let last = nFrames - 1;
  if (maxRms > 0) {
    while (first < last && rms[first] < trimThresh) first++;
    while (last > first && rms[last] < trimThresh) last--;
  }
  first = Math.max(0, first - 1);
  last = Math.min(nFrames - 1, last + 2);
  const n = last - first + 1;

  const silence = maxRms * Math.pow(10, SILENCE_DB / 20);
  const voicedGate = maxRms * Math.pow(10, -30 / 20);
  const amp = new Float32Array(n);
  const pitch = new Float32Array(n);
  const noise = new Float32Array(n);
  const bright = new Float32Array(n);
  let audible = 0;
  let voiced = 0;
  let lastNoise = 0.5;
  let lastBright = 0.5;
  for (let i = 0; i < n; i++) {
    const f = first + i;
    const r = rms[f];
    amp[i] = maxRms > 0 && r > silence ? r / maxRms : 0;
    const isAudible = amp[i] > 0;
    if (isAudible) audible++;
    const isVoiced = isAudible && r > voicedGate && ap[f] < 0.3 && Number.isFinite(f0[f]);
    if (isVoiced) voiced++;
    pitch[i] = isVoiced ? clamp(hzToMidi(f0[f]), PITCH_MIN, PITCH_MAX) : NaN;
    if (isAudible) {
      const nYin = clamp((ap[f] - 0.1) / 0.3, 0, 1);
      const nFlat = clamp((flatness[f] - 0.04) / 0.36, 0, 1);
      lastNoise = Math.max(nYin, nFlat);
      lastBright = hzToBright(centroid[f]);
    }
    noise[i] = lastNoise;
    bright[i] = lastBright;
  }

  fixOctaveJumps(pitch);
  const pitchClean = medianFilter(pitch, 2);

  return {
    sampleRate: sr,
    hopSeconds: HOP / sr,
    duration: n * (HOP / sr),
    startSeconds: Math.max(0, (first * HOP - HOP / 2) / sr),
    amp,
    pitch: pitchClean,
    noise,
    bright,
    voicedRatio: audible > 0 ? voiced / audible : 0,
  };
}

/** Folds isolated octave errors (a classic YIN failure) back towards the local median. */
function fixOctaveJumps(pitch: Float32Array): void {
  const radius = 6;
  const copy = pitch.slice();
  for (let i = 0; i < pitch.length; i++) {
    if (!Number.isFinite(copy[i])) continue;
    const neighbours: number[] = [];
    for (let k = i - radius; k <= i + radius; k++) {
      if (k !== i && k >= 0 && k < copy.length && Number.isFinite(copy[k])) neighbours.push(copy[k]);
    }
    if (neighbours.length < 3) continue;
    const m = median(neighbours);
    const diff = copy[i] - m;
    if (Math.abs(diff - 12) < 2.5) pitch[i] = copy[i] - 12;
    else if (Math.abs(diff + 12) < 2.5) pitch[i] = copy[i] + 12;
  }
}

/** Fills NaN gaps by linear interpolation, holding the edge values. */
export function fillGaps(values: Float32Array): Float32Array | null {
  const out = values.slice();
  const idx: number[] = [];
  for (let i = 0; i < out.length; i++) if (Number.isFinite(out[i])) idx.push(i);
  if (idx.length === 0) return null;
  for (let i = 0; i < idx[0]; i++) out[i] = out[idx[0]];
  for (let i = idx[idx.length - 1] + 1; i < out.length; i++) out[i] = out[idx[idx.length - 1]];
  for (let j = 0; j < idx.length - 1; j++) {
    const a = idx[j];
    const b = idx[j + 1];
    for (let i = a + 1; i < b; i++) out[i] = out[a] + ((i - a) / (b - a)) * (out[b] - out[a]);
  }
  return out;
}

/**
 * Chooses an oscillator from how harmonically rich the voiced parts were:
 * spectral centroid divided by the fundamental. A whistle sits near 1 (sine);
 * a buzzy "bzzz" is way up (saw).
 */
export function pickWave(richness: number, voicedRatio: number): Waveform {
  if (voicedRatio < 0.25 || !Number.isFinite(richness)) return 'saw';
  if (richness < 1.6) return 'sine';
  if (richness < 3) return 'triangle';
  if (richness < 5.5) return 'square';
  return 'saw';
}

/** Median ratio of spectral centroid to f0 over voiced, audible frames. */
export function harmonicRichness(a: Analysis): number {
  const ratios: number[] = [];
  for (let i = 0; i < a.amp.length; i++) {
    if (a.amp[i] > 0.1 && Number.isFinite(a.pitch[i])) ratios.push(brightToHz(a.bright[i]) / midiToHz(a.pitch[i]));
  }
  return median(ratios);
}

/** Turns per-frame measurements into a compact, editable Patch. */
export function analysisToPatch(a: Analysis, name = 'My sound'): Patch {
  const base = defaultPatch();
  const amp = smooth(a.amp, 1);
  const noise = smooth(a.noise, 2);
  const bright = smooth(a.bright, 2);

  let pitch = fillGaps(a.pitch);
  if (!pitch) {
    // Nothing pitched (e.g. "kshhh"): let brightness drive the pitch so the
    // tonal layer still follows the gesture.
    pitch = new Float32Array(bright.length);
    for (let i = 0; i < bright.length; i++) {
      pitch[i] = clamp(hzToMidi(brightToHz(bright[i])) - 24, PITCH_MIN, PITCH_MAX);
    }
  }
  pitch = smooth(pitch, 1);

  // Where the sound is fully unvoiced it should be heard as noise, whatever
  // the frame-level estimate says.
  for (let i = 0; i < noise.length; i++) {
    if (a.voicedRatio < 0.1) noise[i] = Math.max(noise[i], 0.92);
    else if (!Number.isFinite(a.pitch[i]) && a.amp[i] > 0.15) noise[i] = Math.max(noise[i], 0.6);
  }


  return {
    ...base,
    name,
    duration: Math.max(0.05, Math.round(a.duration * 1000) / 1000),
    amp: simplifySeries(amp, { tolerance: 0.03, maxPoints: 48 }),
    pitch: simplifySeries(pitch, { tolerance: 0.35, maxPoints: 48, digits: 2 }),
    noise: simplifySeries(noise, { tolerance: 0.06, maxPoints: 24 }),
    bright: simplifySeries(bright, { tolerance: 0.03, maxPoints: 24 }),
    wave: pickWave(harmonicRichness(a), a.voicedRatio),
  };
}

/** Convenience: recording in, patch out. */
export function imitate(samples: Float32Array, sampleRate: number, name?: string): { analysis: Analysis; patch: Patch } {
  const analysis = analyze(samples, sampleRate);
  return { analysis, patch: analysisToPatch(analysis, name) };
}

