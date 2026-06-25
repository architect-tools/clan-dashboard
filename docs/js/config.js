// config.js — app-wide configuration & domain constants.
// Edit APPS_SCRIPT_URL after deploying the Apps Script backend to enable
// cloud sync + Naver OCR. Leave blank to run fully standalone (localStorage).

export const CONFIG = {
  appName: '불면증 클랜 관리',
  version: '1.0.0',

  // ── Backend (optional) ───────────────────────────────────────────
  // Paste the Apps Script Web App URL here (…/exec). Blank = standalone mode.
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbx6GJnd7PitETPxym-CZv_LIqL5h_MTEZ0mECcRtk6Rwo0p3f1c7xBZrrhUpoywDB9w/exec',

  // Access gate. Change this password. (Obfuscation only — the real write
  // protection is the token checked by the Apps Script backend.)
  GATE_PASSWORD: '7979',
  // 관리자 비밀번호 — 7979(멤버)와 다르게. 이 비번으로 입장하면 관리자 권한.
  // (공개 repo라 난독화 수준 — 강제는 클라이언트 UI에서. 원하는 값으로 바꾸세요.)
  ADMIN_PASSWORD: 'insomnia97',

  // localStorage keys
  STORE_KEY: 'clandash.v1.data',
  AUTH_KEY: 'clandash.v1.auth',
  TOKEN_KEY: 'clandash.v1.token',
  ME_KEY: 'clandash.v1.me',       // 내 닉네임(입찰 귀속)
  ROLE_KEY: 'clandash.v1.role',   // 'admin' | 'member'
};

// 직업(class) metadata: label + theme color + short tag.
// 색은 밝은 종이 배경(kami)에서 텍스트로도, 밝은 글씨 배경으로도 읽히도록 중간~짙은 톤.
// Insomnia 다크 테마 데이터 팔레트(claude design): 차분한 주얼톤, 어두운 배경에서 텍스트로도 읽힘.
export const CLASSES = {
  '전투사제': { color: '#6FB390', tag: '사제' },
  '암살자':   { color: '#AB8FD9', tag: '암살' },
  '사냥꾼':   { color: '#DB9F5C', tag: '사냥' },
  '마법사':   { color: '#6FA0DD', tag: '법사' },
  '전사':     { color: '#DC807C', tag: '전사' },
};
export const CLASS_LIST = Object.keys(CLASSES);

export function classColor(cls) {
  return (CLASSES[cls] || {}).color || '#828B9C';
}

// Tier display colors (S→F 램프)
export const TIER_COLORS = {
  S: '#E7C45A', A: '#6FB390', B: '#6FA0DD', C: '#AB8FD9', D: '#D680AE', F: '#828B9C',
};

// Content category display order
export const CATEGORY_ORDER = ['필드 보스', '월드 보스', '거인의 탑', '심연의 전장', '기타'];
