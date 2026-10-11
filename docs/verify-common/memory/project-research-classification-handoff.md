---
name: project-research-classification-handoff
description: 증권사 리서치 분류·수집 작업(워크트리 research) 인수인계 — 브랜치·커밋·검증 절차·대조표 재생성 순서·미결 항목
metadata:
  node_type: memory
  type: project
  originSessionId: b83bbc70-e91e-4706-8781-6eced38ac8d4
  modified: 2026-09-27T07:57:31.279Z
---

워크트리 `C:\Users\post0\5\.claude\worktrees\research`, 브랜치 `feat/research-samsung-common-exclude`, 전력·에너지 섹터 기준(오너 지시 2026-09-27, `research-sector.ts`): 발전 사업자·전력 판매/망 운영(한국전력·비스트라)·**신재생/수소 발전사업자**=유틸리티. 설비 제조(두산에너빌리티·지멘스·LS ELECTRIC·HD현대일렉트릭·**GE 버노바·블룸에너지**, 기자재·변압기·전선·터빈·풍력 터빈·수소 연료전지/전해조)=산업재. 태양광 셀·모듈·폴리실리콘=소재. 수소 자동차=자동차. 해양플랜트=조선/방산. 정유·석유화학·화학·유전서비스=**에너지/화학**(소재는 철강·비철·소재만). 회사 규칙이 SECTOR_RULES 맨 앞(UTILITY_COMPANY_RE/EQUIPMENT_COMPANY_RE). 규칙 검증 때 `tsc | head` 의 종료 코드는 head 의 것이라 오류를 가림 — PIPESTATUS 로 확인.
묶음 라벨(오너 2026-09-27): 서로 다른 업종 3개 이상 나열("정유화학/철강금속/음식료")은 앱에서 기타. 2개 묶음("2차전지/정유/화학")은 수집기가 PDF 본문 어휘 빈도(sector-label.mjs pickCompositeLabel, 1등 3회↑·2등의 1.5배↑)로 한 업종으로 좁힘 — 삼성 수집기에 연결, 애매하면 그대로. 라벨이 국가명으로 시작하면 그 시장(marketFromLabel, 하나 산업분석 적용; 다른 수집기엔 아직 없음). 원전 라벨(유틸리티)이라도 요약에 원전+기자재·주기기·EPC 면 산업재. 제목이 CPI·PPI·FOMC 등 거시 지표로 시작하면 업종 라벨이어도 이슈분석. Tech 라벨의 메모리·HBM 글은 반도체. 미결: 하나 "일본과 한국의 공작기계 수주 호조"(라벨 자동차, 내용 기계)·"중국 전기차, 지금은 배로…"(라벨 자동차, 제목 중국) 처리 방침 오너 답 대기.
마지막 커밋 `b414a09`. 대조표 아티팩트 https://claude.ai/artifact/7KYeMtKvP2nF4No8MREzjD (v60, 2026-09-27).

**2026-09-27 저녁 중단 시점(오너 지시 "여기서 잠시 멈춰라") — 작업트리 아직 미커밋**:
`git status --short` 에 10개 파일 M(`scripts/collect-{ibk,kb,meritz,nh}-research.mjs`·
`scripts/golden/research-classification.golden.json`·`scripts/lib/overseas-market.mjs`·
`scripts/verify-classification.mts`·`src/app/api/cron/total-research/route.ts`·
`src/lib/db/shinhan-research.ts`·`src/lib/research-sector.ts`, `scripts/.omc/` 는 커밋 금지).
tsc/eslint(변경 파일만)는 통과 확인. **골든 검증은 아직 못 돌림** — 이전 세션이 쓰던
so-stub.cjs 가 스크래치패드에서 사라짐(`ls` 실패), 재생성 필요(server-only 를 no-op
모듈로 스텁하는 짧은 cjs, 과거엔 있었음). 골든에 K16 추가(95건). **대조표는 아직
v60 그대로(재게시 안 함)** — 오너가 "그런데 왜 대조표에는 기존대로지?"로 확인, 이유는
아직 rebuild.mts.txt → trim.mjs → swap-data.mjs → publish 사이클을 한 번도 안 돌렸기
때문(코드만 고친 상태).

**이번 회차에 반영한 것(재검증·재게시 전)**:
- `research-sector.ts`/`overseas-market.mjs` 에 `marketFromTitleLead` 신설 — 라벨이
  업종명뿐이라 `marketFromIndustryLabel` 이 못 잡는데 **제목이 "N월 중국 …"으로 시작**
  하면 ch(오너 지적 — "8월 중국 자동차 판매: 가격 인하 경쟁 확대 조짐 중국산업이다").
  "N월 " 접두어만 벗겨내고 중국만 인정(미국·일본은 오탐 위험 커서 보류, 기존 방침과 동일).
  `total-research/route.ts`·`verify-classification.mts`·`rebuild.mts.txt`(스크래치패드)
  세 곳 모두 `marketFromIndustryLabel(...) ?? marketFromTitleLead(...) ?? market` 순서로
  연결(서버 안전망이라 NH 등 수집기 코드는 안 건드림). twin-check(TS↔mjs) 도 추가.
- `collect-nh-research.mjs` STRATEGY_BOARDS(02/04/05/06) 루프에 pdfUrl(첨부파일) 없는
  항목 skip 추가(오너 지적 — "테마/이슈 10시 Check 9/7 · 양지윤"이 pdfUrl null인데
  수집돼 있었음, "링크가 null 안열리면 수집하지마"). 01 게시판(기업/산업분석)엔 이미
  같은 규칙이 있었음 — 04/05/06 만 뚫려 있었다.
- `collect-meritz-research.mjs`: 제목에 티커가 없는 해외 종목 기업분석 글(예: CATL
  "2Q26 Review", 라벨만 "CATL")을 PDF 첫머리 "이름 (코드 거래소)" 로 승격하는 로직
  추가(`parseOverseasPdfHeader`, overseas-market.mjs 신설 export) — 오너 지적("pdf가면
  티커있는데?"). 사우디 아람코(거래소 "AB")는 시장을 몰라 산업분석에 유지, 로그로만
  남김(⚠ 거래소 미상) — 지어내지 않음.
- IBK "중동 리스크 확대로 인한 FOMC 부담 증대"(변준호) 는 오너가 **투자전략(주식) 유지**
  로 확정(이슈분석 이동 제안 거절) — 코드 변경 없음, 게시판(전략/시황) 우선 원칙 유지.
- "AI Deep 리서치(9월 넷째주)"(NH, stockName "NH/김규진") 는 원인 조사 중 중단 —
  `r.rsh_ppr_ser_cd_nm` 필드가 리터럴로 "NH/김규진" 을 준 것으로 보이나(브라켓 제목이
  아니라 `stockName = bm ? ... : r.rsh_ppr_ser_cd_nm || board.label` 폴백 경로) 왜
  API가 이런 값을 주는지, 이게 정상 시리즈명인지는 미확인. 오너에게 아직 답 못함.
- IBK "게임이론을 통해 살펴본 AI 경쟁"·"9월 미국 증시, 경계의 시간"·"중간선거 앞둔
  트럼프, 유가 상승…" 3건은 오너 확인상 현재 분류(투자전략(주식)·투자전략(주식)·
  이슈분석(경제)) 그대로 맞음.
분류 판단 순서(오너 지시 2026-09-27): **게시판명 → 라벨명 → 내용**. 게시판명은 DB 에 저장 안 돼(수집기가 고정 라벨로 번역) 서버는 라벨부터 본다. 구현: 라벨이 짧은 업종명이면 산업분석 확정(내용 신호로 채권·환율·전략 승격 금지), "…산업분석"처럼 게시판명이 라벨이면 산업분석, 섹터는 stockName → 제목 앞 `[라벨]`·`업종:` → 제목 → 한글 요약 순. 표준 섹터는 16개(반도체·자동차·이차전지 분리, 게임은 커뮤니케이션서비스, 구 중공업=조선/방산, 운송 분리). 규칙을 바꾸면 이전/이후 그룹 비교로 이동 건수를 확인할 것(diff 스크립트 방식). 게시판 저장(B안)은 용량 보고 후 결정 대기.
대조표 "사이트 게시판 목록": 에이전트 5개가 수집기 코드·CLAUDE.md 에서 뽑은 boards-catalog.json(scratchpad/main)을 rebuild 가 덮어씀. 미수집·수집 제외 행은 흐리게. 사이트 전체 메뉴 전수 확인은 삼성·NH·KB·iM·한화·골드만삭스만 true, 나머지는 "전수 확인 전" 표기.
투자전략 위치(오너 지시 2026-09-27 "각 국가별 산업분석으로 다시 변경, 국가별로 나눠라"): 내부 토픽 `시황분석:투자전략` 유지, 표시는 각 시장 산업분석 탭의 "투자전략" 세그먼트(`getIndustryResearch(market,…,"투자전략")`). 거시경제 시황분석 탭은 Daily·Monthly 만. 대조표 그룹명 `{국가} 산업분석(투자전략)`. 모바일 대조표: swap-data.mjs 가 720px 이하 카드형 CSS 를 주입(헤드리스 크롬은 창 폭 최소 500px 이라 iframe width=390 으로 확인).

**Why:** 오너가 대조표에서 항목을 짚으면 공통 규칙 우선으로 고치고, 정답표(`scripts/golden/research-classification.golden.json`, 79건)에 추가한 뒤 재수집·재게시·커밋한다.

**How to apply:**
- 검증: `NODE_OPTIONS="--require <so-stub.cjs>" npx tsx scripts/verify-classification.mts --capture=<final3 디렉터리>` (server-only 스텁 필요). 수집은 캡처 서버(포트 8800)로 `SHINHAN_RESEARCH_IMPORT_URL=... node scripts/collect-<x>-research.mjs --days=N`.
- 대조표 재생성: rebuild.mts.txt → trim.mjs → research-mapping.html 의 `const DATA =` 치환 → Artifact 재게시(스크래치패드 main/ 폴더, 세션 종료 시 사라질 수 있음).
- 셸 heredoc 정규식 백슬래시가 깨지므로 정규식 수정은 Edit 도구나 .cjs 스크립트 파일로 한다(`\b`가 백스페이스로 들어가는 사고 있었음).
- 공통 제외는 `src/lib/research-exclude.ts` ↔ `scripts/lib/exclude-filters.mjs` 쌍둥이, 업종 라벨 정규화는 `research-sector.ts` ↔ `sector-label.mjs` 쌍둥이(검증기가 일치 검사).
- 오너 결정(2026-09-27): 신한 비상장분석은 수집 시점 게시판이 곧 분류 — 상장사 매칭 휴리스틱 제거, 게시판 글은 전부 비상장(상장 후엔 종목 게시판으로 들어옴). 과거 백필분 혼입은 일회성 한계로 수용.
- 신한 해외 "글로벌 이슈;" 시리즈는 f2 에 대표 종목이 붙어도 us 산업분석(정답표 G35~37). "글로벌 전략; Global Portfolio"는 기존대로 수집 제외.
- 대조표(rebuild.mts.txt) 그룹 규칙: 비상장은 `{m} 비상장` 한 폴더(회사별 분리 금지), 산업분석은 앱과 같은 `classifySector`(표준 섹터+기타)로 `{m} 산업분석 — {섹터}`. 완료 표시는 소스·날짜·제목 해시라 그룹이 바뀌어도 유지됨. 재게시는 라이브 read → DATA 줄만 교체(swap-data.mjs) → publish. 캡처 서버는 청크를 Buffer.concat 으로 합쳐야 함(문자열 += 하면 멀티바이트가 깨져 U+FFFD → 게시 거부).
- 섹터 기타 정리(fc56245): `research-sector.ts` 규칙 보강으로 산업분석 기타 75→30. 내 판단으로 넣은 배정이라 정답표엔 안 넣음(오너 확인 대기): 원전→유틸리티, 신재생·태양광·풍력→에너지, 시멘트→건설, 우주는 라벨이 "우주"·우주항공·우주산업일 때만 중공업. 신한 경제분석 라벨(`경제분석 · 경제분석`)은 게시판 기준 이슈분석(환율 글만 환율분석). 규칙 바꿀 땐 기존 항목이 다른 섹터로 뒤바뀌지 않는지 이전/이후 비교로 회귀 검사할 것. 검증기는 캡처 폴더 안 모든 파일을 읽으니 백업 파일을 그 폴더에 두지 말 것.
- 미국·중국 비상장(5786339, 오너 지시 "미국과 중국도 비상장을 추가한다"): source `…비상장리서치` 를 시장과 무관하게 재사용(us/ch). 신한 해외 산업글 제목 IPO→비상장(중국이면 ch), 키움 해외 산업글 IPO·비상장 태그, 삼성 라벨 비상장 태그, 한화 `[IPO 101]`. 해외 비상장 판정은 `isUnlistedCompanyTag`(exclude-filters.mjs)만 — 단순 "비상장" 포함은 "비상장주식 평가이익" 같은 상장사 글을 끌어옴. 조회 API `kind=insight|unlisted`, 화면 `/us/unlisted`(ch 는 시장 화면 없어 데이터만). 한화 해외주식 전략 규칙은 제목에 시장 전체 신호(유동성·FOMC·증시…)일 때만. 미검증: 한화 `[IPO 101]`·삼성 미국 비상장 경로는 최근 90일 캡처에 해당 글이 없어 실데이터로 못 봄.
- 미결(추가): `FX_RE`(shinhan-research.ts ↔ exclude-filters.mjs 쌍둥이)가 "원/달러"·"외환시장"을 환율로 못 잡음 — 신한 "외환시장; 원/달러 속락 이후 방향성"이 이슈분석으로 감. 공통 규칙이라 오너 확인 후 확장.
- 미결: 동일 제목 최신만은 서버 적재에서 처리(실 DB 미검증), 주간 리포트 신한 일정 참조는 Gemini 전체 생성 미검증, 한경 "보우만의 연설"·LS "Clarity Act" 등 이전 미결.
