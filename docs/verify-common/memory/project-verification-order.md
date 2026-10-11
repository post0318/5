---
name: project-verification-order
description: 재무 검증·감사 시장 순서 미국 → 한국 → 일본 → 중국 추가, 한 시장씩 — 동시에 진행하지 않는다
metadata:
  node_type: memory
  type: project
  originSessionId: 0bf0a7e0-1695-4c81-80a5-b89200950463
  modified: 2026-10-02T21:53:57.649Z
---

재무 검증(verify-financials)과 독립 감사는 **미국을 마친 다음 한국으로 넘어간다.** 두 시장을 한꺼번에 다루지 않는다.

**Why:** 오너 지시 2026-09-24 밤 — "미국을 마치면 한국으로 넘어간다 동시에 하려니 더 헷갈린다."

**How to apply:** 감사 범위·수정 작업·보고를 미국 단위로 끊는다. 한국 쪽 코드(FnGuide·Yahoo KR 대조, 2026-09-24 추가분)는 미감사 상태로 두고, 미국 APPROVE 뒤 한국 감사·DART 원자료 A층 신설을 시작한다.

**브랜치(2026-10-03 오너 확인)**: 한국 재무 검증은 `kr/verification` 브랜치에서 한다. 한국 검증이 끝난 뒤 master 에 머지할 예정이라, 그 전에는 master 와 갈라져 있어도 임의로 합치지 않는다. 관련: [[feedback-exact-match-verification]]


**시장 로드맵(오너 지시 2026-10-05)**: "미국 끝내고 한국 끝내면 일본으로 넘어가고 일본 끝내면 중국 추가한다." 순서 = 미국 → 한국 → 일본(EDINET, `jp/edinet.ts` 골격) → 중국(새 시장 추가). 다음 시장 착수는 앞 시장 감사 APPROVE·master 병합 뒤.
