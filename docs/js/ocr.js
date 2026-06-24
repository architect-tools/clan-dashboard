// ocr.js — screenshot → text lines → roster matches.
// Engine: Tesseract.js (kor+eng, sparse-text mode) loaded lazily from CDN.
// Matching is against the known roster, so even imperfect OCR is recovered by
// fuzzy hangul matching + the admin's review step.
import { matchName, normName, similarity } from './util.js';

const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const MAX_SIDE = 5200;     // cap upscaled canvas to keep memory sane
const SCALE = 3.5;         // default upscale factor (small game-UI text needs enlarging)
const TARGET_CELL_H = 96;  // slot mode: normalize each cell to ~this text height
                           // (resolution-independent — no fixed-pixel assumptions)

/** Load a File/Blob into an HTMLImageElement. */
export function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { res(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    img.onerror = (e) => { URL.revokeObjectURL(url); rej(e); };
    img.src = url;
  });
}

/**
 * Preprocess for OCR: optional crop → grayscale → min/max contrast normalize → upscale.
 * @param {HTMLImageElement} img
 * @param {{x,y,w,h}|null} crop in source-image pixels
 * @returns {{dataUrl:string, canvas:HTMLCanvasElement}}
 */
export function preprocess(img, crop = null, scaleHint = SCALE, { invert = false } = {}) {
  const sx = crop ? Math.max(0, crop.x) : 0;
  const sy = crop ? Math.max(0, crop.y) : 0;
  const sw = crop ? Math.min(crop.w, img.width - sx) : img.width;
  const sh = crop ? Math.min(crop.h, img.height - sy) : img.height;
  const scale = Math.max(1, Math.min(scaleHint, MAX_SIDE / Math.max(sw, sh)));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(sw * scale));
  cv.height = Math.max(1, Math.round(sh * scale));
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);

  // grayscale + contrast stretch (min/max normalize on luminance)
  const im = ctx.getImageData(0, 0, cv.width, cv.height);
  const p = im.data;
  let min = 255, max = 0;
  const gray = new Uint8Array(p.length / 4);
  for (let i = 0, j = 0; i < p.length; i += 4, j++) {
    const g = (p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114) | 0;
    gray[j] = g; if (g < min) min = g; if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  for (let i = 0, j = 0; i < p.length; i += 4, j++) {
    let v = ((gray[j] - min) * 255 / range) | 0;
    if (invert) v = 255 - v; // light-on-dark game UI → dark-on-light for Tesseract
    p[i] = p[i + 1] = p[i + 2] = v;
  }
  ctx.putImageData(im, 0, 0);
  // ox/oy = source-image offset, scale = canvas px per source px (for bbox → source mapping)
  return { dataUrl: cv.toDataURL('image/png'), canvas: cv, scale, ox: sx, oy: sy };
}

const _workers = {};  // cache one worker per language combo
async function getWorker(onProgress, lang = 'kor+eng') {
  if (_workers[lang]) return _workers[lang];
  _workers[lang] = (async () => {
    if (!window.Tesseract) {
      onProgress({ stage: 'OCR 엔진 로딩(최초 1회)', progress: 0.05 });
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = TESSERACT_CDN; s.onload = res; s.onerror = () => rej(new Error('Tesseract 로드 실패'));
        document.head.appendChild(s);
      });
    }
    onProgress({ stage: `OCR 데이터 준비(${lang}, 최초 1회)`, progress: 0.1 });
    return window.Tesseract.createWorker(lang, 1, {
      logger: (m) => { if (m.status === 'recognizing text') onProgress({ stage: '문자 인식 중', progress: 0.3 + m.progress * 0.6 }); },
    });
  })();
  return _workers[lang];
}

/**
 * Whole-region OCR with MULTI-SCALE union. OCR of small game text is
 * non-monotonic in scale — a name garbled at one zoom level is read cleanly at
 * another. Running a few scales and unioning all recognized text catches names
 * no single pass gets. Combined with confusable-char matching downstream.
 */
export async function extractLines(img, crop, onProgress = () => {}, { psm = '11', invert = false, scales = [2.6, 3.4, 4.2, 5.0, 5.8], lang = 'kor+eng' } = {}) {
  const worker = await getWorker(onProgress, lang);
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  const perScale = [];
  for (let i = 0; i < scales.length; i++) {
    onProgress({ stage: `문자 인식 중 (${i + 1}/${scales.length})`, progress: 0.2 + i / scales.length * 0.75 });
    const { dataUrl } = preprocess(img, crop, scales[i], { invert });
    const { data } = await worker.recognize(dataUrl);
    perScale.push(dedup(data.text || ''));
  }
  onProgress({ stage: '완료', progress: 1 });
  return { lines: dedup(perScale.flat().join('\n')), perScale, engine: `tesseract(${lang},x${scales.length})` };
}

// Latin-heavy short roster names (KDA, EXE, xooos, Babyee…) attract OCR garbage,
// so they must be read near-exactly. Korean names match reliably via jamo
// distance, so they keep a normal (lower) bar.
const _norm = (n) => normName(n);
const _latinFrac = (n) => { const x = _norm(n); const l = (x.match(/[a-z]/g) || []).length; return x.length ? l / x.length : 0; };
const loThresh = (n) => {
  const L = _norm(n).length;
  if (_latinFrac(n) >= 0.6) return L <= 3 ? 0.88 : L <= 5 ? 0.80 : 0.72; // latin-heavy: strict
  return L <= 2 ? 0.70 : 0.62;                                          // korean/mixed: normal
};
const hiThresh = (n) => {                      // single-scale auto-confirm bar (no consensus)
  const L = _norm(n).length;
  if (_latinFrac(n) >= 0.6) return L <= 3 ? 0.97 : 0.92;
  return 0.92;                                 // korean single-scale must be near-exact too
};

/**
 * Consensus match across per-scale OCR passes + length-aware thresholds.
 * A member is confirmed if read above its low bar in ≥2 scales (consensus) or
 * above its high bar in any single scale. Kills scale-specific & short-name
 * garbage while keeping recall high.
 */
export function consensusMatch(perScale, roster, { minVotes = 2 } = {}) {
  const tally = new Map();
  for (const lines of perScale) {
    const perMember = new Map(); // best score for each member within THIS scale
    for (const line of lines) {
      let best = null, bs = 0;
      for (const m of roster) { const s = similarity(line, m.name); if (s > bs) { bs = s; best = m; } }
      if (best) { const cur = perMember.get(best.id); if (!cur || bs > cur.score) perMember.set(best.id, { member: best, score: bs, token: line }); }
    }
    for (const v of perMember.values()) {
      const t = tally.get(v.member.id) || { member: v.member, best: 0, votes: 0, token: v.token };
      if (v.score >= loThresh(v.member.name)) t.votes++;
      if (v.score > t.best) { t.best = v.score; t.token = v.token; }
      tally.set(v.member.id, t);
    }
  }
  const matched = [], maybe = [];
  for (const t of tally.values()) {
    const e = { member: t.member, score: t.best, token: t.token, votes: t.votes };
    if ((t.votes >= minVotes && t.best >= loThresh(t.member.name)) || t.best >= hiThresh(t.member.name)) matched.push(e);
    else if (t.best >= loThresh(t.member.name)) maybe.push(e);
  }
  matched.sort((a, b) => b.score - a.score); maybe.sort((a, b) => b.score - a.score);
  return { matched, maybe };
}

/**
 * Refined OCR: detect text-line positions in `crop` (no grid assumption), then
 * re-OCR each detected line individually at a normalized height. Handles the
 * real UI layout (headers/gaps/uneven spacing) because lines come from detection.
 */
export async function extractRefined(img, crop, onProgress = () => {}, { segPsm = '6' } = {}) {
  const pre = preprocess(img, crop, SCALE);
  const worker = await getWorker(onProgress);
  // pass 1: segmentation — find line boxes (text content of this pass is ignored)
  await worker.setParameters({ tessedit_pageseg_mode: segPsm });
  onProgress({ stage: '줄 위치 감지', progress: 0.2 });
  const { data } = await worker.recognize(pre.dataUrl);
  let lineBoxes = (data.lines || [])
    .filter((l) => l.bbox && (l.bbox.x1 - l.bbox.x0) > 12 && (l.bbox.y1 - l.bbox.y0) > 10)
    .map((l) => l.bbox);
  // fallback to word boxes if no lines detected
  if (!lineBoxes.length) lineBoxes = (data.words || []).map((w) => w.bbox).filter(Boolean);

  // map canvas bbox → source-image rect, pad a little
  const rects = lineBoxes.map((b) => {
    const x = pre.ox + b.x0 / pre.scale, y = pre.oy + b.y0 / pre.scale;
    const w = (b.x1 - b.x0) / pre.scale, h = (b.y1 - b.y0) / pre.scale;
    const padX = w * 0.06, padY = h * 0.18;
    return { x: x - padX, y: y - padY, w: w + padX * 2, h: h + padY * 2 };
  });

  // pass 2: re-OCR each detected line at a normalized height (single line)
  await worker.setParameters({ tessedit_pageseg_mode: '7' });
  const lines = [];
  let done = 0;
  for (const rect of rects) {
    const scale = Math.min(6, Math.max(1, TARGET_CELL_H / Math.max(8, rect.h)));
    const { dataUrl } = preprocess(img, rect, scale);
    const { data: d2 } = await worker.recognize(dataUrl);
    const t = (d2.text || '').trim().replace(/\s+/g, ' ');
    if (t) lines.push(t);
    onProgress({ stage: `줄 인식 ${done + 1}/${rects.length}`, progress: 0.4 + (++done) / rects.length * 0.6 });
  }
  return { lines: dedup(lines.join('\n')), engine: `tesseract-refined(${rects.length}줄)` };
}

/**
 * Slot-grid OCR: slice `region` into rows×cols cells and OCR each cell's name
 * area (left `nameLeftPct` skipped for the portrait) individually. One name per
 * cell → far fewer mis-reads than whole-image OCR.
 * @returns {Promise<{cells:Array<{text,row,col,rect}>, lines:string[], engine}>}
 */
export async function extractSlots(img, region, { rows, cols, nameLeftPct = 0.22 }, onProgress = () => {}) {
  const reg = region || { x: 0, y: 0, w: img.width, h: img.height };
  const colW = reg.w / cols, rowH = reg.h / rows;
  const worker = await getWorker(onProgress);
  await worker.setParameters({ tessedit_pageseg_mode: '7' }); // SINGLE_LINE
  const cells = [];
  const total = rows * cols; let done = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const rect = {
        x: reg.x + c * colW + colW * nameLeftPct, y: reg.y + r * rowH + rowH * 0.08,
        w: colW * (1 - nameLeftPct - 0.02), h: rowH * 0.84,
      };
      // scale each cell to a target text height → consistent OCR input regardless
      // of the source screenshot resolution (no fixed-pixel width/height).
      const scale = Math.min(6, Math.max(1, TARGET_CELL_H / Math.max(8, rect.h)));
      const { dataUrl } = preprocess(img, rect, scale);
      const { data } = await worker.recognize(dataUrl);
      const text = (data.text || '').trim().replace(/\s+/g, ' ');
      cells.push({ text, row: r, col: c, rect });
      onProgress({ stage: `슬롯 인식 ${done + 1}/${total}`, progress: (++done) / total });
    }
  }
  const lines = cells.map((c) => c.text).filter((t) => normName(t).length >= 1);
  return { cells, lines, engine: 'tesseract-slot' };
}

function dedup(text) {
  const seen = new Set(), out = [];
  for (const raw of String(text).split(/\n+/)) {
    for (const tok of raw.split(/[\s,，|/·•_\[\]()]+/)) {
      const t = tok.trim();
      if (t.length < 1) continue;
      const key = normName(t);
      if (!key || seen.has(key)) continue;
      seen.add(key); out.push(t);
    }
  }
  return out;
}

/**
 * Match OCR tokens to roster members, tiered by confidence.
 * @returns {{matched:[{member,score,token}], maybe:[{member,score,token}], unmatched:string[]}}
 *   matched: high confidence (auto-checked). maybe: low confidence (review). unmatched: leftovers.
 */
export function matchRoster(lines, roster, { high = 0.72, low = 0.58 } = {}) {
  const matched = [], maybe = [], unmatched = [], used = new Set();
  // sort candidate matches globally by score so the best token claims each member
  const cands = [];
  for (const line of lines) {
    const r = matchName(line, roster, low);
    if (r) cands.push({ ...r, token: line });
    else if (normName(line).length >= 2) unmatched.push(line);
  }
  cands.sort((a, b) => b.score - a.score);
  for (const c of cands) {
    if (used.has(c.member.id)) continue;
    used.add(c.member.id);
    (c.score >= high ? matched : maybe).push(c);
  }
  return { matched, maybe, unmatched };
}
