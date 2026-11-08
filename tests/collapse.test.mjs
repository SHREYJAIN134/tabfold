import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChrome, settle } from './fake-chrome.mjs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const fake = createFakeChrome();
globalThis.chrome = fake.chrome;
const url = (p) => pathToFileURL(resolve(p)).href;
const grouping = await import(url('lib/grouping.js'));
const collapse = await import(url('lib/collapse.js'));
const store = await import(url('lib/store.js'));
const bg = await import(url('background.js'));
const { helpers, state } = fake;

function reset() {
  state.windows = []; state.tabs = []; state.groups = []; state.store = { local: {}, session: {} }; state.focusedWindow = null;
  state.updateLog = []; state.forcedSwitches = [];
}
const activate = (tabId) => fake.chrome.tabs.update(tabId, { active: true });
const active = (windowId) => state.tabs.find((t) => t.windowId === windowId && t.active);
const groupByTitle = (windowId, title) => state.groups.find((g) => g.windowId === windowId && g.title === title);
const collapsed = (windowId) => helpers.collapsedIn(windowId);

/** A window with GitHub x2, YouTube x2, Google x1, a pinned tab and a Chrome page, grouped; everything starts expanded. */
async function scene() {
  reset();
  const w = helpers.addWindow();
  const t = {
    pinned: helpers.addTab(w.id, 'https://github.com/pinned', { pinned: true }),
    gh1: helpers.addTab(w.id, 'https://github.com/a'), gh2: helpers.addTab(w.id, 'https://github.com/b'),
    yt1: helpers.addTab(w.id, 'https://www.youtube.com/watch?v=1'), yt2: helpers.addTab(w.id, 'https://www.youtube.com/watch?v=2'),
    g1: helpers.addTab(w.id, 'https://mail.google.com/'),
    plain: helpers.addTab(w.id, 'chrome://settings/'),
  };
  t.gh1.active = true;
  await grouping.organizeAll();
  state.updateLog.length = 0;
  return { w, t };
}

// ------------------------------------------------------------------ selecting tabs

test('selecting a grouped tab expands its group and collapses the others; Technical -> YouTube -> Technical', async () => {
  const { w, t } = await scene();
  await activate(t.gh1.id); await settle();
  assert.deepEqual(collapsed(w.id), { Technical: false, YouTube: true, Google: true });
  await activate(t.yt1.id); await settle();
  assert.deepEqual(collapsed(w.id), { Technical: true, YouTube: false, Google: true }, 'YouTube expands, Technical collapses');
  await activate(t.gh2.id); await settle();
  assert.deepEqual(collapsed(w.id), { Technical: false, YouTube: true, Google: true });
  await activate(t.g1.id); await settle();
  assert.deepEqual(collapsed(w.id), { Technical: true, YouTube: true, Google: false });
  assert.equal(state.forcedSwitches.length, 0, 'Chrome never had to move me off my tab');
});

test('selecting a pinned or ungrouped tab collapses every group in that window', async () => {
  const { w, t } = await scene();
  await activate(t.yt1.id); await settle();
  assert.equal(collapsed(w.id).YouTube, false);
  await activate(t.pinned.id); await settle();
  assert.deepEqual(collapsed(w.id), { Technical: true, YouTube: true, Google: true }, 'pinned tab');
  await activate(t.gh1.id); await settle();
  await activate(t.plain.id); await settle();
  assert.deepEqual(collapsed(w.id), { Technical: true, YouTube: true, Google: true }, 'ungrouped chrome:// tab');
  assert.equal(state.forcedSwitches.length, 0);
});

test('only the expanded/collapsed flag changes: every tab, name, colour, membership and order is preserved', async () => {
  const { w, t } = await scene();
  const snapshot = () => JSON.stringify({
    tabs: state.tabs.map((x) => [x.id, x.url, x.groupId, x.pinned, x.index]),
    groups: state.groups.map((g) => [g.id, g.title, g.color, g.windowId]),
  });
  const before = snapshot();
  for (const tab of [t.yt1, t.gh1, t.pinned, t.g1, t.plain, t.yt2]) { await activate(tab.id); await settle(); }
  assert.equal(snapshot(), before);
  assert.ok(state.updateLog.length > 0);
  assert.ok(state.updateLog.every((u) => Object.keys(u).sort().join() === 'collapsed,id'), 'tabGroups.update was only ever called with {collapsed}');
  assert.equal(state.tabs.length, 7, 'no tab was closed');
});

test('a group you made yourself follows the same rule', async () => {
  const { w, t } = await scene();
  const mine = helpers.addTab(w.id, 'https://example.com/notes');
  const work = helpers.addUserGroup(w.id, 'Work', 'purple', [mine.id]);
  await activate(t.gh1.id); await settle();
  assert.equal(work.collapsed, true);
  await activate(mine.id); await settle();
  assert.equal(work.collapsed, false);
  assert.equal(groupByTitle(w.id, 'Technical').collapsed, true);
  assert.equal(work.title, 'Work');
  assert.equal(mine.groupId, work.id, 'its membership is untouched');
});

test('each window is independent: another window\'s groups keep their state', async () => {
  const { w, t } = await scene();
  const w2 = helpers.addWindow();
  const a = helpers.addTab(w2.id, 'https://github.com/x'); a.active = true;
  const b = helpers.addTab(w2.id, 'https://www.youtube.com/y');
  await grouping.organizeAll();
  groupByTitle(w2.id, 'YouTube').collapsed = true; // the user's state in window 2
  state.updateLog.length = 0;

  await activate(t.yt1.id); await settle();
  await activate(t.gh1.id); await settle();
  await activate(t.pinned.id); await settle();
  const ids2 = new Set(state.groups.filter((g) => g.windowId === w2.id).map((g) => g.id));
  assert.ok(state.updateLog.every((u) => !ids2.has(u.id)), 'no group of window 2 was touched');
  assert.deepEqual(collapsed(w2.id), { Technical: false, YouTube: true });

  await activate(b.id); await settle();
  assert.deepEqual(collapsed(w2.id), { Technical: true, YouTube: false }, 'activity in window 2 only affects window 2');
  assert.deepEqual(collapsed(w.id), { Technical: true, YouTube: true, Google: true }, 'window 1 is as window 1 left it (pinned tab selected)');
});

// ------------------------------------------------------------------ rapid switching and ordering

test('rapid switching: the most recently selected tab wins and the group being read is never collapsed under it', async () => {
  const { w, t } = await scene();
  await Promise.all([activate(t.gh1.id), activate(t.yt1.id), activate(t.g1.id), activate(t.gh2.id), activate(t.yt2.id)]);
  await settle(80);
  assert.equal(active(w.id).id, t.yt2.id);
  assert.deepEqual(collapsed(w.id), { Technical: true, YouTube: false, Google: true });
  assert.equal(state.forcedSwitches.length, 0);
  for (let i = 0; i < 6; i++) { // and a second burst in the other direction
    activate([t.g1, t.gh1, t.yt1][i % 3].id);
  }
  activate(t.gh1.id);
  await settle(80);
  assert.equal(active(w.id).id, t.gh1.id);
  assert.deepEqual(collapsed(w.id), { Technical: false, YouTube: true, Google: true });
  assert.equal(state.forcedSwitches.length, 0);
});

// ------------------------------------------------------------------ a new tab becomes active BEFORE it has a group

test('a launcher tab opens active and ungrouped, then joins its group: Technical ends expanded, the rest collapsed, with no flicker', async () => {
  const { w, t } = await scene();
  await activate(t.yt1.id); await settle(); // reading YouTube; Technical collapsed
  const tech = groupByTitle(w.id, 'Technical');
  assert.equal(tech.collapsed, true);
  state.updateLog.length = 0;

  await store.saveLauncher('launch-02', { name: 'GitHub', url: 'https://github.com/launch' });
  assert.equal(await bg.handleCommand('launch-02', { windowId: w.id }), 'opened');
  await settle(80);

  const opened = state.tabs.find((x) => x.url === 'https://github.com/launch');
  assert.ok(opened.active, 'the launched tab is the active one');
  assert.equal(opened.groupId, tech.id, 'and it joined Technical');
  assert.equal(groupByTitle(w.id, 'Technical').collapsed, false, 'Technical is expanded');
  assert.equal(groupByTitle(w.id, 'YouTube').collapsed, true);
  assert.equal(groupByTitle(w.id, 'Google').collapsed, true);
  assert.equal(state.forcedSwitches.length, 0, 'the active group was never collapsed');
  const techUpdates = state.updateLog.filter((u) => u.id === tech.id);
  assert.deepEqual(techUpdates, [{ id: tech.id, collapsed: false }], 'Technical was expanded once and never collapsed in between');
});

test('a tab that is active but not yet grouped waits for Auto-group; collapsing happens with its real group', async () => {
  const { w, t } = await scene();
  await activate(t.yt1.id); await settle();
  state.updateLog.length = 0;
  // an ordinary tab Tabfold has not seen (no create event): it becomes active while ungrouped
  const fresh = helpers.addTab(w.id, 'https://stackoverflow.com/q/1');
  await activate(fresh.id);
  await settle(80);
  assert.equal(fresh.groupId, groupByTitle(w.id, 'Technical').id);
  assert.deepEqual(collapsed(w.id), { Technical: false, YouTube: true, Google: true });
  assert.equal(state.forcedSwitches.length, 0);
  assert.ok(!state.updateLog.some((u) => u.collapsed === true && u.id === groupByTitle(w.id, 'Technical').id), 'Technical was not collapsed on the way');
});

test('with Auto-group off a new active tab is simply an ungrouped tab: everything collapses', async () => {
  const { w, t } = await scene();
  await store.setSetting('autoGroup', false);
  const fresh = helpers.addTab(w.id, 'https://stackoverflow.com/q/1');
  await activate(fresh.id); await settle(60);
  assert.equal(fresh.groupId, -1);
  assert.deepEqual(collapsed(w.id), { Technical: true, YouTube: true, Google: true });
});

// ------------------------------------------------------------------ background activity never collapses what I am reading

test('opening or updating BACKGROUND tabs never touches the group being read, or groups I expanded by hand', async () => {
  const { w, t } = await scene();
  await activate(t.gh1.id); await settle();
  groupByTitle(w.id, 'YouTube').collapsed = false; // I peeked into YouTube by hand
  state.updateLog.length = 0;

  const bgTab = await fake.chrome.tabs.create({ windowId: w.id, url: 'https://github.com/background', active: false });
  const bgYt = await fake.chrome.tabs.create({ windowId: w.id, url: 'https://www.youtube.com/watch?v=9', active: false });
  await helpers.navigate(bgTab.id, 'https://www.youtube.com/watch?v=10'); // a background tab navigates to another category
  await helpers.navigate(t.gh2.id, 'https://gitlab.com/x');
  await settle(80);

  assert.equal(active(w.id).id, t.gh1.id, 'I am still on the same tab');
  assert.equal(groupByTitle(w.id, 'Technical').collapsed, false, 'the group I am reading stays open');
  assert.equal(groupByTitle(w.id, 'YouTube').collapsed, false, 'and a group I opened by hand was not collapsed behind my back');
  assert.deepEqual(state.updateLog.filter((u) => u.collapsed === true), [], 'nothing was collapsed by background activity');
  assert.equal(state.forcedSwitches.length, 0);
  assert.ok(bgYt.id && state.tabs.find((x) => x.id === bgTab.id).groupId === groupByTitle(w.id, 'YouTube').id, 'background tabs were still grouped normally');
});

test('moving the tab I am reading into another group re-checks the window', async () => {
  const { w, t } = await scene();
  await activate(t.gh1.id); await settle();
  assert.equal(groupByTitle(w.id, 'YouTube').collapsed, true);
  await fake.chrome.tabs.group({ tabIds: [t.gh1.id], groupId: groupByTitle(w.id, 'YouTube').id }); // I drag the tab into YouTube
  await settle(80);
  assert.equal(groupByTitle(w.id, 'YouTube').collapsed, false);
  assert.equal(state.forcedSwitches.length, 0);
});

// ------------------------------------------------------------------ the setting

test('the setting defaults to on, survives older stored settings, and switching it off or on behaves', async () => {
  reset();
  assert.deepEqual(await store.getSettings(), { autoGroup: true, collapseInactive: true });
  state.store.local.settings = { autoGroup: false }; // a profile saved before this setting existed
  assert.deepEqual(await store.getSettings(), { autoGroup: false, collapseInactive: true });
  state.store.local.settings = 'garbage';
  assert.deepEqual(await store.getSettings(), { autoGroup: true, collapseInactive: true });
  state.store.local.settings = { autoGroup: true, collapseInactive: false };
  assert.equal((await store.getSettings()).collapseInactive, false);
  const next = await store.setSetting('autoGroup', false);
  assert.deepEqual(next, { autoGroup: false, collapseInactive: false }, 'changing one switch keeps the other');
});

test('Collapse inactive groups OFF leaves every group alone; switching it ON applies to what is open', async () => {
  const { w, t } = await scene();
  await store.setSetting('collapseInactive', false);
  await activate(t.yt1.id); await settle(); await activate(t.pinned.id); await settle();
  assert.deepEqual(collapsed(w.id), { Technical: false, YouTube: false, Google: false });
  assert.equal(state.updateLog.length, 0);

  await activate(t.yt1.id); await settle();
  await store.setSetting('collapseInactive', true); // fires storage.onChanged
  await settle(80);
  assert.deepEqual(collapsed(w.id), { Technical: true, YouTube: false, Google: true });
});

// ------------------------------------------------------------------ launcher commands: exactly once, and "Verified"

test('a delivered command opens the website EXACTLY ONCE even if delivered twice or auto-repeated', async () => {
  reset();
  const w = helpers.addWindow();
  helpers.addTab(w.id, 'https://example.com/', { active: true });
  await store.saveLauncher('launch-02', { name: 'GitHub', url: 'https://github.com/' });
  const tab = { windowId: w.id };
  const t0 = 1_000_000;
  const results = [await bg.receiveCommand('launch-02', tab, t0), await bg.receiveCommand('launch-02', tab, t0 + 5), await bg.receiveCommand('launch-02', tab, t0 + 300), await bg.receiveCommand('launch-02', tab, t0 + 699)];
  assert.deepEqual(results, ['opened', 'duplicate', 'duplicate', 'duplicate']);
  assert.equal(state.tabs.filter((x) => x.url === 'https://github.com/').length, 1);
  assert.equal(await bg.receiveCommand('launch-02', tab, t0 + 701), 'opened', 'a real second press after the window opens another tab');
  assert.equal(state.tabs.filter((x) => x.url === 'https://github.com/').length, 2);
  const opened = state.tabs.filter((x) => x.url === 'https://github.com/');
  assert.ok(opened.every((x) => x.windowId === w.id), 'in the current window');
  assert.ok(state.tabs.find((x) => x.id === opened[1].id).active, 'and the newest one is active');
});

test('"Verified" is recorded only when Chrome delivers the command, with the key Chrome reports; direct calls and other commands do not set it', async () => {
  reset();
  const w = helpers.addWindow();
  fake.chrome.commands.getAll = async () => [{ name: 'launch-02', shortcut: 'Ctrl+G', description: 'Tabfold launcher 02' }, { name: 'launch-03', shortcut: '', description: 'Tabfold launcher 03' }];
  await store.saveLauncher('launch-02', { name: 'GitHub', url: 'https://github.com/' });
  await bg.handleCommand('launch-02', { windowId: w.id }); // not delivered by Chrome
  await settle();
  assert.deepEqual(await store.getVerified(), {});
  await bg.receiveCommand('launch-02', { windowId: w.id }, 5_000_000);
  await settle();
  assert.deepEqual(await store.getVerified(), { 'launch-02': { shortcut: 'Ctrl+G', at: 5_000_000 } });
  assert.equal(await bg.receiveCommand('_execute_action', { windowId: w.id }), 'ignored');
  assert.equal(await bg.receiveCommand('launch-99', { windowId: w.id }), 'ignored');
  assert.deepEqual(Object.keys(await store.getVerified()), ['launch-02']);
});

test('saved launchers and their command IDs are untouched by all of this', async () => {
  reset();
  state.store.local = {
    seeded: true,
    launchers: { 'launch-01': { name: 'YouTube', url: 'https://www.youtube.com/' }, 'launch-02': { name: 'GitHub', url: 'https://github.com/', wantedKey: 'Ctrl+G' } },
    settings: { autoGroup: true },
  };
  const before = JSON.stringify(state.store.local.launchers);
  await store.getSettings(); await store.seedDefaults(); await store.getVerified(); await store.setSetting('collapseInactive', true);
  assert.equal(JSON.stringify(state.store.local.launchers), before);
  assert.deepEqual(Object.keys(await store.getLaunchers()), ['launch-01', 'launch-02']);
});
