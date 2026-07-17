import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStatus } from '../src/lib/status.mjs';

const SAMPLE = readFileSync(new URL('./fixtures/stdin-sample.json', import.meta.url), 'utf8');

test('parses the full v2.1.206 stdin payload', () => {
  const s = parseStatus(SAMPLE);
  assert.equal(s.sessionId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(s.sessionName, 'Ship the payments dashboard');
  assert.equal(s.model.name, 'Fable 5');
  assert.equal(s.model.id, 'claude-fable-5');
  assert.equal(s.cwd, '/Users/dev/code/my-repo');
  assert.equal(s.repo.name, 'my-repo');
  assert.equal(s.context.usedPct, 12);
  assert.equal(s.context.size, 1000000);
  assert.equal(s.rateLimits.fiveHour.pct, 55.00000000000001);
  assert.equal(s.rateLimits.fiveHour.resetsAt, 1784259600);
  assert.equal(s.rateLimits.sevenDay.pct, 11);
  assert.equal(s.cost.durationMs, 9364000);
  assert.equal(s.effort, 'xhigh');
  assert.equal(s.version, '2.1.206');
});

test('tolerates a minimal payload', () => {
  const s = parseStatus('{"model":{"display_name":"Sonnet 5"}}');
  assert.equal(s.model.name, 'Sonnet 5');
  assert.equal(s.sessionId, null);
  assert.equal(s.context, null);
  assert.equal(s.rateLimits.fiveHour, null);
  assert.equal(s.rateLimits.sevenDay, null);
  assert.equal(s.repo, null);
  assert.equal(s.cost, null);
});

test('tolerates malformed JSON without throwing', () => {
  const s = parseStatus('{not json');
  assert.equal(s.ok, false);
  assert.equal(s.model.name, null);
});

test('tolerates empty input', () => {
  const s = parseStatus('');
  assert.equal(s.ok, false);
});

test('parses pr and git_worktree when present (binary-verified optional fields)', () => {
  const j = JSON.parse(SAMPLE);
  j.pr = { number: 6612, url: 'https://github.com/acme/my-repo/pull/6612', review_state: 'APPROVED' };
  j.workspace.git_worktree = 'gmail-native-tabs';
  const s = parseStatus(JSON.stringify(j));
  assert.equal(s.pr.number, 6612);
  assert.equal(s.pr.reviewState, 'APPROVED');
  assert.equal(s.gitWorktree, 'gmail-native-tabs');
});

test('pr and git_worktree default to null', () => {
  const s = parseStatus(SAMPLE);
  assert.equal(s.pr, null);
  assert.equal(s.gitWorktree, null);
});

test('tolerates unknown extra fields (forward compatibility)', () => {
  const j = JSON.parse(SAMPLE);
  j.rate_limits.extra_usage = { enabled: true, spend: 12 };
  j.some_future_field = { deep: [1, 2, 3] };
  const s = parseStatus(JSON.stringify(j));
  assert.equal(s.ok, true);
  assert.equal(s.rateLimits.fiveHour.pct, 55.00000000000001);
});
