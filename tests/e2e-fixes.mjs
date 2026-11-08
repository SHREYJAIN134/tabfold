// Real-browser verification of: (1) launcher keys that Chrome delivers (Assigned / Verified, Ctrl+G vs Find Next, Alt+Shift+G) and
// (2) collapsing inactive tab groups. A SEPARATE headful Chrome with a throw-away profile; real OS key presses are sent to it
// (tests/send-keys.ps1 refuses to type unless that window is the foreground window). Your normal Chrome is not touched.
//   node tests/e2e-fixes.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, startSite, createReporter, sleep, root } from './cdp-harness.mjs';

const r = createReporter();
const web = await startSite();
const b = await launch({ headful: true });
const shotsDir = join(root, 'tests', 'screenshots');
const press = (chord) => {
  try { return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tests', 'send-keys.ps1'), '-ChromePid', String(b.pid), '-Chord', chord], { encoding: 'utf8' }).trim(); }
  catch (e) { return `ERR ${String(e.stdout || e.message).trim()}`; }
};

try {
  console.log(`Chrome: ${b.exe}\nProfile: ${b.profile}\n`);
  console.log(`Browser: ${(await b.cdp('Browser.getVersion')).product}\n`);
  const ext = await b.loadExtension();
  const inSW = (e) => b.evaluate(ext.sw, e);
  const popupUrl = `chrome-extension://${ext.id}/popup.html`;
  await until(async () => (await inSW(`chrome.storage.local.get('seeded')`)).seeded, 'defaults');
  async function until(fn, what, ms = 8000) { return b.until(fn, what, ms); }

  const win1 = await inSW(`chrome.windows.getAll({windowTypes:['normal']}).then(w => w[0].id)`);
  const tabsOf = (w) => inSW(`chrome.tabs.query({windowId: ${w}}).then(ts => ts.map(t => ({id: t.id, url: t.url || t.pendingUrl, active: t.active, groupId: t.groupId, pinned: t.pinned, index: t.index})))`);
  const groupsOf = (w) => inSW(`(async () => { const gs = await chrome.tabGroups.query({windowId: ${w}}); const out = []; for (const g of gs) { const ts = await chrome.tabs.query({groupId: g.id}); out.push({id: g.id, title: g.title, color: g.color, collapsed: g.collapsed, n: ts.length}); } return out; })()`);
  const state = async (w) => Object.fromEntries((await groupsOf(w)).map((g) => [g.title, g.collapsed]));
  const mk = (w, url, extra = '') => inSW(`chrome.tabs.create({windowId: ${w}, url: ${JSON.stringify(url)}, active: false${extra}}).then(t => t.id)`);
  const activate = (id) => inSW(`chrome.tabs.update(${id}, {active: true}).then(() => true)`);
  const count = (re, w) => inSW(`chrome.tabs.query({${w ? `windowId: ${w}` : ''}}).then(ts => ts.filter(t => ${re}.test(t.url || t.pendingUrl || '')).length)`);
  const assignKey = async (command, keybinding) => {
    const { targetId } = await b.cdp('Target.createTarget', { url: 'chrome://extensions/shortcuts' });
    const page = await b.attach(targetId);
    await b.cdp('Runtime.enable', {}, page);
    await sleep(1200);
    const res = await b.evaluate(page, `new Promise((res) => chrome.developerPrivate.updateExtensionCommand({extensionId: ${JSON.stringify(ext.id)}, commandName: ${JSON.stringify(command)}, keybinding: ${JSON.stringify(keybinding)}, scope: 'CHROME'}, () => res(chrome.runtime.lastError ? 'ERROR: ' + chrome.runtime.lastError.message : 'ok')))`);
    await b.cdp('Target.closeTarget', { targetId });
    return res;
  };
  const usedTargets = new Set();
  async function openPopup(windowId) {
    const tabId = await inSW(`chrome.tabs.create({windowId: ${windowId}, url: ${JSON.stringify(popupUrl)}, active: true}).then(t => t.id)`);
    const target = await until(async () => (await b.cdp('Target.getTargets')).targetInfos.find((t) => t.type === 'page' && t.url === popupUrl && !usedTargets.has(t.targetId)), 'popup target');
    usedTargets.add(target.targetId);
    const session = await b.attach(target.targetId);
    await b.cdp('Page.enable', {}, session);
    await b.cdp('Runtime.enable', {}, session);
    await b.cdp('Emulation.setDeviceMetricsOverride', { width: 440, height: 580, deviceScaleFactor: 2, mobile: false }, session);
    await until(() => b.evaluate(session, `document.querySelectorAll('#results .item').length > 0`), 'popup to render');
    return { tabId, session, ev: (e) => b.evaluate(session, e), close: () => inSW(`chrome.tabs.remove(${tabId}).then(() => true)`) };
  }
  async function shot(session, name) { mkdirSync(shotsDir, { recursive: true }); const { data } = await b.cdp('Page.captureScreenshot', { format: 'png' }, session); writeFileSync(join(shotsDir, `${name}.png`), Buffer.from(data, 'base64')); }

  // ================================================================== Part 1: the GitHub launcher and its key
  console.log('--- Part 1: launcher keys ---');
  const GH = web.site('github.com', '/');
  await inSW(`chrome.storage.local.get('launchers').then(({launchers}) => chrome.storage.local.set({launchers: {...launchers, 'launch-02': {name: 'GitHub', url: ${JSON.stringify(GH)}, wantedKey: 'Ctrl+G'}}}))`);
  const ytTab = await mk(win1, web.site('www.youtube.com', '/watch?v=1'));
  const mailTab = await mk(win1, web.site('mail.google.com', '/'));
  const pinnedTab = await mk(win1, web.site('example.com', '/pinned'), ', pinned: true');
  await sleep(1500);

  // the trace: the GitHub launcher's slot, the manifest command, Chrome's record
  const cmds = await inSW(`chrome.commands.getAll()`);
  const c2 = cmds.find((c) => c.name === 'launch-02');
  const stored2 = (await inSW(`chrome.storage.local.get('launchers')`)).launchers['launch-02'];
  r.expect(stored2.name === 'GitHub' && c2 && c2.description === 'Tabfold launcher 02' && c2.shortcut === '', 'trace: GitHub is saved under launch-02, whose Chrome command is "Tabfold launcher 02" and is unassigned', JSON.stringify(c2));

  // popup, unassigned
  let pop = await openPopup(win1);
  await pop.ev(`document.getElementById('tab-shortcuts').click()`);
  const row0 = await pop.ev(`(() => { const r = document.querySelector('.row[data-command="launch-02"]'); return { key: r.querySelector('.key') && r.querySelector('.key').textContent, assign: [...r.querySelectorAll('button')].some(x => x.textContent === 'Assign key'), chip: r.querySelector('.chip-status') && r.querySelector('.chip-status').textContent, advice: [...r.querySelectorAll('.advice li')].map(li => li.textContent) }; })()`);
  r.expect(!row0.key && row0.assign && !row0.chip, 'unassigned: the row shows "Assign key" and no key, chip or status', JSON.stringify({ key: row0.key, assign: row0.assign, chip: row0.chip }));
  r.expect(row0.advice[0] === 'For GitHub, edit “Tabfold launcher 02” in Chrome and choose a key.', 'it says exactly which command to edit', row0.advice[0]);
  r.expect(row0.advice.some((l) => /Ctrl\+G is also Chrome's Find Next.*Tabfold takes priority.*Find Next keeps working on F3/.test(l)) && row0.advice.some((l) => /Alt\+Shift\+G/.test(l)), 'it explains Ctrl+G is also Find Next, that Tabfold takes priority, where Find Next lives now (F3), and suggests Alt+Shift+G');
  const before = await count(/chrome:\/\/extensions\/shortcuts/);
  await pop.ev(`document.querySelector('.row[data-command="launch-02"] button.primary').click()`);
  await sleep(1000);
  r.expect((await count(/chrome:\/\/extensions\/shortcuts/)) === before + 1, 'Assign key opens chrome://extensions/shortcuts');
  await shot(pop.session, 'fix-1-unassigned');
  await inSW(`chrome.tabs.query({}).then(ts => Promise.all(ts.filter(t => (t.url || t.pendingUrl || '').startsWith('chrome://extensions/shortcuts')).map(t => chrome.tabs.remove(t.id))))`);
  await pop.close();

  // an unassigned Ctrl+G does not reach Tabfold
  await activate(ytTab); await sleep(600);
  const gh0 = await count(/github\.com/);
  r.expect(press('Ctrl+G').startsWith('SENT'), 'real Ctrl+G sent to the test Chrome (unassigned)');
  await sleep(1500);
  r.expect((await count(/github\.com/)) === gh0 && !(await inSW(`chrome.storage.local.get('verified')`)).verified, 'unassigned Ctrl+G: no GitHub tab opens (Chrome keeps the key) and nothing is Verified');

  // assign through Chrome's own shortcut backend
  r.expect((await assignKey('launch-02', 'Ctrl+G')) === 'ok', 'Chrome accepted Ctrl+G on "Tabfold launcher 02"');
  const c2b = (await inSW(`chrome.commands.getAll()`)).find((c) => c.name === 'launch-02');
  r.expect(c2b.shortcut === 'Ctrl+G', 'chrome.commands.getAll() now reports Ctrl+G for launch-02', JSON.stringify(c2b.shortcut));
  pop = await openPopup(win1);
  await pop.ev(`document.getElementById('tab-shortcuts').click()`);
  const row1 = await pop.ev(`(() => { const r = document.querySelector('.row[data-command="launch-02"]'); return { key: r.querySelector('.key').textContent, chip: r.querySelector('.chip-status').textContent, cls: r.querySelector('.chip-status').className, advice: [...r.querySelectorAll('.advice li')].map(li => li.textContent), change: [...r.querySelectorAll('button')].some(x => x.textContent === 'Change key') }; })()`);
  r.expect(row1.key === 'Ctrl+G' && row1.chip === 'Assigned' && /assigned/.test(row1.cls) && !/verified/.test(row1.cls), 'the row shows the key Chrome reports, labelled "Assigned" (not Verified)', JSON.stringify(row1.chip));
  r.expect(row1.change, 'a Change key button is there');
  r.expect(row1.advice.some((l) => /Find Next/.test(l)) && row1.advice.some((l) => /turns Verified the first time/.test(l)), 'Assigned explains how it becomes Verified');
  await pop.close();

  // real Ctrl+G, popup closed, on a page that has focus
  await activate(ytTab); await sleep(800);
  const winTabsBefore = (await tabsOf(win1)).length;
  const ghBefore = await count(/github\.com/, win1);
  r.expect(press('Ctrl+G').startsWith('SENT'), 'real Ctrl+G pressed with the popup closed');
  await sleep(3000); // long enough for a duplicate to show up
  const ghAfter = await count(/github\.com/, win1);
  r.expect(ghAfter === ghBefore + 1, 'the saved URL opened EXACTLY ONCE, in the current window', `${ghBefore} -> ${ghAfter} GitHub tabs, ${winTabsBefore} -> ${(await tabsOf(win1)).length} tabs`);
  const ghTab = (await tabsOf(win1)).find((t) => /github\.com/.test(t.url));
  r.expect(ghTab && ghTab.active, 'in a new ACTIVE tab');
  const g1 = await groupsOf(win1);
  const tech = g1.find((g) => g.title === 'Technical');
  r.expect(tech && ghTab.groupId === tech.id && tech.color === 'blue', 'it joined the Technical group');
  r.expect(JSON.stringify(await state(win1)) === JSON.stringify({ YouTube: true, Google: true, Technical: false }) || (await state(win1)).Technical === false && (await state(win1)).YouTube === true, 'Technical is expanded and the other groups are collapsed', JSON.stringify(await state(win1)));
  const ver = (await inSW(`chrome.storage.local.get('verified')`)).verified;
  r.expect(ver && ver['launch-02'] && ver['launch-02'].shortcut === 'Ctrl+G', 'Tabfold recorded that it RECEIVED launch-02 with Ctrl+G', JSON.stringify(ver));
  pop = await openPopup(win1);
  await pop.ev(`document.getElementById('tab-shortcuts').click()`);
  const row2 = await pop.ev(`(() => { const r = document.querySelector('.row[data-command="launch-02"]'); return { chip: r.querySelector('.chip-status').textContent, advice: [...r.querySelectorAll('.advice li')].map(li => li.textContent) }; })()`);
  r.expect(/Verified/.test(row2.chip), 'now the row says "Verified"', row2.chip);
  r.expect(!row2.advice.some((l) => /still runs|is also Chrome/.test(l)) && row2.advice.some((l) => /Ctrl\+G is Tabfold's now: it takes priority over Chrome's Find Next\. Find Next keeps working on F3\./.test(l)), 'the Find Next warning is replaced by what changed: Tabfold has Ctrl+G, Find Next is on F3');
  await pop.ev(`document.getElementById('addTop').click()`);
  await pop.ev(`(() => { const k = document.getElementById('fKey'); k.value = 'Ctrl+T'; k.dispatchEvent(new Event('input', {bubbles: true})); })()`);
  const note = await pop.ev(`document.getElementById('keyConflict').textContent`);
  r.expect(/keeps Ctrl\+T for itself \(New tab\)/.test(note), 'in the add form, a reserved key is flagged as soon as it is typed', note);
  await pop.ev(`(() => { const k = document.getElementById('fKey'); k.value = 'Ctrl+G'; k.dispatchEvent(new Event('input', {bubbles: true})); })()`);
  const note2 = await pop.ev(`document.getElementById('keyConflict').textContent`);
  r.expect(/currently on .Tabfold launcher 02. \(GitHub\)/.test(note2) && /Find Next keeps working on F3/.test(note2), 'and a key already held by another Tabfold launcher is named, with where the Chrome action went', note2);
  await shot(pop.session, 'fix-2-verified');
  await pop.close();

  // the suggested alternative: Alt+Shift+G on its own launcher
  await inSW(`chrome.storage.local.get('launchers').then(({launchers}) => chrome.storage.local.set({launchers: {...launchers, 'launch-03': {name: 'Mail', url: ${JSON.stringify(web.site('mail.google.com', '/inbox'))}}}}))`);
  r.expect((await assignKey('launch-03', 'Alt+Shift+G')) === 'ok', 'Chrome accepted Alt+Shift+G on "Tabfold launcher 03"');
  await activate(ytTab); await sleep(800);
  const mb = await count(/mail\.google\.com:\d+\/inbox/, win1);
  r.expect(press('Alt+Shift+G').startsWith('SENT'), 'real Alt+Shift+G pressed');
  await sleep(2500);
  r.expect((await count(/mail\.google\.com:\d+\/inbox/, win1)) === mb + 1, 'Alt+Shift+G opened its website exactly once');
  r.expect(((await inSW(`chrome.storage.local.get('verified')`)).verified || {})['launch-03'] && ((await inSW(`chrome.storage.local.get('verified')`)).verified['launch-03'].shortcut === 'Alt+Shift+G'), 'and that key is Verified too');

  // ================================================================== Part 2: collapse inactive groups
  console.log('\n--- Part 2: collapse inactive groups ---');
  const settings = (await inSW(`chrome.storage.local.get('settings')`)).settings;
  r.expect(!settings || settings.collapseInactive !== false, 'Collapse inactive groups is on by default');
  const ghTabs = (await tabsOf(win1)).filter((t) => /github\.com/.test(t.url));
  const ytTabs = (await tabsOf(win1)).filter((t) => /youtube\.com/.test(t.url));
  const gmailTabs = (await tabsOf(win1)).filter((t) => /mail\.google\.com/.test(t.url));
  const settle = async (ms = 900) => sleep(ms);

  await activate(ghTabs[0].id); await settle();
  r.expect(JSON.stringify(await state(win1)) === JSON.stringify({ YouTube: true, Google: true, Technical: false }) || ((await state(win1)).Technical === false && (await state(win1)).YouTube === true && (await state(win1)).Google === true), 'selecting GitHub expands Technical, collapses the rest', JSON.stringify(await state(win1)));
  await activate(ytTabs[0].id); await settle();
  let st = await state(win1);
  r.expect(st.YouTube === false && st.Technical === true && st.Google === true, 'switching to YouTube expands YouTube and collapses Technical', JSON.stringify(st));
  await activate(ghTabs[0].id); await settle();
  st = await state(win1);
  r.expect(st.Technical === false && st.YouTube === true, 'switching back to GitHub expands Technical again', JSON.stringify(st));
  const stillThere = (await tabsOf(win1)).length;
  const beforeNames = JSON.stringify((await groupsOf(win1)).map((g) => [g.id, g.title, g.color, g.n]));

  await activate(pinnedTab); await settle();
  st = await state(win1);
  r.expect(Object.values(st).length >= 3 && Object.values(st).every((v) => v === true), 'selecting the pinned tab collapses every group in the window', JSON.stringify(st));
  r.expect((await tabsOf(win1)).length === stillThere && JSON.stringify((await groupsOf(win1)).map((g) => [g.id, g.title, g.color, g.n])) === beforeNames, 'no tab was closed; group names, colours, membership are unchanged');

  // a real keyboard shortcut for switching tabs (Ctrl+2 = the second tab in the strip)
  const strip = await tabsOf(win1);
  const second = strip.find((t) => t.index === 1);
  await activate(pinnedTab); await settle(500);
  r.expect(press('Ctrl+2').startsWith('SENT'), 'real Ctrl+2 pressed (Chrome\'s own "go to tab 2")');
  await settle(1500);
  const nowActive = (await tabsOf(win1)).find((t) => t.active);
  st = await state(win1);
  const secondGroup = (await groupsOf(win1)).find((g) => g.id === (second && second.groupId));
  r.expect(nowActive && second && nowActive.id === second.id, 'the keyboard shortcut moved to the second tab', `active ${nowActive && nowActive.url}`);
  r.expect(second.groupId === -1 ? Object.values(st).every((v) => v === true) : secondGroup && st[secondGroup.title] === false && Object.entries(st).filter(([k]) => k !== secondGroup.title).every(([, v]) => v === true), 'and the groups followed it', JSON.stringify(st));

  // rapid switching: the last selection wins
  await inSW(`Promise.all([${ghTabs[0].id}, ${ytTabs[0].id}, ${gmailTabs[0].id}, ${ghTabs[0].id}, ${ytTabs[0].id}].map((id, i) => new Promise(r => setTimeout(r, i * 15)).then(() => chrome.tabs.update(id, {active: true}))))`);
  await settle(2000);
  st = await state(win1);
  const lastActive = (await tabsOf(win1)).find((t) => t.active);
  r.expect(lastActive.id === ytTabs[0].id && st.YouTube === false && st.Technical === true && st.Google === true, 'rapid switching: the most recently selected tab wins', JSON.stringify(st));

  // background activity never collapses the group being read
  await activate(ghTabs[0].id); await settle();
  await inSW(`chrome.tabGroups.query({windowId: ${win1}}).then(gs => Promise.all(gs.filter(g => g.title === 'YouTube').map(g => chrome.tabGroups.update(g.id, {collapsed: false}))))`); // I peek into YouTube
  await sleep(300);
  const bgId = await mk(win1, web.site('www.youtube.com', '/watch?v=bg'));
  await inSW(`chrome.tabs.update(${bgId}, {url: ${JSON.stringify(web.site('docs.python.org', '/3/'))}})`);
  await mk(win1, web.site('wikipedia.org', '/'));
  await settle(2000);
  st = await state(win1);
  r.expect(st.Technical === false && st.YouTube === false, 'opening/navigating background tabs leaves the group I am reading open, and a group I opened by hand', JSON.stringify(st));
  r.expect((await tabsOf(win1)).find((t) => t.active).id === ghTabs[0].id, 'and I am still on the same tab');

  // selecting a result in the Tabfold search (opened in another window so this window's state is not disturbed)
  const win3 = await inSW(`chrome.windows.create({url: 'about:blank', focused: false}).then(w => w.id)`);
  await sleep(600);
  const pop3 = await openPopup(win3);
  await pop3.ev(`(() => { const q = document.getElementById('q'); q.value = 'youtube watch'; q.dispatchEvent(new Event('input', {bubbles: true})); })()`);
  const found = await pop3.ev(`document.querySelectorAll('#results .item').length`);
  await pop3.ev(`document.getElementById('q').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}))`);
  await settle(2000);
  const activeAfterSearch = (await tabsOf(win1)).find((t) => t.active);
  st = await state(win1);
  r.expect(found >= 1 && activeAfterSearch.id === ytTabs[0].id && st.YouTube === false && st.Technical === true, 'selecting a result in Tabfold search activates it and the groups follow (YouTube open, Technical collapsed)', JSON.stringify(st));

  // ================================================================== a second window keeps its own state
  console.log('\n--- second window ---');
  const win2 = await inSW(`chrome.windows.create({url: ${JSON.stringify(web.site('github.com', '/w2a'))}, focused: false, width: 800, height: 600}).then(w => w.id)`);
  await sleep(1200);
  const w2yt = await mk(win2, web.site('www.youtube.com', '/w2'));
  const w2gh = (await tabsOf(win2)).find((t) => /github\.com/.test(t.url));
  await sleep(1500);
  await activate(w2yt); await settle();
  const w2state = await state(win2);
  r.expect(w2state.YouTube === false && w2state.Technical === true, 'window 2 has its own groups and its own state', JSON.stringify(w2state));
  const w1before = JSON.stringify(await state(win1));
  await activate(ghTabs[0].id); await settle(); await activate(ytTabs[0].id); await settle(); await activate(pinnedTab); await settle();
  r.expect(JSON.stringify(await state(win2)) === JSON.stringify(w2state), 'selecting tabs in window 1 leaves window 2\'s groups exactly as they were', JSON.stringify(await state(win2)));
  const w1mid = JSON.stringify(await state(win1));
  await activate(w2gh.id); await settle();
  r.expect(JSON.stringify(await state(win1)) === w1mid, 'selecting a tab in window 2 leaves window 1 as it was', w1mid);
  const w2b = await state(win2);
  r.expect(w2b.Technical === false && w2b.YouTube === true, 'and window 2 follows its own selection', JSON.stringify(w2b));

  // ================================================================== the setting persists and can be switched off
  console.log('\n--- setting ---');
  pop = await openPopup(win3);
  r.expect(await pop.ev(`document.getElementById('collapseInactive').checked === true`), 'the popup shows Collapse inactive groups ON');
  await pop.ev(`document.getElementById('collapseInactive').click()`);
  await sleep(500);
  r.expect((await inSW(`chrome.storage.local.get('settings').then(r => r.settings.collapseInactive)`)) === false, 'switching it off is saved');
  await shot(pop.session, 'fix-3-toggles');
  await activate(ghTabs[0].id); await settle();
  await activate(ytTabs[0].id); await settle();
  const offState = await state(win1);
  await inSW(`chrome.storage.local.get('settings').then(r => chrome.storage.local.set({settings: {...r.settings, collapseInactive: true}}))`);
  await settle(1500);
  const onState = await state(win1);
  r.expect(Object.values(onState).filter((v) => v === false).length === 1, 'switching it back on collapses all but the group being read', JSON.stringify({ off: offState, on: onState }));
} catch (e) {
  r.fail('run aborted', e.stack || String(e));
} finally {
  await b.close();
  web.close();
}
process.exit(r.summary() ? 1 : 0);
