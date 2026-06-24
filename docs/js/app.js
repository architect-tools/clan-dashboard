// app.js — bootstrap: gate → load data → build shell → start router.
import { CONFIG } from './config.js';
import { DB } from './db.js';
import { Auth } from './auth.js';
import { Router } from './router.js';
import { el, $, toast } from './util.js';
import { renderDashboard } from './views/dashboard.js';
import { renderMembers } from './views/members.js';
import { renderParticipation } from './views/participation.js';
import { renderDiamond } from './views/diamond.js';
import { renderRotation } from './views/rotation.js';
import { renderSchedule } from './views/schedule.js';
import { renderSettings } from './views/settings.js';

const NAV = [
  { path: 'dashboard', icon: '🏠', label: '대시보드' },
  { path: 'members', icon: '👥', label: '명단 관리' },
  { path: 'participation', icon: '📷', label: '주간 참여도' },
  { path: 'diamond', icon: '💎', label: '다이아 정산' },
  { path: 'rotation', icon: '🎁', label: '순번제/분배' },
  { path: 'schedule', icon: '📅', label: '일정' },
  { path: 'settings', icon: '⚙️', label: '설정' },
];

function buildShell() {
  const root = $('#root');
  root.innerHTML = '';
  const nav = el('nav.sidebar', {}, [
    el('div.brand', {}, [el('span.brand-logo', { text: '🌙' }), el('div', {}, [
      el('div.brand-name', { text: CONFIG.appName }), el('div.brand-sub', { text: '관리자 대시보드' })])]),
    el('div.nav-links', {}, NAV.map((n) => el('a.nav-link', {
      'data-nav': n.path, href: '#/' + n.path,
    }, [el('span.nav-icon', { text: n.icon }), el('span', { text: n.label })]))),
    el('div.sidebar-foot', {}, [
      el('div.ver', { text: 'v' + CONFIG.version + (CONFIG.APPS_SCRIPT_URL ? ' · ☁' : ' · 💾') }),
      el('a.nav-link.logout', { onclick: () => Auth.logout(), text: '🔒 잠금' }),
    ]),
  ]);
  const main = el('main.main', {}, [el('div#app')]);
  const topbar = el('header.topbar', {}, [
    el('button.menu-btn', { text: '☰', onclick: () => document.body.classList.toggle('nav-open') }),
    el('span.topbar-title', { text: CONFIG.appName }),
  ]);
  root.appendChild(el('div.layout', {}, [nav, el('div.main-wrap', {}, [topbar, main])]));
  // close mobile nav on link click
  nav.addEventListener('click', (e) => { if (e.target.closest('.nav-link')) document.body.classList.remove('nav-open'); });
}

async function main() {
  await Auth.gate();
  buildShell();
  try { await DB.init(); }
  catch (e) { console.error(e); toast('데이터 로드 실패: ' + e.message, 'error'); return; }

  Router
    .on('dashboard', renderDashboard)
    .on('members', renderMembers)
    .on('participation', renderParticipation)
    .on('diamond', renderDiamond)
    .on('rotation', renderRotation)
    .on('schedule', renderSchedule)
    .on('settings', renderSettings)
    .start('dashboard');
}

main();
