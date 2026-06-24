// auth.js — simple shared-password gate. The entered password is also stored
// as the backend token (Apps Script verifies it before any write).
import { CONFIG } from './config.js';
import { el, $ } from './util.js';

export const Auth = {
  ok() { return localStorage.getItem(CONFIG.AUTH_KEY) === '1'; },
  logout() { localStorage.removeItem(CONFIG.AUTH_KEY); localStorage.removeItem(CONFIG.TOKEN_KEY); location.reload(); },

  /** Resolve once the user passes the gate. */
  gate() {
    return new Promise((resolve) => {
      if (this.ok()) return resolve();
      const input = el('input.gate-input', { type: 'password', placeholder: '관리자 비밀번호', autofocus: true });
      const err = el('div.gate-err');
      const submit = () => {
        if (input.value === CONFIG.GATE_PASSWORD) {
          localStorage.setItem(CONFIG.AUTH_KEY, '1');
          localStorage.setItem(CONFIG.TOKEN_KEY, input.value);
          overlay.remove();
          resolve();
        } else { err.textContent = '비밀번호가 올바르지 않습니다.'; input.select(); }
      };
      const overlay = el('div.gate-overlay', {}, [
        el('div.gate-card', {}, [
          el('div.gate-logo', { text: '🌙' }),
          el('h1.gate-title', { text: CONFIG.appName }),
          el('p.gate-sub', { text: '관리자 대시보드' }),
          input, err,
          el('button.btn.btn-primary.gate-btn', { text: '입장', onclick: submit }),
        ]),
      ]);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      document.body.appendChild(overlay);
      setTimeout(() => input.focus(), 50);
    });
  },
};
