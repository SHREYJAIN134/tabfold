# Tabfold

Open your websites with personal keyboard shortcuts, keep tabs in native Chrome tab groups automatically, and jump between tabs across all windows.

Plain Manifest V3, HTML, CSS and JavaScript. No npm, no build step, no API key, no backend, nothing loaded from the internet.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the folder that contains `manifest.json`: `C:\Users\SHREY JAIN\Desktop\ce\tabfold`

Pin Tabfold from the puzzle-piece menu if you want its icon on the toolbar.

## Use

**Open a site with a key.** `Ctrl+Y` opens YouTube in a new tab (Chrome assigns it when you install). To add your own:

1. Open Tabfold, go to **My shortcuts**, click **+ Add shortcut**.
2. Enter a name (`GitHub`) and an address (`github.com` is fine; `https://` is added).
3. Click **Save**, then **Assign key in Chrome** and choose a key for the launcher named in the message, for example **Tabfold launcher 02**.

Each row shows the key **Chrome reports for that exact launcher** (`chrome.commands.getAll()`), never the key you hoped for. A key Chrome reports is labelled **Assigned**; it becomes **✓ Verified** the first time Tabfold actually receives that command from Chrome (press the key on any page). The row also tells you which command to edit, for example: *For GitHub, edit “Tabfold launcher 02”*.

**Ctrl+G.** Chrome also uses it for Find Next. In testing (Chrome 156, Windows, real key presses) a Tabfold launcher did receive Ctrl+G once Chrome had assigned it to that launcher's command, and an unassigned Ctrl+G was left to Chrome. If Ctrl+G still runs Find Next for you, Chrome is not applying it to that launcher (look at chrome://extensions/shortcuts: the key must be on “Tabfold launcher 02”, not another launcher or another extension). Use **Alt+Shift+G** instead, assign it the same way, press it, and watch the row turn Verified.

**If the key is already used.** Chrome gives an assigned Tabfold launcher priority over Chrome's own shortcuts, except reserved ones (`Ctrl+T`, `Ctrl+W`, `Ctrl+N`, `Ctrl+Tab`, `Alt+F4` and a few more, which no extension can take). Tabfold cannot rebind Chrome's shortcuts or another extension's (Chrome offers no API for that), but it tells you what your key replaces and where that action lives now, e.g. “Ctrl+G is Tabfold's now: it takes priority over Chrome's Find Next. Find Next keeps working on F3.” The note appears while you type the key in the form and on the launcher's row. A key already held by another Tabfold launcher is named. Keys held by other extensions are visible only on chrome://extensions/shortcuts.

Chrome does not let an extension choose its own keys, so step 3 is always done in Chrome (`chrome://extensions/shortcuts`). Tabfold has 12 launcher slots with the same labels in both places, and shows the key **Chrome reports**, not the one you hoped for. If Chrome reserves a combination (or another extension already uses it) it simply stays unassigned: your website is still saved, so pick a different key. Editing a launcher keeps its key; deleting it makes the key do nothing until you put another website in that slot.

**Switch tabs.** `Alt+K` opens the switcher with search focused. Type part of a title or domain, `↑`/`↓` to choose, `Enter` to jump (other windows are brought forward). Filters: All, YouTube, Technical, Google, Others. One-click buttons open YouTube, GitHub and Google.

**Collapse inactive groups.** On by default (toggle at the top of the popup). Select a tab and its group opens while every other group **in the same window** collapses; select a pinned or ungrouped tab and all groups in that window collapse. It works however you change tabs (click, keyboard shortcut, Tabfold search, a launcher) and only ever changes whether a group is open: no tab is closed, and names, membership and order are untouched. Other windows keep their own state. Opening or updating a tab in the background never collapses the group you are reading.

**Tab groups.** Auto-group (toggle at the top of the popup) puts tabs in colour-coded groups per window: **YouTube** (red), **Technical** (blue: GitHub, GitLab, Stack Overflow, MDN, npm, localhost, developer docs), **Google** (yellow: Search, Gmail, Drive, Docs, Sheets, Calendar, Meet), **Others** (grey). Pinned tabs, blank tabs, Chrome pages and groups you made yourself are left alone. Tabs you drag out of a group stay out until they navigate to a different kind of site.

**Quick Switcher.** `Alt+Q` opens a small keyboard-only window listing Tabfold's groups (YouTube, Technical, Google, Others) with tab counts. Type to filter groups and tabs together (fuzzy, case-insensitive, matches title and URL); `Enter` on a group lists its tabs, `Enter` on a tab jumps to it (any window, restored if minimised); `Backspace` on an empty field goes back to the groups; `Esc` closes. `YouTube / python` searches straight inside a group. Pressing `Alt+Q` again closes it. Change the key at chrome://extensions/shortcuts ("Open the Tabfold Quick Switcher"). Chrome's own `Ctrl+Tab`, `Ctrl+Shift+Tab` and `Ctrl+1–9` are untouched.

## Permissions

| Permission | Why |
|---|---|
| `tabs` | read tab titles and addresses for search and grouping |
| `tabGroups` | create and name the groups |
| `storage` | remember your launchers and Auto-group choice on this device |

No host permissions, no content scripts, no network access. Your launchers stay in `chrome.storage.local`.

## Files

```
manifest.json     background.js     popup.html / popup.css / popup.js
lib/              url.js  categories.js  store.js  grouping.js  collapse.js  keys.js  search.js  slots.js
icons/            icon-16/32/48/128.png
tools/            validate.mjs (checks the folder)   make-icons.mjs (regenerates icons)
tests/            logic / background / collapse tests, e2e-chrome.mjs, e2e-fixes.mjs, send-keys.ps1  (development only)
```

## Checking it

```
node tools/validate.mjs                       manifest, assets, imports, syntax (92 checks)
node --test tests/logic.test.mjs tests/background.test.mjs tests/collapse.test.mjs     54 offline tests with a fake chrome
node tests/e2e-quick.mjs                       Quick Switcher in a real headless Chrome (20 checks)
node tests/e2e-chrome.mjs                     headless separate Chrome, temp profile: 71 behaviours (launching, grouping, switcher, shortcuts screen)
node tests/e2e-fixes.mjs                      headful separate Chrome with REAL key presses: Ctrl+G / Alt+Shift+G and collapsing groups (44 checks)
```

`e2e-chrome.mjs` runs headless and calls the launcher handler the way `chrome.commands.onCommand` does. `e2e-fixes.mjs` opens a visible throw-away Chrome window for about a minute and sends real OS key presses to it (`send-keys.ps1` refuses to type unless that window is in the foreground); it assigns keys through Chrome's own shortcut settings backend, since Chrome has no public API for that.

## Known limits

- Keys are assigned in Chrome, never by Tabfold (an API limit, not a missing feature).
- `Ctrl+Y` is Tabfold's suggested key for YouTube; if another extension already holds it Chrome leaves it unassigned. Pick another at `chrome://extensions/shortcuts`.
- Windows that are not normal browser windows (apps, popups) cannot hold tab groups, so they are skipped.
- Incognito windows are not covered unless you allow Tabfold in Incognito.
