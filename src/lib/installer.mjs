// Install / update / verify / rollback / uninstall / doctor for the HUD.
// Backup-first, idempotent, and fully reversible: the pre-install statusLine
// value is recorded once (original-statusline.json) and restored on
// uninstall; every settings.json touch writes a timestamped backup first.

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  rmSync,
  existsSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
  chmodSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { redact } from './redact.mjs';

const SHIM_MARKER = 'hud/bin/statusline.sh';

function paths(home) {
  const claudeDir = join(home, '.claude');
  const hudDir = join(claudeDir, 'hud');
  return {
    home,
    claudeDir,
    hudDir,
    appDir: join(hudDir, 'app'),
    binDir: join(hudDir, 'bin'),
    backupsDir: join(hudDir, 'backups'),
    stateDir: join(hudDir, 'state'),
    manifest: join(hudDir, 'manifest.json'),
    originalStatusline: join(hudDir, 'original-statusline.json'),
    settings: join(claudeDir, 'settings.json'),
    statuslineShim: join(hudDir, 'bin', 'statusline.sh'),
    hudShim: join(hudDir, 'bin', 'claude-console'),
    localBin: join(home, '.local', 'bin', 'claude-console'),
  };
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function listSourceFiles(srcRoot) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(srcRoot, rel), { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(relPath);
      else if (e.name.endsWith('.mjs')) out.push(relPath);
    }
  };
  walk('');
  return out.sort();
}

function readSettings(p) {
  try {
    return JSON.parse(readFileSync(p.settings, 'utf8'));
  } catch {
    return {};
  }
}

// Strict variant for anything that WRITES settings back: a present-but-corrupt
// settings.json must abort, never be silently replaced.
function readSettingsStrict(p) {
  if (!existsSync(p.settings)) return { ok: true, settings: {} };
  try {
    return { ok: true, settings: JSON.parse(readFileSync(p.settings, 'utf8')) };
  } catch {
    return { ok: false, settings: null };
  }
}

function writeSettingsAtomic(p, settings) {
  const tmp = `${p.settings}.hud-tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, p.settings);
}

function backupSettings(p, log) {
  mkdirSync(p.backupsDir, { recursive: true });
  if (!existsSync(p.settings)) return null;
  const dest = join(p.backupsDir, `settings.json.${Date.now()}-${randomBytes(3).toString('hex')}`);
  copyFileSync(p.settings, dest);
  chmodSync(dest, 0o600);
  log(`backed up settings.json -> ${dest}`);
  return dest;
}

const SHELL_PREAMBLE = `export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/bin:\${PATH:-}"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  for c in "$HOME/.nvm/versions/node/"*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$c" ] && NODE_BIN="$c"
  done
fi
`;

function writeShims(p) {
  mkdirSync(p.binDir, { recursive: true });
  writeFileSync(
    p.statuslineShim,
    `#!/usr/bin/env bash
# claude-console statusline shim — resolves node for GUI-launched shells, then
# delegates. Must never fail the render loop.
${SHELL_PREAMBLE}if [ -z "$NODE_BIN" ]; then printf 'claude-console: node not found\\n'; exit 0; fi
exec "$NODE_BIN" "$HOME/.claude/hud/app/statusline.mjs"
`
  );
  chmodSync(p.statuslineShim, 0o755);
  writeFileSync(
    p.hudShim,
    `#!/usr/bin/env bash
${SHELL_PREAMBLE}if [ -z "$NODE_BIN" ]; then echo 'claude-console: node >= 18 required' >&2; exit 1; fi
exec "$NODE_BIN" "$HOME/.claude/hud/app/cli.mjs" "$@"
`
  );
  chmodSync(p.hudShim, 0o755);
}

export function install({ home, log = console.log }) {
  const p = paths(home);
  const srcRoot = dirname(dirname(fileURLToPath(import.meta.url))); // .../src
  const changed = [];

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    log(`ERROR: node >= 18 required (found ${process.version})`);
    return 1;
  }

  // settings must be parseable BEFORE we change anything
  const strict = readSettingsStrict(p);
  if (!strict.ok) {
    log('ERROR: ~/.claude/settings.json exists but is not valid JSON — fix or remove it, then rerun install. Nothing was changed.');
    return 1;
  }

  mkdirSync(p.appDir, { recursive: true });
  mkdirSync(join(p.stateDir, 'sessions'), { recursive: true, mode: 0o700 });
  mkdirSync(p.backupsDir, { recursive: true, mode: 0o700 });

  const files = listSourceFiles(srcRoot);
  const manifest = { version: 1, installedAt: new Date().toISOString(), files: {} };
  for (const rel of files) {
    const dest = join(p.appDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(srcRoot, rel), dest);
    manifest.files[rel] = sha256(dest);
  }
  changed.push(`installed app -> ${p.appDir} (${files.length} files)`);

  writeShims(p);
  changed.push(`installed shims -> ${p.binDir}`);

  // settings.json: backup, record original statusLine once, point at shim
  backupSettings(p, log);
  const settings = strict.settings;
  const current = settings.statusLine;
  const isOurs = current?.command?.includes(SHIM_MARKER);
  if (!existsSync(p.originalStatusline) && !isOurs) {
    writeFileSync(p.originalStatusline, JSON.stringify({ statusLine: current ?? null }, null, 2) + '\n');
    changed.push(`recorded original statusLine -> ${p.originalStatusline}`);
  }
  // refreshInterval re-runs the statusline on a timer so STATUS (busy/idle),
  // agent ages and shell timers stay real-time even when the session is quiet.
  // 1s keeps the second-granularity timers ticking smoothly (renders are ~40ms)
  settings.statusLine = { type: 'command', command: `bash "$HOME/.claude/${SHIM_MARKER}"`, refreshInterval: 1 };
  writeSettingsAtomic(p, settings);
  changed.push('settings.json statusLine -> claude-console shim');
  writeFileSync(p.manifest, JSON.stringify(manifest, null, 2) + '\n');

  // expose claude-console on PATH if ~/.local/bin exists — but never delete
  // anything at that path we don't own
  const localBinDir = dirname(p.localBin);
  if (existsSync(localBinDir)) {
    let entryExists = false;
    let linkTarget = null;
    try {
      lstatSync(p.localBin);
      entryExists = true;
      linkTarget = readlinkSync(p.localBin); // throws if not a symlink
    } catch {
      // missing, or exists but is not a symlink (linkTarget stays null)
    }
    if (entryExists && (!linkTarget || !linkTarget.includes('.claude/hud'))) {
      changed.push(`NOTE: ${p.localBin} exists and is not claude-console's — left untouched; run via ${p.hudShim}`);
    } else {
      try {
        if (entryExists) rmSync(p.localBin);
        symlinkSync(p.hudShim, p.localBin);
        changed.push(`symlinked ${p.localBin} -> ${p.hudShim}`);
      } catch {
        changed.push(`NOTE: could not symlink into ${localBinDir}; run via ${p.hudShim}`);
      }
    }
  } else {
    changed.push(`NOTE: ${localBinDir} not found; run via ${p.hudShim}`);
  }

  log('claude-console installed.');
  for (const c of changed) log(`  - ${c}`);
  log('Commands: claude-console | --all | --watch | verify | doctor | rollback | uninstall');
  return 0;
}

export function verify({ home, log = console.log }) {
  const p = paths(home);
  let ok = true;
  const fail = (msg) => {
    ok = false;
    log(`FAIL ${msg}`);
  };

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(p.manifest, 'utf8'));
  } catch {
    fail('manifest.json missing or unreadable — is claude-console installed?');
    return 1;
  }
  for (const [rel, hash] of Object.entries(manifest.files)) {
    const f = join(p.appDir, rel);
    if (!existsSync(f)) fail(`missing app file: ${rel}`);
    else if (sha256(f) !== hash) fail(`checksum mismatch (tampered or partial update): ${rel}`);
  }

  const settings = readSettings(p);
  if (!settings.statusLine?.command?.includes(SHIM_MARKER)) {
    fail(`settings.json statusLine does not point at the shim (${JSON.stringify(settings.statusLine)})`);
  }

  const sample = JSON.stringify({ session_id: 'verify', model: { id: 'claude-fable-5', display_name: 'Fable 5' } });
  const res = spawnSync('bash', [p.statuslineShim], {
    input: sample,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, COLUMNS: '120', CLAUDE_HUD_NO_PS: '1' },
    timeout: 10_000,
  });
  if (res.status !== 0 || !res.stdout.includes('Fable 5')) {
    fail(`render test failed (exit ${res.status}): ${redact(String(res.stdout || res.stderr).slice(0, 200))}`);
  } else {
    log('PASS render test');
  }

  if (ok) {
    log(`PASS ${Object.keys(manifest.files).length} files verified, settings wired, render works`);
    return 0;
  }
  return 1;
}

export function rollback({ home, log = console.log }) {
  const p = paths(home);
  let backups = [];
  try {
    backups = readdirSync(p.backupsDir)
      .filter((f) => f.startsWith('settings.json.'))
      .sort();
  } catch {
    // none
  }
  if (!backups.length) {
    log('No settings backups found — nothing to roll back.');
    return 1;
  }
  const latest = join(p.backupsDir, backups[backups.length - 1]);
  let backup;
  try {
    backup = JSON.parse(readFileSync(latest, 'utf8'));
  } catch {
    log(`Backup ${latest} is not valid JSON — cannot roll back safely.`);
    return 1;
  }
  const strict = readSettingsStrict(p);
  if (strict.ok) {
    // surgical: restore ONLY statusLine from the backup and keep every other
    // key the user changed since (a full-file copy would silently drop them)
    const settings = strict.settings;
    if ('statusLine' in backup) settings.statusLine = backup.statusLine;
    else delete settings.statusLine;
    writeSettingsAtomic(p, settings);
    log(`Restored statusLine from ${latest} (your other settings were preserved)`);
  } else {
    // current settings.json is unreadable — restore the full known-good backup
    copyFileSync(latest, p.settings);
    log(`Restored full settings.json from ${latest} (the current file was invalid)`);
  }
  return 0;
}

export function uninstall({ home, purge = false, log = console.log }) {
  const p = paths(home);
  const strict = readSettingsStrict(p);
  if (!strict.ok) {
    log('ERROR: ~/.claude/settings.json is not valid JSON — fix it manually (a pristine backup is in ~/.claude/hud/backups). Nothing was changed.');
    return 1;
  }
  backupSettings(p, log);
  const settings = strict.settings;

  let original = null;
  try {
    original = JSON.parse(readFileSync(p.originalStatusline, 'utf8'));
  } catch {
    // never recorded — treat as "none existed"
  }
  if (original && original.statusLine) {
    settings.statusLine = original.statusLine;
    log(`Restored original statusLine: ${redact(JSON.stringify(original.statusLine))}`);
  } else {
    delete settings.statusLine;
    log('Removed statusLine (none existed before install).');
  }
  writeSettingsAtomic(p, settings);

  // clear the recorded original so a later reinstall re-baselines from whatever
  // statusLine exists at that time — a stale record would block re-capture
  try {
    rmSync(p.originalStatusline, { force: true });
  } catch {
    // best-effort
  }

  try {
    if (readlinkSync(p.localBin).includes('.claude/hud')) {
      rmSync(p.localBin);
      log(`Removed symlink ${p.localBin}`);
    }
  } catch {
    // no symlink
  }

  if (purge) {
    rmSync(p.hudDir, { recursive: true, force: true });
    log(`Purged ${p.hudDir}`);
  } else {
    log(`Kept ${p.hudDir} (state/backups). Use 'uninstall --purge' to remove everything.`);
  }
  return 0;
}

export function doctor({ home, log = console.log }) {
  const p = paths(home);
  log(`node          ${process.version}`);
  const settings = readSettings(p);
  const wired = settings.statusLine?.command?.includes(SHIM_MARKER);
  log(`settings.json statusLine ${wired ? 'points at claude-console shim (OK)' : `NOT wired: ${redact(JSON.stringify(settings.statusLine))}`}`);
  log(`hud dir       ${p.hudDir} ${existsSync(p.appDir) ? '(installed)' : '(NOT installed)'}`);

  try {
    const t0 = Date.now();
    execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 3000 });
    log(`ps scan       OK (${Date.now() - t0}ms)`);
  } catch {
    log('ps scan       FAILED — process counts unavailable');
  }
  try {
    execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 3000 });
    log('git           OK');
  } catch {
    log('git           NOT FOUND — branch/dirty info unavailable');
  }

  const sessionsDir = join(p.stateDir, 'sessions');
  let renders = [];
  try {
    renders = readdirSync(sessionsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(sessionsDir, f), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    // none
  }
  log(`state         ${renders.length} session state file(s)`);
  const times = renders.map((r) => r.renderMs).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (times.length) {
    const pct = (q) => times[Math.min(times.length - 1, Math.floor(q * times.length))].toFixed(1);
    log(`render time   p50 ${pct(0.5)}ms · p95 ${pct(0.95)}ms (last render per session)`);
  }
  const redactProbe = redact('x sk-ant-api03-abcdefghijklmnop1234 password=hunter2');
  log(`redaction     ${redactProbe.includes('sk-ant-api03') || redactProbe.includes('hunter2') ? 'FAILED' : 'OK'}`);
  try {
    const reg = readdirSync(join(p.claudeDir, 'sessions')).filter((f) => f.endsWith('.json')).length;
    log(`registry      ${reg} live-session file(s) in ~/.claude/sessions`);
  } catch {
    log('registry      ~/.claude/sessions not found');
  }
  return 0;
}
