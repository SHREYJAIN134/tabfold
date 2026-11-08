import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, displayHost, isSafeLaunchUrl, isLocalHost } from '../lib/url.js';
import { categorize, categoryForHost, filterCategory, CATEGORIES } from '../lib/categories.js';
import { filterTabs, scoreTab, moveSelection, tabTitle } from '../lib/search.js';
import { chooseSlot, slotOptions, slotInfoText, unusedKeys } from '../lib/slots.js';
import { slotCommand, slotNumber, slotLabel, ALL_COMMANDS, SLOT_COUNT, getLaunchers, saveLauncher, deleteLauncher, seedDefaults, getSettings, setSetting, getPendingAssign, setPendingAssign } from '../lib/store.js';

// ------------------------------------------------------------------ URL entry

test('addresses: bare domains get https://, http and https are accepted, localhost gets http://', () => {
  assert.deepEqual(normalizeUrl('github.com'), { ok: true, url: 'https://github.com/', host: 'github.com' });
  assert.equal(normalizeUrl('  GitHub.com/features  ').url, 'https://github.com/features');
  assert.equal(normalizeUrl('https://www.youtube.com/').url, 'https://www.youtube.com/');
  assert.equal(normalizeUrl('http://example.com/a?b=1#c').url, 'http://example.com/a?b=1#c');
  assert.equal(normalizeUrl('HTTPS://Example.COM').url, 'https://example.com/');
  assert.equal(normalizeUrl('localhost:3000/app').url, 'http://localhost:3000/app');
  assert.equal(normalizeUrl('127.0.0.1:8080').url, 'http://127.0.0.1:8080/');
  assert.equal(normalizeUrl('//cdn.example.com/x').url, 'https://cdn.example.com/x');
  assert.equal(normalizeUrl('mail.google.com').host, 'mail.google.com');
  assert.equal(isLocalHost('localhost'), true);
  assert.equal(isLocalHost('github.com'), false);
});

test('addresses: invalid input and every unsafe scheme is rejected with a message', () => {
  for (const bad of ['', '   ', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///C:/Windows/win.ini',
    'chrome://settings', 'chrome-extension://abc/popup.html', 'ftp://example.com', 'blob:https://example.com/x', 'about:blank', 'mailto:a@b.com', 'vbscript:x',
    'view-source:https://example.com', 'git github.com', 'http://', 'https://', 'not a url', 'github', 'https://user:pass@example.com', '://x.com', 'x'.repeat(3000)]) {
    const r = normalizeUrl(bad);
    assert.equal(r.ok, false, `should reject ${JSON.stringify(bad.slice(0, 40))}`);
    assert.ok(r.error && r.error.length > 5, 'with a message');
  }
  assert.match(normalizeUrl('javascript:alert(1)').error, /http and https/);
  assert.equal(normalizeUrl(null).ok, false);
  assert.equal(normalizeUrl(undefined).ok, false);
});

test('launch safety is re-checked on whatever is in storage', () => {
  assert.equal(isSafeLaunchUrl('https://github.com/'), true);
  assert.equal(isSafeLaunchUrl('http://localhost:3000'), true);
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///x', 'chrome://settings', 'https://u:p@x.com/', '', 'nope', undefined]) assert.equal(isSafeLaunchUrl(bad), false);
  assert.equal(displayHost('https://www.github.com/x'), 'github.com');
  assert.equal(displayHost('nope'), '');
});

// ------------------------------------------------------------------ categories

test('categories: YouTube, Technical, Google, Others for the sites named in the brief', () => {
  const cases = {
    youtube: ['https://www.youtube.com/watch?v=1', 'https://music.youtube.com/', 'https://youtu.be/abc', 'https://m.youtube.com/', 'https://www.youtube-nocookie.com/embed/x'],
    technical: ['https://github.com/a/b', 'https://gist.github.com/x', 'https://gitlab.com/x', 'https://stackoverflow.com/q/1', 'https://developer.mozilla.org/en-US/',
      'https://www.npmjs.com/package/x', 'http://localhost:3000/', 'http://127.0.0.1:5173/', 'https://docs.python.org/3/', 'https://developer.chrome.com/docs/', 'https://pypi.org/', 'https://go.dev/doc'],
    google: ['https://www.google.com/search?q=x', 'https://google.com/', 'https://www.google.co.in/search?q=x', 'https://mail.google.com/mail/u/0/', 'https://drive.google.com/drive',
      'https://docs.google.com/document/d/1', 'https://docs.google.com/spreadsheets/d/1', 'https://calendar.google.com/', 'https://meet.google.com/abc-defg-hij', 'https://gmail.com/'],
    others: ['https://example.com/', 'https://www.wikipedia.org/', 'https://news.ycombinator.com/', 'https://www.amazon.in/', 'https://notgithub.com/', 'https://github.com.evil.example/'],
  };
  for (const [cat, urls] of Object.entries(cases)) for (const u of urls) assert.equal(categorize(u), cat, u);
});

test('categories: docs.google.com is Google Docs, not "docs.*" developer documentation; look-alike hosts are not matched', () => {
  assert.equal(categoryForHost('docs.google.com'), 'google');
  assert.equal(categoryForHost('docs.rs'), 'technical');
  assert.equal(categoryForHost('developers.google.com'), 'technical');
  assert.equal(categoryForHost('myyoutube.com'), 'others');
  assert.equal(categoryForHost('youtube.com.evil.example'), 'others');
  assert.equal(categoryForHost('google.evil.com'), 'others');
});

test('categories: blank tabs, Chrome pages, extension pages, files and devtools are never grouped', () => {
  for (const u of ['', undefined, null, 'about:blank', 'chrome://newtab/', 'chrome://extensions/shortcuts', 'chrome-extension://abc/popup.html', 'edge://settings', 'file:///C:/a.html',
    'devtools://devtools/bundled/x.html', 'view-source:https://github.com', 'data:text/html,hi', 'javascript:void(0)', 'chrome-search://local-ntp/', 'not a url']) assert.equal(categorize(u), null, String(u));
  assert.equal(filterCategory('chrome://settings'), 'others', 'but they can still be found under Others in the switcher');
  assert.deepEqual(Object.values(CATEGORIES).map((c) => c.title), ['YouTube', 'Technical', 'Google', 'Others']);
  assert.equal(new Set(Object.values(CATEGORIES).map((c) => c.color)).size, 4, 'four distinct colours');
});

// ------------------------------------------------------------------ search

const T = (id, windowId, title, url, lastAccessed = 0) => ({ id, windowId, title, url, lastAccessed });
const TABS = [
  T(1, 1, 'Inbox (3) - Gmail', 'https://mail.google.com/mail/u/0/', 50),
  T(2, 1, 'tabfold/tabfold: Chrome extension', 'https://github.com/tabfold/tabfold', 90),
  T(3, 2, 'lofi hip hop radio - YouTube', 'https://www.youtube.com/watch?v=jfKfPfyJRdk', 80),
  T(4, 2, 'Stack Overflow - Where Developers Learn', 'https://stackoverflow.com/', 10),
  T(5, 2, '', 'https://example.com/', 5),
  T(6, 1, 'Settings', 'chrome://settings/', 1),
];

test('search: words match titles and domains across windows; every word must match', () => {
  const ids = (q, category) => filterTabs(TABS, { query: q, category }).map((t) => t.id);
  assert.deepEqual(ids(''), [2, 3, 1, 4, 5, 6], 'no query: most recently used first');
  assert.deepEqual(ids('github'), [2]);
  assert.deepEqual(ids('YOUTUBE'), [3]);
  assert.deepEqual(ids('gm'), [1]);
  assert.deepEqual(ids('lofi radio'), [3]);
  assert.deepEqual(ids('lofi github'), []);
  assert.deepEqual(ids('example'), [5], 'a tab with no title is found by its domain');
  assert.deepEqual(ids('stack over'), [4]);
  assert.deepEqual(ids('zzz'), []);
  assert.ok(scoreTab(TABS[1], 'github') > scoreTab(TABS[1], 'chrome'), 'a domain hit outranks a title hit');
  assert.equal(tabTitle(TABS[4]), 'example.com');
});

test('search: category filters', () => {
  const ids = (category, q = '') => filterTabs(TABS, { query: q, category }).map((t) => t.id);
  assert.deepEqual(ids('youtube'), [3]);
  assert.deepEqual(ids('technical'), [2, 4]);
  assert.deepEqual(ids('google'), [1]);
  assert.deepEqual(ids('others'), [5, 6]);
  assert.deepEqual(ids('all').length, 6);
  assert.deepEqual(ids('technical', 'stack'), [4]);
  assert.deepEqual(ids('google', 'stack'), []);
});

test('search: arrow-key selection wraps and survives an empty list', () => {
  assert.equal(moveSelection(0, 1, 3), 1);
  assert.equal(moveSelection(2, 1, 3), 0);
  assert.equal(moveSelection(0, -1, 3), 2);
  assert.equal(moveSelection(-1, 1, 3), 0);
  assert.equal(moveSelection(-1, -1, 3), 2);
  assert.equal(moveSelection(0, 1, 0), -1);
});

test('search: a 300-tab list filters quickly', () => {
  const many = Array.from({ length: 300 }, (_, i) => T(i + 1, (i % 3) + 1, `Page number ${i} about topic ${i % 17}`, `https://site${i % 40}.example.com/p/${i}`, i));
  const t0 = performance.now();
  const out = filterTabs(many, { query: 'topic 5' });
  assert.ok(out.length > 0);
  assert.ok(performance.now() - t0 < 100);
});

// ------------------------------------------------------------------ slots and the store

const memoryStorage = () => {
  const data = {};
  return {
    data,
    async get(keys) { if (typeof keys === 'string') return keys in data ? { [keys]: structuredClone(data[keys]) } : {}; return structuredClone(data); },
    async set(obj) { Object.assign(data, structuredClone(obj)); },
    async remove(k) { delete data[k]; },
  };
};

test('slots: 12 stable commands with the same label Chrome shows', () => {
  assert.equal(SLOT_COUNT, 12);
  assert.deepEqual(ALL_COMMANDS.slice(0, 3), ['launch-01', 'launch-02', 'launch-03']);
  assert.equal(ALL_COMMANDS[11], 'launch-12');
  assert.equal(slotLabel('launch-02'), 'Tabfold launcher 02');
  assert.equal(slotNumber('launch-12'), 12);
  for (const bad of ['launch-00', 'launch-13', 'launch-1', 'launch-aa', '_execute_action', '', undefined]) assert.equal(slotNumber(bad), 0);
  assert.equal(slotCommand(7), 'launch-07');
});

test('store: add, edit keeps the slot, delete empties it, and reuse works', async () => {
  const s = memoryStorage();
  await saveLauncher('launch-02', { name: 'GitHub', url: 'https://github.com/', wantedKey: 'Ctrl+G' }, s);
  assert.deepEqual((await getLaunchers(s))['launch-02'], { name: 'GitHub', url: 'https://github.com/', wantedKey: 'Ctrl+G' });
  await saveLauncher('launch-02', { name: 'GitHub', url: 'https://github.com/tabfold', wantedKey: 'Ctrl+G' }, s); // edit the URL
  const afterEdit = await getLaunchers(s);
  assert.deepEqual(Object.keys(afterEdit), ['launch-02'], 'still the same slot: the key binding (kept by Chrome per command) is untouched');
  assert.equal(afterEdit['launch-02'].url, 'https://github.com/tabfold');
  await deleteLauncher('launch-02', s);
  assert.deepEqual(await getLaunchers(s), {});
  await saveLauncher('launch-02', { name: 'GitLab', url: 'https://gitlab.com/' }, s);
  assert.equal((await getLaunchers(s))['launch-02'].name, 'GitLab');
  await assert.rejects(saveLauncher('launch-99', { name: 'x', url: 'https://x.com' }, s), /Unknown launcher slot/);
});

test('store: malformed stored data is ignored, not trusted', async () => {
  const s = memoryStorage();
  s.data.launchers = { 'launch-01': { name: 'OK', url: 'https://ok.com/' }, 'launch-02': { name: 5, url: 'x' }, 'launch-03': null, 'launch-77': { name: 'x', url: 'https://x.com' }, 'launch-04': 'str' };
  assert.deepEqual(Object.keys(await getLaunchers(s)), ['launch-01']);
  s.data.launchers = 'junk';
  assert.deepEqual(await getLaunchers(s), {});
});

test('store: YouTube is seeded in slot 01 once; deleting it is not undone by a later start', async () => {
  const s = memoryStorage();
  assert.equal(await seedDefaults(s), true);
  assert.deepEqual((await getLaunchers(s))['launch-01'], { name: 'YouTube', url: 'https://www.youtube.com/' });
  await deleteLauncher('launch-01', s);
  assert.equal(await seedDefaults(s), false);
  assert.deepEqual(await getLaunchers(s), {});
  const existing = memoryStorage();
  existing.data.launchers = { 'launch-05': { name: 'Mine', url: 'https://mine.com/' } };
  await seedDefaults(existing);
  assert.deepEqual(Object.keys(await getLaunchers(existing)), ['launch-05'], 'never overwrites what the user already has');
});

test('store: settings default Auto-group on and remember the choice; pending-assign hint round-trips', async () => {
  const s = memoryStorage();
  assert.deepEqual(await getSettings(s), { autoGroup: true, collapseInactive: true });
  await setSetting('autoGroup', false, s);
  assert.equal((await getSettings(s)).autoGroup, false);
  await setSetting('autoGroup', true, s);
  assert.equal((await getSettings(s)).autoGroup, true);
  assert.equal(await getPendingAssign(s), null);
  await setPendingAssign('launch-02', s);
  assert.equal(await getPendingAssign(s), 'launch-02');
  await setPendingAssign(null, s);
  assert.equal(await getPendingAssign(s), null);
});

test('slots: the first free slot without a key is offered; a reused slot shows its existing key before saving', () => {
  const launchers = { 'launch-01': { name: 'YouTube', url: 'https://www.youtube.com/' } };
  assert.equal(chooseSlot(launchers, {}), 'launch-02');
  assert.equal(chooseSlot(launchers, { 'launch-02': 'Ctrl+G' }), 'launch-03', 'prefers a slot with no key');
  const allKeyed = Object.fromEntries(ALL_COMMANDS.slice(1).map((c) => [c, 'Alt+1']));
  assert.equal(chooseSlot(launchers, allKeyed), 'launch-02', 'otherwise an empty slot that has a key');

  assert.match(slotInfoText('launch-02', launchers, {}), /No key is assigned to this slot yet/);
  assert.match(slotInfoText('launch-02', launchers, { 'launch-02': 'Ctrl+G' }), /already has Ctrl\+G on this empty slot/);
  assert.match(slotInfoText('launch-01', launchers, { 'launch-01': 'Ctrl+Y' }), /replaces YouTube \(youtube\.com\).*Ctrl\+Y/);
  assert.match(slotInfoText('launch-01', launchers, {}), /No key is assigned/);
  assert.match(slotInfoText('launch-01', launchers, { 'launch-01': 'Ctrl+Y' }, { editing: true }), /Keeps its key: Ctrl\+Y/);

  const opts = slotOptions(launchers, { 'launch-03': 'Ctrl+G' });
  assert.equal(opts.length, 12);
  assert.match(opts[0].text, /Tabfold launcher 01 .* YouTube \(replace\)/);
  assert.match(opts[2].text, /Tabfold launcher 03 .* free, key Ctrl\+G/);
});

test('slots: with all 12 in use nothing is pre-selected, and the message says how to proceed', () => {
  const full = Object.fromEntries(ALL_COMMANDS.map((c, i) => [c, { name: `Site ${i}`, url: `https://s${i}.example.com/` }]));
  assert.equal(chooseSlot(full, {}), '');
  assert.match(slotInfoText('', full, {}), /All 12 slots are in use.*replace/);
  assert.equal(slotOptions(full, {}).every((o) => o.used), true);
});

test('slots: a deleted launcher whose key is still bound shows up as an unused key', () => {
  assert.deepEqual(unusedKeys({ 'launch-01': { name: 'a', url: 'https://a.com' } }, { 'launch-01': 'Ctrl+Y', 'launch-02': 'Ctrl+G', 'launch-03': '' }),
    [{ command: 'launch-02', label: 'Tabfold launcher 02', key: 'Ctrl+G' }]);
});

// ------------------------------------------------------------------ key status and guidance (lib/keys.js)

import { normalizeKey, sameKey, isFindNextKey, bindingStatus, otherCommandWithKey, keyAdvice, ALTERNATIVE_KEY } from '../lib/keys.js';

test('keys: comparison ignores case and spacing; Find Next is Ctrl+G (Command+G on a Mac)', () => {
  assert.equal(normalizeKey(' Ctrl + G '), 'ctrl+g');
  assert.equal(sameKey('Ctrl+G', 'ctrl + g'), true);
  assert.equal(sameKey('Ctrl+G', 'Alt+Shift+G'), false);
  assert.equal(sameKey('', ''), false, 'two empty keys are not "the same key"');
  assert.equal(isFindNextKey('Ctrl+G'), true);
  assert.equal(isFindNextKey('Command+G'), true);
  assert.equal(isFindNextKey('Alt+Shift+G'), false);
  assert.equal(isFindNextKey(''), false);
  assert.equal(ALTERNATIVE_KEY, 'Alt+Shift+G');
});

test('keys: none / Assigned / Verified; a key is Verified only for the key that was actually received', () => {
  assert.equal(bindingStatus('', undefined), 'none');
  assert.equal(bindingStatus('', { shortcut: 'Ctrl+G', at: 1 }), 'none', 'no key reported by Chrome: nothing to verify');
  assert.equal(bindingStatus('Ctrl+G', undefined), 'assigned');
  assert.equal(bindingStatus('Ctrl+G', { shortcut: 'Alt+Shift+G', at: 1 }), 'assigned', 'verified an older key; the new key is untested');
  assert.equal(bindingStatus('Ctrl+G', { shortcut: 'ctrl+g', at: 1 }), 'verified');
});

test('keys: which launcher actually holds a key', () => {
  const shortcuts = { 'launch-02': '', 'launch-03': 'Ctrl+G' };
  assert.equal(otherCommandWithKey('launch-02', 'Ctrl+G', shortcuts), 'launch-03');
  assert.equal(otherCommandWithKey('launch-03', 'Ctrl+G', shortcuts), null);
  assert.equal(otherCommandWithKey('launch-02', '', shortcuts), null);
});

test('guidance: it names the exact Chrome command to edit, for the launcher in question', () => {
  const launchers = { 'launch-02': { name: 'GitHub', url: 'https://github.com/' } };
  const none = keyAdvice('launch-02', launchers['launch-02'], { shortcuts: { 'launch-02': '' }, verified: {}, launchers });
  assert.equal(none[0], 'For GitHub, edit \u201CTabfold launcher 02\u201D in Chrome and choose a key.');
  const has = keyAdvice('launch-02', launchers['launch-02'], { shortcuts: { 'launch-02': 'Alt+Shift+G' }, verified: {}, launchers });
  assert.match(has[0], /To change the key for GitHub, edit .Tabfold launcher 02. in Chrome/);
  assert.ok(has.some((l) => /Assigned means Chrome reports this key.*Verified/.test(l)));
  const ver = keyAdvice('launch-02', launchers['launch-02'], { shortcuts: { 'launch-02': 'Alt+Shift+G' }, verified: { 'launch-02': { shortcut: 'Alt+Shift+G', at: 1 } }, launchers });
  assert.ok(!ver.some((l) => /Assigned means/.test(l)), 'once verified there is nothing left to explain');
});

test('guidance: Ctrl+G is explained as Chrome\'s Find Next and Alt+Shift+G is offered; the explanation goes away once the key is Verified', () => {
  const l = { name: 'GitHub', url: 'https://github.com/', wantedKey: 'Ctrl+G' };
  const launchers = { 'launch-02': l };
  const planned = keyAdvice('launch-02', l, { shortcuts: { 'launch-02': '' }, verified: {}, launchers });
  const find = planned.find((x) => /is also Chrome's Find Next/.test(x));
  assert.ok(find, 'a planned Ctrl+G is explained even before Chrome has a key');
  assert.match(find, /Ctrl\+G is also Chrome's Find Next/);
  assert.match(find, /Tabfold launcher 02/);
  assert.match(find, /Tabfold takes priority/);
  assert.match(find, /Find Next keeps working on F3/, 'and it says where the displaced Chrome action lives now');
  assert.ok(planned.some((x) => /still runs Chrome's Find Next/.test(x) && /Alt\+Shift\+G/.test(x)), 'with Alt+Shift+G as the fallback');
  const assigned = keyAdvice('launch-02', l, { shortcuts: { 'launch-02': 'Ctrl+G' }, verified: {}, launchers });
  assert.ok(assigned.some((x) => /is also Chrome's Find Next/.test(x)));
  const verified = keyAdvice('launch-02', l, { shortcuts: { 'launch-02': 'Ctrl+G' }, verified: { 'launch-02': { shortcut: 'Ctrl+G', at: 1 } }, launchers });
  assert.ok(!verified.some((x) => /still runs|is also Chrome/.test(x)), 'it demonstrably works, so no warning');
  assert.ok(verified.some((x) => /Ctrl\+G is Tabfold's now: it takes priority over Chrome's Find Next\. Find Next keeps working on F3\./.test(x)), 'instead it reports what changed');
  const other = keyAdvice('launch-02', { name: 'GitHub', url: 'https://github.com/' }, { shortcuts: { 'launch-02': 'Alt+Shift+G' }, verified: {}, launchers });
  assert.ok(!other.some((x) => /Find Next/.test(x)), 'no Find Next note for a different key');
});

test('chrome keys: what a key replaces and where that Chrome action lives now', async () => {
  const { chromeKeyInfo, conflictNote, RESERVED, BUILT_IN } = await import('../lib/chrome-keys.js');
  assert.deepEqual(chromeKeyInfo('Ctrl+G'), { kind: 'builtin', action: 'Find Next', alternates: ['F3'] });
  assert.deepEqual(chromeKeyInfo('ctrl + shift + g'), { kind: 'builtin', action: 'Find Previous', alternates: ['Shift+F3'] });
  assert.equal(chromeKeyInfo('Ctrl+R').alternates[0], 'F5');
  assert.equal(chromeKeyInfo('Ctrl+L').alternates.join(), 'Alt+D,F6');
  assert.equal(chromeKeyInfo('Ctrl+T').kind, 'reserved');
  assert.equal(chromeKeyInfo('Ctrl+W').kind, 'reserved');
  assert.equal(chromeKeyInfo('Alt+Shift+G'), null, 'a key Chrome does nothing with');
  assert.equal(chromeKeyInfo('Ctrl+Y'), null);
  assert.equal(chromeKeyInfo(''), null);
  assert.ok(Object.keys(RESERVED).every((k) => !(k in BUILT_IN)), 'a key is either reserved or replaceable, never both');

  assert.equal(conflictNote('Ctrl+G', 'Tabfold launcher 02'),
    "Ctrl+G is also Chrome's Find Next. Once Chrome assigns it to “Tabfold launcher 02” Tabfold takes priority, and Chrome's Find Next stops responding to Ctrl+G; Find Next keeps working on F3.");
  assert.equal(conflictNote('Ctrl+G', 'Tabfold launcher 02', { holds: true }), "Ctrl+G is Tabfold's now: it takes priority over Chrome's Find Next. Find Next keeps working on F3.");
  assert.match(conflictNote('Ctrl+D', 'Tabfold launcher 02'), /Chrome has no second key for Bookmark this page; it stays in Chrome's menu/);
  assert.match(conflictNote('Ctrl+T', 'Tabfold launcher 02'), /Chrome keeps Ctrl\+T for itself \(New tab\), so no extension can use it\. Pick a different key for .Tabfold launcher 02./);
  assert.equal(conflictNote('Alt+Shift+G', 'x'), null);
});

test('guidance: a reserved key is flagged as unusable, with no false promise of priority', () => {
  const l = { name: 'Notes', url: 'https://example.com/', wantedKey: 'Ctrl+T' };
  const lines = keyAdvice('launch-04', l, { shortcuts: { 'launch-04': '' }, verified: {}, launchers: { 'launch-04': l } });
  assert.ok(lines.some((x) => /keeps Ctrl\+T for itself \(New tab\)/.test(x)));
  assert.ok(!lines.some((x) => /takes priority/.test(x)));
});

test('guidance: a planned key that Chrome put on a DIFFERENT launcher is called out by name', () => {
  const launchers = { 'launch-02': { name: 'GitHub', url: 'https://github.com/', wantedKey: 'Ctrl+G' }, 'launch-03': { name: 'Gmail', url: 'https://mail.google.com/' } };
  const lines = keyAdvice('launch-02', launchers['launch-02'], { shortcuts: { 'launch-02': '', 'launch-03': 'Ctrl+G' }, verified: {}, launchers });
  assert.ok(lines.some((x) => /Ctrl\+G is assigned to .Tabfold launcher 03. \(Gmail\), not to GitHub\. Move it to .Tabfold launcher 02. in Chrome/.test(x)), lines.join(' | '));
});
