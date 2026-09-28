# 외부 소스 차이 분해

## 2026-09-28 외부 차이 분해(인포맥스 참고 전환 후)

기준 보고서: `reports/verify/verify-us-20260928-203756.json`(인포맥스 = 참고, 외화·시가총액·주식수 예외). 원칙: 추정 금지 — 외부 − 앱 = SEC
원본(companyfacts·10-K/10-Q 인스턴스 차원 사실) 또는 블룸버그 항목의 **정확한 식**만 원인. 같은 소스 × 종목 × 지표는 **대조한 모든 연간 열**에서
성립(항목 없는 해 = 0 → 외부 = 앱). 한 해만 맞는 것은 불인정.

### 연구개발비(우선 처리)

| 종목 · 소스 | 결과 | 식(모든 연도) |
|---|---|---|
| DELL · StockAnalysis | ② FY2022~2026 | 외부 = 앱 − `SeveranceCosts1`[손익 위치 = 연구개발비] (7 · 56 · 40 · 119 · 130) |
| BE · StockAnalysis | ② 2025(다른 해 0) | 외부 = 앱 − `AssetImpairmentCharges`[손익 위치 = 연구개발비] 3.0 |
| META · StockAnalysis 2022 | 미해결 | 2022 차이 1,719 = `RestructuringCharges`[위치 = 연구개발비, 2022 계획] 1,719 이지만 2023 에 같은 항목 1,572 가 있는데 StockAnalysis 2023 = 앱 → 전 연도 불성립 |
| GLW · StockAnalysis 2021(−1) | 미해결 | 차원 포함 전수 탐색에서 일치 사실은 무관한 항목(계열사 설비 이전액)뿐 |
| AMZN · StockAnalysis LTM(−1,474) | 미해결(LTM 재검 대기) | StockAnalysis LTM = 자기 분기 합(28,322 + 24,908 + 41,650 + 24,732)이나 분기마다 SEC 와 다름(연간은 일치). 10-Q 에 줄별 주식보상 사실 없음 |
| IBM · StockAnalysis LTM(−4) | 미해결(LTM 재검 대기) | SEC 분기 합 8,753·앱 8,754·StockAnalysis 8,750 |
| BE · StockAnalysis·블룸버그 LTM | 미해결(LTM 재검 대기) | companyfacts 분기 자료가 2026-03-31 까지 |

규칙(검증기): 연간 열마다 그 사업연도 10-K 원본의 [손익 위치 축 = 연구개발비·판관비] 사실을 미리 읽고(`locFacts`), 개념 하나씩
"외부 = 앱 − 그 항목(없는 해 0)"을 전 연도 조건으로 판정(`sgaRule` noteRules `loc-*`).

### 매출(LTM 4행)

| 종목 · 소스 | 결과 | 식 |
|---|---|---|
| HLT · StockAnalysis LTM 5,104(앱 12,485) | ② | StockAnalysis LTM = 자기 분기 4개 합, 분기마다 SEC "매출 − 비용 환급 매출"과 정확 일치: 1,283 · 1,280(= 4,954 − 9개월 3,674) · 1,182 · 1,359. StockAnalysis 는 분기 매출을 환급 제외로, 연간은 총매출로 싣는다 |
| CL · IBM · ORCL · 블룸버그 LTM ±1 | (LTM 전환 대기) | 블룸버그 = SEC 3개월 분기 4개 합(CL 21,046 · IBM 69,096 · ORCL 71,777), 앱 = 사업연도 + 당기 누적 − 전년 동기(21,047 · 69,095 · 71,776). 오너 결정으로 앱 LTM 을 분기 합으로 바꾸는 중이라 규칙은 넣지 않음 |

### 검증기 결함(수정)

분기 합 규칙(`cogsQuarterSum`·`opQuarterSum`·`daQuarterSum`·`sgaQuarterSum`)이 분기 자료가 없는 블룸버그에 StockAnalysis 분기값을 써서
"블룸버그 LTM = 자기 분기 4개 합"으로 잘못 ② 판정했다(IBM LTM 연구개발비). 분기 자료가 있는 소스(Yahoo·StockAnalysis·인포맥스)만 적용.
