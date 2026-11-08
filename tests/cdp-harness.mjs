// Shared helper for the real-browser scripts: starts a separate Chrome (temporary profile) with a DevTools pipe, loads this
// folder as an unpacked extension, and offers small helpers to talk to its pages and service worker. Pure Node, no packages.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  return [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`, '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && existsSync(p));
}

export function createReporter() {
  const results = [];
  const log = (ok, name, detail = '') => { results.push([ok, name, detail]); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
  return {
    results,
    pass: (n, d) => log(true, n, d),
    fail: (n, d) => log(false, n, d),
    expect: (c, n, d) => log(Boolean(c), n, d),
    summary() {
      const failed = results.filter((r) => !r[0]);
      console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
      for (const [, n, d] of failed) console.log(`  FAILED: ${n} ${d}`);
      return failed.length;
    },
  };
}

/** A local stand-in for the web: every hostname is mapped to 127.0.0.1, so "http://github.com:PORT/" is served by this. */
export async function startSite() {
  const server = createServer((req, res) => {
    const host = String(req.headers.host || '').split(':')[0];
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>${host} page</title><body><h1>${host}</h1><input id="box" aria-label="box">`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, site: (host, path = '/') => `http://${host}:${port}${path}`, close: () => server.close() };
}

export async function launch({ headful = false, extraArgs = [] } = {}) {
  const exe = findChrome();
  if (!exe) throw new Error('Chrome not found (set CHROME_PATH).');
  const profile = mkdtempSync(join(tmpdir(), 'tabfold-e2e-'));
  const args = [
    `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check',
    '--disable-search-engine-choice-screen', '--disable-sync', '--disable-background-networking', '--window-position=40,40', '--window-size=1000,720',
    '--host-resolver-rules=MAP * 127.0.0.1', ...(headful ? [] : ['--headless=new']), ...extraArgs, 'about:blank',
  ];
  const chrome = spawn(exe, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const toChrome = chrome.stdio[3];
  const fromChrome = chrome.stdio[4];
  let nextId = 1;
  const pending = new Map();
  let buffer = '';
  fromChrome.on('data', (d) => {
    buffer += d.toString('utf8');
    let i;
    while ((i = buffer.indexOf('\0')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result); }
    }
  });
  const cdp = (method, params = {}, sessionId) => new Promise((resolveFn, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolveFn, reject });
    toChrome.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  async function evaluate(sessionId, expression) {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
    if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }
  const attach = async (targetId) => (await cdp('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  async function until(fn, what, ms = 8000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(100); } }

  async function loadExtension() {
    const loaded = await cdp('Extensions.loadUnpacked', { path: root });
    const id = loaded.id;
    const target = await until(async () => (await cdp('Target.getTargets')).targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${id}/`)), 'service worker target');
    const sw = await attach(target.targetId);
    await cdp('Runtime.enable', {}, sw);
    await until(() => evaluate(sw, `typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id && typeof __tabfold !== 'undefined'`).catch(() => false), 'the service worker to finish starting');
    return { id, sw, swTargetId: target.targetId };
  }

  async function close() {
    try { if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); else chrome.kill('SIGKILL'); } catch { /* gone */ }
    await sleep(800);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* temp folder: harmless */ }
  }
  return { chrome, pid: chrome.pid, profile, cdp, evaluate, attach, until, loadExtension, close, exe };
}
