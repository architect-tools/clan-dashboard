# DB 스냅샷 (자동 백업/이력)

`.github/workflows/db-snapshot.yml` 이 **매시간** 백엔드(_state)를 `getAll&merge=1` 로 떠서,
직전 스냅샷과 **변동이 있을 때만** 아래 파일을 커밋합니다. 커밋 자체가 곧 DB 변경 diff.

- `state.json` — 전체 상태(키 정렬·정규화). 변경 이력: `git log -p db-snapshots/state.json`
- `summary.json` — 멤버수·참여일수·분배건수 등 요약

수동 실행: GitHub → Actions → "DB hourly snapshot" → Run workflow.
