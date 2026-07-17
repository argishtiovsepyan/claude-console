import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, loadConfig } from '../src/lib/config.mjs';

test('NO_COLOR disables color for any value, including empty string (spec)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hud-cfg-'));
  assert.equal(loadConfig(dir, { NO_COLOR: '' }).style.color, false);
  assert.equal(loadConfig(dir, { NO_COLOR: '1' }).style.color, false);
  assert.equal(loadConfig(dir, {}).style.color, true);
});

test('defaults preserve the legacy look and thresholds', () => {
  const c = defaultConfig();
  assert.equal(c.style.ascii, false);
  assert.equal(c.style.separator, ' | ');
  assert.deepEqual(c.thresholds.context, [50, 75]);
  assert.deepEqual(c.thresholds.usage, [70, 90]);
  assert.equal(c.barWidths.context, 10);
  assert.equal(c.barWidths.usage, 7);
  assert.equal(typeof c.sections, 'object');
  // HUD view defaults: skills + failures hidden (user preference)
  assert.equal(c.hud.sections.skills, false);
  assert.equal(c.hud.sections.failures, false);
});

test('missing config file yields defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hud-cfg-'));
  const c = loadConfig(dir, {});
  assert.deepEqual(c, defaultConfig());
});

test('partial user config deep-merges over defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hud-cfg-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ style: { ascii: true }, sections: { duration: false } }));
  const c = loadConfig(dir, {});
  assert.equal(c.style.ascii, true);
  assert.equal(c.style.separator, ' | '); // untouched default
  assert.equal(c.sections.duration, false);
});

test('invalid JSON config falls back to defaults without throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hud-cfg-'));
  writeFileSync(join(dir, 'config.json'), '{nope');
  const c = loadConfig(dir, {});
  assert.equal(c.style.ascii, false);
});

test('env overrides win: CLAUDE_HUD_ASCII and NO_COLOR', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hud-cfg-'));
  const c = loadConfig(dir, { CLAUDE_HUD_ASCII: '1', NO_COLOR: '1' });
  assert.equal(c.style.ascii, true);
  assert.equal(c.style.color, false);
});
