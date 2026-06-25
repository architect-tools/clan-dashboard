// rotation.js — 전리품: 순번제 큐(컴팩트 아코디언) + 드랍 기록 + 분배 기록(내판가·인계자) + 분배 기준.
import { DB, Mutations } from '../db.js';
import { el, fmt, toast, uid, clear } from '../util.js';
import { page, card, table, btn, modal, select, input, field, classBadge, confirmDialog } from './ui.js';

const DIST_TYPES = ['순번제', '투력', '내판', '참여도', '고정', '기타'];
const BID_TYPES = ['투력순', '참여도순', '경매', '선착순'];
let dropQ = '';
const openQueues = new Set(); // 펼쳐진 큐 이름(재렌더에도 유지)
let countdownTimer = null;
const pad2 = (n) => String(n).padStart(2, '0');
function remainText(ms) {
  if (ms <= 0) return '마감됨';
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (d > 0 ? `${d}일 ` : '') + `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
}
const remainClass = (ms) => ms <= 0 ? 'cd-over' : ms < 600000 ? 'cd-soon' : ms < 3600000 ? 'cd-near' : 'cd-far';

export function renderRotation() {
  const s = DB.state;
  const body = page('전리품', {
    subtitle: '드랍 · 내판 · 순번제 · 분배 기록',
    actions: [btn('내판 도우미', () => saleHelper()), btn('+ 분배 기록', () => logDist(), { kind: 'primary' })],
  });

  // ── 진행 중 내판 (입찰 보드) ──
  clearInterval(countdownTimer); countdownTimer = null;
  const sales = s.sales || [];
  const board = sales.length
    ? el('div.sale-board', {}, sales.map((sale) => renderSale(sale)))
    : el('div.empty.small', { text: '진행 중인 내판이 없습니다. “+ 내판 올리기”로 시작하세요.' });
  body.appendChild(card('진행 중 내판', board, { actions: btn('+ 내판 올리기', () => postSale(), { kind: 'primary' }) }));
  if (sales.length) {
    const tick = () => document.querySelectorAll('.sale-cd').forEach((c) => {
      const rem = (+c.dataset.deadline) - Date.now();
      c.textContent = remainText(rem); c.className = 'sale-cd ' + remainClass(rem);
    });
    tick(); countdownTimer = setInterval(tick, 1000);
    if (typeof MutationObserver !== 'undefined') {
      const obs = new MutationObserver(() => { if (!document.querySelector('.sale-board')) { clearInterval(countdownTimer); countdownTimer = null; obs.disconnect(); } });
      obs.observe(document.getElementById('app') || document.body, { childList: true, subtree: true });
    }
  }

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

  // 내판/분배 도우미: 희망자(또는 전체)를 투력/참여도 순으로 자동 순위 → 1순위에게 분배 기록.
  function saleHelper() {
    modal('내판 / 분배 도우미', (close) => {
      const item = input({ placeholder: '아이템명' });
      const sortBy = select([{ value: 'power', label: '투력 순' }, { value: 'score', label: '참여도 순' }], 'power');
      const threshold = input({ type: 'number', placeholder: '예: 90 (이상=10다이아)' });
      const salePrice = input({ type: 'number', value: '10' });
      const active = s.members.filter((mm) => mm.active !== false);
      const picks = el('div.pick-grid', {}, active.map((mm) => el('label.pick-item', {}, [
        el('input', { type: 'checkbox', dataset: { id: String(mm.id) } }), el('span', { text: mm.name }),
      ])));
      const result = el('div', { style: { marginTop: '12px' } });
      const compute = () => {
        const checked = [...picks.querySelectorAll('input:checked')].map((c) => +c.dataset.id);
        const pool = checked.length ? active.filter((mm) => checked.includes(mm.id)) : active;
        const key = sortBy.value;
        const cands = [...pool].sort((a, b) => (b[key] || 0) - (a[key] || 0));
        const th = +threshold.value || 0;
        clear(result);
        if (!cands.length) return result.appendChild(el('div.empty.small', { text: '대상이 없습니다.' }));
        result.appendChild(el('div.modal-sec', { text: `순위 (${key === 'power' ? '투력' : '참여도'} 순) · ${cands.length}명${checked.length ? '' : ' · 전체'}` }));
        result.appendChild(table([
          { label: '#', align: 'center', width: '34px', render: (_, i) => i + 1 },
          { key: 'name', label: '닉네임', render: (mm) => el('b', { text: mm.name }) },
          { label: '직업', render: (mm) => classBadge(mm.cls) },
          { label: key === 'power' ? '전투력' : '참여점수', align: 'right', render: (mm) => key === 'power' ? mm.power.toLocaleString() : fmt(mm.score) },
          { label: '구분', align: 'center', render: (mm) => (th && mm.power >= th) ? el('span.qstatus.done', { text: '10다이아' }) : el('span.qstatus.wait', { text: '내판' }) },
          { label: '', align: 'right', render: (mm, i) => btn(i === 0 ? '분배(1순위)' : '분배', () => {
            const isTop = th && mm.power >= th;
            Mutations.logDistribution({ date: new Date().toISOString().slice(0, 10), item: item.value.trim() || '(미입력)',
              type: isTop ? (key === 'power' ? '투력' : '참여도') : '내판', member: mm.name, from: '',
              price: isTop ? 10 : (+salePrice.value || 0), note: '' });
            DB.commit(); close(); toast(`${item.value.trim() || '아이템'} → ${mm.name} 분배 기록`); renderRotation();
          }, { kind: i === 0 ? 'primary' : 'ghost' }) },
        ], cands));
      };
      return el('div.form', {}, [
        field('아이템명', item),
        el('div.form-grid', {}, [field('정렬 기준', sortBy), field('기준 투력(만, 선택)', threshold)]),
        field('내판가(기준 미만, 다이아)', salePrice),
        field('구매 희망자 (체크 없으면 전체 활동 멤버)', picks),
        btn('순위 계산', () => compute(), { kind: '' }),
        result,
      ]);
    }, { wide: 'x' });
  }

  // ── 내판 입찰 보드 ──
  function renderSale(sale) {
    const rem = (+sale.deadline) - Date.now();
    const head = el('div.sale-head', {}, [
      el('b.sale-item', { text: sale.item }),
      el('span.sale-type', { text: sale.bidType }),
      sale.basePrice ? el('span.sale-price', { text: `기준 ${fmt(sale.basePrice)}` }) : null,
      el('span.sale-cd', { dataset: { deadline: String(sale.deadline) }, class: remainClass(rem), text: remainText(rem) }),
    ]);
    const bids = el('div.sale-bids', {}, sale.bids.length
      ? sale.bids.map((b, i) => el('span.bid-chip', {}, [
        el('span', { text: b.name + (b.amount ? ` · ${fmt(b.amount)}` : '') }),
        btn('✕', () => { sale.bids.splice(i, 1); DB.commit(); renderRotation(); }, { kind: 'ghost-danger', title: '입찰 취소(관리자)' }),
      ]))
      : [el('span.muted', { text: '입찰 없음' })]);
    return el('div.sale-card', {}, [head, bids, el('div.row-actions', {}, [
      btn('+ 입찰', () => addBid(sale), { kind: 'ghost' }),
      btn('마감 & 정산', () => closeSale(sale)),
      btn('내판 취소', () => confirmDialog(`'${sale.item}' 내판을 취소(삭제)할까요?`, () => { s.sales = s.sales.filter((x) => x.id !== sale.id); DB.commit(); renderRotation(); }, { danger: true, yesText: '취소' }), { kind: 'ghost-danger' }),
    ])]);
  }
  function postSale() {
    const item = input({ placeholder: '아이템명' });
    const bidType = select(BID_TYPES, '투력순');
    const basePrice = input({ type: 'number', value: '10' });
    const n = new Date(Date.now() + 3600000);
    const deadline = input({ type: 'datetime-local', value: `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}T${pad2(n.getHours())}:${pad2(n.getMinutes())}` });
    modal('내판 올리기', (close) => el('div.form', {}, [
      field('아이템명', item),
      el('div.form-grid', {}, [field('입찰 타입', bidType), field('기준/시작가(다이아)', basePrice)]),
      field('마감 시간', deadline),
      el('p.hint', { text: '투력순/참여도순 = 입찰자 중 자동 순위 · 경매 = 입찰가 최고 · 선착순 = 먼저 입찰' }),
      el('div.modal-actions', {}, [btn('취소', close), btn('올리기', () => {
        if (!item.value.trim()) return toast('아이템 입력', 'error');
        const dl = Date.parse(deadline.value);
        (s.sales = s.sales || []).unshift({ id: uid(), item: item.value.trim(), bidType: bidType.value, basePrice: +basePrice.value || 0, deadline: isNaN(dl) ? Date.now() + 3600000 : dl, bids: [] });
        DB.commit(); close(); toast('내판이 올라갔습니다'); renderRotation();
      }, { kind: 'primary' })]),
    ]));
  }
  function addBid(sale) {
    const active = s.members.filter((m) => m.active !== false);
    const member = select(active.map((m) => m.name), active[0]?.name);
    const amount = input({ type: 'number', placeholder: '입찰가' });
    modal('입찰 추가', (close) => el('div.form', {}, [
      field('클랜원', member),
      sale.bidType === '경매' ? field('입찰가(다이아)', amount) : null,
      el('div.modal-actions', {}, [btn('취소', close), btn('입찰', () => {
        if (sale.bids.some((b) => b.name === member.value)) return toast('이미 입찰함', 'error');
        sale.bids.push({ name: member.value, amount: sale.bidType === '경매' ? (+amount.value || 0) : 0 });
        DB.commit(); close(); renderRotation();
      }, { kind: 'primary' })]),
    ]));
  }
  function closeSale(sale) {
    if (!sale.bids.length) return toast('입찰자가 없습니다', 'error');
    const byName = Object.fromEntries(s.members.map((m) => [m.name, m]));
    const ranked = [...sale.bids];
    if (sale.bidType === '투력순') ranked.sort((a, b) => (byName[b.name]?.power || 0) - (byName[a.name]?.power || 0));
    else if (sale.bidType === '참여도순') ranked.sort((a, b) => (byName[b.name]?.score || 0) - (byName[a.name]?.score || 0));
    else if (sale.bidType === '경매') ranked.sort((a, b) => (b.amount || 0) - (a.amount || 0));
    const win = ranked[0];
    const price = sale.bidType === '경매' ? (win.amount || 0) : (sale.basePrice || 0);
    confirmDialog(`'${sale.item}' 낙찰: ${win.name} (${fmt(price)} 다이아 · ${sale.bidType}). 분배 기록하고 마감할까요?`, () => {
      Mutations.logDistribution({ date: new Date().toISOString().slice(0, 10), item: sale.item, type: '내판', member: win.name, from: '', price, note: sale.bidType });
      s.sales = s.sales.filter((x) => x.id !== sale.id);
      DB.commit(); toast(`${sale.item} → ${win.name} 낙찰`); renderRotation();
    }, { yesText: '마감 & 기록' });
  }
}
