// rotation.js — 전리품: 순번제 큐 + 드랍 기록(콘텐츠→아이템) + 분배 기록(내판가·인계자) + 분배 기준.
import { DB, Mutations } from '../db.js';
import { el, fmt, toast, uid } from '../util.js';
import { page, card, table, btn, modal, select, input, field, confirmDialog } from './ui.js';

const DIST_TYPES = ['순번제', '내판', '참여도', '고정', '기타'];
let dropQ = '';

export function renderRotation() {
  const s = DB.state;
  const body = page('전리품', {
    subtitle: '드랍 · 내판 · 순번제 · 분배 기록',
    actions: [btn('+ 분배 기록', () => logDist(), { kind: 'primary' })],
  });

  // ── 순번제 큐 ──
  body.appendChild(el('div.toolbar', {}, [
    el('span.modal-sec', { text: '순번제 큐', style: { margin: '0' } }),
    btn('+ 순번 큐 추가', () => addQueue(), { kind: 'ghost' }),
  ]));
  if (s.rotationQueues.length) {
    const grid = el('div.col-2');
    s.rotationQueues.forEach((qу) => grid.appendChild(renderQueue(qу)));
    body.appendChild(grid);
  } else {
    body.appendChild(el('div.empty.small', { text: '순번제 큐가 없습니다. (설계도·완제 등 순번 분배 목록)' }));
  }

  // ── 드랍 기록 ──
  const dropSearch = input({ placeholder: '콘텐츠/아이템 검색', value: dropQ, oninput: (e) => { dropQ = e.target.value; renderRotation(); } });
  let drops = s.dropLog;
  if (dropQ) drops = drops.filter((d) => (d.content + d.item).includes(dropQ));
  body.appendChild(card('드랍 기록', el('div', {}, [
    el('div.toolbar', { style: { marginBottom: '10px' } }, [dropSearch, el('span.hint', { text: '어떤 콘텐츠에서 무엇이 떨어졌는지' })]),
    table([
      { key: 'date', label: '날짜', width: '108px' },
      { key: 'content', label: '콘텐츠', render: (r) => el('b', { text: r.content }) },
      { key: 'item', label: '아이템' },
      { key: 'note', label: '메모', render: (r) => el('span.muted', { text: r.note || '' }) },
      { label: '', align: 'right', render: (r) => btn('삭제', () => { s.dropLog = s.dropLog.filter((x) => x.id !== r.id); DB.commit(); renderRotation(); }, { kind: 'ghost-danger' }) },
    ], drops, { empty: dropQ ? '검색 결과 없음' : '드랍 기록이 없습니다.' }),
  ]), { actions: btn('+ 드랍 기록', () => addDrop(), { kind: 'ghost' }) }));

  // ── 분배 기록 ──
  body.appendChild(card('분배 기록', table([
    { key: 'date', label: '날짜', width: '108px' },
    { key: 'item', label: '아이템', render: (r) => el('b', { text: r.item }) },
    { key: 'type', label: '구분', align: 'center' },
    { key: 'member', label: '받은 사람' },
    { key: 'from', label: '인계자', render: (r) => el('span.muted', { text: r.from || '–' }) },
    { key: 'price', label: '내판가', align: 'right', render: (r) => r.price ? fmt(r.price) : '–' },
    { key: 'note', label: '메모', render: (r) => el('span.muted', { text: r.note || '' }) },
    { label: '', align: 'right', render: (r) => btn('삭제', () => { s.distributionLog = s.distributionLog.filter((x) => x.id !== r.id); DB.commit(); renderRotation(); }, { kind: 'ghost-danger' }) },
  ], s.distributionLog, { empty: '분배 내역이 없습니다.' }), { actions: btn('+ 분배 기록', () => logDist(), { kind: 'ghost' }) }));

  // ── 분배 기준 (편집 가능 참고) ──
  const rulesArea = el('textarea.input', { rows: 11, value: s.distributionRules || '',
    style: { width: '100%', fontFamily: 'inherit', lineHeight: '1.7', resize: 'vertical' } });
  body.appendChild(card('분배 기준', el('div', {}, [
    rulesArea,
    el('div.row-actions', {}, [btn('기준 저장', () => { s.distributionRules = rulesArea.value; DB.commit(); toast('분배 기준 저장됨'); }, { kind: 'primary' })]),
  ])));

  // ── helpers ──
  function renderQueue(qу) {
    const nextIdx = qу.items.findIndex((it) => !it.status);
    const rows = qу.items.map((it, i) => ({ ...it, _i: i }));
    return card(qу.name, el('div', {}, [
      nextIdx >= 0
        ? el('div.next-up', { html: `다음 차례: <b>${qу.items[nextIdx].name}</b>` })
        : el('div.next-up.done', { text: '대기 인원 없음 (전원 지급/졸업)' }),
      table([
        { label: '#', align: 'center', width: '34px', render: (r) => r._i + 1 },
        { key: 'name', label: '닉네임', render: (r) => el('span', { class: r.status ? 'muted' : '', text: r.name }) },
        { label: '상태', align: 'center', render: (r) => el('span.qstatus', { class: r.status ? 'done' : 'wait', text: r.status || '대기' }) },
        { label: '', align: 'right', width: '150px', render: (r) => el('div.row-actions.nowrap', {}, [
          btn('▲', () => move(qу, r._i, -1), { kind: 'ghost', title: '위로' }),
          btn('▼', () => move(qу, r._i, +1), { kind: 'ghost', title: '아래로' }),
          btn(r.status ? '대기' : '지급', () => { qу.items[r._i].status = r.status ? '' : '지급'; DB.commit(); renderRotation(); }, { kind: 'ghost' }),
          btn('✕', () => { qу.items.splice(r._i, 1); DB.commit(); renderRotation(); }, { kind: 'ghost-danger' }),
        ]) },
      ], rows, { className: 'card-compact' }),
      el('div.row-actions', {}, [
        btn('+ 인원 추가', () => addToQueue(qу), { kind: 'ghost' }),
        btn('큐 삭제', () => confirmDialog(`'${qу.name}' 큐를 삭제할까요?`, () => { s.rotationQueues = s.rotationQueues.filter((x) => x !== qу); DB.commit(); renderRotation(); }, { danger: true, yesText: '삭제' }), { kind: 'ghost-danger' }),
      ]),
    ]), { className: 'card-compact' });
  }
  function move(qу, i, d) {
    const j = i + d; if (j < 0 || j >= qу.items.length) return;
    [qу.items[i], qу.items[j]] = [qу.items[j], qу.items[i]]; DB.commit(); renderRotation();
  }
  function addToQueue(qу) {
    const nm = select(s.members.map((m) => m.name), s.members[0]?.name);
    modal('큐에 인원 추가', (close) => el('div.form', {}, [field('닉네임', nm),
      el('div.modal-actions', {}, [btn('취소', close), btn('추가', () => { qу.items.push({ name: nm.value, status: '' }); DB.commit(); close(); renderRotation(); }, { kind: 'primary' })])]));
  }
  function addQueue() {
    const nm = input({ placeholder: '예: 상급 무기 설계도' });
    modal('순번 큐 추가', (close) => el('div.form', {}, [field('큐 이름', nm),
      el('div.modal-actions', {}, [btn('취소', close), btn('추가', () => { if (!nm.value.trim()) return toast('이름 입력', 'error'); s.rotationQueues.push({ name: nm.value.trim(), items: [] }); DB.commit(); close(); renderRotation(); }, { kind: 'primary' })])]));
  }
  function addDrop() {
    const date = input({ type: 'date', value: new Date().toISOString().slice(0, 10) });
    const cats = s.contentCatalog.map((c) => c.name);
    const content = cats.length ? select(cats, cats[0]) : input({ placeholder: '콘텐츠명' });
    const item = input({ placeholder: '아이템명' });
    const note = input({ placeholder: '메모(선택)' });
    modal('드랍 기록', (close) => el('div.form', {}, [
      field('날짜', date), field('콘텐츠', content), field('아이템', item), field('메모', note),
      el('div.modal-actions', {}, [btn('취소', close), btn('기록', () => {
        if (!item.value.trim()) return toast('아이템 입력', 'error');
        s.dropLog.unshift({ id: uid(), date: date.value, content: content.value.trim(), item: item.value.trim(), note: note.value.trim() });
        DB.commit(); close(); toast('드랍 기록됨'); renderRotation();
      }, { kind: 'primary' })]),
    ]));
  }
  function logDist() {
    const date = input({ type: 'date', value: new Date().toISOString().slice(0, 10) });
    const item = input({ placeholder: '아이템명' });
    const type = select(DIST_TYPES, '순번제');
    const member = select(s.members.map((m) => m.name), s.members[0]?.name);
    const from = select(['없음', ...s.members.map((m) => m.name)], '없음');
    const price = input({ type: 'number', placeholder: '내판가(다이아, 선택)' });
    const note = input({ placeholder: '메모(선택)' });
    modal('분배 기록', (close) => el('div.form', {}, [
      field('날짜', date), field('아이템', item), field('구분', type),
      field('받은 사람', member), field('인계자(선택)', from), field('내판가(선택)', price), field('메모', note),
      el('div.modal-actions', {}, [btn('취소', close), btn('기록', () => {
        if (!item.value.trim()) return toast('아이템 입력', 'error');
        Mutations.logDistribution({ date: date.value, item: item.value.trim(), type: type.value, member: member.value,
          from: from.value === '없음' ? '' : from.value, price: +price.value || 0, note: note.value.trim() });
        DB.commit(); close(); toast('기록되었습니다'); renderRotation();
      }, { kind: 'primary' })]),
    ]));
  }
}
