// distParams.js — 분배 파라미터(정산 계산용): 다이아 분배 비율 · 티어컷 · 고투 ·
// 운영진 · 콘텐츠 점수. 다이아 정산의 "분배 파라미터" 버튼으로 진입(사이드바 설정과 분리).
import { DB } from '../db.js';
import { Roles } from '../roles.js';
import { computeScores } from '../calc.js';
import { el, fmt, toast } from '../util.js';
import { page, card, table, btn, input, comboSelect, field, modal } from './ui.js';

export function renderDistParams() {
  const s = DB.state;
  const applyCurrentParticipationScores = () => {
    const dates = Object.keys(s.participation?.byDate || {}).sort();
    if (!dates.length) return false;
    const range = {
      from: s.participation.scoreFrom || dates[0],
      to: s.participation.scoreTo || dates[dates.length - 1],
    };
    const scores = computeScores(s.participation.byDate, s.contentCatalog, s.members, range);
    s.members.forEach((m) => { m.score = scores[m.id] || 0; });
    s.participation.scoreFrom = range.from;
    s.participation.scoreTo = range.to;
    return true;
  };
  const saveNow = async (message) => {
    const applied = applyCurrentParticipationScores();
    DB.commit();
    const ok = await DB.flushSave();
    if (ok) toast(applied ? `${message} · 참여점수 재계산됨` : message);
  };
  const contentRows = [...s.contentCatalog].sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), 'ko') ||
    String(a.category || '').localeCompare(String(b.category || ''), 'ko'));
  const body = page('분배 파라미터', {
    subtitle: '다이아 분배 비율 · 티어컷 · 고투 · 운영진 · 콘텐츠 점수 — 정산 계산에 쓰이는 값',
    actions: [btn('다이아 정산으로', () => location.hash = '#/diamond', { kind: 'ghost' })],
  });
  if (!Roles.isAdmin()) { body.appendChild(el('div.empty', { text: '분배 파라미터는 관리자만 변경할 수 있습니다. (관리자 비밀번호로 입장하세요)' })); return; }

  // ── 다이아 분배 기준 ──
  const total = input({ type: 'number', value: s.settings.totalDiamonds });
  const staffR = input({ type: 'number', step: '0.1', value: (s.settings.staffRatio * 100).toFixed(1) });
  const powerR = input({ type: 'number', step: '0.1', value: (s.settings.powerRatio * 100).toFixed(1) });
  const partR = input({ type: 'number', step: '0.1', value: (s.settings.participationRatio * 100).toFixed(1) });
  const ratioNote = el('div.hint');
  const checkRatio = () => {
    const sum = (+staffR.value) + (+powerR.value) + (+partR.value);
    ratioNote.textContent = `비율 합계: ${sum.toFixed(1)}% ${Math.abs(sum - 100) < 0.05 ? '' : '100%가 아닙니다'}`;
  };
  [staffR, powerR, partR].forEach((i) => i.addEventListener('input', checkRatio)); checkRatio();

  body.appendChild(card('다이아 분배 기준', el('div', {}, [
    el('div.form-grid', {}, [
      field('총 다이아', total),
      field('운영진 비율 (%)', staffR),
      field('투력 비율 (%)', powerR),
      field('참여도 비율 (%)', partR),
    ]),
    ratioNote,
    btn('저장', () => {
      s.settings.totalDiamonds = +total.value || 0;
      s.settings.staffRatio = (+staffR.value || 0) / 100;
      s.settings.powerRatio = (+powerR.value || 0) / 100;
      s.settings.participationRatio = (+partR.value || 0) / 100;
      DB.commit(); toast('저장되었습니다');
    }, { kind: 'primary' }),
  ])));

  // ── 참여 티어 컷 ──
  body.appendChild(card('참여 티어 컷', el('div', {}, [
    table([
      { key: 'tier', label: '티어', align: 'center' },
      { label: '최소 점수', align: 'right', render: (t) => input({ type: 'number', value: t.minScore, style: { width: '90px' }, onchange: (e) => { t.minScore = +e.target.value || 0; } }) },
      { label: '배수', align: 'right', render: (t) => input({ type: 'number', step: '0.1', value: t.mult, style: { width: '80px' }, onchange: (e) => { t.mult = +e.target.value || 0; } }) },
    ], s.tiers),
    btn('티어 저장', () => { s.tiers.sort((a, b) => b.minScore - a.minScore); DB.commit(); toast('티어 저장됨'); renderDistParams(); }, { kind: 'primary' }),
  ]), { className: 'card-compact' }));

  // ── 투력 상위 비율 (고투) ──
  body.appendChild(card('투력 상위 비율 (고투)', el('div', {}, [
    el('p.hint', { text: '전투력 상위 등수가 받는 비율 (전체 다이아 대비). 합계는 보통 투력 비율과 같습니다.' }),
    table([
      { key: 'rank', label: '순위', align: 'center' },
      { label: '비율 (%)', align: 'right', render: (r) => input({ type: 'number', step: '0.1', value: (r.pct * 100).toFixed(1), style: { width: '90px' }, onchange: (e) => { r.pct = (+e.target.value || 0) / 100; } }) },
      { label: '예상 다이아', align: 'right', render: (r) => fmt(s.settings.totalDiamonds * r.pct) },
    ], s.powerRanks),
    el('div.row-actions', {}, [
      btn('+ 순위 추가', () => { s.powerRanks.push({ rank: s.powerRanks.length + 1, pct: 0 }); DB.commit(); renderDistParams(); }, { kind: 'ghost' }),
      btn('저장', () => { DB.commit(); toast('고투 비율 저장됨'); }, { kind: 'primary' }),
    ]),
  ]), { className: 'card-compact' }));

  // ── 운영진 ──
  body.appendChild(card('운영진', el('div', {}, [
    table([
      { key: 'name', label: '닉네임' },
      { label: '비율 (%)', align: 'right', render: (st) => input({ type: 'number', step: '0.1', value: (st.ratio * 100).toFixed(1), style: { width: '80px' }, onchange: (e) => { st.ratio = (+e.target.value || 0) / 100; } }) },
      { label: '', align: 'right', render: (st) => btn('삭제', () => { s.staff = s.staff.filter((x) => x !== st); DB.commit(); renderDistParams(); }, { kind: 'ghost-danger' }) },
    ], s.staff),
    el('div.row-actions', {}, [
      btn('+ 운영진 추가', () => addStaff(), { kind: 'ghost' }),
      btn('저장', () => { DB.commit(); toast('운영진 저장됨'); }, { kind: 'primary' }),
    ]),
  ]), { className: 'card-compact' }));

  // ── 콘텐츠 점수표 ──
  body.appendChild(card('콘텐츠 점수표', el('div', {}, [
    el('p.hint', { text: '참여 점수 계산에 쓰이는 콘텐츠 목록. 점수 0 또는 비활성은 산정에서 제외됩니다.' }),
    table([
      { key: 'category', label: '분류' },
      { key: 'name', label: '콘텐츠' },
      { label: '점수', align: 'right', render: (c) => input({ type: 'number', value: c.points, style: { width: '72px' }, oninput: (e) => { c.points = +e.target.value || 0; }, onchange: (e) => { c.points = +e.target.value || 0; } }) },
      { label: '주간횟수', align: 'right', render: (c) => input({ type: 'number', value: c.weekly, style: { width: '72px' }, oninput: (e) => { c.weekly = +e.target.value || 0; }, onchange: (e) => { c.weekly = +e.target.value || 0; } }) },
      { label: '활성', align: 'center', render: (c) => el('input', { type: 'checkbox', checked: c.active, onchange: (e) => { c.active = e.target.checked; } }) },
      { label: '', align: 'right', render: (c) => btn('삭제', () => { s.contentCatalog = s.contentCatalog.filter((x) => x !== c); DB.commit(); renderDistParams(); }, { kind: 'ghost-danger' }) },
    ], contentRows),
    el('div.row-actions', {}, [
      btn('+ 콘텐츠 추가', () => addContent(), { kind: 'ghost' }),
      btn('저장', () => saveNow('콘텐츠 저장됨'), { kind: 'primary' }),
    ]),
  ]), { className: 'card-compact' }));

  function addStaff() {
    const names = Roles.selfFirst(s.members.map((m) => m.name).filter(Boolean));
    const name = comboSelect(names, Roles.me() || names[0], { placeholder: '클랜원 검색' });
    const ratio = input({ type: 'number', step: '0.1', value: '1.3' });
    modal('운영진 추가', (close) => el('div.form', {}, [
      field('닉네임', name), field('비율 (%)', ratio),
      el('div.modal-actions', {}, [btn('취소', close), btn('추가', () => { s.staff.push({ name: name.value, ratio: (+ratio.value || 0) / 100 }); DB.commit(); close(); renderDistParams(); }, { kind: 'primary' })]),
    ]));
  }
  function addContent() {
    const cat = input({ value: '기타' }); const nm = input({ placeholder: '콘텐츠명' });
    const pt = input({ type: 'number', value: 0 }); const wk = input({ type: 'number', value: 1 });
    modal('콘텐츠 추가', (close) => el('div.form', {}, [
      field('분류', cat), field('콘텐츠명', nm), field('점수', pt), field('주간 횟수', wk),
      el('div.modal-actions', {}, [btn('취소', close), btn('추가', () => { if (!nm.value.trim()) return toast('이름 입력', 'error'); s.contentCatalog.push({ category: cat.value || '기타', name: nm.value.trim(), points: +pt.value || 0, weekly: +wk.value || 1, active: (+pt.value || 0) > 0 }); DB.commit(); close(); renderDistParams(); }, { kind: 'primary' })]),
    ]));
  }
}
