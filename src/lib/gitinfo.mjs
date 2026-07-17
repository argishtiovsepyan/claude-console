// Git facts for the statusline and HUD. Uses --no-optional-locks so renders
// never take repo locks, and short timeouts so a wedged git can never stall
// a render toward Claude Code's 5s statusline kill.

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

function git(cwd, args, timeoutMs) {
  return execFileSync('git', ['-C', cwd, '--no-optional-locks', ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

export function gitInfo(cwd, { timeoutMs = 1500 } = {}) {
  const none = { branch: null, shortSha: null, dirtyCount: null, isWorktree: false };
  if (!cwd) return none;

  let branch;
  let shortSha = null;
  try {
    branch = git(cwd, ['branch', '--show-current'], timeoutMs);
    if (!branch) {
      shortSha = git(cwd, ['rev-parse', '--short', 'HEAD'], timeoutMs);
      branch = shortSha;
    }
  } catch {
    return none;
  }

  let dirtyCount = null;
  try {
    const out = git(cwd, ['status', '--porcelain'], timeoutMs);
    dirtyCount = out ? out.split('\n').filter(Boolean).length : 0;
  } catch {
    // fine — leave unknown
  }

  let isWorktree = false;
  try {
    const [gitDir, commonDir] = git(cwd, ['rev-parse', '--git-dir', '--git-common-dir'], timeoutMs).split('\n');
    if (gitDir && commonDir) isWorktree = resolve(cwd, gitDir) !== resolve(cwd, commonDir);
  } catch {
    // fine
  }

  return { branch: branch || null, shortSha, dirtyCount, isWorktree };
}
