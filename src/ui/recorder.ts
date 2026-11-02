import { getAudioContext } from './audio';

export interface RecorderCallbacks {
  /** Input level 0..1 (RMS, roughly perceptual), called ~40x a second. */
  onLevel(level: number): void;
  /** Recording finished (manually, by silence, or by time limit). */
  onDone(samples: Float32Array, sampleRate: number): void;
  onError(message: string): void;
}

export const MAX_RECORD_SECONDS = 6;
const SILENCE_STOP_SECONDS = 0.75;

/**
 * Captures raw microphone PCM. Browser voice processing (noise suppression,
 * AGC, echo cancellation) is turned off because it erases exactly the noisy,
 * breathy sounds people make when imitating effects.
 */
export class Recorder {
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private length = 0;
  private heardSound = false;
  private silentFor = 0;
  private noiseFloor = 0.003;
  private stopped = false;
  private sampleRate = 44100;

  constructor(private readonly cb: RecorderCallbacks) {}

  get active(): boolean {
    return this.node !== null && !this.stopped;
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.cb.onError('This browser cannot access a microphone here. Try a demo voice, or drop an audio file instead.');
      return;
    }
    const ac = getAudioContext();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
    } catch (e) {
      const name = (e as DOMException)?.name;
      this.cb.onError(
        name === 'NotAllowedError'
          ? 'Microphone permission was denied. Allow it in your browser’s site settings, or try a demo voice.'
          : name === 'NotFoundError'
            ? 'No microphone was found. Plug one in, or try a demo voice or an audio file.'
            : 'Could not start the microphone. Try a demo voice or drop an audio file instead.',
      );
      return;
    }
    if (this.stopped) {
      this.release();
      return;
    }
    this.sampleRate = ac.sampleRate;
    this.source = ac.createMediaStreamSource(this.stream);
    this.node = ac.createScriptProcessor(2048, 1, 1);
    this.sink = ac.createGain();
    this.sink.gain.value = 0;
    this.node.onaudioprocess = (ev) => this.handle(ev.inputBuffer.getChannelData(0));
    this.source.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(ac.destination);
  }

  private handle(input: Float32Array): void {
    if (this.stopped) return;
    const chunk = new Float32Array(input);
    this.chunks.push(chunk);
    this.length += chunk.length;
    let sq = 0;
    for (let i = 0; i < chunk.length; i++) sq += chunk[i] * chunk[i];
    const rms = Math.sqrt(sq / chunk.length);
    this.cb.onLevel(Math.min(1, Math.sqrt(rms) * 1.6));

    const chunkSec = chunk.length / this.sampleRate;
    const elapsed = this.length / this.sampleRate;
    // Track ambient noise during the first moments, before the user makes a sound.
    if (!this.heardSound && elapsed < 0.4) this.noiseFloor = Math.max(this.noiseFloor, rms);
    const threshold = Math.max(0.012, this.noiseFloor * 4);
    if (rms > threshold) {
      this.heardSound = true;
      this.silentFor = 0;
    } else if (this.heardSound) {
      this.silentFor += chunkSec;
    }
    if ((this.heardSound && this.silentFor >= SILENCE_STOP_SECONDS) || elapsed >= MAX_RECORD_SECONDS) this.stop();
  }

  /** Stops recording and delivers the audio (or nothing, if `discard`). */
  stop(discard = false): void {
    if (this.stopped) return;
    this.stopped = true;
    const out = new Float32Array(this.length);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    this.release();
    this.cb.onLevel(0);
    if (discard) return;
    if (!this.heardSound || out.length < this.sampleRate * 0.05) {
      this.cb.onError('I didn’t hear anything. Get closer to the mic and make some noise: pew, kshh, bwoop!');
      return;
    }
    this.cb.onDone(out, this.sampleRate);
  }

  private release(): void {
    if (this.node) this.node.onaudioprocess = null;
    this.source?.disconnect();
    this.node?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node = null;
    this.source = null;
    this.sink = null;
    this.stream = null;
  }
}
