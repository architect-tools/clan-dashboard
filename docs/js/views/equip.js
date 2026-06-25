// equip.js — 구조화된 클랜원 장착 장비 (게임 장비창 슬롯 레이아웃).
// member.equip = { [슬롯]: { star(1~6 성급), tier(1~8.5, .5단위), enhance } }.
// 3성↑ & 티어가 x.5 면 '배경템' → 슬롯에 벌집무늬. 성급별 색상.
import { DB } from '../db.js';
import { el, clear } from '../util.js';
import { modal, btn, field, input, select } from './ui.js';

export const EQUIP_GROUPS = [
  { label: '무기', cols: 3, slots: ['무기', '보조무기1', '보조무기2'] },
  { label: '방어구', cols: 4, slots: ['투구', '견갑', '흉갑', '각반', '허리띠', '장갑', '신발', '망토'] },
  { label: '장신구', cols: 4, slots: ['목걸이', '귀걸이', '반지', '팔찌'] },
  { label: '특수', cols: 4, slots: ['복종', '충성', '무한', '심연'] },
];

// 1성 회색 · 2성 초록 · 3성 파랑 · 4성 빨강 · 5성 보라 · 6성 노랑 (밝은 배경 가독성용 톤)
const STAR_COLORS = ['', '#8a8f9c', '#3a8a52', '#3b6ea8', '#c2453f', '#9a5cc4', '#c08a1e'];
const TIER_OPTS = Array.from({ length: 16 }, (_, i) => 1 + i * 0.5); // 1 ~ 8.5 (.5 단위)
const tierLabel = (t) => (Number.isInteger(t) ? t : t.toFixed(1)) + 'T';
const isBgItem = (star, tier) => star >= 3 && (tier % 1 === 0.5); // 3성↑ + x.5T = 배경템

/** Render a member's equipment as the game-like slot grid.
 *  editable → click a slot to set 성급/티어/강화 (자동 저장, 그리드 자체 갱신). */
export function equipGrid(member, { editable = false } = {}) {
  const wrap = el('div.equip-wrap');
  const render = () => {
    clear(wrap);
    for (const g of EQUIP_GROUPS) {
      const row = el('div.equip-row', { style: { '--cols': String(g.cols) } });
      for (const slot of g.slots) {
        const it = (member.equip || {})[slot];
        const filled = !!(it && (it.star || it.tier || it.enhance));
        const star = (it && it.star) || 0;
        const color = STAR_COLORS[star] || '';
        const bg = filled && isBgItem(star, it.tier || 0);
        const box = el('div.equip-box', {
          class: (filled ? '' : 'empty') + (bg ? ' bg-item' : ''),
          style: filled && color ? { borderColor: color } : {},
          title: editable ? '클릭해서 편집'
            : (filled ? `${star ? star + '성 ' : ''}${it.tier ? tierLabel(it.tier) + ' ' : ''}${it.enhance ? '+' + it.enhance : ''}`.trim() : '빈 슬롯'),
          onclick: editable ? () => editSlot(member, slot, render) : null,
        }, filled ? [
          star ? el('span.equip-star', { style: { color }, text: star + '성' }) : null,
          it.tier ? el('span.equip-tier', { text: tierLabel(it.tier) }) : null,
          it.enhance ? el('span.equip-enh', { text: '+' + it.enhance }) : null,
        ] : [el('span.equip-empty-mark', { text: editable ? '＋' : '' })]);
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
  const star = select([{ value: '0', label: '없음' }, ...[1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: n + '성' }))], String(cur.star || 0));
  const tier = select([{ value: '0', label: '없음' }, ...TIER_OPTS.map((t) => ({ value: String(t), label: tierLabel(t) }))], String(cur.tier || 0));
  const enh = input({ type: 'number', value: cur.enhance ?? '', placeholder: '강화 수치' });
  const filled = !!(cur.star || cur.tier || cur.enhance);
  modal(`${member.name} · ${slot}`, (close) => el('div.form', {}, [
    field('성급', star), field('티어', tier), field('강화 (+)', enh),
    el('p.hint', { text: '3성급 이상 + 티어가 x.5(예: 3.5T)면 배경템 → 슬롯에 벌집무늬가 표시됩니다.' }),
    el('div.modal-actions', {}, [
      filled ? btn('비우기', () => { if (member.equip) delete member.equip[slot]; DB.commit(); close(); rerender(); }, { kind: 'ghost-danger' }) : null,
      btn('취소', close),
      btn('저장', () => {
        const st = +star.value || 0, t = +tier.value || 0, e = +enh.value || 0;
        member.equip ||= {};
        if (!st && !t && !e) delete member.equip[slot];
        else member.equip[slot] = { star: st, tier: t, enhance: e };
        DB.commit(); close(); rerender();
      }, { kind: 'primary' }),
    ]),
  ]));
}
