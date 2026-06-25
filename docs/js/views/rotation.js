// rotation.js — 전리품: 순번제 큐(컴팩트 아코디언) + 드랍 기록 + 분배 기록(내판가·인계자) + 분배 기준.
import { DB, Mutations } from '../db.js';
import { el, fmt, toast, uid } from '../util.js';
import { page, card, table, btn, modal, select, input, field, confirmDialog } from './ui.js';

const DIST_TYPES = ['순번제', '내판', '참여도', '고정', '기타'];
let dropQ = '';
const openQueues = new Set(); // 펼쳐진 큐 이름(재렌더에도 유지)

export function renderRotation() {
  const s = DB.state;
  const body = page('전리품', {
    subtitle: '드랍 · 내판 · 순번제 · 분배 기록',
    actions: [btn('+ 분배 기록', () => logDist(), { kind: 'primary' })],
  });

  // ── 순번제 큐 (컴팩트 아코디언) ──
  const qWrap = s.rotationQueues.length
    ? el('div.q-list', {}, s.rotationQueues.map((qу) => renderQueueRow(qу)))
    : el('div.empty.small', { text: '순번제 큐가 없습니다. (설계도·완제 등 순번 분배 목록)' });
  body.appendChild(card('순번제 큐', qWrap, { className: 'card-flush', actions: btn('+ 순번 큐 추가', () => addQueue(), { kind: 'ghost' }) }));

  // ── 드랍 기록 ──
  const dropSearch = input({ placeholder: '콘텐츠/아이템 검색', value: dropQ, oninput: (e) => { dropQ = e.target.value; renderRotation(); } });
  let drops = s.dropLog;
  if (dropQ) drops = drops.filter((d) => (d.content + d.item).includes(dropQ));
  body.appendChild(card('드랍 기록', el('div', {}, [
    el('div.toolbar', { style: { marginBottom: '10px' } }, [dropSearch, el('span.hint', { text: '어떤 콘텐츠에서 무엇이 떨어졌는지' })]),
    el('div.scroll-tbl', {}, [table([
      { key: 'date', label: '날짜', width: '108px' },
      { key: 'content', label: '콘텐츠', render: (r) => el('b', { text: r.content }) },
      { key: 'item', label: '아이템' },
      { key: 'note', label: '메모', render: (r) => el('span.muted', { text: r.note || '' }) },
      { label: '', align: 'right', render: (r) => btn('삭제', () => { s.dropLog = s.dropLog.filter((x) => x.id !== r.id); DB.commit(); renderRotation(); }, { kind: 'ghost-danger' }) },
    ], drops, { empty: dropQ ? '검색 결과 없음' : '드랍 기록이 없습니다.' })]),
  ]), { actions: btn('+ 드랍 기록', () => addDrop(), { kind: 'ghost' }) }));

  // ── 분배 기록 ──
  body.appendChild(card('분배 기록', el('div.scroll-tbl', {}, [table([
    { key: 'date', label: '날짜', width: '108px' },
    { key: 'item', label: '아이템', render: (r) => el('b', { text: r.item }) },
    { key: 'type', label: '구분', align: 'center' },
    { key: 'member', label: '받은 사람' },
    { key: 'from', label: '인계자', render: (r) => el('span.muted', { text: r.from || '–' }) },
    { key: 'price', label: '내판가', align: 'right', render: (r) => r.price ? fmt(r.price) : '–' },
    { key: 'note', label: '메모', render: (r) => el('span.muted', { text: r.note || '' }) },
    { label: '', align: 'right', render: (r) => btn('삭제', () => { s.distributionLog = s.distributionLog.filter((x) => x.id !== r.id); DB.commit(); renderRotation(); }, { kind: 'ghost-danger' }) },
  ], s.distributionLog, { empty: '분배 내역이 없습니다.' })]), { actions: btn('+ 분배 기록', () => logDist(), { kind: 'ghost' }) }));

  // ── 분배 기준 (접이식 참고) ──
  const rulesArea = el('textarea.input', { rows: 11, value: s.distributionRules || '',
    style: { width: '100%', fontFamily: 'inherit', lineHeight: '1.7', resize: 'vertical' } });
  body.appendChild(el('details.rules-det', {}, [
    el('summary', { text: '분배 기준 (클릭해서 보기 / 편집)' }),
    el('div.rules-body', {}, [
      rulesArea,
      el('div.row-actions', {}, [btn('기준 저장', () => { s.distributionRules = rulesArea.value; DB.commit(); toast('분배 기준 저장됨'); }, { kind: 'primary' })]),
    ]),
  ]));

  // ── helpers ──
  function renderQueueRow(qу) {
    const next = qу.items[0];
    const open = openQueues.has(qу.name);
    const head = el('div.q-head', { onclick: () => { open ? openQueues.delete(qу.name) : openQueues.add(qу.name); renderRotation(); } }, [
      el('span.q-caret', { text: open ? '▾' : '▸' }),
      el('b.q-name', { text: qу.name }),
      next ? el('span.q-next', { text: `다음 ${next.name}` }) : el('span.q-next.done', { text: '비어있음' }),
      el('span.q-count', { text: `대기 ${qу.items.length}` }),
    ]);
    const item = el('div.q-item', {}, [head]);
    if (!open) return item;

    const rows = qу.items.map((it, i) => ({ ...it, _i: i }));
    item.appendChild(el('div.q-body', {}, [
      table([
        { label: '#', align: 'center', width: '34px', render: (r) => r._i + 1 },
        { key: 'name', label: '닉네임' },
        { label: '', align: 'right', width: '180px', render: (r) => el('div.row-actions.nowrap', {}, [
          r._i === 0 ? btn('지급', () => giveFromQueue(qу, 0), { kind: 'primary' }) : null,
          btn('▲', () => move(qу, r._i, -1), { kind: 'ghost', title: '위로' }),
          btn('▼', () => move(qу, r._i, +1), { kind: 'ghost', title: '아래로' }),
          btn('✕', () => { qу.items.splice(r._i, 1); DB.commit(); renderRotation(); }, { kind: 'ghost-danger', title: '제거' }),
        ]) },
      ], rows, { className: 'card-compact', empty: '인원이 없습니다.' }),
      el('div.row-actions', {}, [
        btn('+ 인원 추가', () => addToQueue(qу), { kind: 'ghost' }),
        btn('큐 삭제', () => confirmDialog(`'${qу.name}' 큐를 삭제할까요?`, () => { s.rotationQueues = s.rotationQueues.filter((x) => x !== qу); openQueues.delete(qу.name); DB.commit(); renderRotation(); }, { danger: true, yesText: '삭제' }), { kind: 'ghost-danger' }),
      ]),
    ]));
    return item;
  }

  // 지급(맨 앞 순번) → 분배 기록 모달(아이템 자동·고정, 내판가 기본 10) → 기록 시 큐에서 제거
  function giveFromQueue(qу, idx) {
    const person = qу.items[idx]; if (!person) return;
    const itemView = el('input.input', { value: qу.name, readonly: 'readonly', style: { opacity: '.6' } });
    const date = input({ type: 'date', value: new Date().toISOString().slice(0, 10) });
    const type = select(DIST_TYPES, '순번제');
    const member = select(s.members.map((m) => m.name), person.name);
    const from = select(['없음', ...s.members.map((m) => m.name)], '없음');
    const price = input({ type: 'number', value: '10' });
    const note = input({ placeholder: '메모(선택)' });
    modal('순번 분배 기록', (close) => el('div.form', {}, [
      field('아이템 (자동)', itemView), field('날짜', date), field('구분', type),
      field('받은 사람', member), field('인계자(선택)', from), field('내판가', price), field('메모', note),
      el('div.modal-actions', {}, [btn('취소', close), btn('기록', () => {
        Mutations.logDistribution({ date: date.value, item: qу.name, type: type.value, member: member.value,
          from: from.value === '없음' ? '' : from.value, price: +price.value || 0, note: note.value.trim() });
        qу.items.splice(idx, 1); // 지급 완료 → 큐에서 제거
        DB.commit(); close(); toast(`${qу.name} → ${member.value} 지급`); renderRotation();
      }, { kind: 'primary' })]),
    ]));
  }
  function move(qу, i, d) {
    const j = i + d; if (j < 0 || j >= qу.items.length) return;
    [qу.items[i], qу.items[j]] = [qу.items[j], qу.items[i]]; DB.commit(); renderRotation();
  }
  function addToQueue(qу) {
    const nm = select(s.members.map((m) => m.name), s.members[0]?.name);
    modal('큐에 인원 추가', (close) => el('div.form', {}, [field('닉네임', nm),
      el('div.modal-actions', {}, [btn('취소', close), btn('추가', () => { qу.items.push({ name: nm.value }); DB.commit(); close(); renderRotation(); }, { kind: 'primary' })])]));
  }
  function addQueue() {
    const nm = input({ placeholder: '예: 상급 무기 설계도' });
    modal('순번 큐 추가', (close) => el('div.form', {}, [field('큐 이름', nm),
      el('div.modal-actions', {}, [btn('취소', close), btn('추가', () => { if (!nm.value.trim()) return toast('이름 입력', 'error'); s.rotationQueues.push({ name: nm.value.trim(), items: [] }); openQueues.add(nm.value.trim()); DB.commit(); close(); renderRotation(); }, { kind: 'primary' })])]));
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
