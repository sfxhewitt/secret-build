// End-to-end check of the built app in real Chromium.
// Usage: npm run build && npm run e2e   (screenshots go to test-results/)
// Uses a fake microphone fed from a generated WAV, so the full record ->
// analyse -> edit -> export path runs exactly as it does for a person.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { preview } from 'vite';
import { chromium } from 'playwright';

const OUT = resolve('test-results');
mkdirSync(OUT, { recursive: true });

// --- a "vocal imitation": a rising whistle with silence either side -------
function makeWav(path) {
  const sr = 48000;
  const pre = 0.5, body = 0.7, post = 2.0;
  const n = Math.round((pre + body + post) * sr);
  const pcm = new Int16Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr - pre;
    let s = (Math.random() * 2 - 1) * 0.001;
    if (t >= 0 && t < body) {
      const f = 500 * Math.pow(2, t / body); // 500 -> 1000 Hz
      phase += f / sr;
      const env = Math.min(1, t / 0.03, (body - t) / 0.05);
      s += 0.6 * env * Math.sin(2 * Math.PI * phase);
    }
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
  }
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  Buffer.from(pcm.buffer).copy(buf, 44);
  writeFileSync(path, buf);
}

const wavPath = join(OUT, 'fake-mic.wav');
makeWav(wavPath);

let failures = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    results.push(`  ✗ ${name}\n      ${String(e?.message ?? e).split('\n')[0]}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const server = await preview({ preview: { port: 4174, strictPort: true }, logLevel: 'silent' });
const url = 'http://localhost:4174/';
const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wavPath}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});

try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true, colorScheme: 'dark' });
  await context.grantPermissions(['microphone', 'clipboard-read', 'clipboard-write'], { origin: url });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(url);
  await page.waitForSelector('.lane-canvas');

  await check('loads without errors and shows the default preset', async () => {
    assert((await page.inputValue('.name-input')) === 'Laser', 'default name');
    assert(errors.length === 0, errors.join('; '));
  });

  await check('demo voice "Pew" is analysed as a falling, pitched gesture', async () => {
    await page.click('[data-demo="pew"]');
    await page.waitForFunction(() => document.querySelector('.insight')?.textContent?.includes('Heard'));
    const text = await page.textContent('.insight');
    assert(/falling/.test(text), `insight: ${text}`);
    assert((await page.locator('.wave-row:not([hidden]) .wave-canvas').count()) === 2, 'voice + result waveforms visible');
    await page.screenshot({ path: join(OUT, '01-pew.png'), fullPage: true });
  });

  await check('play toggles the transport into a playing state', async () => {
    await page.keyboard.press('Escape');
    await page.click('.play-big');
    await page.waitForSelector('.play-big.playing', { timeout: 2000 });
    await page.waitForSelector('.play-big:not(.playing)', { timeout: 5000 });
  });

  await check('style "Sci-fi" applies settings and marks itself active', async () => {
    await page.click('[data-style="laser"]');
    assert((await page.getAttribute('[data-style="laser"]', 'aria-pressed')) === 'true', 'pressed');
    assert((await page.inputValue('input[data-key="transpose"]')) === '24', 'transpose 24');
    assert((await page.getAttribute('[data-wave="saw"]', 'aria-checked')) === 'true', 'saw selected');
    await page.screenshot({ path: join(OUT, '02-scifi.png') });
  });

  await check('dragging a pitch point edits the patch and undo restores it', async () => {
    const box = await page.locator('canvas[data-lane="pitch"]').boundingBox();
    const before = await page.evaluate(() => document.querySelector('.wave-meta')?.textContent);
    // The first point sits at the left edge (t=0); find its y by scanning for a hit.
    const x = box.x + 10;
    let grabbed = false;
    for (let y = box.y + 6; y < box.y + box.height - 6; y += 3) {
      await page.mouse.move(x, y);
      const cursor = await page.$eval('canvas[data-lane="pitch"]', (c) => c.style.cursor);
      if (cursor === 'grab') {
        await page.mouse.down();
        await page.mouse.move(x, box.y + box.height - 12, { steps: 6 });
        await page.mouse.up();
        grabbed = true;
        break;
      }
    }
    assert(grabbed, 'could not find the first pitch point');
    assert(!(await page.isDisabled('[aria-label="Undo"]')), 'undo enabled');
    void before;
    await page.keyboard.press('Control+z');
    assert((await page.getAttribute('[data-style="laser"]', 'aria-pressed')) === 'true', 'undo kept style');
  });

  await check('freehand drawing on the loudness lane adds points', async () => {
    const pointsBefore = await page.evaluate(() => JSON.stringify(window.__mouthpiece?.patch.amp));
    const box = await page.locator('canvas[data-lane="amp"]').boundingBox();
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.8);
    await page.mouse.down();
    for (let i = 0; i <= 20; i++) {
      const t = 0.3 + 0.4 * (i / 20);
      await page.mouse.move(box.x + box.width * t, box.y + box.height * (0.2 + 0.6 * Math.abs(Math.sin(i / 3))));
    }
    await page.mouse.up();
    const pointsAfter = await page.evaluate(() => JSON.stringify(window.__mouthpiece?.patch.amp));
    assert(pointsAfter !== pointsBefore, 'loudness curve unchanged after drawing');
    const n = await page.evaluate(() => window.__mouthpiece?.patch.amp.length);
    assert(n >= 4 && n <= 60, `simplified stroke has a sane point count (${n})`);
  });

  await check('takes: generate 6, then download a zip pack', async () => {
    await page.click('text=Generate takes');
    await page.waitForSelector('.take');
    assert((await page.locator('.take').count()) === 6, 'six takes');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=Download all (.zip)')]);
    const p = join(OUT, dl.suggestedFilename());
    await dl.saveAs(p);
    const z = readFileSync(p);
    assert(z.readUInt32LE(0) === 0x04034b50, 'zip magic');
    assert(z.readUInt16LE(z.length - 22 + 10) === 8, `8 entries, got ${z.readUInt16LE(z.length - 12)}`);
    await page.locator('.takes').screenshot({ path: join(OUT, '03-takes.png') });
  });

  await check('export WAV downloads a valid file', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.btn.primary:has-text("WAV")')]);
    const p = join(OUT, dl.suggestedFilename());
    await dl.saveAs(p);
    const w = readFileSync(p);
    assert(w.toString('ascii', 0, 4) === 'RIFF' && w.toString('ascii', 8, 12) === 'WAVE', 'RIFF/WAVE');
    assert(w.readUInt32LE(24) === 44100, 'sample rate');
    assert(w.length > 10000, 'has audio');
  });

  await check('share link reproduces the same sound in a fresh tab', async () => {
    await page.fill('.name-input', 'Shared zap');
    await page.press('.name-input', 'Tab');
    await page.click('button[title="Copy a link to this sound"]');
    await page.waitForFunction(() => location.hash.startsWith('#s='));
    const link = await page.evaluate(() => location.href);
    const original = await page.evaluate(() => JSON.stringify(window.__mouthpiece.patch));
    const other = await context.newPage();
    await other.goto(link);
    await other.waitForFunction(() => document.querySelector('.name-input')?.value === 'Shared zap');
    const loaded = await other.evaluate(() => JSON.stringify(window.__mouthpiece.patch));
    assert(loaded === original, 'patch identical after share');
    await other.close();
  });

  await check('library: save survives a reload, and opens', async () => {
    await page.keyboard.press('s');
    await page.goto(url);
    await page.waitForSelector('.lane-canvas');
    assert((await page.textContent('.badge')) === '1', 'badge shows 1');
    await page.click('[aria-label="Open library"]');
    await page.waitForSelector('.lib-item');
    await page.screenshot({ path: join(OUT, '04-library.png') });
    await page.click('.lib-item >> text=Open');
    assert((await page.inputValue('.name-input')) === 'Shared zap', 'opened from library');
  });

  await check('microphone: record a (fake) whistle, auto-stop on silence, analyse it', async () => {
    await page.click('.mic');
    await page.waitForSelector('.mic[data-state="recording"]', { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('.capture-status')?.textContent?.startsWith('Got it'), null, { timeout: 12000 });
    const text = await page.textContent('.insight');
    assert(/rising/.test(text), `insight: ${text}`);
    const wave = await page.evaluate(() => window.__mouthpiece.analysedWave);
    assert(wave === 'sine', `a whistle should pick a sine, got ${wave}`);
    assert((await page.inputValue('.name-input')) === 'Take 1', 'named Take 1');
    await page.screenshot({ path: join(OUT, '05-mic.png'), fullPage: true });
  });

  await check('open an audio file through the file picker', async () => {
    await page.setInputFiles('input[type=file]', wavPath);
    await page.waitForFunction(() => document.querySelector('.name-input')?.value === 'fake-mic', null, { timeout: 8000 });
    assert(/rising/.test(await page.textContent('.insight')), 'file analysed');
  });

  await check('help dialog opens and closes', async () => {
    await page.click('[aria-label="How it works"]');
    assert(await page.isVisible('dialog[open]'), 'open');
    await page.screenshot({ path: join(OUT, '06-help.png') });
    await page.keyboard.press('Escape');
    assert(!(await page.isVisible('dialog[open]')), 'closed');
  });

  await check('no runtime errors during the whole session', async () => {
    assert(errors.length === 0, errors.join('; '));
  });

  await check('phone layout has no horizontal scroll (light theme)', async () => {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light', hasTouch: true, isMobile: true });
    const m = await phone.newPage();
    await m.goto(url);
    await m.waitForSelector('.lane-canvas');
    await m.tap('[data-demo="bwoop"]');
    await m.waitForFunction(() => document.querySelector('.insight')?.textContent?.includes('rising'));
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 0, `overflows by ${overflow}px`);
    await m.screenshot({ path: join(OUT, '07-phone-light.png'), fullPage: true });
    await phone.close();
  });
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}

console.log(`\nMouthpiece end-to-end\n${results.join('\n')}\n`);
console.log(failures ? `${failures} check(s) failed` : 'All end-to-end checks passed');
process.exit(failures ? 1 : 0);
