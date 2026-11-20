# Mouthpiece

**Make sound effects with your mouth.**

Every game developer, video editor and prototyper has done it: you need a *pew*, a *kshhh* or a rising *bwoooop*, and the fastest way to describe it is to make the noise yourself. Mouthpiece turns that noise into the actual sound effect.

Tap the mic, imitate the effect, and Mouthpiece:

1. **Listens to the gesture, not the voice.** Every 10 ms it measures pitch (YIN), loudness, how noisy or tonal you are, and spectral brightness.
2. **Turns it into four editable lanes** (Pitch, Loudness, Noise, Brightness), simplified to a handful of draggable breakpoints.
3. **Resynthesises it cleanly.** An anti-aliased oscillator plus a filtered noise source perform your gesture with none of your voice's grit.
4. **Restyles it in one tap.** The same falling *pew* is a laser in *Sci-fi*, a coin drop in *8-bit*, a growl in *Monster*, a sparkle in *Magic*.
5. **Ships it.** Export a WAV, generate a pack of natural variation *takes* (so repeats in a game never sound robotic) as a ZIP, save to your library, or share a link that contains the whole sound.

No mic handy? Six built-in demo voices (a synthetic formant voice saying "pew!", "kshhh", "boi-oi-oing", a whistle and more) and ten presets let you try the whole pipeline immediately. You can also drop in any audio file.

Everything runs locally in the browser. There is no server, recordings never leave your device, and share links carry only the sound's recipe, never your voice.

## Run it

Requires Node 20+.

```bash
npm install
npm run dev        # http://localhost:5173
```

Microphones need a secure context: `localhost` is fine; on another device, serve over HTTPS.

Build a deployable static site, or a single self-contained HTML file:

```bash
npm run build          # -> dist/ (any static host)
npm run build:single   # -> dist-single/index.html (one file, works offline)
```

## Using it

| | |
|---|---|
| **Record** | Click the mic, or hold <kbd>Space</kbd> while you make the noise. Recording stops by itself when you go quiet (max 6 s). |
| **Edit lanes** | Drag points, drag on empty space to draw freehand, double-click to add or remove a point (right-click also removes). The faint line is what was measured from your voice; the dashed pitch line is what you hear after shift, contour, snap and vibrato. |
| **Style** | One-tap genres. Any control change after that makes it your own. |
| **Controls** | Oscillator, pitch shift, contour (exaggerate or flatten the melody), vibrato, sub bass, noise resonance, drive, bit crush, echo, reverb, length, reverse. Double-click a control's label to reset it. |
| **Takes** | Generate 4 to 12 variations from subtle to wild; audition, use one, or download them all as a ZIP (with the source sound and its recipe). |
| **Share** | Copies a link with the sound encoded in the URL (deflated, typically 300 to 900 characters). |

Shortcuts: <kbd>P</kbd>/<kbd>Enter</kbd> play, <kbd>O</kbd> play original, <kbd>E</kbd> export WAV, <kbd>S</kbd> save, <kbd>T</kbd> takes, <kbd>Ctrl/⌘ Z</kbd> undo (add <kbd>Shift</kbd> to redo), <kbd>Esc</kbd> stop.

## How it works

```
mic / file / demo voice
        │  mono PCM
        ▼
analyze()        resample to 22.05 kHz, high-pass, trim silence
                 per 10 ms frame: RMS, YIN f0 + aperiodicity,
                 FFT spectral centroid + flatness
        │  Analysis (dense per-frame series)
        ▼
analysisToPatch() octave-error repair, median filter, gap filling,
                 Ramer–Douglas–Peucker simplification to ≤48 points,
                 oscillator choice from harmonic richness (centroid ÷ f0)
        │  Patch (small JSON recipe, the thing you edit and share)
        ▼
render()         PolyBLEP oscillator + sub, TPT state-variable filters,
                 4-pole filtered noise, drive, bit crush, echo,
                 Freeverb-style reverb, tail trim, normalise to -1 dBFS
        │  Float32 samples (deterministic: same patch, same samples)
        ▼
WAV / ZIP / playback / share link
```

The whole DSP engine (`src/engine/`) is dependency-free TypeScript that runs identically in the browser and in Node, which is what lets the tests check the full loop: synthesise a sound, analyse it, and confirm the gesture comes back.

```
src/engine/   analysis, synthesis, effects, styles, variations, presets,
              demo voices, WAV/ZIP encoders, share-link codec
src/ui/       app shell, canvas lane editor, recorder, playback, library
tests/        unit tests (vitest)
scripts/e2e.mjs  end-to-end run in real Chromium with a fake microphone
```

## Quality checks

```bash
npm run check   # typecheck + lint + unit tests + production build
npm run e2e     # after a build: drives the real app in Chromium
```

The end-to-end script feeds Chromium a generated recording through its fake-microphone flag and walks the whole app: record and auto-stop, analysis, styles, dragging and freehand-drawing lanes, undo, takes and ZIP export, WAV export, share link round trip in a new tab, library persistence across reload, file import, help dialog, and a phone-sized light-theme layout check. Screenshots land in `test-results/`.

If Playwright can't find a browser on your machine, run `npx playwright install chromium` once.

## Known limitations

- It captures one gesture per take. Several separate sounds in one recording are kept as a single sound with gaps, which works but is less editable.
- Pitch tracking covers about 55 Hz to 2.5 kHz, which spans voices and whistles. Very breathy or very quiet performances read as noise, which is usually what you want.
- Recording uses `ScriptProcessorNode`. It's deprecated but supported by every current browser, and it's the most dependable way to get raw, unprocessed microphone audio.
- The library uses `localStorage`, so it is per browser. Use WAV export or share links to move sounds between devices.

## Hosted copy

`docs/index.html` is the single-file build (`npm run build:single`), committed so GitHub Pages can serve it from the `/docs` folder. Rebuild and recommit it after changing the app.
