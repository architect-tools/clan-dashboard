// members.js — roster CRUD (이름/직업/전투력/참여점수).
import { DB, Mutations } from '../db.js';
import { tierForScore } from '../calc.js';
import { el, fmt, toast } from '../util.js';
import { CLASS_LIST } from '../config.js';
import { page, card, table, btn, modal, field, input, select, classBadge, tierBadge, confirmDialog } from './ui.js';

let q = '', sortKey = 'power', sortDir = -1, classFilter = '';

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

  const body = page('명단 관리', {
    subtitle: `클랜원 ${s.members.filter((m) => m.active !== false).length}명 · 직업/전투력/참여점수 관리`,
    actions: [
      btn('+ 클랜원 추가', () => editMember(null), { kind: 'primary' }),
    ],
  });

  body.appendChild(el('div.toolbar', {}, [search, clsSel]));

  const head = (key, label) => el('span.sortable', {
    class: sortKey === key ? 'sorted' : '', onclick: () => { setSort(key); },
    text: label + (sortKey === key ? (sortDir < 0 ? ' ▼' : ' ▲') : ''),
  });

  body.appendChild(card(null, table([
    { key: 'order', label: '순번', align: 'center', width: '52px' },
    { label: head('name', '닉네임'), key: 'name', render: (m) => el('b', { text: m.name }) },
    { label: '직업', key: 'cls', render: (m) => classBadge(m.cls) },
    { label: head('power', '전투력'), align: 'right', render: (m) => el('span', { text: m.power.toLocaleString() }) },
    { label: head('score', '참여점수'), align: 'right', render: (m) => el('span', { text: fmt(m.score) }) },
    { label: '티어', align: 'center', render: (m) => tierBadge(m.tier) },
    { label: '상태', align: 'center', render: (m) => el('span.dot', { class: m.active !== false ? 'on' : 'off', title: m.active !== false ? '활동' : '휴면' }) },
    { label: '', align: 'right', width: '92px', render: (m) => el('div.row-actions', {}, [
      btn('수정', () => editMember(m), { kind: 'ghost' }),
      btn('삭제', () => confirmDialog(`${m.name} 님을 삭제할까요?`, () => { Mutations.removeMember(m.id); DB.commit(); toast('삭제되었습니다'); refresh(); }, { danger: true, yesText: '삭제' }), { kind: 'ghost-danger' }),
    ]) },
  ], rows, { empty: '클랜원이 없습니다.' })));

  function refresh() { renderMembers(); }
  function setSort(k) { if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = (k === 'name') ? 1 : -1; } refresh(); }
}

function editMember(m) {
  const isNew = !m;
  const name = input({ value: m?.name || '', placeholder: '닉네임' });
  const cls = select(CLASS_LIST, m?.cls || CLASS_LIST[0]);
  const power = input({ type: 'number', step: '0.1', value: m?.power ?? '', placeholder: '예: 96.2' });
  const score = input({ type: 'number', value: m?.score ?? '', placeholder: '0~200' });
  const note = input({ value: m?.note || '', placeholder: '메모(선택)' });
  const active = el('input', { type: 'checkbox', checked: m ? m.active !== false : true });

  modal(isNew ? '클랜원 추가' : '클랜원 수정', (close) => el('div.form', {}, [
    field('닉네임', name),
    field('직업', cls),
    field('전투력', power),
    field('참여점수', score),
    field('메모', note),
    el('label.field.field-inline', {}, [active, el('span', { text: '활동 중' })]),
    el('div.modal-actions', {}, [
      btn('취소', close),
      btn('저장', () => {
        if (!name.value.trim()) return toast('닉네임을 입력하세요', 'error');
        Mutations.upsertMember({ id: m?.id, name: name.value.trim(), cls: cls.value,
          power: +power.value || 0, score: +score.value || 0, note: note.value.trim(), active: active.checked });
        DB.commit(); toast('저장되었습니다'); close(); renderMembers();
      }, { kind: 'primary' }),
    ]),
  ]));
}
