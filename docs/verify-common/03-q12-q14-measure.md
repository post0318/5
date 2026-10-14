# Q12·Q14 실측 결과 — 2호기 (2026-10-14)

작업 지시: `02-q12-q14-measure.md`. **앱 코드는 고치지 않았다** — 측정·보고만. 오너가 Q12·Q14 를 다시 정할 근거.

- 실행 위치: 2호기(macro-verify) `~/q12q14/*.py·sites.mjs`, 원자료·중간 결과 `~/5/reports/q12-q14/`(커밋 안 함).
  앱 값 = verify-dev(localhost:3000, `kr/verification` 7bf0515 — `us/app` 4628227 과 미국 앱 파일 7개가 다름) `x-verify-no-snapshot` 응답.
- 규칙: 스크립트는 `flock /tmp/macro-verify.lock` 으로 하나씩(시작 때 available 7.6GB), 운영 DB 쓰기 없음, 돈 드는 호출 없음.
  DART 는 검증 전용 키·순차·300ms·하루 상한(도구 `measure` 200건), SEC 는 기존 캐시(`~/sec-cache`) 재사용.
- 비교는 정확 일치(허용치 없음). 확인 못 한 칸은 "못 봄 + 사유".

> **Q12 결정(오너 2026-10-14)**: "유형으로 가고 NVDA·GEV·V·MAR·DELL·DAL처럼 회사가 무형을 섞어 적은 한 줄을 그대로 쓴 경우는 그대로 쓴다. 분리된 것만 분리한다."
> → 세 시장 = 본표 유형자산 취득 줄, 섞인 한 줄은 그대로, 따로 적은 무형·소프트웨어·임대장비 줄은 제외. 후속 정리는 `01-metric-dictionary-draft.md` Q12.
> Q14 는 아직 결정 전.

## 한 줄 결론

| 질문 | 측정 결과 |
|---|---|
| Q12 지금 앱은? | 미국·한국 모두 **현금흐름표 본표의 「유형자산 취득」 한 줄**(미국은 회사가 그 줄에 쓴 태그 그대로). 하이라이트 CapEx = 재무분석(현금흐름표 행) — 46종목 전 기간 같음(AXP 만 하이라이트 공란) |
| Q12 사이트 관행 | **Yahoo = 유형 + 무형(총액)**, **StockAnalysis = 유형만**(무형은 순액 별도 줄), **FnGuide = 유형만**(화면 공식 "CAPEX = (C/F)유형자산의증가"). 대표 6종목 모든 연도 정확 일치 |
| Q12 미국 "유형만" 분리 가능? | **47종목 중 7종목은 본표 한 줄에 무형·소프트웨어가 이미 섞여 있어 분리 불가**(NVDA·LRCX·GEV·V·MAR·DELL·DAL). 무형을 따로 적는 회사는 7종목(IBM 59%·HLT 83% 가 큼) |
| Q12 한국 무형 비중 | 대부분 10% 미만. 큰 종목: 한국항공우주(5년 합 114%)·한전기술(84%)·두산에너빌리티(58%)·카카오(36%, 유니버스 밖)·현대로템(33%)·LIG(30%)·한화에어로스페이스(29%) |
| Q14 네이버 = FnGuide? | **예. 30종목 중 추정치가 있는 29종목 모든 칸(매출·영업이익·순이익·EPS·목표주가·투자의견)이 FnGuide 컨센서스와 정확히 같다**(네이버는 FnGuide 값을 사사오입) |
| Q14 네이버 vs Yahoo | 기간은 28종목 같은 해(FY2026 = Yahoo 0y). **정확 일치는 매출 1·목표주가 2 칸뿐**, 나머지는 값 차이. 단위·스케일(10^k) 차이 0건. Yahoo 는 영업이익 추정 없음, 기관 수는 Yahoo 가 대부분 더 많음(19종목) |

---

## Q12 — 자본지출(CapEx) 범위

### 1. 태그 정의 원문 (us-gaap 2025, `https://xbrl.fasb.org/us-gaap/2025/us-gaap-2025.zip` → `elts/us-gaap-doc-2025.xml`)

| 태그 | documentation |
|---|---|
| PaymentsToAcquireProductiveAssets | The cash outflow for purchases of and capital improvements on property, plant and equipment (capital expenditures), software, and other intangible assets. |
| PaymentsToAcquireOtherProductiveAssets | Amount of cash outflow for the purchase of or improvements to tangible or intangible assets, used to produce goods or deliver services, classified as other. |
| PaymentsForCapitalImprovements | The cash outflow for acquisition of or capital improvements to properties held for investment (operating, managed, leased) or for use. |
| PaymentsToAcquirePropertyPlantAndEquipment | The cash outflow associated with the acquisition of long-lived, physical assets that are used in the normal conduct of business to produce goods and services and not intended for resale; includes cash outflows to pay for construction of self-constructed assets. |
| PaymentsToAcquireIntangibleAssets | The cash outflow to acquire asset without physical form usually arising from contractual or other legal rights, excluding goodwill. |
| PaymentsToDevelopSoftware | The cash outflow associated with the development or modification of software programs or applications for internal use (that is, not to be sold, leased or otherwise marketed to others) that qualify for capitalization. |
| PaymentsForSoftware | The cash outflow associated with the development, modification or acquisition of software programs or applications for internal use (that is, not to be sold, leased or otherwise marketed to others) that qualify for capitalization. |
| (참고) PaymentsForFlightEquipment | The cash outflow for acquisition of long-lived depreciable flight assets, including owned aircraft or capital improvements. |

지시 목록 밖에서 계산 구조에 나온 태그: `PaymentsToAcquireSoftware`(HLT), `PaymentsToAcquireEquipmentOnLease`(CAT) — 값은 아래 표에 포함.

### 2. 미국 47종목 — 회사가 본표에 쓴 CapEx 줄(최신 10-K/20-F 계산 구조 `_cal.xml` + 회사 라벨 `_lab.xml`)

**(가) 본표 한 줄에 무형·소프트웨어가 섞여 있음 — "유형만" 값이 공시에 없다 (7)**

| 종목 | 태그 | 회사 라벨 |
|---|---|---|
| NVDA | ProductiveAssets | Purchases related to property and equipment **and intangible assets** |
| LRCX | ProductiveAssets | Capital expenditures **and intangible assets** |
| GEV | ProductiveAssets | Additions to property, plant, and equipment **and internal-use software** |
| V | ProductiveAssets | Purchases of property, equipment **and technology** |
| MAR | ProductiveAssets(FY2023~), 그 전 PPE | Capital **and technology** expenditures |
| DELL | **PropertyPlantAndEquipment** | Capital expenditures **and capitalized software development costs** |
| DAL | FlightEquipment + OtherProductiveAssets(앱 = 둘의 합) | Flight equipment … ; Ground property and equipment, **including technology** |

**(나) ProductiveAssets 를 쓰지만 라벨은 유형만 (4)**: AMZN "Purchases of property and equipment", ISRG "Purchases of property, plant, and equipment",
CL "Capital expenditures"(FY2021·22 는 PPE 태그와 같은 값), PEP "Capital spending". — 태그 정의는 무형 포함이나 라벨로는 구분 불가.

**(다) 무형·소프트웨어를 별도 줄로 적음 (7)** — 앱은 이 줄을 CapEx 에 넣지 않는다(앱 = PPE 줄만, 전 기간 일치)

| 종목 | 별도 줄(회사 라벨) | FY2023 | FY2024 | FY2025 | 유형 대비(FY2025) |
|---|---|---:|---:|---:|---:|
| IBM | Investment in software (`ibm_PaymentsToAcquireAndDevelopSoftware`) | 565 | 637 | 647 | 59.3% |
| HLT | Capitalized software costs (`PaymentsToAcquireSoftware`) | 96 | 102 | 84 | 83.2% |
| ASML | Purchase of intangible assets (EUR) | 40.6 | 15.9 | 57.6 | 3.7% |
| VRT | Investments in capitalized software | 6.7 | 17.1 | 6.4 | 2.9% |
| MRVL | Purchases of technology licenses (FY2026 결산) | 13.9(FY24) | 7.0(FY25) | 4.5(FY26) | 1.3% |
| TSM | Intangible assets (TWD 백만) | 5,518 | — | — | 0.6%(FY2023) |
| VST | Purchases of environmental allowances | 1,071 | 1,226 | 1,189 | 43.2% — 배출권(설비투자 아님) |

(단위 백만, 통화 표기 없으면 USD)

**(라) 인수와 합친 줄 — CapEx 범위와 무관하게 분리 불가 (3)**: GOOG "Acquisitions, net of cash acquired, and purchases of intangible assets"(FY2025 1,592),
META "Acquisitions of businesses and intangible assets"(4,231), MSFT `AcquisitionsNetOfCashAcquiredAndPurchasesOfIntangibleAndOtherAssets`(FY2026 1,743).

**(마) 그 밖 (26)**: PPE 한 줄(또는 GLW `PaymentsForCapitalImprovements` "Capital expenditures"). 참고로 CAT 은 "Expenditures for equipment leased to others"(FY2025 1,465)를
따로 적고 앱은 넣지 않는다, MCD `PaymentsToAcquireOtherProductiveAssets` = "Purchases of restaurant businesses"(가맹점 인수, 앱 미포함),
TSLA FY2021 `PaymentsToAcquireIntangibleAssets` 1,500 = 디지털 자산 매입(최신 10-K 계산 구조에는 없음).

**집계**

| 항목 | 종목 수 |
|---|---:|
| PPE 태그 사용(한 해라도) | 39 |
| ProductiveAssets 사용 | 18(그중 이것만 쓰는 종목 8: AMZN·DAL·GEV·ISRG·LRCX·NVDA·PEP·V) |
| 무형·소프트웨어 별도 줄 | 7(위 다) + 인수 합산 3(위 라) |
| 하이라이트 CapEx ≠ 재무분석(현금흐름표 「유형자산 취득」) | **0** — AXP 만 하이라이트 전 기간 공란(현금흐름표엔 값 있음) |
| 앱 값 ≠ PPE 태그 값 | 4칸, 모두 소수 자리: MCD FY2022 1,899.2 vs 1,899 · FY2023 2,357.4 vs 2,357(앱이 원공시 정밀값) · MRVL FY2022 169.324 vs 169.2(이후 10-K 재작성) · **MCD LTM 3,583 vs 3,586(원인 미확인)** |

하이라이트(`CAPEX_CONCEPTS`)와 재무분석(`CAPEX_C`, `OtherProductiveAssets` 추가)의 목록 차이는 지금 유니버스에서 값 차이를 만들지 않는다 —
재무분석 자본지출 금액은 현금흐름표 화면 행을 먼저 쓰고(`edgar-analysis.ts:342`), 47종목 모두 그 행이 있다.

### 3. 한국 30종목 + NAVER·카카오 — DART 연결 현금흐름표 (FY2021~FY2025 원공시, 억원)

계정: `ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities` 「유형자산의 취득」(대한전선만 「투자활동으로 분류된 유형자산의 취득」),
`ifrs-full_PurchaseOfIntangibleAssetsClassifiedAsInvestingActivities` 「무형자산의 취득」. 비율 = 무형 ÷ 유형(절댓값; HD현대중공업 FY2022·LG에너지솔루션 FY2021~22 는 DART 값이 음수로 공시).

| 코드 | 종목 | 비교 연수 | 유형 5년 합 | 무형 5년 합 | 무형/유형 5년 | FY2025 | LTM | 못 본 칸 |
|---|---|---:|---:|---:|---:|---:|---:|---|
| 047810 | 한국항공우주 | 5 | 5,206 | 5,912 | **113.5%** | 47.6% | 208.8% | |
| 052690 | 한전기술 | 5 | 150 | 126 | **84.4%** | 68.3% | 114.3% | |
| 034020 | 두산에너빌리티 | 5 | 18,936 | 10,940 | **57.8%** | 73.2% | 66.1% | |
| 035720 | 카카오(유니버스 밖) | 5 | 21,031 | 7,530 | **35.8%** | 28.2% | 22.6% | |
| 064350 | 현대로템 | 5 | 3,415 | 1,116 | **32.7%** | 21.1% | 34.5% | |
| 079550 | LIG디펜스앤에어로스페이스 | 5 | 8,043 | 2,406 | **29.9%** | 44.8% | 35.8% | |
| 012450 | 한화에어로스페이스 | 5 | 31,049 | 8,870 | **28.6%** | 16.6% | 11.4% | |
| 402340 | SK스퀘어 | 3 | 2,994 | 590 | 19.7% | 66.9% | 41.1% | FY2021·22 DART 013 |
| 298040 | 효성중공업 | 5 | 4,143 | 580 | 14.0% | 9.6% | 4.1% | |
| 267260 | HD현대일렉트릭 | 5 | 4,915 | 507 | 10.3% | 3.6% | 5.1% | |
| 062040 | 산일전기 | 1 | 153 | 12 | 7.9% | 7.9% | 13.7% | FY2021~24 DART 013 |
| 035420 | NAVER(유니버스 밖) | 5 | 38,840 | 2,698 | 6.9% | 6.9% | 6.7% | |
| 329180 | HD현대중공업 | 5 | 21,821 | 1,493 | 6.8% | 5.8% | 6.8% | |
| 005930 | 삼성전자 | 5 | 2,530,924 | 162,923 | 6.4% | 9.7% | 8.3% | |
| 010120 | LS ELECTRIC | 5 | 6,297 | 395 | 6.3% | 4.3% | 5.4% | |
| 051600 | 한전KPS | 5 | 2,206 | 136 | 6.2% | 5.6% | 6.1% | |
| 006260 | LS | 5 | 34,141 | 1,980 | 5.8% | 3.7% | 4.0% | |
| 000660 | SK하이닉스 | 5 | 832,865 | 39,447 | 4.7% | 3.9% | 3.6% | |
| 009150 | 삼성전기 | 5 | 53,186 | 2,314 | 4.4% | 4.5% | 3.7% | |
| 001440 | 대한전선 | 5 | 4,309 | 138 | 3.2% | 3.6% | 5.1% | |
| 103590 | 일진전기 | 5 | 1,588 | 43 | 2.7% | 10.5% | 11.8% | |
| 475150 | SK이터닉스 | 2 | 265 | 5 | 2.0% | 0.0% | 11.9% | FY2021~23 DART 013 |
| 042660 | 한화오션 | 3 | 12,139 | 161 | 1.3% | 1.0% | 0.6% | FY2021·22 「유ㆍ무형자산의 취득」 한 줄(분리 불가) |
| 373220 | LG에너지솔루션 | 5 | 428,288 | 5,301 | 1.2% | 1.5% | 2.5% | |
| 178320 | 서진시스템 | 5 | 9,156 | 89 | 1.0% | 1.1% | 0.9% | |
| 006400 | 삼성SDI | 5 | 184,500 | 1,678 | 0.9% | 2.0% | 2.0% | |
| 000500 | 가온전선 | 5 | 614 | 5 | 0.9% | 0.7% | 18.7% | |
| 015760 | 한국전력공사 | 5 | 689,740 | 4,638 | 0.7% | 0.7% | 0.8% | |
| 119850 | 지엔씨에너지 | 5 | 180 | 1 | 0.4% | 0.2% | — | 2026 반기에 무형 줄 없음 |
| 229640 | LS에코에너지 | 4 | 164 | 0 | 0.1% | 0.1% | 0.1% | |
| 060370 | LS마린솔루션 | 1 | 765 | 0 | 0.0% | 0.0% | — | FY2021~23 DART 013, 2026 반기 무형 줄 없음 |
| 033100 | 제룡전기 | 0 | — | — | — | — | — | 연결재무제표 없음(DART CFS 013, 별도만) |

LTM = FY2025 + 2026 반기 누적 − **2026 반기보고서의 전년 비교값**(재작성 반영).

**앱 하이라이트 CapEx = DART 「유형자산의 취득」** — 대조 가능한 모든 칸이 백만원 단위로 같다. 원 단위 끝자리가 다른 칸(가온전선 FY2022·대한전선 FY2023·한화에어로스페이스 FY2023·두산에너빌리티 FY2022·일진전기 FY2022, 5칸)은
앱이 천원 단위로 적힌 판본 값을 쓴 것. 원공시와 다르고 **다음 해 보고서의 재작성 비교값과 같은 칸**: LS FY2021(3,033 → 2,905), 한국전력 FY2021(126,685 → 126,867),
한화오션 FY2022(합친 줄 → 1,200), SK스퀘어 FY2022, LS마린솔루션 FY2024, 산일전기 FY2024.
**못 봄**: 한화오션 FY2021 앱 983 — DART 표준 재무에는 「유ㆍ무형자산의 취득」 1,003 한 줄뿐(출처 미확인).
제룡전기·SK스퀘어 FY2021·LS마린 FY2023·산일전기 FY2022~23 앱 값 — 연결 원자료 없음(앱은 다른 원천).

측정 중 발견: 처음엔 LTM 의 전년 반기를 **2025 반기보고서 원공시**로 빼 삼성전자 LTM 이 535,936억(앱·Yahoo 519,258억)으로 나왔다 — 2026 반기보고서가
2025 반기 유형자산 취득을 25조 1,634억 → 26조 8,312억으로 다시 적었기 때문. 앱은 같은 보고서의 비교값을 쓴다(위 LTM 정의와 같음).

### 4. 사이트 관행 — 대표 6종목 (같은 기간, 정확 일치 대조)

미국: AAPL(일반)·NVDA(ProductiveAssets, 라벨에 무형 포함)·IBM(소프트웨어 별도 59%). 한국: 삼성전자·NAVER·카카오.

| 종목 | 기간 | 유형(공시) | 무형(공시) | Yahoo capitalExpenditure | StockAnalysis capex | FnGuide CAPEX |
|---|---|---:|---:|---:|---:|---:|
| IBM | FY2022~25·TTM | 1,346 / 1,245 / 1,048 / 1,091 / 1,098 | 626 / 565 / 637 / 647 / 646 | 1,972 / 1,810 / 1,685 / 1,738 / 1,744 = **유형+무형** | 1,346 / 1,245 / 1,048 / 1,091 / 1,098 = **유형** (무형은 별도 −626…) | — |
| NVDA | FY2023~26·TTM | (ProductiveAssets) 1,833 / 1,069 / 3,236 / 6,042 / 7,354 | 별도 줄 없음 | 같은 값 | 같은 값 | — |
| AAPL | FY2022~25·TTM | 10,708 / 10,959 / 9,447 / 12,715 / 10,041 | 없음 | 같은 값 | 같은 값 | — |
| 삼성전자 | FY2022~25·LTM(억원) | 494,304 / 576,113 / 514,064 / 475,222 / 519,258 | 36,963 / 29,229 / 23,353 / 46,310 / 43,173 | 531,267 / 605,342 / 537,416 / 521,531 / 562,430 = **유형+무형** | **유형** 그대로(무형 순액 별도) | 494,304 / 576,113 / 514,064 / 475,222 = **유형** |
| NAVER | FY2022~25·LTM | 7,007 / 6,406 / 5,540 / 12,347 / 16,936 | 555 / 516 / 261 / 847 / 1,129 | **유형+무형** 전 기간 | 유형 FY2022~24·LTM 일치, **FY2025 −12,347.50 vs 12,346.93(0.56억 차, 원인 미확인)** | 7,007 / 6,406 / 5,540 / 12,347 = **유형** |
| 카카오 | FY2022~25·LTM | 4,529 / 5,751 / 3,796 / 4,792 / 5,533 | 1,900 / 1,471 / 1,263 / 1,352 / 1,249 | **유형+무형** 전 기간 | **유형** 전 기간 | 4,529 / 5,751 / 3,796 / 4,792 = **유형** |

(미국 단위 백만 USD. Yahoo 의 무형은 `purchaseOfIntangibles` 총액 — 처분을 뺀 `netIntangiblesPurchaseAndSale` 이 아님. StockAnalysis 무형 줄 `salePurchaseIntangibles` 는 순액.)
FnGuide 는 「투자지표 → CAPEX」 공식이 화면에 "(C/F)유형자산의증가" 로 적혀 있다(`wcomp.fnguide.com/CompanyInfo/Invest`).
**인포맥스: 못 봄**(단말 전용, 2호기에서 접근 수단 없음).

### 5. 블룸버그(미국) — 2호기 판독 파일 `~/5/.cache/bbg/{종목}.json`(10-07 스냅샷, 「BBG 조정」 화면 "자본지출" 행)

46종목(LRCX 판독 파일 없음, AMZN·AXP 는 자본지출 행 없음) FY 칸을 블룸버그 표시 자릿수에서 정확 대조. **블룸버그 = 회사 본표 「유형자산 취득」 줄(= 앱)**, 무형·소프트웨어 별도 줄은 넣지 않는다.

| 결과 | 칸 수 | 내용 |
|---|---:|---|
| 앱(유형 줄)과 일치 | 188 | 무형·소프트웨어를 따로 적는 IBM(FY2025 1,091 — 소프트웨어 647 미포함)·HLT·VRT·MRVL·VST 포함. NVDA·GEV·V·MAR·DELL·DAL 은 회사가 섞어 적은 그 한 줄 그대로 |
| 원통화로는 일치 | 9 | ASML(EUR 900.7·1,281.8·2,155.6·2,067.2·1,573.6 = PPE 줄) · SPOT(EUR 85·25·17·61) — 앱이 USD 환산이라 달라 보임 |
| **유형 + 임대장비** | 5 | CAT: 2,472 = 1,093 + 1,379 … FY2025 4,286 = 2,821 + 1,465(`PaymentsToAcquireEquipmentOnLease` "Expenditures for equipment leased to others") — 앱은 임대장비 미포함 |
| TSM(TWD) | 2 일치 · 2 차이 | FY2022 1,082,672.13·FY2024 956,006.54 = PPE 줄. FY2021 840,395.71 vs 839,195.7(차 1,200.0)·FY2023 949,879.98 vs 949,816.8(차 63.2) — 원인 미확인 |
| 예상치 열 | 1 | MU FY2026 28,201.19(스냅샷 10-07 이 10-K 10-09 제출보다 앞, 소수 자리 = 컨센서스) |
| 차이, 원인 미확인 | 8 | INTC FY2021 20,329 vs 18,733 · FY2022 25,050 vs 24,844 · ISRG FY2021 353.5 vs 339.5 · META FY2022 31,431 vs 31,186 · FY2023 27,266 vs 27,045 · TSLA FY2023 8,898 vs 8,899 · FY2024 11,339 vs 11,342 · SNDK FY2026 152 vs 177 |

→ 블룸버그 관행은 StockAnalysis·FnGuide 와 같은 **유형만(회사 본표 줄)** 쪽. 무형을 섞어 적은 회사는 그 줄 그대로라 "유형만" 으로 정리돼 있지 않다(앱과 같은 한계).

### 6. 일본 42종목 (2026-10-14 추가 — 결정 뒤 실측)

종목: 2호기 일본 검증 최근 실행 로그(`~/jp-verify-cache`)의 42종목. 앱 값 = verify-dev(:3000) 하이라이트 `capex`, 줄 = 같은 서버 현금흐름표 화면(EDINET 본표 계정명 그대로) 투자활동.
앱 규칙(`jp-ev.ts:375`, jp/app 과 동일): 투자활동 중 이름에 `有形固定資産` 과 `取得|購入` 이 있고 `売却` 없는 줄의 합. 외부 요청 0건.

| 본표 구성 | 종목 | 앱 |
|---|---|---|
| 유형 줄만 | 8002·6861·8058·6367·6954·8001 (6) | = 유형 줄, 전 기간 |
| 유형 + 무형(·SW) 따로 | 7203(+ 「賃貸資産の購入」 따로)·285A·6981·4063·8035·6501·6098·9983·4502·2914·8766·7267·4568·6273·4661·6902·2802·9433·9022·6503·5108·4519 (22) | = 유형 줄만(무형·임대 제외), 전 기간 |
| 〃 금융 서식 | 6178·8306·8411·3382 (4) | 하이라이트에 CapEx 행 없음(금융 17행 서식) |
| 합친 한 줄 「有形固定資産及び(その他の)無形資産…」 | 9984·7011·9434·2503·9432(+ 投資不動産)·6758 (6) | = 그 줄 그대로, 전 기간 — **결정과 같음** |
| **합친 한 줄 「有形及び無形固定資産の取得による支出」** | **7974 닌텐도·9020 JR동일본·1925 다이와하우스 (3)** | **전 기간 빈칸**("현금흐름표에 有形固定資産の取得 줄 없음") — 이름에 `有形固定資産` 이 붙어 있지 않아 규칙에 안 걸림. **결정(섞인 한 줄 그대로)과 어긋남** |
| 본표 없음 | 7751 캐논 (1) | 현금흐름표 화면 자체가 비어 있음(US GAAP 회사 — EDINET XBRL 본표 없음, Q12 와 별개 기존 공백) |

무형이 큰 일본 종목(FY2026 또는 최근, 단위 백만엔): 6098 리크루트 무형 51,589 vs 유형 10,702 · 8766 도쿄해상 116,155 vs 42,577 · 4502 다케다 234,930 vs 176,003 ·
9433 KDDI 274,178 vs 404,828 · 7267 혼다 285,480 vs 612,065(「無形資産の取得及び内部開発による支出」) · 6501 히타치 146,039 vs 351,790.

### Q12 선택지 재정리용 사실

- 한국·일본 앱과 FnGuide·StockAnalysis 는 **유형만**, Yahoo 는 **유형 + 무형**. 사이트 관행이 갈린다.
- 미국에서 "유형만"으로 통일하면 7종목(NVDA·LRCX·GEV·V·MAR·DELL·DAL)은 공시에 유형만 값이 없다 → 빈칸 + 사유 또는 그 회사 줄 그대로(정의 차이 표기).
- "유형 + 무형"으로 통일하면 한국은 같은 현금흐름표의 「무형자산의 취득」을 더하면 되고(연결 재무가 있는 29종목 — 일부 해는 0 또는 줄 없음, 한화오션 FY2021·22 는 이미 합친 줄),
  미국은 별도 줄 7종목을 더하는데 VST(배출권)·CAT(임대장비)·MCD(가맹점 인수) 같은 성격 판정이 필요하고, 인수 합산 줄 3종목(GOOG·META·MSFT)은 분리 불가.
- 영향 크기: 한국 무형 비중(5년 합) 10% 이상 유니버스 9종목(위 표, 카카오 제외), 미국 별도 줄 중 비중이 큰 것은 IBM·HLT 둘(VST 는 배출권).

---

## Q14 — 한국 추정치 원천: 네이버(FnGuide) vs Yahoo

원자료(2026-10-13 기준값, 10-14 수집): 네이버 `m.stock.naver.com/api/stock/{코드}/finance/annual`·`/integration`, Yahoo `quoteSummary`
(earningsTrend·financialData·recommendationTrend), FnGuide `wcomp.fnguide.com/CompanyInfo/Consensus`·`Snapshot`
(옛 `comp.fnguide.com/SVO2/ASP/*` 주소는 66건 모두 "페이지가 없습니다" — 새 주소로 다시 받음).

### 1. 네이버 = FnGuide (같은 회계연도 FY2026, 기준일 둘 다 2026-10-13)

추정치가 있는 29종목(제룡전기는 네이버·Yahoo·FnGuide 모두 추정 없음)의 매출·영업이익·순이익·EPS·목표주가·투자의견이 **모두 FnGuide 컨센서스와 같다**.
네이버는 FnGuide 값을 사사오입한다(예: 일진전기 영업이익 FnGuide 2,552.50 → 네이버 2,553, SK이터닉스 EPS 908.50 → 909).
투자의견은 FnGuide 점수 3.95 = 네이버 3.95(FnGuide 상단 상자만 3.9 로 잘라 표시).
FnGuide 에만 있는 것: **추정 기관 수**(네이버 API 응답에 없음), FY2·FY3(네이버는 FY1 만 — Q6 와 같음).

### 2. 네이버 vs Yahoo (네이버 FY = Yahoo 0y 로 맞춤)

| 코드 | 종목 | 기간 | 매출 | EPS | 목표주가 | 기관 수 Yahoo / FnGuide | 투자의견 네이버 / Yahoo |
|---|---|---|---|---|---|---|---|
| 000500 | 가온전선 | FY2026 = 0y | +1.14% | +4.02% | **일치** | 2 / 2 | 4.0 / 1 |
| 000660 | SK하이닉스 | 〃 | +0.81% | +0.38% | −3.58% | 38 / 22 | 4.0 / 1.33 |
| 001440 | 대한전선 | 〃 | +0.67% | +1.28% | +6.79% | 5 / 7 | 4.0 / 1.6 |
| 005930 | 삼성전자 | 〃 | −0.24% | +5.05% | −3.30% | 36 / 22 | 4.0 / 1.36 |
| 006260 | LS | 〃 | +0.05% | −7.15% | −1.77% | 8 / 9 | 4.0 / 1.5 |
| 006400 | 삼성SDI | 〃 | +0.63% | −13.61% | −1.60% | 32 / 19 | 3.95 / 1.72 |
| 009150 | 삼성전기 | 〃 | +0.13% | +1.53% | +0.04% | 27 / 19 | 4.0 / 1.48 |
| 010120 | LS ELECTRIC | 〃 | −0.74% | −0.36% | −5.46% | 24 / 18 | 4.0 / 1.71 |
| 012450 | 한화에어로스페이스 | 〃 | −0.41% | +4.54% | −2.11% | 21 / 20 | 4.0 / 1.36 |
| 015760 | 한국전력 | 〃 | +0.26% | +16.38% | −3.35% | 20 / 15 | 3.93 / 2.05 |
| 033100 | 제룡전기 | — | 못 봄(세 원천 모두 추정 없음) | | | | |
| 034020 | 두산에너빌리티 | 〃 | −0.25% | +14.37% | −3.82% | 21 / 15 | 4.0 / 1.43 |
| 042660 | 한화오션 | 〃 | +0.26% | −3.86% | −5.03% | 22 / 22 | 4.0 / 1.64 |
| 047810 | 한국항공우주 | 〃 | −0.04% | +7.09% | −4.25% | 22 / 19 | 3.95 / 1.77 |
| 051600 | 한전KPS | 〃 | −0.29% | −0.02% | −0.97% | 12 / 11 | 3.91 / 1.75 |
| 052690 | 한전기술 | 〃 | +8.56% | +8.92% | +0.45% | 11 / 9 | 4.0 / 1.73 |
| 060370 | LS마린솔루션 | 〃 | +1.50% | +3.25% | +4.76% | 1 / 3 | 4.0 / 없음 |
| 062040 | 산일전기 | 〃 | +0.49% | −0.19% | +3.46% | 12 / 10 | 4.0 / 1.42 |
| 064350 | 현대로템 | 〃 | −0.41% | +1.79% | +10.79% | 19 / 19 | 4.0 / 1.53 |
| 079550 | LIG디펜스앤에어로스페이스 | 〃 | +0.53% | +0.32% | −2.82% | 19 / 18 | 4.0 / 1.47 |
| 103590 | 일진전기 | 〃 | **일치** | −0.03% | −3.01% | 5 / 4 | 4.0 / 1.6 |
| 119850 | 지엔씨에너지 | 〃 | +4.11% | −3.72% | Yahoo 없음 | 없음 / 2 | 4.0 / 없음 |
| 178320 | 서진시스템 | 〃 | −0.01% | 네이버 −58 / Yahoo −371.5 | **일치** | 3 / 3 | 4.0 / 없음 |
| 229640 | LS에코에너지 | 〃 | −0.99% | −0.23% | −6.86% | 5 / 9 | 4.0 / 없음 |
| 267260 | HD현대일렉트릭 | 〃 | −0.23% | +1.09% | +1.38% | 23 / 18 | 4.0 / 1.57 |
| 298040 | 효성중공업 | 〃 | −0.18% | +1.68% | +1.84% | 20 / 17 | 4.0 / 1.45 |
| 329180 | HD현대중공업 | 〃 | +0.68% | +1.19% | −6.98% | 23 / 20 | 4.0 / 1.52 |
| 373220 | LG에너지솔루션 | 〃 | −0.75% | 네이버 −1,077 / Yahoo −1,533.6 | −4.01% | 31 / 19 | 3.95 / 1.67 |
| 402340 | SK스퀘어 | 〃 | **−96.77%**(네이버 430,005억 / Yahoo 13,875억) | −1.80% | +2.33% | 10 / 3 | 4.0 / 1.4 |
| 475150 | SK이터닉스 | Yahoo 추정 없음 | 못 봄 | 못 봄 | Yahoo 없음 | 없음 / 2 | 4.0 / 없음 |

(차이 = (Yahoo − 네이버) ÷ |네이버|. 매출은 네이버 억원을 원으로 바꿔 억원 단위 반올림 비교, EPS·목표주가는 원.)

**집계** (비교 가능 28종목)
- 기간: 28종목 모두 네이버 FY1(2026) = Yahoo `0y`(endDate 2026-12-31). 기간 어긋남 0, Yahoo 0y 가 다음 해로 넘어간 경우 0.
- 매출: 일치 1 · 1% 이내 22 · 5% 이내 3 · 10% 이내 1 · 그 이상 1(SK스퀘어). **스케일(10^k) 차이 0**.
  SK스퀘어 −96.77% 는 10^k 로 성립하지 않는다 — 원인 못 봄(숫자로 성립하는 설명 없음).
- EPS: 일치 0 · 1% 이내 7 · 5% 이내 12 · 10% 이내 4 · 그 이상 5(한국전력 +16.4%, 두산에너빌리티 +14.4%, 삼성SDI −13.6%, LG에너지솔루션·서진시스템 적자 추정치 크기 차이).
- 목표주가: 일치 2(가온전선·서진시스템) · 1% 이내 3 · 5% 이내 16 · 10% 이내 5 · 그 이상 1(현대로템 +10.8%) · Yahoo 없음 3.
- 추정 기관 수: Yahoo(`numberOfAnalystOpinions`)가 FnGuide 보다 많음 19 · 적음 4 · 같음 4. 네이버는 기관 수 없음.
- 투자의견: **척도가 반대** — 네이버·FnGuide 는 5 = 강력매수(4.0 = Buy), Yahoo 는 1 = strong buy ~ 5 = sell. Yahoo 의견 없음 6종목.
- Yahoo 에 없는 항목: 영업이익·순이익 추정(earningsTrend 는 매출·EPS 만). 네이버에 없는 항목: FY2, 기관 수.
- `naver.ts` 주석의 "야후 스케일 오류"는 이번 30종목 FY1 매출·EPS·목표주가에서 **재현되지 않았다**(스케일 차이 0건).

---

## 검사 범위 · 못 본 범위

- 미국 47종목(유니버스 전체), 한국 30종목(유니버스 전체) + NAVER·카카오(지시서가 대표 종목으로 지정, 유니버스 밖).
- 미국 태그 LTM 을 companyfacts 로 직접 만들지 못한 종목 10(ASML·BE·DAL·KO·MAR·MDLZ·SPOT·TSM·V·XOM — 20-F 반기 미제출·YTD 기간 불일치 등). 이 종목들의 LTM 은 앱 값만 기록.
  TSM 은 FY2024 이후 companyfacts 가 USD 편의 환산만 있어 TWD 기준 FY2024·25 못 봄.
- MSFT·ORCL·TER 는 계산 구조가 `.xsd` 내장이라 회사 라벨 파일 없음(태그 이름으로만 판정).
- 인포맥스 못 봄(단말 전용). FnGuide 미국 종목 없음.
- 원인 미확인 3건: MCD LTM 앱 3,583 vs 태그 계산 3,586 · NAVER FY2025 StockAnalysis 0.56억 차 · 한화오션 FY2021 앱 983 출처.

## 외부 요청 수

스크립트가 남긴 기록(`reports/q12-q14/net-*.json`, 로그) 그대로. 수는 **요청 시도** 기준이라 스크립트 결함으로 네트워크에 나가기 전 실패한 호출도 들어 있다.

| 실행 | 기록 |
|---|---|
| 미국 1차 | SEC 3 · FASB 1 |
| 한국 1차 | DART 14(유니버스 밖 NAVER·카카오 7건씩 — 나머지 30종목은 `~/dart-cache`) |
| 사이트·Q14 1차 | 175 = 네이버 60 · 옛 FnGuide 63(전부 오류 페이지) · wcomp 3 · StockAnalysis 3 · Yahoo 46(라이브러리 불러오기 결함으로 46건 모두 실패) |
| 사이트·Q14 2차 | 46 = Yahoo 43(그중 13건 `module` 옵션 결함 실패) · StockAnalysis 3 |
| 사이트·Q14 3차 | Yahoo 13(실패 1 — 060370.KS 없는 코드, .KQ 로 받음) |
| FnGuide 새 주소 | wcomp 63 · 옛 주소 투자지표 3(오류 페이지) |
| 점검 실행 A | 미국 0 · 한국 0 · FnGuide 0 · 사이트 34(옛 FnGuide 주소가 스크립트에 남아 33 + 없는 Yahoo 코드 1) → 옛 주소 제거·"없음" 응답 저장 |
| **점검 실행 B(최종)** | **미국 0 · 한국 0 · 사이트·Q14 0 · FnGuide 0 — 모든 원천 0건** |

점검 실행의 결과 파일(`q12-us.json`·`q12-kr.json`)은 직전 실행과 바이트 단위로 같다.
