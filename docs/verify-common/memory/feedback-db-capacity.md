---
name: feedback-db-capacity
description: DB 저장을 늘리는 모든 작업은 구현 전 예상 용량·구현 후 실측(scripts/db/size.mjs)을 보고, 쌓이는 데이터는 TTL 필수 — 무료 512MB
metadata:
  type: feedback
---

MongoDB `market_research` 는 무료 등급 512MB(2026-09-26 실측 약 23MB = 4.4%, 재무 fin_* 약 1MB, 큰 쪽은 리서치·뉴스 수집).

**Why:** 오너가 반복 지적 — "계속 말하지만 db 용량 반드시 고려해야한다"(2026-09-26). 파생값 구조·감사표 추가 때 용량 보고가 추정치 위주였다.

**How to apply:** 새 필드·컬렉션·이력 저장을 넣을 때 ① 구현 전 예상 용량(문서 수 × 크기) ② 구현 후 `node scripts/db/size.mjs` 실측을 함께 보고. 계속 쌓이는 데이터(이력·로그)는 TTL 또는 보관 기한 필수, 원문·전체 결과 대신 요약·참조 저장. 검증용·시험 데이터는 운영 DB 에 넣지 않는다(골든셋은 git 파일). 관련: [[project-financial-architecture]]
