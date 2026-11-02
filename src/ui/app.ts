import { analysisToPatch, analyze } from '../engine/analyze';
import { renderVoice, DEMO_VOICES } from '../engine/demoVoice';
import { clonePatch, defaultPatch, MAX_DURATION, sanitizePatch } from '../engine/patch';
import { PRESETS } from '../engine/presets';
import { decodePatch, encodePatch } from '../engine/share';
import { applyStyle, STYLES } from '../engine/styles';
import { effectivePitch, render, RENDER_RATE } from '../engine/synth';
import type { Analysis, Curve, LaneId, Patch, Waveform } from '../engine/types';
import { LANES, PITCH_MAX, PITCH_MIN, WAVEFORMS } from '../engine/types';
import { median, midiToHz, noteName } from '../engine/util';
import { makeVariations } from '../engine/variations';
import { encodeWav } from '../engine/wav';
import { makeZip } from '../engine/zip';
import { currentPlaybackId, decodeFile, play, stopPlayback } from './audio';
import { h, icon, ICONS } from './dom';
import { LaneEditor } from './lanes';
import { LANE_SPECS } from './laneSpecs';
import { loadLibrary, newId, saveLibrary, type LibraryItem } from './library';
import { MAX_RECORD_SECONDS, Recorder } from './recorder';
import { drawWaveform } from './waveform';

type NumericKey =
  | 'duration'
  | 'transpose'
  | 'contour'
  | 'vibratoDepth'
  | 'vibratoRate'
  | 'sub'
  | 'resonance'
  | 'drive'
  | 'crush'
  | 'echoMix'
  | 'echoTime'
  | 'echoFeedback'
  | 'reverbMix'
  | 'reverbSize';

interface SliderDef {
  key: NumericKey;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  /** Map slider position to value non-linearly (e.g. duration). */
  curve?: 'log';
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const secs = (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);

const GROUPS: { title: string; sliders: SliderDef[]; toggles?: ('quantize' | 'reverse')[]; wave?: boolean }[] = [
  {
    title: 'Tone',
    wave: true,
    sliders: [
      { key: 'transpose', label: 'Pitch shift', min: -36, max: 36, step: 1, format: (v) => `${v > 0 ? '+' : ''}${v} st` },
      { key: 'contour', label: 'Contour', min: 0, max: 3, step: 0.05, format: (v) => `×${v.toFixed(2)}` },
      { key: 'vibratoDepth', label: 'Vibrato', min: 0, max: 3, step: 0.05, format: (v) => (v === 0 ? 'off' : `${v.toFixed(2)} st`) },
      { key: 'vibratoRate', label: 'Vibrato speed', min: 1, max: 20, step: 0.5, format: (v) => `${v.toFixed(1)} Hz` },
      { key: 'sub', label: 'Sub bass', min: 0, max: 1, step: 0.01, format: pct },
    ],
    toggles: ['quantize'],
  },
  {
    title: 'Texture',
    sliders: [
      { key: 'resonance', label: 'Noise resonance', min: 0, max: 1, step: 0.01, format: pct },
      { key: 'drive', label: 'Drive', min: 0, max: 1, step: 0.01, format: pct },
      { key: 'crush', label: 'Bit crush', min: 0, max: 1, step: 0.01, format: pct },
    ],
  },
  {
    title: 'Space',
    sliders: [
      { key: 'echoMix', label: 'Echo', min: 0, max: 1, step: 0.01, format: pct },
      { key: 'echoTime', label: 'Echo time', min: 0.02, max: 0.6, step: 0.01, format: secs },
      { key: 'echoFeedback', label: 'Echo repeats', min: 0, max: 0.85, step: 0.01, format: pct },
      { key: 'reverbMix', label: 'Reverb', min: 0, max: 1, step: 0.01, format: pct },
      { key: 'reverbSize', label: 'Room size', min: 0, max: 1, step: 0.01, format: pct },
    ],
  },
  {
    title: 'Shape',
    sliders: [{ key: 'duration', label: 'Length', min: 0.05, max: MAX_DURATION, step: 0.001, format: secs, curve: 'log' }],
    toggles: ['reverse'],
  },
];

const TOGGLE_LABELS = { quantize: 'Snap pitch to notes', reverse: 'Reverse' } as const;
const WAVE_LABELS: Record<Waveform, string> = { sine: 'Sine', triangle: 'Tri', square: 'Square', saw: 'Saw', pulse: 'Pulse' };
const WAVE_PATHS: Record<Waveform, string> = {
  sine: '<path d="M2 12c2.5-8 5-8 7.5 0s5 8 7.5 0 3.5-5 5-4"/>',
  triangle: '<path d="M2 16 7 7l5 10 5-10 5 9"/>',
  square: '<path d="M2 17V7h5v10h5V7h5v10h5"/>',
  saw: '<path d="M2 17 9 7v10l7-10v10l6-8"/>',
  pulse: '<path d="M2 17V7h3v10h7V7h3v10h7"/>',
};

interface Snapshot {
  patch: Patch;
  styleId: string | null;
}

interface Take {
  patch: Patch;
  samples: Float32Array;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'sound';

function download(data: Uint8Array, filename: string, type: string): void {
  const blob = new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, style: 'display:none' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const prefersAutoplayKey = 'mouthpiece.autoplay';
function readPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}
function writePref(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    /* storage unavailable: preference just won't persist */
  }
}

export class App {
  private patch: Patch;
  private analysis: Analysis | null = null;
  private original: Float32Array | null = null;
  private originalRate = RENDER_RATE;
  private analysedWave: Waveform;
  private styleId: string | null = null;
  private rendered: Float32Array = new Float32Array(0);
  private renderQueued = false;
  private history: Snapshot[] = [];
  private historyIndex = -1;
  private recorder: Recorder | null = null;
  private recordCount = 0;
  private takes: Take[] = [];
  private library: LibraryItem[] = loadLibrary();
  private autoplay = readPref(prefersAutoplayKey, true);
  private spaceDownAt = 0;
  private autoplayTimer = 0;
  private toastTimer = 0;

  // DOM
  private readonly root: HTMLElement;
  private lanes: Partial<Record<LaneId, LaneEditor>> = {};
  private micBtn!: HTMLButtonElement;
  private micLevel!: HTMLElement;
  private captureStatus!: HTMLElement;
  private studio!: HTMLElement;
  private nameInput!: HTMLInputElement;
  private origCanvas!: HTMLCanvasElement;
  private resultCanvas!: HTMLCanvasElement;
  private origRow!: HTMLElement;
  private origPlayBtn!: HTMLButtonElement;
  private resultPlayBtn!: HTMLButtonElement;
  private bigPlayBtn!: HTMLButtonElement;
  private insight!: HTMLElement;
  private resultMeta!: HTMLElement;
  private styleChips = new Map<string, HTMLButtonElement>();
  private waveButtons = new Map<Waveform, HTMLButtonElement>();
  private sliders = new Map<NumericKey, { input: HTMLInputElement; out: HTMLOutputElement; def: SliderDef }>();
  private toggles = new Map<'quantize' | 'reverse', HTMLInputElement>();
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private takesGrid!: HTMLElement;
  private takesCount!: HTMLSelectElement;
  private takesAmount!: HTMLInputElement;
  private takesZipBtn!: HTMLButtonElement;
  private libraryPanel!: HTMLElement;
  private libraryList!: HTMLElement;
  private libraryBadge!: HTMLElement;
  private helpDialog!: HTMLDialogElement;
  private shareDialog!: HTMLDialogElement;
  private shareField!: HTMLInputElement;
  private toastEl!: HTMLElement;
  private fileInput!: HTMLInputElement;
  private dropOverlay!: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.patch = clonePatch(PRESETS[0]);
    this.analysedWave = this.patch.wave;
    this.build();
    this.pushHistory();
    this.syncAll();
    this.bindGlobalEvents();
    void this.loadFromHash();
  }

  // ---------------------------------------------------------------- building

  private build(): void {
    const brand = h(
      'div',
      { class: 'brand' },
      h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, logo()),
      h('span', { class: 'brand-name' }, 'Mouthpiece'),
      h('span', { class: 'brand-tag' }, 'sound effects, made with your mouth'),
    );
    this.libraryBadge = h('span', { class: 'badge' });
    const top = h(
      'header',
      { class: 'topbar' },
      brand,
      h(
        'div',
        { class: 'top-actions' },
        h('button', { class: 'btn ghost', onclick: () => this.toggleLibrary(true), 'aria-label': 'Open library' }, icon(ICONS.library), h('span', { class: 'hide-sm' }, 'Library'), this.libraryBadge),
        h('button', { class: 'btn ghost', onclick: () => this.helpDialog.showModal(), 'aria-label': 'How it works' }, icon(ICONS.help), h('span', { class: 'hide-sm' }, 'How it works')),
      ),
    );

    this.root.append(top, this.buildCapture(), this.buildStudio(), this.buildTakes(), this.buildFooter());
    this.root.append(this.buildTransport(), this.buildLibrary(), this.buildHelp(), this.buildShare());
    this.toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    this.dropOverlay = h('div', { class: 'drop-overlay' }, h('div', {}, icon(ICONS.upload, { size: 40 }), h('p', {}, 'Drop an audio file to imitate it, or a .json sound to open it')));
    this.root.append(this.toastEl, this.dropOverlay);
  }

  private buildCapture(): HTMLElement {
    this.micLevel = h('span', { class: 'mic-level' });
    this.micBtn = h(
      'button',
      { class: 'mic', 'aria-label': 'Record a vocal imitation', onclick: () => void this.toggleRecording() },
      this.micLevel,
      h('span', { class: 'mic-core' }, icon(ICONS.mic, { size: 34 })),
    );
    this.captureStatus = h('p', { class: 'capture-status', 'aria-live': 'polite' }, 'Tap, or hold Space');
    this.fileInput = h('input', {
      type: 'file',
      accept: 'audio/*,.wav,.mp3,.ogg,.m4a,.webm,.flac,.json,application/json',
      class: 'visually-hidden',
      onchange: () => {
        const f = this.fileInput.files?.[0];
        if (f) void this.openFile(f);
        this.fileInput.value = '';
      },
    });
    const demoChips = DEMO_VOICES.map((d) =>
      h('button', { class: 'chip', dataset: { demo: d.id }, onclick: () => void this.useDemoVoice(d.id) }, d.label),
    );
    const presetChips = PRESETS.map((p, i) =>
      h('button', { class: 'chip chip-quiet', dataset: { preset: String(i) }, onclick: () => this.usePreset(i) }, p.name),
    );
    return h(
      'section',
      { class: 'capture card' },
      h('div', { class: 'mic-wrap' }, this.micBtn, this.captureStatus),
      h(
        'div',
        { class: 'capture-copy' },
        h('h1', {}, 'Make the noise. ', h('span', { class: 'accent' }, 'Get the sound.')),
        h(
          'p',
          { class: 'lede' },
          'Imitate the effect you want: a ',
          h('em', {}, 'pew'),
          ', a ',
          h('em', {}, 'kshhh'),
          ', a rising ',
          h('em', {}, 'bwoooop'),
          '. Mouthpiece listens to the gesture (its pitch, loudness, hiss and brightness) and rebuilds it as a clean synthesised sound effect you can reshape, restyle and export.',
        ),
        h('div', { class: 'chip-row' }, h('span', { class: 'row-label' }, 'No mic? Try a voice'), ...demoChips),
        h(
          'div',
          { class: 'chip-row' },
          h('span', { class: 'row-label' }, 'Or start from'),
          ...presetChips,
          h('button', { class: 'chip chip-quiet', onclick: () => this.fileInput.click() }, icon(ICONS.upload, { size: 14 }), 'Open file…'),
          this.fileInput,
        ),
      ),
    );
  }

  private buildStudio(): HTMLElement {
    this.nameInput = h('input', {
      class: 'name-input',
      type: 'text',
      maxLength: 60,
      'aria-label': 'Sound name',
      spellcheck: false,
      oninput: () => {
        this.patch.name = this.nameInput.value.trim() || 'Untitled';
      },
      onchange: () => this.commit(false),
    });
    this.origCanvas = h('canvas', { class: 'wave-canvas', style: '--wave: var(--voice)' });
    this.resultCanvas = h('canvas', { class: 'wave-canvas', style: '--wave: var(--result)' });
    this.origPlayBtn = h('button', { class: 'icon-btn', 'aria-label': 'Play your recording (O)', title: 'Play your recording (O)', onclick: () => this.playOriginal() }, icon(ICONS.play));
    this.resultPlayBtn = h('button', { class: 'icon-btn result', 'aria-label': 'Play the sound effect (P)', title: 'Play the sound effect (P)', onclick: () => this.playResult() }, icon(ICONS.play));
    this.insight = h('p', { class: 'insight' });
    this.resultMeta = h('span', { class: 'wave-meta' });
    this.origRow = h(
      'div',
      { class: 'wave-row' },
      this.origPlayBtn,
      h('div', { class: 'wave-body' }, h('span', { class: 'wave-label voice' }, 'Your voice'), this.origCanvas),
    );
    const waveCard = h(
      'div',
      { class: 'card wave-card' },
      h('div', { class: 'card-head' }, this.nameInput, h('span', { class: 'kbd-hint hide-sm' }, 'P play · O original')),
      this.origRow,
      h(
        'div',
        { class: 'wave-row' },
        this.resultPlayBtn,
        h('div', { class: 'wave-body' }, h('span', { class: 'wave-label result' }, 'Sound effect', this.resultMeta), this.resultCanvas),
      ),
      this.insight,
    );

    const laneHost = (id: LaneId) => ({
      getCurve: () => this.patch[id],
      setCurve: (c: Curve, commit: boolean) => this.setCurve(id, c, commit),
      getDuration: () => this.patch.duration,
      getGhost: () => this.ghostFor(id),
      getOverlay: () => (id === 'pitch' ? this.pitchOverlay() : null),
      getViewRange: (): [number, number] => (id === 'pitch' ? this.pitchRange() : [0, 1]),
    });
    const laneEls = LANES.map((id) => {
      const ed = new LaneEditor(LANE_SPECS[id], laneHost(id));
      this.lanes[id] = ed;
      return ed.el;
    });
    const lanesCard = h(
      'div',
      { class: 'card lanes-card' },
      h(
        'div',
        { class: 'card-head' },
        h('h2', {}, 'Gesture'),
        h('span', { class: 'card-sub' }, 'Drag points · draw freehand · double-click to add or remove'),
      ),
      ...laneEls,
      h('p', { class: 'legend' }, h('span', { class: 'swatch ghost' }), 'measured from your voice', h('span', { class: 'swatch dashed' }), 'pitch as heard (after shift, contour, snap, vibrato)'),
    );

    const styleGrid = h(
      'div',
      { class: 'style-grid' },
      ...STYLES.map((s) => {
        const b = h(
          'button',
          { class: 'style-chip', dataset: { style: s.id }, title: s.blurb, onclick: () => this.chooseStyle(s.id) },
          h('strong', {}, s.label),
          h('small', {}, s.blurb),
        );
        this.styleChips.set(s.id, b);
        return b;
      }),
    );

    const groups = GROUPS.map((g) => {
      const rows: HTMLElement[] = [];
      if (g.wave) {
        const seg = h(
          'div',
          { class: 'segmented', role: 'radiogroup', 'aria-label': 'Waveform' },
          ...WAVEFORMS.map((w) => {
            const b = h(
              'button',
              { role: 'radio', class: 'seg', dataset: { wave: w }, title: WAVE_LABELS[w], onclick: () => this.setWave(w) },
              icon(WAVE_PATHS[w], { size: 20 }),
              h('span', {}, WAVE_LABELS[w]),
            );
            this.waveButtons.set(w, b);
            return b;
          }),
        );
        rows.push(h('div', { class: 'control' }, h('span', { class: 'control-label' }, 'Oscillator'), seg));
      }
      for (const def of g.sliders) rows.push(this.buildSlider(def));
      for (const t of g.toggles ?? []) {
        const input = h('input', {
          type: 'checkbox',
          dataset: { toggle: t },
          onchange: () => {
            this.patch[t] = input.checked;
            this.markCustom();
            this.commit(true);
          },
        });
        this.toggles.set(t, input);
        rows.push(h('label', { class: 'toggle' }, input, h('span', { class: 'switch', 'aria-hidden': 'true' }), TOGGLE_LABELS[t]));
      }
      return h('div', { class: 'control-group' }, h('h3', {}, g.title), ...rows);
    });

    const side = h(
      'aside',
      { class: 'side' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Style'), h('span', { class: 'card-sub' }, 'same gesture, new genre')), styleGrid),
      h('div', { class: 'card controls' }, ...groups),
    );

    this.studio = h('section', { class: 'studio' }, h('div', { class: 'main-col' }, waveCard, lanesCard), side);
    return this.studio;
  }

  private buildSlider(def: SliderDef): HTMLElement {
    const toPos = (v: number) => (def.curve === 'log' ? Math.log(v / def.min) / Math.log(def.max / def.min) : v);
    const fromPos = (p: number) => (def.curve === 'log' ? def.min * Math.pow(def.max / def.min, p) : p);
    const input = h('input', {
      type: 'range',
      min: def.curve === 'log' ? '0' : String(def.min),
      max: def.curve === 'log' ? '1' : String(def.max),
      step: def.curve === 'log' ? '0.001' : String(def.step),
      dataset: { key: def.key },
      'aria-label': def.label,
    });
    const out = h('output', { class: 'control-value' });
    input.addEventListener('input', () => {
      let v = fromPos(Number(input.value));
      v = Math.round(v / def.step) * def.step;
      v = Number(v.toFixed(4));
      this.patch[def.key] = v;
      out.textContent = def.format(v);
      if (def.key !== 'duration') this.markCustom();
      this.scheduleRender();
    });
    input.addEventListener('change', () => this.commit(true));
    const label = h('span', { class: 'control-label', title: 'Double-click to reset' }, def.label);
    label.addEventListener('dblclick', () => {
      const d = defaultPatch();
      const reset = def.key === 'duration' ? (this.analysis?.duration ?? d.duration) : d[def.key];
      this.patch[def.key] = reset;
      this.markCustom();
      this.commit(true);
    });
    this.sliders.set(def.key, { input, out, def });
    (input as HTMLInputElement & { _toPos?: (v: number) => number })._toPos = toPos;
    return h('div', { class: 'control' }, h('div', { class: 'control-top' }, label, out), input);
  }

  private buildTakes(): HTMLElement {
    this.takesGrid = h('div', { class: 'takes-grid' });
    this.takesCount = h(
      'select',
      { 'aria-label': 'Number of takes' },
      ...[4, 6, 8, 12].map((n) => h('option', { value: String(n), selected: n === 6 }, `${n} takes`)),
    );
    this.takesAmount = h('input', { type: 'range', min: '0.1', max: '1', step: '0.05', value: '0.45', 'aria-label': 'How different the takes are' });
    this.takesZipBtn = h('button', { class: 'btn', disabled: true, onclick: () => this.downloadTakesZip() }, icon(ICONS.download), 'Download all (.zip)');
    return h(
      'section',
      { class: 'card takes' },
      h(
        'div',
        { class: 'takes-head' },
        h('div', {}, h('h2', {}, 'Takes'), h('p', { class: 'card-sub' }, 'Games repeat sounds constantly, and repeats sound robotic. Generate a set of natural variations of this sound, each a slightly different performance, then export the whole pack.')),
        h(
          'div',
          { class: 'takes-controls' },
          this.takesCount,
          h('label', { class: 'amount' }, h('span', {}, 'Subtle'), this.takesAmount, h('span', {}, 'Wild')),
          h('button', { class: 'btn primary', onclick: () => this.generateTakes() }, icon(ICONS.dice), 'Generate takes'),
          this.takesZipBtn,
        ),
      ),
      this.takesGrid,
    );
  }

  private buildFooter(): HTMLElement {
    return h(
      'footer',
      { class: 'footer' },
      h('p', {}, 'Everything runs locally in your browser. Recordings never leave your device; share links contain only the sound’s recipe, never your voice.'),
    );
  }

  private buildTransport(): HTMLElement {
    this.bigPlayBtn = h('button', { class: 'play-big', 'aria-label': 'Play sound effect', onclick: () => this.playResult() }, icon(ICONS.play, { size: 22 }));
    this.undoBtn = h('button', { class: 'icon-btn', 'aria-label': 'Undo', title: 'Undo (Ctrl+Z)', onclick: () => this.undo() }, icon(ICONS.undo));
    this.redoBtn = h('button', { class: 'icon-btn', 'aria-label': 'Redo', title: 'Redo (Ctrl+Shift+Z)', onclick: () => this.redo() }, icon(ICONS.redo));
    const auto = h('input', {
      type: 'checkbox',
      checked: this.autoplay,
      onchange: () => {
        this.autoplay = auto.checked;
        writePref(prefersAutoplayKey, auto.checked);
      },
    });
    return h(
      'div',
      { class: 'transport', role: 'toolbar', 'aria-label': 'Sound actions' },
      h(
        'div',
        { class: 'transport-inner' },
        this.bigPlayBtn,
        h('label', { class: 'toggle small', title: 'Play automatically after each edit' }, auto, h('span', { class: 'switch', 'aria-hidden': 'true' }), h('span', { class: 'hide-sm' }, 'Auto-play')),
        h('span', { class: 'spacer' }),
        this.undoBtn,
        this.redoBtn,
        h('button', { class: 'btn ghost', onclick: () => this.saveToLibrary(), title: 'Save to library (S)' }, icon(ICONS.save), h('span', { class: 'hide-sm' }, 'Save')),
        h('button', { class: 'btn ghost', onclick: () => void this.share(), title: 'Copy a link to this sound' }, icon(ICONS.link), h('span', { class: 'hide-sm' }, 'Share')),
        h('button', { class: 'btn primary', onclick: () => this.exportWav(), title: 'Download WAV (E)' }, icon(ICONS.download), 'WAV'),
      ),
    );
  }

  private buildLibrary(): HTMLElement {
    this.libraryList = h('div', { class: 'library-list' });
    this.libraryPanel = h(
      'div',
      { class: 'drawer', 'aria-hidden': 'true', onclick: (e: Event) => e.target === this.libraryPanel && this.toggleLibrary(false) },
      h(
        'div',
        { class: 'drawer-panel', role: 'dialog', 'aria-label': 'Library' },
        h('div', { class: 'drawer-head' }, h('h2', {}, 'Library'), h('button', { class: 'icon-btn', 'aria-label': 'Close library', onclick: () => this.toggleLibrary(false) }, icon(ICONS.close))),
        h('p', { class: 'card-sub' }, 'Sounds you save live in this browser.'),
        this.libraryList,
      ),
    );
    return this.libraryPanel;
  }

  private buildHelp(): HTMLElement {
    const close = () => this.helpDialog.close();
    this.helpDialog = h(
      'dialog',
      { class: 'modal', onclick: (e: Event) => e.target === this.helpDialog && close() },
      h(
        'div',
        { class: 'modal-body' },
        h('div', { class: 'drawer-head' }, h('h2', {}, 'How Mouthpiece works'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon(ICONS.close))),
        h(
          'ol',
          { class: 'steps' },
          h('li', {}, h('strong', {}, 'Perform it. '), 'Tap the mic (or hold Space) and imitate the effect. Recording stops by itself when you go quiet.'),
          h('li', {}, h('strong', {}, 'It listens. '), 'Every 10 ms Mouthpiece measures your pitch (YIN), loudness, how noisy or tonal you are, and spectral brightness. That gesture becomes four editable lanes.'),
          h('li', {}, h('strong', {}, 'It resynthesises. '), 'An oscillator and a filtered noise source perform your gesture, cleanly, with none of your voice’s grit. Pick a style to reinterpret it: 8-bit, sci-fi, monster, magic…'),
          h('li', {}, h('strong', {}, 'Shape and ship. '), 'Drag or draw on the lanes, tweak the controls, generate variation takes, then export WAVs or share a link.'),
        ),
        h('h3', {}, 'Tips'),
        h(
          'ul',
          { class: 'tips' },
          h('li', {}, 'Get close to the mic and commit. Exaggerated performances make the best effects.'),
          h('li', {}, 'One sound per take. Whistles track pitch beautifully; “kshh” and “tsss” become noise bursts.'),
          h('li', {}, 'Try the same gesture in every style. A falling “pew” is a laser in Sci-fi and a coin drop in 8-bit.'),
        ),
        h('h3', {}, 'Shortcuts'),
        h(
          'dl',
          { class: 'shortcuts' },
          ...[
            ['Space', 'hold to record, tap to start or stop'],
            ['P / Enter', 'play the sound effect'],
            ['O', 'play your original recording'],
            ['E', 'export WAV'],
            ['S', 'save to library'],
            ['T', 'generate takes'],
            ['Ctrl/⌘ Z', 'undo, add Shift to redo'],
            ['Esc', 'stop playback or recording'],
          ].flatMap(([k, d]) => [h('dt', {}, h('kbd', {}, k)), h('dd', {}, d)]),
        ),
      ),
    );
    return this.helpDialog;
  }

  private buildShare(): HTMLElement {
    const close = () => this.shareDialog.close();
    this.shareField = h('input', { class: 'share-field', type: 'text', readOnly: true, onfocus: () => this.shareField.select() });
    this.shareDialog = h(
      'dialog',
      { class: 'modal', onclick: (e: Event) => e.target === this.shareDialog && close() },
      h(
        'div',
        { class: 'modal-body' },
        h('div', { class: 'drawer-head' }, h('h2', {}, 'Share this sound'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon(ICONS.close))),
        h('p', { class: 'card-sub' }, 'The whole sound is encoded in this link (no server, no upload). Anyone who opens it gets the same sound, fully editable.'),
        this.shareField,
      ),
    );
    return this.shareDialog;
  }

  // ----------------------------------------------------------------- events

  private bindGlobalEvents(): void {
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('hashchange', () => void this.loadFromHash());
    window.addEventListener('resize', () => this.drawWaves());
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener?.('change', () => this.refreshTheme());

    let dragDepth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      this.dropOverlay.classList.add('show');
    });
    window.addEventListener('dragover', (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) this.dropOverlay.classList.remove('show');
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      this.dropOverlay.classList.remove('show');
      const f = e.dataTransfer?.files?.[0];
      if (f) void this.openFile(f);
    });
  }

  private isTyping(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    if (!t) return false;
    const tag = t.tagName;
    if (tag === 'TEXTAREA' || t.isContentEditable) return true;
    if (tag === 'INPUT') {
      const type = (t as HTMLInputElement).type;
      return type === 'text' || type === 'search' || type === 'url' || type === 'email' || type === 'number';
    }
    if (tag === 'SELECT') return true;
    return false;
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.isTyping(e)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      this.redo();
      return;
    }
    if (mod || e.altKey) return;
    if (document.querySelector('dialog[open]') && e.key !== 'Escape') return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (e.repeat) return;
        this.spaceDownAt = performance.now();
        if (this.recorder?.active) this.recorder.stop();
        else void this.toggleRecording();
        break;
      case 'p':
      case 'P':
      case 'Enter':
        if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName === 'BUTTON') return;
        e.preventDefault();
        this.playResult();
        break;
      case 'o':
      case 'O':
        this.playOriginal();
        break;
      case 'e':
      case 'E':
        this.exportWav();
        break;
      case 's':
      case 'S':
        this.saveToLibrary();
        break;
      case 't':
      case 'T':
        this.generateTakes();
        break;
      case 'Escape':
        stopPlayback();
        if (this.recorder?.active) this.recorder.stop(true);
        this.toggleLibrary(false);
        break;
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.key !== ' ' || this.isTyping(e)) return;
    // Hold-to-record: releasing a long press stops; a quick tap leaves it running.
    if (this.recorder?.active && performance.now() - this.spaceDownAt > 450) this.recorder.stop();
  }

  // ------------------------------------------------------------- capturing

  private setCaptureState(state: 'idle' | 'starting' | 'recording' | 'analysing', message?: string): void {
    this.micBtn.dataset.state = state;
    this.micBtn.setAttribute('aria-pressed', String(state === 'recording'));
    this.captureStatus.textContent =
      message ??
      {
        idle: 'Tap, or hold Space',
        starting: 'Opening the mic…',
        recording: `Listening… make the sound (stops when you go quiet, max ${MAX_RECORD_SECONDS} s)`,
        analysing: 'Listening back…',
      }[state];
    this.captureStatus.classList.toggle('error', false);
  }

  private captureError(message: string): void {
    this.setCaptureState('idle', message);
    this.captureStatus.classList.add('error');
    this.recorder = null;
  }

  private async toggleRecording(): Promise<void> {
    if (this.recorder?.active) {
      this.recorder.stop();
      return;
    }
    if (this.recorder) return; // still starting
    stopPlayback();
    this.setCaptureState('starting');
    const rec = new Recorder({
      onLevel: (l) => this.micLevel.style.setProperty('--level', l.toFixed(3)),
      onDone: (samples, sr) => {
        this.recorder = null;
        this.recordCount++;
        void this.imitate(samples, sr, `Take ${this.recordCount}`);
      },
      onError: (m) => this.captureError(m),
    });
    this.recorder = rec;
    await rec.start();
    if (this.recorder === rec && rec.active) this.setCaptureState('recording');
  }

  private async imitate(samples: Float32Array, sampleRate: number, name: string): Promise<void> {
    this.setCaptureState('analysing');
    // Let the UI paint the "listening back" state before the analysis blocks.
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const maxLen = Math.round(MAX_DURATION * sampleRate);
    const clipped = samples.length > maxLen ? samples.slice(0, maxLen) : samples;
    const analysis = analyze(clipped, sampleRate);
    let peakAmp = 0;
    for (const v of analysis.amp) peakAmp = Math.max(peakAmp, v);
    if (peakAmp === 0) {
      this.captureError('That was silent. Try again a little louder.');
      return;
    }
    const patch = analysisToPatch(analysis, name);
    const start = Math.floor(analysis.startSeconds * sampleRate);
    const end = Math.min(clipped.length, start + Math.ceil(analysis.duration * sampleRate));
    this.original = clipped.slice(start, end);
    this.originalRate = sampleRate;
    this.analysis = analysis;
    this.analysedWave = patch.wave;
    // Keep the current style so people can perform several takes in one genre.
    const style = STYLES.find((s) => s.id === this.styleId);
    this.patch = style ? { ...applyStyle(patch, style, patch.wave), name } : patch;
    this.takes = [];
    this.renderTakes();
    this.setCaptureState('idle', 'Got it. Edit below, or perform another.');
    this.pushHistory();
    this.syncAll();
    this.studio.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (this.autoplay) setTimeout(() => this.playResult(), 250);
  }

  private async useDemoVoice(id: string): Promise<void> {
    const d = DEMO_VOICES.find((v) => v.id === id);
    if (!d) return;
    stopPlayback();
    const samples = renderVoice(d.spec, RENDER_RATE);
    const name = d.label.replace(/[“”↑↗]/g, '').trim();
    await this.imitate(samples, RENDER_RATE, name);
  }

  private usePreset(i: number): void {
    const p = PRESETS[i];
    if (!p) return;
    this.loadPatch(clonePatch(p), null);
    this.setCaptureState('idle', `Loaded “${p.name}”. Or perform your own.`);
    if (this.autoplay) this.playResult();
  }

  private loadPatch(patch: Patch, styleId: string | null): void {
    stopPlayback();
    this.patch = patch;
    this.analysis = null;
    this.original = null;
    this.analysedWave = patch.wave;
    this.styleId = styleId;
    this.takes = [];
    this.renderTakes();
    this.pushHistory();
    this.syncAll();
  }

  private async openFile(file: File): Promise<void> {
    const isJson = file.name.toLowerCase().endsWith('.json') || file.type === 'application/json';
    try {
      if (isJson) {
        const patch = sanitizePatch(JSON.parse(await file.text()));
        this.loadPatch(patch, null);
        this.toast(`Opened “${patch.name}”`);
        return;
      }
      if (file.size > 60 * 1024 * 1024) throw new Error('too big');
      this.setCaptureState('analysing');
      const { samples, sampleRate } = await decodeFile(await file.arrayBuffer());
      await this.imitate(samples, sampleRate, file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Imported');
    } catch {
      this.captureError(isJson ? 'That file is not a Mouthpiece sound.' : 'Could not read that audio file. WAV, MP3, OGG and M4A usually work.');
    }
  }

  private async loadFromHash(): Promise<void> {
    const m = location.hash.match(/^#s=([A-Za-z0-9_-]+)/);
    if (!m) return;
    try {
      const patch = await decodePatch(m[1]);
      this.loadPatch(patch, null);
      this.toast(`Loaded shared sound “${patch.name}”. Press play!`);
    } catch {
      this.toast('That share link looks broken.');
    }
  }

  // --------------------------------------------------------------- editing

  private setCurve(id: LaneId, curve: Curve, commit: boolean): void {
    this.patch[id] = curve;
    if (commit) this.commit(true);
    else {
      this.scheduleRender();
      this.lanes[id]?.draw();
    }
  }

  private setWave(w: Waveform): void {
    this.patch.wave = w;
    this.markCustom();
    this.commit(true);
  }

  private chooseStyle(id: string): void {
    const s = STYLES.find((x) => x.id === id);
    if (!s) return;
    this.patch = applyStyle(this.patch, s, this.analysedWave);
    this.styleId = id;
    this.commit(true);
  }

  private markCustom(): void {
    if (this.styleId !== null) {
      this.styleId = null;
      this.syncStyles();
    }
  }

  /** Records an undo step, refreshes the UI, and optionally auto-plays. */
  private commit(autoplay: boolean): void {
    this.pushHistory();
    this.syncAll();
    if (autoplay && this.autoplay) {
      clearTimeout(this.autoplayTimer);
      this.autoplayTimer = window.setTimeout(() => this.playResult(), 120);
    }
  }

  private pushHistory(): void {
    const snap: Snapshot = { patch: clonePatch(this.patch), styleId: this.styleId };
    const cur = this.history[this.historyIndex];
    if (cur && JSON.stringify(cur) === JSON.stringify(snap)) return;
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(snap);
    if (this.history.length > 200) this.history.shift();
    this.historyIndex = this.history.length - 1;
  }

  private restore(i: number): void {
    const s = this.history[i];
    if (!s) return;
    this.historyIndex = i;
    this.patch = clonePatch(s.patch);
    this.styleId = s.styleId;
    this.syncAll();
  }

  private undo(): void {
    if (this.historyIndex > 0) this.restore(this.historyIndex - 1);
  }
  private redo(): void {
    if (this.historyIndex < this.history.length - 1) this.restore(this.historyIndex + 1);
  }

  // --------------------------------------------------------------- derived

  private ghostFor(id: LaneId): Float32Array | null {
    const a = this.analysis;
    if (!a) return null;
    return a[id];
  }

  private pitchOverlay(): Float32Array | null {
    const p = this.patch;
    if (p.transpose === 0 && p.contour === 1 && !p.quantize && p.vibratoDepth === 0) return null;
    return effectivePitch(p, 400);
  }

  private pitchRange(): [number, number] {
    let lo = Infinity;
    let hi = -Infinity;
    const take = (v: number) => {
      if (Number.isFinite(v)) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    };
    this.patch.pitch.forEach((p) => take(p.v));
    this.pitchOverlay()?.forEach(take);
    this.analysis?.pitch.forEach(take);
    if (!Number.isFinite(lo)) return [48, 84];
    lo -= 3;
    hi += 3;
    const minSpan = 24;
    if (hi - lo < minSpan) {
      const c = (hi + lo) / 2;
      lo = c - minSpan / 2;
      hi = c + minSpan / 2;
    }
    if (lo < PITCH_MIN) {
      hi += PITCH_MIN - lo;
      lo = PITCH_MIN;
    }
    if (hi > PITCH_MAX) {
      lo -= hi - PITCH_MAX;
      hi = PITCH_MAX;
    }
    return [Math.max(PITCH_MIN, Math.floor(lo)), Math.min(PITCH_MAX, Math.ceil(hi))];
  }

  private describe(): string {
    const a = this.analysis;
    if (!a) return 'Built from a preset or link. Perform your own version with the mic for a measured gesture.';
    const voiced = Math.round(a.voicedRatio * 100);
    const parts = [`Heard ${a.duration.toFixed(2)} s`];
    const finite = Array.from(a.pitch).filter((v) => Number.isFinite(v));
    if (finite.length > 3 && a.voicedRatio > 0.15) {
      const head = median(finite.slice(0, Math.max(2, Math.floor(finite.length * 0.15))));
      const tail = median(finite.slice(-Math.max(2, Math.floor(finite.length * 0.15))));
      const lo = Math.min(...finite);
      const hi = Math.max(...finite);
      const dir = tail - head > 2 ? 'rising' : head - tail > 2 ? 'falling' : 'level';
      parts.push(`${voiced}% pitched`);
      parts.push(`${dir} ${dir === 'level' ? 'around' : 'from'} ${noteName(head)}${dir === 'level' ? '' : ` to ${noteName(tail)}`} (range ${noteName(lo)}–${noteName(hi)}, ${Math.round(midiToHz(lo))}–${Math.round(midiToHz(hi))} Hz)`);
    } else {
      parts.push('unpitched, so it became a noise gesture');
    }
    parts.push(`suggested oscillator: ${WAVE_LABELS[this.analysedWave].toLowerCase()}`);
    return parts.join(' · ');
  }

  // ------------------------------------------------------------- rendering

  private scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.renderNow();
      for (const id of LANES) this.lanes[id]?.draw();
    });
  }

  private renderNow(): void {
    this.rendered = render(this.patch);
    this.resultMeta.textContent = ` · ${(this.rendered.length / RENDER_RATE).toFixed(2)} s`;
    this.drawWaves();
  }

  private drawWaves(playhead: { which: 'orig' | 'result'; t: number } | null = null): void {
    const cs = getComputedStyle(this.root);
    drawWaveform(this.origCanvas, this.original, {
      color: cs.getPropertyValue('--voice').trim() || '#ffb020',
      playhead: playhead?.which === 'orig' ? playhead.t : null,
    });
    const len = this.rendered.length / RENDER_RATE;
    drawWaveform(this.resultCanvas, this.rendered, {
      color: cs.getPropertyValue('--result').trim() || '#3ee0c4',
      playhead: playhead?.which === 'result' ? playhead.t : null,
      marker: len > this.patch.duration + 0.02 ? (this.patch.reverse ? 1 - this.patch.duration / len : this.patch.duration / len) : null,
    });
  }

  private syncAll(): void {
    this.nameInput.value = this.patch.name;
    this.origRow.hidden = !this.original;
    this.insight.textContent = this.describe();
    this.syncStyles();
    for (const [w, b] of this.waveButtons) {
      b.setAttribute('aria-checked', String(this.patch.wave === w));
      b.classList.toggle('on', this.patch.wave === w);
    }
    for (const [key, s] of this.sliders) {
      const v = this.patch[key];
      const toPos = (s.input as HTMLInputElement & { _toPos?: (v: number) => number })._toPos;
      s.input.value = String(toPos ? toPos(v) : v);
      s.out.textContent = s.def.format(v);
    }
    for (const [key, input] of this.toggles) input.checked = this.patch[key];
    this.undoBtn.disabled = this.historyIndex <= 0;
    this.redoBtn.disabled = this.historyIndex >= this.history.length - 1;
    this.renderNow();
    for (const id of LANES) this.lanes[id]?.draw();
    this.renderLibrary();
  }

  private syncStyles(): void {
    for (const [id, b] of this.styleChips) {
      b.classList.toggle('on', id === this.styleId);
      b.setAttribute('aria-pressed', String(id === this.styleId));
    }
  }

  private refreshTheme(): void {
    for (const id of LANES) {
      this.lanes[id]?.refreshColors();
      this.lanes[id]?.draw();
    }
    this.drawWaves();
    this.renderTakes();
  }

  // ------------------------------------------------------------- playback

  private setPlaying(btn: HTMLButtonElement | null): void {
    for (const b of [this.origPlayBtn, this.resultPlayBtn, this.bigPlayBtn]) {
      const on = b === btn || (btn === this.resultPlayBtn && b === this.bigPlayBtn);
      b.classList.toggle('playing', on);
      b.replaceChildren(icon(on ? ICONS.stop : ICONS.play, { size: b === this.bigPlayBtn ? 22 : 18 }));
    }
  }

  private playResult(): void {
    if (currentPlaybackId() === 'result') {
      stopPlayback();
      return;
    }
    clearTimeout(this.autoplayTimer);
    const total = this.rendered.length / RENDER_RATE;
    const dur = this.patch.duration;
    const reverse = this.patch.reverse;
    this.setPlaying(this.resultPlayBtn);
    play(
      this.rendered,
      RENDER_RATE,
      'result',
      (sec) => {
        const laneT = reverse ? (total - sec) / dur : sec / dur;
        for (const id of LANES) this.lanes[id]?.setPlayhead(laneT >= 0 && laneT <= 1 ? laneT : null);
        this.drawWaves({ which: 'result', t: sec / total });
      },
      () => {
        for (const id of LANES) this.lanes[id]?.setPlayhead(null);
        this.setPlaying(null);
        this.drawWaves();
      },
    );
  }

  private playOriginal(): void {
    if (!this.original) return;
    if (currentPlaybackId() === 'orig') {
      stopPlayback();
      return;
    }
    const total = this.original.length / this.originalRate;
    this.setPlaying(this.origPlayBtn);
    play(
      this.original,
      this.originalRate,
      'orig',
      (sec) => {
        for (const id of LANES) this.lanes[id]?.setPlayhead(sec / total <= 1 ? sec / total : null);
        this.drawWaves({ which: 'orig', t: sec / total });
      },
      () => {
        for (const id of LANES) this.lanes[id]?.setPlayhead(null);
        this.setPlaying(null);
        this.drawWaves();
      },
    );
  }

  // ---------------------------------------------------------------- export

  private exportWav(): void {
    download(encodeWav(this.rendered, RENDER_RATE), `${slug(this.patch.name)}.wav`, 'audio/wav');
    this.toast(`Downloaded ${slug(this.patch.name)}.wav`);
  }

  private async share(): Promise<void> {
    const token = await encodePatch(this.patch);
    const url = `${location.href.split('#')[0]}#s=${token}`;
    history.replaceState(null, '', `#s=${token}`);
    let copied = false;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch {
      copied = false;
    }
    if (copied) this.toast('Link copied. The whole sound is inside it.');
    else {
      this.shareField.value = url;
      this.shareDialog.showModal();
      this.shareField.focus();
      this.shareField.select();
    }
  }

  // ----------------------------------------------------------------- takes

  private generateTakes(): void {
    const count = Number(this.takesCount.value) || 6;
    const amount = Number(this.takesAmount.value) || 0.45;
    const seed = Math.floor(Math.random() * 1e6) + 1;
    const patches = makeVariations(this.patch, count, amount, seed);
    this.takes = patches.map((p) => ({ patch: p, samples: render(p) }));
    this.renderTakes();
    this.takesGrid.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  private renderTakes(): void {
    this.takesZipBtn.disabled = this.takes.length === 0;
    if (this.takes.length === 0) {
      this.takesGrid.replaceChildren(h('p', { class: 'empty' }, 'No takes yet. Press “Generate takes” (or T).'));
      return;
    }
    const cs = getComputedStyle(this.root);
    const color = cs.getPropertyValue('--result').trim() || '#3ee0c4';
    const cards = this.takes.map((take, i) => {
      const canvas = h('canvas', { class: 'take-wave' });
      const playBtn = h('button', { class: 'icon-btn result', 'aria-label': `Play ${take.patch.name}` }, icon(ICONS.play));
      const id = `take-${i}`;
      playBtn.addEventListener('click', () => {
        if (currentPlaybackId() === id) {
          stopPlayback();
          return;
        }
        this.setPlaying(null);
        playBtn.replaceChildren(icon(ICONS.stop));
        play(
          take.samples,
          RENDER_RATE,
          id,
          (sec) => drawWaveform(canvas, take.samples, { color, playhead: sec / (take.samples.length / RENDER_RATE) }),
          () => {
            playBtn.replaceChildren(icon(ICONS.play));
            drawWaveform(canvas, take.samples, { color });
          },
        );
      });
      const card = h(
        'div',
        { class: 'take' },
        h('div', { class: 'take-top' }, playBtn, h('span', { class: 'take-name' }, take.patch.name), h('span', { class: 'take-len' }, `${(take.samples.length / RENDER_RATE).toFixed(2)} s`)),
        canvas,
        h(
          'div',
          { class: 'take-actions' },
          h('button', { class: 'btn small', onclick: () => this.useTake(i) }, icon(ICONS.check, { size: 14 }), 'Use'),
          h('button', { class: 'btn small ghost', onclick: () => download(encodeWav(take.samples, RENDER_RATE), `${slug(take.patch.name)}.wav`, 'audio/wav') }, icon(ICONS.download, { size: 14 }), 'WAV'),
        ),
      );
      requestAnimationFrame(() => drawWaveform(canvas, take.samples, { color }));
      return card;
    });
    this.takesGrid.replaceChildren(...cards);
  }

  private useTake(i: number): void {
    const t = this.takes[i];
    if (!t) return;
    this.patch = clonePatch(t.patch);
    this.commit(true);
    this.studio.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private downloadTakesZip(): void {
    if (!this.takes.length) return;
    const base = slug(this.patch.name);
    const entries = [
      { name: `${base}/${base}.wav`, data: encodeWav(this.rendered, RENDER_RATE) },
      ...this.takes.map((t) => ({ name: `${base}/${slug(t.patch.name)}.wav`, data: encodeWav(t.samples, RENDER_RATE) })),
      { name: `${base}/${base}.mouthpiece.json`, data: new TextEncoder().encode(JSON.stringify(this.patch, null, 2)) },
    ];
    download(makeZip(entries), `${base}-pack.zip`, 'application/zip');
    this.toast(`Downloaded ${base}-pack.zip (${this.takes.length + 1} sounds)`);
  }

  // --------------------------------------------------------------- library

  private saveToLibrary(): void {
    const item: LibraryItem = { id: newId(), savedAt: Date.now(), patch: clonePatch(this.patch) };
    const next = [item, ...this.library].slice(0, 200);
    if (!saveLibrary(next)) {
      this.toast('Could not save: browser storage is unavailable here. Use WAV or Share instead.');
      return;
    }
    this.library = next;
    this.renderLibrary();
    this.toast(`Saved “${this.patch.name}” to your library`);
  }

  private toggleLibrary(open: boolean): void {
    this.libraryPanel.classList.toggle('open', open);
    this.libraryPanel.setAttribute('aria-hidden', String(!open));
    if (open) this.renderLibrary();
  }

  private renderLibrary(): void {
    this.libraryBadge.textContent = this.library.length ? String(this.library.length) : '';
    if (!this.libraryList) return;
    if (this.library.length === 0) {
      this.libraryList.replaceChildren(h('p', { class: 'empty' }, 'Nothing saved yet. Press Save (or S) to keep a sound here.'));
      return;
    }
    this.libraryList.replaceChildren(
      ...this.library.map((item) => {
        const date = new Date(item.savedAt);
        return h(
          'div',
          { class: 'lib-item' },
          h(
            'button',
            {
              class: 'icon-btn result',
              'aria-label': `Play ${item.patch.name}`,
              onclick: () => play(render(item.patch), RENDER_RATE, `lib-${item.id}`),
            },
            icon(ICONS.play),
          ),
          h('div', { class: 'lib-meta' }, h('strong', {}, item.patch.name), h('small', {}, `${item.patch.wave} · ${item.patch.duration.toFixed(2)} s · ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)),
          h('button', { class: 'btn small', onclick: () => { this.loadPatch(clonePatch(item.patch), null); this.toggleLibrary(false); } }, 'Open'),
          h('button', { class: 'icon-btn', 'aria-label': `Download ${item.patch.name}`, onclick: () => download(encodeWav(render(item.patch), RENDER_RATE), `${slug(item.patch.name)}.wav`, 'audio/wav') }, icon(ICONS.download)),
          h(
            'button',
            {
              class: 'icon-btn danger',
              'aria-label': `Delete ${item.patch.name}`,
              onclick: () => {
                const next = this.library.filter((x) => x.id !== item.id);
                saveLibrary(next);
                this.library = next;
                this.renderLibrary();
              },
            },
            icon(ICONS.trash),
          ),
        );
      }),
    );
  }

  // ------------------------------------------------------------------ misc

  private toast(message: string): void {
    this.toastEl.textContent = message;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 2800);
  }
}

function logo(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('width', '30');
  svg.setAttribute('height', '30');
  svg.innerHTML =
    '<rect width="64" height="64" rx="16" fill="var(--accent)"/><path d="M10 32c6-10 14-14 22-14s16 4 22 14c-6 10-14 14-22 14s-16-4-22-14z" fill="#fff"/><path d="M18 32h4l3-7 4 14 4-10 3 6 3-3h7" stroke="var(--accent)" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
  return svg;
}
