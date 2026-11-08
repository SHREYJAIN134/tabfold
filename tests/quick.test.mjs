import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGroups } from '../lib/quick.js';

let nextId = 1;
const tab = (title, url, extra = {}) => ({ id: nextId++, windowId: 1, index: 0, title, url, ...extra });

test('groups: always the four, in Tabfold order, with counts; empty groups kept', () => {
  const g = buildGroups([
    tab('a', 'https://www.youtube.com/watch?v=1'), tab('b', 'https://github.com/x'), tab('c', 'https://www.youtube.com/watch?v=2'),
    tab('Settings', 'chrome://settings/', { pinned: true }),
  ]);
  assert.deepEqual(g.map((x) => [x.title, x.count]), [['YouTube', 2], ['Technical', 1], ['Google', 0], ['Others', 1]]);
  assert.deepEqual(buildGroups([]).map((x) => x.count), [0, 0, 0, 0]);
  assert.deepEqual(buildGroups(undefined).map((x) => x.count), [0, 0, 0, 0]);
});

test('tabs keep browser order: window by window, left to right, whatever order Chrome returned them in', () => {
  const g = buildGroups([
    tab('w2-0', 'https://www.youtube.com/a', { windowId: 20, index: 0 }),
    tab('w1-2', 'https://www.youtube.com/b', { windowId: 10, index: 2 }),
    tab('w1-0', 'https://www.youtube.com/c', { windowId: 10, index: 0 }),
    tab('w2-1', 'https://www.youtube.com/d', { windowId: 20, index: 1 }),
  ], [10, 20]);
  assert.deepEqual(g[0].tabs.map((t) => t.title), ['w1-0', 'w1-2', 'w2-0', 'w2-1']);
});

test('duplicate titles stay separate entries', () => {
  const g = buildGroups([tab('Docs', 'https://docs.python.org/3/'), tab('Docs', 'https://developer.mozilla.org/docs')]);
  assert.equal(g[1].tabs.length, 2);
  assert.notEqual(g[1].tabs[0].id, g[1].tabs[1].id);
});

test('a very large group is returned whole (no cap)', () => {
  const many = Array.from({ length: 1000 }, (_, i) => tab(`V${i}`, `https://www.youtube.com/watch?v=${i}`, { index: i }));
  assert.equal(buildGroups(many)[0].count, 1000);
});
