#!/usr/bin/env node
/*
 * Meeting Copilot helper.
 * Serves meeting-copilot.html on http://localhost:8765 and gets the suggestions
 * from the Claude Code CLI already logged in on this computer, so they run on
 * the Claude subscription instead of a paid API key.
 *
 * Run:  node copilot-server.js      (or double-click start-copilot.bat on Windows)
 * Needs: Node 18+, and Claude Code installed and logged in (`claude`, then /login).
 * Listens on 127.0.0.1 only. Nothing is written to disk except a temp prompt file.
 */
'use strict';
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'),
      os = require('os'), crypto = require('crypto'), { spawn, spawnSync } = require('child_process');

const PORT  = +process.env.COPILOT_PORT || 8765;
const MODEL = process.env.COPILOT_MODEL || 'haiku';
const BIN   = process.env.COPILOT_CLAUDE_BIN || 'claude';
const WIN   = process.platform === 'win32';
const WORK  = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-copilot-'));
const PAGE  = [path.join(__dirname, 'meeting-copilot.html'), path.join(__dirname, 'index.html')].find(f => fs.existsSync(f)) || path.join(__dirname, 'index.html');
const TURN_TIMEOUT_MS = 30000;
// Hosted copy of the page that may talk to this helper (besides localhost itself).
const EXTRA_ORIGINS = (process.env.COPILOT_ORIGINS || 'https://sfxhewitt.github.io').split(',').map(s => s.trim()).filter(Boolean);
const MAX_TURNS_PER_SESSION = 120;

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const q = a => (a === '' || /[\s"&|<>^]/.test(a)) ? '"' + a.replace(/"/g, '\\"') + '"' : a;

function childEnv(){
  const env = { ...process.env };
  // Make sure the CLI uses the subscription login, not a pay-as-you-go key.
  delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}
function run(args){
  const opts = { cwd: WORK, env: childEnv(), windowsHide: true };
  if (WIN) return spawn([q(BIN), ...args.map(q)].join(' '), { ...opts, shell: true });
  return spawn(BIN, args, opts);
}
function claudeVersion(){
  try {
    const r = WIN ? spawnSync(q(BIN) + ' --version', { shell: true, encoding: 'utf8', timeout: 15000 })
                  : spawnSync(BIN, ['--version'], { encoding: 'utf8', timeout: 15000 });
    if (r.status === 0) return (r.stdout || '').trim();
  } catch (e) {}
  return null;
}

/* ---------- Claude session ---------- */
// Flag sets, most capable first. If one fails to start, the next is tried,
// and finally a plain one-shot call per suggestion.
const SESSION_FLAGS = [
  ['--tools', '', '--strict-mcp-config', '--no-session-persistence', '--include-partial-messages'],
  ['--strict-mcp-config', '--include-partial-messages'],
  []
];
const state = { mode: 'session', variant: 0, proc: null, hash: null, spFile: null, seen: 0, turns: 0,
                buf: '', cur: null, okTurns: 0, lastMs: null };

function writePrompt(system){
  const hash = crypto.createHash('sha1').update(system).digest('hex');
  const f = path.join(WORK, 'system-' + hash.slice(0, 10) + '.txt');
  if (!fs.existsSync(f)) fs.writeFileSync(f, system, 'utf8');
  return { hash, f };
}
function killSession(){
  if (state.proc){ try { state.proc.stdin.end(); } catch (e) {} try { state.proc.kill(); } catch (e) {} }
  state.proc = null; state.buf = ''; state.seen = 0; state.turns = 0;
}
function startSession(system){
  killSession();
  const { hash, f } = writePrompt(system);
  state.hash = hash; state.spFile = f;
  const args = ['-p', '--model', MODEL, '--system-prompt-file', f,
                '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
                ...SESSION_FLAGS[state.variant]];
  const p = state.proc = run(args);
  let err = '';
  p.stderr.on('data', d => { err = (err + d).slice(-2000); });
  p.stdout.on('data', d => onStdout(p, d));
  p.on('error', e => failCurrent(p, 'Could not run Claude Code (' + e.message + ').'));
  p.on('exit', code => {
    if (state.proc === p) state.proc = null;
    failCurrent(p, 'Claude Code stopped (exit ' + code + '). ' + err.trim().split('\n').pop());
  });
  log('Started Claude session (flag set ' + (state.variant + 1) + ' of ' + SESSION_FLAGS.length + ')');
}
function failCurrent(p, msg){
  const c = state.cur;
  if (c && c.proc === p){ state.cur = null; clearTimeout(c.timer); c.reject(new Error(msg)); }
}
function onStdout(p, d){
  state.buf += d.toString('utf8');
  let i;
  while ((i = state.buf.indexOf('\n')) >= 0){
    const line = state.buf.slice(0, i).trim(); state.buf = state.buf.slice(i + 1);
    if (!line || line[0] !== '{') continue;
    let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
    const c = state.cur; if (!c || c.proc !== p) continue;
    if (ev.type === 'stream_event' && ev.event && ev.event.type === 'content_block_delta' &&
        ev.event.delta && typeof ev.event.delta.text === 'string'){
      c.text += ev.event.delta.text; c.streamed = true; c.onDelta(ev.event.delta.text);
    } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)){
      const t = ev.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
      if (!c.streamed && t){ c.text += t; c.onDelta(t); }
      c.finalText = t || c.finalText;
    } else if (ev.type === 'result' || ('duration_api_ms' in ev && 'terminal_reason' in ev)){
      state.cur = null; clearTimeout(c.timer);
      const bad = ev.is_error || ev.terminal_reason === 'api_error' || (ev.subtype && ev.subtype !== 'success');
      if (bad) c.reject(new Error((c.finalText || c.text || ev.result || 'Claude Code reported an error').toString().slice(0, 300)));
      else c.resolve(c.text || c.finalText || '');
    }
  }
}
function sessionAsk(text, onDelta){
  return new Promise((resolve, reject) => {
    const p = state.proc;
    if (!p) return reject(new Error('Claude session is not running.'));
    const c = state.cur = { proc: p, text: '', finalText: '', streamed: false, onDelta, resolve, reject, timer: null };
    c.timer = setTimeout(() => { if (state.cur === c){ state.cur = null; killSession(); reject(new Error('Claude took too long to answer.')); } }, TURN_TIMEOUT_MS);
    try { p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'); }
    catch (e) { state.cur = null; clearTimeout(c.timer); reject(e); }
  });
}
function oneShot(system, text, onDelta){
  return new Promise((resolve, reject) => {
    const { f } = writePrompt(system);
    const p = run(['-p', '--model', MODEL, '--system-prompt-file', f, '--output-format', 'text']);
    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch (e) {} reject(new Error('Claude took too long to answer.')); }, TURN_TIMEOUT_MS);
    p.stdout.on('data', d => { const s = d.toString('utf8'); out += s; onDelta(s); });
    p.stderr.on('data', d => { err = (err + d).slice(-2000); });
    p.on('error', e => { clearTimeout(timer); reject(new Error('Could not run Claude Code (' + e.message + ').')); });
    p.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error((out || err || 'Claude Code exited ' + code).trim().slice(0, 300))); });
    p.stdin.end(text);
  });
}

const fmt = segs => segs.map(s => s.who + ': ' + s.text).join('\n');
function tail(b){
  const pts = (b.points || []).length ? '\n\nPoints still to raise (cue one with ASK only at a natural gap):\n' + b.points.map(p => '* ' + p).join('\n') : '';
  return pts + '\n\nWhat should ' + (b.me || 'I') + ' say next? Reply in the required format only.';
}
async function ask(b, onDelta){
  const system = String(b.system || '');
  const segs = Array.isArray(b.segs) ? b.segs : [];
  const total = Number.isFinite(b.total) ? b.total : segs.length;
  const t0 = Date.now();

  while (state.mode === 'session'){
    const { hash } = writePrompt(system);
    if (!state.proc || state.hash !== hash || state.turns >= MAX_TURNS_PER_SESSION) startSession(system);
    const fresh = segs.slice(Math.max(0, segs.length - Math.max(0, total - state.seen)));
    const first = state.seen === 0;
    let msg;
    if (b.warm) msg = 'The call has not started yet. Reply with exactly: WAIT';
    else if (first) msg = 'TRANSCRIPT SO FAR:\n' + (fmt(segs) || '(nothing said yet)') + tail(b);
    else msg = (fresh.length ? 'NEW TRANSCRIPT LINES:\n' + fmt(fresh) : 'No new lines since your last suggestion. Give your best suggestion for this moment.') + tail(b);
    try {
      const out = await sessionAsk(msg, onDelta);
      if (!b.warm) state.seen = total;
      state.turns++; state.okTurns++; state.lastMs = Date.now() - t0;
      return out;
    } catch (e) {
      killSession();
      const authy = /auth|log ?in|credential|api key|401|403|could not run|not recognized|ENOENT/i.test(e.message);
      if (state.okTurns === 0 && !authy && state.variant < SESSION_FLAGS.length - 1){ state.variant++; log('Session start failed, trying simpler flags:', e.message); continue; }
      if (state.okTurns === 0 && !authy){ state.mode = 'oneshot'; log('Falling back to one call per suggestion:', e.message); break; }
      throw e;
    }
  }
  const msg = b.warm ? 'Reply with exactly: WAIT' : 'TRANSCRIPT SO FAR:\n' + (fmt(segs) || '(nothing said yet)') + tail(b);
  const out = await oneShot(system, msg, onDelta);
  state.okTurns++; state.lastMs = Date.now() - t0;
  return out;
}

/* one request at a time; a newer waiting request replaces an older waiting one */
let busy = false, waiting = null;
function enqueue(job){
  return new Promise((resolve, reject) => {
    const item = { job, resolve, reject };
    if (!busy){ runItem(item); return; }
    if (waiting) waiting.reject(Object.assign(new Error('superseded'), { superseded: true }));
    waiting = item;
  });
}
async function runItem(item){
  busy = true;
  try { item.resolve(await item.job()); } catch (e) { item.reject(e); }
  busy = false;
  if (waiting){ const w = waiting; waiting = null; runItem(w); }
}

/* ---------- HTTP ---------- */
function readJson(req){
  return new Promise((resolve, reject) => {
    let s = ''; req.on('data', d => { s += d; if (s.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const sendJson = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
function allowed(req){
  const hosts = ['localhost:' + PORT, '127.0.0.1:' + PORT];
  if (!hosts.includes(req.headers.host || '')) return false;
  const o = req.headers.origin;
  if (o && !hosts.map(h => 'http://' + h).includes(o) && !EXTRA_ORIGINS.includes(o)) return false;
  if (req.method === 'OPTIONS') return true;
  if (req.method === 'POST' && req.headers['x-copilot'] !== '1') return false;
  return true;
}
function elToken(key){
  return new Promise((resolve, reject) => {
    const r = https.request('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe',
      { method: 'POST', headers: { 'xi-api-key': key, 'content-length': 0 }, timeout: 15000 }, resp => {
        let s = ''; resp.on('data', d => s += d); resp.on('end', () => resolve({ status: resp.statusCode, body: s }));
      });
    r.on('timeout', () => r.destroy(new Error('ElevenLabs did not respond')));
    r.on('error', reject); r.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (!allowed(req)) return sendJson(res, 403, { error: 'forbidden' });
  const url = (req.url || '/').split('?')[0];
  if (EXTRA_ORIGINS.includes(req.headers.origin)){
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS'){
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'content-type, x-copilot',
                         'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600' });
    return res.end();
  }
  try {
    if (req.method === 'GET' && (url === '/' || url === '/meeting-copilot.html')){
      if (!fs.existsSync(PAGE)) return sendJson(res, 404, { error: 'meeting-copilot.html must be in the same folder as copilot-server.js' });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return fs.createReadStream(PAGE).pipe(res);
    }
    if (req.method === 'GET' && url === '/health')
      return sendJson(res, 200, { ok: true, helper: 'meeting-copilot', mode: state.mode, model: MODEL, lastMs: state.lastMs });
    if (req.method === 'POST' && url === '/el-token'){
      const b = await readJson(req);
      if (!b.key) return sendJson(res, 400, { error: 'No ElevenLabs key given' });
      const r = await elToken(String(b.key));
      res.writeHead(r.status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(r.body);
    }
    if (req.method === 'POST' && (url === '/suggest' || url === '/warm')){
      const b = await readJson(req); if (url === '/warm') b.warm = true;
      let started = false;
      try {
        const t0 = Date.now();
        await enqueue(() => ask(b, chunk => {
          if (b.warm) return;
          if (!started){ started = true; res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' }); }
          res.write(chunk);
        }));
        if (b.warm) return sendJson(res, 200, { ok: true, ms: Date.now() - t0, mode: state.mode });
        if (!started) res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end();
      } catch (e) {
        if (started) return res.end();
        if (e.superseded) return sendJson(res, 409, { error: 'superseded' });
        log('Suggestion failed:', e.message);
        return sendJson(res, 500, { error: e.message });
      }
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) { try { sendJson(res, 500, { error: e.message }); } catch (_) {} }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error('\nPort ' + PORT + ' is already in use. The helper is probably already running: open http://localhost:' + PORT + '\n');
  else console.error(e);
  process.exit(1);
});
function shutdown(){ killSession(); try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {} process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

server.listen(PORT, '127.0.0.1', () => {
  const url = 'http://localhost:' + PORT;
  const v = claudeVersion();
  console.log('\n  Meeting Copilot helper is running.\n  Open: ' + url + '   (use Chrome or Edge)\n  Leave this window open during the call. Close it to stop.\n');
  if (v) console.log('  Claude Code found: ' + v + '\n');
  else console.log('  WARNING: could not run "claude". Install Claude Code and log in (run: claude, then /login),\n  then start this helper again. Transcription will still work; suggestions will not.\n');
  if (!process.env.COPILOT_NO_OPEN){
    try {
      if (WIN) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    } catch (e) {}
  }
});
