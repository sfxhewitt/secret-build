import { defaultPatch } from './patch';
import type { Curve, Patch } from './types';

type Pairs = [number, number][];
const c = (pairs: Pairs): Curve => pairs.map(([t, v]) => ({ t, v }));

interface PresetDef extends Partial<Omit<Patch, 'pitch' | 'amp' | 'noise' | 'bright'>> {
  name: string;
  pitch: Pairs;
  amp: Pairs;
  noise?: Pairs;
  bright?: Pairs;
}

function preset(d: PresetDef): Patch {
  const { pitch, amp, noise, bright, ...rest } = d;
  return {
    ...defaultPatch(),
    ...rest,
    pitch: c(pitch),
    amp: c(amp),
    noise: c(noise ?? [[0, 0], [1, 0]]),
    bright: c(bright ?? [[0, 0.6], [1, 0.5]]),
  };
}

/** Hand-built starting points, so the app is useful even without a microphone. */
export const PRESETS: readonly Patch[] = [
  preset({
    name: 'Laser',
    duration: 0.32,
    wave: 'saw',
    pitch: [[0, 96], [0.25, 82], [1, 62]],
    amp: [[0, 0], [0.03, 1], [0.4, 0.6], [1, 0]],
    bright: [[0, 0.85], [1, 0.45]],
    echoMix: 0.3,
    echoTime: 0.07,
    echoFeedback: 0.3,
  }),
  preset({
    name: 'Coin',
    duration: 0.38,
    wave: 'square',
    pitch: [[0, 83], [0.22, 83], [0.23, 88], [1, 88]],
    amp: [[0, 0], [0.02, 0.9], [0.22, 0.8], [0.25, 1], [1, 0]],
    bright: [[0, 0.7], [1, 0.6]],
    crush: 0.25,
  }),
  preset({
    name: 'Jump',
    duration: 0.3,
    wave: 'square',
    pitch: [[0, 60], [0.6, 76], [1, 79]],
    amp: [[0, 0], [0.05, 1], [0.7, 0.7], [1, 0]],
    bright: [[0, 0.55], [1, 0.65]],
  }),
  preset({
    name: 'Power-up',
    duration: 0.9,
    wave: 'triangle',
    quantize: true,
    pitch: [[0, 60], [1, 96]],
    amp: [[0, 0], [0.04, 0.9], [0.85, 0.9], [1, 0]],
    vibratoDepth: 1.2,
    vibratoRate: 14,
    echoMix: 0.25,
    echoTime: 0.11,
  }),
  preset({
    name: 'Explosion',
    duration: 1.4,
    wave: 'saw',
    pitch: [[0, 40], [1, 28]],
    amp: [[0, 0], [0.01, 1], [0.15, 0.7], [1, 0]],
    noise: [[0, 1], [1, 0.9]],
    bright: [[0, 0.75], [0.2, 0.5], [1, 0.2]],
    drive: 0.5,
    sub: 0.9,
    reverbMix: 0.35,
    reverbSize: 0.85,
  }),
  preset({
    name: 'Punch',
    duration: 0.22,
    wave: 'sine',
    pitch: [[0, 55], [0.3, 40], [1, 33]],
    amp: [[0, 0], [0.01, 1], [0.3, 0.5], [1, 0]],
    noise: [[0, 0.8], [0.1, 0.3], [1, 0.1]],
    bright: [[0, 0.7], [1, 0.25]],
    drive: 0.6,
    sub: 0.5,
  }),
  preset({
    name: 'Whoosh',
    duration: 0.8,
    wave: 'sine',
    pitch: [[0, 60], [1, 60]],
    amp: [[0, 0], [0.55, 1], [1, 0]],
    noise: [[0, 1], [1, 1]],
    bright: [[0, 0.35], [0.55, 0.72], [1, 0.3]],
    resonance: 0.55,
  }),
  preset({
    name: 'Alarm',
    duration: 1.2,
    wave: 'square',
    pitch: [[0, 81], [0.25, 81], [0.2501, 76], [0.5, 76], [0.5001, 81], [0.75, 81], [0.7501, 76], [1, 76]],
    amp: [[0, 0], [0.02, 0.8], [0.98, 0.8], [1, 0]],
    bright: [[0, 0.6], [1, 0.6]],
  }),
  preset({
    name: 'UFO',
    duration: 1.6,
    wave: 'triangle',
    pitch: [[0, 70], [0.5, 82], [1, 66]],
    amp: [[0, 0], [0.1, 0.8], [0.9, 0.8], [1, 0]],
    vibratoDepth: 2.5,
    vibratoRate: 11,
    reverbMix: 0.3,
  }),
  preset({
    name: 'Blip',
    duration: 0.09,
    wave: 'sine',
    pitch: [[0, 93], [1, 95]],
    amp: [[0, 0], [0.08, 1], [1, 0]],
    bright: [[0, 0.5], [1, 0.5]],
    reverbMix: 0.1,
    reverbSize: 0.2,
  }),
];
