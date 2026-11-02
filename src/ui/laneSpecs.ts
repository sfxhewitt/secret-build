import type { LaneId } from '../engine/types';
import { PITCH_MAX, PITCH_MIN } from '../engine/types';
import { brightToHz, hzToBright, midiToHz, noteName } from '../engine/util';
import type { LaneSpec } from './lanes';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const hz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)} kHz` : `${Math.round(f)} Hz`);

export const LANE_SPECS: Record<LaneId, LaneSpec> = {
  pitch: {
    id: 'pitch',
    label: 'Pitch',
    hint: 'the melody of your gesture',
    colorVar: '--lane-pitch',
    domain: [PITCH_MIN, PITCH_MAX],
    height: 150,
    fill: false,
    format: (v) => `${noteName(v)} · ${hz(midiToHz(v))}`,
    grid: (lo, hi) => {
      const out: { v: number; label?: string; strong?: boolean }[] = [];
      const fine = hi - lo <= 26;
      for (let m = Math.ceil(lo); m <= Math.floor(hi); m++) {
        if (m % 12 === 0) out.push({ v: m, label: noteName(m), strong: true });
        else if (fine) out.push({ v: m });
      }
      return out;
    },
  },
  amp: {
    id: 'amp',
    label: 'Loudness',
    hint: 'the envelope',
    colorVar: '--lane-amp',
    domain: [0, 1],
    height: 96,
    fill: true,
    format: pct,
    grid: () => [{ v: 0.25 }, { v: 0.5, label: '50%' }, { v: 0.75 }],
  },
  noise: {
    id: 'noise',
    label: 'Noise',
    hint: 'tone ↔ hiss',
    colorVar: '--lane-noise',
    domain: [0, 1],
    height: 80,
    fill: true,
    format: (v) => (v < 0.05 ? 'pure tone' : v > 0.95 ? 'pure noise' : `${pct(v)} noise`),
    grid: () => [{ v: 0.5, label: 'mix' }],
  },
  bright: {
    id: 'bright',
    label: 'Brightness',
    hint: 'dark ↔ bright',
    colorVar: '--lane-bright',
    domain: [0, 1],
    height: 80,
    fill: true,
    format: (v) => hz(brightToHz(v)),
    grid: () => [
      { v: hzToBright(200), label: '200 Hz' },
      { v: hzToBright(1000), label: '1 kHz' },
      { v: hzToBright(5000), label: '5 kHz' },
    ],
  },
};
