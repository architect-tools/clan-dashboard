// diamond.js — diamond settlement (운영진 + 투력 + 참여도 → 최종정산).
import { DB } from '../db.js';
import { computeSettlement } from '../calc.js';
import { el, fmt, pct, downloadFile, toast } from '../util.js';
import { page, card, table, statCard, btn, classBadge, tierBadge } from './ui.js';

export function renderDiamond() {
  const s = DB.state;
  const res = computeSettlement(s);
  const t = res.totals;

  const body = page('다이아 정산', {
    subtitle: `총 ${fmt(t.total)} 다이아 · 운영진 ${pct(s.settings.staffRatio)} / 투력 ${pct(s.settings.powerRatio)} / 참여도 ${pct(s.settings.participationRatio)}`,
    actions: [
      btn('CSV 내보내기', () => exportCsv(res), { kind: 'ghost' }),
      btn('설정 변경', () => location.hash = '#/settings', { kind: 'ghost' }),
    ],
  });

  // guidance when participation hasn't been tracked yet (all scores 0)
  const activeMembers = s.members.filter((m) => m.active !== false);
  if (activeMembers.length && activeMembers.every((m) => !m.score)) {
    body.appendChild(el('div.banner', {}, [
      el('span', { text: '⚠️' }),
      el('span', { text: '참여점수가 아직 없습니다(전원 F티어). 주간 참여도에서 콘텐츠 참여를 기록한 뒤 “참여점수 산정 → 명단 반영”을 누르면 티어와 다이아가 반영됩니다.' }),
      btn('주간 참여도로', () => location.hash = '#/participation', { kind: 'primary' }),
    ]));
  }

  // ── summary stats ──
  body.appendChild(el('div.stat-grid', {}, [
    statCard('총 다이아', fmt(t.total), { icon: '💎', color: '#38bdf8' }),
    statCard('운영진 합계', fmt(t.staffSum), { sub: pct(s.settings.staffRatio) }),
    statCard('투력 합계', fmt(t.powerSum), { sub: `상위 ${s.powerRanks.length}명` }),
    statCard('참여도 합계', fmt(t.partSum), { sub: pct(s.settings.participationRatio) }),
    statCard(t.shortage > 0 ? '모자른 다이아' : '남는 다이아', fmt(t.shortage > 0 ? t.shortage : t.surplus), {
      icon: res.verification.status === '정상' ? '✅' : '⚠️',
      color: res.verification.status === '정상' ? '#34d399' : '#fbbf24',
      sub: '검증 ' + res.verification.status,
    }),
  ]));

  // ── tier breakdown ──
  body.appendChild(card('티어별 참여 다이아', table([
    { key: 'tier', label: '티어', align: 'center', render: (r) => tierBadge(r.tier) },
    { key: 'mult', label: '배수', align: 'center', render: (r) => '×' + r.mult },
    { key: 'count', label: '인원', align: 'center' },
    { key: 'each', label: '1인당', align: 'right', render: (r) => fmt(r.each) },
    { key: 'subtotal', label: '소계', align: 'right', render: (r) => fmt(r.subtotal) },
  ], res.byTier), { className: 'card-compact' }));

  // ── final settlement table ──
  body.appendChild(card('최종 정산', table([
    { label: '순위', align: 'center', width: '48px', render: (_, i) => el('span.rank', { text: i + 1 }) },
    { key: 'name', label: '닉네임', render: (r) => el('b', { text: r.name }) },
    { label: '직업', render: (r) => classBadge(r.cls) },
    { key: 'powerRank', label: '투력순위', align: 'center', render: (r) => '#' + r.powerRank },
    { label: '티어', align: 'center', render: (r) => tierBadge(r.tier) },
    { key: 'powerDia', label: '투력', align: 'right', render: (r) => r.powerDia ? fmt(r.powerDia) : '–' },
    { key: 'partDia', label: '참여', align: 'right', render: (r) => fmt(r.partDia) },
    { key: 'staffDia', label: '운영진', align: 'right', render: (r) => r.staffDia ? fmt(r.staffDia) : '–' },
    { key: 'total', label: '총 다이아', align: 'right', render: (r) => el('b', { style: { color: '#38bdf8' }, text: fmt(r.total) }) },
  ], res.rows)));
}

function exportCsv(res) {
  const head = ['순위', '닉네임', '직업', '투력순위', '티어', '투력다이아', '참여다이아', '운영진다이아', '총다이아'];
  const lines = [head.join(',')];
  res.rows.forEach((r, i) => lines.push([i + 1, r.name, r.cls, r.powerRank, r.tier, r.powerDia, r.partDia, r.staffDia, r.total].join(',')));
  lines.push(['', '', '', '', '합계', res.totals.powerSum, res.totals.partSum, res.totals.staffSum, res.totals.distributed].join(','));
  downloadFile('다이아정산.csv', '﻿' + lines.join('\n'), 'text/csv');
  toast('CSV를 내보냈습니다');
}
