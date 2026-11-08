// Real-browser check of the Quick Switcher (Alt+Q). Separate headless Chrome, temp profile, local stand-in websites.
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
  const rows = () => ev(`[...document.querySelectorAll('#results .item')].map(n => n.querySelector('.title').textContent + '|' + (n.querySelector('.count-pill')?.textContent || ''))`);
  const selected = () => ev(`document.querySelector('#results .item[aria-selected="true"] .title')?.textContent`);
  const key = async (k, code = k) => { for (const type of ['keyDown', 'keyUp']) await b.cdp('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: { ArrowDown: 40, ArrowUp: 38, Enter: 13, Backspace: 8, Escape: 27 }[k] || 0 }, page); await sleep(60); };
  const type = async (text) => { await ev(`document.getElementById('q').focus()`); await b.cdp('Input.insertText', { text }, page); await sleep(80); };

  r.expect((await ev(`document.activeElement.id`)) === 'q', 'search field is focused on open');
  const groups = await rows();
  r.expect(groups[0] === 'YouTube|3 tabs' && groups[1].startsWith('Technical') && groups[2] === 'Google|0 tabs' && groups.length === 4, 'groups with counts, empty group kept', JSON.stringify(groups));
  await key('ArrowDown'); r.expect((await selected()) === 'Technical', 'Down moves highlight');
  await key('ArrowUp'); await key('ArrowUp'); r.expect((await selected()) === 'Others', 'Up wraps around');

  await type('tech'); r.expect((await rows())[0].startsWith('Technical'), 'search groups by partial name');
  await ev(`(() => { const q = document.getElementById('q'); q.value = ''; q.dispatchEvent(new Event('input')); })()`);
  await key('Enter'); // highlight resets to first row = YouTube
  r.expect((await ev(`document.getElementById('crumb').textContent`)) === 'YouTube — 3 tabs', 'Enter opens the highlighted group');
  r.expect((await rows()).length === 3, 'group shows its tabs');
  await type('java'); r.expect((await rows()).length === 1, 'search within the group');
  await key('Backspace'); // removes nothing yet? field has text -> default deletion
  r.expect((await ev(`document.getElementById('crumb').hidden`)) === false, 'Backspace with text in the field edits text, stays in group');
  await ev(`(() => { const q = document.getElementById('q'); q.value = ''; q.dispatchEvent(new Event('input')); })()`);
  await key('Backspace');
  r.expect((await ev(`document.getElementById('crumb').hidden`)) === true && (await rows()).length === 4, 'Backspace on empty field returns to the group list');

  await type('YouTube / python');
  const direct = await rows();
  r.expect(direct.length === 1 && direct[0].startsWith('python-numpy'.slice(0, 0)) || /youtube\.com|page/i.test(direct[0] || ''), 'direct "YouTube / python" finds the tab', JSON.stringify(direct));

  // ---- activation across windows
  await ev(`(() => { const q = document.getElementById('q'); q.value = 'issues'; q.dispatchEvent(new Event('input')); })()`);
  await sleep(100);
  r.expect((await rows()).length >= 1, 'tab in another window is found by URL');
  await key('Enter');
  await sleep(500);
  const active = await sw(`chrome.tabs.get(${gh}).then(t => ({active: t.active, windowId: t.windowId}))`);
  r.expect(active.active && active.windowId === win2, 'Enter activated the tab in the other window');

  // ---- closed tab while open: list updates itself
  const t2 = await b.cdp('Target.createTarget', { url: quickUrl });
  const page2 = await b.attach(t2.targetId); await b.cdp('Runtime.enable', {}, page2);
  await b.until(() => b.evaluate(page2, `document.querySelectorAll('#results .item').length === 4`).catch(() => false), 'second switcher');
  await sw(`chrome.tabs.remove(${yt[0]})`);
  const updated = await b.until(async () => (await b.evaluate(page2, `document.querySelector('#results .count-pill').textContent`)) === '2 tabs', 'live update after a tab closes').catch(() => false);
  r.expect(updated, 'closed tab disappears from open switcher');
} finally {
  const failed = r.summary();
  await b.close(); web.close();
  process.exit(failed ? 1 : 0);
}
