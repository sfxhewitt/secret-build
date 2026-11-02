import { describe, expect, it } from 'vitest';
import {
  analysisToPatch,
  analyze,
  curveDistance,
  decodePatch,
  decodeWav,
  defaultPatch,
  DEMO_VOICES,
  encodePatch,
  encodeWav,
  evalCurve,
  fillGaps,
  imitate,
  makeVariations,
  makeZip,
  crc32,
  mutate,
  normalizeCurve,
  PRESETS,
  render,
  renderVoice,
  sampleCurve,
  sanitizePatch,
  simplifySeries,
  STYLES,
  applyStyle,
  yin,
  median,
  midiToHz,
  hzToMidi,
  type Patch,
} from '../src/engine';

const SR = 44100;

function tone(freq: number, seconds: number, sr = SR, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * sr));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

function meanFinite(a: ArrayLike<number>, from = 0, to = a.length): number {
  let s = 0;
  let c = 0;
  for (let i = from; i < to; i++) if (Number.isFinite(a[i])) (s += a[i]), c++;
  return s / c;
}

describe('curves', () => {
  it('evaluates and samples linearly', () => {
    const c = [{ t: 0, v: 0 }, { t: 0.5, v: 10 }, { t: 1, v: 0 }];
    expect(evalCurve(c, 0.25)).toBeCloseTo(5);
    expect(evalCurve(c, 0.75)).toBeCloseTo(5);
    const s = sampleCurve(c, 5);
    expect(Array.from(s)).toEqual([0, 5, 10, 5, 0]);
  });
  it('normalizes unsorted / partial curves', () => {
    const c = normalizeCurve([{ t: 0.7, v: 2 }, { t: 0.2, v: 1 }, { t: NaN, v: 3 }]);
    expect(c[0]).toEqual({ t: 0, v: 1 });
    expect(c[c.length - 1]).toEqual({ t: 1, v: 2 });
    expect(c.map((p) => p.t)).toEqual([0, 0.2, 0.7, 1]);
  });
  it('simplifies dense series within tolerance and point budget', () => {
    const n = 300;
    const series = new Float32Array(n);
    for (let i = 0; i < n; i++) series[i] = Math.sin((i / n) * Math.PI * 2);
    const c = simplifySeries(series, { tolerance: 0.02, maxPoints: 30 });
    expect(c.length).toBeLessThanOrEqual(30);
    const back = sampleCurve(c, n);
    let maxErr = 0;
    for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(back[i] - series[i]));
    expect(maxErr).toBeLessThan(0.08);
  });
  it('fills gaps by interpolation and returns null when empty', () => {
    const f = fillGaps(new Float32Array([NaN, 2, NaN, 4, NaN]))!;
    expect(Array.from(f)).toEqual([2, 2, 3, 4, 4]);
    expect(fillGaps(new Float32Array([NaN, NaN]))).toBeNull();
  });
});

describe('pitch tracking (YIN)', () => {
  for (const hz of [80, 220, 440, 1000, 2000]) {
    it(`finds ${hz} Hz`, () => {
      const sr = 22050;
      const frame = Float64Array.from(tone(hz, 1024 / sr + 0.001, sr).subarray(0, 1024));
      const r = yin(frame, sr);
      expect(Math.abs(hzToMidi(r.f0) - hzToMidi(hz))).toBeLessThan(0.15);
      expect(r.aperiodicity).toBeLessThan(0.1);
    });
  }
  it('reports noise as aperiodic', () => {
    let s = 1;
    const frame = new Float64Array(1024).map(() => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1);
    expect(yin(frame, 22050).aperiodicity).toBeGreaterThan(0.3);
  });
});

describe('analysis', () => {
  it('measures a steady tone and trims silence', () => {
    const sig = new Float32Array(SR); // 1 s with tone in the middle 0.5 s
    sig.set(tone(330, 0.5), Math.round(0.25 * SR));
    const a = analyze(sig, SR);
    expect(a.duration).toBeGreaterThan(0.45);
    expect(a.duration).toBeLessThan(0.62);
    expect(a.startSeconds).toBeGreaterThan(0.2);
    expect(a.voicedRatio).toBeGreaterThan(0.9);
    expect(meanFinite(a.pitch, 5, a.pitch.length - 5)).toBeCloseTo(hzToMidi(330), 0);
    expect(meanFinite(a.noise, 5, a.noise.length - 5)).toBeLessThan(0.1);
  });
  it('follows a glide', () => {
    const n = SR;
    const sig = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const f = 200 * Math.pow(4, i / n); // 200 -> 800 Hz
      ph += f / SR;
      sig[i] = 0.5 * Math.sin(2 * Math.PI * ph);
    }
    const { patch } = imitate(sig, SR);
    const start = evalCurve(patch.pitch, 0.05);
    const end = evalCurve(patch.pitch, 0.95);
    expect(end - start).toBeGreaterThan(20); // two octaves = 24 semitones
    expect(Math.abs(start - hzToMidi(200 * Math.pow(4, 0.05)))).toBeLessThan(1.5);
  });
  it('handles a completely silent input', () => {
    const a = analyze(new Float32Array(SR / 2), SR);
    expect(Math.max(...a.amp)).toBe(0);
    const p = analysisToPatch(a);
    expect(() => render(p)).not.toThrow();
  });
  it('handles a very short input and other sample rates', () => {
    const a = analyze(tone(440, 0.02, 48000), 48000);
    expect(a.amp.length).toBeGreaterThan(0);
    const b = analyze(tone(440, 0.4, 16000), 16000);
    expect(meanFinite(b.pitch, 3, b.pitch.length - 3)).toBeCloseTo(69, 0);
  });
});

describe('demo voices -> patches (the core loop)', () => {
  const results = Object.fromEntries(
    DEMO_VOICES.map((d) => [d.id, imitate(renderVoice(d.spec), SR, d.id)]),
  );
  it('pew falls in pitch and starts noisy', () => {
    const { patch } = results.pew;
    expect(evalCurve(patch.pitch, 0.1) - evalCurve(patch.pitch, 0.9)).toBeGreaterThan(12);
    expect(evalCurve(patch.noise, 0.0)).toBeGreaterThan(0.4);
    expect(evalCurve(patch.noise, 0.5)).toBeLessThan(0.2);
  });
  it('bwoop rises', () => {
    const { patch } = results.bwoop;
    expect(evalCurve(patch.pitch, 0.85) - evalCurve(patch.pitch, 0.1)).toBeGreaterThan(18);
  });
  it('kshh becomes a noise gesture', () => {
    const { patch, analysis } = results.kshh;
    expect(analysis.voicedRatio).toBeLessThan(0.1);
    expect(meanFinite(sampleCurve(patch.noise, 50))).toBeGreaterThan(0.9);
  });
  it('whistle is detected as nearly pure and picks a sine', () => {
    const { patch } = results.whistle;
    expect(patch.wave).toBe('sine');
    expect(Math.abs(evalCurve(patch.pitch, 0.5) - hzToMidi(1100 + (1700 - 1100) * (0.5 / 0.6)))).toBeLessThan(1.5);
  });
  it('wah-wah steps down', () => {
    const { patch } = results.sad;
    expect(evalCurve(patch.pitch, 0.1)).toBeGreaterThan(evalCurve(patch.pitch, 0.55));
  });
  it('patches stay compact enough to edit by hand', () => {
    for (const { patch } of Object.values(results)) {
      for (const lane of ['pitch', 'amp', 'noise', 'bright'] as const) {
        expect(patch[lane].length).toBeGreaterThanOrEqual(2);
        expect(patch[lane].length).toBeLessThanOrEqual(48);
      }
    }
  });
});

describe('synthesis', () => {
  it('is deterministic', () => {
    const p = PRESETS[4];
    expect(render(p)).toEqual(render(p));
  });
  it('produces clean, normalised output for every preset and style', () => {
    for (const base of PRESETS) {
      for (const s of STYLES) {
        const out = render(applyStyle(base, s, base.wave));
        let peak = 0;
        let finite = true;
        for (const v of out) {
          if (!Number.isFinite(v)) finite = false;
          peak = Math.max(peak, Math.abs(v));
        }
        expect(finite, `${base.name}/${s.id}`).toBe(true);
        expect(peak).toBeGreaterThan(0.5);
        expect(peak).toBeLessThanOrEqual(0.9);
        expect(out.length).toBeGreaterThanOrEqual(Math.round(base.duration * SR) - 1);
      }
    }
  });
  it('round-trips: render a patch, analyse it, get the gesture back', () => {
    const p: Patch = {
      ...defaultPatch(),
      wave: 'triangle',
      duration: 0.8,
      pitch: [{ t: 0, v: 76 }, { t: 1, v: 60 }],
      amp: [{ t: 0, v: 0.2 }, { t: 0.2, v: 1 }, { t: 1, v: 0.3 }],
      bright: [{ t: 0, v: 0.5 }, { t: 1, v: 0.5 }],
    };
    const back = analysisToPatch(analyze(render(p), SR));
    expect(Math.abs(back.duration - p.duration)).toBeLessThan(0.06);
    const inner = (c: Patch['pitch']) => c.filter(() => true);
    expect(Math.abs(evalCurve(inner(back.pitch), 0.5) - 68)).toBeLessThan(1);
    expect(curveDistance(back.amp, p.amp)).toBeLessThan(0.12);
    expect(meanFinite(sampleCurve(back.noise, 50), 5, 45)).toBeLessThan(0.1);
  });
  it('noise brightness round-trips through analysis', () => {
    for (const b of [0.3, 0.5, 0.7]) {
      const p: Patch = { ...defaultPatch(), duration: 0.6, amp: [{ t: 0, v: 1 }, { t: 1, v: 1 }], noise: [{ t: 0, v: 1 }, { t: 1, v: 1 }], bright: [{ t: 0, v: b }, { t: 1, v: b }] };
      const a = analyze(render(p), SR);
      expect(Math.abs(meanFinite(a.bright, 5, a.bright.length - 5) - b)).toBeLessThan(0.08);
      expect(meanFinite(a.noise, 5, a.noise.length - 5)).toBeGreaterThan(0.85);
    }
  });
  it('transpose shifts the measured pitch', () => {
    const p: Patch = { ...defaultPatch(), wave: 'sine', duration: 0.5, pitch: [{ t: 0, v: 60 }, { t: 1, v: 60 }], amp: [{ t: 0, v: 1 }, { t: 1, v: 1 }], transpose: 7 };
    const a = analyze(render(p), SR);
    expect(median(a.pitch)).toBeCloseTo(67, 0);
  });
  it('effects add tails and reverse flips', () => {
    const base: Patch = { ...defaultPatch(), duration: 0.2 };
    const dry = render(base);
    const wet = render({ ...base, reverbMix: 0.5, echoMix: 0.4 });
    expect(wet.length).toBeGreaterThan(dry.length);
    const rev = render({ ...base, reverse: true });
    expect(rev.length).toBe(dry.length);
    // Reversed sound ends loud (the attack is now at the end).
    const energy = (a: Float32Array, s: number, e: number) => a.slice(s, e).reduce((x, v) => x + v * v, 0);
    const q = Math.floor(rev.length / 4);
    expect(energy(rev, 3 * q, rev.length)).toBeGreaterThan(energy(rev, 0, q));
  });
  it('midi conversions are inverse', () => {
    expect(midiToHz(69)).toBeCloseTo(440);
    expect(hzToMidi(midiToHz(51.3))).toBeCloseTo(51.3);
  });
});

describe('variations', () => {
  it('are deterministic, different and valid', () => {
    const p = PRESETS[0];
    expect(mutate(p, 3)).toEqual(mutate(p, 3));
    const takes = makeVariations(p, 6, 0.5, 42);
    expect(new Set(takes.map((t) => JSON.stringify(t))).size).toBe(6);
    for (const t of takes) {
      expect(sanitizePatch(t)).toEqual(t);
      expect(render(t).length).toBeGreaterThan(0);
    }
    expect(takes[0].name).toBe('Laser A');
  });
  it('amount 0 changes nothing but the seed and name', () => {
    const p = PRESETS[1];
    const m = mutate(p, 9, 0);
    expect(m.pitch).toEqual(normalizeCurve(p.pitch));
    expect(m.duration).toBe(p.duration);
  });
});

describe('patch validation and sharing', () => {
  it('sanitises hostile input', () => {
    const p = sanitizePatch({ duration: 1e9, wave: 'evil', pitch: 'x', amp: [{ t: 5, v: 9 }], name: 42, transpose: NaN });
    expect(p.duration).toBe(8);
    expect(p.wave).toBe(defaultPatch().wave);
    expect(p.amp.every((pt) => pt.v <= 1 && pt.t <= 1)).toBe(true);
    expect(p.transpose).toBe(0);
    expect(sanitizePatch(null)).toEqual(defaultPatch());
  });
  it('round-trips through a share token', async () => {
    for (const preset of PRESETS) {
      const token = await encodePatch(preset);
      expect(token).toMatch(/^[zj][A-Za-z0-9_-]+$/);
      expect(token.length).toBeLessThan(1200);
      expect(await decodePatch(token)).toEqual(sanitizePatch(preset));
    }
  });
  it('rejects garbage tokens', async () => {
    await expect(decodePatch('qqqq')).rejects.toThrow();
    await expect(decodePatch('zAAAA')).rejects.toThrow();
  });
  it('every preset is already valid', () => {
    for (const p of PRESETS) expect(sanitizePatch(p)).toEqual(p);
  });
});

describe('file formats', () => {
  it('WAV encodes and decodes', () => {
    const s = tone(440, 0.1);
    const bytes = encodeWav(s, SR);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF');
    const d = decodeWav(bytes);
    expect(d.sampleRate).toBe(SR);
    expect(d.samples.length).toBe(s.length);
    for (let i = 0; i < s.length; i += 97) expect(d.samples[i]).toBeCloseTo(s[i], 3);
  });
  it('zip has valid structure and CRCs', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const a = new TextEncoder().encode('hello');
    const z = makeZip([{ name: 'a.txt', data: a }, { name: 'dir/b.wav', data: encodeWav(tone(100, 0.01), SR) }]);
    const v = new DataView(z.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    const eocd = z.length - 22;
    expect(v.getUint32(eocd, true)).toBe(0x06054b50);
    expect(v.getUint16(eocd + 10, true)).toBe(2);
    const cdOffset = v.getUint32(eocd + 16, true);
    expect(v.getUint32(cdOffset, true)).toBe(0x02014b50);
  });
});
