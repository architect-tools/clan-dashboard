// rotation.js — 순번제 item distribution queues + distribution log + weapon progress.
import { DB, Mutations } from '../db.js';
import { el, fmt, toast, uid } from '../util.js';
import { page, card, table, btn, modal, select, input, field, confirmDialog } from './ui.js';

export function renderRotation() {
  const s = DB.state;
  const body = page('순번제 / 분배', { subtitle: '설계도·완제 아이템 순번 분배 및 분배 내역', actions: [
    btn('+ 분배 큐 추가', () => addQueue(), { kind: 'ghost' }),
    btn('+ 분배 기록', () => logDist(), { kind: 'primary' }),
  ] });

  // ── queues ──
  const grid = el('div.col-2');
  s.rotationQueues.forEach((qу) => grid.appendChild(renderQueue(qу)));
  body.appendChild(grid);

  // ── distribution log ──
  body.appendChild(card('분배 내역', table([
    { key: 'date', label: '날짜', width: '110px' },
    { key: 'item', label: '아이템', render: (r) => el('b', { text: r.item }) },
    { key: 'type', label: '구분', align: 'center' },
    { key: 'member', label: '받은 사람' },
    { key: 'note', label: '메모' },
    { label: '', align: 'right', render: (r) => btn('삭제', () => { s.distributionLog = s.distributionLog.filter((x) => x.id !== r.id); DB.commit(); renderRotation(); }, { kind: 'ghost-danger' }) },
  ], s.distributionLog, { empty: '분배 내역이 없습니다.' })));

  // ── weapon progress ──
  if (s.weaponProgress?.length) {
    body.appendChild(card('무기 강화 현황', table([
      { key: 'name', label: '닉네임', render: (w) => el('b', { text: w.name }) },
      { key: 'cls', label: '직업' },
      { key: 'main', label: '주무기', align: 'center' },
      { key: 'sub1', label: '보조', align: 'center' },
      { key: 'sub2', label: '보조2', align: 'center' },
    ], s.weaponProgress), { className: 'card-compact' }));
  }

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
        { label: '', align: 'right', width: '150px', render: (r) => el('div.row-actions', {}, [
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
    modal('분배 큐 추가', (close) => el('div.form', {}, [field('큐 이름', nm),
      el('div.modal-actions', {}, [btn('취소', close), btn('추가', () => { if (!nm.value.trim()) return toast('이름 입력', 'error'); s.rotationQueues.push({ name: nm.value.trim(), items: [] }); DB.commit(); close(); renderRotation(); }, { kind: 'primary' })])]));
  }
  function logDist() {
    const date = input({ type: 'date', value: new Date().toISOString().slice(0, 10) });
    const item = input({ placeholder: '아이템명' });
    const type = select(['순번제', '내판가', '참여도', '고정', '기타'], '순번제');
    const member = select(s.members.map((m) => m.name), s.members[0]?.name);
    const note = input({ placeholder: '메모(선택)' });
    modal('분배 기록', (close) => el('div.form', {}, [
      field('날짜', date), field('아이템', item), field('구분', type), field('받은 사람', member), field('메모', note),
      el('div.modal-actions', {}, [btn('취소', close), btn('기록', () => { if (!item.value.trim()) return toast('아이템 입력', 'error'); Mutations.logDistribution({ date: date.value, item: item.value.trim(), type: type.value, member: member.value, note: note.value.trim() }); DB.commit(); close(); toast('기록되었습니다'); renderRotation(); }, { kind: 'primary' })]),
    ]));
  }
}
