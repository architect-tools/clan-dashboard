// settings.js — 사이트 전역 설정: 화면(UI 스케일) · 클랜 정보 · 연동/데이터.
// (분배 비율·티어컷·고투·운영진·콘텐츠 점수는 distParams.js = '분배 파라미터'로 분리)
import { DB } from '../db.js';
import { el, toast, downloadFile, applyUiScale } from '../util.js';
import { CONFIG } from '../config.js';
import { page, card, btn, input, field, confirmDialog } from './ui.js';

export function renderSettings() {
  const s = DB.state;
  const body = page('설정', { subtitle: '화면 · 클랜 정보 · 데이터 — 사이트 전역 설정' });

  // ── 화면 (UI 스케일) ──
  const cur = s.appSettings.uiScale || 1;
  const val = el('b', { text: Math.round(cur * 100) + '%' });
  const slider = input({ type: 'range', min: '0.7', max: '1.5', step: '0.05', value: String(cur), style: { width: '240px' } });
  slider.addEventListener('input', () => { val.textContent = Math.round(+slider.value * 100) + '%'; applyUiScale(+slider.value); }); // live preview
  body.appendChild(card('화면 크기 (UI 스케일)', el('div', {}, [
    el('p.hint', { text: '대시보드 전체 화면 배율입니다. 글씨·표가 작거나 크면 조절하세요. (저장해야 다음에도 유지됩니다)' }),
    el('div.toolbar', {}, [
      slider, val,
      btn('100%', () => { slider.value = '1'; slider.dispatchEvent(new Event('input')); }, { kind: 'ghost' }),
      btn('저장', () => { s.appSettings.uiScale = +slider.value; DB.commit(); toast('화면 크기를 저장했습니다'); }, { kind: 'primary' }),
    ]),
  ])));

  // ── 클랜 정보 ──
  const clanName = input({ value: s.meta.clanName || '' });
  body.appendChild(card('클랜 정보', el('div', {}, [
    el('div.form-grid', {}, [field('클랜 이름', clanName)]),
    btn('저장', () => { s.meta.clanName = clanName.value.trim() || s.meta.clanName; DB.commit(); toast('저장되었습니다'); }, { kind: 'primary' }),
  ])));

  // ── 분배 파라미터(별도 페이지) 링크 ──
  body.appendChild(card('분배 파라미터', el('div', {}, [
    el('p.hint', { text: '다이아 분배 비율 · 티어컷 · 고투 · 운영진 · 콘텐츠 점수는 별도 페이지에서 관리합니다.' }),
    btn('분배 파라미터 열기', () => location.hash = '#/dist-params', { kind: 'primary' }),
  ])));

  // ── 연동 · 데이터 ──
  body.appendChild(card('연동 · 데이터', el('div', {}, [
    el('p.hint', { html: `현재 모드: <b>${CONFIG.APPS_SCRIPT_URL ? '클라우드 동기화' : '로컬 저장(localStorage)'}</b>. 클라우드 동기화는 <code>js/config.js</code>의 <code>APPS_SCRIPT_URL</code>을 채우면 활성화됩니다.` }),
    el('div.row-actions', {}, [
      btn('전체 데이터 내보내기(JSON)', () => downloadFile('clandash-backup.json', JSON.stringify(DB.state, null, 2)), { kind: 'ghost' }),
      btn('데이터 가져오기(JSON)', () => importJson(), { kind: 'ghost' }),
      btn('로컬 데이터 초기화', () => confirmDialog('로컬 저장 데이터를 모두 지우고 시드로 되돌립니다. 계속할까요?', () => { localStorage.removeItem(CONFIG.STORE_KEY); location.reload(); }, { danger: true, yesText: '초기화' }), { kind: 'ghost-danger' }),
    ]),
  ])));

  function importJson() {
    const fi = el('input', { type: 'file', accept: '.json', style: { display: 'none' } });
    fi.onchange = async () => {
      try {
        const data = JSON.parse(await fi.files[0].text());
        if (!data || typeof data !== 'object') throw new Error('형식 오류');
        localStorage.setItem(CONFIG.STORE_KEY, JSON.stringify(data)); // re-normalized on reload
        toast('가져왔습니다 — 새로고침합니다'); setTimeout(() => location.reload(), 600);
      } catch (e) { toast('가져오기 실패: ' + e.message, 'error'); }
    };
    document.body.appendChild(fi); fi.click(); fi.remove();
  }
}
