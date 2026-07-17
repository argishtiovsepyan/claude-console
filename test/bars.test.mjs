import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBar, barLevel } from '../src/lib/bars.mjs';

// Fill math must match the existing statusline-command.sh awk formula:
// filled = int(pct / 100 * width + 0.5), clamped to [0, width]

test('44% over width 7 fills 3 cells (parity with existing script)', () => {
  assert.equal(renderBar(44, 7), '███░░░░');
});

test('55% over width 7 fills 4 cells', () => {
  assert.equal(renderBar(55, 7), '████░░░');
});

test('12% over width 10 fills 1 cell', () => {
  assert.equal(renderBar(12, 10), '█░░░░░░░░░');
});

test('0% is empty, 100% is full', () => {
  assert.equal(renderBar(0, 7), '░░░░░░░');
  assert.equal(renderBar(100, 7), '███████');
});

test('clamps out-of-range percentages', () => {
  assert.equal(renderBar(130, 7), '███████');
  assert.equal(renderBar(-5, 7), '░░░░░░░');
});

test('ascii mode uses ASCII-only characters', () => {
  const out = renderBar(44, 7, { ascii: true });
  assert.equal(out, '###----');
  assert.ok(/^[\x20-\x7e]+$/.test(out));
});

test('barLevel matches existing script thresholds (>= boundaries, rounded first)', () => {
  assert.equal(barLevel(10, [70, 90]), 'low');
  assert.equal(barLevel(69.4, [70, 90]), 'low');
  assert.equal(barLevel(70, [70, 90]), 'mid');
  assert.equal(barLevel(89.4, [70, 90]), 'mid');
  assert.equal(barLevel(90, [70, 90]), 'high');
  assert.equal(barLevel(100, [70, 90]), 'high');
});

test('barLevel rounds like the existing script before comparing', () => {
  // script compares the awk-rounded integer: 89.6 -> 90 -> high
  assert.equal(barLevel(89.6, [70, 90]), 'high');
});
