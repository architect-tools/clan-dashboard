// equip.js — 구조화된 클랜원 장착 장비 (게임 장비창 슬롯 레이아웃).
// member.equip = { [슬롯명]: { grade, tier, enhance } }. 무기/방어구/장신구/특수 그룹.
import { DB } from '../db.js';
import { el, clear } from '../util.js';
import { modal, btn, field, input } from './ui.js';

export const EQUIP_GROUPS = [
  { label: '무기', slots: ['무기', '보조무기1', '보조무기2'] },
  { label: '방어구', slots: ['투구', '견갑', '흉갑', '각반', '허리띠', '장갑', '신발', '망토'] },
  { label: '장신구', slots: ['목걸이', '귀걸이', '반지', '팔찌'] },
  { label: '특수', slots: ['복종', '충성', '무한', '심연'] },
];

/** Render a member's equipment as the game-like slot grid.
 *  editable → click a slot to set 등급/티어/강화 (자동 저장, 그리드 자체 갱신). */
export function equipGrid(member, { editable = false } = {}) {
  const wrap = el('div.equip-wrap');
  const render = () => {
    clear(wrap);
    for (const g of EQUIP_GROUPS) {
      const row = el('div.equip-row');
      for (const slot of g.slots) {
        const it = (member.equip || {})[slot];
        const filled = !!(it && (it.grade || it.tier || it.enhance));
        const box = el('div.equip-box', {
          class: filled ? '' : 'empty',
          title: editable ? '클릭해서 편집' : (filled ? `${it.grade || ''} T${it.tier || '-'} +${it.enhance || 0}` : '빈 슬롯'),
          onclick: editable ? () => editSlot(member, slot, render) : null,
        }, filled ? [
          it.grade ? el('span.equip-grade', { text: it.grade }) : null,
          it.tier ? el('span.equip-tier', { text: 'T' + it.tier }) : null,
          it.enhance ? el('span.equip-enh', { text: '+' + it.enhance }) : null,
        ] : [el('span.equip-empty-mark', { text: editable ? '＋' : '–' })]);
        row.appendChild(el('div.equip-slot', {}, [box, el('div.equip-name', { text: slot })]));
      }
      wrap.appendChild(el('div.equip-group', {}, [el('div.equip-group-label', { text: g.label }), row]));
    }
  };
  render();
  return wrap;
}

function editSlot(member, slot, rerender) {
  const cur = (member.equip || {})[slot] || {};
  const grade = input({ value: cur.grade || '', placeholder: '예: E / D / S' });
  const tier = input({ type: 'number', value: cur.tier ?? '', placeholder: '1~10' });
  const enh = input({ type: 'number', value: cur.enhance ?? '', placeholder: '강화 수치' });
  const filled = !!(cur.grade || cur.tier || cur.enhance);
  modal(`${member.name} · ${slot}`, (close) => el('div.form', {}, [
    field('등급', grade), field('티어', tier), field('강화 (+)', enh),
    el('div.modal-actions', {}, [
      filled ? btn('비우기', () => { if (member.equip) delete member.equip[slot]; DB.commit(); close(); rerender(); }, { kind: 'ghost-danger' }) : null,
      btn('취소', close),
      btn('저장', () => {
        const g = grade.value.trim(), t = +tier.value || 0, e = +enh.value || 0;
        member.equip ||= {};
        if (!g && !t && !e) delete member.equip[slot];
        else member.equip[slot] = { grade: g, tier: t, enhance: e };
        DB.commit(); close(); rerender();
      }, { kind: 'primary' }),
    ]),
  ]));
}
