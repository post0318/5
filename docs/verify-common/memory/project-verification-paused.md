---
name: project-verification-paused
description: "재무제표 작업은 매출 닫은 뒤 일시 중지(2026-09-25) — 오너가 리서치 먼저 마무리 후 재개, 재개 시 docs/handoff-verification.md 부터"
metadata:
  node_type: memory
  type: project
  originSessionId: 0bf0a7e0-1695-4c81-80a5-b89200950463
  modified: 2026-09-25T12:19:35.879Z
---

오너 지시 2026-09-25: "매출을 끝내면 재무제표는 브랜치에 커밋/푸시까지 해놓고 멈추고 있어라. 리서치부터 마무리하고 다시 시작하겠다."

2026-09-25 저녁 오너 "매출 마무리해" → 매출 닫음(47종목 실패 0, Fable 최종 감사 APPROVE, 커밋 767fc51). 재개 시 XOM LTM 잔차 591백만 처리 결정부터.

**Why:** 오너가 리서치 작업을 먼저 끝내려 함. 같은 작업 폴더를 쓰므로 재무 작업이 섞이지 않게 멈춤.
**How to apply:** 재개 지시가 있을 때까지 재무제표(fin·verify) 작업·정기 커밋 크론을 하지 않는다. 재개 시 wip/verification 브랜치에서 docs/handoff-verification.md·docs/metrics/*.md 를 읽고 다음 지표(매출원가·매출총이익)부터. 관련: [[project-financial-architecture]], [[feedback-close-metric-by-metric]]

**2026-09-27 갱신**: 재무 작업 재개됨 — 매출·매출원가(조건부)·영업이익·감가상각비 1차 큰 틀 완료. 다음 = 미결 일괄 정리 → Fable 최종 점검. 재개 시 docs/handoff-verification.md 맨 위 "현황 (2026-09-27 저녁)"부터 읽을 것.
