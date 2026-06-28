# DB 스냅샷 (자동 백업/이력)

`.github/workflows/db-snapshot.yml` 이 **매시간** 백엔드(_state)를 `getAll&merge=1` 로 떠서,
직전 스냅샷과 **변동이 있을 때만** 커밋합니다.

> ⚠️ 스냅샷은 **`db-history` 브랜치**에 쌓입니다 (main 이 아님 → GitHub Pages 재빌드 안 함).

- `db-snapshots/state.json` — 전체 상태(키 정렬·정규화)
- `db-snapshots/summary.json` — 멤버수·참여일수·분배건수 등 요약

변경 이력 보기:
```
git fetch origin db-history
git log -p origin/db-history -- db-snapshots/state.json
```
또는 GitHub 에서 브랜치를 `db-history` 로 바꿔 파일 History 확인.

수동 실행: GitHub → Actions → "DB hourly snapshot" → Run workflow.
