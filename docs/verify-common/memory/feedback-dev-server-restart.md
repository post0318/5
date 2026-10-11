---
name: feedback-dev-server-restart
description: 이 PC 는 메모리가 빠듯 — 긴 검증은 개발 서버를 주기적으로 새로 띄우며 묶음으로 나눠 돌린다
metadata:
  node_type: memory
  type: feedback
  originSessionId: 0bf0a7e0-1695-4c81-80a5-b89200950463
  modified: 2026-09-24T23:08:18.509Z
---

C:\Users\post0\5 작업 PC 는 여유 메모리가 2~4GB 라 Next 개발 서버(Turbopack)가 1~2GB 까지 커지면 Claude Code 가 백그라운드 작업(개발 서버·전체 재검증)을 강제 종료한다(2026-09-25 두 번 발생). 개발 서버 본체 프로세스는 종료 후에도 남는 경우가 많다.

**Why:** 오너 지시 2026-09-25 — "메모리 부족하면 개발서버 한번씩 재실행하면서 해라."

**How to apply:** 전체 재검증(47종목 약 25분)은 10종목 안팎 묶음으로 나눠 전면 실행(명령 1회 10분 이내)하고, 묶음 사이에 남아 있는 next 프로세스(start-server.js·postcss pool 포함)를 종료한 뒤 `npm run dev` 로 새로 띄운다. 결과 JSON 은 묶음별로 나오니 합쳐서 판정. 관련: [[feedback-batch-fix-then-verify]]
