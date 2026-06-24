// ocr.js — screenshot → text lines → roster matches.
// Engine: Tesseract.js (kor+eng, sparse-text mode) loaded lazily from CDN.
// Matching is against the known roster, so even imperfect OCR is recovered by
// fuzzy hangul matching + the admin's review step.
import { matchName, normName } from './util.js';

const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const MAX_SIDE = 3400;   // cap upscaled canvas to keep memory sane
const SCALE = 2.4;       // upscale factor (small game-UI text needs enlarging)

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
export function preprocess(img, crop = null) {
  const sx = crop ? Math.max(0, crop.x) : 0;
  const sy = crop ? Math.max(0, crop.y) : 0;
  const sw = crop ? Math.min(crop.w, img.width - sx) : img.width;
  const sh = crop ? Math.min(crop.h, img.height - sy) : img.height;
  const scale = Math.min(SCALE, MAX_SIDE / Math.max(sw, sh));
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
    const v = ((gray[j] - min) * 255 / range) | 0;
    p[i] = p[i + 1] = p[i + 2] = v;
  }
  ctx.putImageData(im, 0, 0);
  return { dataUrl: cv.toDataURL('image/png'), canvas: cv };
}

let _workerPromise = null;
async function getWorker(onProgress) {
  if (_workerPromise) return _workerPromise;
  _workerPromise = (async () => {
    if (!window.Tesseract) {
      onProgress({ stage: 'OCR 엔진 로딩(최초 1회)', progress: 0.05 });
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = TESSERACT_CDN; s.onload = res; s.onerror = () => rej(new Error('Tesseract 로드 실패'));
        document.head.appendChild(s);
      });
    }
    onProgress({ stage: '한글 데이터 준비(최초 1회 다운로드)', progress: 0.1 });
    const worker = await window.Tesseract.createWorker('kor+eng', 1, {
      logger: (m) => { if (m.status === 'recognizing text') onProgress({ stage: '문자 인식 중', progress: 0.3 + m.progress * 0.65 }); },
    });
    await worker.setParameters({ tessedit_pageseg_mode: '11' }); // SPARSE_TEXT — scattered UI labels
    return worker;
  })();
  return _workerPromise;
}

/**
 * Run OCR and return cleaned candidate tokens.
 * @param {HTMLImageElement} img
 * @param {{x,y,w,h}|null} crop
 * @returns {Promise<{lines:string[], engine:string}>}
 */
export async function extractLines(img, crop, onProgress = () => {}) {
  const { dataUrl } = preprocess(img, crop);
  const worker = await getWorker(onProgress);
  onProgress({ stage: '문자 인식 중', progress: 0.3 });
  const { data } = await worker.recognize(dataUrl);
  onProgress({ stage: '완료', progress: 1 });
  return { lines: dedup(data.text || ''), engine: 'tesseract(kor+eng)' };
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
