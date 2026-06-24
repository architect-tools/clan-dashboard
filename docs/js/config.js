// config.js — app-wide configuration & domain constants.
// Edit APPS_SCRIPT_URL after deploying the Apps Script backend to enable
// cloud sync + Naver OCR. Leave blank to run fully standalone (localStorage).

export const CONFIG = {
  appName: '불면증 클랜 관리',
  version: '1.0.0',

  // ── Backend (optional) ───────────────────────────────────────────
  // Paste the Apps Script Web App URL here (…/exec). Blank = standalone mode.
  APPS_SCRIPT_URL: '',

  // Access gate. Change this password. (Obfuscation only — the real write
  // protection is the token checked by the Apps Script backend.)
  GATE_PASSWORD: 'insomnia',

  // localStorage keys
  STORE_KEY: 'clandash.v1.data',
  AUTH_KEY: 'clandash.v1.auth',
  TOKEN_KEY: 'clandash.v1.token',
};

// 직업(class) metadata: label + theme color + short tag
export const CLASSES = {
  '전투사제': { color: '#34d399', tag: '사제' },
  '암살자':   { color: '#a78bfa', tag: '암살' },
  '사냥꾼':   { color: '#60a5fa', tag: '사냥' },
  '마법사':   { color: '#38bdf8', tag: '법사' },
  '전사':     { color: '#fb7185', tag: '전사' },
};
export const CLASS_LIST = Object.keys(CLASSES);

export function classColor(cls) {
  return (CLASSES[cls] || {}).color || '#94a3b8';
}

// Tier display colors
export const TIER_COLORS = {
  S: '#fbbf24', A: '#34d399', B: '#60a5fa', C: '#a78bfa', D: '#f472b6', F: '#94a3b8',
};

// Content category display order
export const CATEGORY_ORDER = ['필드 보스', '월드 보스', '거인의 탑', '심연의 전장', '기타'];
