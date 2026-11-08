// Which launcher slot a new website should use, and what to tell the user about it. Pure functions.
//   launchers: { 'launch-02': { name, url } }            (from storage)
//   shortcuts: { 'launch-02': 'Ctrl+G' }                 (from chrome.commands.getAll(); '' or missing = unassigned)

import { ALL_COMMANDS, slotLabel } from './store.js';
import { displayHost } from './url.js';

/** Empty slot with no Chrome key first (cleanest), then an empty slot that still has a key, else '' (all 12 are in use). */
export function chooseSlot(launchers, shortcuts) {
  const empty = ALL_COMMANDS.filter((c) => !launchers[c]);
  return empty.find((c) => !shortcuts[c]) || empty[0] || '';
}

/** One <option> per slot for the form's slot picker. */
export function slotOptions(launchers, shortcuts) {
  return ALL_COMMANDS.map((command) => {
    const l = launchers[command];
    const key = shortcuts[command] || '';
    const state = l ? `${l.name} (replace)` : key ? `free, key ${key}` : 'free';
    return { command, used: Boolean(l), key, text: `${slotLabel(command)} — ${state}` };
  });
}

/** The sentence shown under the slot picker: it always names the key Chrome currently has on the slot, before saving. */
export function slotInfoText(command, launchers, shortcuts, { editing = false } = {}) {
  if (!command) return 'All 12 slots are in use. Choose one to replace, or cancel and edit an existing shortcut.';
  const l = launchers[command];
  const key = shortcuts[command] || '';
  if (editing) return key ? `Keeps its key: ${key}.` : 'No key is assigned in Chrome yet. Use Assign key after saving.';
  if (l) {
    const was = `${l.name} (${displayHost(l.url) || l.url})`;
    return key
      ? `This replaces ${was}. Chrome already has ${key} on this slot, so ${key} will open the new website.`
      : `This replaces ${was}. No key is assigned to this slot in Chrome.`;
  }
  return key
    ? `Chrome already has ${key} on this empty slot. As soon as you save, ${key} will open this website.`
    : 'No key is assigned to this slot yet. After saving, assign one in Chrome.';
}

/** Slots that have no website but still have a Chrome key: pressing it does nothing. */
export function unusedKeys(launchers, shortcuts) {
  return ALL_COMMANDS.filter((c) => !launchers[c] && shortcuts[c]).map((command) => ({ command, label: slotLabel(command), key: shortcuts[command] }));
}
