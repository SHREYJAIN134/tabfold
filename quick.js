// Tabfold Quick Switcher (Alt+Q): a list of groups, then the tabs of a group, all from the keyboard. No search.
// Page titles and URLs are only ever put into the DOM with textContent / setAttribute, never as HTML.

import { displayHost } from './lib/url.js';
import { moveSelection, tabTitle } from './lib/search.js';
import { buildGroups } from './lib/quick.js';

const $ = (id) => document.getElementById(id);

const state = { tabs: [], windows: [], focusedWindowId: null, groups: [], groupId: null, selected: 0, selectedGroup: 0, selectedKey: null };

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== undefined && c !== null) node.append(c);
  return node;
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const announce = (message) => { $('live').textContent = ''; setTimeout(() => { $('live').textContent = message; }, 30); };
const currentGroup = () => (state.groupId ? state.groups.find((g) => g.id === state.groupId) : null);
const items = () => (currentGroup() ? currentGroup().tabs : state.groups);
const keyOf = (item) => (currentGroup() ? `t:${item.id}` : `g:${item.id}`);

// =============================================================================================== data

async function load() {
  const [tabs, windows, focused] = await Promise.all([
    chrome.tabs.query({ windowType: 'normal' }),
    chrome.windows.getAll({ windowTypes: ['normal'] }),
    chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null),
  ]);
  state.tabs = tabs;
  state.windows = windows.map((w) => w.id);
  state.focusedWindowId = focused ? focused.id : null;
  state.groups = buildGroups(tabs, state.windows);
}

/** Live update while open: re-reads Chrome and keeps the highlight on the same group/tab when it still exists. */
async function refresh() {
  await load();
  if (state.groupId && !currentGroup()) state.groupId = null;
  const list = items();
  const at = state.selectedKey ? list.findIndex((x) => keyOf(x) === state.selectedKey) : -1;
  state.selected = at >= 0 ? at : Math.min(state.selected, Math.max(0, list.length - 1));
  render();
}

// =============================================================================================== view

function render({ scroll = true } = {}) {
  const group = currentGroup();
  const list = items();
  if (state.selected >= list.length) state.selected = Math.max(0, list.length - 1);
  state.selectedKey = list[state.selected] ? keyOf(list[state.selected]) : null;

  $('back').hidden = !group;
  $('heading').textContent = group ? group.title : 'Tabfold — Quick Switcher';
  $('count').textContent = group ? plural(group.count, 'tab') : '';
  $('results').setAttribute('aria-label', group ? `${group.title} tabs` : 'Groups');
  $('hints').textContent = group
    ? '↑↓ select · Enter switch · ← Backspace back · Esc close'
    : '↑↓ select · Enter or → open · Esc close';

  const ul = $('results');
  ul.textContent = '';
  const frag = document.createDocumentFragment();
  list.forEach((item, i) => frag.append(group ? tabItem(item, i) : groupItem(item, i)));
  ul.append(frag);

  const empty = $('empty');
  empty.hidden = list.length > 0;
  if (!list.length) empty.textContent = group ? `No tabs in ${group.title}.` : 'No groups.';
  syncSelection({ scroll });
}

function groupItem(group, i) {
  const item = el('li', {
    class: `item group${group.count ? '' : ' empty-group'}`, role: 'option', id: `opt-${i}`, 'aria-selected': 'false',
    'aria-label': `${group.title}, ${plural(group.count, 'tab')}`,
  },
  el('span', { class: 'fav', 'aria-hidden': 'true' }, el('i', { class: `dot ${group.id}` })),
  el('div', { class: 'meta' }, el('div', { class: 'title', text: group.title })),
  el('span', { class: 'count-pill', text: plural(group.count, 'tab') }));
  item.addEventListener('click', () => { select(i, { scroll: false }); openGroup(); });
  item.addEventListener('mousemove', () => { if (state.selected !== i) select(i, { scroll: false }); });
  return item;
}

function tabItem(tab, i) {
  const host = displayHost(tab.url);
  const current = tab.active && tab.windowId === state.focusedWindowId;
  const fav = el('span', { class: 'fav', 'aria-hidden': 'true' });
  const letter = (host || tabTitle(tab)).charAt(0).toUpperCase();
  if (tab.favIconUrl && /^(https?:|data:image\/)/.test(tab.favIconUrl)) {
    const img = el('img', { src: tab.favIconUrl, alt: '', width: '16', height: '16' });
    img.addEventListener('error', () => { fav.textContent = letter; img.remove(); });
    fav.append(img);
  } else fav.textContent = letter;

  const badges = el('span', { class: 'badges' });
  if (tab.pinned) badges.append(el('span', { class: 'badge', text: 'Pinned' }));
  if (state.windows.length > 1) badges.append(el('span', { class: 'badge other', text: `Window ${state.windows.indexOf(tab.windowId) + 1 || '?'}`, title: 'Which Chrome window this tab is in' }));

  const item = el('li', {
    class: `item${current ? ' current' : ''}`, role: 'option', id: `opt-${i}`, 'aria-selected': 'false',
    'aria-label': `${tabTitle(tab)}, ${host}${current ? ', current tab' : ''}`,
  },
  fav,
  el('div', { class: 'meta' }, el('div', { class: 'title', text: tabTitle(tab), title: tabTitle(tab) }), el('div', { class: 'sub' }, el('span', { class: 'host', text: host || tab.url || '' }))),
  badges);
  item.addEventListener('click', () => { select(i, { scroll: false }); activate(tab); });
  item.addEventListener('mousemove', () => { if (state.selected !== i) select(i, { scroll: false }); });
  return item;
}

function syncSelection({ scroll = true } = {}) {
  const nodes = $('results').querySelectorAll('.item');
  nodes.forEach((node, i) => node.setAttribute('aria-selected', String(i === state.selected)));
  const node = nodes[state.selected];
  if (node) {
    if (scroll) node.scrollIntoView({ block: 'nearest' });
    $('results').setAttribute('aria-activedescendant', node.id);
  } else $('results').removeAttribute('aria-activedescendant');
}

function select(index, { scroll = true } = {}) {
  state.selected = index;
  const item = items()[index];
  state.selectedKey = item ? keyOf(item) : null;
  syncSelection({ scroll });
}

// =============================================================================================== actions

/** Opens the highlighted group. The highlight starts on the tab you are on, if it is in this group. */
function openGroup() {
  if (currentGroup()) return;
  const group = state.groups[state.selected];
  if (!group) return;
  state.selectedGroup = state.selected;
  state.groupId = group.id;
  const here = group.tabs.findIndex((t) => t.active && t.windowId === state.focusedWindowId);
  state.selected = Math.max(0, here);
  render();
  announce(`${group.title}, ${plural(group.count, 'tab')}`);
}

/** Back to the group list with the group you came from still highlighted. */
function leaveGroup() {
  if (!currentGroup()) return;
  state.groupId = null;
  state.selected = state.selectedGroup;
  render();
}

/** Switches to the tab and brings its window forward (restoring it if minimised). A tab closed in the meantime just disappears from the list. */
async function activate(tab) {
  if (!tab) return;
  try {
    await chrome.tabs.update(tab.id, { active: true });
    const win = await chrome.windows.get(tab.windowId);
    await chrome.windows.update(tab.windowId, win.state === 'minimized' ? { focused: true, state: 'normal' } : { focused: true });
  } catch {
    announce('That tab was closed.');
    await refresh();
    return;
  }
  window.close();
}

// =============================================================================================== events

function onKey(e) {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const list = items();
  switch (e.key) {
    case 'ArrowDown': case 'ArrowUp': {
      e.preventDefault();
      const next = moveSelection(state.selected, e.key === 'ArrowDown' ? 1 : -1, list.length);
      if (next >= 0) select(next);
      break;
    }
    case 'Enter':
      e.preventDefault();
      if (currentGroup()) activate(list[state.selected]); else openGroup();
      break;
    case 'ArrowRight': if (!currentGroup()) { e.preventDefault(); openGroup(); } break;
    case 'ArrowLeft': case 'Backspace': if (currentGroup()) { e.preventDefault(); leaveGroup(); } break;
    case 'Escape': e.preventDefault(); window.close(); break;
    default:
  }
}

function wire() {
  document.addEventListener('keydown', onKey);
  $('back').addEventListener('click', leaveGroup);

  // Keep the lists current while the switcher is open (nothing listens when it is closed).
  let timer = null;
  const soon = () => { clearTimeout(timer); timer = setTimeout(() => refresh().catch(() => {}), 120); };
  chrome.tabs.onCreated.addListener(soon);
  chrome.tabs.onRemoved.addListener(soon);
  chrome.tabs.onMoved.addListener(soon);
  chrome.tabs.onAttached.addListener(soon);
  chrome.tabs.onDetached.addListener(soon);
  chrome.tabs.onActivated.addListener(soon);
  chrome.tabs.onUpdated.addListener((id, change) => { if (change.title !== undefined || change.url !== undefined || change.pinned !== undefined || change.favIconUrl !== undefined) soon(); });
  chrome.windows.onRemoved.addListener(soon);

  // Close when the person clicks away, like any quick switcher (not before it has been focused once).
  let wasFocused = document.hasFocus();
  window.addEventListener('focus', () => { wasFocused = true; });
  window.addEventListener('blur', () => { if (wasFocused) setTimeout(() => { if (!document.hasFocus()) window.close(); }, 150); });
}

load().then(() => {
  wire();
  render();
  $('results').focus();
}).catch((err) => {
  console.error('Tabfold Quick Switcher failed to start', err);
  $('empty').hidden = false;
  $('empty').textContent = 'Tabfold could not load your tabs. Try again.';
});
