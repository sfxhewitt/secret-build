import { sampleCurve } from './curve';
import { SVF } from './dsp';
import { applyCrush, applyDrive, applyEcho, applyReverb, echoTail, reverbTail } from './effects';
import { makeRng } from './rng';
import type { Patch, Waveform } from './types';
import { brightToHz, clamp, median, midiToHz } from './util';

export const RENDER_RATE = 44100;
const OUTPUT_PEAK = 0.89; // -1 dBFS

function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

const PULSE_WIDTH = 0.25;
/** Noise cutoff relative to the brightness frequency (calibrated so analysis round-trips). */
export const NOISE_CUTOFF_RATIO = 1.4;

/** Gains that bring each waveform to roughly the same RMS loudness. */
const WAVE_GAIN: Record<Waveform, number> = {
  sine: 0.7,
  triangle: 0.85,
  square: 0.5,
  saw: 0.85,
  pulse: 0.58,
};

function oscSample(wave: Waveform, phase: number, dt: number): number {
  switch (wave) {
    case 'sine':
      return Math.sin(2 * Math.PI * phase);
    case 'triangle':
      return 1 - 4 * Math.abs(phase - 0.5);
    case 'saw':
      return 2 * phase - 1 - polyBlep(phase, dt);
    case 'square': {
      let v = phase < 0.5 ? 1 : -1;
      v += polyBlep(phase, dt);
      v -= polyBlep((phase + 0.5) % 1, dt);
      return v;
    }
    case 'pulse': {
      let v = phase < PULSE_WIDTH ? 1 : -1;
      v += polyBlep(phase, dt);
      v -= polyBlep((phase + 1 - PULSE_WIDTH) % 1, dt);
      return v - (2 * PULSE_WIDTH - 1);
    }
  }
}

/**
 * The effective pitch curve (MIDI) after contour, transpose, vibrato and
 * quantisation, sampled at `n` points. Exposed so the UI can draw what you hear.
 */
export function effectivePitch(patch: Patch, n: number, sampleRate = RENDER_RATE): Float32Array {
  const raw = sampleCurve(patch.pitch, n);
  const center = median(sampleCurve(patch.pitch, 256));
  const out = new Float32Array(n);
  const durSamples = patch.duration * sampleRate;
  for (let i = 0; i < n; i++) {
    let m = center + (raw[i] - center) * patch.contour + patch.transpose;
    if (patch.quantize) m = Math.round(m);
    if (patch.vibratoDepth > 0) {
      const tSec = n === 1 ? 0 : (i / (n - 1)) * (durSamples / sampleRate);
      m += patch.vibratoDepth * Math.sin(2 * Math.PI * patch.vibratoRate * tSec);
    }
    out[i] = clamp(m, 0, 135);
  }
  return out;
}

/** Renders a patch to mono samples. Deterministic for a given patch. */
export function render(patch: Patch, sampleRate = RENDER_RATE): Float32Array {
  const n = Math.max(1, Math.round(patch.duration * sampleRate));
  const tail = Math.round(
    (Math.max(echoTail(patch.echoTime, patch.echoFeedback, patch.echoMix), 0) +
      reverbTail(patch.reverbSize, patch.reverbMix)) *
      sampleRate,
  );
  const out = new Float32Array(n + tail);

  const pitch = effectivePitch(patch, n, sampleRate);
  const amp = sampleCurve(patch.amp, n);
  const noise = sampleCurve(patch.noise, n);
  const bright = sampleCurve(patch.bright, n);

  const rng = makeRng(patch.seed);
  const toneFilter = new SVF(sampleRate);
  const noiseFilter = new SVF(sampleRate);
  const noiseFilter2 = new SVF(sampleRate);
  const nyquist = sampleRate / 2;
  const waveGain = WAVE_GAIN[patch.wave];
  const noiseQ = 0.6 + patch.resonance * patch.resonance * 14;
  // Resonant noise gets louder at the peak; compensate so loudness stays put.
  const noiseResComp = 1 / (1 + patch.resonance * 1.6);
  let phase = 0;
  let subPhase = 0;

  for (let i = 0; i < n; i++) {
    const freq = Math.min(midiToHz(pitch[i]), nyquist * 0.9);
    const dt = freq / sampleRate;
    phase += dt;
    if (phase >= 1) phase -= Math.floor(phase);
    subPhase += dt * 0.5;
    if (subPhase >= 1) subPhase -= Math.floor(subPhase);

    let tone = oscSample(patch.wave, phase, dt) * waveGain;
    if (patch.sub > 0) tone += Math.sin(2 * Math.PI * subPhase) * 0.7 * patch.sub;
    const bHz = brightToHz(bright[i]);
    toneFilter.process(tone, clamp(bHz * 4, 250, 19000), 0.707);
    tone = toneFilter.low;

    const white = rng() * 2 - 1;
    const nCut = clamp(bHz * NOISE_CUTOFF_RATIO, 40, 19000);
    noiseFilter.process(white, nCut, noiseQ);
    noiseFilter2.process(noiseFilter.low, nCut, 0.707);
    const nGain = Math.min(10, 0.5 / (0.577 * Math.sqrt(clamp((2 * nCut) / sampleRate, 0.003, 1))));
    const noiseSig = noiseFilter2.low * nGain * noiseResComp;

    const nz = clamp(noise[i], 0, 1);
    out[i] = (tone * (1 - nz) + noiseSig * nz) * clamp(amp[i], 0, 1);
  }

  applyDrive(out, patch.drive);
  applyCrush(out, patch.crush);
  applyEcho(out, sampleRate, patch.echoTime, patch.echoFeedback, patch.echoMix);
  applyReverb(out, sampleRate, patch.reverbSize, patch.reverbMix);

  let result = trimTail(out, n);
  if (patch.reverse) result.reverse();
  result = fadeEdges(result, sampleRate);
  normalize(result, OUTPUT_PEAK);
  return result;
}

/** Drops the inaudible end of an effects tail (never cuts into the dry part). */
function trimTail(buf: Float32Array, minLength: number): Float32Array {
  let p = 0;
  for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]));
  if (p === 0) return buf.slice(0, minLength);
  const thresh = p * 0.0003; // about -70 dB
  let end = buf.length;
  while (end > minLength && Math.abs(buf[end - 1]) < thresh) end--;
  return buf.slice(0, end);
}

function fadeEdges(buf: Float32Array, sampleRate: number): Float32Array {
  const fin = Math.min(buf.length >> 2, Math.round(0.002 * sampleRate));
  const fout = Math.min(buf.length >> 2, Math.round(0.006 * sampleRate));
  for (let i = 0; i < fin; i++) buf[i] *= i / fin;
  for (let i = 0; i < fout; i++) buf[buf.length - 1 - i] *= i / fout;
  return buf;
}

function normalize(buf: Float32Array, target: number): void {
  let p = 0;
  for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]));
  if (p < 1e-9) return;
  const g = target / p;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
}
