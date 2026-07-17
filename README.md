# 불면증 클랜 관리 대시보드

GitHub Pages에서 실행되는 클랜 운영 대시보드입니다. 운영 데이터는 **Supabase Postgres**에 저장하고, 변경 알림은 **Supabase Realtime**으로 즉시 전달합니다. 참여도 화면은 스크린샷 OCR 결과에서 인식된 인원을 마커로 표시하므로 누락자를 바로 확인할 수 있습니다.

라이브: https://architect-tools.github.io/clan-dashboard/

## 주요 기능

- 명단, 참여도, 장비·주문석·엘릭서·상태 보드 관리
- 스크린샷 OCR 참여자 자동 매칭 및 인식 마커 표시
- 다이아 정산, 분배 이력, 내판·입찰·낙찰
- 일정, 로테이션, QA 리포트
- 멤버별 원자적 저장, 관리자 revision 충돌 방지, Realtime 자동 새로고침
- JSON 내보내기·가져오기와 매시간 별도 브랜치 백업

## 실시간 DB 구조

브라우저가 전체 JSON을 직접 덮어쓰지 않습니다.

- 명단은 멤버당 한 행, 참여도는 날짜·콘텐츠당 한 행으로 저장합니다.
- 장비·스킬·보드 셀·입찰은 해당 행만 트랜잭션으로 갱신합니다.
- 중복 네트워크 재시도는 mutation ID로 한 번만 적용합니다.
- 관리자 전체 저장은 `adminRevision`이 오래됐으면 거부합니다.
- 모든 클라이언트 쓰기는 `dashboard_*` RPC를 통과하며, RLS가 테이블 직접 쓰기를 차단합니다.
- 익명 Supabase Auth 세션에 선택한 닉네임과 역할을 연결합니다. 비밀번호 해시는 DB에서만 검증합니다.
- `clans.revision` 변경을 구독한 클라이언트가 일관된 최신 스냅샷을 다시 읽습니다.

`apps-script/` 백엔드는 전환 전 복제 원본과 비상 롤백용 이전 모드로만 남겨 둡니다. 자동 배포는 중지되어 있으며 `Legacy Apps Script deploy` workflow를 수동 실행할 때만 갱신합니다. Supabase 연결값이 있으면 앱은 Supabase를 우선 사용합니다.

## 1. Supabase 프로젝트 준비

1. Supabase에서 새 프로젝트를 만듭니다.
2. Authentication의 Anonymous Sign-Ins를 활성화합니다.
3. SQL Editor에서 [001_clan_dashboard.sql](supabase/migrations/001_clan_dashboard.sql), [002_opaque_secret_keys.sql](supabase/migrations/002_opaque_secret_keys.sql) 순서로 실행합니다.
4. Project Settings/API에서 Project URL, Publishable key, Secret(service role) key를 확인합니다.

Publishable key는 RLS 사용을 전제로 브라우저에 넣는 공개 키입니다. Secret/service-role key는 `docs/` 아래나 Git에 절대 넣지 않습니다.

## 2. 기존 Apps Script 데이터 복제

마이그레이션은 먼저 현재 운영 상태를 임시 JSON 파일로 백업하고, 원본·대상 건수를 비교합니다. 기본 실행은 쓰지 않는 dry-run입니다.

PowerShell 예시:

```powershell
$env:SUPABASE_URL='https://PROJECT.supabase.co'
$env:SUPABASE_SERVICE_ROLE_KEY='sb_secret_...'
$env:CLAN_SLUG='insomnia'
$env:CLAN_MEMBER_PASSWORD='멤버 비밀번호'
$env:CLAN_ADMIN_PASSWORD='관리자 비밀번호'

npm run db:migrate:supabase
npm run db:migrate:supabase -- --apply
npm run db:snapshot:supabase
```

또는 [.env.example](.env.example)을 `.env.local`로 복사해 값을 채우면 위 스크립트들이 자동으로 읽습니다. `.env.local`은 Git에서 제외됩니다.

`--apply`는 Supabase의 해당 클랜 데이터를 원본 스냅샷과 동일하게 초기화하므로 최초 이전 또는 계획된 재이관 때만 실행합니다. 현재 운영 Apps Script 데이터는 수정하지 않습니다.

## 3. 대시보드 전환

[config.js](docs/js/config.js)의 공개 연결값을 채웁니다.

```js
SUPABASE_URL: 'https://PROJECT.supabase.co',
SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_...',
CLAN_SLUG: 'insomnia',
APPS_SCRIPT_URL: '',
```

검증 후 `APPS_SCRIPT_URL`을 비우면 브라우저에 남아 있던 이전 Apps Script 모드를 완전히 끕니다. Supabase 모드에서는 `GATE_PASSWORD`와 `ADMIN_PASSWORD` 값을 브라우저가 판정에 사용하지 않습니다. 비밀번호는 마이그레이션 때 생성된 서버 해시로만 확인합니다.

배포는 GitHub 저장소의 Settings → Pages에서 `main` 브랜치의 `/docs`를 선택합니다.

## 4. 백업 설정

GitHub Actions Secrets에 다음 값을 등록합니다.

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

`DB hourly snapshot` workflow가 매시간 일관된 DB 상태를 `db-history` 브랜치에 저장합니다. 전환 전에는 기존 Apps Script 스냅샷을 fallback으로 사용합니다.

## 로컬 실행과 검증

```bash
npx serve docs

npm run check
npm run smoke
npm run test:concurrency
npm run test:supabase
npm run test:sql
npm run gas:check
```

- `check`: 브라우저 모듈 import 검사
- `smoke`: 전 화면 렌더와 계산·뮤테이션 회귀 검사
- `test:concurrency`: 동시 멤버 쓰기, 재시도, 관리자 충돌 회귀 검사
- `test:supabase`: Auth·RPC·Realtime 프런트엔드 어댑터 통합 검사
- `test:sql`: 임시 Postgres에서 마이그레이션과 핵심 RPC를 실제 실행
- `gas:check`: 전환 전용 Apps Script 문법 검사

Docker가 설치된 환경에서는 Supabase CLI로 로컬 DB를 띄운 뒤 SQL을 추가 검증할 수 있습니다. 실제 전환 전에는 별도 Supabase 프로젝트에서 SQL 실행과 dry-run/`--apply` 검증을 먼저 수행합니다.

## OCR

OCR은 브라우저의 Tesseract.js(`kor+eng`)로 실행하므로 별도 OCR 서버나 과금이 필요하지 않습니다.

- 인식된 명단은 캡처 위에 마커로 표시합니다.
- 결과를 `확정 / 확인 필요 / 미매치`로 나눕니다.
- 확인 필요 항목은 후보를 선택해 바로 보정할 수 있습니다.
- 닉네임은 운영 명단과 fuzzy matching하며, 원본 캡처는 DB에 저장하지 않습니다.

## QA 리포트 CLI

관리자 화면에서 접수한 리포트를 조회·응답할 수 있습니다.

```bash
npm run qa:list
npm run qa:show -- <slot>
npm run qa:prompt -- <slot>
npm run qa:reply -- <slot> --status resolved --message "수정 내용과 검증 결과"
```

Supabase 전환 후 CLI에는 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CLAN_SLUG` 환경 변수를 사용합니다. 로컬 JSON은 `--state-file <path>` 또는 `CLANDASH_STATE_FILE`로 처리할 수 있습니다. Apps Script 방식은 전환 전 fallback으로만 유지합니다.

## 저장소 구조

```text
docs/                       GitHub Pages 앱
  data/seed.json            로컬 모드 초기 데이터
  js/supabase-backend.js    Auth·RPC·Realtime 어댑터
  js/                       앱과 화면 코드
supabase/migrations/        Postgres 스키마·RLS·RPC
scripts/migrate-to-supabase.mjs
scripts/supabase-snapshot.mjs
scripts/supabase-test.mjs
apps-script/Code.gs         이전 백엔드/롤백용
```

## 보안 메모

- Publishable key만 브라우저에 둡니다. service-role key는 서버측 스크립트와 GitHub Secret에서만 사용합니다.
- RLS와 Security Definer RPC가 클랜 범위, 역할, 본인 멤버 ID를 다시 확인합니다.
- 현재 멤버 공용 비밀번호 방식은 기존 운영 UX를 유지합니다. 닉네임별 강한 본인 확인이 필요하면 이메일·OTP 로그인으로 확장해야 합니다.
- 브라우저의 로컬 모드는 한 기기 테스트용이며 다중 사용자 운영용이 아닙니다.
