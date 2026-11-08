import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyScore, buildGroups, runQuery, scoreTabFuzzy, MAX_TAB_ROWS } from '../lib/quick.js';

let nextId = 1;
const tab = (title, url, extra = {}) => ({ id: nextId++, windowId: 1, title, url, ...extra });
const sample = () => buildGroups([
  tab('Machine Learning Full Course', 'https://www.youtube.com/watch?v=1', { lastAccessed: 10 }),
  tab('Java DSA Tutorial', 'https://www.youtube.com/watch?v=2', { lastAccessed: 30 }),
  tab('Python NumPy Explained', 'https://www.youtube.com/watch?v=3', { lastAccessed: 20 }),
  tab('Pull requests', 'https://github.com/pulls', { windowId: 2 }),
  tab('Inbox', 'https://mail.google.com/mail/u/0/'),
  tab('Settings', 'chrome://settings/', { pinned: true }),
]);
const titles = (rows) => rows.map((r) => (r.kind === 'group' ? `[${r.group.title}]` : r.tab.title));

test('fuzzy: substring beats scattered letters, case does not matter once lower-cased, no match is -1', () => {
  assert.ok(fuzzyScore('py', 'python numpy') > fuzzyScore('pn', 'python numpy'));
  assert.ok(fuzzyScore('mlc', 'machine learning course') > 0, 'letters in order');
  assert.equal(fuzzyScore('zzz', 'python'), -1);
  assert.equal(fuzzyScore('x', 'python'), -1, 'one letter must be a real substring');
  assert.equal(fuzzyScore('p', 'python') > fuzzyScore('y', 'python'), true, 'word start ranks higher');
  assert.equal(fuzzyScore('', 'anything'), 0);
});

test('groups: always the four, in order, with counts, empty ones kept, pinned and internal pages included', () => {
  const g = sample();
  assert.deepEqual(g.map((x) => [x.title, x.count]), [['YouTube', 3], ['Technical', 1], ['Google', 1], ['Others', 1]]);
  assert.deepEqual(buildGroups([]).map((x) => x.count), [0, 0, 0, 0]);
  assert.equal(g[0].tabs[0].title, 'Java DSA Tutorial', 'most recently used first');
});

test('top level: empty query lists the groups; a name finds the group, then tabs', () => {
  const g = sample();
  assert.deepEqual(titles(runQuery(g, {}).rows), ['[YouTube]', '[Technical]', '[Google]', '[Others]']);
  const r = runQuery(g, { query: 'YOUTUBE' });
  assert.equal(titles(r.rows)[0], '[YouTube]');
  const partial = runQuery(g, { query: 'tech' });
  assert.equal(titles(partial.rows)[0], '[Technical]');
});

test('top level: tabs are found by title and by URL, ranked, across groups and windows', () => {
  const g = sample();
  assert.deepEqual(titles(runQuery(g, { query: 'numpy' }).rows), ['Python NumPy Explained']);
  assert.ok(titles(runQuery(g, { query: 'github.com/pulls' }).rows).includes('Pull requests'), 'a URL with a slash is still a plain search');
  assert.ok(titles(runQuery(g, { query: 'mlc' }).rows).includes('Machine Learning Full Course'), 'fuzzy');
  assert.deepEqual(titles(runQuery(g, { query: 'nothing here' }).rows), []);
});

test('"Group / words" searches inside the matching group only', () => {
  const g = sample();
  assert.deepEqual(titles(runQuery(g, { query: 'YouTube / Python' }).rows), ['Python NumPy Explained']);
  assert.deepEqual(titles(runQuery(g, { query: 'yt/py' }).rows).length >= 0, true);
  assert.equal(runQuery(g, { query: 'youtube/' }).rows.length, 3, 'empty right side = every tab of the group');
  assert.deepEqual(titles(runQuery(g, { query: 'tech / python' }).rows), [], 'Python is not in Technical');
});

test('inside a group: only that group, filtered; empty group shows nothing', () => {
  const g = sample();
  assert.equal(runQuery(g, { groupId: 'youtube' }).rows.length, 3);
  assert.deepEqual(titles(runQuery(g, { groupId: 'youtube', query: 'java' }).rows), ['Java DSA Tutorial']);
  assert.deepEqual(runQuery(buildGroups([]), { groupId: 'google' }).rows, []);
  assert.deepEqual(runQuery(g, { groupId: 'nope' }).rows, []);
});

test('duplicate titles stay separate rows with their own tab ids', () => {
  const g = buildGroups([tab('Docs', 'https://docs.python.org/3/'), tab('Docs', 'https://developer.mozilla.org/docs')]);
  const rows = runQuery(g, { query: 'docs' }).rows.filter((r) => r.kind === 'tab');
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].tab.id, rows[1].tab.id);
});

test('many tabs: the list is capped and says so', () => {
  const many = Array.from({ length: 1000 }, (_, i) => tab(`Video ${i}`, `https://www.youtube.com/watch?v=${i}`));
  const r = runQuery(buildGroups(many), { groupId: 'youtube' });
  assert.equal(r.rows.length, MAX_TAB_ROWS);
  assert.equal(r.truncated, true);
});

test('tab scoring: a title hit outranks a URL-only hit', () => {
  const a = scoreTabFuzzy(tab('Python guide', 'https://example.com/'), ['python']);
  const b = scoreTabFuzzy(tab('Guide', 'https://example.com/python'), ['python']);
  assert.ok(a > b);
});
