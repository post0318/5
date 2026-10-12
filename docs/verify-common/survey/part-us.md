# 지표 사전 조사 — 미국(origin/us/app 4628227) 파트

모든 경로는 `src/...`(origin/us/app 기준 줄 번호, 실제 확인). 약어: HL = `src/lib/markets/us/edgar-highlights.ts`, BK = `src/lib/markets/us/edgar-highlights-bank.ts`, AN = `src/lib/markets/us/edgar-analysis.ts`, EV = `src/lib/markets/us/edgar-ev.ts`, PS = `src/lib/markets/us/edgar-pershare.ts`, SR = `src/lib/markets/us/edgar-series.ts`, SH = `src/lib/markets/us/edgar-shares.ts`, FR = `src/lib/markets/us/fin-revenue.ts`, MU = `src/lib/markets/multiples.ts`, CO = `src/lib/markets/consensus.ts`, SA = `src/components/stock-analysis.tsx`, UO = `src/lib/universe/overview.ts`, ED = `src/lib/markets/us/edgar.ts`(buildUsTtm).

## 0. 공통 부품(여러 행이 공유)

| 부품 | 미국 정의 | 원천(파일:줄) |
|---|---|---|
| LTM 흐름 | 최근 4개 분기 합(오너 결정 2026-09-28 "LTM 분기합"), 20-F Yahoo 분기면 FY + 당기누적 − 전년동기누적. 사업연도 뒤 정기공시가 있는데 분기 누적 없음 → 공란(LTM_NO_QUARTER), 마지막 연간값 550일 초과 → 공란. 연간값으로 대체 안 함 | SR:711 `ltmFlowOf`, SR:752 `quarterSumLtm`, SR:677 `ltmAnchor`(최근 정기공시 자산총계 기준일) |
| 사업연도 키 | `fiscalYearOf(결산일)` — 1월 1~7일 결산은 전년도 | SR:226 |
| 매출(연간·LTM) | 재무 5층(fin) 매출 지표 `facts.revenue`(은행은 순수익 유형 규칙) | FR:133 `revAnnualMap`, FR:151 `revLtm` |
| 영업이익 | 비금융(fin 경로): fin opinc 열(본표 소계, 없으면 공시 계산구조 "세전이익 − 영업외"), 금융사(fin 유형 bank·broker·insurer): 합성 `OperatingIncomeLossUnified` = OperatingIncomeLoss → 세전+이자비용−지분법(EBIT) → 세전; 금융업(financialSector)은 이자 가산 안 함 | EV:752 `opIncomeViaFin`, EV:766 `opIncomeAnnualCells`, EV:782 `opIncomeLtm`, EV:637 `opIncomeEntries` |
| 감가상각비 | 현금흐름표 본표 감가상각 줄 합(SYN_DA_CF) 또는 콘텐츠 상각 포함 합성(NFLX)이 있으면 그것, 없으면 합계 태그 최댓값(DA_TOTAL), 구성항목(감가+무형) 합이 2% 넘게 크면 구성합. 중단사업 혼합 연도 공란 | EV:444 `pickDa`, EV:518 `daAnnualByYear`, EV:573 `daTtm`, EV:549 `daTtmCell` |
| 지배주주 순이익 | NetIncomeLoss → ProfitLoss − NCI 순이익(같은 기간 NCI 없으면 공시에 NCI 줄 없음 증명 시만) → 보통주 귀속 순이익(우선주배당·NCI 없을 때만) | PS:79 `netIncomeToParentEntries`, PS:209, PS:203 `ltmNetIncomeOf` |
| EPS 분자(보통주 귀속) | NetIncomeLossAvailableToCommonStockholdersDiluted/Basic → (우선주배당 없으면) 지배주주 순이익 | PS:106 `niToCommonEntries` |
| 사업연도 희석 EPS | EarningsPerShareDiluted(분할 보정) → Class A 실측 → 계속+중단 희석 EPS 합 → 보통주귀속 순이익 ÷ 희석 가중평균 → 근사(순이익 ÷ 결산일 주식수, 라벨). 공시 EPS 0 + 순이익≠0 은 공란 | PS:153 `fyEps` |
| LTM EPS | LTM 보통주 귀속 순이익 ÷ 현재 주식수(흐름식 금지) | PS:124 `ltmEpsOf` |
| 자기자본 | 기준일 ±7일 StockholdersEquity(최신 공시) → 포함자본 − MinorityInterest → 자산 − 부채(NCI·임시자본 없음 증명 시). 지배주주 자본 | PS:228 `parentEquityOf` |
| 주식수 | 현재 = EDGAR 보강 → 인포맥스 보정 → (표지 45일 초과 시) Yahoo; 결산일 = 결산일 본표 유통주식수 등(CLAUDE.md "결산일 주식수") | SH:247 `buildShareResolver`(current SH:326, atFiscalYearEnd SH:321) |
| EV 브릿지 | 시가총액(+UP-REIT 파트너지분 시가) + 이자부 차입금(본표 차입 줄 합 SYN_DEBT_FACE, 없으면 태그 규칙, 금융리스 포함·운용리스 제외) + 우선주(장부가와 청산가치 중 큰 값) + 비지배지분 − (현금 + 단기투자 + 장기투자증권). 금융 자회사는 제조 부문 차입금, 판별 실패·부문 미분리는 공란. 기준일 ±6일 값만 | EV:126 `resolveDebt`, EV:265 `buildEvResolver`, EV:345 `resolve`, EV:427 `evAt`; 태그 목록 EV:40~100 |
| 배수 부호 규칙 | 분모 ≤ 0 이면 공란 | PS:264 `positiveRatio` |
| 무배당 | 배당 공시가 하나도 없는 사업연도·최근 1년 = 0 | `src/lib/markets/us/blank-reason.ts`:28,33 |
| 지급기준 DPS | 주당배당 공시 없는 해 = 배당금 지급액(PaymentsOfDividendsCommonStock→PaymentsOfOrdinaryDividends→PaymentsOfDividends) ÷ 기본 가중평균 주식수 | blank-reason.ts:55 `dpsFromPaid` |
| 보통주 배당 근거 | 주당배당 태그·보통주 배당 태그가 없으면 포괄 배당 태그를 보통주 배당으로 보지 않음 | `src/lib/markets/us/edgar-cashflow.ts`:265 |
| 금융회사 판정 | SIC 60xx·61xx + NoninterestExpense 태깅 | `src/lib/markets/us/edgar-financial.ts`:26 |

## 1. 하이라이트 — 일반(buildUsHighlights)

열: 최근 5개 사업연도(fin 매출 연도) + 현재/LTM(기준일 = Yahoo 분기말 또는 자산총계 최근일, HL:205~207) + 예상 최대 2개(Yahoo earningsTrend). 라우트 분기: `src/app/api/markets/[market]/[symbol]/highlights/route.ts`:199~205(금융회사면 BK).

| 행 키 | 표시 이름 | 미국 산식 | 원천 | 메모 |
|---|---|---|---|---|
| mktcap | 시가총액 | FY: 결산일 이전 마지막 종가(secBasisBars) × 결산일 주식수 / LTM: 최근 종가 × 현재 주식수 / 예상: 없음 | HL:358~383, SH | 상장 전이면 공란 + 사유(HL:383) |
| opunits | + 운영 파트너십 지분 (시가) | Yahoo implied − shares × 가격 (리츠만, 값 있을 때만 행 표시) | HL:399~400, HL:583~585 | 미국만. 근거: CLAUDE.md UP-REIT |
| cash | − 현금·단기투자·장기투자증권 | −(현금 + 단기투자(본표 SYN_STI_FACE 또는 STI 태그 최댓값) + 장기투자증권 최댓값) | EV:362~370, HL:394 | LongTermInvestments 미차감(EV:30~34). 장기 채권형 증권 차감은 미국만(인수인계 어긋남 7) |
| debt | + 차입금 | 이자부 차입금 + 금융리스, 운용리스 제외. 금융 자회사 = 제조 부문만, 부문 미분리면 연결값 표시(EV만 공란) | EV:126, HL:395, HL:402~409 | CLAUDE.md "운용리스는 차입금에서 제외" |
| pref_nci | + 우선주·비지배지분 | 우선주(장부가·청산가치 큰 값)+우선 파트너지분 + NCI(UP-REIT면 OP 장부가 차감) | EV:384~402, HL:396 | 한국은 `nci` 행만·`pref_mcap`(우선주 시가) 별도 |
| ev | 기업가치 (EV) | 시가총액 + opunits 시가 + 차입금 + 우선주 + NCI − 현금. 예상 열 없음. 20-F LTM은 EV 구성 같은 기준일일 때만 | EV:427~432, HL:391,401 | 은행은 BK에서 동일식 |
| revenue | 매출액 | FY: fin 연간 / LTM: fin LTM / 예상: Yahoo revenueAvg | HL:414~422, FR:133,151 | 매출 = 총매출 Revenues 우선(CLAUDE.md) |
| revenue_yoy | 성장률 % YoY | (당 − 전)/\|전\|×100. 첫 FY 열은 전년 fin 값, **LTM 열은 직전 FY 열 대비**, **첫 예상 열은 LTM 열 대비** | HL:544~552, HL:154 | LTM·예상 YoY 기준이 "직전 열"이라 같은 기간 비교 아님 — 근거 주석 없음 |
| ebitda | EBITDA | 영업이익 + 감가상각비. 둘 중 하나 없으면 공란(0 대체 없음) | HL:423~441 | 비fin 경로 LTM = fin LTM opinc + daTtm |
| ebitda_m | 마진 % | EBITDA / 매출 ×100 (매출 0 이면 공란, 부호 무관) | HL:594, HL:158 | |
| ni | 순이익 | FY: 지배주주 순이익 / LTM: `ltmNetIncomeOf` / 예상: 예상 희석 EPS × 현재 주식수 | HL:443~460 | 예상 순이익 = 오너 결정 2026-10-01 |
| ni_m | 마진 % | 순이익 / 매출 ×100 | HL:596 | |
| eps | EPS (희석) | FY: `fyEps` / LTM: `ltmEpsOf`(LTM 보통주귀속 순이익 ÷ 현재 주식수) / 예상: Yahoo epsAvg | HL:465~491 | 적자도 음수 그대로 |
| eps_yoy | 성장률 % YoY | revenue_yoy 와 같은 규칙, 첫 열 전년 = 공시 EarningsPerShareDiluted 원값(분할 보정 없음) | HL:598, HL:293 | 첫 열 전년값 S.eps 는 분할 미보정·fyEps 대체경로 미적용 — 근거 없음(미확인 영향) |
| dps | DPS | FY: CommonStockDividendsPerShareDeclared → CashPaid 연도별 병합 × 분할계수 → 무배당 0 → 지급기준(dpsFromPaid) / LTM: 같은 태그 LTM 흐름(분기 DPS 합) → 무배당 0 → 20-F만 LTM 배당지급 ÷ 현재 주식수 / 예상: 없음 | HL:301, HL:493~504, HL:519~530 | 오너 결정 2026-10-02(무배당 0, 지급기준) |
| divyield | 배당수익률 % | DPS / 그 열 가격(FY 결산일 종가, LTM 최근 종가) ×100 | HL:505~507 | |
| ocf | 영업활동 현금흐름 | 현금흐름표 화면 행 `cf:total:영업활동 현금흐름` 값, 그 열이 없으면 NetCashProvidedByUsedInOperatingActivities 연간/LTM | HL:531, HL:512~518 | 폴백 태그 목록이 AN(계속사업 태그 포함)과 다름 |
| capex | 자본지출 | −\|현금흐름표 `cf:투자활동 현금흐름:유형자산 취득`\|, 없으면 CAPEX_CONCEPTS(4종) | HL:532~536, HL:93~98 | AN 폴백은 5종(PaymentsToAcquireOtherProductiveAssets 추가) |
| fcf | 잉여현금흐름 | OCF + capex(음수) | HL:537~539 | |
| per | PER | FY: 결산일 종가 ÷ FY EPS / LTM: 최근 종가 ÷ LTM EPS / 예상: 현재가 ÷ 예상 EPS. 분모 ≤0 공란 | HL:615~617 | |
| pbr | PBR | 시가총액 ÷ 지배주주 자본(기말, 그 열 기준일). 예상 공란 | HL:618~620 | 분모 = 지배주주 자본 |
| psr | PSR | FY·LTM: 시가총액 ÷ 매출 / 예상: 현재 시가총액 ÷ 예상 매출 | HL:621~623 | |
| ev_ebitda | EV/EBITDA | EV ÷ EBITDA(≤0 공란). 예상 공란 | HL:624~626 | 분자 EV 음수는 허용 |

## 2. 하이라이트 — 금융 레이아웃(buildUsBankHighlights, 은행·카드사)

LTM 기준일 = Assets 최근 시점값(BK:122) — 일반 레이아웃(Yahoo 분기말/latestBalanceDate)과 산정 함수 다름(결과는 대개 같음, 미확인).

| 행 키 | 표시 이름 | 미국 산식 | 원천 | 메모 |
|---|---|---|---|---|
| mktcap | 시가총액 | 일반과 같음(결산일 종가 × 결산일 주식수 / 최근 종가 × 현재 주식수) | BK:207~227 | |
| cash | − 현금·단기투자·장기투자증권 | 일반과 같은 EV 브릿지(무맥락 resolver), LTM 은 latestBalanceDate | BK:290~293 | 오너 지시 2026-10-01 "EV를 비워두면 안된다" |
| debt | + 차입금 | 이자부 차입금(예금 제외) | BK:292 | |
| pref_nci | + 우선주·비지배지분 | 우선주 + NCI | BK:294 | |
| ev | 기업가치 (EV) | 시가총액 + 차입금 + 우선주 + NCI − 현금(opunits 없음) | BK:295 | AXP 블룸버그 대조 주석 BK:289 |
| equity | 자기자본 장부가치 | `parentEquityOf`(지배주주) | BK:213~215 | |
| deposits | 총예금 | `Deposits` 기준일 ±6일 값 | BK:38, BK:217 | 은행만 |
| assets | 자산총계 | `Assets` 기준일 ±6일 값 | BK:218 | |
| net_revenue | 순수익 | fin 매출(은행 유형 = 순수익) / 예상 Yahoo 매출 | BK:233~241 | 노트 문구는 RevenuesNetOfInterestExpense(BK:335) |
| net_revenue_yoy | 성장률 % YoY | 일반과 같은 seq 규칙 | BK:277~282 | |
| pre_provision | 충당금전이익 | 순수익 − NoninterestExpense | BK:242~245, edgar-financial.ts:10 | |
| pre_provision_m | 마진 % | 충당금전이익 / 순수익 | BK:310 | |
| op_income | 영업이익 | 충당금전이익 − 대손충당금(Provision 3종 첫 개념) | BK:246~247, edgar-financial.ts:12 | 대손충당금 없으면 공란(AN 은 태그 자체 없는 회사만 0 — 규칙 다름) |
| op_income_m | 마진 % | 영업이익 / 순수익 | BK:312 | |
| ni | 순이익 | FY 지배주주 순이익 / **LTM = ltmFlowOf(netIncomeToParentEntries)** / 예상 EPS × 현재 주식수 | BK:249~258 | 일반은 `ltmNetIncomeOf`(같은 식) |
| ni_m | 마진 % | 순이익 / 순수익 | BK:314 | |
| eps | EPS (희석) | 일반과 같음(fyEps / ltmEpsOf / Yahoo) | BK:260~274 | |
| eps_yoy | 성장률 % YoY | seq | BK:316 | |
| per | PER | 결산일 종가 ÷ EPS, 예상 = LTM 열 가격 ÷ 예상 EPS, 분모 ≤0 공란(자체 ratio) | BK:321~323 | |
| pbr | PBR | 시가총액 ÷ 지배주주 자본 | BK:324 | |
| psr | PSR (순수익 기준) | 시가총액 ÷ 순수익 | BK:325 | |
| (없음) | DPS·배당수익률·EBITDA·EV/EBITDA·현금흐름 | 금융 레이아웃엔 행 없음 | — | |

## 3. 재무분석(buildUsAnalysis) — 행 키 = `an:${표시이름}`(AN:800)

열: 최근 5개 사업연도 + 현재/LTM. 금융 레이아웃은 별도 없음 — isFin 이면 매출총이익 대신 충당금전이익(라벨만 바뀜, AN:982), 영업이익 = 충당금전이익 − 대손충당금(AN:228~233). 평균잔액 = (기초+기말)/2, LTM 은 (최근 분기말 + 1년 전)/2(AN:630~661). 범용 ratio = 분모가 0 이 아니면 계산(**음수 분모 허용**, AN:723~729).

| 행 키 | 미국 산식 | 원천 | 메모 |
|---|---|---|---|
| PER | 그 열 가격 ÷ EPS(FY fyEps / LTM ltmEpsOf), 분모 ≤0 공란 | AN:827~830 | HL 과 같은 식 |
| PBR | 시가총액 ÷ 지배주주 자본(기말) | AN:831~834, AN:449~458 | |
| PSR | 시가총액 ÷ 매출, 매출 0 만 공란(음수 미처리) | AN:835~840 | HL 은 positiveRatio — 매출 ≤0 처리 다름(미확인 영향) |
| EV/EBITDA | EV ÷ EBITDA(EBITDA ≤0 공란) | AN:841~852 | |
| 주가 / FCF | 시가총액 ÷ FCF — 범용 ratio, **FCF 음수면 음수 배수 표시** | AN:971 | 부호 규칙 미적용, 근거 없음 |
| PEG (EPS 3Y CAGR) | PER ÷ EPS 3년 CAGR(없으면 2년), g ≥ 1% 일 때만 | AN:853~865 | |
| ROE (%) | 지배주주 순이익 ÷ **평균** 지배주주 자본 ×100 | AN:975, AN:663~675 | 분모 음수 허용 |
| 순이익률 (%) | 순이익 ÷ 매출 | AN:976 | |
| × 총자산회전율 (회) | 매출 ÷ 평균 자산 | AN:869, AN:977 | |
| × 재무레버리지 (배) | 평균 자산 ÷ 평균 지배주주 자본 | AN:870, AN:978 | 분모 = 지배주주 자본 |
| ROA (%) | 순이익 ÷ 평균 자산 | AN:979 | |
| ROIC (%) | NOPAT ÷ 평균 투하자본. NOPAT = 영업이익 × (1 − clamp(법인세/세전, 0, 0.4)), 유효세율 못 구하면 공란. 투하자본 = 평균자산 − (평균 유동부채 − 평균 유동차입금) | AN:597~608, AN:677~703, AN:980 | 세율 상한 40% |
| FCF 마진 (%) | FCF ÷ 매출 | AN:981 | |
| 매출총이익률 (%) / 충당금전이익률 (%) | fin gp ÷ 매출 / (금융) (순수익 − NoninterestExpense) ÷ 순수익 | AN:205~224, AN:982 | |
| 영업이익률 (%) | 영업이익 ÷ 매출 | AN:983 | |
| 유효세율 (%) | IncomeTaxExpenseBenefit ÷ 세전이익(PRETAX_C 4종 공시값) | AN:420~423, AN:867 | |
| FCF 수익률 (%) | FCF ÷ 시가총액 | AN:987 | |
| 영업현금흐름 / 순이익 | OCF ÷ 순이익 | AN:988 | |
| 주당 FCF | FCF ÷ 그 열 주식수(결산일/현재) | AN:731~737, AN:989 | |
| 부채비율 (%) | 부채총계 ÷ 지배주주 자본(기말). 부채총계 = Liabilities, 없으면 (부채와자본총계 또는 자산) − 포함자본 − 임시자본 | AN:609~626, AN:992 | 분자 정의 오너 확인 주석(2026-10-01) |
| 총차입금 / 자기자본 (%) | 연결 총차입금(금융 자회사 포함) ÷ 지배주주 자본 | AN:484~495, AN:993 | 신용지표는 연결, EV 만 제조부문(2026-10-01) |
| 총차입금(운용리스 포함) / 자기자본 (%) | (차입금 + 운용리스 부채) ÷ 자본 | AN:509~513, AN:994 | 미국만(S&P 식 참고) |
| 총차입금 / 총자산 (%) | 차입금 ÷ 자산(기말) | AN:995 | |
| 장기차입금 / 자기자본 (%) | 비유동 차입금(+비유동 금융리스) ÷ 자본 | AN:502~504, AN:996 | 미국만 |
| 장기차입금 / 총자산 (%) | 비유동 차입금 ÷ 자산 | AN:997 | 미국만 |
| 순차입금 / 자기자본 (%) | (차입금 − 현금·투자) ÷ 자본. 둘 다 같은 기준일 있을 때만 | AN:593~596, AN:998 | 한쪽 0 대체 안 함(인수인계: 한국은 한쪽만 있어도 계산) |
| 재무레버리지 정도 (DFL) | 영업이익 ÷ (영업이익 − 이자비용) | AN:957~962, AN:999 | 미국만 |
| 총차입금 / EBITDA | 차입금 ÷ EBITDA(음수 EBITDA 허용) | AN:1002 | |
| 순차입금 / EBITDA | 순차입금 ÷ EBITDA | AN:1003 | |
| 영업이익 / 총차입금 | | AN:1004 | |
| 이자보상배율 (EBIT/이자) | 영업이익 ÷ **발생주의 이자비용**(INT_EXP 6종 연도별 첫 값, ≤0 이면 공란, 500일 내 태깅 없으면 LTM 공란) | AN:64~71, AN:399~416, AN:1005 | 인수인계: 한국·일본은 현금 이자지급 |
| EBITDA / 이자비용 | | AN:1006 | 미국만 |
| (EBITDA−CapEx) / 이자비용 | | AN:954~956, AN:1007 | 미국만 |
| EBIT / 현금이자 | 영업이익 ÷ InterestPaidNet/InterestPaid | AN:397~398, AN:1008 | |
| EBITDA / 현금이자 | | AN:1009 | 미국만 |
| CFO / 총차입금 | | AN:1010 | |
| FCF / 총차입금 | | AN:1011 | |
| 알트만 Z-스코어 | 1.2·운전자본/자산 + 1.4·이익잉여금/자산 + 3.3·영업이익/자산 + 0.6·시가총액/부채총계 + 1.0·매출/자산(기말 잔액) | AN:924~949, AN:1012 | |
| 유동비율 | 유동자산 ÷ 유동부채(기말) | AN:1015 | |
| 당좌비율 | (현금 + 단기투자 + 매출채권) ÷ 유동부채, 매출채권 태그를 안 쓰는 회사만 0 | AN:871~889, AN:1016 | 재고 차감식 아님(엄격 정의) |
| 현금비율 | (현금 + 단기투자) ÷ 유동부채 | AN:517~534, AN:1017 | 장기투자증권 미포함 |
| CFO / 유동부채 | OCF ÷ **평균** 유동부채 | AN:1018 | 다른 유동성 지표는 기말 — 혼재, 근거 없음 |
| 매출채권 회전일수 (DSO) | 평균 매출채권 ÷ 매출 × 365 | AN:895, AN:903~909 | |
| 재고자산 회전일수 (DIO) | 평균 재고 ÷ \|매출원가\| × 365, 재고 태그 안 쓰는 회사 0 | AN:896~920 | |
| 매입채무 회전일수 (DPO) | 평균 매입채무 ÷ \|매출원가\| × 365 | AN:898~902, AN:921 | |
| 현금전환주기 (CCC) | DSO + DIO − DPO | AN:922 | |
| 배당성향 (%) | \|보통주 배당금 지급액(현금흐름표 행)\| ÷ 지배주주 순이익 ×100. 근거 없으면 0, 무배당 0 | AN:375~395, AN:1027~1032 | 지급 기준(현금) — DPS 결의 기준과 다름 |
| 총주주환원율 (%) | (\|배당\| + \|자사주매입 PaymentsForRepurchaseOfCommonStock\|) ÷ 순이익 | AN:396, AN:1033~1047 | 미국만 |
| 성장률(1Y) 매출액 | yoy1: 직전 열 대비, 첫 열은 전체 시계열 전년, LTM 은 직전 FY 열 대비 | AN:764~781, AN:1050 | |
| 성장률(1Y) EBITDA | | AN:1051 | 미국만 |
| 성장률(1Y) 영업이익 | | AN:1052 | |
| 성장률(1Y) 순이익 | | AN:1053 | |
| 성장률(1Y) 희석 EPS | | AN:1054 | |
| 성장률(1Y) 주당배당금 | DPS 시계열(선언→지급태그, 분할보정, 무배당 0, 지급기준) | AN:552~579, AN:1055 | 미국만 |
| 성장률(1Y) 영업활동 현금흐름 | | AN:1056 | |
| 성장률(1Y) 자본지출 | | AN:1057 | 미국만 |
| 성장률(1Y) 잉여현금흐름 | | AN:1058 | |
| CAGR(3Y) 매출액 | (cur/base)^(1/3) − 1, LTM 열은 LTM 값 ÷ (최근FY+1−3) 값, LTM 없으면 공란(연간 대체 없음). 음수·0 공란 | AN:741~756, AN:1061 | 인수인계: 한국은 LTM 없으면 사업연도값 |
| CAGR(3Y) EPS | | AN:1062 | |
| CAGR(3Y) 주당배당금 | | AN:1063 | 미국만 |

## 4. 개요(stock-analysis.tsx) — "11행" = 시가총액 + 투자지표 10칸

**미국은 투자지표 10칸 표를 화면에 그리지 않는다**(`market !== "us" && market !== "kr"`, SA:942) — 계산(MU computeUsMultiples)만 하고 시가총액 칸(SA:694~707)만 표시. 계산 입력은 TTM 스냅샷(ED:488 `buildUsTtm`, 라우트 `src/app/api/markets/[market]/[symbol]/ttm/route.ts`, 저장본 ttm_snap). 가격 = quote.last(마감 종가).

| 행 | 미국 산식 | 원천 | 메모 |
|---|---|---|---|
| 시가총액 | 현재가 × 현재 주식수(snapshot.evShares = shareRes.current) — Yahoo 대체 없음 | MU:142~145, ED:540~541, SA:697~703 | 화면 표시됨 |
| PER | 현재가 ÷ **최근 사업연도** 희석 EPS(fyEps), ≤0 공란 | MU:148~152, ED:551~561 | 하이라이트 FY PER(결산일 종가)와 분자 다름 |
| PER(TTM) | 현재가 ÷ LTM EPS(ltmEpsOf), ≤0 공란 | SA:457~465, MU:154~156 | |
| 추정PER | Yahoo forwardPE, 없으면 현재가 ÷ 차년 예상 EPS(>0) | SA:477~488 | Yahoo 값 자체엔 부호 규칙 없음 |
| PBR | 시가총액 ÷ 지배주주 자본(evDate 기준), ≤0 공란 | MU:157~163, ED:548 | |
| EV/EBITDA | (시가총액 + opunits 시가 − OP 장부가 + 우선주 시가(미국은 없음) + evNetDebt) ÷ (LTM 영업이익 + LTM 감가상각비), EBITDA ≤0 공란. evNetDebt = 차입금 + 우선주 + NCI − 현금 | MU:167~177, ED:581 | |
| BPS | 지배주주 자본 ÷ 현재 주식수 | MU:157~161 | |
| DPS | 최근 사업연도 **CommonStockDividendsPerShareDeclared 만**(CashPaid·분할보정·무배당 0·지급기준 없음) | ED:516~519, ED:594~595, ttm route:67~75 | 하이라이트 DPS 규칙과 다름 — 근거 없음(새 발견) |
| DPS(TTM) | 같은 태그 LTM 흐름(분기 합) | ED:596~599 | 동상 |
| 배당수익률 | DPS(TTM) ÷ 현재가 | SA:495 | |
| PSR | 시가총액 ÷ LTM 매출(매출 0 만 공란, 음수 미처리) | MU:164~166 | |

개요의 그 밖의 칸(미국 표시): 52주 베타(자체 52주 일간, 없으면 Yahoo 5년 월간 SA:722~749), 52주 최고/최저(SA:751~772), 목표주가(Yahoo, SA:773~808), 요약 칩 7개 = 재무분석 LTM 값 그대로(FCF 마진·PEG·순차입금/EBITDA·유동비율·총차입금/자기자본·이자보상배율(없으면 EBIT/현금이자 — 정의 다른 값 대체)·알트만 Z, SA:827~939).

## 5. 유니버스 통합 뷰(universe-overview.tsx + UO computeDoc)

미국은 getStockOverview(service.ts:116~124 getTtm) → ov.multiples(MU) + ov.ttm.

| 칸 | 미국 산식 | 원천 | 메모 |
|---|---|---|---|
| 종가 | ov.quote.last | UO:98 | |
| 등락 | ov.quote.changePct | UO:99 | |
| 시가총액 | multiples.marketCap(현재가 × 현재 주식수) | UO:111 | 개요와 같은 함수 |
| 외국인지분율 | 행 없음(한국만) | `src/components/universe-overview.tsx`:187~189 | |
| 매출액 | **LTM** 매출(ttm.revenue) | UO:77 | 오너 결정 2026-09-25 "LTM". 칸 이름은 revenueAnnual |
| 영업이익률 | LTM 영업이익 ÷ LTM 매출 | UO:113 | |
| 순이익률 | LTM 지배주주 순이익 ÷ LTM 매출 | UO:114 | |
| PER(TTM) | multiples.perTtm | UO:102 | |
| PER(Fwd) | Yahoo forwardPE(estPer) | UO:103~106 | 개요 추정PER 의 폴백(현재가 ÷ 차년 EPS) 없음 |
| 목표주가 | Yahoo targetMeanPrice | UO:109 | |
| 투자의견 | Yahoo recommendationKey | UO:110 | |

## 6. 컨센서스(consensus.ts + consensus-panel.tsx)

**화면 표시(us/app 의 consensus-panel.tsx 222줄)**: EPS 컨센서스 추이 표 = 시점(현재/1주/1개월/3개월 전) × [당해 EPS(E), 당해 PER(E), 차년 EPS(E), 차년 PER(E)](`src/components/consensus-panel.tsx`:130~170), EPS 어닝 서프라이즈 = [컨센서스, 실제, 서프라이즈%](같은 파일 173~215). 미국은 매출·EPS 차트도 생략(75). **연도별 실적 표(rows: 매출·영업이익·순이익·EPS·BPS·PER·PBR·ROE·EV/EBITDA)는 API 가 계산하지만 화면 어디에도 그리지 않는다**(broker-ratings.tsx 도 analystRatings·price 만 사용). 인수인계의 "consensus-panel.tsx:615" 는 이 브랜치에 그 줄이 없음(파일 222줄).

| 지표 | 미국 산식 | 원천 | 메모 |
|---|---|---|---|
| 당해/차년 EPS(E) | Yahoo earningsTrend epsTrend current·d7·d30·d90(외화 공시는 USD 환산) | CO:608~623, CO:287~292 | |
| 당해/차년 PER(E) | 현재가 ÷ EPS(E), `e` truthy 면 계산(**음수 EPS → 음수 PER**) | CO:615 | 부호 규칙 없음(인수인계 지적) |
| 어닝 서프라이즈 | Yahoo surprises 최근 4건 | CO:635 | |
| (API) revenue | getFinancials 연간 `fin:revenue` 행의 FY 값 | CO:398, CO:61~66 | 최근 4개 사업연도 |
| (API) revenueYoY | 직전 행 대비, 첫 행은 fin 전년 매출 | CO:584~604 | 예상 행은 직전 실적 행 대비 |
| (API) opIncome | opIncomeAnnualCells | CO:401~407 | |
| (API) netIncome | 지배주주 순이익 | CO:409~413 | |
| (API) eps | fyEps(결산일 주식수) / 예상 = Yahoo epsAvg | CO:441, CO:455~461, CO:563 | |
| (API) bps | 지배주주 자본(기말) ÷ 결산일 주식수 | CO:417~419, CO:463~464 | |
| (API) per | 결산일 종가(secBasisBars) ÷ EPS, ≤0 공란 / 예상 행 = 현재가 ÷ 예상 EPS(**부호 규칙 없음**) | CO:494, CO:564 | |
| (API) pbr | 결산일 종가 ÷ BPS, ≤0 공란 | CO:495~496 | 시가총액÷자본과 동치 |
| (API) roe | 순이익 ÷ **기말** 지배주주 자본 ×100, \|ROE\|≥100 숨김 | CO:500~502 | 재무분석 ROE(평균 자본)와 다름 — 인수인계 지적 |
| (API) evEbitda | edgar-ev evAt(결산일) ÷ (영업이익 + daAnnualByYear), EBITDA ≤0 공란 | CO:505~514 | |

## 미국만의 특이 규칙

1. EV 현금에 **장기투자증권(채권형)** 차감, LongTermInvestments 미차감(EV:89~94).
2. 차입금에서 **운용리스 제외**(ASC 842), 운용리스 포함 부채비율은 별도 행(AN:994).
3. **UP-REIT 운영 파트너십 지분** 시가 반영 행 `opunits`(HL:583), 우선주 = 장부가·청산가치 큰 값(EV:390~392).
4. 금융 자회사(CAT 등): EV 는 제조 부문 차입금, 신용지표는 연결 차입금(AN:484~487).
5. 영업이익: fin 5층 opinc(소계 없으면 공시 계산구조 합성), 금융사는 세전 기반 합성(EV:637~713).
6. 감가상각비: 현금흐름표 본표 감가상각 줄(손상 포함 — 손상차손 원칙 2026-09-28), 콘텐츠 상각(NFLX만), 중단사업 혼합 연도 공란.
7. LTM = 최근 4개 분기 합(20-F Yahoo 분기는 FY+누적−전년누적), 결손 시 공란(연간값 대체 없음).
8. 사업연도 EPS 대체 사슬(Class A·계속+중단 합·가중평균·근사 라벨), LTM EPS = LTM 보통주귀속 순이익 ÷ 현재 주식수.
9. 현재 주식수 = EDGAR 보강 → 인포맥스 보정 → (45일 초과) Yahoo.
10. DPS: 선언→지급 태그 병합·분할 보정·무배당 0·지급기준(dpsFromPaid)·20-F LTM 지급액÷주식수.
11. 이자보상배율은 발생주의 이자비용(INT_EXP 6종), 현금이자 별도 행.
12. 미국에만 있는 재무분석 행: 주가/FCF, FCF 수익률, 운용리스 포함 차입금/자본, 장기차입금 비율 2개, DFL, EBITDA/이자·(EBITDA−CapEx)/이자·EBITDA/현금이자, 총주주환원율, YoY EBITDA·DPS·CapEx, CAGR DPS.
13. 은행·카드사 전용 하이라이트(총예금·충당금전이익, DPS·EBITDA 행 없음).

### 이 조사에서 확인한 미국 내부 불일치(근거 주석 없음)
- 개요 DPS·DPS(TTM)(ED:516 Declared 태그만, 분할보정·무배당0·지급기준 없음) ≠ 하이라이트 DPS(HL:493~530).
- 재무분석 범용 ratio 는 음수 분모 허용(주가/FCF·ROE·총차입금/EBITDA 등 음수 표시) — 하이라이트·멀티플의 positiveRatio 와 다름. PSR 은 하이라이트만 positiveRatio.
- 하이라이트 YoY: LTM 열은 직전 FY 열 대비, 첫 예상 열은 LTM 열 대비(HL:549).
- 하이라이트 eps_yoy 첫 열 전년값 = 공시 EarningsPerShareDiluted 원값(분할 미보정, HL:293·551).
- 재무분석 CFO/유동부채만 평균 유동부채, 다른 유동성 지표는 기말.
- 은행 영업이익: 하이라이트는 대손충당금 결손 시 공란, 재무분석은 태그 자체 없는 회사만 0.
- OCF·CapEx 폴백 태그 목록이 하이라이트(HL:93~98, 1종)와 재무분석(AN:318~325, 2종·5종) 다름.
- 개요 이자보상배율 칩: 발생주의 없으면 현금이자 값으로 대체(SA:839~840).
- 컨센서스 연도별 표는 API 계산만, 화면 미표시.
