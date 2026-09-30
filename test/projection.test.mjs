import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchorKey, descriptionBlock, projectDescriptions } from '../dist/projection.js';

const user = (content, timestamp = 1) => ({ role: 'user', content, timestamp });
const description = id => ({ role: 'custom', customType: 'dynamic-skill:context', content: `description ${id}`,
  display: false, timestamp: 0, details: { id, paths: [id], pendingPaths: [] } });

test('description stays at its original position as the request grows', () => {
  const a = user('a');
  const block = descriptionBlock([a], description('one'));
  const first = projectDescriptions([a], [block]);
  assert.deepEqual(projectDescriptions([a, user('b', 2)], [block]), [...first, user('b', 2)]);
  assert.deepEqual(projectDescriptions(first, [block]), first);
});

test('deleted anchors do not resurrect descriptions or dependent blocks', () => {
  const a = user('a');
  const first = descriptionBlock([a], description('one'));
  const second = descriptionBlock(projectDescriptions([a], [first]), description('two'));
  assert.deepEqual(projectDescriptions([user('replacement')], [first, second]), [user('replacement')]);
  assert.deepEqual(projectDescriptions([a], [first, second]), [a, description('one'), description('two')]);
});

test('shared anchors preserve creation order, including dependent descriptions and partial replay', () => {
  const a = user('a');
  const one = descriptionBlock([a], description('one'));
  const two = descriptionBlock([description('one')], description('two'));
  const three = descriptionBlock([a], description('three'));
  const blocks = [one, two, three];
  const expected = [a, description('one'), description('two'), description('three')];
  assert.deepEqual(projectDescriptions([a], blocks), expected);
  assert.deepEqual(projectDescriptions(expected.slice(0, 3), blocks), expected);
  assert.deepEqual(projectDescriptions(expected, blocks), expected);
});

test('ambiguous identical messages are not guessed by occurrence number', () => {
  const a = user('same');
  const unanchored = descriptionBlock([a, a], description('one'));
  assert.equal(unanchored.anchor, null);
  assert.deepEqual(projectDescriptions([a], [unanchored]), [a]);
  const block = descriptionBlock([a], description('one'));
  assert.deepEqual(projectDescriptions([a, a], [block]), [a, a]);
  assert.notEqual(anchorKey(a), anchorKey(user('same', 2)));
});

test('custom timestamp round trips preserve anchors and do not mutate saved blocks', () => {
  const a = description('existing');
  const block = descriptionBlock([a], description('new'));
  const input = [{ ...a, timestamp: 999 }];
  const projected = projectDescriptions(input, JSON.parse(JSON.stringify([block])));
  assert.equal(projected.length, 2);
  projected[1].details.paths.push('foreign');
  assert.deepEqual(block.message.details.paths, ['new']);
  assert.equal(input.length, 1);
});

test('identical marker text with different source metadata does not revive an old block', () => {
  const marker = source => ({ role: 'custom', customType: 'external-marker', content: 'same marker',
    display: false, timestamp: 0, details: { source } });
  const original = marker('old-source');
  const replacement = marker('new-source');
  const block = descriptionBlock([original], description('old-discovery'));
  assert.notEqual(anchorKey(original), anchorKey(replacement));
  assert.deepEqual(projectDescriptions([replacement], [block]), [replacement]);
});

test('raw anchors follow public entry identity, not identical replacement content', () => {
  const a = user('same');
  const key = anchorKey(a);
  const original = new Map([[key, 'entry-old']]);
  const block = descriptionBlock([a], description('one'), original);
  assert.equal(block.source, 'entry-old');
  assert.deepEqual(projectDescriptions([a], [block], original), [a, description('one')]);
  assert.deepEqual(projectDescriptions([a], [block], new Map([[key, 'entry-new']])), [a]);
  assert.deepEqual(projectDescriptions([a], [block], new Map()), [a]);
  const ambiguous = new Map([[key, null]]);
  assert.deepEqual(projectDescriptions([a], [block], ambiguous), [a]);
  assert.equal(descriptionBlock([a], description('two'), ambiguous).anchor, null);
});

test('a retained description suppresses replay even when its anchor is absent', () => {
  const a = user('a');
  const message = description('one');
  const block = descriptionBlock([a], message);
  assert.deepEqual(projectDescriptions([message], [block]), [message]);
  const unanchored = descriptionBlock([], message);
  assert.equal(unanchored.anchor, null);
  assert.deepEqual(projectDescriptions([], [unanchored]), []);
  assert.deepEqual(projectDescriptions([message], [unanchored]), [message]);
});
