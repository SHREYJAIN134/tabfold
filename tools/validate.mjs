// Checks that the extension folder is complete and consistent. Run from anywhere:  node tools/validate.mjs
// No dependencies. Exits 1 on any failure. (Development helper: Chrome itself does not need this file.)
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const bad = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : bad(msg));
const read = (p) => readFileSync(join(root, p), 'utf8');

console.log(`Validating ${root}`);

// ---------------------------------------------------------------- manifest
const manifestPath = join(root, 'manifest.json');
check(existsSync(manifestPath), 'manifest.json is directly inside the folder');
const m = JSON.parse(read('manifest.json'));
check(m.manifest_version === 3, 'Manifest V3');
check(m.name === 'Tabfold' && /^\d+(\.\d+){0,3}$/.test(m.version), `name "${m.name}", version ${m.version}`);
check(JSON.stringify([...m.permissions].sort()) === JSON.stringify(['storage', 'tabGroups', 'tabs']), `minimal permissions: ${m.permissions.join(', ')}`);
check(!m.host_permissions && !m.optional_host_permissions && !m.content_scripts && !m.web_accessible_resources, 'no host permissions, content scripts or web-accessible resources');
check(!/<all_urls>|\*:\/\//.test(JSON.stringify(m)), 'no broad URL patterns');
check(m.background && m.background.service_worker === 'background.js' && existsSync(join(root, 'background.js')), 'service worker file exists');
check(m.action && existsSync(join(root, m.action.default_popup)), `popup ${m.action && m.action.default_popup} exists`);

// ---------------------------------------------------------------- icons
function pngSize(file) {
  const b = readFileSync(file);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}
const iconFiles = new Set([...Object.values(m.icons || {}), ...Object.values((m.action && m.action.default_icon) || {})]);
for (const [size, file] of [...Object.entries(m.icons || {}), ...Object.entries((m.action && m.action.default_icon) || {})]) {
  const full = join(root, file);
  const dims = existsSync(full) ? pngSize(full) : null;
  check(dims && dims[0] === Number(size) && dims[1] === Number(size), `${file} exists and is a ${size}x${size} PNG`);
}
check(iconFiles.size >= 4, 'icons declared for 16, 32, 48 and 128');

// ---------------------------------------------------------------- commands
const cmds = m.commands || {};
const launch = Object.keys(cmds).filter((k) => k.startsWith('launch-')).sort();
check(launch.length === 12 && launch.every((k, i) => k === `launch-${String(i + 1).padStart(2, '0')}`), '12 launcher commands launch-01 ... launch-12');
check(launch.every((k) => cmds[k].description === `Tabfold launcher ${k.slice(-2)}`), 'every launcher is described as "Tabfold launcher NN" (the label shown in Chrome)');
check(cmds['launch-01'].suggested_key && cmds['launch-01'].suggested_key.windows === 'Ctrl+Y', 'launch-01 suggests Ctrl+Y on Windows');
check(launch.slice(1).every((k) => !cmds[k].suggested_key), 'launch-02 ... launch-12 are left unassigned');
check(cmds._execute_action && cmds._execute_action.suggested_key.default === 'Alt+K', 'Alt+K opens the popup (_execute_action)');
const suggested = Object.values(cmds).filter((c) => c.suggested_key).length;
check(suggested <= 4, `${suggested} suggested keys (Chrome honours at most 4)`);

// ---------------------------------------------------------------- html and relative imports
const html = read('popup.html');
for (const [, attr, ref] of html.matchAll(/(src|href)="([^"]+)"/g)) {
  if (/^(https?:)?\/\//.test(ref)) { bad(`popup.html loads a remote file: ${ref}`); continue; }
  check(existsSync(join(root, ref)), `popup.html ${attr}="${ref}" exists`);
}
check(!/<script(?![^>]*\bsrc=)[^>]*>[^<]/i.test(html), 'no inline scripts (extension pages forbid them)');

const jsFiles = [];
const walk = (dir) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (f === 'node_modules') continue; if (statSync(p).isDirectory()) walk(p); else if (/\.(js|mjs)$/.test(f)) jsFiles.push(p); } };
walk(root);
for (const file of jsFiles) {
  const src = readFileSync(file, 'utf8');
  for (const [, spec] of src.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    check(existsSync(resolve(dirname(file), spec)), `${relative(root, file)} imports ${spec}`);
  }
}

// ---------------------------------------------------------------- syntax
const tmp = mkdtempSync(join(tmpdir(), 'tabfold-check-'));
try {
  let n = 0;
  for (const file of jsFiles) {
    const copy = join(tmp, `${n++}.mjs`);
    writeFileSync(copy, readFileSync(file, 'utf8'));
    try { execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' }); ok(`syntax ${relative(root, file)}`); } catch (e) { bad(`syntax ${relative(root, file)}: ${String(e.stderr).split('\n').slice(0, 3).join(' ')}`); }
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }

// ---------------------------------------------------------------- the popup script only uses ids that exist
const popupJs = read('popup.js');
const used = new Set([...popupJs.matchAll(/\$\('([^']+)'\)/g)].map((x) => x[1]));
const defined = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((x) => x[1]));
for (const id of used) check(defined.has(id), `popup.js uses #${id}, present in popup.html`);
const css = read('popup.css');
check(!/@import|url\(\s*['"]?https?:/.test(css), 'popup.css loads nothing remote');
for (const f of ['lib/url.js', 'lib/categories.js', 'lib/store.js', 'lib/grouping.js', 'lib/collapse.js', 'lib/keys.js', 'lib/chrome-keys.js', 'lib/search.js', 'lib/slots.js']) check(existsSync(join(root, f)), `${f} exists`);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
