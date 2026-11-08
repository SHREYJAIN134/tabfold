// Reasoning about the key combination a launcher has in Chrome. Pure functions: no Chrome APIs.
//
// Vocabulary used in the UI:
//   (none)    Chrome reports no key for the launcher's command.
//   Assigned  chrome.commands.getAll() reports a key for that exact command ID.
//   Verified  Tabfold's service worker actually RECEIVED that command from Chrome while it had that key.
// A key the user merely planned is never shown as either.

import { slotLabel } from './store.js';
import { normalizeKey, chromeKeyInfo, conflictNote } from './chrome-keys.js';

export { normalizeKey };
export const sameKey = (a, b) => Boolean(normalizeKey(a)) && normalizeKey(a) === normalizeKey(b);

/** Chrome's own "Find Next" (Windows/Linux Ctrl+G, macOS Command+G). */
export const isFindNextKey = (key) => ['ctrl+g', 'cmd+g'].includes(normalizeKey(key));
export const ALTERNATIVE_KEY = 'Alt+Shift+G';

/** 'none' | 'assigned' | 'verified' for one launcher. `verified` is { shortcut, at } recorded when the command was received. */
export function bindingStatus(shortcut, verified) {
  if (!shortcut) return 'none';
  return verified && sameKey(verified.shortcut, shortcut) ? 'verified' : 'assigned';
}

/** Another launcher command that currently holds `key`, or null. */
export function otherCommandWithKey(command, key, shortcuts) {
  if (!key) return null;
  return Object.keys(shortcuts).find((c) => c !== command && sameKey(shortcuts[c], key)) || null;
}

/**
 * The guidance shown under one launcher row, as plain sentences. It always names the exact Chrome command to edit.
 *   launcher: { name, wantedKey? }   shortcuts: { 'launch-02': 'Ctrl+G', ... }   launchers: all saved launchers
 */
export function keyAdvice(command, launcher, { shortcuts, verified, launchers = {} }) {
  const lines = [];
  const key = shortcuts[command] || '';
  const status = bindingStatus(key, verified && verified[command]);
  const label = slotLabel(command);

  if (!key) lines.push(`For ${launcher.name}, edit “${label}” in Chrome and choose a key.`);
  else lines.push(`To change the key for ${launcher.name}, edit “${label}” in Chrome.`);

  // A planned key that Chrome has put on a DIFFERENT launcher: the usual reason a key "does the wrong thing".
  if (launcher.wantedKey && !sameKey(launcher.wantedKey, key)) {
    const other = otherCommandWithKey(command, launcher.wantedKey, shortcuts);
    if (other) {
      const who = launchers[other] ? ` (${launchers[other].name})` : '';
      lines.push(`${launcher.wantedKey} is assigned to “${slotLabel(other)}”${who}, not to ${launcher.name}. Move it to “${label}” in Chrome.`);
    }
  }

  const keyInQuestion = key || launcher.wantedKey || '';
  // What the key REPLACES in Chrome and where that Chrome action lives now. Tabfold has priority over Chrome's built-in shortcuts
  // (except reserved keys, which no extension can take); Chrome gives extensions no way to rebind its own shortcuts, so this is a report.
  const info = chromeKeyInfo(keyInQuestion);
  if (info && info.kind === 'reserved') lines.push(conflictNote(keyInQuestion, label));
  else if (info && status === 'verified') lines.push(conflictNote(keyInQuestion, label, { holds: true }));
  else if (info) {
    lines.push(conflictNote(keyInQuestion, label));
    lines.push(`If pressing it still runs Chrome's ${info.action}, Chrome is not applying it to this launcher: check chrome://extensions/shortcuts, or assign ${ALTERNATIVE_KEY} instead and press it to test.`);
  }
  if (status === 'assigned') lines.push('Assigned means Chrome reports this key. It turns Verified the first time Tabfold actually receives it: press the key on any page.');
  return lines;
}
