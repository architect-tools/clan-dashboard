// gear.js — 장비/숙련 현황: flexible per-member status boards.
// Covers the source sheets' tracking tabs (무기 숙련, 장비 현황, 주문석,
// 성좌/탈것/표본, 엘릭서&패시브 …) as editable boards: rows = members, custom columns.
import { DB } from '../db.js';
import { Roles } from '../roles.js';
import { el, toast, uid } from '../util.js';
import { page, card, btn, input, select, modal, field, confirmDialog } from './ui.js';
import { equipGrid } from './equip.js';

let activeBoard = 0, gearMember = null;

export function renderGear() {
  const s = DB.state;
  const adm = Roles.isAdmin();
  if (!s.statusBoards) s.statusBoards = [];
  if (!s.statusBoards.length) seedDefaultBoards(s); // first run

  if (activeBoard >= s.statusBoards.length) activeBoard = 0;
  const board = s.statusBoards[activeBoard];

  const body = page('장비/숙련 현황', {
    subtitle: '장착 장비(슬롯) + 무기 숙련·주문석·성좌 등 클랜원별 현황',
    actions: [btn('+ 보드 추가', () => addBoard(), { kind: 'primary', admin: true })],
  });

  // ── 장착 장비 (구조화 슬롯, 게임 장비창 레이아웃) ──
  const me = Roles.me();
  const activeMembers = Roles.selfFirst(s.members.filter((m) => m.active !== false)); // 본인 먼저
  if (activeMembers.length) {
    if (!gearMember || !activeMembers.some((m) => m.id === gearMember)) gearMember = activeMembers[0].id; // 기본 = 본인
    const selMember = activeMembers.find((m) => m.id === gearMember);
    const canEditSel = adm || Roles.isMe(selMember.name); // 멤버는 본인 장비만 편집
    const picker = select(activeMembers.map((m) => ({ value: String(m.id), label: m.name + (Roles.isMe(m.name) ? ' (나)' : '') })), String(gearMember),
      { onchange: (e) => { gearMember = +e.target.value; renderGear(); } });
    body.appendChild(card('장착 장비', el('div', {}, [
      el('div.toolbar', {}, [el('span.muted', { text: '클랜원' }), picker, canEditSel ? el('span.hint', { text: '슬롯을 클릭해 등급·티어·강화 입력' }) : el('span.hint', { text: '본인 장비만 편집할 수 있습니다' })]),
      equipGrid(selMember, { editable: canEditSel }),
    ])));
  }

  // ── 기타 현황 보드 (무기 숙련·주문석·성좌 등) ──
  body.appendChild(el('div.modal-sec', { text: '기타 현황 보드' }));

  // board tabs
  const tabs = el('div.board-tabs', {}, s.statusBoards.map((b, i) =>
    el('button.board-tab', { class: i === activeBoard ? 'active' : '', onclick: () => { activeBoard = i; renderGear(); } }, [
      el('span', { text: b.name }),
    ])));
  body.appendChild(tabs);

  if (!board) { body.appendChild(el('div.empty', { text: '보드를 추가하세요.' })); return; }

  const members = Roles.selfFirst(s.members.filter((m) => m.active !== false)); // 본인 행 먼저
  const tbl = el('table.tbl');
  const headCells = [el('th.sticky-col', { text: '닉네임' }), el('th', { text: '직업', style: { width: '80px' } })];
  board.columns.forEach((col) => headCells.push(el('th', {}, [
    el('span', { text: col }),
    adm ? el('button.col-x', { title: '열 삭제', text: '✕', onclick: () => { board.columns = board.columns.filter((c) => c !== col); DB.commit(); renderGear(); } }) : null,
  ])));
  headCells.push(el('th', { style: { width: '40px' } }, [
    adm ? el('button.col-add', { title: '열 추가', text: '+', onclick: () => addColumn(board) }) : null]));
  tbl.appendChild(el('thead', {}, el('tr', {}, headCells)));

  const tb = el('tbody');
  members.forEach((m) => {
    const row = el('tr', {}, [
      el('td.sticky-col', {}, [el('b', { text: m.name })]),
      el('td', { class: 'muted', text: m.cls || '-' }),
    ]);
    const rec = (board.data[m.id] ||= {});
    const canEditRow = adm || Roles.isMe(m.name); // 멤버는 본인 행만 편집
    board.columns.forEach((col) => {
      const cell = canEditRow
        ? input({ value: rec[col] ?? '', placeholder: '-', class: 'cell-input', onchange: (e) => { rec[col] = e.target.value; DB.commit(); } })
        : el('span', { class: rec[col] ? '' : 'muted', text: rec[col] || '-' });
      row.appendChild(el('td', {}, [cell]));
    });
    row.appendChild(el('td'));
    tb.appendChild(row);
  });
  tbl.appendChild(tb);

  body.appendChild(card(null, el('div.table-wrap', {}, [tbl]), { className: 'card-flush' }));
  body.appendChild(el('div.toolbar', {}, [
    btn('+ 열 추가', () => addColumn(board), { kind: 'ghost', admin: true }),
    btn('이름 변경', () => renameBoard(board), { kind: 'ghost', admin: true }),
    btn('보드 삭제', () => confirmDialog(`'${board.name}' 보드를 삭제할까요?`, () => { s.statusBoards.splice(activeBoard, 1); activeBoard = 0; DB.commit(); renderGear(); }, { danger: true, yesText: '삭제' }), { kind: 'ghost-danger', admin: true }),
  ]));
}

function addColumn(board) {
  const name = input({ placeholder: '예: 주무기 / 보유 / 단계' });
  modal('열 추가', (close) => el('div.form', {}, [field('열 이름', name),
    el('div.modal-actions', {}, [btn('취소', close), btn('추가', () => {
      const v = name.value.trim(); if (!v) return toast('이름 입력', 'error');
      if (board.columns.includes(v)) return toast('이미 있는 열', 'error');
      board.columns.push(v); DB.commit(); close(); renderGear();
    }, { kind: 'primary' })])]));
}
function renameBoard(board) {
  const name = input({ value: board.name });
  modal('보드 이름 변경', (close) => el('div.form', {}, [field('이름', name),
    el('div.modal-actions', {}, [btn('취소', close), btn('저장', () => { board.name = name.value.trim() || board.name; DB.commit(); close(); renderGear(); }, { kind: 'primary' })])]));
}
function addBoard() {
  const name = input({ placeholder: '예: 장비 현황 / 주문석 / 성좌·탈것' });
  const cols = input({ placeholder: '열 이름들, 쉼표로 구분 (예: 무기,방어구,장신구)' });
  modal('보드 추가', (close) => el('div.form', {}, [field('보드 이름', name), field('열 (쉼표 구분)', cols),
    el('div.modal-actions', {}, [btn('취소', close), btn('추가', () => {
      const v = name.value.trim(); if (!v) return toast('이름 입력', 'error');
      const columns = cols.value.split(',').map((x) => x.trim()).filter(Boolean);
      DB.state.statusBoards.push({ id: uid(), name: v, columns: columns.length ? columns : ['상태'], data: {} });
      activeBoard = DB.state.statusBoards.length - 1; DB.commit(); close(); renderGear();
    }, { kind: 'primary' })])]));
}

// seed boards from source sheets (무기 숙련 from weaponProgress) on first visit
function seedDefaultBoards(s) {
  const wpByName = Object.fromEntries((s.weaponProgress || []).map((w) => [w.name, w]));
  const weapon = { id: uid(), name: '무기 숙련', columns: ['주무기', '보조', '보조2'], data: {} };
  s.members.forEach((m) => {
    const w = wpByName[m.name];
    if (w) weapon.data[m.id] = { 주무기: w.main || '', 보조: w.sub1 || '', 보조2: w.sub2 || '' };
  });
  s.statusBoards.push(weapon);
  s.statusBoards.push({ id: uid(), name: '장비 현황', columns: ['무기', '방어구', '장신구'], data: {} });
  s.statusBoards.push({ id: uid(), name: '주문석·성좌·탈것', columns: ['주문석', '성좌', '탈것', '표본'], data: {} });
  DB.commit({ history: false });
}
