import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessSkill } from '../dist/lru.js';

const paths = (count) => Array.from({ length: count }, (_, i) => `/dynamic-skill/skills/skill-${i}/SKILL.md`);
const newcomer = '/dynamic-skill/skills/new/SKILL.md';

test('first access inserts halfway, rounding down, including empty and odd queues', () => {
  for (const length of [0, 1, 2, 3, 19, 20]) {
    const original = Object.freeze(paths(length));
    const result = accessSkill(original, newcomer);
    assert.equal(result.indexOf(newcomer), Math.floor(length / 2));
    assert.equal(result.length, length + 1);
    assert.deepEqual(result.filter((path) => path !== newcomer), original);
  }
});

test('new skill in a queue of 20 advances through indexes 10, 5, 2, 1, 0', () => {
  const original = paths(20);
  let order = original;
  for (const expected of [10, 5, 2, 1, 0, 0]) {
    order = accessSkill(order, newcomer);
    assert.equal(order.indexOf(newcomer), expected);
    assert.equal(order.length, 21);
    assert.deepEqual(order.filter((path) => path !== newcomer), original);
  }
});

test('existing tail in a queue of 20 advances through indexes 9, 4, 2, 1, 0', () => {
  const original = paths(20);
  const tail = original.at(-1);
  let order = original;
  for (const expected of [9, 4, 2, 1, 0, 0]) {
    order = accessSkill(order, tail);
    assert.equal(order.indexOf(tail), expected);
    assert.equal(order.length, 20);
    assert.deepEqual(order.filter((path) => path !== tail), original.slice(0, -1));
  }
});

test('access shifts only crossed entries and preserves the previous snapshot', () => {
  const original = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  const result = accessSkill(original, 'H');
  assert.deepEqual(result, ['A', 'B', 'C', 'H', 'D', 'E', 'F', 'G']);
  assert.deepEqual(original, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  assert.deepEqual(accessSkill(result, 'F'), ['A', 'B', 'C', 'F', 'H', 'D', 'E', 'G']);
});
