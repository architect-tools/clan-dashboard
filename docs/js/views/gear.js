// gear.js — 장비/숙련 현황: flexible per-member status boards.
// Covers the source sheets' tracking tabs (무기 숙련, 장비 현황, 주문석,
// 성좌/탈것/표본, 엘릭서&패시브 …) as editable boards: rows = members, custom columns.
import { DB } from '../db.js';
import { Roles } from '../roles.js';
import { CLASS_LIST } from '../config.js';
import { el, toast, uid, clear } from '../util.js';
import { page, card, btn, input, select, comboSelect, modal, field, confirmDialog, classBadge } from './ui.js';
import { equipGrid, equipCell, editSlot, EQUIP_GROUPS } from './equip.js';
import { classGroups } from '../skills-data.js';
import { COMMON_SPELLSTONES } from '../common-stones.js';
import { skillIcon, commonStoneIcon } from '../items-index.js';

let gearMember = null;
const skillIdx = {}; // 주문석·엘릭서 캐러셀에서 선택한 직업 인덱스(재렌더에도 유지)

export function renderGear() {
  const s = DB.state;
  const adm = Roles.isAdmin();
  if (!s.statusBoards) s.statusBoards = [];
  if (!s.statusBoards.length) seedDefaultBoards(s); // first run

  const body = page('장비/캐릭터 현황', {
    subtitle: '장착 장비(슬롯·표) + 주문석·성좌·탈것·엘릭서 등 클랜원별 현황',
    actions: [btn('+ 보드 추가', () => addBoard(), { kind: 'primary', admin: true })],
  });

  // ── 상단 고정 섹션 네비 (스크롤 위치 무관) — 표가 많아 섹션 점프 ──
  const sections = [];
  const navBar = el('div.gear-nav');
  body.appendChild(navBar);
  const addSection = (id, label, node) => {
    if (!node) return;
    node.id = id; node.classList.add('gear-section');
    sections.push({ id, label });
    body.appendChild(node);
  };

  // ── 장착 장비 (구조화 슬롯, 게임 장비창 레이아웃) ──
  const me = Roles.me();
  const activeMembers = Roles.selfFirst(s.members.filter((m) => m.active !== false)); // 본인 먼저
  if (activeMembers.length) {
    if (!gearMember || !activeMembers.some((m) => m.id === gearMember)) gearMember = activeMembers[0].id; // 기본 = 본인
    const selMember = activeMembers.find((m) => m.id === gearMember);
    const canEditSel = adm || Roles.isMe(selMember.name); // 멤버는 본인 장비만 편집
    const picker = comboSelect(activeMembers.map((m) => ({ value: String(m.id), label: m.name + (Roles.isMe(m.name) ? ' (나)' : '') })), String(gearMember),
      { placeholder: '클랜원 검색', onchange: (e) => { gearMember = +e.target.value; renderGear(); } });
    addSection('gear-equip', '장착 장비', card('장착 장비', el('div', {}, [
      el('div.toolbar', {}, [el('span.muted', { text: '클랜원' }), picker, canEditSel ? el('span.hint', { text: '슬롯을 클릭해 등급·티어·강화 입력' }) : el('span.hint', { text: '본인 장비만 편집할 수 있습니다' })]),
      equipGrid(selMember, { editable: canEditSel }),
    ])));
  }

  // ── 장비 현황 (장착 장비를 멤버×슬롯 엑셀 표로 — 셀 클릭해 편집) ──
  // 셀 고정폭(colgroup) + 그룹 헤더(무기/방어구/장신구/성유물). 성유물은 강화가 없어 좁게.
  if (activeMembers.length) {
    const eqTbl = el('table.tbl.equip-status-tbl');
    const cg = [el('col.col-name'), el('col.col-class')];
    EQUIP_GROUPS.forEach((g) => g.slots.forEach(() => cg.push(el('col', { class: g.label === '성유물' ? 'col-relic' : '' }))));
    eqTbl.appendChild(el('colgroup', {}, cg));
    const h1 = [el('th.col-name', { rowspan: '2', text: '닉네임' }), el('th.col-class', { rowspan: '2', text: '직업' })];
    EQUIP_GROUPS.forEach((g) => h1.push(el('th', { class: 'grp-start', colspan: String(g.slots.length), text: g.label })));
    const h2 = [];
    EQUIP_GROUPS.forEach((g) => g.slots.forEach((slot, i) => h2.push(el('th', { class: i === 0 ? 'grp-start' : '', title: slot, text: slot }))));
    eqTbl.appendChild(el('thead', {}, [el('tr', {}, h1), el('tr', {}, h2)]));
    const tb2 = el('tbody');
    activeMembers.forEach((m) => {
      const canEditRow = adm || Roles.isMe(m.name); // 관리자 전체, 멤버는 본인 행
      const tr = el('tr', { class: Roles.isMe(m.name) ? 'me-row' : '' }, [
        el('td.col-name', {}, [el('b', { text: m.name })]),
        el('td.col-class', {}, [classBadge(m.cls)]),
      ]);
      EQUIP_GROUPS.forEach((g) => g.slots.forEach((slot, i) => {
        const c = equipCell(slot, (m.equip || {})[slot]);
        tr.appendChild(el('td', {
          class: (i === 0 ? 'grp-start' : '') + (canEditRow ? ' editable' : ''),
          style: { textAlign: 'center', cursor: canEditRow ? 'pointer' : 'default' },
          title: canEditRow ? `${slot} 편집` : '',
          onclick: canEditRow ? () => editSlot(m, slot, () => renderGear()) : null,
        }, [c.text ? el('span', { style: c.color ? { color: c.color, fontWeight: '600' } : {}, text: c.text }) : el('span.muted', { text: canEditRow ? '＋' : '·' })]));
      }));
      tb2.appendChild(tr);
    });
    eqTbl.appendChild(tb2);
    addSection('gear-equipstatus', '장비 현황', card('장비 현황', el('div.scroll-tbl', {}, [eqTbl]),
      { className: 'card-flush', actions: el('span.hint', { text: adm ? '셀 클릭 → 편집' : '본인 행 클릭 → 편집' }) }));
  }

  // ── 주문석 / 엘릭서 (직업별 전용 표, 원문 시트 그대로) ──
  addSection('gear-spellstone', '주문석', renderSkillSection('주문석', 'spellstone'));
  addSection('gear-elixir', '엘릭서', renderSkillSection('엘릭서', 'elixir'));

  // ── 기타 현황 보드 (성좌·탈것·플랫폼) — 각각 분리된 섹션(멀티탭 아님) ──
  s.statusBoards.forEach((board, i) => addSection('gear-board-' + i, board.name, renderBoardCard(board, i)));

  // ── 상단 네비 채우기 ──
  navBar.appendChild(el('span.gear-nav-label', { text: '바로가기' }));
  sections.forEach((sec) => navBar.appendChild(el('button.gear-nav-link', {
    type: 'button', text: sec.label,
    onclick: () => { const t = document.getElementById(sec.id); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
  })));

  // 주문석·엘릭서: 직업 탭(+ '공용' 탭)으로 한 직업씩 가로 슬라이드 전환. 스크롤뷰 없음.
  // 직업 탭은 최다 인원 직업에 맞춘 고정 높이(전환 시 안 흔들림). '공용'은 전원 표라 자연 높이.
  function renderSkillSection(cat, kind) {
    const withMembers = CLASS_LIST.filter((cls) => s.members.some((m) => m.active !== false && m.cls === cls));
    if (!withMembers.length) return card(cat, el('div.empty.small', { text: '활동 클랜원이 없습니다.' }), { className: 'card-flush' });
    const keys = ['공용', ...withMembers];
    const maxRows = Math.max(1, ...withMembers.map((cls) => s.members.filter((m) => m.active !== false && m.cls === cls).length));
    const fixedH = 56 + maxRows * 27; // 헤더 2행 + 최다 인원 (직업 탭 고정 높이)
    let idx = Math.min(skillIdx[cat] || 0, keys.length - 1); skillIdx[cat] = idx;
    const panel = el('div.skill-panel');
    const tabs = el('div.skill-tabs');
    const show = (n, dir) => {
      idx = (n + keys.length) % keys.length; skillIdx[cat] = idx;
      clear(panel);
      const t = buildClassTable(cat, kind, keys[idx]);
      t.classList.add(dir < 0 ? 'slide-l' : 'slide-r');
      panel.appendChild(t);
      panel.style.minHeight = keys[idx] === '공용' ? '' : fixedH + 'px'; // 직업 탭만 고정 높이
      [...tabs.children].forEach((b, i) => b.classList.toggle('active', i === idx));
    };
    keys.forEach((k, i) => tabs.appendChild(el('button.skill-tab', { class: i === idx ? 'active' : '', text: k, onclick: () => show(i, i < idx ? -1 : 1) })));
    const head = el('div.skill-head', {}, [
      el('button.skill-arrow', { text: '‹', title: '이전', onclick: () => show(idx - 1, -1) }), tabs,
      el('button.skill-arrow', { text: '›', title: '다음', onclick: () => show(idx + 1, 1) }),
    ]);
    const acts = (cat === '주문석' && adm) ? btn('공용 주문석 지정', () => openStoneSelect(), { kind: 'ghost', admin: true }) : null;
    const cardNode = card(cat, el('div', {}, [head, panel]), { className: 'card-flush', actions: acts });
    show(idx, 1);
    return cardNode;
  }

  // 상태 보드 1개 → 카드(멤버×컬럼 토글 표 + 관리자 열/이름/삭제 액션). 성좌·탈것·플랫폼 각각.
  function renderBoardCard(board, idx) {
    const members = Roles.selfFirst(s.members.filter((m) => m.active !== false)); // 본인 행 먼저
    const tbl = el('table.tbl');
    const headCells = [el('th.sticky-col', { text: '닉네임' }), el('th', { text: '직업', style: { width: '80px' } })];
    board.columns.forEach((col) => headCells.push(el('th', {}, [
      el('span', { text: col }),
      adm ? el('button.col-x', { title: '열 삭제', text: '✕', onclick: () => { board.columns = board.columns.filter((c) => c !== col); DB.commit(); renderGear(); } }) : null,
    ])));
    headCells.push(el('th', { style: { width: '40px' } }, [adm ? el('button.col-add', { title: '열 추가', text: '+', onclick: () => addColumn(board) }) : null]));
    tbl.appendChild(el('thead', {}, el('tr', {}, headCells)));
    const tb = el('tbody');
    members.forEach((m) => {
      const row = el('tr', { class: Roles.isMe(m.name) ? 'me-row' : '' }, [el('td.sticky-col', {}, [el('b', { text: m.name })]), el('td', { class: 'muted', text: m.cls || '-' })]);
      const rec = (board.data[m.id] ||= {});
      const canEditRow = adm || Roles.isMe(m.name); // 멤버는 본인 행만 편집
      board.columns.forEach((col) => {
        const owned = !!rec[col];
        const cell = canEditRow
          ? el('button.sk-toggle', { class: owned ? 'on' : '', type: 'button', title: owned ? '있음 (클릭해 해제)' : '없음 (클릭해 표시)',
              onclick: (e) => { if (rec[col]) delete rec[col]; else rec[col] = true; DB.commit(); const on = !!rec[col]; const b = e.currentTarget; b.classList.toggle('on', on); b.title = on ? '있음 (클릭해 해제)' : '없음 (클릭해 표시)'; } }, [el('span.sk-check', { text: '✓' })])
          : el('span.sk-check', { class: owned ? 'on' : '', text: owned ? '✓' : '' });
        row.appendChild(el('td', { style: { textAlign: 'center' } }, [cell]));
      });
      row.appendChild(el('td'));
      tb.appendChild(row);
    });
    tbl.appendChild(tb);
    const acts = adm ? el('div.row-actions', {}, [
      btn('+ 열', () => addColumn(board), { kind: 'ghost', admin: true }),
      btn('이름', () => renameBoard(board), { kind: 'ghost', admin: true }),
      btn('삭제', () => confirmDialog(`'${board.name}' 보드를 삭제할까요?`, () => { s.statusBoards.splice(idx, 1); DB.commit(); renderGear(); }, { danger: true, yesText: '삭제' }), { kind: 'ghost-danger', admin: true }),
    ]) : null;
    return card(board.name, el('div.table-wrap', {}, [tbl]), { className: 'card-flush', actions: acts });
  }
  function buildClassTable(cat, kind, key) {
    if (cat === '주문석' && key === '공용') return buildCommonStoneTable(); // 공용 주문석 = 지정+개수 관리
    const mem = key === '공용'
      ? Roles.selfFirst(s.members.filter((m) => m.active !== false))
      : Roles.selfFirst(s.members.filter((m) => m.active !== false && m.cls === key));
    // cols 원소: 문자열 또는 {key,label} → 통일
    const groups = classGroups(kind, key).map((g) => ({ label: g.label, cols: g.cols.map((c) => (typeof c === 'string' ? { key: c, label: c } : c)) }));
    const tbl = el('table.tbl.skill-tbl');
    const ncols = groups.reduce((a, g) => a + g.cols.length, 0);
    tbl.appendChild(el('colgroup', {}, [el('col.col-name'), ...Array.from({ length: ncols }, () => el('col'))]));
    const h1 = [el('th.skill-name', { rowspan: '2', text: key })];
    groups.forEach((g) => h1.push(el('th', { class: 'grp-start', colspan: String(g.cols.length), text: g.label })));
    const h2 = [];
    groups.forEach((g) => g.cols.forEach((c, i) => {
      const ic = skillIcon(cat, key, c.key);
      // 아이콘 없으면 금지(정지) 표지로 대체
      const icoEl = ic
        ? el('img.sk-ic', { src: ic, alt: '', title: c.label, loading: 'lazy' })
        : el('span.sk-ic.sk-none', { title: '아이콘 없음' });
      h2.push(el('th', { class: i === 0 ? 'grp-start' : '', title: c.key }, [el('div.sk-h', {}, [icoEl, el('span.sk-hn', { text: c.label })])]));
    }));
    tbl.appendChild(el('thead', {}, [el('tr', {}, h1), el('tr', {}, h2)]));
    const tb = el('tbody');
    mem.forEach((m) => {
      const canEdit = adm || Roles.isMe(m.name);
      const tr = el('tr', { class: Roles.isMe(m.name) ? 'me-row' : '' }, [el('td.skill-name', {}, [el('b', { text: m.name })])]);
      groups.forEach((g) => g.cols.forEach((c, i) => {
        const owned = !!((m.skills || {})[cat] || {})[c.key]; // 보유 여부(토글)
        const cell = canEdit
          ? el('button.sk-toggle', { class: owned ? 'on' : '', type: 'button', title: owned ? '보유 (클릭해 해제)' : '미보유 (클릭해 보유)',
              onclick: (e) => { const on = toggleSkill(m, cat, c.key); const b = e.currentTarget; b.classList.toggle('on', on); b.title = on ? '보유 (클릭해 해제)' : '미보유 (클릭해 보유)'; } }, [el('span.sk-check', { text: '✓' })])
          : el('span.sk-check', { class: owned ? 'on' : '', text: owned ? '✓' : '' });
        tr.appendChild(el('td', { class: i === 0 ? 'grp-start' : '', style: { textAlign: 'center' } }, [cell]));
      }));
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    return tbl;
  }
  // 보유 여부 토글(있으면 true, 해제 시 삭제). 기존 텍스트값도 truthy라 보유로 표시.
  function toggleSkill(m, cat, key) {
    m.skills ||= {}; m.skills[cat] ||= {};
    let on;
    if (m.skills[cat][key]) { delete m.skills[cat][key]; on = false; } else { m.skills[cat][key] = true; on = true; }
    DB.commit();
    return on;
  }

  // ── 공용 주문석: 관리자가 지정한 항목만 + 개수(2개 이상 보유) 스테퍼, 성급별 ──
  function shortStone(full) { return String(full).replace(/\s*[:\-]\s*(일반 공격|대시)\s*$/, ''); }
  function buildCommonStoneTable() {
    const cat = '공용주문석';
    const managed = s.appSettings.managedStones || [];
    const mem = Roles.selfFirst(s.members.filter((m) => m.active !== false));
    if (!managed.length) {
      return el('div.empty.small', { text: adm ? '“공용 주문석 지정”으로 관리할 주문석을 먼저 선택하세요.' : '아직 지정된 공용 주문석이 없습니다.' });
    }
    const tbl = el('table.tbl.skill-tbl');
    tbl.appendChild(el('colgroup', {}, [el('col.col-name'), ...managed.map(() => el('col.col-cnt'))]));
    const hr = [el('th.skill-name', { text: '닉네임' })];
    managed.forEach((mc) => {
      const ic = mc.star === 5 ? commonStoneIcon(mc.name) : null;
      const icoEl = ic ? el('img.sk-ic', { src: ic, alt: '', title: mc.name, loading: 'lazy' }) : el('span.sk-ic.sk-none', { title: '4성 아이콘 추가 예정' });
      hr.push(el('th', { title: mc.name }, [el('div.sk-h', {}, [icoEl, el('span.sk-hn', { text: shortStone(mc.name) }), el('span.sk-star', { text: mc.star + '성' })])]));
    });
    tbl.appendChild(el('thead', {}, el('tr', {}, hr)));
    const tb = el('tbody');
    mem.forEach((m) => {
      const canEdit = adm || Roles.isMe(m.name);
      const tr = el('tr', { class: Roles.isMe(m.name) ? 'me-row' : '' }, [el('td.skill-name', {}, [el('b', { text: m.name })])]);
      managed.forEach((mc) => {
        const key = mc.name + '__' + mc.star;
        const cur = ((m.skills || {})[cat] || {})[key] || 0;
        tr.appendChild(el('td', {}, [countCell(m, cat, key, cur, canEdit)]));
      });
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    return tbl;
  }
  function countCell(m, cat, key, cur, canEdit) {
    if (!canEdit) return el('span.sk-count', { class: cur ? 'on' : '', text: cur ? String(cur) : '·' });
    const num = el('span.sk-count', { class: cur ? 'on' : '', text: String(cur) });
    const step = (d) => () => setCount(m, cat, key, d, num);
    return el('div.sk-stepper', {}, [
      el('button.sk-step', { type: 'button', text: '−', title: '1 줄이기', onclick: step(-1) }),
      num,
      el('button.sk-step', { type: 'button', text: '+', title: '1 늘리기', onclick: step(+1) }),
    ]);
  }
  function setCount(m, cat, key, delta, numEl) {
    m.skills ||= {}; m.skills[cat] ||= {};
    let v = (m.skills[cat][key] || 0) + delta;
    if (v <= 0) { delete m.skills[cat][key]; v = 0; } else m.skills[cat][key] = v;
    DB.commit();
    numEl.textContent = String(v); numEl.classList.toggle('on', v > 0);
  }
  // 관리자: 81종 중 관리할 공용 주문석을 성급별로 지정
  function openStoneSelect() {
    const managed = (s.appSettings.managedStones ||= []);
    const has = (name, star) => managed.some((x) => x.name === name && x.star === star);
    const toggle = (name, star, on) => {
      const i = managed.findIndex((x) => x.name === name && x.star === star);
      if (on && i < 0) managed.push({ name, star });
      else if (!on && i >= 0) managed.splice(i, 1);
      DB.commit();
    };
    modal('공용 주문석 지정', (close) => el('div', {}, [
      el('p.hint', { text: '관리할 공용 주문석을 선택하세요. 선택 항목이 공용 탭에 개수 관리로 표시됩니다. (지금은 5성 아이콘 보유, 4성은 추후 아이콘 추가 예정)' }),
      ...COMMON_SPELLSTONES.map((g) => el('div', {}, [
        el('div.modal-sec', { text: g.label }),
        el('div.stone-pick', {}, g.cols.map((c) => el('div.stone-row', {}, [
          el('span.stone-name', { text: c.label }),
          el('label.stone-star', {}, [el('input', { type: 'checkbox', checked: has(c.key, 5), onchange: (e) => toggle(c.key, 5, e.target.checked) }), el('span', { text: '5성' })]),
          el('label.stone-star', {}, [el('input', { type: 'checkbox', checked: has(c.key, 4), onchange: (e) => toggle(c.key, 4, e.target.checked) }), el('span', { text: '4성' })]),
        ]))),
      ])),
      el('div.modal-actions', {}, [btn('완료', () => { close(); renderGear(); }, { kind: 'primary' })]),
    ]), { wide: 'x' });
  }

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
      DB.commit(); close(); renderGear();
    }, { kind: 'primary' })])]));
}

// 제네릭 보드(첫 방문 시): 성좌·탈것·플랫폼. 주문석·엘릭서는 직업별 전용 표(renderSkillSection),
// 장착 장비는 슬롯 그리드+장비 현황 표가 담당하므로 보드에서 제외.
function seedDefaultBoards(s) {
  const push = (name, columns) => s.statusBoards.push({ id: uid(), name, columns, data: {} });
  push('성좌', ['바위를 삼키는 괴물', '자유로운 여행자', '바다의 괴물']);
  push('탈것', ['지진발굽', '심연의 수호자', '심연의 환영', '황혼의방랑자']);
  push('플랫폼 이용 현황', ['PC', '모바일', '디스코드']);
  DB.commit({ history: false });
}
