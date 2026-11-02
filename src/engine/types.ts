/** A breakpoint on a normalised timeline. `t` is 0..1 across the sound's duration. */
export interface Point {
  t: number;
  v: number;
}

export type Curve = Point[];

export type Waveform = 'sine' | 'triangle' | 'square' | 'saw' | 'pulse';

export const WAVEFORMS: readonly Waveform[] = ['sine', 'triangle', 'square', 'saw', 'pulse'];

/** The four editable "gesture" lanes extracted from a vocal imitation. */
export type LaneId = 'pitch' | 'amp' | 'noise' | 'bright';

export const LANES: readonly LaneId[] = ['pitch', 'amp', 'noise', 'bright'];

/**
 * A Patch fully describes a sound effect. It is small, serialisable and
 * deterministic: rendering the same patch always produces the same samples.
 */
export interface Patch {
  version: 1;
  name: string;
  /** Length of the rendered sound in seconds (before echo / reverb tails). */
  duration: number;
  /** Pitch lane, in MIDI note numbers (60 = middle C, 69 = A440). */
  pitch: Curve;
  /** Loudness lane, linear 0..1. */
  amp: Curve;
  /** Tone/noise balance lane, 0 = pure tone, 1 = pure noise. */
  noise: Curve;
  /** Brightness lane, 0..1, mapped logarithmically to a filter cutoff. */
  bright: Curve;

  wave: Waveform;
  /** Global transposition in semitones. */
  transpose: number;
  /** Exaggerates (>1) or flattens (<1) the pitch contour around its median. */
  contour: number;
  /** Snap pitch to the nearest semitone (classic chip-tune stepping). */
  quantize: boolean;
  vibratoRate: number; // Hz
  vibratoDepth: number; // semitones
  /** Resonance of the noise filter, 0..1. */
  resonance: number;
  /** Level of a sine one octave below the main oscillator, 0..1. */
  sub: number;
  /** Soft-clip drive, 0..1. */
  drive: number;
  /** Bit-crush / sample-rate reduction amount, 0..1. */
  crush: number;
  echoMix: number; // 0..1
  echoTime: number; // seconds
  echoFeedback: number; // 0..0.9
  reverbMix: number; // 0..1
  reverbSize: number; // 0..1
  reverse: boolean;
  /** Seed for every random process (noise source). */
  seed: number;
}

/** Per-frame features measured from a recording. */
export interface Analysis {
  sampleRate: number;
  hopSeconds: number;
  duration: number;
  /** Where the trimmed sound starts within the input, in seconds. */
  startSeconds: number;
  /** RMS amplitude, normalised so the loudest frame is 1. */
  amp: Float32Array;
  /** Fundamental frequency in MIDI notes, NaN where unvoiced. */
  pitch: Float32Array;
  /** 0 = perfectly periodic, 1 = noise. */
  noise: Float32Array;
  /** Spectral brightness 0..1. */
  bright: Float32Array;
  /** Fraction of audible frames that were voiced (pitched). */
  voicedRatio: number;
}

export const PITCH_MIN = 24; // C1
export const PITCH_MAX = 120; // C9

export const BRIGHT_MIN_HZ = 60;
export const BRIGHT_MAX_HZ = 16000;
