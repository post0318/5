---
name: feedback-hourly-wip-commit
description: 작업 중 커밋·푸시는 검증 통과 여부와 무관하게 1시간 단위로 (wip 브랜치)
metadata:
  node_type: memory
  type: feedback
  originSessionId: 0bf0a7e0-1695-4c81-80a5-b89200950463
  modified: 2026-09-24T21:12:11.589Z
---

작업 브랜치(wip/verification 등)에는 검증·감사 통과 여부와 상관없이 **1시간마다** 커밋하고 원격에 푸시한다. master 는 오너 지시 전까지 푸시 금지(운영 배포).

**Why:** 오너 지시 2026-09-25 — "커밋은 통과유무와 무관하게 1시간단위로 해. 그래야 진행된것까지 공유되니깐." 오너가 여러 PC 에서 이어서 작업하므로 진행분이 원격에 있어야 한다.

**How to apply:** 세션 시작 시 CronCreate 로 매시 정기 커밋 작업을 걸어 둔다(세션 한정·7일 만료). 커밋 메시지에 "검증 미완 가능"을 밝히고, .env·reports·.omc 등 비밀·산출물은 제외한다. 관련: [[feedback-batch-fix-then-verify]]
