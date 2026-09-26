# 매출원가·매출총이익 지표 (미국, 2차 지표) — 2026-09-26

> 변경 이력: 2026-09-26 최초(오너 결정 반영) · 같은 날 영업이익·영업비용 1단계 추가(§8)

`architecture.md` §7 롤아웃 2단계. 0~3층 계약은 그 문서를, 차이 분류(① 일치 ② 정의 차이 ③ 오류)·외부 단독 이탈·SEC 반올림 잔차
불인정 원칙은 `revenue.md` §0 을 그대로 따른다. 현황 조사: 세션 임시 폴더 `scratchpad/metric-cogs/survey.md`(유형 분류·외부 3곳
정의·분해식), 유형 D 구성 조사: `scratchpad/cogs-dtype/report.md`·`rules.json`.

---

## 1. 정의 (오너 결정 2026-09-26)

**매출원가 줄은 손익계산서 본표 계산 구조로 찾는다** — 태그 우선순위·개념 이름 역할표로 고르지 않는다(2층 `assemble/is.ts`
`identifyCogs`, 역할 `cogs`·`cogs.part`).

1. 본표에 매출총이익 소계가 있고 계산 구조(`_cal`)에 그 식이 있으면 **매출총이익 식에서 빼는 항**이 매출원가다.
   - 빼는 항이 한 줄이면 그 줄. 여러 줄이면 그 항들을 정확히 합하는 본표 소계 줄(AMD 2023·2024 10-K "매출원가" 소계), 없으면 각
     항의 합(`cogs.part`).
   - 식의 더하는 항에 매출 줄이 없으면(TSM 2018 이전 — 매출총이익 = 조정 전 매출총이익 ± 관계기업 미실현이익) 더하는 소계의 식으로
     내려가 매출이 있는 식의 빼는 항을 쓴다.
2. 매출총이익 식이 없으면 **원가 개념이면서 그 열 원천 공시 자체 라벨이 원가**(cost of [net] revenue·sales·goods·products·
   equipment)인 본표 줄. 다른 후보 식 안의 항은 빼고 하나만 남을 때만. 라벨은 반드시 그 공시의 `_lab` 에서 읽는다(최신 공시 라벨이나
   companyfacts 표준 라벨로 판정하지 않음 — MCD 10-Q 의 `CostOfGoodsAndServicesSold` 는 "Franchised restaurants-occupancy expenses").
3. 파생 열(Q4 = 사업연도 − 9개월·누적 차·LTM)의 구성 공시가 구조 기준 공시와 다른 개념으로 원가 줄을 달았으면(LRCX: 10-K 는 구조조정
   포함 소계, 10-Q 는 회사 고유 "Cost of goods sold" 가 매출총이익 식의 원가 항) 그 구성 공시 자체 본표의 매출총이익 식 원가 항(한 줄,
   더하는 항이 매출일 때만)을 읽는다 — 각 공시의 본표 매출원가끼리 빼는 것이라 1번과 같은 기준. 읽은 사실은 파생값 입력(`f:`)에 남는다.

| 유형 | 본표 구조 | 매출원가 | 매출총이익 | 종목(유니버스 47) |
|---|---|---|---|---|
| A | 매출총이익 소계 + 원가 한 줄 | 그 줄 | 본표 소계 | AAPL·AMAT·ASML·BE·CL·DELL·GEV·GLW·IBM·INTC·ISRG·KO·MDLZ·MRVL·MSFT·MU·NVDA·PEP·PLTR·SNDK·SPOT·TER·TSLA·TSM·WDC |
| B | 매출총이익 소계 + 원가 소계(여러 줄) | **소계 그대로**(인수 무형상각·구조조정 포함) | 본표 소계 | AMD·AVGO·LRCX |
| C | 소계 없음 + 원가 한 줄 | 그 줄(라벨 판정) | **매출 − 매출원가 합성**, 표기 "본표 소계 없음 · 매출 − 매출원가" | AMZN·GOOG·META·NFLX·WMT·VRT·UBER·CAT |
| D | 원가 줄 없음 | 회사별 구성 규칙(`metrics/cogs-rules.ts`) — **대기 중엔 빈칸 + "구성 규칙 대기"** | 규칙이 정해지면 매출 − 구성 매출원가 합성(C 와 같은 표기 + "구성: 라벨"), 대기 중엔 빈칸 | XOM·MCD·V·ORCL·MAR·HLT·SBUX·DAL·CEG·VST·AXP |

- **UBER**: 원가 줄이 "Cost of revenue, exclusive of depreciation and amortization" — 그 줄을 매출원가로(Yahoo 정확 일치), 주석
  "본표 원가 줄 — 제외 항목 있음(라벨)". TER("exclusive of acquired intangible assets amortization")도 같은 주석.
- **CAT**(금융 자회사): 매출원가 = 본표 "Cost of goods sold", 매출총이익 = 합성(C). 매출에 금융상품 수익이 있고 그 원가(금융상품
  이자비용)는 원가 밖이라 외부 3곳과 모두 다르다 — 매출 쪽 "금융 자회사 매출 정의 보류"(revenue.md §9)와 함께 2단계에서 재검토.
- **본표 매출총이익 ≠ 매출 − 매출원가**(IBM 연간·분기 ±1백만 반올림, GEV 분기 ±1백만, TSM FY2016~2018 관계기업 미실현이익 조정 줄):
  **본표 값을 두고** 주석 "회사 공시 자체 — 본표 매출총이익 ≠ 매출 − 매출원가(차 …달러)". 실패가 아니다(앱 = 본표). 비교는 매출 지표
  값 기준, USD 공시 0.5달러·외화 상대 1e-9.
- **AXP**(은행·카드): 유형 D 대기. 손익계산서 화면의 "충당금전이익"(순수익 − 총이자외비용)은 매출총이익이 아니며 기존 표시를 유지한다.

## 2. 기간·통화

매출과 같다(`revenue.md` §2) — 줄 값은 1층 `value()` 가 정한다(최신 판본, Q4 = 사업연도 − 9개월, LTM = 사업연도 + 당기 누적 − 전년
동기, 외화 = 기간 평균 환율, 20-F LTM = Yahoo 분기 × 분기 평균 환율: `read/ltm-yahoo.ts` 의 `costOfRevenue`·`grossProfit`). 같은
공시·기간·차원에 본문 문장용 반올림 사실이 정밀값과 함께 있으면 정밀한 값(`read/vintage.ts mostPrecise` — decimals 큰 쪽, 없으면
다른 값의 반올림인 값을 버림. DAL 감가상각비 2,443 vs "2.4 billion" 2,400 사례). 이 변경으로 유니버스 47종목 값 변화 0.

## 3. 소비처 (전부 fin 값만 — 재계산 금지)

| 소비처 | 파일 | 사용 |
|---|---|---|
| 손익계산서(연간·분기·Q4·LTM) | `markets/us/edgar-income.ts` | "(−) 매출원가"·"매출총이익" 행. 합성이면 행 이름 "매출총이익 (본표 소계 없음 · 매출 − 매출원가…)", 그 밖의 사유(구성 규칙 대기·회사 공시 자체·제외 항목 있는 원가 줄·빈칸 사유)는 "※ 매출원가·매출총이익: …" 각주(표시 열만). 유형 D 대기는 기존처럼 "(−) 영업비용" 축약 + 각주 |
| 재무분석 | `markets/us/edgar-analysis.ts` | 매출총이익률, DIO·DPO·CCC 분모 |
| 기본 재무제표(getFinancials)·개요 멀티플 | `markets/us/edgar.ts` `FIN_IS_ROWS`, `markets/multiples.ts` | 행 id `fin:cogs`·`fin:grossProfit`(매출 `fin:revenue` 와 같은 방식) |
| 20-F LTM | fin `read/ltm-yahoo.ts` | 옛 `edgar-yahoo-quarters.ts` FLOWS 의 매출원가·매출총이익 항목은 삭제 |

전달 경로: `fin-revenue.ts` 의 열(`RevCol`)에 `cogs`·`gp`·`cogsNote`·`gpNote`(`metricAt`·`metricNoteAt`). 삭제한 사본: `edgar-series.ts`
`COGS_CONCEPTS`·`cogsConcepts`, `edgar-income.ts`·`edgar-analysis.ts` 의 태그 병합 계산, `edgar.ts` CONCEPTS 의 CostOfRevenue·
GrossProfit, `edgar-highlights.ts` 의 죽은 grossProfit 계열. eslint: `COGS_TAG`(CostOfRevenue·CostOfGoodsAndServicesSold·
CostOfGoodsSold·CostOfGoodsAndServiceExcludingDepreciationDepletionAndAmortization·CostOfSales·GrossProfit) 문자열을 src/lib/fin
밖에서 금지(매출 태그 금지와 같은 파일·같은 예외).

## 4. 저장 (엔진판 6)

- `fin_sym.m.cogs`·`m.gp`(열 순서 = `c`), 파생값 입력 `d.cogs`·`d.gp`, 같은 열 칸만 가리키는 입력은 틀로 묶어 `d.tp`(§7), 칸 사유·주석
  `n.cogs`·`n.gp`(`[문구, 열키[]][]` — 빈칸이면 사유, 값이 있으면 정의 메모). `fin_stmt` 는 형식 변화 없음(원가·매출총이익 줄은 이미
  줄로 저장되어 있었다). `fin_chg` 는 `m.cogs`·`m.gp` 칸 변경도 기록. 호환용 `x`(예외 코드)는 매출에만 둔다 — 새 지표는 `d` 로 충분.
- 합성 매출총이익의 입력 = `c:열|매출 줄`(매출이 여러 줄 합이면 매출 입력) − `c:열|원가 줄`(합이면 그 입력). 자기 검사(`derived.ts`)는
  매출과 같은 규칙으로 다섯 지표 모두.

## 5. 확인된 결함 (③ — 이번 전환으로 해소)

| ID | 내용 | 결과 |
|---|---|---|
| C1 | CAT FY2022~25 매출원가 = 주석 조각(CostOfGoodsAndServicesSold 413/160/33/49백만), 합성 매출총이익 ≈ 매출. LTM 만 본표 태그라 한 행 안에서 기준 혼합 | 본표 41,350/42,767/40,199/44,752, 매출총이익 18,077/24,293/24,610/22,837(합성) |
| C2 | MCD 10-Q 가 가맹점 임차비용을 CostOfGoodsAndServicesSold 로 태깅 → 분기 매출원가 ≈ 680백만, 매출총이익 = 매출 − 그것 | 유형 D 대기 — 분기도 빈칸 + 사유(라벨 판정도 거부: 원가 라벨 아님) |
| C3 | UBER 매출원가 빈칸(태그 목록에 없음) | 본표 줄 31,338(FY2025) + 제외 항목 주석 |
| C4 | 매출원가·매출총이익 계산 경로 6곳(태그 목록 제각각) | fin 한 곳 + eslint |
| C5 | LRCX Q4 매출원가 빈칸(10-K 소계 개념이 10-Q 에 없음) | §1-3 구성 공시 본표 원가 항 |

기존 화면 값(연간 5개 사업연도, survey app-legacy 재현) 대비 바뀐 칸: CAT 4개 연도·UBER 5개 연도만(나머지 208칸 동일).

## 6. 검증

- 최신 10-K 본표(face.json) 대조: 47종목 불일치 0 — 값 대조 36종목(A·B·C, 외화는 원통화 × 매출과 같은 환율), 유형 D 11종목은 앱 빈칸 +
  "구성 규칙 대기"(본표에도 원가 줄 없음).
- 비저장 조립 47종목: 매출 변화 0칸, 파생값 자기 검사 불일치 0, 매출원가·매출총이익 조립 항등식 불성립으로 비운 칸 0.
- 검증기(`scripts/verify-financials.mjs --metric=cogs`, 다른 작업자)는 앱을 import 하지 않고 본표를 따로 판독한다(S3). 앱 쪽 표기 계약:
  원가 행 이름 `^(−) 매출원가`, 매출총이익 행 `^매출총이익`(합성이면 뒤에 "(본표 소계 없음 · …)"), 유형 D 대기 사유 문구 "구성 규칙 대기".

## 7. 저장 용량 (오너 요구 — 무료 DB 512MB)

| 시점 | fin_sym(47종목) | fin_stmt | 비고 |
|---|---|---|---|
| 착수 전(엔진판 5, 실측) | 350,401B | 728,404B | |
| 사전 추정(매출원가·매출총이익) | +약 210KB | 변화 없음 | 종목당 m 1KB + d 2.6KB + n 0.3KB ≈ 4.5KB |
| 실측 — 매출원가·매출총이익만 | 540,206B(+190KB) | 728,420B(+16B, LRCX Q4 칸) | 합성 매출총이익 입력이 전 열(WMT d 1.1KB → 9.0KB) |
| 사전 추정(영업이익·영업비용 추가) | +약 190KB | 변화 없음 | |
| 실측 — 네 지표, 틀 압축 전 | 869,384B | 728,420B | 영업비용 입력(전 열 2항) 114KB |
| **실측 — 네 지표, 틀 압축(`d.tp`) 후** | **694,311B(+344KB)** | **728,420B** | 같은 열 칸만 가리키는 입력은 틀 1개 + 열 목록 |

측정: `BSON.calculateObjectSize`(비저장 조립 결과를 `toSymDoc`·`toStmtDoc` 로 만든 문서, 운영 DB 쓰기 없음). `fin_chg`: 엔진판 6 첫 적재 때
새 지표 칸(47종목 × 약 31열 × 4지표, 옛 값 null → 새 값)이 한 번 기록된다 — 약 5,800건 × 110B ≈ 0.6MB(TTL 180일). 합계로 보면 fin 전체
1.4MB 수준으로 M0 한도의 0.3% — `architecture.md` §3.3 예산 안.

## 8. 영업이익·영업비용 1단계 (오너 지시 2026-09-26 — "매출원가부터 영업이익까지 같이 본다")

본표에 공시된 기본 구성만 fin 지표로 세운다(`metrics/opinc.ts`). **소비처는 아직 전환하지 않는다** — 화면은 옛 계산(edgar-ev.ts
단일 기준 영업이익 시계열) 그대로. 전환은 매출원가·매출총이익 검증 통과 후 리드 지시.

- 영업이익 = 본표 영업이익 소계 줄(OperatingIncomeLoss·IFRS ProfitLossFromOperatingActivities) 값 그대로. 소계가 없는 열은 빈칸 +
  "정의 대기 — 본표 영업이익 소계 없음"(IBM 전 열, VRT FY2016~17·SNDK·WDC 일부 옛 열).
- 영업비용 = 매출총이익(fin) − 영업이익. 본표 영업이익 식이 "매출총이익 − 영업비용 합계 한 줄"이면 그 줄과 정확 대조 — 비저장 조립
  47종목에서 대조 470칸(연간·분기 목록 중복 LTM 포함), 불일치 0. 불일치면 값을 두고 주석 "본표 영업비용 합계 ≠ …"·경고.
- 2단계(빈칸 + "정의 대기"): 유형 D 11종목, CAT, 영업이익 소계 없는 종목(IBM 등 — 합성 규칙), 경계 항목(감가상각·기타 영업비용),
  일회성비용.
- 기존 화면(손익계산서 "영업이익" 행) 대비(비저장 조립 vs 현재 `buildUsIncome`): 같은 값 351칸, fin 빈칸 143칸, 다름 6칸 — KO·MDLZ
  LTM·2026Q2(현재 화면이 최신 2분기 10-Q 를 반영 못함), TSM FY2025·LTM(현재 화면 빈칸). 모두 fin 쪽이 본표.
- 영업이익 소비처(전환 대상 목록): 손익계산서(`edgar-income.ts` 영업이익 행·기타 영업비용·영업외손익 차감), 재무분석(`edgar-analysis.ts`
  영업이익률·EBITDA·NOPAT·ROIC·Altman Z·DFL), 하이라이트(`edgar-highlights.ts` S/E.opIncome — 연간·LTM·EBITDA·EV/EBITDA), 은행
  하이라이트(`edgar-highlights-bank.ts`, 은행식 — 대상 아님), TTM/개요 멀티플(`edgar.ts buildUsTtm` → `multiples.ts` EV/EBITDA·EV/EBIT,
  `universe/overview.ts`), 컨센서스(`consensus.ts` 실적 영업이익·EBITDA), 20-F LTM(`edgar-yahoo-quarters.ts` 영업이익 항목), 합성
  시계열 원천(`edgar-ev.ts` SYN_OP_INCOME·`edgar-is-structure.ts`·`edgar-revenue-dims.ts`·`edgar-oneoff.ts`), SKHY(`dart-adr.ts`).

## 9. 미결

1. **유형 D 구성 규칙 채우기**(리드 지시 후) — `cogs-rules.ts` 표 형식은 조사 규칙표(`rules.json` composition: 항마다 개념 후보 여럿·부호)와
   같다. 채우면 매출원가 = 구성 합, 매출총이익 = 매출 − 구성 합(합성 표기 + "구성: 라벨"). 메커니즘은 XOM(원유·제품 매입 + 생산·제조비)
   으로 메모리 안 주입 시험 완료 — FY2025 226,672(= 184,248 + 42,424), 자기 검사 통과.
2. **빈칸으로 남은 옛 열**(화면 표시 범위 밖): WDC 2024Q1~Q3(열 원천이 10-K 분기 요약표 — 매출총이익만 있고 원가 줄 없음), SNDK 2024Q1
   (열 원천 10-Q 에 그 기간 손익 본표 없음 — 매출 앵커가 주석에서 잡힘), VRT FY2016~17(SPAC 이전, 매출도 없음). 사유는 칸마다 저장.
3. **외부 정의 차이 목록**(survey §4): StockAnalysis = 원가 소계 − 인수 무형상각·구조조정·손상, 인포맥스 = 원가 + 감가상각·상각. ② 분해식
   정확 성립 31건, 미해결 13건(인포맥스 D&A 원천 불명 등) — F층 분류는 검증기 작업.
4. CAT 손익계산서 "기타 영업비용"은 옛 계산(OPEX 태그 CostsAndExpenses − 판관비 − 연구개발비 — 매출원가 포함 총비용)이라 크게 나온다 —
   판관비·영업비용 2단계에서 정리(이번 범위 밖, 값 변화 없음).
5. 골든셋 `GOLDEN_CHECKS` 에 매출원가·매출총이익 A층 검사 추가·Fable 독립 감사 — 검증기 작업 후.
