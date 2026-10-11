---
name: research-pipeline-status
description: 증권사 리서치(기업분석) 본문 발췌·목표주가·투자의견 파이프라인 진행 현황 — 2026-09-13 세션 종료 시점
metadata: 
  node_type: memory
  type: project
  originSessionId: 1165c10e-41fc-4d81-962f-747fd6db43dd
  modified: 2026-09-13T00:52:25.866Z
---

2026-09-13 하루 세션에서 `5` 프로젝트(글로벌 종목 리서치 대시보드)의 증권사
리서치 기능(유안타·NH·미래에셋·KB·한경컨센서스·교보·신한·하나·한화·
한국투자증권, 총 10개 국내 소스)에 본문 발췌·목표주가·투자의견 추출 로직을
새로 붙이고 다수 버그를 수정·배포·백필까지 완료했다.

**Why:** 종목분석 화면에 리서치 카드를 표시할 때 제목만 있고 본문 요약·
목표주가·투자의견이 비어있는 문제를 오너가 지적하며 시작. 이후 여러 라운드에
걸쳐 "메타데이터를 본문 확인 없이 그대로 믿으면 안 된다"는 원칙을 발견해
전체 소스에 소급 적용했다([[feedback-verify-before-display]] 참고).

**현재 상태(완료)**:
- 10개 국내 소스 전부 90일치 백필 완료, 목표주가/투자의견은 "본문(PDF·상세
  페이지·리스트 요약)에 실제 언급이 확인된 경우에만" 표시하도록 통일.
- DB 보관 기간 90일로 통일(`src/lib/db/shinhan-research.ts` MAX_AGE_MS).
- 유안타증권은 myasset.com 자체 스크래핑이 불안정해 한경컨센서스 경유로
  전환(`collect-yuanta-research.mjs`는 워크플로 비활성화, 참고용 보존).
- 유니버스 통합표 "의견" 컬럼을 "투자의견"으로, 표시를 한글로 통일
  (`recommendationKo`를 `stock-analysis.tsx`에서 export해 재사용).
- Yahoo `financialData.recommendationKey`가 문자열 `"none"`으로 오는
  종목(예: 넷플릭스)에 대해 `recommendationTrend` 모듈로 직접 계산하는
  폴백 추가(`src/lib/markets/quote/yahoo.ts`).

**미해결(다음 세션에서 이어갈 것)**:
1. **유니버스 통합표 새로고침 버튼이 클릭해도 반영 안 됨** — 동시성을
   8→20으로 올려봤지만 오너가 "반응이 마찬가지"라고 확인. 타임아웃 가설은
   틀렸거나 부분적으로만 맞을 수 있음. `/api/universe/overview?refresh=1`
   라우트(`src/app/api/universe/overview/route.ts`, `maxDuration=60`)와
   `refreshUniverseOverview`(`src/lib/universe/overview.ts`)를 다시 살펴볼
   것 — 인증(401) 때문에 curl로 직접 재현이 안 돼 브라우저 네트워크 탭
   확인이 필요할 수 있음.
2. **GlobalMonitor(미국 종목 리서치)에 아직 검증 로직 미적용** — 오너가
   "한국 끝나면 미국도 동일하게" 명시적으로 요청. `collect-globalmonitor-
   research.mjs`는 현재 `opinion: ""` 고정, targetPrice 필드 자체가 없음.
   API 응답의 `rptopninvest` 필드는 실측 결과 항상 비어있었음(30건 샘플) —
   PDF 본문에서 뽑아야 할 가능성이 높음. 한국 브로커들이 미국 종목을 다루는
   구조라 같은 "목표주가/투자의견" 한글 정규식이 그대로 통할 가능성이 큼
   (미검증).
