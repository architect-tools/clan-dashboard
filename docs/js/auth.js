// auth.js — shared-password gate with identity (nickname) + role.
//   • 닉네임 드롭다운에서 본인 선택 → 입찰 귀속/자기 것만 취소에 사용.
//   • 비밀번호: 7979 = 멤버, 관리자 비번 = 관리자. 멤버 변경은 서버의 원자적
//     닉네임 범위 mutation 으로 저장되어 다른 멤버의 동시 편집과 병합된다.
import { CONFIG } from './config.js';
import { SupabaseBackend } from './supabase-backend.js';
import { el } from './util.js';
import { comboSelect } from './views/ui.js';

// 게이트 드롭다운 채울 명단 — 읽기는 토큰 불필요(getAll). 백엔드 → 로컬 → 시드 순.
async function loadRoster() {
  if (SupabaseBackend.isConfigured()) {
    try { return await SupabaseBackend.roster(); } catch (e) { console.error('Supabase roster failed', e); }
  }
  let data = null;
  if (CONFIG.APPS_SCRIPT_URL) {
    try { const r = await fetch(CONFIG.APPS_SCRIPT_URL + '?action=getAll'); data = (await r.json()).data; } catch { /* fall through */ }
  }
  if (!data) { try { data = JSON.parse(localStorage.getItem(CONFIG.STORE_KEY) || 'null'); } catch { /* ignore */ } }
  if (!data) { try { data = await (await fetch('data/seed.json', { cache: 'no-store' })).json(); } catch { /* ignore */ } }
  const ms = (data && data.members) || [];
  return ms.filter((m) => m && m.name && m.active !== false).map((m) => m.name)
    .sort((a, b) => a.localeCompare(b, 'ko'));
}

export const Auth = {
  // 재로그인 유도: 비번(=백엔드 토큰)이 바뀌었거나 닉네임(신원)이 없으면 게이트 다시 표시
  ok() {
    return localStorage.getItem(CONFIG.AUTH_KEY) === '1'
      && localStorage.getItem(CONFIG.TOKEN_KEY) === CONFIG.GATE_PASSWORD
      && !!localStorage.getItem(CONFIG.ME_KEY);
  },
  logout() {
    const finish = () => {
      [CONFIG.AUTH_KEY, CONFIG.TOKEN_KEY, CONFIG.ROLE_KEY, CONFIG.ME_KEY].forEach((k) => localStorage.removeItem(k));
      location.reload();
    };
    if (SupabaseBackend.isConfigured()) {
      SupabaseBackend.releaseIdentity().then(finish).catch((e) => {
        console.error('identity release failed', e);
        SupabaseBackend.signOut().finally(finish);
      });
    }
    else finish();
  },

  /** Resolve once the user passes the gate (nickname + password). */
  async gate() {
    if (SupabaseBackend.isConfigured()) {
      await SupabaseBackend.ensureAnonymousSession();
      const profile = await SupabaseBackend.profile();
      if (profile?.name && profile?.role) {
        localStorage.setItem(CONFIG.AUTH_KEY, '1');
        localStorage.setItem(CONFIG.ME_KEY, profile.name);
        localStorage.setItem(CONFIG.ROLE_KEY, profile.role);
        return;
      }
      [CONFIG.AUTH_KEY, CONFIG.TOKEN_KEY, CONFIG.ROLE_KEY, CONFIG.ME_KEY].forEach((k) => localStorage.removeItem(k));
    } else if (this.ok()) return;
    const names = await loadRoster();
    return new Promise((resolve) => {
      const who = names.length
        ? comboSelect(names, '', { class: 'gate-input gate-who', placeholder: '닉네임 검색…' })
        : el('input.gate-input.gate-who', { placeholder: '내 닉네임', autocomplete: 'off' });
      const input = el('input.gate-input', { type: 'password', placeholder: '비밀번호', autocomplete: 'off' });
      const err = el('div.gate-err');
      const submit = async () => {
        const me = (who.value || '').trim();
        if (!me) { err.textContent = '닉네임을 선택하세요.'; return; }
        const pw = input.value;
        let role = null;
        const submitBtn = overlay.querySelector('.gate-btn');
        submitBtn.disabled = true; err.textContent = '확인 중…';
        try {
          if (SupabaseBackend.isConfigured()) {
            const claimed = await SupabaseBackend.claim(me, pw);
            role = claimed?.role;
          } else {
            role = (CONFIG.ADMIN_PASSWORD && pw === CONFIG.ADMIN_PASSWORD) ? 'admin'
              : (pw === CONFIG.GATE_PASSWORD) ? 'member' : null;
          }
        } catch (e) {
          console.error(e); role = null;
        }
        if (!role) {
          err.textContent = '비밀번호가 올바르지 않습니다.'; input.select(); submitBtn.disabled = false; return;
        }
        localStorage.setItem(CONFIG.AUTH_KEY, '1');
        if (!SupabaseBackend.isConfigured()) localStorage.setItem(CONFIG.TOKEN_KEY, CONFIG.GATE_PASSWORD);
        localStorage.setItem(CONFIG.ME_KEY, me);
        localStorage.setItem(CONFIG.ROLE_KEY, role);
        overlay.remove();
        resolve();
      };
      const overlay = el('div.gate-overlay', {}, [
        el('div.gate-card', {}, [
          el('h1.gate-title', { text: CONFIG.appName }),
          el('p.gate-sub', { text: '닉네임을 선택하고 비밀번호를 입력하세요' }),
          who, input, err,
          el('button.btn.btn-primary.gate-btn', { text: '입장', onclick: submit }),
          el('p.gate-foot', { text: '관리자는 관리자 비밀번호로 입장하세요.' }),
        ]),
      ]);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      document.body.appendChild(overlay);
      setTimeout(() => who.focus(), 50);
    });
  },
};
