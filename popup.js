// Tabfold popup: the tab switcher ("Tabs") and the launcher manager ("My shortcuts").
// Page titles and URLs are only ever put into the DOM with textContent / setAttribute, never as HTML.

import {
  SHORTCUTS_PAGE, ALL_COMMANDS, slotLabel, slotNumber, getLaunchers, saveLauncher, deleteLauncher,
  getSettings, setSetting, getPendingAssign, setPendingAssign, getVerified,
} from './lib/store.js';
import { bindingStatus, keyAdvice, otherCommandWithKey } from './lib/keys.js';
import { conflictNote } from './lib/chrome-keys.js';
import { slotLabel as labelOf } from './lib/store.js';
import { normalizeUrl, displayHost, isSafeLaunchUrl } from './lib/url.js';
import { CATEGORIES, filterCategory } from './lib/categories.js';
import { filterTabs, moveSelection, tabTitle } from './lib/search.js';
import { chooseSlot, slotOptions, slotInfoText, unusedKeys } from './lib/slots.js';

const $ = (id) => document.getElementById(id);

const state = {
  view: 'tabs',
  tabs: [], windows: [], currentWindowId: null,
  category: 'all', query: '', shown: [], selected: 0,
  launchers: {}, shortcuts: {}, verified: {}, editing: null, banner: null, confirmDelete: null,
};

/** Tiny element builder. Children are strings (as text) or nodes. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== undefined && c !== null) node.append(c);
  return node;
}
const announce = (message) => { $('live').textContent = ''; setTimeout(() => { $('live').textContent = message; }, 30); };
const openSettings = () => chrome.tabs.create({ url: SHORTCUTS_PAGE });

// =============================================================================================== data

async function loadTabs() {
  const [tabs, windows, current] = await Promise.all([
    chrome.tabs.query({ windowType: 'normal' }),
    chrome.windows.getAll({ windowTypes: ['normal'] }),
    chrome.windows.getCurrent().catch(() => null),
  ]);
  state.tabs = tabs;
  state.windows = windows.map((w) => w.id);
  state.currentWindowId = current ? current.id : null;
}

/** What Chrome reports for each launcher command. A key is "assigned" only if it shows up here. */
async function loadShortcuts() {
  const commands = await chrome.commands.getAll();
  const map = {};
  for (const c of commands) if (slotNumber(c.name)) map[c.name] = c.shortcut || '';
  state.shortcuts = map;
}

async function loadLaunchers() { state.launchers = await getLaunchers(); }
async function loadVerified() { state.verified = await getVerified(); }

// =============================================================================================== views

function setView(name, { focus = true } = {}) {
  state.view = name;
  const tabsView = name === 'tabs';
  $('view-tabs').hidden = !tabsView;
  $('view-shortcuts').hidden = tabsView;
  for (const [id, on] of [['tab-tabs', tabsView], ['tab-shortcuts', !tabsView]]) {
    $(id).setAttribute('aria-selected', String(on));
    $(id).tabIndex = on ? 0 : -1;
  }
  $('hints').hidden = !tabsView;
  $('count').hidden = !tabsView;
  if (!tabsView) renderShortcuts();
  if (focus) (tabsView ? $('q') : $('addTop')).focus();
}

// =============================================================================================== Tabs

function renderTabs() {
  state.shown = filterTabs(state.tabs, { query: state.query, category: state.category });
  if (state.selected >= state.shown.length) state.selected = Math.max(0, state.shown.length - 1);
  const list = $('results');
  list.textContent = '';

  state.shown.forEach((tab, i) => {
    const host = displayHost(tab.url);
    const cat = filterCategory(tab.url);
    const otherWindow = state.currentWindowId != null && tab.windowId !== state.currentWindowId;
    const windowNumber = state.windows.indexOf(tab.windowId) + 1;
    const fav = el('span', { class: 'fav', 'aria-hidden': 'true' });
    const letter = (host || tabTitle(tab)).charAt(0).toUpperCase();
    if (tab.favIconUrl && /^(https?:|data:image\/)/.test(tab.favIconUrl)) {
      const img = el('img', { src: tab.favIconUrl, alt: '', width: '16', height: '16' });
      img.addEventListener('error', () => { fav.textContent = letter; img.remove(); });
      fav.append(img);
    } else fav.textContent = letter;

    const badge = otherWindow
      ? el('span', { class: 'badge other', text: `Window ${windowNumber || '?'}`, title: 'This tab is in another Chrome window' })
      : tab.active ? el('span', { class: 'badge', text: 'Current' }) : null;

    const item = el('li', {
      class: 'item', role: 'option', id: `opt-${tab.id}`, 'aria-selected': String(i === state.selected),
      'aria-label': `${tabTitle(tab)}, ${host}, ${CATEGORIES[cat].title}${otherWindow ? `, in window ${windowNumber}` : ''}`,
    },
    fav,
    el('div', { class: 'meta' },
      el('div', { class: 'title', text: tabTitle(tab) }),
      el('div', { class: 'sub' }, el('i', { class: `dot ${cat}`, title: CATEGORIES[cat].title }), el('span', { class: 'host', text: host || tab.url || '' }))),
    badge);
    item.addEventListener('click', () => activate(tab));
    item.addEventListener('mousemove', () => { if (state.selected !== i) select(i, { scroll: false }); });
    list.append(item);
  });

  const empty = $('empty');
  empty.hidden = state.shown.length > 0;
  if (!state.shown.length) empty.textContent = state.query ? `No tabs match “${state.query}”.` : 'No tabs in this group.';
  $('count').textContent = `${state.shown.length} of ${state.tabs.length} tabs`;
  syncActiveDescendant();
}

function syncActiveDescendant() {
  const tab = state.shown[state.selected];
  if (tab) $('q').setAttribute('aria-activedescendant', `opt-${tab.id}`); else $('q').removeAttribute('aria-activedescendant');
}

function select(index, { scroll = true } = {}) {
  const items = $('results').children;
  if (items[state.selected]) items[state.selected].setAttribute('aria-selected', 'false');
  state.selected = index;
  const node = items[index];
  if (node) { node.setAttribute('aria-selected', 'true'); if (scroll) node.scrollIntoView({ block: 'nearest' }); }
  syncActiveDescendant();
}

/** Jump to the tab and bring its window forward. */
async function activate(tab) {
  if (!tab) return;
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch { /* the tab was closed meanwhile */ }
  window.close();
}

function setCategory(cat) {
  state.category = cat;
  for (const chip of document.querySelectorAll('.chip')) chip.setAttribute('aria-pressed', String(chip.dataset.cat === cat));
  state.selected = 0;
  renderTabs();
}

async function openUrl(url) {
  if (!isSafeLaunchUrl(url)) return;
  await chrome.tabs.create({ url, active: true });
  window.close();
}

// =============================================================================================== My shortcuts

function bannerFor(command, text, { assign = true } = {}) {
  state.banner = { command, text, assign };
}

function renderBanner() {
  const b = state.banner;
  $('banner').hidden = !b;
  if (!b) return;
  $('bannerText').textContent = b.text;
  $('bannerAssign').hidden = !b.assign;
}

/** The hint for a saved website that has no key yet: survives closing and reopening the popup. */
async function restorePendingBanner() {
  const command = await getPendingAssign();
  if (!command) return;
  const l = state.launchers[command];
  if (!l || state.shortcuts[command]) { await setPendingAssign(null); return; }
  let text = `${l.name} saved. In Chrome, assign a key to “${slotLabel(command)}”.`;
  const { assignVisited } = await chrome.storage.local.get('assignVisited');
  if (l.wantedKey && assignVisited === command) {
    text += ` Chrome has not assigned ${l.wantedKey}. It may be reserved by Chrome or used by another extension; choose a different combination.`;
  }
  if (!state.banner) bannerFor(command, text);
}

function renderShortcuts() {
  renderBanner();
  const list = $('launchers');
  list.textContent = '';
  const commands = ALL_COMMANDS.filter((c) => state.launchers[c]);

  if (!commands.length) {
    list.append(el('li', { class: 'none', text: 'No shortcuts yet. Add a website and give it a key.' }));
  }
  for (const command of commands) {
    const l = state.launchers[command];
    const key = state.shortcuts[command];
    const confirming = state.confirmDelete === command;
    const status = bindingStatus(key, state.verified[command]);
    const keyNode = key
      ? el('span', { class: 'keybox' },
        el('span', { class: 'key', text: key, title: 'The key Chrome reports for this launcher' }),
        el('span', {
          class: `chip-status ${status}`, text: status === 'verified' ? '✓ Verified' : 'Assigned',
          title: status === 'verified' ? 'Tabfold received this command from Chrome with this key' : 'Chrome reports this key. It becomes Verified the first time Tabfold receives it.',
        }))
      : el('button', { type: 'button', class: 'btn primary small', text: 'Assign key', title: 'Opens Chrome’s shortcuts page', onclick: () => assignInChrome(command) });

    const row = el('li', { class: 'row', 'data-command': command },
      el('div', {},
        el('div', { class: 'name', text: l.name }),
        el('div', { class: 'domain', text: displayHost(l.url) || l.url }),
        el('div', { class: 'slot', text: slotLabel(command) })),
      keyNode);
    if (l.wantedKey && !key) row.append(el('p', { class: 'wanted', text: `You planned ${l.wantedKey}, but Chrome has no key on this slot yet.` }));
    else if (l.wantedKey && key && key.replace(/\s/g, '').toLowerCase() !== l.wantedKey.replace(/\s/g, '').toLowerCase()) {
      row.append(el('p', { class: 'wanted', text: `You planned ${l.wantedKey}; Chrome has ${key}.` }));
    }
    const advice = keyAdvice(command, l, { shortcuts: state.shortcuts, verified: state.verified, launchers: state.launchers });
    row.append(el('ul', { class: 'advice', 'aria-label': `About the key for ${l.name}` }, ...advice.map((line) => el('li', { class: /is also Chrome|for itself|is assigned to|still runs/.test(line) ? 'warn' : '', text: line }))));
    row.append(el('div', { class: 'row-actions' },
      el('button', { type: 'button', class: 'btn small', text: 'Test', title: `Open ${l.name} now`, onclick: () => openUrl(l.url) }),
      el('button', { type: 'button', class: 'btn small', text: 'Edit', onclick: () => openForm(command) }),
      key ? el('button', { type: 'button', class: 'btn small', text: 'Change key', title: 'Opens Chrome’s shortcuts page', onclick: () => assignInChrome(command) }) : null,
      el('button', {
        type: 'button', class: `btn small danger${confirming ? ' confirm' : ''}`, text: confirming ? 'Confirm delete' : 'Delete',
        onclick: () => (confirming ? removeLauncher(command) : askDelete(command)),
      })));
    list.append(row);
  }

  const unused = unusedKeys(state.launchers, state.shortcuts);
  const ul = $('unused');
  ul.hidden = !unused.length;
  ul.textContent = '';
  for (const u of unused) {
    ul.append(el('li', {}, el('span', { text: `${u.label}: ${u.key} is still assigned in Chrome, but this slot is empty, so the key does nothing.` }),
      el('button', { type: 'button', class: 'btn small', text: 'Open Chrome', onclick: openSettings })));
  }
  $('slotsUsed').textContent = `${commands.length} of ${ALL_COMMANDS.length} slots used`;
}

function askDelete(command) {
  state.confirmDelete = command;
  renderShortcuts();
  setTimeout(() => { if (state.confirmDelete === command) { state.confirmDelete = null; if (state.view === 'shortcuts') renderShortcuts(); } }, 4000);
}

async function removeLauncher(command) {
  const l = state.launchers[command];
  state.confirmDelete = null;
  await deleteLauncher(command);
  if ((await getPendingAssign()) === command) await setPendingAssign(null);
  await loadLaunchers();
  await loadShortcuts();
  const key = state.shortcuts[command];
  bannerFor(command, key
    ? `${l.name} deleted. ${key} is still assigned to “${slotLabel(command)}” in Chrome, but it does nothing now. Add another website to this slot, or remove the key in Chrome.`
    : `${l.name} deleted. “${slotLabel(command)}” is free to use again.`, { assign: Boolean(key) });
  $('bannerAssign').textContent = 'Open Chrome shortcuts';
  announce(`${l.name} deleted`);
  renderShortcuts();
}

async function assignInChrome(command) {
  await chrome.storage.local.set({ assignVisited: command });
  await openSettings();
}

// ---- add / edit form
function fillSlotPicker(selected) {
  const select = $('fSlot');
  select.textContent = '';
  if (!state.editing && !chooseSlot(state.launchers, state.shortcuts)) select.append(el('option', { value: '', text: 'Choose a slot to replace…' }));
  for (const o of slotOptions(state.launchers, state.shortcuts)) select.append(el('option', { value: o.command, text: o.text }));
  select.value = selected || '';
}
/** Live note under "Key you plan to use": what Chrome does with that key, and whether a Tabfold launcher already holds it. */
function updateKeyConflict() {
  const key = $('fKey').value.trim();
  const slot = state.editing ? state.editing.command : $('fSlot').value;
  const notes = [];
  if (key) {
    const other = otherCommandWithKey(slot, key, state.shortcuts);
    if (other) {
      const l = state.launchers[other];
      notes.push(`${key} is currently on “${labelOf(other)}”${l ? ` (${l.name})` : ''}. A key can only trigger one thing, so move it in Chrome if you want it here.`);
    }
    const c = conflictNote(key, slot ? labelOf(slot) : 'this launcher');
    if (c) notes.push(c);
  }
  $('keyConflict').hidden = !notes.length;
  $('keyConflict').textContent = notes.join(' ');
}

function updateSlotInfo() {
  $('slotInfo').textContent = slotInfoText($('fSlot').value, state.launchers, state.shortcuts, { editing: Boolean(state.editing) });
}

function openForm(command) {
  state.editing = command ? { command } : null;
  const l = command ? state.launchers[command] : null;
  $('formTitle').textContent = l ? `Edit ${l.name}` : 'Add shortcut';
  $('fName').value = l ? l.name : '';
  $('fUrl').value = l ? l.url : '';
  $('fKey').value = l && l.wantedKey ? l.wantedKey : '';
  fillSlotPicker(command || chooseSlot(state.launchers, state.shortcuts));
  $('fSlot').disabled = Boolean(command);
  updateSlotInfo();
  updateKeyConflict();
  showFormError('');
  $('form').hidden = false;
  $('fSave').textContent = l ? 'Save changes' : 'Save';
  if (state.view !== 'shortcuts') setView('shortcuts', { focus: false });
  $('form').scrollIntoView({ block: 'nearest' });
  $('fName').focus();
}
function closeForm() {
  $('form').hidden = true;
  state.editing = null;
  showFormError('');
}
function showFormError(message) {
  $('formError').hidden = !message;
  $('formError').textContent = message;
}

async function submitForm(event) {
  event.preventDefault();
  const parsed = normalizeUrl($('fUrl').value);
  if (!parsed.ok) { showFormError(parsed.error); $('fUrl').focus(); return; }
  const command = state.editing ? state.editing.command : $('fSlot').value;
  if (!command) { showFormError('Choose a slot to replace.'); $('fSlot').focus(); return; }
  const name = $('fName').value.trim() || parsed.host.replace(/^www\./, '');
  const wantedKey = $('fKey').value.trim();
  const editing = Boolean(state.editing);

  await saveLauncher(command, { name, url: parsed.url, wantedKey });
  await loadLaunchers();
  await loadShortcuts(); // what Chrome says right now
  closeForm();

  const key = state.shortcuts[command];
  if (key) {
    await setPendingAssign(null);
    bannerFor(command, editing ? `${name} updated. It still opens with ${key}.` : `${name} saved. It opens with ${key}.`, { assign: false });
  } else {
    await setPendingAssign(command);
    const wanted = wantedKey ? ` You planned ${wantedKey}: type it on that page. If Chrome will not keep it, it is reserved or already used, so pick another.` : '';
    bannerFor(command, `${name} ${editing ? 'updated' : 'saved'}. In Chrome, assign a key to “${slotLabel(command)}”.${wanted}`);
  }
  $('bannerAssign').textContent = 'Assign key in Chrome';
  announce(`${name} saved`);
  renderShortcuts();
  $('banner').scrollIntoView({ block: 'nearest' });
}

// =============================================================================================== events

function wire() {
  // views
  for (const id of ['tab-tabs', 'tab-shortcuts']) {
    $(id).addEventListener('click', () => setView(id === 'tab-tabs' ? 'tabs' : 'shortcuts'));
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); setView(state.view === 'tabs' ? 'shortcuts' : 'tabs', { focus: false }); $(state.view === 'tabs' ? 'tab-tabs' : 'tab-shortcuts').focus(); }
    });
  }
  $('addTop').addEventListener('click', () => { setView('shortcuts', { focus: false }); openForm(null); });

  // switcher
  $('q').addEventListener('input', () => { state.query = $('q').value; state.selected = 0; renderTabs(); });
  $('q').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = moveSelection(state.selected, e.key === 'ArrowDown' ? 1 : -1, state.shown.length);
      if (next >= 0) select(next);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(state.shown[state.selected]);
    }
  });
  for (const chip of document.querySelectorAll('.chip')) chip.addEventListener('click', () => { setCategory(chip.dataset.cat); $('q').focus(); });
  for (const b of document.querySelectorAll('[data-open]')) b.addEventListener('click', () => openUrl(b.dataset.open));

  // shortcuts
  $('form').addEventListener('submit', submitForm);
  $('fCancel').addEventListener('click', closeForm);
  $('fSlot').addEventListener('change', () => { updateSlotInfo(); updateKeyConflict(); });
  $('fKey').addEventListener('input', updateKeyConflict);
  $('bannerAssign').addEventListener('click', () => (state.banner && state.banner.command ? assignInChrome(state.banner.command) : openSettings()));
  $('bannerDismiss').addEventListener('click', () => { state.banner = null; renderBanner(); });

  // settings
  $('autoGroup').addEventListener('change', async (e) => { await setSetting('autoGroup', e.target.checked); announce(`Auto-group ${e.target.checked ? 'on' : 'off'}`); });
  $('collapseInactive').addEventListener('change', async (e) => { await setSetting('collapseInactive', e.target.checked); announce(`Collapse inactive groups ${e.target.checked ? 'on' : 'off'}`); });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('form').hidden) { e.preventDefault(); closeForm(); return; }
    if (state.view === 'tabs' && $('q').value) { e.preventDefault(); $('q').value = ''; state.query = ''; state.selected = 0; renderTabs(); return; }
    window.close();
  });

  // coming back from chrome://extensions/shortcuts: show what Chrome reports now
  const refresh = async () => { await Promise.all([loadShortcuts(), loadVerified()]); if (state.view === 'shortcuts') renderShortcuts(); };
  if (chrome.commands.onChanged) chrome.commands.onChanged.addListener(refresh); // Chrome reports a key being assigned or changed
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.verified) refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('focus', refresh);
}

// =============================================================================================== start

async function init() {
  const [settings] = await Promise.all([getSettings(), loadTabs(), loadShortcuts(), loadLaunchers(), loadVerified()]);
  $('autoGroup').checked = settings.autoGroup;
  $('collapseInactive').checked = settings.collapseInactive;
  wire();
  renderTabs();
  await restorePendingBanner();
  $('q').focus();
}

init().catch((err) => {
  console.error('Tabfold failed to start', err);
  $('empty').hidden = false;
  $('empty').textContent = 'Tabfold could not load your tabs. Try reopening it.';
});
