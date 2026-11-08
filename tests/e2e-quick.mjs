// Real-browser check of the list-based Quick Switcher (Alt+Q). Separate headless Chrome, temp profile, local stand-in websites.
//   node tests/e2e-quick.mjs
// A real Alt+Q press cannot be sent to headless Chrome, so the command handler is called as chrome.commands.onCommand would call it;
// the switcher page itself is driven with real DevTools key events.
import { launch, startSite, createReporter, sleep } from './cdp-harness.mjs';

const r = createReporter();
const web = await startSite();
const b = await launch();
try {
  const ext = await b.loadExtension();
  const sw = (e) => b.evaluate(ext.sw, e);
  const manifest = await sw(`chrome.runtime.getManifest().commands['quick-switcher']`);
  r.expect(manifest && manifest.suggested_key.default === 'Alt+Q', 'manifest: quick-switcher suggests Alt+Q');
  const registered = await sw(`chrome.commands.getAll().then(c => c.find(x => x.name === 'quick-switcher'))`);
  r.expect(registered && registered.shortcut === 'Alt+Q', 'Chrome registered the command', JSON.stringify(registered));

  const win1 = await sw(`chrome.windows.getAll({windowTypes:['normal']}).then(w => w[0].id)`);
  const win2 = await sw(`chrome.windows.create({url: ${JSON.stringify(web.site('github.com', '/pulls'))}}).then(w => w.id)`);
  const mk = (w, url) => sw(`chrome.tabs.create({windowId: ${w}, url: ${JSON.stringify(url)}, active: false}).then(t => t.id)`);
  const yt = [];
  for (const n of ['python-numpy', 'java-dsa', 'ml-course']) yt.push(await mk(win1, web.site('www.youtube.com', `/${n}`)));
  const gh = await mk(win2, web.site('github.com', '/issues'));
  await mk(win1, web.site('example.org', '/'));
  await sleep(1200);

  // ---- the command opens a popup window; again focuses/closes it
  r.expect((await sw(`__tabfold.openQuickSwitcher()`)) === 'opened', 'command opens the switcher window');
  const popupWins = () => sw(`chrome.windows.getAll({populate:true}).then(ws => ws.filter(w => w.type === 'popup' && w.tabs.some(t => (t.url||'').endsWith('quick.html'))).length)`);
  await sleep(500);
  r.expect((await popupWins()) === 1, 'exactly one switcher window');
  const second = await sw(`__tabfold.openQuickSwitcher()`);
  r.expect(second === 'focused' || second === 'closed', 'second press does not open a duplicate', second);
  r.expect((await popupWins()) <= 1, 'still at most one switcher window');
  await sw(`chrome.windows.getAll({populate:true}).then(ws => Promise.all(ws.filter(w => w.type === 'popup').map(w => chrome.windows.remove(w.id))))`);

  // ---- drive the page in a normal tab
  const quickUrl = `chrome-extension://${ext.id}/quick.html`;
  const { targetId } = await b.cdp('Target.createTarget', { url: quickUrl });
  const page = await b.attach(targetId);
  await b.cdp('Runtime.enable', {}, page);
  await b.until(() => b.evaluate(page, `document.querySelectorAll('#results .item').length > 0`).catch(() => false), 'switcher rows');
  const ev = (e) => b.evaluate(page, e);
  const rows = () => ev(`[...document.querySelectorAll('#results .item')].map(n => n.querySelector('.title').textContent.replace(/^● /, '') + '|' + (n.querySelector('.count-pill')?.textContent || ''))`);
  const key = async (k, code = k) => { for (const type of ['keyDown', 'keyUp']) await b.cdp('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: { ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Backspace: 8, Escape: 27 }[k] || 0 }, page); await sleep(60); };

  const sel = () => ev(`document.querySelector('#results .item[aria-selected="true"] .title')?.textContent.replace(/^● /, '')`);
  const heading = () => ev(`document.getElementById('heading').textContent`);
  r.expect((await ev(`!document.getElementById('q') && !document.querySelector('input')`)), 'no search field in the page');
  const groups = await rows();
  r.expect(groups[0] === 'YouTube|3 tabs' && groups[1].startsWith('Technical') && groups[2] === 'Google|0 tabs' && groups.length === 4, 'all groups in order with counts, empty group kept', JSON.stringify(groups));
  r.expect((await sel()) === 'YouTube', 'first group highlighted');
  await key('ArrowDown'); r.expect((await sel()) === 'Technical', 'Down moves highlight');
  await key('ArrowUp'); await key('ArrowUp'); r.expect((await sel()) === 'Others', 'Up from the first wraps to the last');
  await key('ArrowDown'); r.expect((await sel()) === 'YouTube', 'Down from the last wraps to the first');

  await key('Enter');
  r.expect((await heading()) === 'YouTube' && (await ev(`document.getElementById('back').hidden`)) === false, 'Enter opens the group, back arrow shown');
  const tabs = await rows();
  r.expect(tabs.length === 3, 'every tab of the group is listed', JSON.stringify(tabs));
  await key('ArrowDown'); await key('ArrowDown'); await key('ArrowDown');
  r.expect((await ev(`document.querySelector('#results .item[aria-selected="true"]') === document.querySelectorAll('#results .item')[0]`)), 'tab list wraps');
  await key('ArrowLeft');
  r.expect((await heading()) === 'Tabfold — Quick Switcher' && (await sel()) === 'YouTube', 'Left returns to the group list');
  await key('ArrowDown'); await key('ArrowRight');
  r.expect((await heading()) === 'Technical', 'Right opens the highlighted group');
  await key('Backspace');
  r.expect((await heading()) === 'Tabfold — Quick Switcher' && (await sel()) === 'Technical', 'Backspace returns, same group still highlighted');
  await key('ArrowDown'); await key('Enter');
  r.expect((await heading()) === 'Google' && (await ev(`document.getElementById('empty').textContent`)) === 'No tabs in Google.', 'empty group handled');
  await key('Backspace'); await key('ArrowUp'); await key('Enter'); // Google -> Technical

  // ---- activation across windows (Technical holds github.com in window 2)
  const rowsHere = await ev(`[...document.querySelectorAll('#results .item')].map(n => n.getAttribute('aria-label'))`);
  r.expect(rowsHere.length === 2, 'Technical lists both github tabs, from two windows', JSON.stringify(rowsHere));
  // select the tab whose id is gh by clicking its row (index 1 = window 2, second tab)
  await ev(`document.querySelectorAll('#results .item')[1].dispatchEvent(new MouseEvent('mousemove', {bubbles: true}))`);
  await key('Enter'); await sleep(500);
  const active = await sw(`chrome.tabs.get(${gh}).then(t => ({active: t.active, windowId: t.windowId}))`);
  r.expect(active.active && active.windowId === win2, 'Enter activated the tab in the other window');

  // ---- scrolling a long list keeps the highlight in view
  const many = [];
  for (let n = 0; n < 40; n++) many.push(await mk(win1, web.site('www.youtube.com', `/long-${n}`)));
  const t3 = await b.cdp('Target.createTarget', { url: quickUrl });
  const page3 = await b.attach(t3.targetId); await b.cdp('Runtime.enable', {}, page3);
  await b.until(() => b.evaluate(page3, `document.querySelectorAll('#results .item').length === 4`).catch(() => false), 'third switcher');
  const k3 = async (k) => { for (const type of ['keyDown', 'keyUp']) await b.cdp('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: { ArrowUp: 38, ArrowDown: 40, Enter: 13 }[k] }, page3); await sleep(50); };
  await k3('Enter');
  r.expect((await b.evaluate(page3, `document.querySelectorAll('#results .item').length`)) >= 40, 'a large group lists every tab');
  for (let n = 0; n < 25; n++) await k3('ArrowDown');
  await sleep(600);
  const visible = await b.evaluate(page3, `(() => { const s = document.querySelector('#results .item[aria-selected="true"]').getBoundingClientRect(); const l = document.getElementById('results').getBoundingClientRect(); return s.top >= l.top - 1 && s.bottom <= l.bottom + 1; })()`);
  r.expect(visible, 'highlight scrolls into view');

  // ---- closing a tab while open: list updates itself
  await sw(`chrome.tabs.remove(${many[0]})`);
  const shrunk = await b.until(async () => (await b.evaluate(page3, `document.getElementById('count').textContent`)).startsWith(String(40 + 3 - 1)) || (await b.evaluate(page3, `document.querySelectorAll('#results .item').length`)) < 43, 'live update').catch(() => false);
  r.expect(shrunk, 'closed tab disappears from the open switcher');
  await key('Escape');
} finally {
  const failed = r.summary();
  await b.close(); web.close();
  process.exit(failed ? 1 : 0);
}
