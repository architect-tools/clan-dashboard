// app.js — bootstrap: gate → load data → build shell → start router.
import { CONFIG } from './config.js';
import { SupabaseBackend } from './supabase-backend.js';
import { DB } from './db.js';
import { Auth } from './auth.js';
import { Roles } from './roles.js';
import { Locks } from './locks.js';
import { Router } from './router.js';
import { el, $, toast, applyUiScale } from './util.js';
import { busyOverlay, btn } from './views/ui.js';
import { renderDashboard, openBugReportForm, openImprovementForm, openQaBacklog } from './views/dashboard.js';
import { renderMembers } from './views/members.js';
import { renderParticipation } from './views/participation.js';
import { renderDiamond } from './views/diamond.js';
import { renderRotation } from './views/rotation.js';
import { renderGear } from './views/gear.js';
import { renderSettings } from './views/settings.js';
import { renderDistParams } from './views/distParams.js';
import { renderMemberPasswords } from './views/memberPasswords.js';

const NAV = [
  { path: 'dashboard', icon: '🏠', label: '대시보드' },
  { path: 'members', icon: '👥', label: '클랜원' },
  { path: 'participation', icon: '📅', label: '참여 기록' },
  { path: 'diamond', icon: '💎', label: '다이아 정산' },
  { path: 'rotation', icon: '🎁', label: '전리품' },
  { path: 'gear', icon: '🛡️', label: '장비/캐릭터 현황' },
  { path: 'member-passwords', icon: '🔑', label: '멤버 비밀번호', admin: true },
  { path: 'dist-params', icon: '🧮', label: '분배 파라미터', admin: true },
  { path: 'settings', icon: '⚙️', label: '설정', admin: true },
];

let undoBtn, redoBtn, refreshBtn, saveOverlay;
function updateHistoryButtons() {
  if (undoBtn) undoBtn.disabled = !DB.canUndo();
  if (redoBtn) redoBtn.disabled = !DB.canRedo();
}

function showSavingOverlay(active, label = '변경사항 저장 중…') {
  if (active) {
    const detail = '서버 반영이 끝날 때까지 잠시 기다려 주세요';
    if (saveOverlay) saveOverlay.update(label, detail);
    else saveOverlay = busyOverlay(label, detail);
    return;
  }
  if (saveOverlay) saveOverlay.close();
  saveOverlay = null;
}

async function manualRefresh() {
  const syncLabel = SupabaseBackend.isConfigured()
    ? '실시간 DB 변경사항 동기화'
    : Roles.isAdmin() ? '시트 변경사항 동기화' : '다른 멤버 변경사항 동기화';
  const busy = busyOverlay('최신 데이터 불러오는 중…', syncLabel);
  let r;
  try {
    if (DB._pendingSave) {
      busy.update('변경사항 저장 중…', '대시보드 변경사항을 먼저 DB에 반영');
      const ok = await DB.flushSave();
      if (!ok) { toast('저장 실패로 새로고침을 중단했습니다', 'error'); return; }
      busy.update('최신 데이터 불러오는 중…', syncLabel);
    }
    r = await DB.refresh({ merge: Roles.isAdmin(), force: true });
  } finally { busy.close(); } // ⟳ 버튼 회전은 onLoading 콜백이 담당
  if (r === 'busy') toast('편집/저장 중입니다 — 잠시 후 다시 시도하세요', 'error');
  else if (r === true) toast('최신 데이터로 갱신했습니다');
  else if (r === false) toast('이미 최신 상태입니다');
  else if (r === 'save-error') toast('최근 저장 실패가 있어 자동 갱신을 건너뜁니다', 'error');
  else toast('새로고침 실패 — 잠시 후 다시 시도', 'error');
}

function buildShell() {
  const root = $('#root');
  root.innerHTML = '';
  refreshBtn = el('button.icon-btn.refresh-btn', { title: '새로고침 (최신 데이터 불러오기)', onclick: () => manualRefresh() }, [el('span.refresh-ico', { text: '⟳' })]);
  const nav = el('nav.sidebar', {}, [
    el('div.brand', {}, [
      el('div', {}, [el('div.brand-name', { text: CONFIG.appName }), el('div.brand-sub', { text: '관리자 대시보드' })]),
      refreshBtn]),
    el('div.nav-links', {}, NAV.map((n) => el('a.nav-link', {
      'data-nav': n.path, href: '#/' + n.path, class: n.admin ? 'admin-only' : '',
    }, [el('span', { text: n.label })]))),
    el('div.sidebar-foot', {}, [
      el('div.whoami', { class: Roles.isAdmin() ? 'admin' : 'member' },
        [el('span.whoami-role', { text: Roles.isAdmin() ? '관리자' : '멤버' }), el('span.whoami-name', { text: Roles.me() || '?' })]),
      el('div.ver', { text: 'v' + CONFIG.version + (SupabaseBackend.isConfigured() ? ' · 실시간 DB' : CONFIG.APPS_SCRIPT_URL ? ' · 시트 동기화' : ' · 로컬') }),
      el('a.nav-link.logout', { onclick: () => Auth.logout(), text: '잠금 / 전환' }),
    ]),
  ]);
  // undo/redo는 공유 상태를 되돌릴 수 있어 관리자 전용
  undoBtn = el('button.icon-btn.admin-only', { title: '실행 취소 (Ctrl+Z)', onclick: () => DB.undo(), disabled: true }, ['↶']);
  redoBtn = el('button.icon-btn.admin-only', { title: '다시 실행 (Ctrl+Shift+Z)', onclick: () => DB.redo(), disabled: true }, ['↷']);
  const qaReportBtn = btn('버그 리포트 작성', () => openBugReportForm(), { kind: 'primary', admin: true });
  qaReportBtn.classList.add('topbar-qa-btn');
  const improvementBtn = btn('건의/개선사항', () => openImprovementForm(), { kind: 'ghost', admin: true });
  improvementBtn.classList.add('topbar-qa-btn');
  const backlogBtn = btn('백로그', () => openQaBacklog(), { kind: 'ghost', admin: true });
  backlogBtn.classList.add('topbar-qa-btn');
  const lockBanner = el('div.lock-banner', { style: { display: 'none' } });
  Locks.setBanner(lockBanner);
  const main = el('main.main', {}, [lockBanner, el('div#app')]);
  const topbar = el('header.topbar', {}, [
    el('button.menu-btn', { text: '☰', onclick: () => document.body.classList.toggle('nav-open') }),
    el('span.topbar-title', { text: CONFIG.appName }),
    el('span.role-badge', { class: Roles.isAdmin() ? 'admin' : 'member', text: (Roles.isAdmin() ? '관리자' : '멤버') + ' · ' + (Roles.me() || '?') }),
    el('div.topbar-tools', {}, [undoBtn, redoBtn, backlogBtn, improvementBtn, qaReportBtn]),
  ]);
  root.appendChild(el('div.layout', {}, [nav, el('div.main-wrap', {}, [topbar, main])]));
  nav.addEventListener('click', (e) => { if (e.target.closest('.nav-link')) document.body.classList.remove('nav-open'); });

  // keyboard: Ctrl/Cmd+Z undo, Ctrl+Shift+Z or Ctrl+Y redo
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (!Roles.isAdmin()) return; // undo/redo는 공유 상태 보호 위해 관리자만
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return; // don't hijack field editing
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); DB.undo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); DB.redo(); }
  });
}

async function main() {
  await Auth.gate();
  document.body.dataset.role = Roles.role(); // CSS가 .admin-only 표시/숨김 결정
  buildShell();
  // topbar 실제 높이를 CSS 변수로 → 장비 페이지 고정 네비가 topbar 바로 아래 갭 없이 붙도록
  const setTopbarH = () => { const tb = document.querySelector('.topbar'); if (tb) document.documentElement.style.setProperty('--topbar-h', tb.offsetHeight + 'px'); };
  setTopbarH(); window.addEventListener('resize', setTopbarH);
  const boot = busyOverlay('데이터 불러오는 중…');
  try { await DB.init(); }
  catch (e) { console.error(e); toast('데이터 로드 실패: ' + e.message, 'error'); boot.close(); return; }
  boot.close();

  applyUiScale(DB.state.appSettings?.uiScale); // restore saved UI scale
  // onLoading: 백그라운드 새로고침 중 ⟳ 버튼 회전(비차단 표시)
  DB.setCallbacks({
    onHistory: updateHistoryButtons,
    onRefresh: () => Router.refresh(),
    onLoading: (active) => { if (refreshBtn) refreshBtn.classList.toggle('spinning', active); },
    onSaving: showSavingOverlay,
  });

  Router
    .on('dashboard', renderDashboard)
    .on('members', renderMembers)
    .on('participation', renderParticipation)
    .on('diamond', renderDiamond)
    .on('rotation', renderRotation)
    .on('gear', renderGear)
    .on('member-passwords', renderMemberPasswords)
    .on('settings', renderSettings)
    .on('dist-params', renderDistParams)
    .start('dashboard');
  updateHistoryButtons();

  // 소프트 락: 현재 편집 페이지를 백엔드에 등록 + 같은 페이지 다른 관리자 표시
  const route = () => (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/')[0];
  window.addEventListener('hashchange', () => { Locks.enter(route()); DB.refresh(); });
  Locks.enter(route());

  // 다중 사용자 신선도: 페이지 전환·탭 복귀·30초 폴링 시 백그라운드 새로고침(내 편집/모달 중엔 자동 스킵).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') DB.refresh({ merge: !SupabaseBackend.isConfigured() && Roles.isAdmin() });
  });
  if (!SupabaseBackend.isConfigured()) {
    let _poll = 0;
    setInterval(() => {
      if (document.visibilityState === 'visible') DB.refresh({ merge: Roles.isAdmin() && (++_poll % 4 === 0) });
    }, 30000);
  }
}

// Prevent a manual refresh/close from cancelling an in-flight destructive save.
window.addEventListener('beforeunload', (event) => {
  if (!DB._pendingSave) return;
  event.preventDefault();
  event.returnValue = '';
});

main();
