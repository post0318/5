# 판관비·연구개발비 지표 (미국, 3차 지표) — 2026-09-28

> 변경 이력: 2026-09-28 최초(오너 결정 반영, 엔진판 12)

`architecture.md` 5층 구조(source → read → assemble → metrics)의 매출원가(`cogs.md`)와 같은 틀. 차이 분류(① 일치 ② 정의 차이 ③ 오류)·외부
단독 이탈·그림자 채우기 금지는 `revenue.md` §0 을 따른다. 현황 조사: 세션 임시 폴더 `scratchpad/sga-survey.md`(소비처·47종목 본표 구조·
옛 태그 방식 오류 추정). 검증기(`scripts/verify-financials.mjs`·`scripts/metrics/*`) 쪽 판관비 대조는 별도 작업.

---

## 1. 정의 (오너 결정 2026-09-28)

**판관비·연구개발비 줄은 손익계산서 본표 계산 구조로 찾는다**(2층 `assemble/is.ts identifySgaRnd`, 역할 `sga`·`sga.part`·`rnd`·`rnd.part`).

1. 뿌리 = 본표 영업이익 소계의 계산식(없으면 세전이익 식 — IBM·XOM). 뿌리에서 계산 구조를 내려가며 **판관비·연구개발비 성격 줄**을
   모은다(그 줄 아래로는 내려가지 않음). 매출·매출총이익 식(매출·원가 줄), 원가 줄(`cogs`·`cogs.part`), 유형 D 매출원가 구성 항 개념
   (`cogs-rules.ts`)은 들어가지 않는다 — 원가와 겹치지 않게.
2. 성격 판정: 표준 네임스페이스(us-gaap·ifrs-full)는 **개념 이름**, 회사 고유 개념은 **그 공시 자체 라벨**.
   - 판관비: SellingGeneralAndAdministrativeExpense·GeneralAndAdministrativeExpense·SellingAndMarketingExpense·SellingExpense·
     MarketingExpense·MarketingAndAdvertisingExpense·AdvertisingExpense·OtherSellingGeneralAndAdministrativeExpense, IFRS
     SalesAndMarketingExpense·DistributionCosts·AdministrativeExpense. 회사 고유 = 라벨이 판매·일반관리 계열로 시작.
   - 연구개발비: ResearchAndDevelopmentExpense(…ExcludingAcquiredInProcessCost·Software…), 회사 고유 = 라벨에 "research"(취득 IPR&D 제외).
3. **판관비 = 성격 줄 전부의 합**. 여러 줄이면 합 + 손익계산서에 하위 줄 표시, 본표에 그 줄들을 정확히 합하는 소계 줄이 있으면 그 소계.
4. 본표 이름이 표준 이름이 아닌 한 줄(HLT·MAR·SBUX "General and administrative", MCD "Other", AMZN "Technology and infrastructure",
   TER "Engineering and development" 등)은 값 그대로 + 주석 `본표 줄 이름: "…"` — 화면 행 이름에 `(본표: …)` 병기.
5. 계산 구조가 뿌리와 끊긴 본표(PLTR 2023 이전 10-Q — 영업비용 합계 식이 영업이익 식에 매달리지 않음): 표시 순서상 영업이익 줄 앞의
   성격 줄 중 뿌리에서 닿지 않은 줄도 모은다(부호 = 그 줄이 속한 식 꼭대기까지의 가중치 곱).
6. 회사별 예외(`metrics/sga-rules.ts`, 공시 accn·숫자 근거 필수 — S2):
   - AMZN: `amzn:FulfillmentExpense` = 판관비, `amzn:TechnologyAndInfrastructureExpense` = 연구개발비(오너 결정).
   - NFLX: FY2019 이전 `nflx:TechnologyandDevelopmentExpense`(라벨 없음) = 연구개발비(FY2020 부터 같은 이름 줄이 us-gaap R&D).
   - KO: `us-gaap:OtherCostAndExpenseOperating` = 판관비 — 같은 본표 줄 "Other operating charges" 를 10-K(2022~)는
     OtherSellingGeneralAndAdministrativeExpense, 10-Q·옛 10-K 는 이 개념으로 태깅(오너 결정 "KO SG&A + Other SG&A" 를 전 열에 같게).
   - DAL: 판관비 빈칸 + 사유 "성격별 비용 본표 — 판관비 소계·일반관리비 줄 없음(판매 수수료 줄만)"(오너 결정).
7. 빈칸 + 사유(조용한 빈칸 없음): 금융사(FIN_TYPES — AXP) "금융사 — 해당 없음", 성격 줄 없음 `본표에 줄 없음 — 본표 영업이익 식에
   … 성격 줄 없음`(CEG 판관비, R&D 없는 회사 전부), 구조 판독 실패, 줄 값 없음, 기준 혼합(§2), 조립 항등식 불성립(매출원가와 같은 규칙).

## 2. 기간·통화

줄 값은 1층 `value()` 가 정한다(최신 판본, Q4 = 사업연도 − 9개월, LTM = 사업연도 + 당기 누적 − 전년 동기, 외화 = 기간 평균 환율).

- **파생 열(Q4·누적 차·LTM)의 기준 혼합**: 구성 공시마다 그 공시 자체 본표로 같은 판정을 한다. 줄 구성(개념 목록)이 같으면 줄 값 그대로.
  다르면 **합 동일성**(cogs.md 유형 D 와 같은 기준): 두 구성이 함께 공시된 같은 기간의 합이 반올림 단위 안에서 같으면(개념 이름만 바뀜 —
  NFLX Marketing → Sales and marketing, KO 태그 교체) 구성 공시마다 그 공시 자체 줄의 합으로 파생값(주석 "구성 공시마다 줄 개념 다름 — 합
  동일(…)", 하위 줄은 비움). 합이 다르거나 비교할 기간이 없거나 구성 공시 한쪽에 줄이 없으면 빈칸 + "구성 공시 간 줄 구성 다름 — 기준 혼합".
- **20-F LTM**(TSM·ASML·SPOT): 줄마다 Yahoo 분기 × 분기 평균 환율(`read/ltm-yahoo.ts YAHOO_FIELD` — 판관비 합계·판매마케팅·일반관리·
  연구개발 필드), 연간 경계 확인(Yahoo 연간 = SEC FY). 매출원가 20-F LTM 과 같은 방식 — 옛 `edgar-yahoo-quarters.ts` FLOWS 의 판관비·
  연구개발비 항목은 삭제.

## 3. 소비처 (전부 fin 값만 — 태그 재선택 금지)

| 소비처 | 파일 | 사용 |
|---|---|---|
| 손익계산서(연간·분기·Q4·LTM) | `markets/us/edgar-income.ts` | "(−) 판매관리비"·"(−) 연구개발비" 행(표준 이름 아니면 `(본표: …)` 병기, 여러 줄이면 depth 2 하위 행 — 같은 이름 줄은 열이 겹치지 않으면 한 행), 빈칸 사유는 칸 주석 + `※ 판매관리비: …` 각주(`본표에 줄 없음` 제외) |
| "(−) 기타 영업비용" | 같은 파일 | fin 영업비용(매출총이익 − 영업이익) − 판관비 − 연구개발비. 사유가 `본표에 줄 없음` 인 칸만 0 으로 차감(그 비용 줄이 본표에 없음), 그 밖의 빈칸이면 빈칸 |
| 기본 재무제표(getFinancials) | `markets/us/edgar.ts FIN_IS_ROWS` | 행 id `fin:rnd`·`fin:sga`(옛 CONCEPTS 태그 행 삭제) |
| 20-F LTM | fin `read/ltm-yahoo.ts` | §2 |

- 전달 경로: `fin-revenue.ts` `RevCol.sga·rnd·sgaNote·rndNote`, `UsRevenue.sgaParts·rndParts`(`metricPartsAt`).
- 삭제: `edgar-income.ts` SGA·RND 태그 목록, `edgar.ts` CONCEPTS 의 R&D·SG&A 태그 행, `edgar-yahoo-quarters.ts` 판관비·연구개발비 FLOWS,
  `multiples.ts` "매출총이익 − 판관비 − 연구개발비" 영업이익 폴백(미국은 `computeUsMultiples` 로 가서 도달 불가, 한국·일본 재무제표에는 그
  미국 태그 행이 없어 죽은 코드였다).
- eslint `SGA_TAG`(SellingGeneralAndAdministrativeExpense·GeneralAndAdministrativeExpense·SellingAndMarketingExpense·SalesAndMarketingExpense·
  MarketingExpense·OtherSellingGeneralAndAdministrativeExpense·ResearchAndDevelopmentExpense·…ExcludingAcquiredInProcessCost) 문자열을
  src/lib/fin 밖에서 금지(매출·매출원가와 같은 파일·같은 예외). 정규식 리터럴(edgar-oneoff.ts 제외 판정, recon-lines.mjs)은 대상 아님.

## 4. 저장 (엔진판 12)

- `fin_sym.m.sga`·`m.rnd`, 파생값 입력 `d.sga`·`d.rnd`(여러 줄 합 = `c:열|줄` 입력 — 같은 열 칸만이면 `d.tp` 틀), 칸 사유·주석 `n.sga`·`n.rnd`,
  하위 줄 `sp.sga`·`sp.rnd` = `[줄 id, 라벨, 값[]]`(값 순서 = `c`, 지표가 여러 줄 합인 열만 — 합을 비운 열은 하위 줄도 null).
- `fin_stmt.r` = 역할(sga·sga.part·rnd·rnd.part) → `[줄 사전 번호, 열키[]]` — 저장본만으로 어느 줄이 판관비·연구개발비인지 재현.
- `fin_chg` 는 `m.sga`·`m.rnd` 칸 변경도 기록.

| 시점 | fin_sym | fin_stmt | fin_chg |
|---|---|---|---|
| 착수 전(엔진판 11, 실측) | 950,216B | 728,508B | 715,330B(6,291건) |
| 사전 추정 | +약 70KB | +약 90KB | +약 0.3MB |
| **실측(엔진판 12 적재 후)** | **1,158,177B(+208KB)** | **773,598B(+45KB)** | **938,052B(+223KB, +2,115건 — TTL 180일)** |

fin_sym 증가 내역(47종목 합): d.sga 45.6KB·d.rnd 43.5KB(파생 열 줄 입력 복사 — 매출원가와 같은 방식)·n 30KB·m 23KB·sp 10.9KB·d.tp 9KB.
합계 +0.48MB — M0 512MB 의 0.09%(DB 전체 22.3MB → 약 22.8MB).

## 5. 확인된 결함 (③ — 이번 전환으로 해소)

| ID | 내용 | 결과 |
|---|---|---|
| S1 | 여러 줄 판관비 회사에서 태그 목록(SG&A → G&A)이 일반관리비만 잡음 — 판매·마케팅이 기타 영업비용으로 | AMAT·AMZN·BE·GOOG·META·MSFT·NFLX·ORCL·PLTR·UBER·V 판관비 = 줄 합(예: AMZN 2021 8,823 → 116,485, GOOG 13,510 → 36,422) |
| S2 | 주석에만 있는 R&D 태그(판관비 안에 포함된 금액)를 연구개발비로 차감 — 기타 영업비용 음수·이중 차감 | CL·MDLZ·PEP·VRT·XOM 연구개발비 빈칸 + "본표에 줄 없음"(PEP 2021 기타 영업비용 −752 → 0) |
| S3 | 회사 고유 R&D 줄 누락·주석 태그 사용 | GLW 연구개발비 = 본표 "Research, development and engineering"(2021 800 → 995), AMZN = "Technology and infrastructure"(빈칸 → 56,052) |
| S4 | KO "Other operating charges" 누락, MCD·HLT·MAR·SBUX·V·VST·CEG 등 기타 영업비용 빈칸 | 오너 결정대로 채움(MCD 판관비 = "Other" 줄 — 옛 값 3,039 는 D&A 포함 SG&A 머리 합계 태그) |
| S5 | 20-F(TSM·SPOT) 판관비·연구개발비 빈칸(IFRS 개념 미대응) | 본표 IFRS 줄 합, LTM 은 Yahoo 줄별 |

**전·후 비교**(`baseline-snapshot.mjs` 47종목, `.omc/snapshots/sga-before`·`sga-after`, 행 이름 기준 대조 `.omc/tmp/sga-cmp.mjs`): 손익계산서
바뀐 칸 486(연간 295·분기 191) — 판관비 148(값→값 135·빈칸→값 13) · 연구개발비 60(빈칸→값 29·값→빈칸 25·값→값 6) · 기타 영업비용 278
(값→값 121·빈칸→값 157). 새 행 59개(하위 줄 57·DAL 각주 2 — 이후 KO 같은 이름 하위 줄 2쌍을 한 행으로 합침). **그 밖의 행·화면(하이라이트·재무분석·요약·TTM·컨센서스·개요) 변화 0**(시세·베타 등 시장 데이터
조회 시각 차이만). fin 저장본에서 매출·매출원가·매출총이익·영업이익·영업비용 칸 변경 0(fin_chg 엔진판 12 기록은 m.sga·m.rnd 와 20-F LTM
판관비·연구개발비 줄 16칸뿐). 그 밖의 값→값 사례: MAR 2025 Q2 245 → 210(2026 Q2 10-Q 재작성 비교값 — 1층 최신 판본 규칙), MRVL FY2022
955.3 → 955.245(정밀값), KO 2021~ 판관비 + Other operating charges.

## 6. 미결

1. **UBER "Operations and support"**(2,854, FY2025)는 판관비 성격 이름이 아니라 기타 영업비용에 남는다 — 오너 확인 필요(Yahoo 는 판관비에 포함하는지 미확인).
2. **AMZN FY2016~2020 "Technology and content"**(`amzn:TechnologyAndContentExpense`)는 오너 결정(Technology and infrastructure) 범위 밖 —
   연구개발비 빈칸 + "본표에 줄 없음"(화면 표시 범위 밖 옛 열). 2021Q4 는 구성 공시 간 줄 구성 다름(T&I ↔ 없음)으로 빈칸.
3. **MCD 판관비 = "Other" 줄만**(오너 결정): 본표 "Selling, general & administrative expenses" 머리 아래 D&A 줄(457)은 감가상각이라 제외 —
   Yahoo·SA 의 판관비와 정의가 다를 수 있음(검증기 대조 때 ②).
4. KO 판관비에 "Other operating charges"(구조조정·손상 성격 포함)를 넣은 것은 오너 결정 — 외부 3곳은 이 줄을 판관비 밖(비경상)으로 둘 가능성.
5. 옛 열 빈칸(화면 범위 밖): TSM FY2017~2020·HLT FY2016~17·DELL FY2020·MRVL 2022Q3~Q4(계산 구조 없음), DELL·SNDK·WDC 2024Q1~Q3(10-K 분기
   요약표 열 — 줄 값 없음, 매출원가와 같음), MCD 2024Q1·2025Q1(총비용 항등식 불성립 — 매출원가와 같음).
6. 검증기 대조(`--metric=sga`) 미구현 — 앱 표기 계약: 행 이름 `^\(−\) 판매관리비`·`^\(−\) 연구개발비`(뒤에 `(본표: …)` 가능), 하위 행 id
   `is:sga:<개념>`·`is:rnd:<개념>`, 빈칸 사유 문구 `본표에 줄 없음`·`구성 공시 간 줄 구성 다름 — 기준 혼합`·`금융사 — 해당 없음`.
