import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, REDACTED } from '../src/lib/redact.mjs';

test('redact stays fast on adversarial input (no quadratic backtracking)', () => {
  const s = 'a'.repeat(20000); // long undelimited run — used to make the URL rule O(n^2)
  const t0 = process.hrtime.bigint();
  redact(s);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 50, `redact too slow (${ms.toFixed(1)}ms) — possible quadratic backtracking`);
});

// ---------- known token prefixes ----------

test('redacts Anthropic API keys', () => {
  const out = redact('curl -H "x-api-key: sk-ant-api03-AbCdEfGh1234567890AbCdEfGh1234567890AbCd"');
  assert.ok(!out.includes('sk-ant-api03'), out);
  assert.ok(out.includes(REDACTED), out);
});

test('redacts generic sk- style keys of 20+ chars', () => {
  const out = redact('OPENAI says sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12');
  assert.ok(!out.includes('sk-proj-Ab12'), out);
});

test('redacts GitHub classic and fine-grained tokens', () => {
  const a = redact('git remote set-url origin https://ghp_AbCdEf123456789012345678901234567890@github.com/x/y');
  assert.ok(!a.includes('ghp_AbCdEf'), a);
  const b = redact('export T=github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKLMNOPQRSTUV');
  assert.ok(!b.includes('github_pat_11'), b);
});

test('redacts Slack tokens', () => {
  // fake token, split so secret scanners don't flag the source file itself
  const fakeSlack = ['xoxb', '1234567890', '1234567890123', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-');
  const out = redact(`slack ${fakeSlack}`);
  assert.ok(!out.includes('xoxb-1234567890-'), out);
});

test('redacts AWS access key ids', () => {
  const out = redact('aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE');
  assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'), out);
});

test('redacts JWTs', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';
  const out = redact(`curl -H "Authorization: Bearer ${jwt}"`);
  assert.ok(!out.includes('eyJhbGciOiJIUzI1NiI'), out);
});

// ---------- key=value / flags / env / headers ----------

test('redacts sensitive key=value pairs but keeps the key visible', () => {
  const out = redact('mytool --mode fast password=hunter2 api_key=abc123');
  assert.ok(!out.includes('hunter2'), out);
  assert.ok(!out.includes('abc123'), out);
  assert.ok(out.includes('password='), out);
  assert.ok(out.includes('api_key='), out);
});

test('redacts sensitive long CLI flags with = and with space', () => {
  const a = redact('psql --password=supersecret1');
  assert.ok(!a.includes('supersecret1'), a);
  const b = redact('vault login --token s3cr3ttoken99');
  assert.ok(!b.includes('s3cr3ttoken99'), b);
});

test('redacts env-var assignments with sensitive names', () => {
  const out = redact('STRIPE_SECRET_KEY=sk_live_abc123 node server.js');
  assert.ok(!out.includes('sk_live_abc123'), out);
  assert.ok(out.includes('STRIPE_SECRET_KEY='), out);
});

test('redacts Authorization and Cookie header values', () => {
  const a = redact("curl -H 'Authorization: Bearer abc.def.ghi' https://x.test");
  assert.ok(!a.includes('abc.def.ghi'), a);
  const b = redact('curl -H "Cookie: session=deadbeefcafe1234" https://x.test');
  assert.ok(!b.includes('deadbeefcafe1234'), b);
});

test('redacts JSON-style sensitive fields', () => {
  const out = redact('{"apiKey": "zzz-secret-999", "name": "ok"}');
  assert.ok(!out.includes('zzz-secret-999'), out);
  assert.ok(out.includes('"name": "ok"'), out);
});

// ---------- URLs ----------

test('redacts URL userinfo passwords', () => {
  const out = redact('git clone https://argo:p4ssw0rd@github.com/x/y.git');
  assert.ok(!out.includes('p4ssw0rd'), out);
  assert.ok(out.includes('github.com/x/y.git'), out);
});

test('redacts sensitive URL query params', () => {
  const out = redact('curl "https://api.test/v1/data?access_token=abcd1234&limit=5"');
  assert.ok(!out.includes('abcd1234'), out);
  assert.ok(out.includes('limit=5'), out);
});

test('redacts colon-style (YAML/config) secrets', () => {
  const a = redact('password: hunter2xyz');
  assert.ok(!a.includes('hunter2xyz'), a);
  const b = redact('api_key: sup3rSecretValue');
  assert.ok(!b.includes('sup3rSecretValue'), b);
  const c = redact('client_secret:   quoted"');
  assert.ok(!c.includes('quoted'), c);
});

test('colon rule leaves prose with sensitive words but no key-colon shape alone', () => {
  const s = 'docs: add token counting guide';
  assert.equal(redact(s), s);
});

// ---------- entropy fallback ----------

test('redacts long high-entropy base64-like blobs', () => {
  const out = redact('auth blob QWxhZGRpbjpvcGVuIHNlc2FtZSBmb3IgbWUgbm93IQ==');
  assert.ok(!out.includes('QWxhZGRpbjpvcGVuIHNlc2FtZSBmb3IgbWUgbm93IQ=='), out);
});

test('redacts long single-case high-entropy blobs (lowercase hex, base32)', () => {
  const lowerHex = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934c'; // 48-char lowercase hex
  const a = redact(`x_internal_svc ${lowerHex}`);
  assert.ok(!a.includes(lowerHex), a);
  const base32 = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // 32-char upper base32
  const b = redact(`otp seed ${base32}`);
  assert.ok(!b.includes(base32), b);
});

test('redact stays fast on large dense-alphanumeric input (linearity guard)', () => {
  const big = Array.from({ length: 15000 }, (_, i) => `a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p${i}`).join(' ');
  const t0 = Date.now();
  redact(big);
  const ms = Date.now() - t0;
  assert.ok(ms < 500, `redact took ${ms}ms on ${big.length} chars`);
});

// ---------- must NOT redact ----------

test('keeps ordinary commands intact', () => {
  const s = 'npm run test --workspace @xavior/api && git status --porcelain';
  assert.equal(redact(s), s);
});

test('keeps 40-char git SHAs (hex is not a secret)', () => {
  const s = 'git checkout 0dea4043c1ec4365c155a9117afbdb7c84b2f527';
  assert.equal(redact(s), s);
});

test('keeps UUIDs', () => {
  const s = 'claude --resume aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  assert.equal(redact(s), s);
});

test('keeps prose containing the word token without a value', () => {
  const s = 'git commit -m "meter TTS character spend into tier budgets"';
  assert.equal(redact(s), s);
  const t = 'docs: add token counting guide';
  assert.equal(redact(t), t);
});

test('keeps file paths', () => {
  const s = 'ls /Users/dev/.claude/hud/state/sessions';
  assert.equal(redact(s), s);
});

// ---------- robustness ----------

test('is idempotent', () => {
  const s = 'password=hunter2 sk-ant-api03-AbCdEfGh1234567890AbCdEfGh12';
  assert.equal(redact(redact(s)), redact(s));
});

test('tolerates non-string input', () => {
  assert.equal(redact(null), '');
  assert.equal(redact(undefined), '');
  assert.equal(redact(42), '42');
});
