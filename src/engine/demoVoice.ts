import { sampleCurve } from './curve';
import { SVF } from './dsp';
import { makeRng } from './rng';
import type { Curve } from './types';

/**
 * A tiny formant voice synthesiser. It produces "vocal imitations" (a pew, a
 * whistle, a kshhh...) so that the whole voice -> sound pipeline can be tried
 * and tested without a microphone. They are deliberately voice-like, not clean.
 */

type Pairs = [number, number][];
const c = (pairs: Pairs): Curve => pairs.map(([t, v]) => ({ t, v }));

const VOWELS = {
  i: [270, 2290, 3010],
  e: [530, 1840, 2480],
  a: [730, 1090, 2440],
  o: [570, 840, 2410],
  u: [300, 870, 2240],
} as const;
type Vowel = keyof typeof VOWELS;

export interface VoiceSpec {
  duration: number;
  /** Fundamental in Hz. */
  f0: Pairs;
  /** Loudness 0..1. */
  amp: Pairs;
  /** Vowel morph: list of [t, vowel]. */
  vowels: [number, Vowel][];
  /** Breathiness 0..1 (aspiration noise mixed into the voice). */
  breath?: Pairs;
  /** Fricative noise level 0..1 and its centre frequency in Hz. */
  fric?: Pairs;
  fricHz?: Pairs;
  /** Whistle: replaces the voice with a near-sine. */
  whistle?: boolean;
}

export interface DemoVoice {
  id: string;
  label: string;
  spec: VoiceSpec;
}

export const DEMO_VOICES: readonly DemoVoice[] = [
  {
    id: 'pew',
    label: '“Pew!”',
    spec: {
      duration: 0.42,
      f0: [[0, 620], [0.3, 330], [1, 170]],
      amp: [[0, 0], [0.06, 1], [0.5, 0.65], [1, 0]],
      vowels: [[0, 'i'], [0.45, 'u'], [1, 'u']],
      fric: [[0, 0.9], [0.05, 0], [1, 0]],
      fricHz: [[0, 2500], [1, 2500]],
      breath: [[0, 0.1], [1, 0.15]],
    },
  },
  {
    id: 'bwoop',
    label: '“Bwoooop ↑”',
    spec: {
      duration: 0.85,
      f0: [[0, 140], [0.7, 520], [1, 600]],
      amp: [[0, 0], [0.08, 0.9], [0.8, 1], [1, 0]],
      vowels: [[0, 'u'], [0.6, 'o'], [1, 'a']],
      breath: [[0, 0.08], [1, 0.08]],
    },
  },
  {
    id: 'kshh',
    label: '“Kshhhh”',
    spec: {
      duration: 1.0,
      f0: [[0, 120], [1, 100]],
      amp: [[0, 0], [0.03, 1], [0.25, 0.7], [1, 0]],
      vowels: [[0, 'a'], [1, 'a']],
      breath: [[0, 1], [1, 1]],
      fric: [[0, 1], [1, 1]],
      fricHz: [[0, 4200], [0.3, 2800], [1, 1500]],
    },
  },
  {
    id: 'boing',
    label: '“Boi-oi-oing”',
    spec: {
      duration: 0.95,
      f0: [[0, 180], [0.08, 300], [0.16, 200], [0.26, 290], [0.36, 210], [0.48, 280], [0.62, 230], [1, 255]],
      amp: [[0, 0], [0.04, 1], [0.6, 0.7], [1, 0]],
      vowels: [[0, 'o'], [0.3, 'i'], [1, 'i']],
      breath: [[0, 0.05], [1, 0.05]],
    },
  },
  {
    id: 'whistle',
    label: 'Whistle ↗',
    spec: {
      duration: 0.8,
      f0: [[0, 1100], [0.6, 1700], [1, 1800]],
      amp: [[0, 0], [0.1, 0.9], [0.85, 0.9], [1, 0]],
      vowels: [[0, 'u'], [1, 'u']],
      breath: [[0, 0.05], [1, 0.05]],
      whistle: true,
    },
  },
  {
    id: 'sad',
    label: '“Wah-wah-wahhh”',
    spec: {
      duration: 1.6,
      f0: [
        [0, 247], [0.2, 247], [0.22, 233], [0.42, 233], [0.44, 220], [0.64, 220], [0.66, 208],
        [0.7, 214], [0.74, 202], [0.78, 214], [0.82, 202], [0.86, 214], [0.9, 202], [1, 208],
      ],
      amp: [
        [0, 0], [0.03, 0.9], [0.18, 0.7], [0.21, 0.15], [0.24, 0.9], [0.4, 0.7], [0.43, 0.15],
        [0.46, 0.9], [0.62, 0.7], [0.65, 0.15], [0.68, 1], [0.95, 0.6], [1, 0],
      ],
      vowels: [
        [0, 'u'], [0.08, 'a'], [0.2, 'u'], [0.3, 'a'], [0.42, 'u'], [0.52, 'a'], [0.64, 'u'], [0.76, 'a'], [1, 'o'],
      ],
      breath: [[0, 0.06], [1, 0.06]],
    },
  },
];

function vowelAt(vowels: [number, Vowel][], t: number, k: number): number {
  if (t <= vowels[0][0]) return VOWELS[vowels[0][1]][k];
  for (let i = 0; i < vowels.length - 1; i++) {
    const [ta, va] = vowels[i];
    const [tb, vb] = vowels[i + 1];
    if (t <= tb) {
      const f = tb > ta ? (t - ta) / (tb - ta) : 1;
      return VOWELS[va][k] + (VOWELS[vb][k] - VOWELS[va][k]) * f;
    }
  }
  return VOWELS[vowels[vowels.length - 1][1]][k];
}

/** Renders a voice spec to mono samples at `sampleRate`. */
export function renderVoice(spec: VoiceSpec, sampleRate = 44100, seed = 7): Float32Array {
  const n = Math.round(spec.duration * sampleRate);
  const f0 = sampleCurve(c(spec.f0), n);
  const amp = sampleCurve(c(spec.amp), n);
  const breath = sampleCurve(c(spec.breath ?? [[0, 0], [1, 0]]), n);
  const fric = sampleCurve(c(spec.fric ?? [[0, 0], [1, 0]]), n);
  const fricHz = sampleCurve(c(spec.fricHz ?? [[0, 3000], [1, 3000]]), n);
  const rng = makeRng(seed);
  const formants = [new SVF(sampleRate), new SVF(sampleRate), new SVF(sampleRate)];
  const formantGain = [1, 0.6, 0.3];
  const fricFilter = new SVF(sampleRate);
  const out = new Float32Array(n);
  let phase = 0;
  let jitter = 0;
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    // Natural pitch jitter makes it sound less like a synth.
    jitter += (rng() - 0.5) * 0.02 - jitter * 0.01;
    const hz = f0[i] * (1 + jitter * 0.3);
    phase += hz / sampleRate;
    if (phase >= 1) phase -= 1;
    const noiseSample = rng() * 2 - 1;
    let voice: number;
    if (spec.whistle) {
      voice = Math.sin(2 * Math.PI * phase) * 0.8 + noiseSample * breath[i] * 0.3;
    } else {
      // Glottal-ish pulse: a saw with a softened edge, plus aspiration.
      const glottal = (phase < 0.6 ? phase / 0.6 : (1 - phase) / 0.4) * 2 - 1;
      const src = glottal * (1 - breath[i]) + noiseSample * breath[i] * 0.8;
      voice = 0;
      for (let k = 0; k < 3; k++) {
        const fHz = vowelAt(spec.vowels, t, k);
        formants[k].process(src, fHz, fHz / 90);
        voice += formants[k].band * formantGain[k];
      }
      voice *= 0.8;
    }
    fricFilter.process(rng() * 2 - 1, fricHz[i], 1.2);
    const fr = fricFilter.band * fric[i] * 1.2;
    out[i] = (voice + fr) * amp[i];
  }
  // Normalise to a comfortable level, like a real recording would be.
  let p = 0;
  for (let i = 0; i < n; i++) p = Math.max(p, Math.abs(out[i]));
  if (p > 0) for (let i = 0; i < n; i++) out[i] *= 0.7 / p;
  // Add a little room noise floor before and after, like a mic would capture.
  const padN = Math.round(0.15 * sampleRate);
  const padded = new Float32Array(n + padN * 2);
  for (let i = 0; i < padded.length; i++) padded[i] = (rng() * 2 - 1) * 0.0015;
  for (let i = 0; i < n; i++) padded[i + padN] += out[i];
  return padded;
}
