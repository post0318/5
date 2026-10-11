---
name: project-kr-audit2-resume
description: "한국 검증 감사 2차 수정 중단 지점(2026-10-05, 사용량 소진) — 12시 이후 재개 시 여기부터"
metadata:
  node_type: memory
  type: project
  originSessionId: 01d0db45-f81a-414b-9ed4-6a2233ab4a4a
  modified: 2026-10-05T04:41:05.291Z
---

2026-10-05 사용량 소진으로 한국 감사 2차 수정을 중단, 12시(자정) 이후 재개(오너 지시 "그동안은 쉬어라").

- 앱 수정: kr/verification `3338f95` 푸시(서버 미확인) — overview-metrics 경고·칸 비움, quote/xbrl/dart-adr 조용한 실패 → 경고, LTM 배당 창, 캐시 열쇠에 접수번호(정정 즉시 반영).
- 검증기 수정: `wip/kr-audit2` `a6053ef`(미완성, kr/verification 미병합) — LTM 열 누락 실패, 분기 A층, 게시 전 우선주 독립 확인, 사업보고서 시기 LTM, 금융 자회사 규칙, 원문 감가상각 판독기 docda.mjs(연결 전).
- 남은 일: ④ daLayer 연결(xbrl+영업비용확인 칸 XBRL 재현, 원문·TTM 독립 판독, 안 되면 공통모드) · ⑦ K5 LTM 공공데이터 대조 · ⑩ 단위 메시지 · verify-financials 연결(COMMON 상태·분기·LTM 열 존재·게시 전 재실행 집계) · CLAUDE.md · 서버 ~/5-plant 제거 · 심은 오류 재현(N23·N25·N26 등) · 30종목 전체 · 3차 독립 재감사.
- 2차 감사 결과: 1차 놓친 9/9, 새 22건 중 18건 검출, MAJOR 6건.
- 병합 시(master): populate-kr-da.mjs --prod, 오라클 /opt/macro/dart-cache. 10-07 07:00 실측 보고서로 KRX 게시 전 구간 확정. 텔레그램 2분 수신 장중 확인.

- 10-05 13:40 UTC 재확인: 오너가 "잠시만 여기까지 — 나갔다 다시 들어오겠다, 이어서 할 수 있게 준비"로 다시 멈춤. 작업자 중지, 미커밋 변경 없음. 로컬 C:\Users\post0\5 는 wip/kr-audit2(a6053ef) 체크아웃 상태, 원격 kr/verification = 3338f95. 검증 서버 verify-dev(:3000) 가동 중, 마지막 전체 실행 verify-kr7(0d5502b 기준, 실패 0).

**How to apply:** 재개 시 wip/kr-audit2 를 pull 해 남은 일부터, 수정 작업자 1명(Opus)에게 맡기고 끝나면 독립 재감사.
