/** In-place iterative radix-2 complex FFT. `re` and `im` must have power-of-two length. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/**
 * Resamples with a windowed-sinc low-pass when downsampling, linear otherwise.
 * Quality is more than enough for feature analysis.
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input.slice();
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  if (ratio > 1) {
    // Anti-alias: sinc kernel with cutoff at the new Nyquist.
    const half = Math.ceil(4 * ratio);
    const fc = 0.5 / ratio;
    for (let i = 0; i < outLen; i++) {
      const center = i * ratio;
      const c = Math.floor(center);
      let acc = 0;
      let wsum = 0;
      for (let k = c - half; k <= c + half; k++) {
        if (k < 0 || k >= input.length) continue;
        const x = k - center;
        const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        const win = 0.5 + 0.5 * Math.cos((Math.PI * x) / (half + 1));
        const w = sinc * win;
        acc += input[k] * w;
        wsum += w;
      }
      out[i] = wsum !== 0 ? acc / wsum : 0;
    }
  } else {
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const k = Math.floor(pos);
      const f = pos - k;
      const a = input[k] ?? 0;
      const b = input[k + 1] ?? a;
      out[i] = a + (b - a) * f;
    }
  }
  return out;
}

/**
 * Topology-preserving-transform state variable filter (Zavalishin / Simper).
 * Stable under fast cutoff modulation, which matters for swept SFX.
 */
export class SVF {
  private ic1 = 0;
  private ic2 = 0;
  low = 0;
  band = 0;
  high = 0;

  constructor(private readonly sampleRate: number) {}

  /** Processes one sample. `cutoff` in Hz, `q` > 0.5. Outputs on low/band/high. */
  process(x: number, cutoff: number, q: number): void {
    const fc = Math.min(cutoff, this.sampleRate * 0.45);
    const g = Math.tan((Math.PI * fc) / this.sampleRate);
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - this.ic2;
    const v1 = a1 * this.ic1 + a2 * v3;
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.low = v2;
    this.band = v1;
    this.high = x - k * v1 - v2;
  }
}

/** Running median filter over a (possibly NaN-containing) series; NaNs are ignored. */
export function medianFilter(values: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(values.length);
  const win: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      out[i] = NaN;
      continue;
    }
    win.length = 0;
    for (let k = i - radius; k <= i + radius; k++) {
      if (k >= 0 && k < values.length && Number.isFinite(values[k])) win.push(values[k]);
    }
    win.sort((a, b) => a - b);
    const m = win.length >> 1;
    out[i] = win.length % 2 ? win[m] : (win[m - 1] + win[m]) / 2;
  }
  return out;
}

/** Centered moving average. */
export function smooth(values: Float32Array, radius: number): Float32Array {
  if (radius <= 0) return values.slice();
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let s = 0;
    let c = 0;
    for (let k = i - radius; k <= i + radius; k++) {
      if (k >= 0 && k < values.length) {
        s += values[k];
        c++;
      }
    }
    out[i] = s / c;
  }
  return out;
}
