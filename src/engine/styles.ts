import type { Patch, Waveform } from './types';

export type StyleSettings = Omit<Patch, 'version' | 'name' | 'duration' | 'pitch' | 'amp' | 'noise' | 'bright' | 'seed'>;

export interface Style {
  id: string;
  label: string;
  blurb: string;
  /** Wave to use; `null` keeps whatever the analysis picked. */
  wave: Waveform | null;
  settings: Omit<StyleSettings, 'wave'>;
}

const NEUTRAL: Omit<StyleSettings, 'wave'> = {
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
};

const style = (id: string, label: string, blurb: string, wave: Waveform | null, s: Partial<StyleSettings>): Style => ({
  id,
  label,
  blurb,
  wave,
  settings: { ...NEUTRAL, ...s },
});

/** One-tap "looks" that reinterpret the same vocal gesture in a different genre. */
export const STYLES: readonly Style[] = [
  style('clean', 'Clean', 'Your gesture, played straight', null, {}),
  style('retro', '8-bit', 'Chip-tune square, stepped pitch, crunchy', 'square', { transpose: 12, quantize: true, crush: 0.45 }),
  style('laser', 'Sci-fi', 'Bright saw, exaggerated sweep, slap echo', 'saw', {
    transpose: 24,
    contour: 1.8,
    echoMix: 0.35,
    echoTime: 0.09,
    echoFeedback: 0.4,
    reverbMix: 0.15,
  }),
  style('cartoon', 'Cartoon', 'Bouncy sine with big wobbly contour', 'sine', {
    transpose: 12,
    contour: 2.2,
    vibratoDepth: 0.4,
    vibratoRate: 7,
  }),
  style('monster', 'Monster', 'Low, growling, heavy sub', 'saw', {
    transpose: -12,
    contour: 0.8,
    drive: 0.7,
    sub: 0.8,
    reverbMix: 0.25,
    reverbSize: 0.7,
  }),
  style('robot', 'Robot', 'Pulse wave, stepped and bit-crushed', 'pulse', { quantize: true, crush: 0.6, drive: 0.3 }),
  style('magic', 'Magic', 'Shimmering, airy, long sparkle tail', 'triangle', {
    transpose: 24,
    vibratoDepth: 0.25,
    vibratoRate: 9,
    echoMix: 0.4,
    echoTime: 0.14,
    echoFeedback: 0.45,
    reverbMix: 0.5,
    reverbSize: 0.8,
  }),
  style('cinematic', 'Cinematic', 'Huge, dark and reverberant', 'saw', {
    transpose: -12,
    sub: 1,
    drive: 0.35,
    reverbMix: 0.6,
    reverbSize: 0.9,
  }),
  style('ui', 'UI blip', 'Tiny, clean, polite interface sound', 'sine', { transpose: 24, contour: 0.6, reverbMix: 0.1, reverbSize: 0.2 }),
];

export function applyStyle(patch: Patch, s: Style, analysedWave: Waveform): Patch {
  return { ...patch, ...s.settings, wave: s.wave ?? analysedWave };
}
