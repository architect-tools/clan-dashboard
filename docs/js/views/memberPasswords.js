// memberPasswords.js — admin-only per-member login password management.
import { Roles } from '../roles.js';
import { SupabaseBackend } from '../supabase-backend.js';
import { el, toast } from '../util.js';
import { page, card, table, btn, input, confirmDialog } from './ui.js';

let query = '';

export async function renderMemberPasswords() {
  const body = page('멤버 비밀번호', {
    subtitle: '클랜원별 6자리 로그인 비밀번호 · 관리자 전용',
  });
  if (!Roles.isAdmin()) {
    body.appendChild(el('div.empty', { text: '관리자만 볼 수 있는 페이지입니다.' }));
    return;
  }
  if (!SupabaseBackend.isConfigured()) {
    body.appendChild(el('div.empty', { text: '멤버별 비밀번호는 실시간 DB 연결 상태에서만 사용할 수 있습니다.' }));
    return;
  }

  body.appendChild(el('div.empty.member-password-loading', { text: '비밀번호 목록을 불러오는 중…' }));
  try {
    const rows = await SupabaseBackend.memberPasswords();
    renderRows(body, rows);
  } catch (error) {
    console.error(error);
    body.innerHTML = '';
    body.appendChild(el('div.empty', { text: '비밀번호 목록을 불러오지 못했습니다: ' + error.message }));
  }
}

function renderRows(body, rows) {
  const refresh = () => renderRows(body, rows);
  const filtered = () => rows.filter((row) => !query || row.name.includes(query));
  body.innerHTML = '';

  const search = input({
    placeholder: '닉네임 검색', value: query,
    oninput: (event) => { query = event.target.value.trim(); refresh(); },
  });
  body.appendChild(card('사용 안내', el('div.member-password-guide', {}, [
    el('p.hint', { text: '각 비밀번호는 해당 클랜원에게만 전달하세요. 비밀번호를 재발급하면 기존 비밀번호로 로그인된 해당 멤버 세션도 해제됩니다.' }),
    el('div.toolbar.member-password-toolbar', {}, [
      search,
      btn('활동 멤버 전체 복사', () => copyAll(rows.filter((row) => row.active)), { kind: 'ghost' }),
    ]),
  ])));

  body.appendChild(card('발급 현황', el('div.chips.summary-chips', {}, [
    el('span.chip', { text: `전체 ${rows.length}명` }),
    el('span.chip', { text: `활동 ${rows.filter((row) => row.active).length}명` }),
    el('span.chip', { text: '6자리 숫자' }),
  ])));

  body.appendChild(card(null, table([
    { label: '상태', width: '70px', align: 'center', render: (row) => el('span.member-password-status', {
      class: row.active ? 'active' : 'inactive', text: row.active ? '활동' : '휴면',
    }) },
    { key: 'name', label: '닉네임' },
    { label: '로그인 비밀번호', render: (row) => el('code.member-password-value', { text: row.password }) },
    { label: '', align: 'right', render: (row) => el('div.row-actions.nowrap', {}, [
      btn('복사', () => copyText(row.password, `${row.name} 비밀번호를 복사했습니다`), { kind: 'ghost' }),
      btn('재발급', () => resetPassword(row, rows, body), { kind: 'ghost-danger' }),
    ]) },
  ], filtered(), { empty: '검색 결과가 없습니다.' })));
}

function resetPassword(row, rows, body) {
  confirmDialog(`${row.name} 님의 비밀번호를 새로 발급할까요? 기존 비밀번호는 즉시 사용할 수 없게 됩니다.`, async () => {
    try {
      const result = await SupabaseBackend.resetMemberPassword(row.memberId);
      row.password = result.password;
      renderRows(body, rows);
      toast(`${row.name} 비밀번호를 재발급했습니다`);
    } catch (error) {
      console.error(error);
      toast('비밀번호 재발급 실패: ' + error.message, 'error');
    }
  }, { danger: true, yesText: '재발급' });
}

async function copyAll(rows) {
  const text = rows.map((row) => `${row.name}\t${row.password}`).join('\n');
  await copyText(text, `활동 멤버 ${rows.length}명의 비밀번호를 복사했습니다`);
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = el('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.appendChild(area); area.select();
    document.execCommand('copy'); area.remove();
  }
  toast(message);
}
