import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitsFree, freeWithin, intersectIntervals, mergeIntervals, placeEarliest, subtractIntervals } from '../src/engine/index.ts';

const iv = (s: number, e: number) => ({ start: s, end: e });

test('merge / subtract / intersect', () => {
  assert.deepEqual(mergeIntervals([iv(5, 8), iv(1, 3), iv(2, 4), iv(8, 9), iv(10, 10)]), [iv(1, 4), iv(5, 9)]);
  assert.deepEqual(subtractIntervals([iv(0, 10)], [iv(2, 3), iv(5, 7)]), [iv(0, 2), iv(3, 5), iv(7, 10)]);
  assert.deepEqual(subtractIntervals([iv(0, 10)], [iv(-5, 20)]), []);
  assert.deepEqual(intersectIntervals([iv(0, 10), iv(20, 30)], [iv(5, 25)]), [iv(5, 10), iv(20, 25)]);
  assert.equal(freeWithin([iv(0, 10), iv(20, 30)], 5, 25), 10);
});

test('inputs are never mutated', () => {
  const a = [iv(5, 8), iv(1, 3)];
  mergeIntervals(a);
  assert.deepEqual(a, [iv(5, 8), iv(1, 3)]);
});

test('placeEarliest respects gaps, release and deadline', () => {
  const free = [iv(0, 30), iv(60, 120)];
  assert.equal(placeEarliest(free, -Infinity, 0, Infinity, 20), 0);
  assert.equal(placeEarliest(free, 15, 0, Infinity, 20), 60); // 15..35 would overrun the first gap
  assert.equal(placeEarliest(free, 0, 70, Infinity, 20), 70);
  assert.equal(placeEarliest(free, 0, 0, 70, 20), 0);
  assert.equal(placeEarliest(free, 20, 0, 70, 20), Infinity); // would have to start at 60 and end at 80 > 70
  assert.equal(placeEarliest(free, 0, 0, Infinity, 90), Infinity);
  assert.ok(fitsFree(free, 60, 60));
  assert.ok(!fitsFree(free, 25, 10));
});
