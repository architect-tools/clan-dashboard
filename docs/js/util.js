// util.js — DOM helpers, formatting, and hangul-aware fuzzy name matching.

// ── DOM ────────────────────────────────────────────────────────────
/** el('div.card#x', {onclick}, [children|string]) → HTMLElement */
export function el(tag, attrs = {}, children = []) {
  const m = tag.match(/^([a-z0-9]+)?(#[\w-]+)?((?:\.[\w-]+)*)$/i) || [];
  const node = document.createElement(m[1] || 'div');
  if (m[2]) node.id = m[2].slice(1);
  if (m[3]) node.className = m[3].split('.').filter(Boolean).join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className += ' ' + v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) node.style.setProperty(sk, sv); // custom props need setProperty
        else node.style[sk] = sv;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number'
      ? document.createTextNode(String(c)) : c);
  }
  return node;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

// ── formatting ─────────────────────────────────────────────────────
export const fmt = (n) => (n == null || isNaN(n)) ? '0' : Math.round(n).toLocaleString('ko-KR');
export const pct = (n, d = 1) => (n * 100).toFixed(d) + '%';
export function debounce(fn, ms = 200) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export function uid() {
  return 'id' + Math.abs(Date.now() ^ ((performance.now() * 1000) | 0)).toString(36)
    + Math.floor(performance.now() % 1000).toString(36);
}

// ── hangul decomposition & fuzzy matching ──────────────────────────
const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const JUNG = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
const JONG = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];

/** Decompose a hangul string into a jamo sequence for finer-grained distance. */
export function toJamo(str) {
  let out = '';
  for (const ch of String(str)) {
    const code = ch.charCodeAt(0) - 0xac00;
    if (code >= 0 && code <= 11171) {
      out += CHO[Math.floor(code / 588)] + JUNG[Math.floor((code % 588) / 28)] + JONG[code % 28];
    } else out += ch;
  }
  return out;
}

/** Normalize a name for comparison: strip spaces, symbols, lowercase. */
export function normName(s) {
  return String(s || '')
    .replace(/[\s　]/g, '')
    .replace(/[^0-9a-z가-힣ㄱ-ㅣ]/gi, '')
    .toLowerCase();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/** 0..1 similarity combining raw + jamo-level edit distance. */
// Fold digits to their look-alike letters — OCR commonly reads s하울s as "5하울5",
// VISVIM as "V15V1M", etc. Applied to both sides so it only ever helps.
const CONFUSE = { '0': 'o', '1': 'l', '2': 'z', '3': 'e', '4': 'a', '5': 's', '6': 'b', '7': 't', '8': 'b', '9': 'g' };
function fold(s) { return s.replace(/[0-9]/g, (d) => CONFUSE[d]); }

function simCore(na, nb) {
  if (na === nb) return 1;
  const raw = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
  const ja = toJamo(na), jb = toJamo(nb);
  const jam = 1 - levenshtein(ja, jb) / Math.max(ja.length, jb.length);
  let sim = raw * 0.45 + jam * 0.55;
  // Substring bonus, scaled by coverage so that e.g. "싸다"⊂"아싸다" does NOT
  // beat the exact "아싸다" match (avoids cross-assigning similar nicknames).
  if (na.includes(nb) || nb.includes(na)) {
    const minL = Math.min(na.length, nb.length), maxL = Math.max(na.length, nb.length);
    sim = Math.max(sim, 0.55 + 0.4 * (minL / maxL));
  }
  return Math.max(0, Math.min(1, sim));
}

export function similarity(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return 0;
  let sim = simCore(na, nb);
  const fa = fold(na), fb = fold(nb);
  if (fa !== na || fb !== nb) sim = Math.max(sim, simCore(fa, fb) * 0.98); // tiny penalty so exact wins ties
  return sim;
}

/**
 * Match an OCR'd token against a roster.
 * @param {string} token raw OCR text line
 * @param {Array<{name:string}>} roster
 * @param {number} threshold min similarity (default 0.62)
 * @returns {{member, score}|null}
 */
export function matchName(token, roster, threshold = 0.62) {
  let best = null, bestScore = 0;
  for (const m of roster) {
    const s = similarity(token, m.name);
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return best && bestScore >= threshold ? { member: best, score: bestScore } : null;
}

// ── misc ───────────────────────────────────────────────────────────
export function downloadFile(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function toast(msg, kind = 'info') {
  let host = $('#toast-host');
  if (!host) { host = el('div#toast-host'); document.body.appendChild(host); }
  const t = el(`div.toast.toast-${kind}`, { text: msg });
  host.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3000);
}
