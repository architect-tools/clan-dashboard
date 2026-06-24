// dashboard.js — overview: clan stats, tier distribution, top lists.
import { DB } from '../db.js';
import { computeSettlement, tierForScore } from '../calc.js';
import { el, fmt } from '../util.js';
import { CONFIG, TIER_COLORS, CLASSES } from '../config.js';
import { page, card, statCard, table, classBadge, tierBadge, btn } from './ui.js';

export function renderDashboard() {
  const s = DB.state;
  const members = s.members.filter((m) => m.active !== false);
  const res = computeSettlement(s);
  const live = !!CONFIG.APPS_SCRIPT_URL;

  const body = page(`${s.meta?.clanName || ''} 클랜 대시보드`, {
    subtitle: new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }),
    actions: [
      el('span.mode-pill', { class: live ? 'live' : 'local', text: live ? '☁ 클라우드 동기화' : '💾 로컬 저장' }),
    ],
  });

  // ── top stats ──
  const tierCount = res.tierCount;
  body.appendChild(el('div.stat-grid', {}, [
    statCard('클랜원', fmt(members.length), { icon: '👥', sub: `휴면 ${s.members.length - members.length}명` }),
    statCard('총 다이아', fmt(s.settings.totalDiamonds), { icon: '💎', color: '#38bdf8' }),
    statCard('평균 전투력', fmt(members.reduce((a, m) => a + m.power, 0) / (members.length || 1)), { icon: '⚔️' }),
    statCard('S/A 티어', fmt((tierCount.S || 0) + (tierCount.A || 0)), { icon: '🏆', color: '#fbbf24', sub: `S ${tierCount.S || 0} · A ${tierCount.A || 0}` }),
  ]));

  // ── tier distribution bar ──
  const tierBar = el('div.tier-bar');
  s.tiers.forEach((t) => {
    const n = tierCount[t.tier] || 0;
    if (!n) return;
    tierBar.appendChild(el('div.tier-seg', {
      style: { flex: n, background: TIER_COLORS[t.tier] }, title: `${t.tier}: ${n}명`,
    }, [el('span', { text: `${t.tier} ${n}` })]));
  });

  // ── class distribution ──
  const byClass = {};
  members.forEach((m) => { byClass[m.cls] = (byClass[m.cls] || 0) + 1; });
  const classBar = el('div.tier-bar');
  Object.entries(byClass).sort((a, b) => b[1] - a[1]).forEach(([cls, n]) => {
    classBar.appendChild(el('div.tier-seg', { style: { flex: n, background: (CLASSES[cls] || {}).color || '#888' }, title: `${cls}: ${n}명` }, [el('span', { text: `${(CLASSES[cls] || {}).tag || cls} ${n}` })]));
  });

  body.appendChild(el('div.col-2', {}, [
    card('티어 분포', tierBar, { className: 'card-compact' }),
    card('직업 분포', classBar, { className: 'card-compact' }),
  ]));

  // ── top combat power & top participation ──
  const topPower = [...members].sort((a, b) => b.power - a.power).slice(0, 8);
  const topPart = [...members].sort((a, b) => b.score - a.score).slice(0, 8);
  body.appendChild(el('div.col-2', {}, [
    card('전투력 TOP 8', table([
      { label: '#', align: 'center', width: '36px', render: (_, i) => i + 1 },
      { key: 'name', label: '닉네임', render: (m) => el('b', { text: m.name }) },
      { label: '직업', render: (m) => classBadge(m.cls) },
      { key: 'power', label: '전투력', align: 'right', render: (m) => m.power.toLocaleString() },
    ], topPower), { className: 'card-compact', actions: btn('명단 전체', () => location.hash = '#/members', { kind: 'ghost' }) }),
    card('참여점수 TOP 8', table([
      { label: '#', align: 'center', width: '36px', render: (_, i) => i + 1 },
      { key: 'name', label: '닉네임', render: (m) => el('b', { text: m.name }) },
      { label: '티어', align: 'center', render: (m) => tierBadge(tierForScore(m.score, s.tiers)) },
      { key: 'score', label: '점수', align: 'right', render: (m) => fmt(m.score) },
    ], topPart), { className: 'card-compact', actions: btn('참여도 관리', () => location.hash = '#/participation', { kind: 'ghost' }) }),
  ]));
}
