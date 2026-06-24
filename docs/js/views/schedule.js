// schedule.js — weekly clan content schedule (editable event list by weekday).
import { DB } from '../db.js';
import { el, toast, uid } from '../util.js';
import { page, card, btn, modal, input, select, field, confirmDialog } from './ui.js';

const DAYS = ['월', '화', '수', '목', '금', '토', '일'];

// Sensible defaults derived from the source 일정 sheet (daily raids + weekly bosses).
const DEFAULTS = [
  { time: '12:00', name: '대범람', group: '전체' },
  { time: '21:00', name: '대범람', group: '전체' },
  { time: '22:00', name: '월보', group: '전체' },
  { time: '22:30', name: '거인의 탑', group: '전체' },
];

export function renderSchedule() {
  const s = DB.state;
  if (!s.schedule.length) {
    DAYS.forEach((d) => DEFAULTS.forEach((e) => s.schedule.push({ id: uid(), day: d, ...e, note: '' })));
    DB.commit();
  }
  const body = page('일정', { subtitle: '클랜 콘텐츠 주간 일정', actions: [
    btn('+ 일정 추가', () => editEvent(null), { kind: 'primary' }),
    btn('초기화', () => confirmDialog('일정을 모두 지울까요?', () => { s.schedule = []; DB.commit(); renderSchedule(); }, { danger: true, yesText: '초기화' }), { kind: 'ghost-danger' }),
  ] });

  const grid = el('div.sched-grid');
  DAYS.forEach((day) => {
    const items = s.schedule.filter((e) => e.day === day).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    const col = el('div.sched-col', {}, [
      el('div.sched-day', { class: (day === '토' || day === '일') ? 'weekend' : '', text: day + '요일' }),
    ]);
    if (!items.length) col.appendChild(el('div.empty.small', { text: '일정 없음' }));
    items.forEach((e) => col.appendChild(el('div.sched-event', { onclick: () => editEvent(e) }, [
      el('span.sched-time', { text: e.time || '' }),
      el('span.sched-name', { text: e.name }),
      e.group && e.group !== '전체' ? el('span.sched-group', { text: e.group }) : null,
    ])));
    col.appendChild(el('button.sched-add', { text: '+', title: day + '요일 일정 추가', onclick: () => editEvent({ day }) }));
    grid.appendChild(col);
  });
  body.appendChild(card(null, grid, { className: 'card-flush' }));
}

function editEvent(e) {
  const s = DB.state;
  const isNew = !e || !e.id;
  const day = select(DAYS, e?.day || '월');
  const time = input({ type: 'time', value: e?.time || '21:00' });
  const name = input({ value: e?.name || '', placeholder: '예: 대범람 / 심연 / 월보' });
  const group = input({ value: e?.group || '전체', placeholder: '예: 7그룹 / 전체' });
  const note = input({ value: e?.note || '', placeholder: '메모(선택)' });
  modal(isNew ? '일정 추가' : '일정 수정', (close) => el('div.form', {}, [
    field('요일', day), field('시간', time), field('콘텐츠', name), field('그룹', group), field('메모', note),
    el('div.modal-actions', {}, [
      !isNew ? btn('삭제', () => { s.schedule = s.schedule.filter((x) => x.id !== e.id); DB.commit(); close(); renderSchedule(); }, { kind: 'ghost-danger' }) : null,
      btn('취소', close),
      btn('저장', () => {
        if (!name.value.trim()) return toast('콘텐츠명을 입력하세요', 'error');
        const data = { day: day.value, time: time.value, name: name.value.trim(), group: group.value.trim() || '전체', note: note.value.trim() };
        if (isNew) s.schedule.push({ id: uid(), ...data });
        else Object.assign(s.schedule.find((x) => x.id === e.id), data);
        DB.commit(); close(); toast('저장되었습니다'); renderSchedule();
      }, { kind: 'primary' }),
    ]),
  ]));
}
