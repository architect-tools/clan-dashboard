# 🌙 불면증 클랜 관리 대시보드

기존 구글 시트 3개(클랜 관리 / 순번제 / 다이아 계산)를 대체하는 **관리자 웹 대시보드**입니다.
GitHub Pages에 배포하고, 데이터는 구글 시트(Apps Script)에 저장하며, **스크린샷 OCR로 참여자를 자동 기입**합니다.

**🔗 라이브: https://architect-tools.github.io/clan-dashboard/** (기본 비밀번호 `insomnia`)

> OCR은 **Tesseract.js**(브라우저 내장, 무료, kor+eng)를 사용합니다. 별도 키/서버 없이 동작합니다.
> 실측 인식률: 클랜 패널 4종(31·37·46·45명, 총 159명) **자동확정 158/159 · 오인식 0**(오프라인 검증) — 다중 스케일 × 전처리 합의 매칭(원본·이진화132·이진화110, 전 변형이 브라우저 캔버스와 픽셀 동일). 못 찾는 인원은 '확인필요'에서 드롭다운으로 1초.

## ✨ 주요 기능

| 메뉴 | 기능 |
|---|---|
| 🏠 대시보드 | 클랜원 수·총 다이아·평균 전투력·티어/직업 분포, 전투력·참여점수 TOP |
| 👥 명단 관리 | 클랜원 CRUD(닉네임/직업/전투력/참여점수), 검색·정렬·필터, 티어 자동 표시 |
| 📷 주간 참여도 | **스크린샷 체크인(OCR)** + 콘텐츠별 체크 그리드 → 참여점수 자동 산정 → 명단 반영 |
| 💎 다이아 정산 | 운영진 + 투력(고투) + 참여도(티어) 자동 계산, 검증·CSV 내보내기 (기존 시트와 **다이아 단위까지 동일**) |
| 🎁 순번제/분배 | 설계도·완제 아이템 순번 큐(순서 변경·지급 처리), 분배 내역, 무기 강화 현황 |
| 📅 일정 | 요일별 클랜 콘텐츠 일정 편집 |
| ⚙️ 설정 | 총 다이아·비율·티어컷·고투비율·운영진·콘텐츠 점수표, 백업/복원 |
| 🧪 QA 리포트 | 관리자 대시보드에서 버그 리포트 접수, 처리 상태, Codex 응답 히스토리 확인 |

### 핵심 설계
- **별도 백엔드 불필요로 즉시 동작**: 기본은 브라우저 `localStorage`에 저장(로컬 모드). GitHub Pages에 올리면 바로 사용 가능.
- **선택적 클라우드 동기화**: Apps Script Web App URL을 넣으면 구글 시트에 저장 + 여러 기기 동기화 + 네이버 OCR.
- **OCR은 알려진 명단과 퍼지 매칭**: 한글 인식이 완벽하지 않아도 `싸다/아싸다/빛싸다`처럼 비슷한 닉네임까지 정확히 구분 (검증 완료).
- **계산 로직은 시트 수식에서 분리**: 모든 정산을 JS로 재구현 → 기존 시트의 깨지기 쉬운 수식에 의존하지 않음.

---

## 🚀 1단계: GitHub Pages 배포 (필수, 5분)

1. GitHub에 새 저장소(repo)를 만듭니다. (예: `clan-dashboard`)
2. 이 폴더를 푸시합니다:
   ```bash
   git remote add origin https://github.com/<아이디>/clan-dashboard.git
   git push -u origin main
   ```
3. 저장소 **Settings ▸ Pages** → Source를 **Deploy from a branch**, 브랜치 `main`, 폴더 **`/docs`** 선택 → Save.
4. 1~2분 뒤 `https://<아이디>.github.io/clan-dashboard/` 접속 → 비밀번호 입력(기본 `insomnia`).

> 비밀번호는 `docs/js/config.js`의 `GATE_PASSWORD`에서 변경하세요.

이 상태로도 **모든 기능이 동작**합니다(로컬 저장). 데이터는 그 브라우저에만 저장되니, 여러 명이 쓰거나 OCR을 쓰려면 2단계를 진행하세요.

---

## ☁️ 2단계: 구글 시트 동기화 + OCR (선택)

### 2-1. Apps Script 백엔드 배포
1. [sheets.new](https://sheets.new) 로 **새 구글 시트**를 만듭니다. (이게 DB가 됩니다)
2. 메뉴 **확장 프로그램 ▸ Apps Script**.
3. `apps-script/Code.gs` 내용을 전부 복사해 붙여넣고 저장.
4. 좌측 **프로젝트 설정 ⚙️ ▸ 스크립트 속성**에 추가:
   - `GATE_PASSWORD` = 대시보드 비밀번호와 동일하게
   - (OCR 쓸 때) `NAVER_OCR_URL`, `NAVER_OCR_SECRET` — 아래 2-3 참고
5. **배포 ▸ 새 배포 ▸ 유형: 웹 앱** → 실행: **나**, 액세스 권한: **모든 사용자** → 배포 → URL 복사.
6. `docs/js/config.js`의 `APPS_SCRIPT_URL`에 그 URL(`…/exec`)을 붙여넣고 다시 푸시.

이제 모드 표시가 `☁ 클라우드 동기화`로 바뀌고, 변경사항이 구글 시트에 저장됩니다.
(시트의 `명단(미러)`·`분배내역(미러)` 탭에서 사람이 보기 좋게 확인 가능 — 수정은 대시보드에서)

### 2-2. 기존 데이터 가져오기 (이미 seed에 반영됨)
초기 데이터(48명 명단·설정·콘텐츠·순번)는 `docs/data/seed.json`에 이미 들어 있습니다.
나중에 원본 시트에서 다시 가져오려면:
```bash
# 원본 시트 CSV를 받아 csv 폴더에 저장한 뒤
node scripts/build-seed.mjs <csv폴더> docs/data/seed.json
```

### 2-3. OCR (설정 불필요)
OCR은 **Tesseract.js**(브라우저 내장, kor+eng)로 동작하므로 별도 키/과금이 없습니다.
(네이버 CLOVA OCR은 유료 전환되어 사용하지 않습니다.)
- 인식 팁: 체크인 창에서 **이름이 있는 영역을 드래그**하면 배경 잡음이 빠져 인식률이 크게 올라갑니다.
- 결과는 **신뢰 / 확인필요 / 미매칭**으로 분류되며, 미매칭은 드롭다운으로 직접 지정합니다.
- 게임 내 닉네임(예: `oO서영Oo`, `s하울s`, `EXE`)을 명단에 그대로 등록해두면 스크린샷과 바로 매칭됩니다.

---

## 🖥️ 로컬에서 미리보기

정적 사이트라 아무 서버로나 열 수 있습니다:
```bash
npx serve docs        # 또는: python -m http.server 8080 --directory docs
```
브라우저에서 표시되는 주소로 접속.

## 🧪 개발/검증 스크립트
```bash
npm run check    # import 그래프 일관성 검사
npm run smoke    # jsdom으로 전 화면 렌더 + 정산/뮤테이션 검증
node scripts/build-seed.mjs <csv폴더>   # 시드 재생성
```

## 🧪 QA 리포트 처리 흐름
관리자 대시보드 상단의 `버그 리포트 작성`에서 접수하고, `QA 히스토리`에서 슬롯별 요청/응답을 확인합니다.

이 PC에서 Codex CLI로 처리할 때는 같은 DB 상태를 읽는 보조 명령을 사용합니다:
```bash
npm run qa:list                 # 미해결 QA 리포트 목록
npm run qa:create -- --title "테스트 리포트"
npm run qa:show -- <slot>
npm run qa:prompt -- <slot>
npm run qa:reply -- <slot> --status resolved --message "수정 내용과 검증 결과"
npm run qa:delete -- <slot>
```

`APPS_SCRIPT_URL`이 비어 있는 로컬 JSON 상태를 처리할 때는 `--state-file <path>` 또는 `CLANDASH_STATE_FILE`을 지정하세요.

## 📁 구조
```
docs/                 ← GitHub Pages가 서빙하는 루트
  index.html
  assets/css/style.css
  data/seed.json      ← 초기 데이터(명단·설정·콘텐츠·순번)
  js/
    app.js  config.js  db.js  calc.js  ocr.js  auth.js  router.js  util.js
    views/  (dashboard, members, participation, diamond, rotation, schedule, settings, ui)
apps-script/Code.gs   ← 구글 시트 백엔드 + 네이버 OCR 프록시
scripts/              ← seed 생성·검증 도구
```

## 🔒 보안 메모
- 비밀번호 게이트는 화면 진입을 막는 1차 방어이며, 실제 쓰기 보호는 Apps Script가 토큰(비밀번호)을 검증합니다.
- 더 강한 보안이 필요하면 구글 OAuth 방식으로 확장 가능합니다.
