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
};
