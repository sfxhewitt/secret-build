/** Shared AudioContext and one-voice playback with a progress callback. */

let ctx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export interface Playback {
  id: string;
  stop(): void;
}

let current: { source: AudioBufferSourceNode; id: string; raf: number; onEnd: () => void } | null = null;

export function stopPlayback(): void {
  if (!current) return;
  const c = current;
  current = null;
  cancelAnimationFrame(c.raf);
  try {
    c.source.onended = null;
    c.source.stop();
  } catch {
    /* already stopped */
  }
  c.onEnd();
}

export function currentPlaybackId(): string | null {
  return current?.id ?? null;
}

/**
 * Plays mono samples. `onProgress` receives seconds elapsed each frame;
 * `onEnd` fires once when playback stops for any reason.
 */
export function play(
  samples: Float32Array,
  sampleRate: number,
  id: string,
  onProgress?: (seconds: number) => void,
  onEnd?: () => void,
): void {
  stopPlayback();
  if (samples.length === 0) {
    onEnd?.();
    return;
  }
  const ac = getAudioContext();
  const buffer = ac.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  const source = ac.createBufferSource();
  source.buffer = buffer;
  source.connect(ac.destination);
  const startAt = ac.currentTime + 0.01;
  source.start(startAt);
  const entry = {
    source,
    id,
    raf: 0,
    onEnd: () => onEnd?.(),
  };
  const tick = () => {
    if (current !== entry) return;
    onProgress?.(Math.max(0, ac.currentTime - startAt));
    entry.raf = requestAnimationFrame(tick);
  };
  source.onended = () => {
    if (current === entry) {
      cancelAnimationFrame(entry.raf);
      current = null;
      entry.onEnd();
    }
  };
  current = entry;
  entry.raf = requestAnimationFrame(tick);
}

/** Decodes any browser-supported audio file to mono samples. */
export async function decodeFile(data: ArrayBuffer): Promise<{ samples: Float32Array; sampleRate: number }> {
  const ac = getAudioContext();
  const buf = await ac.decodeAudioData(data.slice(0));
  const n = buf.length;
  const out = new Float32Array(n);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) out[i] += d[i] / buf.numberOfChannels;
  }
  return { samples: out, sampleRate: buf.sampleRate };
}
