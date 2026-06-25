// equip.js — 구조화된 클랜원 장착 장비 (게임 장비창 슬롯 레이아웃).
// member.equip = { [슬롯]: { star(1~6 성급), tier(1~8.5, .5단위), enhance } }.
// 3성↑ & 티어가 x.5 면 '배경템' → 슬롯에 벌집무늬. 성급별 색상.
// 예외: 성유물 슬롯은 { tier(정수, T1~) }만 — 성급·강화·배경템·분배 없음(거래 불가).
import { DB } from '../db.js';
import { el, clear } from '../util.js';
import { modal, btn, field, input, select } from './ui.js';

// 슬롯명은 운영 시트(장비 현황)와 일치: 주무기/보조1/보조2, 투구/견갑/상의/하의/벨트/장갑/신발/망토.
export const EQUIP_GROUPS = [
  { label: '무기', cols: 3, slots: ['주무기', '보조1', '보조2'] },
  { label: '방어구', cols: 4, slots: ['투구', '견갑', '상의', '하의', '벨트', '장갑', '신발', '망토'] },
  { label: '장신구', cols: 4, slots: ['목걸이', '귀걸이', '반지', '팔찌'] },
  { label: '성유물', cols: 4, slots: ['복종', '충성', '무한', '심연'] },
];

// 1성 회색 · 2성 초록 · 3성 파랑 · 4성 빨강 · 5성 보라 · 6성 노랑 (Insomnia 다크 팔레트)
const STAR_COLORS = ['', '#868F9F', '#6FB390', '#6FA0DD', '#DC807C', '#AB8FD9', '#E7C45A'];
const TIER_OPTS = Array.from({ length: 16 }, (_, i) => 1 + i * 0.5); // 1 ~ 8.5 (.5 단위)
const tierLabel = (t) => (Number.isInteger(t) ? t : t.toFixed(1)) + 'T';
const isBgItem = (star, tier) => star >= 3 && (tier % 1 === 0.5); // 3성↑ + x.5T = 배경템

// 성유물(복종·충성·무한·심연): 티어만 있는 거래 불가 장비. 성급·강화·배경템 없음, 티어는 정수(T1~).
const RELIC_SLOTS = new Set(EQUIP_GROUPS.find((g) => g.label === '성유물').slots);
const isRelic = (slot) => RELIC_SLOTS.has(slot);
const RELIC_TIERS = Array.from({ length: 20 }, (_, i) => i + 1); // T1 ~ T20 (정수)
const relicTierLabel = (t) => 'T' + t; // 게임 표기: T10, T7 …
// 티어 구간별 색: T1~3 동색 · T4~6 은색 · T7~9 금색 · T10~ 프리즘(무지개, CSS 처리)
const RELIC_BRONZE = '#C0813E', RELIC_SILVER = '#C2CAD6', RELIC_GOLD = '#E7C45A';
const relicTone = (t) => t >= 10 ? 'prism' : t >= 7 ? RELIC_GOLD : t >= 4 ? RELIC_SILVER : RELIC_BRONZE;

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
        const relic = isRelic(slot);
        const filled = relic ? !!(it && it.tier) : !!(it && (it.star || it.tier || it.enhance));
        const star = (it && it.star) || 0;
        const tone = relic && filled ? relicTone(it.tier) : ''; // 색(hex) 또는 'prism'
        const prism = tone === 'prism';
        const color = relic ? (prism ? '' : tone) : (STAR_COLORS[star] || '');
        const bg = !relic && filled && isBgItem(star, it.tier || 0);
        const box = el('div.equip-box', {
          class: (filled ? '' : 'empty') + (bg ? ' bg-item' : '') + (relic ? ' relic' : '') + (prism ? ' relic-prism' : ''),
          style: filled && color ? { borderColor: color, background: `linear-gradient(135deg, color-mix(in srgb, ${color} 34%, var(--bg2)), var(--bg2) 72%)` } : {},
          title: editable ? '클릭해서 편집'
            : (filled ? (relic ? relicTierLabel(it.tier) : `${star ? star + '성 ' : ''}${it.tier ? tierLabel(it.tier) + ' ' : ''}${it.enhance ? '+' + it.enhance : ''}`.trim()) : '빈 슬롯'),
          onclick: editable ? () => editSlot(member, slot, render) : null,
        }, filled
          ? (relic
            ? [el('span.equip-tier.relic-tier', prism ? { class: 'prism', text: relicTierLabel(it.tier) } : { style: { color: tone }, text: relicTierLabel(it.tier) })]
            : [
              star ? el('span.equip-star', { style: { color }, text: star + '성' }) : null,
              it.tier ? el('span.equip-tier', { text: tierLabel(it.tier) }) : null,
              it.enhance ? el('span.equip-enh', { text: '+' + it.enhance }) : null,
            ])
          : [el('span.equip-empty-mark', { text: editable ? '＋' : '' })]);
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
  if (isRelic(slot)) return editRelic(member, slot, cur, rerender);
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

// 성유물 슬롯 편집: 티어(정수)만. 성급·강화 없음.
function editRelic(member, slot, cur, rerender) {
  const tier = select([{ value: '0', label: '없음' }, ...RELIC_TIERS.map((t) => ({ value: String(t), label: relicTierLabel(t) }))], String(cur.tier || 0));
  const filled = !!cur.tier;
  modal(`${member.name} · ${slot} (성유물)`, (close) => el('div.form', {}, [
    field('티어', tier),
    el('p.hint', { text: '성유물은 티어만 있는 거래 불가 장비입니다 (성급·강화 없음). 색: T1~3 동색 · T4~6 은색 · T7~9 금색 · T10~ 프리즘.' }),
    el('div.modal-actions', {}, [
      filled ? btn('비우기', () => { if (member.equip) delete member.equip[slot]; DB.commit(); close(); rerender(); }, { kind: 'ghost-danger' }) : null,
      btn('취소', close),
      btn('저장', () => {
        const t = +tier.value || 0;
        member.equip ||= {};
        if (!t) delete member.equip[slot];
        else member.equip[slot] = { tier: t }; // 성급·강화 없음
        DB.commit(); close(); rerender();
      }, { kind: 'primary' }),
    ]),
  ]));
}
