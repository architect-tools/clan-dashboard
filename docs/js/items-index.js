// items-index.js — 아이템 아이콘 인덱스(자동 크롭 라이브러리 docs/assets/items/item_NNN.webp).
// ~item_references 스크린샷에서 크롭·밝기보정 후 이름→직업으로 인덱싱. 키는 공백 제거한 스킬명.
// 주문석: 이름에 ':직업'이 있어 직업별 매핑. (트래킹 12종 + 미트래킹 extra 포함)
import { COMMON_SPELLSTONE_ICONS } from './common-stones.js';
export const ITEM_ICON_BASE = 'assets/items/';
// ?v= 캐시 무효화 — 아이콘 재크롭 시 숫자 올려 브라우저가 새로 받게(파일명 동일이라 캐시됨)
export const iconFile = (id) => ITEM_ICON_BASE + 'item_' + String(id).padStart(3, '0') + '.webp?v=4';
const norm = (s) => String(s || '').replace(/[\s:\-]/g, '');

export const SPELLSTONE_ICONS = {
  전사: { 칼날쇄도: 139, 분노방출: 145, 정신집중: 151, 파열의칼날: 152, 파멸: 155, 다중궤적: 159, 신체강화: 153, 철갑의분노: 156, 사슬구속: 157, 도약베기: 158, 전투선포: 154, 검의낙인: 147, 패왕의투지: 160, 검의포효: 161, 철의수호: 162 },
  마법사: { 마력인장: 142, 얼음가시: 150, 정신집중: 163, 지옥불: 148, 공간압축: 167, 서리지옥: 171, 신체강화: 164, 고밀도마력: 168, 마법보호막: 165, 얼음기둥: 169, 마력순환: 166, 가호: 170, 영겁의지혜: 172, 마나의요람: 173, 원소과부하: 174 },
  전투사제: { 비틀린격류: 141, 폭류: 144, 정신집중: 175, 바람쇄도: 146, 뒤틀린운명: 179, 심연의샘: 183, 신체강화: 176, 자연의힘: 180, 치유: 177, 구원: 181, 정화: 178, 집중치유: 182, 심판자의숨: 109, 신의숨결: 110, 빛의세례: 111 },
  암살자: { 그림자쇄도: 140, 모래뿌리기: 113, 정신집중: 112, 독안개: 114, 강습: 118, 잔영난무: 121, 신체강화: 115, 암살자의길: 119, 비도: 116, 은신: 149, 사냥개시: 117, 절멸: 120, 살의의안광: 122, 그림자안개: 123, 살기응축: 124 },
  사냥꾼: { 연사: 143, 다발화살: 126, 정신집중: 125, 화살비: 127, 영혼화살: 131, 사슬궁: 135, 신체강화: 128, 사냥감각: 132, 추적화살: 129, 그림자덫: 133, 약점포착: 130, 전투해방: 134, 명궁의응시: 136, 바람의올가미: 137, 지배자의시선: 138 },
};

// 엘릭서: 이름에 직업이 없어(아이콘 뱃지로 구분) 이름→직업 확실한 것만 매핑. 4·5성 중 보유본.
export const ELIXIR_ICONS = {
  공용: { 집중호흡: 1, 영웅의기운: 2 },
  전사: { 전사의기운: 84, 강철의분노: 94, 타오르는분노: 98, 철벽의수호: 104 },
  마법사: { 마법사의기운: 86, 정신폭발: 96, 얼어붙은불꽃: 99, 전장의눈: 106 },
  전투사제: { 전투사제의기운: 87, 성스러운광휘: 89, 얼어붙은독기: 100, 성역: 107 },
  암살자: { 암살자의기운: 85, 그림자의칼날: 97, 잔혹한각인: 101, 선고: 105 },
  사냥꾼: { 사냥꾼의기운: 88, 야수의송곳니: 95, 혈흔의본능: 102, 잿빛화살: 108 },
};

export function stoneIcon(cls, name) {
  const m = SPELLSTONE_ICONS[cls]; const id = m && m[norm(name)];
  return id ? iconFile(id) : null;
}
export function elixirIcon(cls, name) {
  const id = (ELIXIR_ICONS[cls] && ELIXIR_ICONS[cls][norm(name)]) || (ELIXIR_ICONS['공용'] && ELIXIR_ICONS['공용'][norm(name)]);
  return id ? iconFile(id) : null;
}
export function commonStoneIcon(name) {
  const id = COMMON_SPELLSTONE_ICONS[norm(name)];
  return id ? iconFile(id) : null;
}
/** 주문석/엘릭서 표 헤더용 아이콘 경로(없으면 null). 주문석 공용 탭 = 공용 주문석(범용 효과석). */
export function skillIcon(cat, classKey, name) {
  if (cat === '주문석') return classKey === '공용' ? commonStoneIcon(name) : stoneIcon(classKey, name);
  return elixirIcon(classKey, name);
}
