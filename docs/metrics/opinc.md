
## 2026-09-28 외부 영업이익 차이 분해 (미국 10-K 제출사, ③ 68건)

대상: `verify-financials --universe --metric=sga` 의 영업이익 ③ 68건(앱 = SEC 본표 영업이익, A층 정확 일치). 방법: 그 연도의
원 10-K 인스턴스에서 손익계산서 본표 줄 + 일회성 성격 태그(구조조정·손상·소송·인수 등, 포괄손익·세금·현금흐름 태그 제외)를
후보로 **외부 − 앱 = 1~2개 항목 합**을 외부 표기 정밀도(백만 → ±0.5백만) 안에서 찾음. 블룸버그 스냅샷 보유 종목(IBM·KO·MCD·
MDLZ·XOM·CAT·DELL·ORCL·MRVL)은 BBG 조정(비정상항목) 부분집합으로도 대조. 스크립트: scratchpad `oi/batch.mjs`·`oi/bbgmatch.mjs`.
검증기·앱 코드 변경 없음(2항목 조합은 우연 일치 위험이 있어 판정 규칙으로 넣지 않음).

**확정 — 단일 항목 정확 일치(② 정의 차이로 볼 수 있음)**

| 종목·기간 | 소스 | 외부 − 앱(백만) | 원인 |
|---|---|---|---|
| INTC 2021 | StockAnalysis | +2,626 | 본표 `RestructuringSettlementAndImpairmentProvisions` "Restructuring and other charges" 2,626 제외 |
| MAR 2021 | StockAnalysis | +8 | 본표 "Restructuring and merger-related charges" 8 제외 |
| V FY2021 | StockAnalysis | +3 | 본표 `LossContingencyLossInPeriod` "Litigation provision" 3 제외 |
| CAT 2021 | 인포맥스 | +90 | 주석 `RestructuringCharges` 90 제외 (BBG 조정 "구조조정 90" 과도 일치) |
| DELL FY2022 | StockAnalysis | +134 | 주석 `RestructuringCosts` "Severance charges" 134 제외 |

**추정 — 본표 2개 항목 정확 일치(의미는 타당하나 조합 탐색이라 우연 가능성 배제 못 함)**

| 종목·기간 | 소스 | 외부 − 앱 | 조합 |
|---|---|---|---|
| AMAT FY2021 | StockAnalysis | +311 | 본표 "Severance and related charges" 157 + "Deal termination fee" 154 제외 |
| DAL 2021 | 인포맥스 | −4,531 | 본표 "Government grant recognition" 4,512 를 영업이익에서 뺌(급여지원 보조금) + 구조조정 −19 |
| DAL 2021 | StockAnalysis | −4,061 | 정부보조금 4,512 뺌 + 본표 비근무 연금 이익 451 을 영업이익에 넣음 |
| MCD 2021 | StockAnalysis | −197.9 | 본표 "Other operating (income) expense, net" 483.3 중 "Impairment and other charges" 285.4 를 뺀 나머지(매각이익 등) 제외 |
| XOM 2023 | StockAnalysis | +2,586 | 손상 3,300 제외 − 비근무 연금 714 (XOM 영업이익은 합성) |

**미해결 52건(LTM 6건 별도)** — AMAT·CAT(SA)·CEG·CL·DAL 외·DELL(인포맥스)·GLW·HLT·IBM 2021~2025·INTC(인포맥스)·KO·MCD(인포맥스)·MDLZ·
MRVL·MU·PEP·ORCL·SBUX·TER·VRT·VST·WDC·XOM 2021·2022·2024. LTM 6건(IBM·MDLZ·XOM)은 분기 원본 합성이 필요해 이번 범위 밖.
- 블룸버그 비정상항목 부분집합으로 맞는 건 CAT 인포맥스 1건뿐. BBG 자체도 세 번째 정의(ORCL 조정 영업이익 20,530 = GAAP +
  소송합의 4,700 + 구조조정 191 + 기타 4,713 — SA 4,910·인포맥스 4,936 어느 조합과도 불일치; IBM·XOM 은 BBG GAAP 영업이익부터
  앱과 다름 — IBM 2021 BBG 6,253 vs 앱 6,865, XOM 2021 BBG 23,233 vs 앱 24,019: 두 회사 모두 본표 영업이익 소계가 없어 정의가
  갈림). → **블룸버그 스냅샷을 더 받아도 SA·인포맥스 차이는 풀리지 않을 가능성이 높다**(SA·FactSet 은 주석 기반 자체 조정).
- 풀려면 SA·인포맥스(FactSet)가 제외한 항목을 소스 쪽에서 직접 봐야 한다(StockAnalysis 는 "Operating Income" 정의 문서·항목
  분해가 없음, 인포맥스는 FactSet 항목 드릴다운 화면 확인 필요).

**앱 일회성비용 행이 빈 원인(edgar-oneoff.ts)** — 표시 숫자에 영향 주는 수정이라 미적용, 오너 확인 대기:
1. **ORCL 전 연도 빈칸**: 기간 목록을 표준 세전이익 태그(`IncomeLossFromContinuingOperationsBeforeIncomeTaxes…`)로 만드는데
   ORCL 은 2018 이후 회사 고유 태그(`orcl_IncomeLossFromContinuingOperationsIncludingNoncontrollingInterestBeforeIncomeTaxes…`)라
   기간이 0개. 일회성 줄은 정상 판독됨(FY2024~26 `BusinessCombinationAcquisitionRelatedCosts`·`RestructuringCharges`, 2026
   `orcl_RestructuringAndOtherExpenses`). 수정안: 기간 목록을 영업이익(`OperatingIncomeLossUnified`) 또는 계산 구조 루트 개념
   기준으로.
2. **KO·MCD 빈칸(정상 동작)**: 본표 줄이 "Other operating charges"(KO 846 — 손상·구조조정 등 합)·"Other operating (income)
   expense, net"(MCD)처럼 라벨에 일회성 단어가 없어 "별도 줄만" 규칙에 안 걸림. 주석 내역까지 읽으려면 "손익계산서 별도 줄만"
   결정(2026-09-24)을 바꿔야 함.
3. **가장 오래된 연도(2021) 빈칸**: 최근 10-K 3건만 읽고 결산일 2.2년 안만 쓴다 → 5개 연도 표시에서 첫 해가 항상 빔(SBUX 처럼
   결산월이 늦어 창 안에 드는 경우만 값). 수정안: 그 기간을 담은 10-K 를 과거 목록까지 찾아 읽기(`edgar-annual-filings.ts`,
   다른 모듈과 같은 방식).
