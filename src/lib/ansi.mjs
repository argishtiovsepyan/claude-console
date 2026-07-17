// ANSI + display-width helpers. Width math must treat SGR sequences as
// zero-width and East-Asian wide / emoji code points as double-width so
// truncation never corrupts the terminal.

export const RESET = '\x1b[0m';

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function color(code, enabled = true) {
  return enabled ? `\x1b[${code}m` : '';
}

export function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

function codePointWidth(cp) {
  // zero-width: combining marks, ZWJ, variation selectors
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    cp === 0x200b ||
    cp === 0x200d ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  ) {
    return 0;
  }
  // wide: CJK, Hangul, fullwidth forms, emoji
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(s) {
  const chars = [...stripAnsi(s)];
  let w = 0;
  for (let i = 0; i < chars.length; i++) {
    // a base char followed by VS16 (U+FE0F) is one emoji-presentation glyph =
    // width 2, regardless of the base's own default width
    if (i + 1 < chars.length && chars[i + 1].codePointAt(0) === 0xfe0f) {
      w += 2;
      i++; // consume the VS16 (already zero-width on its own)
      continue;
    }
    w += codePointWidth(chars[i].codePointAt(0));
  }
  return w;
}

// Split into tokens preserving ANSI escapes as atomic units.
function tokenize(s) {
  const out = [];
  const str = String(s);
  let i = 0;
  while (i < str.length) {
    if (str[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(str.slice(i));
      if (m) {
        out.push({ ansi: true, text: m[0] });
        i += m[0].length;
        continue;
      }
    }
    const cp = str.codePointAt(i);
    let ch = String.fromCodePoint(cp);
    let width = codePointWidth(cp);
    // keep a base char and its trailing VS16 as ONE width-2 token so truncation
    // never splits the pair and the width matches displayWidth
    if (str.codePointAt(i + ch.length) === 0xfe0f) {
      ch += '️';
      width = 2;
    }
    out.push({ ansi: false, text: ch, width });
    i += ch.length;
  }
  return out;
}

export function truncateDisplay(s, maxWidth, { ascii = false, ellipsis } = {}) {
  const str = String(s);
  if (displayWidth(str) <= maxWidth) return str;
  const ell = ellipsis ?? (ascii ? '~' : '…');
  if (maxWidth < displayWidth(ell)) return '';
  const budget = Math.max(0, maxWidth - displayWidth(ell));
  let out = '';
  let used = 0;
  let sawAnsi = false;
  for (const t of tokenize(str)) {
    if (t.ansi) {
      out += t.text;
      sawAnsi = true;
      continue;
    }
    if (used + t.width > budget) break;
    out += t.text;
    used += t.width;
  }
  return out + ell + (sawAnsi ? RESET : '');
}

// Middle truncation for paths: keep the start, ALWAYS keep the tail,
// ellipsis between. Plain text only — paint after truncating.
export function truncateMiddleDisplay(s, maxWidth, { ascii = false, ellipsis, headMax: headOverride } = {}) {
  const str = String(s);
  if (displayWidth(str) <= maxWidth) return str;
  const ell = ellipsis ?? (ascii ? '~' : '…');
  const budget = maxWidth - displayWidth(ell);
  if (budget <= 0) return truncateDisplay(str, maxWidth, { ascii, ellipsis });
  // tail-weighted: for paths the trailing directories matter most; callers
  // can pin the head even shorter (e.g. just the root prefix)
  const headMax = Math.min(headOverride ?? Math.floor(budget * 0.4), budget - 1);
  const tailMax = budget - headMax;
  const toks = tokenize(str).filter((t) => !t.ansi);
  let head = '';
  let used = 0;
  for (const t of toks) {
    if (used + t.width > headMax) break;
    head += t.text;
    used += t.width;
  }
  let tail = '';
  let tused = 0;
  for (let i = toks.length - 1; i >= 0; i--) {
    if (tused + toks[i].width > tailMax) break;
    tail = toks[i].text + tail;
    tused += toks[i].width;
  }
  return head + ell + tail;
}

export function padEndDisplay(s, width) {
  const pad = width - displayWidth(s);
  return pad > 0 ? String(s) + ' '.repeat(pad) : String(s);
}
