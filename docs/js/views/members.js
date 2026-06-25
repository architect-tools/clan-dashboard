// members.js — roster CRUD (이름/직업/전투력/참여점수).
import { DB, Mutations } from '../db.js';
import { tierForScore, attendanceCount } from '../calc.js';
import { el, fmt, toast } from '../util.js';
import { CLASS_LIST, CLASSES } from '../config.js';
import { page, card, table, btn, modal, field, input, select, classBadge, tierBadge, confirmDialog } from './ui.js';
import { equipGrid } from './equip.js';

const GRADES = ['운영진', '정회원', '준회원', '신입'];
let q = '', sortKey = 'power', sortDir = -1, classFilter = '', quickEdit = false;

export function renderMembers() {
  const s = DB.state;
  const tiers = s.tiers;
  let rows = s.members.map((m) => ({ ...m, tier: tierForScore(m.score, tiers) }));
  if (q) rows = rows.filter((m) => m.name.includes(q));
  if (classFilter) rows = rows.filter((m) => m.cls === classFilter);
  rows.sort((a, b) => {
    const v = (typeof a[sortKey] === 'string') ? a[sortKey].localeCompare(b[sortKey]) : (a[sortKey] - b[sortKey]);
    return v * sortDir;
  });

  const search = input({ placeholder: '닉네임 검색', value: q, oninput: (e) => { q = e.target.value; refresh(); } });
  const clsSel = select(['전체 직업', ...CLASS_LIST].map((c) => ({ value: c === '전체 직업' ? '' : c, label: c })), classFilter,
    { onchange: (e) => { classFilter = e.target.value; refresh(); } });

  const active = s.members.filter((m) => m.active !== false);
  const body = page('명단 관리', {
    subtitle: `클랜원 ${active.length}명 · 직업/전투력/참여점수 관리`,
    actions: [
      btn(quickEdit ? '빠른편집 끄기' : '빠른편집', () => { quickEdit = !quickEdit; refresh(); }, { kind: quickEdit ? 'primary' : 'ghost' }),
      btn('+ 여러명 추가', () => bulkAdd(), { kind: 'ghost' }),
      btn('+ 클랜원 추가', () => editMember(null), { kind: 'primary' }),
    ],
  });

  // summary chips: 직업 분포 + 평균 전투력
  const byClass = {};
  active.forEach((m) => { byClass[m.cls] = (byClass[m.cls] || 0) + 1; });
  body.appendChild(el('div.chips.summary-chips', {},
    [el('span.chip', { text: `총 ${active.length}명` }),
     el('span.chip', { text: `평균투력 ${fmt(active.reduce((a, m) => a + m.power, 0) / (active.length || 1))}` }),
     ...CLASS_LIST.filter((c) => byClass[c]).map((c) => el('span.chip.cls-chip', { style: { '--c': (CLASSES[c] || {}).color }, text: `${c} ${byClass[c]}` }))]));

  body.appendChild(el('div.toolbar', {}, [search, clsSel,
    quickEdit ? el('span.hint', { text: '셀을 직접 수정 → 자동 저장' }) : null]));

  const head = (key, label) => el('span.sortable', {
    class: sortKey === key ? 'sorted' : '', onclick: () => { setSort(key); },
    text: label + (sortKey === key ? (sortDir < 0 ? ' ▼' : ' ▲') : ''),
  });
  const numCell = (m, key) => quickEdit
    ? input({ type: 'number', step: key === 'power' ? '0.1' : '1', value: m[key], class: 'cell-input', style: { width: '84px', textAlign: 'right' },
        onchange: (e) => { Mutations.upsertMember({ id: m.id, [key]: +e.target.value || 0 }); DB.commit(); if (key === 'score') refresh(); } })
    : el('span', { text: key === 'score' ? fmt(m.score) : m.power.toLocaleString() });

  body.appendChild(card(null, table([
    { key: 'order', label: '순번', align: 'center', width: '52px' },
    { label: head('name', '닉네임'), key: 'name', render: (m) => el('div.name-cell', {}, [
      el('b.member-link', { text: m.name, title: '클릭 → 상세', onclick: () => openMemberDetail(m) }),
      m.grade ? el('span.grade-badge', { class: gradeCls(m.grade), text: m.grade }) : null,
    ]) },
    { label: '직업', key: 'cls', render: (m) => quickEdit
        ? select(CLASS_LIST, m.cls, { class: 'cell-input', onchange: (e) => { Mutations.upsertMember({ id: m.id, cls: e.target.value }); DB.commit(); } })
        : classBadge(m.cls) },
    { label: head('power', '전투력'), align: 'right', render: (m) => numCell(m, 'power') },
    { label: head('score', '참여점수'), align: 'right', render: (m) => numCell(m, 'score') },
    { label: '티어', align: 'center', render: (m) => tierBadge(m.tier) },
    { label: '상태', align: 'center', render: (m) => el('span.dot', { class: m.active !== false ? 'on' : 'off', title: m.active !== false ? '활동' : '휴면' }) },
    { label: '', align: 'right', render: (m) => el('div.row-actions.nowrap', {}, [
      btn('수정', () => editMember(m), { kind: 'ghost' }),
      btn('삭제', () => confirmDialog(`${m.name} 님을 삭제할까요?`, () => { Mutations.removeMember(m.id); DB.commit(); toast('삭제되었습니다'); refresh(); }, { danger: true, yesText: '삭제' }), { kind: 'ghost-danger' }),
    ]) },
  ], rows, { empty: '클랜원이 없습니다.' })));

  function refresh() { renderMembers(); }
  function setSort(k) { if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = (k === 'name') ? 1 : -1; } refresh(); }
}

function bulkAdd() {
  const ta = el('textarea.input', { rows: 10, placeholder: '한 줄에 한 명씩\n예) 닉네임\n또는) 닉네임, 직업, 전투력\n붉으래, 암살자, 128\n보스' , style: { width: '100%', fontFamily: 'inherit', resize: 'vertical' } });
  modal('여러 명 추가 (붙여넣기)', (close) => el('div.form', {}, [
    el('p.hint', { text: '게임 클랜 명단을 그대로 붙여넣으세요. 한 줄에 한 명. “닉네임, 직업, 전투력” 형식도 인식합니다.' }),
    ta,
    el('div.modal-actions', {}, [
      btn('취소', close),
      btn('추가', () => {
        const lines = ta.value.split('\n').map((l) => l.trim()).filter(Boolean);
        let n = 0;
        for (const line of lines) {
          const parts = line.split(/[\t,]|\s{2,}/).map((x) => x.trim()).filter(Boolean);
          const name = parts[0]; if (!name) continue;
          const cls = parts.find((p) => CLASS_LIST.includes(p)) || '';
          const power = parts.map((p) => parseFloat(p)).find((x) => Number.isFinite(x)) || 0;
          Mutations.upsertMember({ name, cls, power, score: 0 });
          n++;
        }
        if (!n) return toast('추가할 이름이 없습니다', 'error');
        DB.commit(); toast(`${n}명 추가되었습니다`); close(); renderMembers();
      }, { kind: 'primary' }),
    ]),
  ]));
}

function editMember(m) {
  const isNew = !m;
  const name = input({ value: m?.name || '', placeholder: '닉네임' });
  const cls = select(CLASS_LIST, m?.cls || CLASS_LIST[0]);
  const grade = select([...new Set([...GRADES, m?.grade].filter(Boolean))], m?.grade || '정회원');
  const power = input({ type: 'number', step: '0.1', value: m?.power ?? '', placeholder: '예: 96.2' });
  const score = input({ type: 'number', value: m?.score ?? '', placeholder: '0~200' });
  const note = input({ value: m?.note || '', placeholder: '메모(선택)' });
  const active = el('input', { type: 'checkbox', checked: m ? m.active !== false : true });

  modal(isNew ? '클랜원 추가' : '클랜원 수정', (close) => el('div.form', {}, [
    field('닉네임', name),
    field('직업', cls),
    field('등급', grade),
    field('전투력', power),
    field('참여점수', score),
    field('메모', note),
    el('label.field.field-inline', {}, [active, el('span', { text: '활동 중' })]),
    el('div.modal-actions', {}, [
      btn('취소', close),
      btn('저장', () => {
        if (!name.value.trim()) return toast('닉네임을 입력하세요', 'error');
        Mutations.upsertMember({ id: m?.id, name: name.value.trim(), cls: cls.value, grade: grade.value,
          power: +power.value || 0, score: +score.value || 0, note: note.value.trim(), active: active.checked });
        DB.commit(); toast('저장되었습니다'); close(); renderMembers();
      }, { kind: 'primary' }),
    ]),
  ]));
}

const gradeCls = (g) => g === '운영진' ? 'g-staff' : g === '신입' ? 'g-new' : '';
const mdStat = (label, value) => el('div.md-stat', {}, [el('div.md-stat-v', { text: value }), el('div.md-stat-l', { text: label })]);

// ── 클랜원 통합 상세 (봇 /클랜원조회): 기본·참여·다이아·장비를 한 화면에 ──
function openMemberDetail(m) {
  const s = DB.state;
  const tier = tierForScore(m.score || 0, s.tiers);

  // 다이아 내역 (분배 확정 기록에서)
  const dia = [];
  for (const st of (s.settlements || [])) {
    const e = (st.entries || []).find((x) => x.memberId === m.id);
    if (e) dia.push({ period: `${st.from || '?'}~${st.to || '?'}`, power: e.powerDia, part: e.partDia, staff: e.staffDia, total: e.total });
  }
  const diaTotal = dia.reduce((a, d) => a + d.total, 0);

  // 최근 참여 (날짜 내림차순, 최대 14)
  const recent = [];
  for (const date of Object.keys(s.participation.byDate).sort().reverse()) {
    const day = s.participation.byDate[date];
    for (const content of Object.keys(day)) if (day[content].includes(m.id)) recent.push({ date, content });
    if (recent.length >= 14) break;
  }
  const attTotal = attendanceCount(s.participation.byDate, m.id);

  // 장비/현황 (비어있지 않은 보드만)
  const boards = (s.statusBoards || []).map((b) => ({
    name: b.name,
    cells: (b.columns || []).map((c) => ({ col: c, val: ((b.data?.[m.id]?.[c]) || '').trim() })).filter((x) => x.val),
  })).filter((b) => b.cells.length);

  modal(m.name, (close) => el('div.member-detail', {}, [
    el('div.md-head', {}, [
      classBadge(m.cls),
      m.grade ? el('span.grade-badge', { class: gradeCls(m.grade), text: m.grade }) : null,
      tierBadge(tier),
      el('span.dot', { class: m.active !== false ? 'on' : 'off' }),
      el('span.muted', { text: m.active !== false ? '활동 중' : '휴면' }),
    ]),

    el('div.modal-sec', { text: '기본' }),
    el('div.md-grid', {}, [
      mdStat('전투력', m.power.toLocaleString()),
      mdStat('참여점수', fmt(m.score || 0)),
      mdStat('티어', tier),
      mdStat('등급', m.grade || '–'),
      mdStat('순번', String(m.order ?? '–')),
      mdStat('누적 다이아', fmt(diaTotal)),
    ]),
    m.note ? el('p.hint', { text: '메모: ' + m.note }) : null,

    el('div.modal-sec', { text: `최근 참여 · 누적 ${attTotal}회` }),
    recent.length
      ? el('div.chips', {}, recent.map((r) => el('span.chip', { text: `${r.date.slice(5)} ${r.content}` })))
      : el('div.empty.small', { text: '참여 기록 없음' }),

    el('div.modal-sec', { text: `다이아 내역 · 누적 ${fmt(diaTotal)}` }),
    dia.length
      ? table([
        { key: 'period', label: '기간' },
        { key: 'power', label: '투력', align: 'right', render: (d) => fmt(d.power) },
        { key: 'part', label: '참여', align: 'right', render: (d) => fmt(d.part) },
        { key: 'staff', label: '운영진', align: 'right', render: (d) => d.staff ? fmt(d.staff) : '–' },
        { key: 'total', label: '총', align: 'right', render: (d) => el('b', { style: { color: 'var(--primary)' }, text: fmt(d.total) }) },
      ], dia)
      : el('div.empty.small', { text: '받은 다이아 없음' }),

    el('div.modal-sec', { text: '장착 장비' }),
    equipGrid(m, { editable: true }),
    boards.length ? el('div.modal-sec', { text: '기타 현황' }) : null,
    boards.length ? el('div', {}, boards.map((b) => el('div.md-board', {}, [
      el('b', { text: b.name }),
      el('div.chips', {}, b.cells.map((c) => el('span.chip', { text: `${c.col}: ${c.val}` }))),
    ]))) : null,
  ]), {
    wide: 'x',
    headerActions: (close) => [btn('편집', () => { close(); editMember(m); })],
  });
}
