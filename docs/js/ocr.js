// ocr.js — screenshot → text lines → roster matches.
//   primary: Naver CLOVA OCR via the Apps Script backend (DB.ocr)
//   fallback: Tesseract.js (Korean), loaded lazily from CDN
import { DB } from './db.js';
import { matchName, normName } from './util.js';

const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

/** Read a File/Blob into an <img> then a downscaled canvas (max 1600px). */
export async function imageToBase64(file, max = 1600) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.width * scale);
    cv.height = Math.round(img.height * scale);
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    return { dataUrl: cv.toDataURL('image/png'), base64: cv.toDataURL('image/png').split(',')[1], canvas: cv };
  } finally { URL.revokeObjectURL(url); }
}

let _tess = null;
async function loadTesseract() {
  if (window.Tesseract) return window.Tesseract;
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = TESSERACT_CDN; s.onload = res; s.onerror = () => rej(new Error('Tesseract 로드 실패'));
    document.head.appendChild(s);
  });
  return window.Tesseract;
}

/**
 * Extract text lines from an image.
 * @param {{base64:string, dataUrl:string}} img
 * @param {(p:{stage:string,progress:number})=>void} onProgress
 * @returns {Promise<{lines:string[], engine:string}>}
 */
export async function extractLines(img, onProgress = () => {}) {
  // 1) backend Naver OCR
  onProgress({ stage: '서버 OCR 요청', progress: 0.1 });
  const backend = await DB.ocr(img.base64).catch(() => null);
  if (backend && backend.length) return { lines: dedup(backend), engine: 'naver' };

  // 2) Tesseract.js fallback (Korean)
  onProgress({ stage: 'Tesseract 로딩(최초 1회 다운로드)', progress: 0.2 });
  const T = await loadTesseract();
  const { data } = await T.recognize(img.dataUrl, 'kor', {
    logger: (m) => { if (m.status === 'recognizing text') onProgress({ stage: '문자 인식 중', progress: 0.3 + m.progress * 0.7 }); },
  });
  const lines = (data.lines || []).map((l) => l.text).concat((data.text || '').split('\n'));
  return { lines: dedup(lines), engine: 'tesseract' };
}

function dedup(lines) {
  const seen = new Set(), out = [];
  for (let raw of lines) {
    // split a line that may contain several names separated by spaces/symbols
    for (const tok of String(raw).split(/[\s,|/·•\-_\[\]()]+/)) {
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
 * Match OCR lines to roster members.
 * @returns {{matched:Array<{member,score,token}>, unmatched:string[]}}
 */
export function matchRoster(lines, roster, threshold = 0.62) {
  const matched = [], unmatched = [], used = new Set();
  for (const line of lines) {
    const r = matchName(line, roster, threshold);
    if (r && !used.has(r.member.id)) { used.add(r.member.id); matched.push({ ...r, token: line }); }
    else if (!r && normName(line).length >= 2) unmatched.push(line);
  }
  matched.sort((a, b) => b.score - a.score);
  return { matched, unmatched };
}
