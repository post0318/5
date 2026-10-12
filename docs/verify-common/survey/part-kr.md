# 지표 사전 조사 — 한국(origin/kr/app 547f79a)

읽은 코드: scratchpad/src/kr (origin/kr/app 그대로, 줄 번호 = 브랜치). 경로는 `src/...` 기준. 모르는 칸은 "미확인".
공통 약어: `annualSeries` = dart-facts.ts:972(연도마다 그 해를 담은 **가장 최근 사업보고서** 값 — dart-facts.ts:309~312·353~357), `krLtmBalance` = dart-ev.ts:372, `getKrTtm` = opendart.ts:431, `loadKrTtmDetail` = opendart.ts:633.
LTM 손익 구성식(공통): `최근 사업연도 + 당기 누적 − 당기 보고서의 전기 누적`(opendart.ts:512~535). 3~5월(사업보고서 뒤·1분기 전)엔 사업연도 그대로(opendart.ts:457~483).

## 1. 하이라이트 (src/lib/markets/kr/dart-highlights.ts)

열: 사업연도(FY, 결산 12-31 고정 표기 :91) + 현재/LTM + 추정 1개년(네이버 컨센서스, :95~96).
**금융 레이아웃: 행 없음** — 한국은 금융업 전용 하이라이트가 없다. 금융업은 같은 일반 레이아웃에 EV·EV/EBITDA 공란(blocker "financial", :320, dart-ev.ts:174~178 — 예수부채·보험계약부채·책임준비금 계정이 있으면).

| 행 키 | 표시 이름 | 한국 산식 | 원천(파일:줄) | 메모 |
|---|---|---|---|---|
| mktcap | 시가총액 (보통주) | FY: KRX 연말(마지막 거래일) MKTCAP 보통주 = 그날 상장주식수×종가. 없으면 연말 종가×**현재** 상장주식수 근사(⚠주석). LTM: 현재 KRX MKTCAP(currentMarketCap) → caps.current.common. 추정열 null | dart-highlights.ts:128~138; dart-ev.ts:445~464 loadKrCaps→quote/krx.ts fetchKrxCapsOn(MKTCAP); highlights/route.ts:110~111 | 주식수 = KRX 상장주식수(LIST_SHRS, 자기주식 **포함**, quote/krx.ts:327). 어긋남 6 확인 — 유통주식수 아님. 근사 근거: 오너 결정 2026-10-04 "근사 + ⚠ 표시"(:134) |
| pref_mcap | + 우선주 시가총액 | KRX 우선주 자체 시세 MKTCAP 합(연말/현재). 값이 있는 회사만 행 노출 | dart-highlights.ts:139~141,231~233; dart-ev.ts:457 | 한국만. CLAUDE.md "우선주는 포함한다" |
| cash | − 현금성자산 | 현금및현금성자산+단기금융상품+단기투자자산(증권)+단기금융자산+유동 상각후원가·FVPL 금융자산. "기타(유동)금융자산"은 그 기간 자기 보고서가 단기예치금 ID 를 단 경우만 포함. LTM = 손익 TTM 마지막 분기말(krLtmBalance) | dart-ev.ts:116~140(CASH_ID·CASH_NAME·cashIn), :298 sumLines; LTM :398~401 | 미국과 정의 다름(장기 채권형 증권 없음 — 어긋남 7). 근거: CLAUDE.md B16(네이버 WiseReport 정의) |
| debt | + 총차입금 (리스부채 포함) | 차입금·사채·리스부채(DEBT_ID/DEBT_NAME) 합. 차입금 줄이 없을 때만 "(유동|비유동|단기|장기)금융부채". 본표 리스 줄 없는 해 = 주석 판정(krLeaseFor) 가산, 확인 불가면 EV 공란 | dart-ev.ts:70~112, 201~222, 291~323(bridgeAt :314) | 리스 포함 = 미국과 반대(근거 CLAUDE.md, dart-ev.ts:62~64 IFRS16). **차입금 줄이 하나도 없고 현금 줄만 있는 해는 차입금 0**(:310~316 `debt.get(year) ?? 0`, LTM :415) — "순차입금 한쪽만" 건 원천 |
| nci | + 비지배지분 | ifrs-full_NoncontrollingInterests / "비지배지분". 0 아닌 값이 있는 회사만 행 노출 | dart-ev.ts:142~143,219,299 | 미국은 pref_nci(우선주+비지배) 한 행 |
| ev | 기업가치 (EV) | 보통주 시총 + 우선주 시총 + 총차입금 + 비지배지분 − 현금성자산. 금융업·현대차(005380 captive-unsplit)·KRX 조회 실패·리스 확인 불가면 공란. LTM = 현재 시총 + 분기말 브릿지 | dart-ev.ts:327~345, 186; dart-highlights.ts:156~166 | 금융업·금융 자회사 공란 = 오너 결정(2026-10-11)로 **미국 규칙으로 바꿀 대상**(코드 미반영) |
| revenue | 매출액 | FY: ifrs-full_Revenue / dart_Revenue / "매출액·수익(매출액)·영업수익". LTM: ttm.revenue. 추정: 네이버 매출액 컨센서스(억원×1e8) | dart-highlights.ts:18,101,172~174; opendart.ts:304,335 | 추정 원천 = 네이버(FnGuide) — 미국은 Yahoo |
| revenue_yoy | 성장률 % YoY | (당열−앞열)/\|앞열\|. 첫 FY 열은 그 전년도 연간값(src)으로. LTM 열 = LTM vs 최근 FY 열, 추정열 = 추정 vs LTM | dart-highlights.ts:213~219,242 | LTM·추정 YoY 의 비교 대상이 "앞 열"이라 같은 기간 전년이 아님(전 시장 공통 구조인지 미확인) |
| opinc | 영업이익 | FY: dart_OperatingIncomeLoss → ifrs-full_ProfitLossFromOperatingActivities → "영업이익"(krOpIncomeByYear). LTM ttm.opIncome. 추정 네이버 | dart-ev.ts:582~589; dart-highlights.ts:175~177 | 미국 하이라이트에는 행 없음 |
| opinc_m | 마진 % | 영업이익/매출×100(매출 0 이면 빈칸) | dart-highlights.ts:75~76,244 | |
| ebitda | EBITDA | 영업이익 + 감가상각비(daAndAmortSeries: 손익계산서 본표 감가상각 줄 → 사업보고서 주석 적재본(영업비용 기준 감가+무형) → DART 현금흐름 감가 줄 → 빈칸). LTM = 손익 TTM 과 같은 구성의 주석 감가상각 TTM 만, 없으면 빈칸 | dart-facts.ts:1063~1136; dart-highlights.ts:222~227 | 정의: 영업비용 기준(CLAUDE.md 2026-10-02 오너 결정). 중단영업 처리 있음(적재 스크립트) |
| ebitda_m | 마진 % | EBITDA/매출×100 | dart-highlights.ts:246 | |
| ni | 순이익 | FY: **ifrs-full_ProfitLoss**(당기순이익, 비지배 포함). LTM ttm.netIncome(같은 ProfitLoss, opendart.ts:334). 추정: 네이버 당기순이익 컨센서스 → 없으면 추정 EPS×현재 상장주식수 | dart-highlights.ts:19,103,178~187 | **어긋남 2 확인**: 지배주주 순이익 아님. 추정열 순이익은 네이버 "당기순이익" 정의(지배/전체) 미확인 |
| ni_m | 마진 % | ProfitLoss/매출×100 | dart-highlights.ts:248 | 분자 비지배 포함 |
| eps | EPS (희석) | FY: krEpsByYear = 희석 전체 EPS → 없으면 기본 → 전체 미공시면 계속+중단 주당이익 합(칸 주석). LTM ttm.eps. 추정 네이버 EPS | dart-ev.ts:505~575; dart-highlights.ts:188~192,249~262 | 라벨은 "희석"이지만 기본 EPS 대체 있음. LTM 근사는 아래 개요 PER(TTM) 행 참고 |
| eps_yoy | 성장률 % YoY | revenue_yoy 와 같은 seq | dart-highlights.ts:263 | |
| dps | DPS | FY: DART alotMatter 보통주 주당 현금배당금(무배당=0). LTM: 공공데이터 배당기준일 최근 12개월 합 → 없으면 최근 FY 값(주석). 추정 null | dart-facts.ts:815~866; rights-schedule.ts:106~158; dart-highlights.ts:195~199 | LTM 연간값 대체(사유 표기) |
| divyield | 배당수익률 % | DPS / 그 열 주가(FY=KRX 연말 종가, LTM=현재가)×100 | dart-highlights.ts:200 | |
| ocf | 영업활동 현금흐름 | ifrs-full_CashFlowsFromUsedInOperatingActivities. LTM ttm.krLtm.ocf(같은 TTM 식, 전기 누적은 분기 XBRL 정정본) | dart-highlights.ts:20,204~206; opendart.ts:565~602 | LTM 없으면 빈칸(연간 대체 안 함, :203) |
| capex | 자본지출 | −\|유형자산의 취득\|(ifrs-full_PurchaseOfPropertyPlantAndEquipment…). 무형자산 취득 미포함 | dart-highlights.ts:21,207~210 | 무형 취득 제외가 미국·일본과 같은지 미확인 |
| fcf | 잉여현금흐름 | OCF + capex(음수) | dart-highlights.ts:211 | |
| per | PER | 그 열 주가 / EPS(분모 ≤0 빈칸). FY 주가 = KRX 연말 실제 종가(미보정). 추정 = 네이버 estPer → 없으면 현재가/추정 EPS | dart-highlights.ts:117~125,272~275 | **어긋남 8**: 코드 주석(:122)은 "DART EPS 는 당시 기준"이라 하나 로더는 그 해를 담은 **가장 최근 보고서**(재작성본, dart-facts.ts:309~312)를 쓴다 → 분할을 소급 재작성한 해는 미보정 종가 ÷ 보정 EPS 로 어긋날 수 있음(실측 미확인) |
| pbr | PBR | 시가총액(보통주) / **지배주주 자본**(EquityAttributableToOwnersOfParent, 없으면 자본총계). LTM 자본 = 분기말 지배주주 자본. 추정 = 네이버 estPbr | dart-ev.ts:486~498; dart-highlights.ts:276~279 | 분자에 우선주 시총 미포함(미국·일본 확인 필요) |
| psr | PSR | 시가총액/매출. 추정열 = 현재 시총/추정 매출 | dart-highlights.ts:282~285 | |
| ev_ebitda | EV/EBITDA | EV/EBITDA(분모 ≤0 빈칸), 추정열 없음 | dart-highlights.ts:286 | |

## 2. 재무분석 (src/lib/markets/kr/dart-analysis.ts) — 45행

열: 최근 사업연도들 + 현재/LTM. LTM 규칙(:114~179): 매출·영업이익·순이익·EPS = TTM(없으면 빈칸, mapTtm); 매출총이익·세전·법인세·현금흐름 = ttm.krLtm(손익 TTM 이 분기 조합일 때, 없으면 빈칸); 재무상태표 = 손익 TTM 마지막 분기말(분기 facts), 분기값 하나라도 없으면 빈칸. TTM 이 사업연도면 LTM = 최근 FY.
계정 정의 KR_ANALYSIS_ACCOUNTS(:17~41). **자본(equity) = ifrs-full_Equity "자본총계"**(:27), 순이익 = ifrs-full_ProfitLoss(:22).
평균잔액 = (기말+기초)/2, 기초 없으면 빈칸; LTM = (분기말+1년 전 같은 분기말)/2(:207~224).

| 섹션 / 표시 이름 (accountId = `an:{이름}`) | 한국 산식 | 원천(줄) | 메모 |
|---|---|---|---|
| 밸류 / PER | 주가/EPS(>0). FY 주가 = KRX 연말 종가, LTM = 현재가 & ttm.eps | :269~272,341 | = PER(TTM) in LTM. 어긋남 8 동일 |
| 밸류 / PBR | 시가총액/**지배주주 자본**(>0). LTM = 현재 시총/분기말 지배주주 자본 | :343~345 | 같은 화면 ROE·레버리지는 자본총계(혼재) |
| 밸류 / PSR | 시가총액/매출(>0) | :346 | |
| 밸류 / EV/EBITDA | 하이라이트와 같은 EV(krEv / krEvFromBridge) / EBITDA(>0) | :347~356 | |
| 밸류 / PEG (EPS 3Y CAGR) | PER / EPS 3년 CAGR(%) — PER>0·CAGR≥1 일 때만 | :359~364 | |
| 수익성 / ROE (%) | **ProfitLoss / 평균 자본총계**×100 | :367 | **어긋남 2 확인**(분자·분모 모두 비지배 포함). 미국은 지배주주 |
| 수익성 / 순이익률 (%) | ProfitLoss/매출 | :368 | 어긋남 2 |
| 수익성 / × 총자산회전율 | 매출/평균 총자산 | :369 | |
| 수익성 / × 재무레버리지 | 평균 총자산/**평균 자본총계** | :370 | 어긋남 2(분모 자본총계) |
| 수익성 / ROA (%) | ProfitLoss/평균 총자산 | :371 | |
| 수익성 / ROIC (%) | NOPAT/평균 투하자본. NOPAT = 영업이익×(1−clamp(법인세/세전,0,0.4)); 투하자본 = 평균 총자산 − (평균 유동부채 − 평균 유동 차입금). 유효세율 못 구하면 빈칸 | :372~384; 유동 차입금 dart-ev.ts:229~252 | 미국과 같은 정의라 주석(2026-10-02). 유동/비유동 판정 못 하는 차입금 줄이 있으면 그 해 빈칸 |
| 수익성 / FCF 마진 (%) | FCF/매출 | :385 | FCF = OCF − \|유형자산 취득\| |
| 수익성 / 매출총이익률 (%) | 매출총이익(ifrs-full_GrossProfit)/매출 | :386 | 매출총이익 줄 없는 회사 빈칸 |
| 수익성 / 영업이익률 (%) | 영업이익/매출 | :387 | |
| 수익성 / 유효세율 (%) | 법인세비용/세전이익 | :388 | |
| 현금창출 / 영업현금흐름 / 순이익 | OCF/ProfitLoss | :472 | 분모 비지배 포함 |
| 현금창출 / 주당 FCF | FCF/주식수. FY = KRX 연말 MKTCAP÷연말 종가(그날 상장주식수), LTM = 현재 상장주식수 | :473~489 | 상장주식수(자기주식 포함) |
| 레버리지 / 부채비율 (%) | 부채총계/**자본총계**(기말) | :391 | 어긋남 2 |
| 레버리지 / 총차입금 / 자기자본 (%) | 총차입금(리스 포함)/자본총계(기말) | :392 | 어긋남 2 |
| 레버리지 / 총차입금 / 총자산 (%) | 총차입금/자산총계 | :393 | |
| 레버리지 / 순차입금 / 자기자본 (%) | (총차입금−현금성자산)/자본총계 | :196~197,394 | 순차입금: debt·cash 중 하나라도 있으면 계산, 없는 쪽 0(:197). 단 브릿지는 bridgeAt 단계에서 이미 둘 다 숫자(:314~316 — 없는 쪽 0) → 사실상 "한쪽만 있어도 계산"의 원천은 dart-ev.ts |
| 건전성 / 총차입금 / EBITDA | 총차입금/EBITDA(>0) | :397 | |
| 건전성 / 순차입금 / EBITDA | 순차입금/EBITDA(>0) | :398 | |
| 건전성 / 영업이익 / 총차입금 | 영업이익/총차입금 | :399 | |
| 건전성 / 이자보상배율 (EBIT/이자) | 영업이익/\|이자의 지급\|(CF, 현금 기준) | :39,178,400 | 미국은 발생주의 이자비용(인수인계 추가 항목). 근거 주석 없음(:10 "이자비용 = CF '이자의 지급'"만) |
| 건전성 / CFO / 총차입금 | OCF/총차입금 | :401 | |
| 건전성 / FCF / 총차입금 | FCF/총차입금 | :402 | |
| 건전성 / 알트만 Z-스코어 | 1.2·운전자본/자산 + 1.4·이익잉여금/자산 + 3.3·영업이익/자산 + 0.6·**보통주 시총**/부채총계 + 1.0·매출/자산 | :405~415 | 시총에 우선주 미포함. 표시 형식 "pct"(:504) |
| 유동성 / 유동비율 | 유동자산/유동부채 | :418 | |
| 유동성 / 당좌비율 | (현금+단기금융상품+매출채권)/유동부채, 빠진 항목 0 | :419~424 | 재고 차감식 아님 |
| 유동성 / 현금비율 | (현금+단기금융상품)/유동부채 | :425~429 | EV 현금성자산과 범위 다름 |
| 유동성 / CFO / 유동부채 | OCF/평균 유동부채 | :430 | |
| 운전자본 / DSO | 평균 매출채권/매출×365 | :433 | |
| 운전자본 / DIO | 평균 재고/\|매출−매출총이익\|×365 | :434~442 | 원가 = 매출−매출총이익 |
| 운전자본 / DPO | 평균 매입채무/원가×365 | :443 | |
| 운전자본 / CCC | DSO+DIO−DPO | :444~446 | |
| 주주환원 / 배당성향 (%) | \|배당금의 지급(CF)\|/ProfitLoss | :40,449 | 어긋남 2(분모). 분자도 비지배 배당 포함 가능(ifrs-full_DividendsPaidClassifiedAsFinancingActivities — 미확인) |
| YoY / 매출액 | 연도: 전년 대비. LTM: (TTM − 최근 FY)/\|최근 FY\| | :305~318,522 | LTM 은 같은 기간 전년이 아니라 최근 FY 대비 |
| YoY / 영업이익 | 같음(TTM) | :523 | |
| YoY / 순이익 | 같음(ProfitLoss) | :524 | |
| YoY / 희석 EPS | 같음 | :525 | |
| YoY / 영업활동 현금흐름 | 연도만, LTM 빈칸(ltm 미전달) | :526 | |
| YoY / 잉여현금흐름 | 연도만, LTM 빈칸 | :527,563~570 | |
| CAGR / 매출액 | 연도: (y/(y−3))^(1/3)−1(둘 다 >0). LTM: cur = TTM **없으면 최근 FY 값**, base = 최근FY−2 | :319~332,530 | **어긋남 4 확인**(:328 사업연도값 대체). 추가: base 가 lastY+1−n(=lastY−2)이라 TTM 대체 시 2년 구간에 1/3 지수 — 과소 산출(새 발견) |
| CAGR / EPS | 같음(eps0, ttm.eps) | :531 | 같음 |

## 3. 개요 11행 (src/components/stock-analysis.tsx — 한국)

한국 멀티플 = computeTrailingMultiples 한국 분기(multiples.ts:221~463), 입력 = TTM 스냅샷(loadKrTtmDetail)만. TTM 실패면 전부 빈칸+사유(multiples.ts:231~236).

| 행 | 한국 산식 | 원천 | 메모 |
|---|---|---|---|
| 시가총액 | quote.marketCap(KRX MKTCAP = 현재가×상장주식수) → 없으면 price×shares | multiples.ts:343~346; quote/index.ts:209~228; stock-analysis.tsx:692~701 | 자기주식 포함(어긋남 6). 아래 외국인지분율(네이버) 부기 :709~713 |
| PER | 현재가 / 최근 사업연도 EPS(ttm.fyEps = krEpsByYear 최근 해), >0 | multiples.ts:239,352; opendart.ts:752~755 | |
| PER(TTM) | 현재가 / ttm.eps(>0) | stock-analysis.tsx:460~463 | ttm.eps: 전체 EPS TTM, 분기 EPS 공시 없으면 **TTM 순이익 ÷ (연간 ProfitLoss ÷ 연간 EPS)** 근사(opendart.ts:543~561) — **어긋남 3**(주당값 흐름식). 새 발견: 환산 주식수 분자가 비지배 포함 ProfitLoss, 분모 EPS 는 지배주주 기준 → 비지배 큰 회사는 주식수·EPS 왜곡. TTM 항목 매칭 실패 시 최근 FY 값 대체(opendart.ts:688~716, 사유 표기) — **어긋남 4** |
| 추정PER | 네이버(FnGuide) 당해 추정 PER → 없으면 현재가/추정 EPS(>0) | stock-analysis.tsx:478~482; naver.ts:90~131 | 미국 = Yahoo **차년도** forward. 한국 = 당해(코멘트 :472~473) — 정의 다름 |
| PBR | price / BPS (= 현재가×상장주식수 / 분기말 지배주주 자본) | multiples.ts:281,362~367 | 분모 지배주주 자본 |
| EV/EBITDA (EV/EBIT 라벨) | EV = 현재가×상장주식수 + 우선주 시총(현재) + evNetDebt(분기말 차입금+비지배−현금). EBITDA = ttm.opIncome + ttm.daTtm(없으면 빈칸). EBITDA>0 | multiples.ts:380~407; opendart.ts:756~767 | daTtm 없으면 라벨 "EV/EBIT"이 되나 값은 빈칸(:407, stock-analysis.tsx:505). 금융업·005380 공란 |
| BPS | 분기말 지배주주 자본 / **상장주식수**(자기주식 포함) | multiples.ts:338,362~364 | DART 연결 ADR 만 유통주식수(:357~360) |
| DPS | DART alotMatter 최근 사업연도 보통주 DPS | ttm/route.ts:64~87 | |
| DPS(TTM) | 공공데이터 배당기준일 최근 12개월 합 → 없으면 최근 FY DPS(basis "fy") | ttm/route.ts:59~63,81~85; rights-schedule.ts:142~158 | 연간 대체 |
| 배당수익률 | DPS(TTM)/현재가 | stock-analysis.tsx:493 | |
| PSR | 시가총액 / ttm.revenue | multiples.ts:370~372 | |

(그 외 개요 상단 Stat: 52주 베타(KOSPI 52주 일간 → Yahoo 5년 월간 폴백), 52주 최고/최저, 목표주가(Yahoo) — 11행 밖. 요약 칩 7종은 재무분석 LTM 값을 그대로(stock-analysis.tsx:827~838).)

## 4. 유니버스 통합 뷰 (src/components/universe-overview.tsx + src/lib/universe/overview.ts)

한국 = computeKrOverviewMetrics(overview-metrics.ts) — TTM(getKrTtm)만, 없으면 빈칸+경고(:46~56).

| 칸 | 한국 산식 | 원천 | 메모 |
|---|---|---|---|
| 종가 | getEodQuote last(KRX→Stooq→Yahoo 폴백) | overview-metrics.ts:42; overview.ts:102 | |
| 등락 | quote.changePct | overview.ts:103 | |
| 시가총액 | quote.marketCap(KRX MKTCAP) → price×shares | overview-metrics.ts:44 | 어긋남 6 |
| 외국인지분율 | 네이버 m.stock integration dealTrendInfos[0].foreignerHoldRatio → totalInfos foreignRate | naver.ts:43~64; overview.ts:65,119 | **한국만**(universe-overview.tsx:77~78) |
| 매출액 | ttm.revenue | overview-metrics.ts:51 | |
| 영업이익률 | ttm.opIncome/ttm.revenue | :61 | |
| 순이익률 | ttm.netIncome(ProfitLoss)/ttm.revenue | :62 | 어긋남 2 |
| PER(TTM) | price/ttm.eps(>0) | :59 | 어긋남 3·4 동일 |
| PER(Fwd) | 네이버 당해 추정 PER | overview.ts:107~110 | 미국은 Yahoo forwardPer(차기). 정의 다름 |
| 목표주가 | **Yahoo** targetMeanPrice(fetchForwardConsensus) | overview.ts:113; service.ts:110~114 | 네이버 targetMean 은 받지만 안 씀(naver.ts:127) |
| 투자의견 | Yahoo recommendationKey | overview.ts:114 | 네이버 recommMean 미사용 |

(서버는 pbr = 시가총액/분기말 지배주주 자본도 계산하지만 화면 칸 없음 — overview-metrics.ts:60.)

## 5. 컨센서스 (src/lib/markets/consensus.ts 한국 경로, src/components/consensus-panel.tsx)

**화면에 그려지는 것**(consensus-panel.tsx:60~216): 매출·EPS 추이 차트(실적+추정), EPS 컨센서스 추이 표, EPS 어닝 서프라이즈 표. API 행의 bps·per·pbr·roe·evEbitda·opIncome·netIncome·revenueYoY 는 **이 패널에서 표시하지 않음**(kr/app 기준 — 다른 소비처: 검증기 verify-row 등은 미확인).

| 지표 | 한국 산식 | 원천 | 메모 |
|---|---|---|---|
| 차트 매출액(실적) | 연간 재무제표 표(adapter.getFinancials → rowsToStatement, account_nm) 이름 매칭 "매출액·수익(매출액)·매출·영업수익" | consensus.ts:60~66,109~127,415; opendart.ts:186~279 | 하이라이트(dart-facts ID 우선, 최신 보고서)와 원천 경로 다름 — rowsToStatement 는 연도별 first-wins(:229) |
| 차트 매출액(추정) | Yahoo earningsTrend revenueAvg | consensus.ts:576~597 | 하이라이트 추정열은 네이버 — 화면 간 원천 다름 |
| 차트 EPS(실적) | krEpsByYear(하이라이트와 같음) | consensus.ts:363,476~477 | |
| 차트 EPS(추정) | Yahoo epsAvg | :580 | |
| EPS 추이: 당해/차년 EPS(E) | Yahoo epsTrend current·7d·30d·90d | :623~641 | |
| EPS 추이: 당해/차년 PER(E) | 현재가/EPS(E) — **부호 규칙 없음**(e 가 0 아니면 음수도) | :632 | 인수인계 "PER(E) 부호 규칙 없음" 확인(줄은 :632, 추정 행 per :581 도 같음) |
| 서프라이즈: 컨센서스·실제·서프라이즈 | Yahoo surprises 최근 4 | :652 | |
| (API만) opIncome | krOpIncomeByYear | :422~423 | |
| (API만) netIncome | 표 이름 매칭: 지배주주 순이익 이름 우선 → "당기순이익" 등 전체 | :71~81,426~430 | 하이라이트(ProfitLoss)와 정의 다를 수 있음 |
| (API만) bps | 지배주주 자본 / **현재 상장주식수**(모든 과거 연도) | :225~227,449~455,480~481 | 과거 연도에 현재 주식수 — PBR(KRX 연말 시총 기준)과 기준 불일치 |
| (API만) per | KRX 연말 종가/EPS(>0) | :491~494,511 | |
| (API만) pbr | KRX 연말 보통주 시총(없으면 연말 종가×현재 주식수) / 지배주주 자본(>0) | :510~515 | |
| (API만) roe | 순이익(표 이름 매칭)/**기말** 지배주주 자본 ×100, ±100% 초과 숨김 | :517~519 | 재무분석 ROE(ProfitLoss/평균 자본총계)와 분자·분모·기말/평균 모두 다름 |
| (API만) evEbitda | krEv(연말 caps 보통주 시총, 없으면 연말 종가×현재 주식수 — capsError 면 공란) / (영업이익+감가상각) | :534~540 | |

## 인수인계 어긋남 대조(한국 해당분)

- 2번 확인: 순이익 = ifrs-full_ProfitLoss(dart-highlights.ts:19, dart-analysis.ts:22, opendart.ts:334); ROE·재무레버리지·부채비율·차입금/자본·순차입금/자본 분모 = 자본총계(dart-analysis.ts:27,225,367,370,391~394). PBR 만 지배주주.
- 3번 확인: opendart.ts:543~561(인수인계 512~559). 추가로 환산 주식수 = ProfitLoss/EPS 라 비지배 혼입.
- 4번 확인: opendart.ts:526~529(분기 누적 없음→연간), :688~716(fyLast 채움), dart-analysis.ts:328(CAGR LTM). 추가로 CAGR LTM base 연도 오프셋(lastY−2 에 1/3 지수).
- 6번: 시가총액·BPS·주당 FCF 주식수 = KRX 상장주식수(자기주식 포함). 유통주식수(fetchKrDistributedShares, dart-facts.ts:875)는 DART 연결 ADR 에만 사용.
- 8번: 코드상 불일치 가능(로더 최신 판본 EPS vs KRX 미보정 연말 종가), 주석(dart-highlights.ts:122)과 로더 동작이 상충. 실측 미확인.
- 순차입금 한쪽만: dart-ev.ts:310~316(연간)·:414~417(LTM) — 차입금 줄 없으면 0, 현금 줄 없으면 0. dart-analysis.ts:197 도 같은 규칙.

## 한국만의 특이 규칙

1. 우선주 시가총액을 EV 에 별도 행으로 가산(pref_mcap, KRX 우선주 자체 시세) — PBR·PSR·알트만 Z 분자에는 미포함.
2. 리스부채를 총차입금에 포함(IFRS 16, dart-ev.ts:62~64); 본표에 리스 줄 없으면 주석 판정, 확인 불가면 EV 공란.
3. 현금성자산 = 네이버 WiseReport 정의(B16), "기타(유동)금융자산"은 그 기간 보고서 단기예치금 태그일 때만.
4. 차입금 줄 대신 "(유동|비유동)금융부채"만 공시하는 회사(한전·HD현대) 대체.
5. 금융업 판정 = 예수부채·보험계약부채·책임준비금 계정 존재(dart-ev.ts:174~178), 금융 자회사 = 하드코딩 005380(dart-ev.ts:186).
6. 시가총액 = KRX MKTCAP(상장주식수, 자기주식 포함), 과거 연도는 KRX 연말 실측, 실패 시 연말 종가×현재 주식수 근사(⚠).
7. LTM 손익 = 최근 사업연도 + 당기 누적 − 당기 보고서 전기 누적(정정본, 오너 2026-10-10); 3~5월은 사업연도 그대로; 현금흐름 전기 누적은 분기 XBRL 대조 후만.
8. EPS = 전체 EPS, 미공시면 계속+중단 주당이익 합; 희석 없으면 기본.
9. 감가상각 = 영업비용 기준(성격별 비용 주석·본표 감가 줄), 적재본은 유니버스 종목만, 없으면 DART 현금흐름 감가 줄, 그것도 없으면 빈칸.
10. 추정 열(하이라이트)·추정PER·유니버스 PER(Fwd) = 네이버(FnGuide) 당해 컨센서스. 컨센서스 패널 추정·목표주가·투자의견은 Yahoo.
11. 이자보상배율 분모 = 현금 이자지급(CF).
12. DPS = DART alotMatter(무배당 0), DPS(TTM) = 공공데이터 배당기준일 12개월 합.
13. 연결 재무제표 없는 해는 별도 재무제표(ofsYears 주석).
14. 연도 열 결산일 표기를 12-31 고정(dart-highlights.ts:91, dart-analysis.ts:542) — 12월 결산 외 회사 미대응.
