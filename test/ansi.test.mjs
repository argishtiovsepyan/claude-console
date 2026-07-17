import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi, displayWidth, truncateDisplay, truncateMiddleDisplay, padEndDisplay, color, RESET } from '../src/lib/ansi.mjs';

test('a base char + VS16 (U+FE0F) is one width-2 emoji-presentation glyph', () => {
  assert.equal(displayWidth('❤️'), 2); // U+2764 U+FE0F — was miscounted as 1
  assert.equal(displayWidth('a❤️b'), 4);
  // truncation keeps the pair intact and never exceeds the width
  const t = truncateDisplay('❤️xxxxx', 3);
  assert.ok(displayWidth(t) <= 3, JSON.stringify(t));
});

test('truncateMiddleDisplay keeps head and tail around the ellipsis, within width', () => {
  assert.equal(truncateMiddleDisplay('abcdefghijklmnop', 9), 'abc…lmnop');
  assert.equal(truncateMiddleDisplay('abcdefghijklmnop', 9, { headMax: 2 }), 'ab…klmnop');
  assert.equal(displayWidth(truncateMiddleDisplay('/Users/dev/Desktop/X1/repo/.claude/worktrees/thing', 24)), 24);
  assert.ok(truncateMiddleDisplay('/Users/dev/very/long/path/tail-dir', 20).endsWith('tail-dir'));
  assert.equal(truncateMiddleDisplay('short', 20), 'short');
});

test('stripAnsi removes SGR sequences', () => {
  assert.equal(stripAnsi('\x1b[0;36mdevelop\x1b[0m'), 'develop');
});

test('displayWidth ignores ANSI codes', () => {
  assert.equal(displayWidth('\x1b[38;5;154m███\x1b[0m'), 3);
});

test('displayWidth counts plain ASCII', () => {
  assert.equal(displayWidth('5h: 44%'), 7);
});

test('displayWidth counts block elements as single width', () => {
  assert.equal(displayWidth('███░░░░'), 7);
});

test('displayWidth counts CJK and emoji as double width', () => {
  assert.equal(displayWidth('あ'), 2);
  assert.equal(displayWidth('🚀'), 2);
});

test('truncateDisplay returns string unchanged when it fits', () => {
  assert.equal(truncateDisplay('short', 10), 'short');
});

test('truncateDisplay cuts to width including ellipsis', () => {
  const out = truncateDisplay('hello world', 8);
  assert.equal(stripAnsi(out), 'hello w…');
  assert.equal(displayWidth(out), 8);
});

test('truncateDisplay uses ASCII ellipsis in ascii mode', () => {
  const out = truncateDisplay('hello world', 8, { ascii: true });
  assert.equal(out, 'hello w~');
  assert.ok(displayWidth(out) <= 8);
});

test('truncateDisplay never cuts inside an ANSI escape and ends with reset', () => {
  const s = `${color(36)}develop${RESET} | ${color(37)}Fable 5${RESET}`;
  const out = truncateDisplay(s, 10);
  assert.equal(displayWidth(out), 10);
  // no dangling escape introducer at the end
  assert.ok(!/\x1b\[[0-9;]*$/.test(out), JSON.stringify(out));
  assert.ok(out.endsWith(RESET) || !out.includes('\x1b'), JSON.stringify(out));
});

test('truncateDisplay never exceeds tiny widths, even below the ellipsis width', () => {
  assert.equal(truncateDisplay('hello', 0), '');
  const one = truncateDisplay('hello', 1);
  assert.ok(displayWidth(one) <= 1, JSON.stringify(one));
});

test('padEndDisplay pads to display width', () => {
  const s = `${color(36)}ab${RESET}`;
  const out = padEndDisplay(s, 5);
  assert.equal(displayWidth(out), 5);
});

test('color respects enabled=false', () => {
  assert.equal(color(36, false), '');
});
