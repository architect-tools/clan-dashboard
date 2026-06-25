// app.js — bootstrap: gate → load data → build shell → start router.
import { CONFIG } from './config.js';
import { DB } from './db.js';
import { Auth } from './auth.js';
import { Router } from './router.js';
import { el, $, toast, applyUiScale } from './util.js';
import { renderDashboard } from './views/dashboard.js';
import { renderMembers } from './views/members.js';
import { renderParticipation } from './views/participation.js';
import { renderDiamond } from './views/diamond.js';
import { renderRotation } from './views/rotation.js';
import { renderGear } from './views/gear.js';
import { renderSchedule } from './views/schedule.js';
import { renderSettings } from './views/settings.js';
import { renderDistParams } from './views/distParams.js';

const NAV = [
  { path: 'dashboard', icon: '🏠', label: '대시보드' },
  { path: 'members', icon: '👥', label: '명단 관리' },
  { path: 'participation', icon: '📅', label: '참여 기록' },
  { path: 'diamond', icon: '💎', label: '다이아 정산' },
  { path: 'rotation', icon: '🎁', label: '순번제/분배' },
  { path: 'gear', icon: '🛡️', label: '장비/숙련 현황' },
  { path: 'schedule', icon: '🗓️', label: '일정' },
  { path: 'settings', icon: '⚙️', label: '설정' },
];

let undoBtn, redoBtn;
function updateHistoryButtons() {
  if (undoBtn) undoBtn.disabled = !DB.canUndo();
  if (redoBtn) redoBtn.disabled = !DB.canRedo();
}

function buildShell() {
  const root = $('#root');
  root.innerHTML = '';
  const nav = el('nav.sidebar', {}, [
    el('div.brand', {}, [el('div', {}, [
      el('div.brand-name', { text: CONFIG.appName }), el('div.brand-sub', { text: '관리자 대시보드' })])]),
    el('div.nav-links', {}, NAV.map((n) => el('a.nav-link', {
      'data-nav': n.path, href: '#/' + n.path,
    }, [el('span', { text: n.label })]))),
    el('div.sidebar-foot', {}, [
      el('div.ver', { text: 'v' + CONFIG.version + (CONFIG.APPS_SCRIPT_URL ? ' · 클라우드' : ' · 로컬') }),
      el('a.nav-link.logout', { onclick: () => Auth.logout(), text: '잠금' }),
    ]),
  ]);
  undoBtn = el('button.icon-btn', { title: '실행 취소 (Ctrl+Z)', onclick: () => DB.undo(), disabled: true }, ['↶']);
  redoBtn = el('button.icon-btn', { title: '다시 실행 (Ctrl+Shift+Z)', onclick: () => DB.redo(), disabled: true }, ['↷']);
  const main = el('main.main', {}, [el('div#app')]);
  const topbar = el('header.topbar', {}, [
    el('button.menu-btn', { text: '☰', onclick: () => document.body.classList.toggle('nav-open') }),
    el('span.topbar-title', { text: CONFIG.appName }),
    el('div.topbar-tools', {}, [undoBtn, redoBtn]),
  ]);
  root.appendChild(el('div.layout', {}, [nav, el('div.main-wrap', {}, [topbar, main])]));
  nav.addEventListener('click', (e) => { if (e.target.closest('.nav-link')) document.body.classList.remove('nav-open'); });

  // keyboard: Ctrl/Cmd+Z undo, Ctrl+Shift+Z or Ctrl+Y redo
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return; // don't hijack field editing
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); DB.undo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); DB.redo(); }
  });
}

async function main() {
  await Auth.gate();
  buildShell();
  try { await DB.init(); }
  catch (e) { console.error(e); toast('데이터 로드 실패: ' + e.message, 'error'); return; }

  applyUiScale(DB.state.appSettings?.uiScale); // restore saved UI scale
  DB.setCallbacks({ onHistory: updateHistoryButtons, onRefresh: () => Router.refresh() });

  Router
    .on('dashboard', renderDashboard)
    .on('members', renderMembers)
    .on('participation', renderParticipation)
    .on('diamond', renderDiamond)
    .on('rotation', renderRotation)
    .on('gear', renderGear)
    .on('schedule', renderSchedule)
    .on('settings', renderSettings)
    .on('dist-params', renderDistParams)
    .start('dashboard');
  updateHistoryButtons();
}

main();
