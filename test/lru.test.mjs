import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessSkill, accessSkillState } from '../dist/lru.js';

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

test('pending skills re-enter at index 10 while the active tail promotes to index 9', () => {
  const active = Object.freeze(paths(20));
  const pendingEviction = Object.freeze([newcomer, '/another/SKILL.md']);
  const state = Object.freeze({ active, pendingEviction });
  const promoted = accessSkillState(state, active[19], 20);
  assert.equal(promoted.active.indexOf(active[19]), 9);
  assert.deepEqual(promoted.pendingEviction, pendingEviction);
  const restored = accessSkillState(state, newcomer, 20);
  assert.equal(restored.active.indexOf(newcomer), 10);
  assert.equal(restored.active.length, 20);
  assert.deepEqual(restored.pendingEviction, ['/another/SKILL.md', active[19]]);
  assert.deepEqual(restored.active.filter((path) => path !== newcomer), active.slice(0, 19));
  assert.deepEqual(state, { active: paths(20), pendingEviction: [newcomer, '/another/SKILL.md'] });
  const again = accessSkillState(restored, newcomer, 20);
  assert.equal(again.active.indexOf(newcomer), 5);
  assert.deepEqual(again.pendingEviction, restored.pendingEviction);
});

test('new admissions move overflow to pending and repeated accesses keep collections disjoint', () => {
  let state = { active: paths(20), pendingEviction: [] };
  state = accessSkillState(state, newcomer, 20);
  assert.equal(state.active.indexOf(newcomer), 10);
  assert.deepEqual(state.pendingEviction, [paths(20)[19]]);
  const seen = new Set([...state.active, ...state.pendingEviction]);
  for (let i = 0; i < 40; i++) {
    const target = i % 2 ? `/new-${i}/SKILL.md` : state.pendingEviction[0];
    seen.add(target);
    state = accessSkillState(state, target, 20);
    assert.equal(state.active.length, 20);
    const combined = [...state.active, ...state.pendingEviction];
    assert.equal(new Set(combined).size, combined.length);
    assert.deepEqual(new Set(combined), seen);
  }
});

test('admission uses active length even below capacity and validates capacity', () => {
  const state = { active: paths(3), pendingEviction: [newcomer] };
  const restored = accessSkillState(state, newcomer, 20);
  assert.equal(restored.active.indexOf(newcomer), 1);
  assert.deepEqual(restored.pendingEviction, []);
  assert.deepEqual(accessSkillState({ active: [], pendingEviction: [] }, newcomer, 1), {
    active: [newcomer], pendingEviction: [],
  });
  for (const capacity of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => accessSkillState(state, newcomer, capacity), RangeError);
  }
});
