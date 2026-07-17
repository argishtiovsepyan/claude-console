// Central redaction for everything the HUD renders (process command lines,
// task labels, failure snippets). Deny-first: prefer over-redacting a benign
// value to ever leaking a secret. Every rule must keep redact() idempotent.

export const REDACTED = '[redacted]';

const SENSITIVE_NAME =
  '(?:password|passwd|pwd|secret|token|api[-_]?key|apikey|credential|access[-_]?key|private[-_]?key|client[-_]?secret|auth)';

const RULES = [
  // --- well-known token shapes ---
  { re: /\bsk-ant-[A-Za-z0-9_-]{10,}/g, sub: REDACTED },
  { re: /\bsk-[A-Za-z0-9_-]{20,}/g, sub: REDACTED },
  { re: /\bsk_(?:live|test)_[A-Za-z0-9]{6,}/g, sub: REDACTED },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, sub: REDACTED },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, sub: REDACTED },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, sub: REDACTED },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, sub: REDACTED },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, sub: REDACTED },
  { re: /\bya29\.[0-9A-Za-z_-]{20,}/g, sub: REDACTED },
  { re: /\bnpm_[A-Za-z0-9]{30,}\b/g, sub: REDACTED },
  { re: /\bglpat-[A-Za-z0-9_-]{15,}/g, sub: REDACTED },
  // JWT (three base64url segments)
  { re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, sub: REDACTED },

  // --- headers: keep the header name, drop the value ---
  {
    re: /((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*:\s*)([^"'\n]+)/gi,
    sub: `$1${REDACTED}`,
  },
  // generic "Bearer <token>" anywhere
  { re: /\b(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, sub: `$1${REDACTED}` },

  // --- URLs ---
  // userinfo password: scheme://user:pass@host. Length-bounded so backtracking
  // can't scale with input size (real schemes/hosts/userinfo are never huge) —
  // an unbounded run of word chars with no ':' was O(n^2) = a render-hang risk.
  { re: /(\w{1,32}:\/\/[^/\s:@]{1,256}):([^@\s/]{1,256})@/g, sub: `$1:${REDACTED}@` },
  // sensitive query params
  {
    re: /([?&](?:access_token|refresh_token|id_token|token|apikey|api_key|key|secret|password|signature|sig|auth|session)=)([^&\s"']+)/gi,
    sub: `$1${REDACTED}`,
  },

  // --- key=value (env assignments, CLI k=v) — keep the key visible ---
  {
    re: new RegExp(
      `\\b([A-Za-z0-9_.-]*${SENSITIVE_NAME}[A-Za-z0-9_.-]*)(=)(["']?)([^\\s"';&|]+)\\3`,
      'gi'
    ),
    sub: `$1$2$3${REDACTED}$3`,
  },
  // JSON-style: "apiKey": "value"
  {
    re: new RegExp(`("(?:[A-Za-z0-9_-]*${SENSITIVE_NAME}[A-Za-z0-9_-]*)"\\s*:\\s*)"([^"]*)"`, 'gi'),
    sub: `$1"${REDACTED}"`,
  },
  // long flags with a space-separated value: --token abc, --password abc
  {
    re: new RegExp(`(--?[A-Za-z0-9-]*${SENSITIVE_NAME}[A-Za-z0-9-]*[ ])(["']?)([^\\s"']+)\\2`, 'gi'),
    sub: `$1$2${REDACTED}$2`,
  },
  // colon-style (YAML/config) secrets: password: hunter2, api_key: value
  {
    re: new RegExp(
      `\\b([A-Za-z0-9_.-]*${SENSITIVE_NAME}[A-Za-z0-9_.-]*)(\\s*:\\s*)(["']?)([^\\s"',;&|]+)\\3`,
      'gi'
    ),
    sub: `$1$2$3${REDACTED}$3`,
  },
];

// Entropy fallback, executed as a single linear pass (a function replacer over
// maximal in-class runs — never per-position lookahead scanning, which was
// measurably quadratic). '/' deliberately excluded so file paths never match.
//   - mixed-class (upper+lower+digit) runs >= 32 -> secret-shaped
//   - single-case lower+digit runs >= 44 -> lowercase hex/base36 secrets
//     (full 40-char git SHA-1s stay visible)
//   - single-case upper+digit runs >= 32 -> base32-style secrets
function entropyRedact(s) {
  return s.replace(/[A-Za-z0-9+=_-]{32,}/g, (m) => {
    const hasUpper = /[A-Z]/.test(m);
    const hasLower = /[a-z]/.test(m);
    const hasDigit = /[0-9]/.test(m);
    if (!hasDigit) return m; // plain words / identifiers
    if (hasUpper && hasLower) return REDACTED;
    if (hasLower && m.length >= 44) return REDACTED;
    if (hasUpper && m.length >= 32) return REDACTED;
    return m; // short single-case runs (git SHA-1s, UUID segments) survive
  });
}

// Hard input cap: callers pre-cap their surfaces, but redact() itself must
// never be a hang vector regardless of caller discipline.
const MAX_INPUT = 10_000;

export function redact(input) {
  if (input === null || input === undefined) return '';
  let s = String(input);
  if (s.length > MAX_INPUT) s = s.slice(0, MAX_INPUT);
  for (const { re, sub } of RULES) s = s.replace(re, sub);
  return entropyRedact(s);
}
