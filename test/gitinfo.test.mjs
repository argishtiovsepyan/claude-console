import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitInfo } from '../src/lib/gitinfo.mjs';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hud-git-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'develop');
  git('config', 'user.email', 't@t.test');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  return { dir, git };
}

test('clean repo: branch, no dirt, not a worktree', () => {
  const { dir } = makeRepo();
  const info = gitInfo(dir);
  assert.equal(info.branch, 'develop');
  assert.equal(info.dirtyCount, 0);
  assert.equal(info.isWorktree, false);
});

test('dirty repo counts modified and untracked files', () => {
  const { dir } = makeRepo();
  writeFileSync(join(dir, 'a.txt'), 'changed\n');
  writeFileSync(join(dir, 'new.txt'), 'new\n');
  const info = gitInfo(dir);
  assert.equal(info.dirtyCount, 2);
});

test('linked worktree is detected', () => {
  const { dir, git } = makeRepo();
  const wt = join(dir, '.wt', 'feature');
  mkdirSync(join(dir, '.wt'), { recursive: true });
  git('worktree', 'add', '-q', wt, '-b', 'feature-x');
  const info = gitInfo(wt);
  assert.equal(info.branch, 'feature-x');
  assert.equal(info.isWorktree, true);
});

test('detached HEAD falls back to short sha', () => {
  const { dir, git } = makeRepo();
  git('checkout', '-q', '--detach');
  const info = gitInfo(dir);
  assert.ok(/^[0-9a-f]{4,12}$/.test(info.branch), info.branch);
});

test('non-repo directory returns nulls without throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hud-nogit-'));
  const info = gitInfo(dir);
  assert.equal(info.branch, null);
  assert.equal(info.dirtyCount, null);
  assert.equal(info.isWorktree, false);
});

test('missing directory returns nulls without throwing', () => {
  const info = gitInfo('/nonexistent/path/xyz');
  assert.equal(info.branch, null);
});
