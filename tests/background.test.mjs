import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChrome, settle } from './fake-chrome.mjs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// The background code reads the global `chrome` when it runs, so one fake is installed for the whole file and reset per test.
const fake = createFakeChrome();
globalThis.chrome = fake.chrome;
const url = (p) => pathToFileURL(resolve(p)).href;
const grouping = await import(url('lib/grouping.js'));
const store = await import(url('lib/store.js'));
const bg = await import(url('background.js'));

function reset() {
  fake.state.windows = []; fake.state.tabs = []; fake.state.groups = []; fake.state.store = { local: {}, session: {} }; fake.state.focusedWindow = null; fake.state.updateLog = []; fake.state.forcedSwitches = [];
  // keep the listeners the background module registered on import
}
const A = () => fake.helpers.groupsIn(1);
const titles = (windowId) => fake.helpers.groupsIn(windowId).map((g) => g.title).sort();

async function fire(command, tab) {
  return bg.handleCommand(command, tab);
}

// ------------------------------------------------------------------ launching

test('launcher key: opens the saved site in a NEW ACTIVE tab of the current window', async () => {
  reset();
  const w1 = fake.helpers.addWindow(); const w2 = fake.helpers.addWindow();
  const current = fake.helpers.addTab(w2.id, 'https://example.com/', { active: true });
  await store.saveLauncher('launch-02', { name: 'GitHub', url: 'https://github.com/' });
  const result = await fire('launch-02', { id: current.id, windowId: w2.id });
  assert.equal(result, 'opened');
  const opened = fake.state.tabs.find((t) => t.url === 'https://github.com/');
  assert.ok(opened);
  assert.equal(opened.windowId, w2.id, 'in the window the key was pressed in, not another one');
  assert.equal(opened.active, true);
  assert.equal(fake.state.tabs.filter((t) => t.windowId === w1.id).length, 0);
});

test('launcher key: falls back to the last focused normal window when no tab is supplied', async () => {
  reset();
  fake.helpers.addWindow(); const w2 = fake.helpers.addWindow(); fake.state.focusedWindow = w2.id;
  await store.saveLauncher('launch-01', { name: 'YouTube', url: 'https://www.youtube.com/' });
  assert.equal(await fire('launch-01'), 'opened');
  assert.equal(fake.state.tabs[0].windowId, w2.id);
});

test('an empty, deleted, unknown or unsafe slot does nothing', async () => {
  reset();
  const w = fake.helpers.addWindow();
  await store.saveLauncher('launch-02', { name: 'GitHub', url: 'https://github.com/' });
  await store.deleteLauncher('launch-02');
  assert.equal(await fire('launch-02', { windowId: w.id }), 'empty', 'deleted: its key (if Chrome still has one) does nothing');
  assert.equal(await fire('launch-09', { windowId: w.id }), 'empty', 'never used');
  assert.equal(await fire('_execute_action'), 'ignored');
  assert.equal(await fire('launch-99'), 'ignored');
  fake.state.store.local.launchers = { 'launch-03': { name: 'Evil', url: 'javascript:alert(1)' } }; // corrupted storage
  assert.equal(await fire('launch-03', { windowId: w.id }), 'unsafe');
  fake.state.store.local.launchers = { 'launch-04': { name: 'Evil', url: 'file:///C:/Windows/win.ini' } };
  assert.equal(await fire('launch-04', { windowId: w.id }), 'unsafe');
  assert.equal(fake.state.tabs.length, 0, 'no tab was opened by any of them');
});

test('editing the URL changes where the same slot goes; deleting then re-adding reuses the slot', async () => {
  reset();
  const w = fake.helpers.addWindow();
  await store.saveLauncher('launch-02', { name: 'GitHub', url: 'https://github.com/' });
  await fire('launch-02', { windowId: w.id });
  await store.saveLauncher('launch-02', { name: 'GitHub', url: 'https://github.com/anthropics' });
  await fire('launch-02', { windowId: w.id });
  await store.deleteLauncher('launch-02');
  await fire('launch-02', { windowId: w.id });
  await store.saveLauncher('launch-02', { name: 'GitLab', url: 'https://gitlab.com/' });
  await fire('launch-02', { windowId: w.id });
  assert.deepEqual(fake.state.tabs.map((t) => t.url), ['https://github.com/', 'https://github.com/anthropics', 'https://gitlab.com/']);
});

// ------------------------------------------------------------------ grouping

test('five GitHub launches land in ONE Technical group; the group is blue and named Technical', async () => {
  reset();
  const w = fake.helpers.addWindow();
  await store.saveLauncher('launch-02', { name: 'GitHub', url: 'https://github.com/' });
  await Promise.all([1, 2, 3, 4, 5].map(() => fire('launch-02', { windowId: w.id })));
  await settle();
  const groups = A();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, 'Technical');
  assert.equal(groups[0].color, 'blue');
  assert.equal(groups[0].tabs.length, 5);
});

test('navigating one tab from GitHub to YouTube moves just that tab into YouTube', async () => {
  reset();
  const w = fake.helpers.addWindow();
  const tabs = [1, 2, 3].map(() => fake.helpers.addTab(w.id, 'https://github.com/'));
  await grouping.organizeAll();
  assert.equal(A().length, 1);
  await fake.helpers.navigate(tabs[1].id, 'https://www.youtube.com/watch?v=1');
  await settle();
  const byTitle = Object.fromEntries(A().map((g) => [g.title, g.tabs]));
  assert.deepEqual(byTitle.Technical, ['https://github.com/', 'https://github.com/']);
  assert.deepEqual(byTitle.YouTube, ['https://www.youtube.com/watch?v=1']);
  assert.equal(A().find((g) => g.title === 'YouTube').color, 'red');
});

test('existing tabs are organised on install; pinned, blank, Chrome pages and custom groups are left alone', async () => {
  reset();
  const w = fake.helpers.addWindow();
  const pinned = fake.helpers.addTab(w.id, 'https://github.com/', { pinned: true });
  const blank = fake.helpers.addTab(w.id, 'about:blank');
  const newtab = fake.helpers.addTab(w.id, 'chrome://newtab/');
  const settings = fake.helpers.addTab(w.id, 'chrome://settings/');
  const ext = fake.helpers.addTab(w.id, 'chrome-extension://abc/popup.html');
  const mine = fake.helpers.addTab(w.id, 'https://github.com/mine');
  const custom = fake.helpers.addUserGroup(w.id, 'Work', 'purple', [mine.id]);
  const yt = fake.helpers.addTab(w.id, 'https://music.youtube.com/');
  const g1 = fake.helpers.addTab(w.id, 'https://mail.google.com/');
  const g2 = fake.helpers.addTab(w.id, 'https://docs.google.com/document/d/1');
  const o = fake.helpers.addTab(w.id, 'https://example.com/');
  await fake.helpers.emit('installed', { reason: 'install' });
  await settle();
  assert.equal(pinned.groupId, -1);
  for (const t of [blank, newtab, settings, ext]) assert.equal(t.groupId, -1, t.url);
  assert.equal(mine.groupId, custom.id, 'a tab in the user\'s own group stays there');
  assert.deepEqual(titles(w.id), ['Google', 'Others', 'Work', 'YouTube']);
  assert.equal(g1.groupId, g2.groupId);
  assert.notEqual(yt.groupId, o.groupId);
  assert.equal(fake.state.groups.find((g) => g.id === custom.id).title, 'Work');
  assert.deepEqual(await store.getLaunchers(), { 'launch-01': { name: 'YouTube', url: 'https://www.youtube.com/' } }, 'first run seeds YouTube in slot 01');
});

test('every window is independent: each gets its own group per category', async () => {
  reset();
  const w1 = fake.helpers.addWindow(); const w2 = fake.helpers.addWindow();
  fake.helpers.addTab(w1.id, 'https://github.com/a'); fake.helpers.addTab(w1.id, 'https://github.com/b');
  fake.helpers.addTab(w2.id, 'https://github.com/c'); fake.helpers.addTab(w2.id, 'https://www.youtube.com/');
  await grouping.organizeAll();
  assert.deepEqual(titles(w1.id), ['Technical']);
  assert.deepEqual(titles(w2.id), ['Technical', 'YouTube']);
  assert.equal(fake.state.groups.length, 3);
  assert.equal(fake.state.tabs.filter((t) => t.windowId === w1.id).every((t) => fake.state.groups.find((g) => g.id === t.groupId).windowId === w1.id), true);
});

test('a new tab opened by a link or typed address joins its group via the tab events', async () => {
  reset();
  const w = fake.helpers.addWindow();
  fake.helpers.addTab(w.id, 'https://github.com/');
  await grouping.organizeAll();
  const t = fake.helpers.addTab(w.id, '');
  t.pendingUrl = 'https://github.com/tabfold';
  await fake.helpers.emit('tabCreated', { ...t });
  await settle();
  assert.equal(A().length, 1);
  assert.equal(A()[0].tabs.length, 2);
  const blank = fake.helpers.addTab(w.id, '');
  await fake.helpers.emit('tabCreated', { ...blank });
  await settle();
  assert.equal(blank.groupId, -1, 'a blank tab is left alone');
});

test('a tab the user dragged out of a group is not pulled back by navigation within the same site', async () => {
  reset();
  const w = fake.helpers.addWindow();
  const a = fake.helpers.addTab(w.id, 'https://github.com/a');
  fake.helpers.addTab(w.id, 'https://github.com/b');
  await grouping.organizeAll();
  a.groupId = -1; // the user drags it out
  await fake.helpers.navigate(a.id, 'https://github.com/a/issues');
  await settle();
  assert.equal(a.groupId, -1, 'same category as before: leave the user\'s choice');
  await fake.helpers.navigate(a.id, 'https://www.youtube.com/');
  await settle();
  assert.notEqual(a.groupId, -1, 'but a different category is grouped');
});

test('a user group that happens to share a title but has another colour is never mistaken for ours', async () => {
  reset();
  const w = fake.helpers.addWindow();
  const mine = fake.helpers.addTab(w.id, 'https://github.com/mine');
  const theirs = fake.helpers.addUserGroup(w.id, 'Technical', 'pink', [mine.id]);
  const other = fake.helpers.addTab(w.id, 'https://github.com/other');
  await grouping.organizeAll();
  assert.equal(mine.groupId, theirs.id);
  assert.notEqual(other.groupId, theirs.id, 'a separate Technical group was created for ours');
  assert.equal(fake.state.groups.length, 2);
});

test('Auto-group off: nothing is grouped; switching it back on organises what is open', async () => {
  reset();
  const w = fake.helpers.addWindow();
  await store.setSetting('autoGroup', false);
  const t = fake.helpers.addTab(w.id, 'https://github.com/');
  await fake.helpers.emit('tabCreated', { ...t });
  await grouping.organizeAll();
  await settle();
  assert.equal(t.groupId, -1);
  await store.saveLauncher('launch-02', { name: 'GitHub', url: 'https://github.com/' });
  await fire('launch-02', { windowId: w.id });
  await settle();
  assert.equal(A().length, 0, 'launching does not group while Auto-group is off');

  await store.setSetting('autoGroup', true); // fires storage.onChanged
  await settle(60);
  assert.equal(A().length, 1);
  assert.equal(A()[0].tabs.length, 2);
});

test('popup / app windows cannot hold groups and are skipped without error', async () => {
  reset();
  fake.helpers.addWindow();
  const popup = fake.helpers.addWindow('popup');
  const t = fake.helpers.addTab(popup.id, 'https://github.com/');
  assert.equal(await grouping.organizeTab(t.id), 'window');
  assert.equal(t.groupId, -1);
  assert.equal(await grouping.organizeTab(99999), 'gone', 'a tab that closed meanwhile is not an error');
});

test('categoryOfGroup recognises only Tabfold\'s title+colour pairs', () => {
  assert.equal(grouping.categoryOfGroup({ title: 'YouTube', color: 'red' }), 'youtube');
  assert.equal(grouping.categoryOfGroup({ title: 'Google', color: 'yellow' }), 'google');
  assert.equal(grouping.categoryOfGroup({ title: 'Others', color: 'grey' }), 'others');
  assert.equal(grouping.categoryOfGroup({ title: 'Work', color: 'purple' }), null);
  assert.equal(grouping.categoryOfGroup({ title: 'Technical', color: 'red' }), null);
  assert.equal(grouping.categoryOfGroup(null), null);
});
