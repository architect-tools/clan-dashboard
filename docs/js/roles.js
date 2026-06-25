// roles.js — client-side role + identity (UI gating only).
// 입장 시 닉네임(ME)과 역할(ROLE)을 저장한다. 백엔드 쓰기 토큰은 항상 7979(멤버)로
// 고정이므로 이 역할 구분은 화면 제어용이다(공개 repo·last-write-wins). 진짜 서버
// 강제는 Phase 2(관리자 토큰 분리 + 입찰 전용 엔드포인트)에서.
import { CONFIG } from './config.js';

export const Roles = {
  me() { return localStorage.getItem(CONFIG.ME_KEY) || ''; },
  role() { return localStorage.getItem(CONFIG.ROLE_KEY) || 'member'; },
  isAdmin() { return this.role() === 'admin'; },
  // 입찰 취소: 관리자는 전부, 멤버는 자기 입찰만
  canCancelBid(bid) { return this.isAdmin() || (!!bid && bid.name === this.me()); },
  // 장비 등 '내 것'은 멤버도 편집 가능
  isMe(name) { return !!name && name === this.me(); },
  // 선택 목록에서 본인을 맨 위로(편의). list = 이름 문자열 배열 또는 멤버 객체 배열.
  selfFirst(list, nameOf = (x) => (typeof x === 'string' ? x : x && x.name)) {
    const me = this.me();
    if (!me || !Array.isArray(list)) return list;
    const i = list.findIndex((x) => nameOf(x) === me);
    if (i <= 0) return list;
    const copy = [...list];
    copy.unshift(copy.splice(i, 1)[0]);
    return copy;
  },
};
