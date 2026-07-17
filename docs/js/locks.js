// locks.js — 소프트 락: 관리자가 편집 페이지에 있으면 백엔드에 '편집 중' 등록,
// 같은 페이지에 다른 관리자가 있으면 배너로 알림(하드 차단 X, 오래된 저장은 revision 충돌로 거부).
import { CONFIG } from './config.js';
import { SupabaseBackend } from './supabase-backend.js';
import { Roles } from './roles.js';

const LIVE = () => !!CONFIG.APPS_SCRIPT_URL && !SupabaseBackend.isConfigured();
const LOCKED_PAGES = new Set(['members', 'participation', 'diamond', 'dist-params', 'settings', 'rotation', 'gear']);

export const Locks = {
  page: null, timer: null, _banner: null,
  setBanner(node) { this._banner = node; },

  async _post(action, page) {
    try {
      const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, token: localStorage.getItem(CONFIG.TOKEN_KEY) || '', page, who: Roles.me() }),
      });
      return (await res.json()).data;
    } catch { return null; }
  },

  _render(locks) {
    if (!this._banner) return;
    const others = (locks || []).filter((l) => l.page === this.page && l.who !== Roles.me());
    if (!this.page || !others.length) { this._banner.style.display = 'none'; this._banner.textContent = ''; return; }
    this._banner.style.display = '';
    this._banner.textContent = `⚠ ${others.map((o) => o.who).join(', ')} 님이 이 페이지를 편집 중입니다 — 먼저 저장된 변경 이후에는 새로고침이 필요합니다.`;
  },

  // 페이지 진입 시 호출(관리자·라이브 한정). 이전 페이지 락 해제 후 새 페이지 락 등록 + 하트비트.
  async enter(page) {
    clearInterval(this.timer);
    if (!LIVE() || !Roles.isAdmin() || !LOCKED_PAGES.has(page)) {
      if (this.page) this._post('unlock', this.page);
      this.page = null; this._render([]); return;
    }
    if (this.page && this.page !== page) await this._post('unlock', this.page);
    this.page = page;
    this._render(await this._post('lock', page));
    this.timer = setInterval(async () => { this._render(await this._post('lock', this.page)); }, 18000);
  },
};
