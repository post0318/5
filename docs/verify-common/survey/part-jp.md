# 일본 지표 사전 조사 (origin/jp/app 8591851)

경로는 모두 `src/lib/...`·`src/components/...` (브랜치 줄 번호). 공통 기호:
- `f` = `jpFundamentals()` 결과(JpFund, src/lib/markets/jp/jp-ev.ts:196~443), `v` = `jpValuation()` 결과(JpVal, jp-ev.ts:502~637).
- 열 = 최근 5개 사업연도(`FY{결산연도}`) + 현재/LTM. **LTM 흐름 = 최근 사업연도 + 반기 누적 − 전년 같은 반기, 재무상태표·주식수 = 반기말**(src/lib/markets/jp/statements.ts:390~405, 450~458). 사업연도 뒤 반기 보고서가 없으면 LTM = 최근 사업연도 그대로(`ltmIsFy`, statements.ts:433~437 / jp-ev.ts:207).
- 열마다 그 기간을 실은 **가장 나중 제출 서류**의 본표 값(statements.ts:416~425).
- 주당 값(EPS·DPS·BPS)·주가는 **현재 주식 기준**(Yahoo 분할 보정, jp-ev.ts:32~34, 561~608).
- 멀티플 부호 규칙: 분모 0 이하면 공란(`pos`, jp-ev.ts:611~613).
- 공시 원천은 EDINET XBRL 본표(jppfs_cor = J-GAAP, jpigp_cor = IFRS) + 경영지표(jpcrp_cor …SummaryOfBusinessResults).

## ① 하이라이트 — 일반 레이아웃 (src/lib/markets/jp/jp-highlights.ts:105~133, 밸류 78~83)

| 행 키 | 표시 이름 | 일본 산식 | 원천 | 메모 |
|---|---|---|---|---|
| mktcap | 시가총액 | 열 기준일 실제 종가 × 그 날 유통주식수. 연도 열 종가 = 결산일 이전 10일 안 마지막 봉의 Yahoo 종가 × 그 뒤 분할 곱(실제 가격 환원), LTM = 현재가(px.last) × (반기말 주식수 × 그 뒤 분할) | 주식수 = 발행주식수 − 자기주식(statements.ts:510, 有報 株式の総数等·自己株式等), jp-ev.ts:545~559; 종가 `barOn` jp-ev.ts:472~476 | 기말 직전 권리락 분할은 주식수 × 비율(jp-ev.ts:515~517). 분할 이력 없으면 연도 열 공란(jp-ev.ts:537). 우선주 0(일본 상장사 보통주만, jp-ev.ts:17) |
| cash | − 현금성자산 | 유동자산 안 現金及び現金同等物(IFRS)·現金及び預金(J-GAAP) + 定期預金·短期投資·有価証券·短期運用有価証券·短期運用資産, 상하위 이중 합산 제외(sumTop) | `isCash` jp-ev.ts:101~104, 계산 336~337; 요소 jpigp_cor:CashAndCashEquivalentsIFRS, jppfs_cor:CashAndDeposits, jppfs_cor:CashAndCashEquivalents | その他の金融資産 제외(한국 "기타유동금융자산 제외"와 같음, jp-ev.ts:24~25). **장기 채권형 증권 미포함**(미국과 다름) |
| debt | + 총차입금 (리스부채 포함) | 부채 구역 차입금 줄(借入·社債·有利子負債·リース負債·リース債務·CP·借用金·長期債務·資金調達に係る債務) 합, 預金·貯金 등 제외. IFRS 에서 본표에 リース負債 줄 없으면 ① 주석이 차입금 줄 포함 확인 → 그대로 ② 주석 리스부채 장부금액 가산 ③ 확인 불가 → 본표 차입금만 + 사유 | `DEBT_RE`/`isDebt` jp-ev.ts:97~99, 338~361; 리스 판정 241~273, 343~353 | 차입금+기타금융부채 한 줄(三菱重工)이면 공란(오너 결정 D4, jp-ev.ts:354~361). **리스 확인 불가 시 debt 값은 남고(본표만) EV 만 공란**(jp-ev.ts:359, 369) — 재무분석 레버리지 비율은 이 값 그대로 씀 |
| nci | + 비지배지분 | NonControllingInterests 줄, 없고 자본 있으면 0 | jp-ev.ts:320~321; jpigp_cor:NonControllingInterestsIFRS, jppfs_cor:NonControllingInterests | 값이 하나라도 0 아닐 때만 행 표시(jp-highlights.ts:114) |
| ev | 기업가치 (EV) | mcap + 차입금 + 비지배지분 − 현금 | `netDebtEv` jp-ev.ts:365~371, `v.ev` 624~625 | 금융업 서식·금융사업 연결(CAPTIVE_RE: 金融事業に係る債権 등)·D4·리스 불명이면 공란(jp-ev.ts:366~369). **오너 결정(2026-10-11) "전 시장 미국 규칙"은 코드 미반영**(커밋 8591851 메시지) |
| revenue | 매출액 | 본표 매출 줄: 合計 라벨 → RevenueIFRS·Revenue2IFRS·NetSalesIFRS·OperatingRevenueIFRS·NetSales·OperatingRevenue1/2·NetSalesOfCompletedConstructionContracts·OrdinaryIncomeBNK → 라벨(売上高 등) | `REV_PREDS` jp-ev.ts:109~123, 277 | 예상 열 = Yahoo revenueAvg(jp-highlights.ts:66) |
| revenue_yoy | 성장률 % YoY | (당기 − 앞 열)/abs(앞 열). 첫 열 공란, LTM = LTM vs 최근 사업연도(ltmIsFy 면 공란), 예상 열은 앞 열(LTM 이면 그 앞 사업연도) 대비 | `seq` jp-highlights.ts:58~64 | 첫 열 공란(인수인계 지적). 앞 열이 1년 차이인지 확인 안 함(재무분석 yoy 도 같음) |
| opinc | 영업이익 | 본표 OperatingProfitLossIFRS·OperatingIncome·라벨 営業利益/損益 → 없으면 ① 事業利益 줄 ② 세전이익 + abs(支払利息) − 持分法利益 + 持分法損失 ③ 공란 | jp-ev.ts:124~132, 278~293 | ② 는 "미국 기준과 같음" 주석(jp-ev.ts:291). 금융업 서식 공란 |
| opinc_m | 마진 % | 영업이익 / 매출 | jp-highlights.ts:75, 120 | |
| ebitda | EBITDA | 영업이익 + 감가상각비. 감가상각비 = CF 영업활동 減価償却·償却費·のれん償却額 줄 합(繰延保険契約費·社債·割引·株式報酬·保険 제외), 손상 묶인 줄은 그대로, 별도 減損損失 줄 미포함 | jp-ev.ts:378~387 | **중단영업 감가상각 처리 없음**(인수인계 결함 5). 사용권자산 상각은 CF 줄에 묶여 있으면 포함(별도 규칙 없음 — 미확인) |
| ebitda_m | 마진 % | EBITDA / 매출 | jp-highlights.ts:122 | |
| ni | 순이익 (지배) | ProfitLossAttributableToOwnersOfParent(IFRS·J-GAAP). 개별 회사(연결 없음)만 ProfitLoss·NetIncome·ProfitLossIFRS | jp-ev.ts:303~311 | 예상 열 = Yahoo epsAvg × 현재 주식수(jp-highlights.ts:70) |
| ni_m | 마진 % | 지배 순이익 / 매출 | jp-highlights.ts:124 | |
| eps | EPS (희석) | 연도 열: 경영지표 희석 EPS → 희석 "－"·없음이면 기본 EPS → 본표 EPS 줄; 그 서류 제출일 뒤 분할로 나눔. LTM(반기 뒤) = LTM 지배 순이익 ÷ 현재 유통주식수. LTM=FY 면 최근 사업연도 EPS | statements.ts:473~480, 546~560 (jpcrp_cor:DilutedEarningsLossPerShareIFRSSummaryOfBusinessResults·DilutedEarningsPerShareSummaryOfBusinessResults, Basic…, jpigp_cor:DilutedEarningsLossPerShareIFRS 등); jp-ev.ts:561~583 | 주당 흐름식 금지 원칙(미국 ltmEps 와 같음, jp-ev.ts:563). 예상 열 Yahoo epsAvg |
| eps_yoy | 성장률 % YoY | seq(EPS) | jp-highlights.ts:126 | 위 YoY 규칙 |
| dps | DPS | 그 사업연도 有報 자신의 경영지표 1株当たり配当額(개별·회사 단위), 결산일 뒤 분할(+기말 직전 권리락 분할)로 나눔. "－" = 0. LTM: ltmIsFy 일 때만 최근 사업연도 값, 반기 뒤 LTM 은 공란 | statements.ts:562~571 (jpcrp_cor:DividendPaidPerShareSummaryOfBusinessResults); jp-ev.ts:584~608 | 기중 분할이면 공시 합계 그대로(jp-ev.ts:603~606) |
| divyield | 배당수익률 % | DPS / 열 주가(현재 주식 기준) ×100 | jp-ev.ts:609 | |
| ocf | 영업활동 현금흐름 | NetCashProvidedByUsedInOperatingActivities(IFRS·J-GAAP) | jp-ev.ts:374 | |
| capex | 자본지출 | 투자활동 有形固定資産…取得/購入(売却 제외) 줄 합, 부호 abs → 화면은 음수 표시 | jp-ev.ts:375~377; jp-highlights.ts:108, 131 | **무형자산 취득 미포함**(유형만) |
| fcf | 잉여현금흐름 | OCF − CapEx | jp-highlights.ts:109 | |
| per | PER | 열 주가 ÷ 현재 주식 기준 EPS(EPS>0) | jp-ev.ts:613~615 | 예상 열 = 현재가 / Yahoo epsAvg(>0)(jp-highlights.ts:79) |
| pbr | PBR | 시가총액 ÷ 지배주주 자본(>0) | jp-ev.ts:619~620; 지배주주 자본 = IFRS EquityAttributableToOwnersOfParentIFRS, J-GAAP NetAssets − NonControllingInterests − SubscriptionRightsToShares(jp-ev.ts:322~326) | 기말 값 |
| psr | PSR | 시가총액 ÷ 매출(>0) | jp-ev.ts:621~622 | 예상 열 = 현재 시가총액 / Yahoo revenueAvg(분모 truthy 만 확인, jp-highlights.ts:81) |
| ev_ebitda | EV/EBITDA | EV ÷ EBITDA(>0) | jp-ev.ts:626~628 | 금융 레이아웃엔 행 없음 |

## ② 하이라이트 — 금융 레이아웃 (`f.financial` = 손익계산서에 …BNK·INS·SEC 요소, jp-ev.ts:204; 행 jp-highlights.ts:86~104 + 밸류 78~82) — 17행

| 행 키 | 표시 이름 | 일본 산식 | 원천 | 메모 |
|---|---|---|---|---|
| mktcap | 시가총액 | 일반과 같음 | jp-ev.ts:545~559 | |
| equity | 자기자본 (지배주주) | 지배주주 자본(위 PBR 분모와 같음) | jp-ev.ts:322~326 | |
| assets | 자산총계 | AssetsIFRS·Assets | jp-ev.ts:316 | |
| revenue | 경상수익 | REV_PREDS(은행은 OrdinaryIncomeBNK·라벨 経常収益) | jp-ev.ts:109~123 | 표시 이름만 바뀜(jp-highlights.ts:66) |
| revenue_yoy | 성장률 % YoY | seq | jp-highlights.ts:94 | |
| ordinary | 경상이익 | jppfs_cor:OrdinaryIncome | jp-ev.ts:294 | **일본 고유**(J-GAAP 경상이익) |
| ordinary_m | 마진 % | 경상이익 / 경상수익 | jp-highlights.ts:96 | |
| ni | 순이익 (지배) | 일반과 같음 | jp-ev.ts:303~311 | |
| ni_m | 마진 % | 지배 순이익 / 경상수익 | jp-highlights.ts:98 | |
| roe | ROE % | 지배 순이익 ÷ **평균** 지배주주 자본((기말 + 1년 전 기말)/2) ×100. 1년 전 없으면 공란. LTM 의 1년 전 = 전년 같은 반기말(반기 화면) | jp-ev.ts:629~633, `bsPrev` 430~437 | 평균 자본(미국·한국 하이라이트에는 ROE 행 없음 — 확인 범위 밖) |
| eps | EPS (희석) | 일반과 같음 | | |
| eps_yoy | 성장률 % YoY | seq | | |
| dps | DPS | 일반과 같음 | | |
| divyield | 배당수익률 % | 일반과 같음 | | |
| per | PER | 일반과 같음 | | |
| pbr | PBR | 일반과 같음 | | |
| psr | PSR (경상수익 기준) | 시가총액 ÷ 경상수익 | jp-highlights.ts:81 | |

EV·EBITDA·차입금·현금흐름 행 없음(주석 "예금·보험부채가 영업 부채", jp-highlights.ts:140).

## ③ 재무분석 (src/lib/markets/jp/jp-analysis.ts) — 키 = `an:{표시 이름}` (accountId, jp-analysis.ts:27)

공통: 평균 잔액 = (기말 + 1년 전 기말)/2, 1년 전 없으면 공란(기말 대체 안 함, jp-analysis.ts:8, 38~45). YoY = 직전 사업연도 열 대비, 첫 사업연도 열 공란("전년 열 없음"), LTM = 최근 사업연도 대비(ltmIsFy 면 공란)(49~57). CAGR(k=3): 연도 열 = 3년 전 사업연도 대비, LTM 열 = **LTM 값 vs (최근 사업연도 − 3년) 사업연도**, 지수 1/3 고정, 양쪽 > 0 일 때만, LTM 없으면 공란(연간값 대체 없음)(58~66).

### 일반 레이아웃 (jp-analysis.ts:143~208)

| 행 키 | 표시 이름 | 일본 산식 | 원천 | 메모 |
|---|---|---|---|---|
| an:PER | PER | v.per(하이라이트와 같음) | jp-analysis.ts:145 | |
| an:PBR | PBR | v.pbr | :146 | 분모 지배주주 자본 |
| an:PSR | PSR | v.psr | :147 | |
| an:EV/EBITDA | EV/EBITDA | v.evEbitda | :148 | |
| an:PEG (EPS 3Y CAGR) | PEG | PER ÷ EPS 3년 CAGR(PER>0, CAGR≥1) | :76~77 | |
| an:ROE (%) | ROE | 지배 순이익 ÷ 평균 지배주주 자본 | :71~73, 152 | |
| an:순이익률 (%) | 순이익률 | 지배 순이익 / 매출 | :75, 153 | |
| an:× 총자산회전율 (회) | 총자산회전율 | 매출 / 평균 자산 | :154 | |
| an:× 재무레버리지 (배) | 재무레버리지 | 평균 자산 / **평균 지배주주 자본** | :155 | 듀폰 분해 일관(ROE 분모와 같음) |
| an:ROA (%) | ROA | 지배 순이익 / 평균 자산 | :74, 156 | |
| an:ROIC (%) | ROIC | NOPAT = 영업이익 × (1 − clamp(법인세/세전, 0, 0.4)); 투하자본 = 평균 자산 − (평균 유동부채 − 평균 유동차입금) | :115~123, 157 | 세전이익 0·없으면 공란 |
| an:FCF 마진 (%) | FCF 마진 | (OCF − CapEx) / 매출 | :69, 158 | |
| an:매출총이익률 (%) | 매출총이익률 | GrossProfitIFRS·GrossProfit / 매출 | jp-ev.ts:312; :159 | |
| an:영업이익률 (%) | 영업이익률 | 영업이익 / 매출 | :160 | |
| an:유효세율 (%) | 유효세율 | 법인세(IncomeTaxExpenseIFRS·IncomeTaxes, 없으면 Current+Deferred 합) / 세전이익 | jp-ev.ts:296~302; :161 | |
| an:영업현금흐름 / 순이익 | OCF/순이익 | OCF / 지배 순이익 | :164 | |
| an:주당 FCF | 주당 FCF | FCF × 열 주가 ÷ 시가총액(= FCF ÷ 현재 기준 주식수) | :142, 165 | |
| an:부채비율 (%) | 부채비율 | 부채총계 / **자본총계**(EquityIFRS·NetAssets) | jp-ev.ts:317~319; :168 | 자본총계 분모(인수인계: 레버리지 분모 혼재) |
| an:총차입금 / 자기자본 (%) | 총차입금/자기자본 | 차입금 / 자본총계 | :169 | 리스 불명이면 본표 차입금만으로 계산 |
| an:총차입금 / 총자산 (%) | 총차입금/총자산 | 차입금 / 자산(기말) | :170 | |
| an:순차입금 / 자기자본 (%) | 순차입금/자기자본 | (차입금 − 현금) / 자본총계 — 비지배지분 미포함, 둘 다 있을 때만 | :70, 171 | |
| an:총차입금 / EBITDA | 총차입금/EBITDA | 차입금 / EBITDA(>0) | :174 | |
| an:순차입금 / EBITDA | 순차입금/EBITDA | 순차입금 / EBITDA(>0) | :175 | |
| an:영업이익 / 총차입금 | 영업이익/총차입금 | 영업이익 / 차입금 | :176 | |
| an:이자보상배율 (EBIT/이자) | 이자보상배율 | 영업이익 / **CF 利息の支払額(현금 이자지급) abs** | jp-ev.ts:388~390; :177 | 현금 기준(미국 발생주의와 다름 — 인수인계 지적) |
| an:CFO / 총차입금 | CFO/총차입금 | OCF / 차입금 | :178 | |
| an:FCF / 총차입금 | FCF/총차입금 | FCF / 차입금 | :179 | |
| an:알트만 Z-스코어 | 알트만 Z | 1.2·운전자본/자산 + 1.4·이익잉여금/자산 + 3.3·영업이익/자산 + 0.6·시가총액/부채총계 + 1.0·매출/자산(기말) | :125~130, 180 | 이익잉여금 RetainedEarningsIFRS·RetainedEarnings(jp-ev.ts:329) |
| an:유동비율 | 유동비율 | 유동자산 / 유동부채 | :183 | |
| an:당좌비율 | 당좌비율 | (현금성자산 + 매출채권) / 유동부채, 한쪽 없으면 0 으로 | :131~132, 184 | 현금성자산에 단기투자 포함("한국과 같은 범위" 주석) |
| an:현금비율 | 현금비율 | 현금성자산 / 유동부채 | :185 | |
| an:CFO / 유동부채 | CFO/유동부채 | OCF / **평균** 유동부채 | :186 | 다른 유동성 비율은 기말 |
| an:매출채권 회전일수 (DSO) | DSO | 평균 매출채권 / 매출 × 365 | :137, 189 | 매출채권 = 유동자산 営業債権·受取手形·売掛金 등 첫 줄(jp-ev.ts:330) |
| an:재고자산 회전일수 (DIO) | DIO | 평균 재고 / 매출원가 × 365. 원가 = abs(CostOfSales) 또는 abs(매출 − 매출총이익) | :133, 138, 190 | |
| an:매입채무 회전일수 (DPO) | DPO | 평균 매입채무 / 매출원가 × 365 | :139, 191 | |
| an:현금전환주기 (CCC) | CCC | DSO + DIO − DPO | :140, 192 | |
| an:배당성향 (%) | 배당성향 | CF 配当金の支払額(비지배 제외) abs / 지배 순이익 | jp-ev.ts:391~393; :78, 195 | 현금 지급 기준(LTM 도 FY+H−H 흐름) |
| an:매출액(YoY) | 매출액 | yoy(매출) | :198 | |
| an:영업이익(YoY) | 영업이익 | yoy | :199 | |
| an:순이익(YoY) | 순이익 | yoy(지배) | :200 | |
| an:희석 EPS(YoY) | 희석 EPS | yoy(현재 기준 EPS) | :201 | |
| an:영업활동 현금흐름(YoY) | 영업활동 현금흐름 | yoy | :202 | |
| an:잉여현금흐름(YoY) | 잉여현금흐름 | yoy | :203 | |
| an:매출액(CAGR) | 매출액 3년 CAGR | cagr(매출, 3) | :206 | 키는 YoY 행과 같은 `an:매출액`(accountId 충돌 — 표시 이름 같음) |
| an:EPS(CAGR) | EPS 3년 CAGR | cagr(EPS, 3) | :207 | |

(행 수 45 — 인수인계 "일본 45"와 일치. 실제 accountId 는 `an:매출액` 등 YoY·CAGR 두 행이 같은 값을 가짐, jp-analysis.ts:27·198·206)

### 금융 레이아웃 (jp-analysis.ts:81~111) — 17행

| 행 키 | 표시 이름 | 일본 산식 | 원천 | 메모 |
|---|---|---|---|---|
| an:PER | PER | v.per | :84 | |
| an:PBR | PBR | v.pbr | :85 | |
| an:PSR (경상수익 기준) | PSR | v.psr | :86 | |
| an:PEG (EPS 3Y CAGR) | PEG | 일반과 같음 | :87 | |
| an:ROE (%) | ROE | 평균 지배주주 자본 | :90 | |
| an:ROA (%) | ROA | 평균 자산 | :91 | |
| an:순이익률 (%) | 순이익률 | 지배 순이익 / 경상수익 | :92 | |
| an:경상이익률 (%) | 경상이익률 | 경상이익 / 경상수익 | :93 | 일본 고유 |
| an:유효세율 (%) | 유효세율 | 법인세/세전 | :94 | |
| an:자기자본비율 (%) | 자기자본비율 | 지배주주 자본 / 자산(기말) | :97 | 금융만 |
| an:배당성향 (%) | 배당성향 | 현금 배당지급 / 지배 순이익 | :100 | |
| an:경상수익(YoY) | 경상수익 | yoy | :103 | |
| an:경상이익(YoY) | 경상이익 | yoy | :104 | |
| an:순이익(YoY) | 순이익 | yoy | :105 | |
| an:희석 EPS(YoY) | 희석 EPS | yoy | :106 | |
| an:경상수익(CAGR) | 경상수익 3년 CAGR | cagr | :109 | |
| an:EPS(CAGR) | EPS 3년 CAGR | cagr | :110 | |

## ④ 개요 11행 (src/components/stock-analysis.tsx:406~524, 694~704; 계산 src/lib/markets/multiples.ts `computeUsMultiples` 121~216 — 일본은 미국과 같은 함수, multiples.ts:220)

입력 = `getJpTtm` → `jpTtmFromModel`(jp-ev.ts:643~695, 하이라이트 LTM 열과 같은 값).

| 행 키(라벨) | 표시 이름 | 일본 산식 | 원천 | 메모 |
|---|---|---|---|---|
| 시가총액 | 시가총액 | `multiples.marketCap` = 개요 현재가(quote.last) × snapshot.evShares(= v.shares LTM: 반기말 유통주식수 × 그 뒤 분할); **null 이면 `ov.quote.marketCap`(Yahoo) 표시** | stock-analysis.tsx:697~703; multiples.ts:142~145 | Yahoo 대체는 미국만 금지(stock-analysis.tsx:696~697) — 인수인계 지적과 같음. 유니버스는 대체 없음 |
| PER | PER | 현재가 ÷ 최근 사업연도 EPS(fyEps = v.eps[최근 FY], 현재 주식 기준)(>0) | multiples.ts:148~152; jp-ev.ts:675 | |
| PER(TTM) | PER(TTM) | 현재가 ÷ ttm.eps(LTM 지배 순이익 ÷ 현재 주식수, 또는 ltmIsFy 면 FY EPS)(>0) | stock-analysis.tsx:457~465; jp-ev.ts:674 | |
| 추정PER | 추정PER | Yahoo forwardPer, 없으면 현재가 ÷ Yahoo "차년" epsAvg(>0) | stock-analysis.tsx:477~488 | Yahoo forwardPer 자체는 부호 확인 없음 |
| PBR | PBR | 시가총액 ÷ snapshot.equity(LTM 열 지배주주 자본 = 반기말)(>0) | multiples.ts:157~163; jp-ev.ts:686 | |
| EV/EBITDA | EV/EBITDA | (시가총액 + netDebtEv) ÷ (LTM 영업이익 + LTM 감가상각비)(>0). 금융업·금융사업 연결은 evBlocker 로 공란 | multiples.ts:168~189; jp-ev.ts:667, 691~692 | 라벨은 evEbitdaIsApprox=false 라 "EV/EBITDA" |
| BPS | BPS | snapshot.equity ÷ evShares(bookShares 없음) | multiples.ts:157~161 | 하이라이트·컨센서스 BPS(지배자본×주가÷시총)와 같은 주식수 기준 |
| DPS | DPS | ttm.dpsAnnual = 최근 사업연도 DPS(현재 주식 기준) | src/app/api/markets/[market]/[symbol]/ttm/route.ts:67~75; jp-ev.ts:668, 678 | |
| DPS(TTM) | DPS(TTM) | ltmIsFy 일 때만 최근 사업연도 DPS, 반기 뒤면 공란 | jp-ev.ts:679~682 | 반기 보고서 뒤 12개월 배당 미산정 |
| 배당수익률 | 배당수익률 | DPS(TTM) ÷ 현재가 | stock-analysis.tsx:495 | DPS(TTM) 공란이면 공란 |
| PSR | PSR | 시가총액 ÷ LTM 매출(분모 truthy) | multiples.ts:164~166 | |

## ⑤ 유니버스 통합 뷰 (src/lib/universe/overview.ts:37~120, 화면 src/components/universe-overview.tsx) — 일본은 미국과 같은 TTM 경로(overview.ts:74~76)

| 칸 | 표시 이름 | 일본 산식 | 원천 | 메모 |
|---|---|---|---|---|
| last | 종가 | ov.quote.last | overview.ts:98 | |
| changePct | 등락 | ov.quote.changePct | overview.ts:99 | |
| marketCap | 시가총액 | ov.multiples.marketCap(위 개요와 같은 함수) | overview.ts:111 | **Yahoo 대체 없음** — 개요 화면과 다름 |
| foreignRatio | 외국인지분율 | 행 없음(한국만) | overview.ts:64, 115 | |
| revenueAnnual | 매출액 | ttm.revenue(LTM) | overview.ts:77 | 이름은 Annual 이나 LTM |
| opMargin | 영업이익률 | ttm.opIncome / ttm.revenue | overview.ts:113 | 금융 서식은 영업이익 공란 → 공란 |
| netMargin | 순이익률 | ttm.netIncome(지배) / ttm.revenue | overview.ts:114 | |
| perTtm | PER(TTM) | ov.multiples.perTtm | overview.ts:102 | |
| estPer | PER(Fwd) | Yahoo forwardPer 만(현재가 ÷ 차년 EPS 대체 없음) | overview.ts:103~106 | 개요 추정PER 과 대체 규칙 다름 |
| targetMeanPrice | 목표주가 | Yahoo targetMeanPrice | overview.ts:109 | 민카부 목표주가 아님 |
| recommendationKey | 투자의견 | Yahoo recommendationKey | overview.ts:110 | |

(per·pbr 필드도 저장하나 화면 표에는 칸 없음 — universe-overview.tsx 머리줄 확인)

## ⑥ 컨센서스 (src/lib/markets/consensus.ts, src/components/consensus-panel.tsx, src/components/minkabu-consensus.tsx)

일본 실적 행은 `getJpConsensusYears`(src/lib/markets/jp/jp-views.ts:74~106, 사업연도 열만 — 하이라이트와 같은 값). 연도 = 연간 재무제표 periods 의 fiscalYear 최근 4개(consensus.ts:234~237).

| 지표 | 표시 이름 | 일본 산식 | 원천 | 메모 |
|---|---|---|---|---|
| revenue (차트 막대) | 매출액(천만엔) | 실적 = f.rev, 추정 = Yahoo revenueAvg | consensus.ts:382, 569; consensus-panel.tsx:62, 102~109 | |
| revenueYoY | (패널 미표시) | 행 간 YoY, 첫 행 공란(미국만 전년 값으로 채움) | consensus.ts:585~604 | |
| opIncome | (패널 미표시) | f.op | consensus.ts:384 | |
| netIncome | (패널 미표시) | f.ni(지배) | consensus.ts:385 | |
| eps (차트 선) | EPS | 실적 = v.eps(현재 주식 기준), 추정 = Yahoo epsAvg | consensus.ts:386, 563; consensus-panel.tsx:63, 110~118 | |
| bps | (패널 미표시) | 지배자본 × 주가 ÷ 시가총액(결산일) | jp-ev.ts:617 | notes 에 사유만 노출(consensus.ts:395) |
| per | (패널 미표시) | v.per(결산일 주가, EPS>0) | jp-views.ts:96 | |
| pbr | (패널 미표시) | v.pbr | jp-views.ts:97 | |
| roe | (패널 미표시) | v.roe = **평균** 지배주주 자본 | jp-views.ts:98; jp-ev.ts:629~633 | 미국·한국 컨센서스 ROE = 기말 자본(consensus.ts:500) — 정의 다름 |
| evEbitda | (패널 미표시) | v.evEbitda | jp-views.ts:99 | |
| 추정 행 per | (패널 미표시) | 현재가 ÷ Yahoo epsAvg — **부호 규칙 없음**(eps truthy 만) | consensus.ts:564 | |
| epsRevision.eps / epsNext | 당해·차년도 EPS(E) | Yahoo epsTrend(현재·1주·1개월·3개월 전) | consensus.ts:607~624; consensus-panel.tsx:155~165 | |
| epsRevision.per / perNext | 당해·차년도 PER(E) | 현재가 ÷ EPS(E) — **부호 규칙 없음** | consensus.ts:615 | 인수인계 지적과 같음 |
| earningsSurprise | EPS 어닝 서프라이즈(컨센서스·실제·서프라이즈) | Yahoo surprises 최근 4건 | consensus.ts:635; consensus-panel.tsx:173~215 | |
| (민카부) 목표주가 | 목표주가 + 상승여력 | 민카부 analyst_consensus 목표주가, 상승여력 = 목표가/개요 현재가 − 1 | minkabu-consensus.tsx:68~90; src/lib/markets/jp/minkabu.ts:67~78 | 일본 고유 출처(오너 예외 승인) |
| (민카부) 1개월·3개월 전 대비 | 목표가 변화 | history latest vs 1m·3m | minkabu-consensus.tsx:91~94 | |
| (민카부) 레이팅·애널리스트 수·기준일·의견 분포·변화 표 | | 민카부 화면 판독 | minkabu-consensus.tsx:97~160 | |
| (민카부) 업적 예상 | 매출액·순이익·EPS(애널리스트 예상 열 + 회사 예상 열) | 민카부 業績予想 표 売上高·当期利益·1株当り利益 | minkabu.ts:198~221; minkabu-consensus.tsx:176~181 | 일본 고유(회사 예상 = 決算短信 가이던스) |

## 일본만의 특이 규칙

1. **LTM = 최근 사업연도 + 반기 누적 − 전년 같은 반기**(분기 보고서 없음, EDINET 2024-04 부터 반기·연간만 — statements.ts:20, 602). 반기 보고서 전에는 LTM = 최근 사업연도 그대로(ltmIsFy) → LTM YoY 공란, DPS(TTM)·배당수익률 LTM 은 반기 뒤면 공란.
2. 주당 값·주가 모두 **현재 주식 기준 분할 보정**: EPS 는 "서류 제출일 뒤 분할"로, DPS 는 "결산일 뒤 분할 + 기말 직전 권리락 분할"로 나눈다(jp-ev.ts:32~34, 592~600). 시가총액만 그 날 실제 주식 기준.
3. 주식수 = 有報 株式の総数等 발행주식수 − 自己株式等 제출회사 행(자기주식 차감) — 한국 "확인 후 적용" 항목과 대조 필요.
4. EPS = 경영지표 희석 → "－"이면 기본 → 본표 EPS 줄(statements.ts:546~559).
5. DPS = 경영지표 개별(회사 단위) 1株当たり配当額, "－" = 0(무배당).
6. 영업이익 없을 때 ① 事業利益 줄 → ② 세전 + 支払利息 − 持分法(미국식) → ③ 공란.
7. 금융업 판정 = 손익계산서 요소가 …BNK·INS·SEC(jp-ev.ts:204). 금융 레이아웃 고유 행: 경상수익·경상이익·경상이익률·자기자본비율·ROE(하이라이트).
8. EV 공란 사유가 미국·한국보다 많음: 금융업, 금융사업 연결(CAPTIVE_RE — 도요타·소니·혼다·セブン&アイ), D4(차입금+기타금융부채 한 줄), IFRS 리스부채 확인 불가. **10-11 오너 결정(미국 규칙으로 채움)은 코드 미반영.**
9. 리스부채 확인 불가일 때 `f.debt` 는 본표 차입금만으로 남아 재무분석 레버리지·건전성 비율(총차입금/자기자본·/EBITDA 등)이 리스 빠진 값으로 계산됨(EV 만 공란) — 같은 화면 안 정의 불일치(jp-ev.ts:340~361, jp-analysis.ts:169~179).
10. 감가상각비 = CF 영업활동 줄 합(손상 묶인 줄 그대로, 별도 減損損失 제외, のれん償却額 포함) — **중단영업 처리 없음**, 영업비용 기준(한국 최종 결정) 아님.
11. 현금성자산에 장기 채권형 증권 없음(유동 定期預金·短期投資·有価証券까지만).
12. CapEx = 유형자산 취득만(무형 제외).
13. ROE(하이라이트 금융·재무분석·컨센서스)·ROA·회전율 = **평균 잔액**, 1년 전 없으면 공란. LTM 의 1년 전 = 전년 같은 반기말.
14. 재무분석 레버리지 분모 혼재: 부채비율·총차입금/자기자본·순차입금/자기자본 = 자본총계, 재무레버리지·ROE = 지배주주 자본(인수인계 지적과 같음).
15. 이자보상배율 분모 = CF 利息の支払額(현금 지급).
16. 배당성향 = CF 配当金の支払額(비지배 제외) / 지배 순이익(현금 기준, 주당 DPS 기준 아님).
17. 순차입금(재무분석) = 차입금 − 현금(비지배지분 미포함, 둘 다 있을 때만) — EV 브릿지 netDebtEv(비지배 포함)와 다른 값.
18. CAGR LTM 열 = LTM 값 vs (최근 FY − 3) 값, 지수 1/3 고정(실제 기간 3.5년).
19. 하이라이트 YoY 첫 열 공란, 앞 열이 1년 차이인지 확인 안 함.
20. 개요 시가총액만 Yahoo 대체(stock-analysis.tsx:703), 유니버스·하이라이트는 대체 없음.
21. 컨센서스 패널은 실적 행의 PER·PBR·ROE·EV/EBITDA·BPS 를 계산하지만 화면에 그리지 않음(차트 = 매출·EPS, 표 = EPS 리비전·서프라이즈). 일본은 민카부 카드(목표주가·레이팅·업적 예상 — 회사 예상 포함)가 추가.
22. 하이라이트 금액 단위 JPY 백만(jp-highlights.ts:156), 컨센서스 차트 천만엔.
23. statements.ts:475 `BPS` 태그 목록에 `EquityToAssetRatioIFRSSummaryOfBusinessResults`(자기자본비율)가 들어 있음 — 다만 `x.bps` 는 화면 계산에 쓰이지 않음(v.bps 는 jp-ev.ts:617 에서 자본×주가÷시총으로 계산). 잠재 오류로만 기록.
