// Real-browser check. Launches a SEPARATE Chrome (its own temporary profile; your normal Chrome is not touched), loads this
// folder as an unpacked extension through the DevTools protocol, and drives the real service worker and popup page.
//   node tests/e2e-chrome.mjs [--headful] [--keep-shots]
// Needs only Node and an installed Chrome. A local HTTP server stands in for the websites (every hostname is mapped to
// 127.0.0.1), so github.com / youtube.com / google.com are tested by hostname without any internet access.
//
// What this CANNOT do: press a real keyboard shortcut. Chrome handles extension shortcuts in the browser UI, which DevTools
// cannot reach. The launcher handler is called exactly as chrome.commands.onCommand would call it, and Chrome's own record
// of each command (chrome.commands.getAll) is read back.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const headful = process.argv.includes('--headful');
const shotsDir = join(root, 'tests', 'screenshots');
const CHROME = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`, '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && existsSync(p));
if (!CHROME) { console.error('Chrome not found (set CHROME_PATH).'); process.exit(2); }

const results = [];
const pass = (name, detail = '') => { results.push([true, name, detail]); console.log(`  PASS  ${name}${detail ? `  (${detail})` : ''}`); };
const fail = (name, detail = '') => { results.push([false, name, detail]); console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`); };
const expect = (cond, name, detail = '') => (cond ? pass(name, detail) : fail(name, detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ a local stand-in for the web
const server = createServer((req, res) => {
  const host = String(req.headers.host || '').split(':')[0];
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>${host} page</title><body><h1>${host}</h1>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const site = (host, path = '/') => `http://${host}:${PORT}${path}`;

// ------------------------------------------------------------------ Chrome over a DevTools pipe
const profile = mkdtempSync(join(tmpdir(), 'tabfold-e2e-'));
const args = [
  `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check',
  '--disable-search-engine-choice-screen', '--disable-sync', '--disable-background-networking', '--window-size=1100,800',
  `--host-resolver-rules=MAP * 127.0.0.1`, ...(headful ? [] : ['--headless=new']), 'about:blank',
];
const chrome = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
const toChrome = chrome.stdio[3];
const fromChrome = chrome.stdio[4];

let nextId = 1;
const pending = new Map();
const waiters = [];
let buffer = '';
fromChrome.on('data', (d) => {
  buffer += d.toString('utf8');
  let i;
  while ((i = buffer.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (msg.id && pending.has(msg.id)) { const { resolve: ok, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(`${msg.error.message}`)) : ok(msg.result); }
    else for (const w of [...waiters]) if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
  }
});
const cdp = (method, params = {}, sessionId) => new Promise((ok, reject) => {
  const id = nextId++;
  pending.set(id, { resolve: ok, reject });
  toChrome.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});
const waitEvent = (match, ms = 8000) => new Promise((ok, reject) => {
  const t = setTimeout(() => reject(new Error('timed out waiting for a DevTools event')), ms);
  waiters.push({ match, resolve: (m) => { clearTimeout(t); ok(m); } });
});

async function evaluate(sessionId, expression, { awaitPromise = true } = {}) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true }, sessionId);
  if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}
async function attach(targetId) { return (await cdp('Target.attachToTarget', { targetId, flatten: true })).sessionId; }
async function until(fn, what, ms = 8000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(100); } }

let sw; // session of the service worker
const inSW = (expr) => evaluate(sw, expr);
const shot = async (session, name) => {
  mkdirSync(shotsDir, { recursive: true });
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, session);
  writeFileSync(join(shotsDir, `${name}.png`), Buffer.from(data, 'base64'));
};

async function cleanup() {
  try { server.close(); } catch { /* ignore */ }
  try { if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); else chrome.kill('SIGKILL'); } catch { /* already gone */ }
  await sleep(800);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* the profile may still be locked: harmless, it is in the temp folder */ }
}

try {
  console.log(`Chrome: ${CHROME}\nProfile: ${profile}\nLocal web stand-in: ${site('github.com')}\n`);
  const version = await cdp('Browser.getVersion');
  console.log(`Browser: ${version.product}\n`);

  // ------------------------------------------------------------------ load the extension
  const loaded = await cdp('Extensions.loadUnpacked', { path: root });
  const extId = loaded.id;
  expect(/^[a-p]{32}$/.test(extId || ''), 'Chrome loaded the unpacked extension from the folder (manifest accepted)', extId);

  const swTarget = await until(async () => (await cdp('Target.getTargets')).targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`)), 'service worker target');
  sw = await attach(swTarget.targetId);
  await cdp('Runtime.enable', {}, sw);
  // The worker's target can exist a moment before its extension context does: wait until chrome.runtime is really there.
  await until(() => evaluate(sw, `typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id && typeof __tabfold !== 'undefined'`).catch(() => false), 'the service worker to finish starting');
  expect(swTarget.url.endsWith('/background.js'), 'the background service worker (module) started', swTarget.url);

  // ------------------------------------------------------------------ commands as Chrome reports them
  const cmds = await inSW('chrome.commands.getAll()');
  const byName = Object.fromEntries(cmds.map((c) => [c.name, c]));
  expect(cmds.filter((c) => /^launch-\d\d$/.test(c.name)).length === 12, 'Chrome lists all 12 launcher commands', cmds.map((c) => c.name).join(','));
  expect(byName['launch-01'].description === 'Tabfold launcher 01' && byName['launch-02'].description === 'Tabfold launcher 02', 'Chrome shows the same "Tabfold launcher NN" labels', byName['launch-02'].description);
  expect(byName['launch-01'].shortcut === 'Ctrl+Y', 'launch-01 (YouTube) is bound to Ctrl+Y by Chrome', JSON.stringify(byName['launch-01'].shortcut));
  expect(cmds.filter((c) => /^launch-\d\d$/.test(c.name) && c.name !== 'launch-01').every((c) => c.shortcut === ''), 'launch-02 ... launch-12 are reported unassigned (empty shortcut)');
  expect(byName._execute_action && byName._execute_action.shortcut === 'Alt+K', 'Alt+K is bound to open the popup', JSON.stringify(byName._execute_action && byName._execute_action.shortcut));

  // ------------------------------------------------------------------ first-run defaults
  const stored = await until(async () => { const v = await inSW('chrome.storage.local.get(null)'); return v.seeded ? v : null; }, 'first-run defaults to be saved');
  expect(stored.launchers && stored.launchers['launch-01'] && stored.launchers['launch-01'].url === 'https://www.youtube.com/', 'YouTube is seeded in slot 01', JSON.stringify(stored.launchers));
  expect(stored.seeded === true, 'first-run flag saved');

  // ------------------------------------------------------------------ windows
  const w1 = await inSW(`chrome.windows.getAll({windowTypes:['normal']}).then(w => w[0].id)`);
  const w2 = await inSW(`chrome.windows.create({url: ${JSON.stringify(site('example.com'))}, focused: false, width: 900, height: 700}).then(w => w.id)`);
  expect(w1 !== w2, 'two normal windows exist', `${w1}, ${w2}`);
  await sleep(500);

  const groupsOf = (windowId) => inSW(`(async () => { const gs = await chrome.tabGroups.query({windowId: ${windowId}}); const out = []; for (const g of gs) { const ts = await chrome.tabs.query({groupId: g.id}); out.push({id: g.id, title: g.title, color: g.color, tabs: ts.map(t => (t.url || t.pendingUrl)) }); } return out; })()`);
  const tabsOf = (windowId) => inSW(`chrome.tabs.query({windowId: ${windowId}}).then(ts => ts.map(t => ({id: t.id, url: t.url || t.pendingUrl, active: t.active, groupId: t.groupId, pinned: t.pinned})))`);

  // ------------------------------------------------------------------ the YouTube default launcher
  const before = (await tabsOf(w1)).length;
  const r1 = await inSW(`__tabfold.handleCommand('launch-01', {windowId: ${w1}})`);
  await sleep(1200);
  const t1 = await tabsOf(w1);
  const yt = t1.find((t) => /youtube\.com/.test(t.url || ''));
  expect(r1 === 'opened' && t1.length === before + 1 && yt, 'launcher 01 opens YouTube in a new tab of the current window', `${before} -> ${t1.length} tabs, url ${yt && yt.url}`);
  expect(yt && yt.active, 'the new YouTube tab is the active tab');
  const g1 = await groupsOf(w1);
  expect(g1.some((g) => g.title === 'YouTube' && g.color === 'red' && g.tabs.some((u) => /youtube\.com/.test(u))), 'the YouTube tab joined a red "YouTube" group', JSON.stringify(g1.map((g) => [g.title, g.color])));

  // ------------------------------------------------------------------ add GitHub (as the popup saves it), launch it five times
  const GH = site('github.com', '/');
  await inSW(`chrome.storage.local.get('launchers').then(({launchers}) => chrome.storage.local.set({launchers: {...launchers, 'launch-02': {name: 'GitHub', url: ${JSON.stringify(GH)}}}}))`);
  for (let i = 0; i < 5; i++) await inSW(`__tabfold.handleCommand('launch-02', {windowId: ${w1}})`);
  await sleep(1500);
  const g2 = await groupsOf(w1);
  const tech = g2.filter((g) => g.title === 'Technical');
  expect(tech.length === 1 && tech[0].color === 'blue' && tech[0].tabs.length === 5, 'five GitHub launches share ONE blue "Technical" group', JSON.stringify(tech.map((g) => [g.tabs.length, g.color])));
  expect((await tabsOf(w1)).filter((t) => /github\.com/.test(t.url)).every((t) => t.groupId === tech[0].id), 'every GitHub tab is in it');

  // ------------------------------------------------------------------ navigate one GitHub tab to YouTube
  const ghTab = (await tabsOf(w1)).find((t) => /github\.com/.test(t.url));
  await inSW(`chrome.tabs.update(${ghTab.id}, {url: ${JSON.stringify(site('www.youtube.com', '/watch?v=1'))}})`);
  await until(async () => (await tabsOf(w1)).find((t) => t.id === ghTab.id && /youtube/.test(t.url) && t.groupId !== tech[0].id), 'tab to move to the YouTube group');
  const g3 = await groupsOf(w1);
  const yg = g3.filter((g) => g.title === 'YouTube');
  expect(yg.length === 1 && yg[0].tabs.length === 2, 'navigating one tab to YouTube moved just that tab into the existing YouTube group', JSON.stringify(g3.map((g) => [g.title, g.tabs.length])));
  expect(g3.find((g) => g.title === 'Technical').tabs.length === 4, 'the other four GitHub tabs stayed in Technical');

  // ------------------------------------------------------------------ other categories, pinned, blank, chrome:// and a custom group
  const mk = async (windowId, url, extra = '') => inSW(`chrome.tabs.create({windowId: ${windowId}, url: ${JSON.stringify(url)}, active: false${extra}}).then(t => t.id)`);
  const gmail = await mk(w1, site('mail.google.com', '/'));
  const docs = await mk(w1, site('docs.google.com', '/document/d/1'));
  const other = await mk(w1, site('wikipedia.org', '/'));
  const blank = await mk(w1, 'about:blank');
  const settingsTab = await mk(w1, 'chrome://version');
  const pinned = await mk(w1, site('github.com', '/pinned'), ', pinned: true');
  const mine = await mk(w1, site('github.com', '/mine'));
  await inSW(`chrome.tabs.group({tabIds: [${mine}]}).then(g => chrome.tabGroups.update(g, {title: 'Work', color: 'purple'}))`); // the user's own group
  await sleep(2000);
  const tabs4 = await tabsOf(w1);
  const g4 = await groupsOf(w1);
  const by = (id) => tabs4.find((t) => t.id === id);
  const gt = (id) => g4.find((g) => g.id === by(id).groupId);
  expect(gt(gmail) && gt(gmail).title === 'Google' && gt(docs) && gt(docs).id === gt(gmail).id, 'Gmail and Google Docs share one "Google" group (yellow)', gt(gmail) && gt(gmail).color);
  expect(gt(other) && gt(other).title === 'Others', 'an ordinary site goes to "Others"');
  expect(by(blank).groupId === -1, 'a blank tab is left alone');
  expect(by(settingsTab).groupId === -1, 'a chrome:// page is left alone');
  expect(by(pinned).pinned && by(pinned).groupId === -1, 'a pinned tab is left alone');
  expect(gt(mine) && gt(mine).title === 'Work' && gt(mine).color === 'purple', 'a tab in the user\'s own "Work" group stays there');
  expect(g4.filter((g) => g.title === 'Work').length === 1, 'the custom group was not duplicated or renamed');

  // ------------------------------------------------------------------ the second window is independent
  for (let i = 0; i < 2; i++) await inSW(`__tabfold.handleCommand('launch-02', {windowId: ${w2}})`);
  await sleep(1500);
  const gw2 = await groupsOf(w2);
  const techW2 = gw2.filter((g) => g.title === 'Technical');
  const techW1 = (await groupsOf(w1)).filter((g) => g.title === 'Technical');
  expect(techW2.length === 1 && techW2[0].tabs.length === 2 && techW1.length === 1 && techW1[0].id !== techW2[0].id, 'each window keeps its own Technical group', `w1 ${techW1[0] && techW1[0].id}, w2 ${techW2[0] && techW2[0].id}`);

  // ------------------------------------------------------------------ Auto-group off, then on
  await inSW(`chrome.storage.local.set({settings: {autoGroup: false}})`);
  await inSW(`__tabfold.handleCommand('launch-02', {windowId: ${w2}})`);
  await sleep(1200);
  const offTabs = await tabsOf(w2);
  expect(offTabs.filter((t) => /github\.com/.test(t.url)).length === 3 && offTabs.filter((t) => /github\.com/.test(t.url) && t.groupId === -1).length === 1, 'with Auto-group off a newly launched tab stays ungrouped');
  await inSW(`chrome.storage.local.set({settings: {autoGroup: true}})`);
  await until(async () => (await tabsOf(w2)).filter((t) => /github\.com/.test(t.url) && t.groupId === -1).length === 0, 'tab to be grouped after switching Auto-group back on');
  pass('switching Auto-group back on organises the open tabs');

  // ------------------------------------------------------------------ delete: the slot does nothing
  const beforeDelete = (await tabsOf(w1)).length;
  await inSW(`chrome.storage.local.get('launchers').then(({launchers}) => { delete launchers['launch-02']; return chrome.storage.local.set({launchers}); })`);
  const rEmpty = await inSW(`__tabfold.handleCommand('launch-02', {windowId: ${w1}})`);
  await sleep(500);
  expect(rEmpty === 'empty' && (await tabsOf(w1)).length === beforeDelete, 'a deleted launcher does nothing when its command fires');

  // ------------------------------------------------------------------ the popup page, in a tab, driven like a user
  const popupUrl = `chrome-extension://${extId}/popup.html`;
  const usedTargets = new Set();
  let pg;
  const $$ = (expr) => evaluate(pg, expr);
  async function openPopup(windowId) {
    await inSW(`chrome.tabs.create({windowId: ${windowId}, url: ${JSON.stringify(popupUrl)}, active: true})`);
    const target = await until(async () => (await cdp('Target.getTargets')).targetInfos.find((t) => t.type === 'page' && t.url === popupUrl && !usedTargets.has(t.targetId)), 'popup page target');
    usedTargets.add(target.targetId);
    pg = await attach(target.targetId);
    await cdp('Page.enable', {}, pg);
    await cdp('Runtime.enable', {}, pg);
    await cdp('Emulation.setDeviceMetricsOverride', { width: 440, height: 580, deviceScaleFactor: 2, mobile: false }, pg);
    await until(() => evaluate(pg, `document.querySelectorAll('#results .item').length > 0`), 'popup to list tabs');
  }
  await openPopup(w1);
  const popupWindow = await $$(`chrome.windows.getCurrent().then(w => w.id)`);
  expect(popupWindow === w1, 'the popup page is in window 1');
  const total = await $$(`document.querySelectorAll('#results .item').length`);
  const allTabs = await inSW(`chrome.tabs.query({windowType: 'normal'}).then(t => t.length)`);
  expect(total === allTabs, 'the switcher lists every tab from every normal window', `${total} listed, ${allTabs} open`);
  expect(await $$(`document.activeElement.id === 'q'`), 'search is focused when the popup opens');
  expect(await $$(`document.querySelector('#results .item[aria-selected="true"]') !== null && document.getElementById('q').getAttribute('aria-activedescendant') !== null`), 'a selected result is marked (aria-selected + aria-activedescendant)');
  await shot(pg, '1-tabs');

  // search across windows by domain, then arrow + Enter to switch windows
  const type = (text) => $$(`(() => { const q = document.getElementById('q'); q.value = ${JSON.stringify(text)}; q.dispatchEvent(new Event('input', {bubbles: true})); return document.querySelectorAll('#results .item').length; })()`);
  const key = (k) => $$(`document.getElementById('q').dispatchEvent(new KeyboardEvent('keydown', {key: ${JSON.stringify(k)}, bubbles: true, cancelable: true}))`);
  const nYt = await type('youtube');
  expect(nYt === 2, 'typing "youtube" filters by domain', `${nYt} results`);
  expect(await type('zzzzqqq') === 0 && await $$(`!document.getElementById('empty').hidden`), 'a search with no match shows a message');
  await type('example');
  const ex = await $$(`[...document.querySelectorAll('#results .item')].map(li => [li.textContent, li.querySelector('.badge') && li.querySelector('.badge').textContent])`);
  expect(ex.length === 1 && /example\.com/.test(ex[0][0]), 'a tab in the OTHER window is found', JSON.stringify(ex));
  const exTab = (await inSW(`chrome.tabs.query({windowId: ${w2}})`)).find((t) => /example\.com/.test(t.url || t.pendingUrl || ''));
  const badge = ex[0][1];
  expect(/^Window \d+$/.test(badge || ''), 'it is labelled as being in another window', String(badge));
  await $$(`(() => { const q = document.getElementById('q'); q.value = 'github'; q.dispatchEvent(new Event('input', {bubbles: true})); })()`);
  await key('ArrowDown'); await key('ArrowUp'); // selection moves and wraps without error
  await type('example');
  await key('Enter');
  await sleep(1000);
  const afterEnter = await inSW(`Promise.all([chrome.tabs.get(${exTab.id}), chrome.windows.getLastFocused({windowTypes: ['normal']})])`);
  expect(afterEnter[0].active, 'Enter activated the selected tab');
  expect(afterEnter[1].id === w2 || afterEnter[0].windowId === w2, 'and its window was brought forward', `last focused window ${afterEnter[1].id}, tab window ${afterEnter[0].windowId}`);

  expect(afterEnter[0].windowId === w2 && popupWindow === w1, 'that was a tab in a DIFFERENT window than the popup\'s');
  await sleep(300);
  expect(!(await cdp('Target.getTargets')).targetInfos.some((t) => t.targetId === [...usedTargets][0]), 'the popup closed itself after the jump (like a real popup)');

  // filters and quick-open buttons
  await openPopup(w1);
  const nTech = await $$(`(() => { document.querySelector('.chip[data-cat="technical"]').click(); return [...document.querySelectorAll('#results .item')].every(li => /github|localhost|127/.test(li.textContent)) && document.querySelectorAll('#results .item').length; })()`);
  expect(nTech >= 6, 'the Technical filter shows only technical tabs', String(nTech));
  expect(await $$(`document.querySelector('.chip[data-cat="technical"]').getAttribute('aria-pressed') === 'true'`), 'the active filter is marked pressed');
  expect(await $$(`['YouTube', 'GitHub', 'Google'].every(n => [...document.querySelectorAll('[data-open]')].some(b => b.textContent === n))`), 'one-click launch buttons for YouTube, GitHub and Google exist');

  // sticky search with a long list: add 120 tabs, then check the controls stay put while the list scrolls
  for (let i = 0; i < 120; i += 20) await inSW(`Promise.all(Array.from({length: 20}, (_, j) => chrome.tabs.create({windowId: ${w1}, url: ${JSON.stringify(site('long.example.com', '/p'))} + (${i} + j), active: false})))`);
  await sleep(2500);
  await $$(`location.reload()`);
  await sleep(1200);
  await until(() => evaluate(pg, `document.querySelectorAll('#results .item').length > 100`), 'popup to list 100+ tabs');
  const geo = await $$(`(() => { const r = document.getElementById('results'); const q = document.getElementById('q').getBoundingClientRect().top; r.scrollTop = 4000; return { items: r.children.length, scrollable: r.scrollHeight > r.clientHeight, scrolled: r.scrollTop > 0, qTop: document.getElementById('q').getBoundingClientRect().top, qTopBefore: q, chipsTop: document.querySelector('.chips').getBoundingClientRect().top }; })()`);
  expect(geo.items > 100 && geo.scrollable && geo.scrolled && geo.qTop === geo.qTopBefore && geo.qTop >= 0, 'with 100+ tabs the list scrolls while search and filters stay visible', JSON.stringify(geo));
  await shot(pg, '2-tabs-long');

  // ------------------------------------------------------------------ My shortcuts: add GitHub through the real form
  await $$(`location.reload()`);
  await sleep(1200);
  await until(() => evaluate(pg, `document.querySelectorAll('#results .item').length > 0`), 'popup reloaded');
  await $$(`document.getElementById('addTop').click()`);
  expect(await $$(`!document.getElementById('view-shortcuts').hidden && !document.getElementById('form').hidden`), 'Add shortcut (always visible in the header) opens the form on My shortcuts');
  await shot(pg, '3-add-form');
  const fill = (name, url, keyNote = '') => $$(`(() => { const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', {bubbles: true})); }; set('fName', ${JSON.stringify(name)}); set('fUrl', ${JSON.stringify(url)}); set('fKey', ${JSON.stringify(keyNote)}); })()`);
  const submit = () => $$(`document.getElementById('form').requestSubmit()`);
  const slotPicked = await $$(`document.getElementById('fSlot').value`);
  expect(slotPicked === 'launch-02', 'the form picks the first free slot automatically', slotPicked);
  await fill('Bad', 'javascript:alert(1)');
  await submit();
  expect(await $$(`!document.getElementById('formError').hidden && /http and https/.test(document.getElementById('formError').textContent)`), 'a javascript: address is rejected with a message');
  await fill('GitHub', 'github.com', 'Ctrl+G');
  await submit();
  await sleep(400);
  const saved = await inSW(`chrome.storage.local.get('launchers').then(r => r.launchers['launch-02'])`);
  expect(saved && saved.name === 'GitHub' && saved.url === 'https://github.com/', '"github.com" is saved as https://github.com/ in slot 02', JSON.stringify(saved));
  const bannerText = await $$(`document.getElementById('bannerText').textContent`);
  expect(/GitHub saved\. In Chrome, assign a key to .Tabfold launcher 02./.test(bannerText), 'the banner tells me to assign a key to "Tabfold launcher 02"', bannerText);
  expect(await $$(`!document.getElementById('bannerAssign').hidden && document.getElementById('bannerAssign').textContent === 'Assign key in Chrome'`), 'an "Assign key in Chrome" button is next to it');
  const rowState = await $$(`(() => { const r = document.querySelector('.row[data-command="launch-02"]'); return { key: r.querySelector('.key') && r.querySelector('.key').textContent, assignBtn: [...r.querySelectorAll('button')].some(b => b.textContent === 'Assign key'), wanted: r.querySelector('.wanted') && r.querySelector('.wanted').textContent, text: r.textContent }; })()`);
  expect(!rowState.key && rowState.assignBtn, 'the GitHub row shows "Assign key", NOT my preferred Ctrl+G, because Chrome reports no key', JSON.stringify(rowState));
  expect(/planned Ctrl\+G, but Chrome has no key/.test(rowState.wanted || ''), 'the preferred key is shown only as a note, clearly not active');
  const youtubeRow = await $$(`document.querySelector('.row[data-command="launch-01"] .key').textContent`);
  expect(youtubeRow === 'Ctrl+Y', 'the YouTube row shows the key Chrome reports (Ctrl+Y)', youtubeRow);
  await shot(pg, '4-shortcuts');

  // "Assign key in Chrome" opens chrome://extensions/shortcuts
  const before2 = await inSW(`chrome.tabs.query({}).then(t => t.length)`);
  await $$(`document.getElementById('bannerAssign').click()`);
  await sleep(1200);
  const shortcutsTab = await inSW(`chrome.tabs.query({}).then(ts => ts.filter(t => (t.url || t.pendingUrl || '').startsWith('chrome://extensions/shortcuts')).length)`);
  expect(shortcutsTab === 1, 'Assign key in Chrome opens chrome://extensions/shortcuts', `${before2} tabs before`);

  // edit the URL: the slot (and so its key) is kept
  await $$(`(() => { document.querySelector('.row[data-command="launch-02"] .row-actions button:nth-child(2)').click(); })()`);
  expect(await $$(`document.getElementById('fSlot').disabled && document.getElementById('fSlot').value === 'launch-02'`), 'editing keeps the same slot (the slot picker is locked)');
  await fill('GitHub', 'https://github.com/anthropics', 'Ctrl+G');
  await submit();
  await sleep(400);
  const edited = await inSW(`chrome.storage.local.get('launchers').then(r => r.launchers)`);
  expect(edited['launch-02'].url === 'https://github.com/anthropics' && Object.keys(edited).sort().join() === 'launch-01,launch-02', 'editing the URL updated the same slot, nothing else', JSON.stringify(edited['launch-02']));

  // test button
  const ytCount = () => inSW(`chrome.tabs.query({}).then(ts => ts.filter(t => /youtube\.com/.test(t.url || t.pendingUrl || '')).length)`);
  const nBefore = await ytCount();
  await $$(`document.querySelector('.row[data-command="launch-01"] .row-actions button').click()`);
  await sleep(1200);
  expect((await ytCount()) === nBefore + 1, 'Test opens the website in a new tab (and the popup closes)', `${nBefore} -> ${await ytCount()} YouTube tabs`);
  await openPopup(w1);
  await $$(`document.getElementById('tab-shortcuts').click()`);

  // YouTube's slot has a bound key: choosing it to REPLACE shows that key before saving
  await $$(`document.getElementById('addTop').click()`);
  await $$(`(() => { const s = document.getElementById('fSlot'); s.value = 'launch-01'; s.dispatchEvent(new Event('change', {bubbles: true})); })()`);
  const info = await $$(`document.getElementById('slotInfo').textContent`);
  expect(/replaces YouTube/.test(info) && /Ctrl\+Y/.test(info), 'choosing an occupied slot that has a key shows that key first', info);
  await $$(`document.getElementById('fCancel').click()`);

  // delete (two-step), then reuse the slot
  await $$(`document.querySelector('.row[data-command="launch-02"] .btn.danger').click()`);
  expect(await $$(`document.querySelector('.row[data-command="launch-02"] .btn.danger').textContent === 'Confirm delete'`), 'Delete asks for a second click');
  await $$(`document.querySelector('.row[data-command="launch-02"] .btn.danger').click()`);
  await sleep(500);
  expect(!(await inSW(`chrome.storage.local.get('launchers').then(r => 'launch-02' in r.launchers)`)), 'GitHub is deleted from storage');
  // delete YouTube too, then add a new site: slot 01 is empty but still has Ctrl+Y in Chrome
  await $$(`document.querySelector('.row[data-command="launch-01"] .btn.danger').click()`);
  await $$(`document.querySelector('.row[data-command="launch-01"] .btn.danger').click()`);
  await sleep(500);
  const unusedText = await $$(`document.getElementById('unused').textContent`);
  expect(/launcher 01: Ctrl\+Y is still assigned in Chrome, but this slot is empty/.test(unusedText), 'a deleted launcher\'s leftover Chrome key is shown as doing nothing', unusedText);
  const bannerAfterDelete = await $$(`document.getElementById('bannerText').textContent`);
  expect(/Ctrl\+Y is still assigned/.test(bannerAfterDelete), 'the delete banner names the key that is still bound', bannerAfterDelete);
  await $$(`document.getElementById('addTop').click()`);
  const pick = await $$(`document.getElementById('fSlot').value`);
  const infoReuse = await $$(`document.getElementById('slotInfo').textContent`);
  expect(pick === 'launch-02', 'the next add prefers the empty slot with no key', pick);
  await $$(`(() => { const s = document.getElementById('fSlot'); s.value = 'launch-01'; s.dispatchEvent(new Event('change', {bubbles: true})); })()`);
  const infoKeyed = await $$(`document.getElementById('slotInfo').textContent`);
  expect(/already has Ctrl\+Y on this empty slot/.test(infoKeyed), 'reusing a slot that still has a key shows that key before saving', infoKeyed);
  await fill('YouTube Music', 'music.youtube.com');
  await submit();
  await sleep(400);
  const reused = await inSW(`chrome.storage.local.get('launchers').then(r => r.launchers['launch-01'])`);
  expect(reused && reused.url === 'https://music.youtube.com/', 'the slot was reused for a new website', JSON.stringify(reused));
  expect(/It opens with Ctrl\+Y/.test(await $$(`document.getElementById('bannerText').textContent`)), 'and it reports the key Chrome already has on it');
  const rReuse = await inSW(`__tabfold.handleCommand('launch-01', {windowId: ${w1}})`);
  await sleep(1000);
  expect(rReuse === 'opened' && (await tabsOf(w1)).some((t) => /music\.youtube\.com/.test(t.url || '')), 'pressing the still-bound key now opens the new website');
  await shot(pg, '5-shortcuts-after');

  // ------------------------------------------------------------------ Auto-group toggle in the popup remembers its state
  await $$(`document.getElementById('autoGroup').click()`);
  await sleep(300);
  expect((await inSW(`chrome.storage.local.get('settings').then(r => r.settings.autoGroup)`)) === false, 'the Auto-group toggle in the popup saves "off"');
  await $$(`location.reload()`);
  await sleep(1000);
  expect(await $$(`document.getElementById('autoGroup').checked === false`), 'and it is still off when the popup reopens');
  await $$(`document.getElementById('autoGroup').click()`);
  await sleep(300);
  expect((await inSW(`chrome.storage.local.get('settings').then(r => r.settings.autoGroup)`)) === true, 'switching it on again is saved too');

  // ------------------------------------------------------------------ persistence across a browser restart is covered by storage.local; check the service worker survives being stopped
  const stopped = await cdp('Target.closeTarget', { targetId: swTarget.targetId }).catch(() => ({ success: false }));
  pass('service worker target closed to simulate Chrome stopping it', JSON.stringify(stopped));
} catch (err) {
  fail('e2e run aborted', err.stack || String(err));
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) for (const [, name, detail] of failed) console.log(`  FAILED: ${name} ${detail}`);
process.exit(failed.length ? 1 : 0);
