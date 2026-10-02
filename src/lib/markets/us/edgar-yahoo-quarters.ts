import "server-only";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { YahooFundamentalsRow } from "../quote/yahoo";
import { DA_TOTAL, SYN_DA_CF, daAnnualByYear, resolveDebt } from "./edgar-ev";
import { SYN_DEBT_FACE, SYN_DEBT_FACE_NONCURRENT } from "./edgar-bs-structure";
import { fiscalYearOf, instantOn } from "./edgar-series";
import { ifrsSourcesOf } from "./edgar-foreign";
import { sixKValueOf, type SixKStatements } from "./edgar-6k";

/**
 * **20-F 발행사 LTM 열 = Yahoo 분기(원통화) 최근 4개 분기** (오너 결정 2026-09-25 — Yahoo·인포맥스 분기 구성 비교 후.
 * 인포맥스는 검증 도구의 대조 원천으로만 쓴다).
 *
 * 20-F 발행사(TSM·ASML·SPOT 등)는 SEC 에 분기 XBRL 이 없어 LTM 이 최근 사업연도(FY)에 머문다. 예전 인포맥스 경로는
 * 매출·영업이익·순이익·감가상각비만 최근 4개 분기로 바꾸고 나머지(매출원가·세전이익·법인세·현금흐름·재무상태표)는 FY 로
 * 남겨, 한 LTM 열 안에서 기간이 섞였다(TSM 매출총이익률 51.39% < 영업이익률 55.84%, 독립 감사 2026-09-25).
 *
 * 원칙 — LTM 열 안에서 원천·기간이 하나:
 *  - 흐름 = Yahoo 최근 4개 분기 합. 분기마다 **그 분기 평균 환율**(앱 공통 환율 규칙 — 연준 H.10, edgar-foreign.ts fxToUsd)로 USD 환산.
 *  - 잔액 = Yahoo 최신 분기말 값 × 기말 환율. 평균 잔액용으로 1년 전 분기말 값도 넣는다(있을 때).
 *  - 항목마다 **연간 경계 확인**: Yahoo 연간(SEC FY 말일) = SEC FY(원통화, 공시 단위 안). 다르면 정의가 다른 것 — 그 항목만
 *    LTM 공란(FY 값 유지·다른 원천 혼합 금지). 최근 4개 분기 중 하나라도 결측이어도 공란.
 *  - 매핑하지 않은 흐름 개념은 최근 FY 항목에 `ltmNone` 을 달아 LTM 이 비게 한다(edgar-series.ttmCombine). 매핑하지 않은
 *    잔액 개념은 소비 모듈이 LTM 기준일(balanceDate)의 값만 읽어 자연히 빈다.
 *  - EV 구성요소(차입금·현금·단기투자·장기투자증권·비지배지분·우선주) 중 SEC FY 말에 있는 것이 하나라도 Yahoo 로 같은
 *    기준일 값을 못 채우면 evComplete = false — 소비 모듈이 LTM EV·순차입금을 비운다(FY말 잔액과 최신 분기 흐름을 섞지 않음).
 *    비지배지분·우선주가 SEC FY 말에 아예 없으면(해당 없음) 0 으로 본다 — ASML·SPOT 처럼 없는 회사의 EV 를 비울 이유가 없다.
 *
 * 구현 — LTM 조합(edgar-series.ttmCombine: FY + 당기누적 − 전년동기누적)에 LTM 전용 값(ltmQ)을 넣는다:
 *   FY.ltmQ = 꼬리 분기(최근 4개 분기 중 FY 안) 합 + 전년동기, 당기누적 = FY 이후 분기 합, 전년동기 = Yahoo 연간 − 꼬리 분기
 *   → 조합 = 최근 4개 분기 합(항등식). 연도 열 값(val)은 SEC 그대로.
 */

export const YAHOO_Q_FORM = "YAHOO-Q";

export type YahooLtmResult =
  | {
      source: "yahoo";
      /** 최신 분기말(흐름 기간 끝 = 잔액 기준일) */
      through: string;
      currency: string;
      /** 채운 항목 */
      filled: string[];
      /** 비운 항목과 사유 */
      blanked: { label: string; reason: string }[];
      /** SEC 연말 값 + Yahoo 분기 변동분으로 채운 EV 구성요소(Yahoo 연말 값이 SEC 와 정의가 조금 달라 그대로 못 쓴 것 — 오너 결정 2026-10-01 (가)) */
      approx?: { label: string; reason: string }[];
      /** 회사 6-K 분기 재무제표(연결재무보고서)에서 읽은 항목 — 야후 정의가 SEC 와 달라 못 쓴 항목을 회사 공시 줄로(2026-10-02) */
      sixK?: { label: string; reason: string }[];
      /** LTM EV·순차입금을 같은 기준일로 계산할 수 있는지 */
      evComplete: boolean;
      evReason: string | null;
    }
  | {
      source: "none";
      reason: string;
      /**
       * true = LTM 열 공란(사업연도 값을 LTM 으로 대체하지 않음) — H.10 공식 환율 미고시·조회 실패(오너·리드 결정 2026-09-27, fin 과 같은 규칙).
       * 흐름 개념 최근 FY 에 ltmNone 을 달고, 화면 라우트는 LTM 열 전체를 비운다(sec-unavailable.ts blankLtm…)
       */
      ltmBlank?: true;
    };

type Units = Record<string, FactUnitEntry[]>;
type Ns = Record<string, { label?: string; description?: string; units: Units }>;
/** 환율(연준 H.10 — edgar-foreign.ts fxToUsd). why(end) = 값이 없을 때 사유(H.10 미고시) */
type Fx = { avg(start: string, end: string): number | null; at(date: string): number | null; why?(end: string): string | null };

const DAY = 864e5;
const span = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / DAY;
const addDay = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const monthEndShift = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + n + 1, 0)).toISOString().slice(0, 10);
};
const isMonthEnd = (d: string) => monthEndShift(d, 0) === d;
const isAnnualE = (e: FactUnitEntry) =>
  !!e.start && /^(20-F|10-K)/.test(e.form) && e.fp === "FY" && span(e.start, e.end) > 300 && span(e.start, e.end) < 400;

/**
 * SEC 최근 사업연도 판정 기준 개념. 매출은 여기서 다루지 않는다 — 20-F 매출 LTM 은 재무 5층 구조(src/lib/fin
 * read/ltm-yahoo.ts)가 같은 규칙으로 따로 만든다(docs/metrics/revenue.md §2, 매출 태그 직접 사용 금지).
 */
const FY_ANCHOR = ["NetIncomeLoss", "ProfitLoss"];
const PRETAX = [
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesAndExtraordinaryItemsNoncontrollingInterest",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndEquityMethodInvestments",
];
const INTEREST = ["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt", "InterestAndDebtExpense"];

/** 흐름 항목 — Yahoo 필드 → us-gaap 개념(외화·IFRS 정규화 후). sign: SEC 부호 = sign × Yahoo */
/** Yahoo 필드 — 배열이면 그 필드들의 합(하나라도 없으면 없음) */
type YKey = string | string[];
const yv = (rec: Record<string, number> | undefined, k: YKey): number | null => {
  if (!rec) return null;
  // "a|b" = 앞 필드가 없으면 뒤 필드(ASML — 야후가 reconciledDepreciation 을 주지 않고 depreciationAndAmortization 만, 2025 = SEC 1,025.9 백만 EUR)
  if (typeof k === "string") return k.includes("|") ? (k.split("|").map((x) => rec[x]).find((x) => x != null) ?? null) : (rec[k] ?? null);
  let t = 0;
  for (const x of k) { if (rec[x] == null) return null; t += rec[x]; }
  return t;
};
const FLOWS: { label: string; y: YKey; concepts: string[]; sign?: 1 | -1; da?: true }[] = [
  // 매출원가·매출총이익·판관비·연구개발비는 여기서 다루지 않는다 — 20-F LTM 도 재무 5층 구조(src/lib/fin read/ltm-yahoo.ts)가 같은 규칙
  // (줄마다 Yahoo 분기 × 분기 평균 환율, 연간 경계 확인)으로 만든다(docs/metrics/cogs.md §2·sga.md §2, 태그 직접 사용 금지)
  // Yahoo operatingIncome 은 정규화 값(TSM FY2025 1,936,095.6백만 TWD) — 공시값은 totalOperatingIncomeAsReported(1,936,091.7 = SEC)
  { label: "영업이익", y: "totalOperatingIncomeAsReported", concepts: ["OperatingIncomeLoss"] },
  { label: "이자비용", y: "interestExpense", concepts: INTEREST },
  { label: "세전이익", y: "pretaxIncome", concepts: PRETAX },
  { label: "법인세", y: "taxProvision", concepts: ["IncomeTaxExpenseBenefit"] },
  { label: "순이익", y: "netIncome", concepts: ["NetIncomeLoss"] },
  { label: "보통주 귀속 순이익", y: "netIncomeCommonStockholders", concepts: ["NetIncomeLossAvailableToCommonStockholdersBasic"] },
  { label: "연결 순이익", y: "netIncomeIncludingNoncontrollingInterests", concepts: ["ProfitLoss"] },
  { label: "감가상각비", y: "reconciledDepreciation|depreciationAndAmortization", concepts: [SYN_DA_CF, ...DA_TOTAL], da: true },
  { label: "영업활동현금흐름", y: "operatingCashFlow", concepts: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"] },
  { label: "투자활동현금흐름", y: "investingCashFlow", concepts: ["NetCashProvidedByUsedInInvestingActivities", "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations"] },
  { label: "재무활동현금흐름", y: "financingCashFlow", concepts: ["NetCashProvidedByUsedInFinancingActivities", "NetCashProvidedByUsedInFinancingActivitiesContinuingOperations"] },
  // 야후 capitalExpenditure = 유형 + 무형 취득(TSM 2025: 1,272,450.3 + 10,146.9 = 1,282,597.2 백만 TWD) — SEC 개념(유형자산 취득)과 같은 정의인 purchaseOfPPE
  { label: "CapEx", y: "purchaseOfPPE", concepts: ["PaymentsToAcquirePropertyPlantAndEquipment"], sign: -1 },
  { label: "배당금 지급", y: "cashDividendsPaid", concepts: ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock", "PaymentsOfOrdinaryDividends"], sign: -1 },
  { label: "자사주 매입", y: "repurchaseOfCapitalStock", concepts: ["PaymentsForRepurchaseOfCommonStock"], sign: -1 },
  // ── 현금흐름표 세부 줄(2026-10-02, 오너 지시 "tsm은 값넣어" — 20-F LTM 현금흐름표 줄이 거의 다 비어 있었다) ──
  { label: "주식보상비용", y: "stockBasedCompensation", concepts: ["ShareBasedCompensation"] },
  { label: "매출채권 증감", y: "changeInReceivables", concepts: ["IncreaseDecreaseInAccountsReceivable"], sign: -1 },
  { label: "재고자산 증감", y: "changeInInventory", concepts: ["IncreaseDecreaseInInventories"], sign: -1 },
  { label: "매입채무 증감", y: "changeInAccountPayable", concepts: ["IncreaseDecreaseInAccountsPayable"] },
  { label: "무형자산 취득", y: "purchaseOfIntangibles", concepts: ["PaymentsToAcquireIntangibleAssets"], sign: -1 },
  { label: "투자자산 취득", y: "purchaseOfInvestment", concepts: ["PaymentsToAcquireMarketableSecurities", "PaymentsToAcquireInvestments"], sign: -1 },
  { label: "투자자산 처분·만기", y: "saleOfInvestment", concepts: ["ProceedsFromSaleAndMaturityOfMarketableSecurities"] },
  { label: "장기차입금 조달", y: "longTermDebtIssuance", concepts: ["ProceedsFromIssuanceOfLongTermDebt"] },
  { label: "장기차입금 상환", y: "longTermDebtPayments", concepts: ["RepaymentsOfLongTermDebt"], sign: -1 },
  { label: "환율변동 효과", y: "effectOfExchangeRateChanges", concepts: ["EffectOfExchangeRateOnCashAndCashEquivalents"] },
  // SEC 순증감은 환율효과 반영 후, Yahoo changesInCash 는 반영 전 — 둘을 더한 값(TSM 2024: 615,033.3 + 47,165.9 = 662,199.2)
  { label: "현금 순증감", y: ["changesInCash", "effectOfExchangeRateChanges"], concepts: ["CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect"] },
  { label: "이자 지급액", y: "interestPaidCFF", concepts: ["InterestPaidNet"], sign: -1 },
  { label: "법인세 납부액", y: "taxesRefundPaid", concepts: ["IncomeTaxesPaidNet", "IncomeTaxesPaid"], sign: -1 },
];

/** 현금흐름표 개념 이름(6-K 현금흐름표에서 찾을 대상 — 손익 개념이 현금흐름 조정 줄과 이름이 같아 잘못 붙지 않게) */
const CF_CONCEPT = /^(PaymentsTo|PaymentsFor|PaymentsOf|Proceeds|Repayments|IncreaseDecrease|NetCash|EffectOfExchangeRate|CashCashEquivalents.*PeriodIncreaseDecrease|InterestPaid|IncomeTaxesPaid|DividendsReceived|InterestReceived|ShareBasedCompensation|OtherNoncashIncomeExpense|PaymentsForProceedsFrom)/;

/** 잔액 항목. ev: EV 구성요소 */
const STI = ["MarketableSecuritiesCurrent", "ShortTermInvestments", "AvailableForSaleSecuritiesDebtSecuritiesCurrent", "DebtSecuritiesCurrent"];
const LT_SECURITIES = ["MarketableSecuritiesNoncurrent", "AvailableForSaleSecuritiesDebtSecuritiesNoncurrent", "DebtSecuritiesNoncurrent"];
const PREFERRED = ["PreferredStockValue", "PreferredStockValueOutstanding"];
const INSTANTS: { label: string; y: YKey; concepts: string[]; ev?: true }[] = [
  { label: "자산총계", y: "totalAssets", concepts: ["Assets"] },
  { label: "부채와자본총계", y: "totalAssets", concepts: ["LiabilitiesAndStockholdersEquity"] },
  { label: "부채총계", y: "totalLiabilitiesNetMinorityInterest", concepts: ["Liabilities"] },
  { label: "지배주주 자본", y: "stockholdersEquity", concepts: ["StockholdersEquity"] },
  { label: "자본총계", y: "totalEquityGrossMinorityInterest", concepts: ["StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"] },
  { label: "비지배지분", y: "minorityInterest", concepts: ["MinorityInterest"], ev: true },
  { label: "유동자산", y: "currentAssets", concepts: ["AssetsCurrent"] },
  { label: "유동부채", y: "currentLiabilities", concepts: ["LiabilitiesCurrent"] },
  { label: "현금및현금성자산", y: "cashAndCashEquivalents", concepts: ["CashAndCashEquivalentsAtCarryingValue"], ev: true },
  { label: "단기투자", y: "otherShortTermInvestments", concepts: STI, ev: true },
  { label: "매출채권", y: "accountsReceivable", concepts: ["AccountsReceivableNetCurrent"] },
  { label: "재고자산", y: "inventory", concepts: ["InventoryNet"] },
  { label: "매입채무", y: "accountsPayable", concepts: ["AccountsPayableCurrent"] },
  // ── 재무상태표 세부 줄(2026-10-02) — 야후 연말 값이 SEC 와 정의가 조금 다르면 SEC 연말 + 야후 분기 변동분(결정 (가) 방식) ──
  { label: "유형자산", y: "netPPE", concepts: ["PropertyPlantAndEquipmentNet"] },
  { label: "장기 투자자산", y: "investmentsAndAdvances", concepts: ["LongTermInvestments"] },
  { label: "자본금·주식발행초과금", y: ["capitalStock", "additionalPaidInCapital"], concepts: ["CommonStocksIncludingAdditionalPaidInCapital"] },
  { label: "이익잉여금", y: "retainedEarnings", concepts: ["RetainedEarningsAccumulatedDeficit"] },
  { label: "기타포괄손익누계액", y: "gainsLossesNotAffectingRetainedEarnings", concepts: ["AccumulatedOtherComprehensiveIncomeLossNetOfTax"] },
  { label: "유동성 장기부채", y: "currentDebt", concepts: ["LongTermDebtCurrent"] },
  { label: "장기부채", y: "longTermDebt", concepts: ["LongTermDebtNoncurrent"] },
];

/** 공시 단위 안에서 같은가 — 단위 = SEC 원통화 값의 끝자리 0 개수(최대 10^6). 역환산 부동소수 오차만큼 여유 */
function sameInUnit(sec: number, yv: number): boolean {
  const r = Math.round(Math.abs(sec));
  let unit = 1;
  while (unit < 1e6 && r !== 0 && r % (unit * 10) === 0) unit *= 10;
  return Math.abs(sec - yv) < unit + Math.abs(sec) * 1e-9;
}

/** 흐름 개념(skip 제외)의 최근 FY 항목에 ltmNone(LTM 공란) — 제자리 수정. 주식수 단위(가중평균)는 LTM 에 안 쓴다 */
function markLtmNone(out: Ns, skip: Set<string> = new Set()): void {
  for (const [c, node] of Object.entries(out)) {
    if (skip.has(c)) continue;
    let changed = false;
    const units: Units = {};
    for (const [u, arr] of Object.entries(node.units ?? {})) {
      if (u === "shares" || u === "pure") { units[u] = arr; continue; }
      const fyEnd = arr.filter(isAnnualE).reduce((m, e) => (e.end > m ? e.end : m), "");
      if (!fyEnd) { units[u] = arr; continue; }
      units[u] = arr.map((e) => (isAnnualE(e) && e.end === fyEnd ? ((changed = true), { ...e, ltmNone: true }) : e));
    }
    if (changed) out[c] = { ...node, units };
  }
}

/**
 * LTM 열 공란(사업연도 값 대체 없음) — H.10 공식 환율 미고시·조회 실패. 흐름 개념 최근 FY 에 ltmNone, 결과에 ltmBlank(라우트가 LTM 열 전체를 비움)
 */
export function blankYahooLtm(facts: CompanyFacts, reason: string): { facts: CompanyFacts; result: YahooLtmResult } {
  const out: Ns = { ...((facts.facts["us-gaap"] ?? {}) as Ns) };
  markLtmNone(out);
  return { facts: { ...facts, facts: { ...facts.facts, "us-gaap": out } } as CompanyFacts, result: { source: "none", reason, ltmBlank: true } };
}

/**
 * LTM 기간(withYahooLtm 과 같은 판정) — 6-K 분기 보고서를 미리 찾을 때. E = SEC 최근 사업연도말, last = 최신 분기말, yearAgo = 1년 전 분기말
 */
export function yahooLtmPeriods(facts: CompanyFacts, y: { quarterly: YahooFundamentalsRow[] }): { E: string; last: string; yearAgo: string } | null {
  const gaap = (facts.facts["us-gaap"] ?? {}) as Ns;
  const fy = FY_ANCHOR.flatMap((c) => (gaap[c]?.units?.USD ?? []).filter(isAnnualE)).sort((a, b) => b.end.localeCompare(a.end))[0];
  if (!fy || !isMonthEnd(fy.end)) return null;
  const ends = new Set(y.quarterly.map((r) => r.end));
  let last: string | null = null;
  for (let i = 1; i <= 3 && ends.has(monthEndShift(fy.end, 3 * i)); i++) last = monthEndShift(fy.end, 3 * i);
  return last ? { E: fy.end, last, yearAgo: monthEndShift(last, -12) } : null;
}

/** 정규화(USD) 이후의 facts 에 Yahoo 분기 LTM 을 붙인다 */
export function withYahooLtm(
  facts: CompanyFacts,
  y: { quarterly: YahooFundamentalsRow[]; annual: YahooFundamentalsRow[] },
  fx: Fx,
  currency: string,
  sixK: SixKStatements | null = null,
): { facts: CompanyFacts; result: YahooLtmResult } {
  // 보강 불가 = LTM 열 공란(사업연도 값을 LTM 으로 보이지 않는다 — 그림자 채우기 금지, 2026-09-27). 예외는 "사업연도 뒤
  // 분기가 아직 없음" 하나(그때는 사업연도 = 최근 12개월, 정의상 같은 기간) — noQuarter
  const none = (reason: string) => blankYahooLtm(facts, reason);
  const noQuarter = (reason: string) => ({ facts, result: { source: "none" as const, reason } });
  const gaap = (facts.facts["us-gaap"] ?? {}) as Ns;
  const usd = (c: string): FactUnitEntry[] => gaap[c]?.units?.USD ?? [];
  const latestFy = (c: string) =>
    usd(c).filter(isAnnualE).sort((a, b) => b.end.localeCompare(a.end) || (b.filed ?? "").localeCompare(a.filed ?? ""))[0];

  // SEC 최근 사업연도 = 순이익 개념의 최근 FY
  const fyRev = FY_ANCHOR.map(latestFy).filter(Boolean).sort((a, b) => b!.end.localeCompare(a!.end))[0];
  if (!fyRev?.start) return none("SEC 연간 순이익 없음");
  const E = fyRev.end, fyStart = fyRev.start;
  if (!isMonthEnd(E)) return none("달 말 결산 아님");

  const qBy = new Map(y.quarterly.map((r) => [r.end, r.values]));
  const ya = y.annual.find((r) => Math.abs(span(r.end, E)) <= 10)?.values;
  if (!ya) return none(`Yahoo FY${E.slice(0, 4)} 연간 없음 — 연간 경계 확인 불가`);
  const newQ: string[] = [];
  for (let i = 1; i <= 4 && qBy.has(monthEndShift(E, 3 * i)); i++) newQ.push(monthEndShift(E, 3 * i));
  if (!newQ.length) return noQuarter(`Yahoo 에 SEC FY${E.slice(0, 4)} 이후 분기 없음 — LTM = SEC 사업연도`);
  if (newQ.length >= 4) return none("Yahoo 분기가 SEC 연간보다 1년 이상 앞섬 — 새 연간 공시 대기");
  const k = newQ.length;
  const last = newQ[k - 1];
  const tail: string[] = [];
  for (let j = 3 - k; j >= 0; j--) tail.push(monthEndShift(E, -3 * j));
  const last4 = [...tail, ...newQ];
  const priorEnd = monthEndShift(E, -3 * (4 - k));
  const qStart = (d: string) => addDay(monthEndShift(d, -3), 1);

  // 환율 — 분기 평균(흐름)·기말(잔액). 하나라도 없으면 LTM 전체 보강 안 함(FY 유지 + 사유). 단 H.10 미고시(발표 지연)면 LTM 열 공란 —
  // 사업연도 값을 LTM 으로 보이는 대체를 하지 않는다(fin 과 같은 규칙)
  const qRate = new Map<string, number>();
  for (const d of last4) {
    const r = fx.avg(qStart(d), d);
    if (r == null) return none(fx.why?.(d) ?? `환율 없음(${d} 분기)`);
    qRate.set(d, r);
  }
  const fyRate = fx.avg(fyStart, E), priorRate = fx.avg(fyStart, priorEnd), lastRate = fx.at(last), eRate = fx.at(E);
  if (fyRate == null || priorRate == null || lastRate == null || eRate == null) {
    return none(fx.why?.(last) ?? "환율 없음(연간·기말)");
  }
  const yearAgo = monthEndShift(last, -12);
  const yearAgoRate = fx.at(yearAgo);

  const out: Ns = { ...gaap };
  const today = new Date().toISOString().slice(0, 10);
  const base = { fy: Number(E.slice(0, 4)) + 1, fp: "Q", form: YAHOO_Q_FORM, filed: today };
  const filled: string[] = [];
  const blanked: { label: string; reason: string }[] = [];
  const filledConcepts = new Set<string>();
  const fyYear = fiscalYearOf(E);
  const opPresent = latestFy("OperatingIncomeLoss")?.end === E;

  /** SEC 연말·사업연도 값 + 야후 분기 변동분으로 만든 항목(결정 (가) 방식) */
  const approx: { label: string; reason: string }[] = [];

  // ── 6-K 분기 재무제표(회사 공시 줄) ──
  // 야후 정의가 SEC 와 정확히 같지 않은 항목은 회사가 낸 분기 보고서의 같은 줄을 먼저 쓴다(야후 변동분 근사보다 정의가 SEC 와 같다).
  // us-gaap 개념 ← IFRS 원 개념(정규화 매핑의 역) ← 20-F 라벨 파일의 줄 이름. 원 개념은 그 회사가 SEC FY 에 실제로 공시한 것만
  const ifrsNs = ((facts.facts as Record<string, Ns | undefined>)["ifrs-full"] ?? {}) as Ns;
  const ifrsAtE = (c: string, kind: "bs" | "cf"): number | null => {
    for (const arr of Object.values(ifrsNs[c]?.units ?? {}))
      for (const e of arr) if (e.end === E && (kind === "bs" ? !e.start : !!e.start && span(e.start, E) > 300)) return e.val;
    return null;
  };
  /**
   * us-gaap 개념의 6-K 열 값(원통화). 정규화(edgar-foreign mapIfrs)가 SEC FY 에 실제로 쓴 IFRS 원 개념과 같은 것만 — 매핑 후보 순서대로
   * 첫 번째로 FY 값이 있는 후보(대안 묶음은 원 개념이 있는 첫 대안). 그 후보의 6-K 줄이 없으면 다른 후보로 넘어가지 않는다(정의가 달라짐).
   * 재무상태표는 원 개념마다 6-K 전년 연말 열 = SEC 원 개념 연말 값(공시 단위 안)인 줄만
   */
  const sixKOf = (dst: string, kind: "bs" | "cf"): { vals: number[]; src: string } | null => {
    if (!sixK) return null;
    const iE = sixK.bsDates.indexOf(E);
    for (const cand of ifrsSourcesOf(dst)) {
      const els = cand.sum.map((el) => (typeof el === "string" ? (ifrsNs[el] ? el : null) : (el.find((x) => ifrsNs[x]) ?? null))).filter((x): x is string => !!x && ifrsAtE(x, kind) != null);
      if (!els.length) continue;
      let tot: number[] | null = null;
      for (const c of els) {
        const fyV = ifrsAtE(c, kind)!;
        const v = sixKValueOf(sixK, c, kind, kind === "bs" && iE >= 0 ? (vals) => sameInUnit(fyV, vals[iE]) : undefined);
        if (!v || (kind === "bs" && (iE < 0 || !sameInUnit(fyV, v[iE])))) return null;
        tot = tot ? tot.map((t, i) => t + v[i]) : v.slice();
      }
      return { vals: tot!.map((v) => v * cand.sign), src: els.join(" + ") };
    }
    // 미국 기준(US GAAP) 20-F 회사(ASML) — 개념 그대로. 재무상태표는 SEC 연말 값(원통화 역환산)과 보고서 연말 열이 같아야
    if (!Object.keys(ifrsNs).length && sixK.labels.has(dst)) {
      const fyB = kind === "bs" ? instantOn(usd(dst), E) : null;
      if (kind === "bs" && (fyB == null || iE < 0)) return null;
      const ok = (vals: number[]) => sameInUnit(fyB! / eRate!, vals[iE]);
      const v = sixKValueOf(sixK, dst, kind, kind === "bs" ? ok : undefined);
      if (!v || (kind === "bs" && !ok(v))) return null;
      return { vals: v, src: dst };
    }
    return null;
  };
  const sixKFilled: { label: string; reason: string }[] = [];
  const fromSixK = new Set<string>();
  // ── 흐름 ──
  for (const it of FLOWS) {
    const present = it.concepts.filter((c) => latestFy(c)?.end === E);
    if (!present.length) continue;
    const sign = it.sign ?? 1;
    const fail = (reason: string) => { if (!flowSixK()) blanked.push({ label: it.label, reason }); };
    // 6-K 현금흐름표(당기·전기 누적) — LTM = SEC 사업연도 + 당기 누적 − 전기 누적. 감가상각(여러 개념 합)·손익 항목은 대상 밖
    const flowSixK = (): boolean => {
      if (!sixK || it.concepts === PRETAX || it.concepts === INTEREST) return false;
      const iC = sixK.cfDates.indexOf(last), iP = sixK.cfDates.indexOf(priorEnd);
      const curRate = fx.avg(addDay(E, 1), last);
      if (iC < 0 || iP < 0 || curRate == null) return false;
      let got = present.map((c) => ({ c, r: sixKOf(c, "cf") }));
      // 감가상각비 — SEC 값은 여러 개념 중 하나(또는 합). 보고서 줄이 있는 개념의 사업연도 값이 SEC 감가상각비와 같고, 다른 개념도 모두 같은
      // 값일 때만(같은 금액의 다른 이름) 그 줄을 모든 개념에(ASML 현금흐름 "Depreciation and amortization")
      if (it.da) {
        const daFy = daAnnualByYear(facts).get(fyYear);
        const hit = got.find((g) => g.r);
        if (daFy == null || !hit || present.some((c) => !sameInUnit(daFy / fyRate, latestFy(c)!.val / fyRate))) return false;
        got = present.map((c) => ({ c, r: hit.r }));
      }
      if (got.some((g) => !g.r)) return false;
      for (const { c, r } of got) {
        const fy = latestFy(c)!;
        const cur = r!.vals[iC] * curRate, prior = r!.vals[iP] * priorRate;
        const arr = usd(c).map((e) => (isAnnualE(e) && e.end === E && e.start === fy.start ? { ...e, ltmQ: fy.val } : e));
        arr.push({ ...base, start: addDay(E, 1), end: last, val: cur, ltmQ: cur }, { ...base, start: fyStart, end: priorEnd, val: prior, ltmQ: prior });
        out[c] = { ...out[c], units: { ...out[c].units, USD: arr } };
        filledConcepts.add(c);
      }
      sixKFilled.push({ label: it.label, reason: `${sixK.source} · ${got.map((g) => g.r!.src).join(", ")}` });
      return true;
    };
    // 영업이익 태그가 없는 회사는 세전이익 기반 합성(edgar-ev opIncomeEntries)이 이 값을 가공한다 — 합성값의 ltmQ 를
    // 맞출 수 없어 세전이익·이자비용도 비운다(항목 간 기간 혼합 방지)
    if (!opPresent && (it.concepts === PRETAX || it.concepts === INTEREST)) { fail("영업이익 태그 없음(세전이익 기반 합성)"); continue; }
    const yA = yv(ya, it.y);
    if (yA == null) { fail("Yahoo 연간 없음"); continue; }
    // 연간 경계: SEC FY(원통화) = Yahoo 연간
    const secVals = it.da
      ? [daAnnualByYear(facts).get(fyYear) ?? null]
      : present.map((c) => latestFy(c)!.val);
    const bad = secVals.find((v) => v == null || !sameInUnit(v / fyRate, sign * yA));
    if (bad !== undefined && flowSixK()) continue;
    // 야후 연간이 SEC 와 정의가 조금 다르면 LTM = 야후 최근 4분기 + (SEC 사업연도 − 야후 연간) — 잔액의 결정 (가)와 같은 방식(2026-10-02,
    // TSM CapEx 야후 1,272,450.3 vs SEC 1,272,410.5 백만 TWD). 차이가 SEC 값의 5% 를 넘으면 대응이 틀린 것으로 보고 비운다
    let levelAdj = false;
    if (bad !== undefined) {
      const rel = bad == null ? Infinity : Math.abs(bad / fyRate - sign * yA) / Math.max(1, Math.abs(bad / fyRate));
      if (rel > 0.05) {
        fail(`Yahoo 연간 ≠ SEC FY${E.slice(0, 4)}(정의 차이) — SEC ${bad == null ? "없음" : Math.round(bad / fyRate).toLocaleString("en-US")} vs Yahoo ${Math.round(sign * yA).toLocaleString("en-US")} ${currency}`);
        continue;
      }
      levelAdj = true;
    }
    const missing = last4.filter((d) => yv(qBy.get(d), it.y) == null);
    if (missing.length) { fail(`Yahoo 분기 결측(${missing.join("·")})`); continue; }
    const q = (d: string) => sign * yv(qBy.get(d), it.y)! * qRate.get(d)!;
    const tailUsd = tail.reduce((s, d) => s + q(d), 0);
    const newUsd = newQ.reduce((s, d) => s + q(d), 0);
    const priorOrig = sign * yA - tail.reduce((s, d) => s + sign * yv(qBy.get(d), it.y)!, 0);
    const priorUsd = priorOrig * priorRate;
    if (levelAdj) approx.push({ label: it.label, reason: `SEC FY${E.slice(0, 4)} ${Math.round(bad! / fyRate).toLocaleString("en-US")} vs Yahoo ${Math.round(sign * yA).toLocaleString("en-US")} ${currency}` });
    for (const c of present) {
      const fy = latestFy(c)!;
      // 수준 보정 = SEC 연간 − 야후 연간(사업연도 평균 환율). 감가상각은 SEC 값이 여러 개념의 합(daAnnualByYear)이라 그 합으로
      const secUsd = it.da ? (secVals[0] ?? fy.val) : fy.val;
      const adjUsd = levelAdj ? secUsd - sign * yA * fyRate : 0;
      const arr = usd(c).map((e) => (isAnnualE(e) && e.end === E && e.start === fy.start ? { ...e, ltmQ: tailUsd + priorUsd + adjUsd } : e));
      arr.push(
        { ...base, start: addDay(E, 1), end: last, val: newUsd, ltmQ: newUsd },
        { ...base, start: fyStart, end: priorEnd, val: priorUsd, ltmQ: priorUsd },
      );
      out[c] = { ...out[c], units: { ...out[c].units, USD: arr } };
      filledConcepts.add(c);
    }
    filled.push(it.label);
  }

  // 매핑하지 않은(또는 비운) 흐름 개념 — 최근 FY 항목에 ltmNone(LTM 공란)
  // 그 밖 현금흐름표 줄(FLOWS 에 없는 개념) — 6-K 현금흐름표에 같은 줄이 있으면 SEC 사업연도 + 당기 누적 − 전기 누적
  if (sixK) {
    const iC = sixK.cfDates.indexOf(last), iP = sixK.cfDates.indexOf(priorEnd);
    const curRate = fx.avg(addDay(E, 1), last);
    const handled = new Set([...FLOWS.flatMap((f) => f.concepts), ...DA_TOTAL, SYN_DA_CF]);
    const extra: string[] = [];
    for (const c of Object.keys(out)) {
      if (handled.has(c) || filledConcepts.has(c) || !CF_CONCEPT.test(c) || iC < 0 || iP < 0 || curRate == null) continue;
      const fy = latestFy(c);
      if (fy?.end !== E) continue;
      const r = sixKOf(c, "cf");
      if (!r) continue;
      const cur = r.vals[iC] * curRate, prior = r.vals[iP] * priorRate;
      const arr = usd(c).map((e) => (isAnnualE(e) && e.end === E && e.start === fy.start ? { ...e, ltmQ: fy.val } : e));
      arr.push({ ...base, start: addDay(E, 1), end: last, val: cur, ltmQ: cur }, { ...base, start: fyStart, end: priorEnd, val: prior, ltmQ: prior });
      out[c] = { ...out[c], units: { ...out[c].units, USD: arr } };
      filledConcepts.add(c);
      extra.push(c);
    }
    if (extra.length) sixKFilled.push({ label: `현금흐름표 그 밖 ${extra.length}개 줄`, reason: `${sixK.source} · ${extra.join(", ")}` });
  }
  markLtmNone(out, filledConcepts);

  // ── 잔액(최신 분기말) ──
  const on = (c: string, d: string) => instantOn(usd(c), d);
  const put = (c: string, d: string, v: number) => {
    const arr = [...(out[c]?.units?.USD ?? []), { ...base, end: d, val: v }];
    out[c] = { ...(out[c] ?? {}), units: { ...(out[c]?.units ?? {}), USD: arr } };
  };
  const yAt = (d: string, key: YKey) => (d === E ? (yv(qBy.get(E), key) ?? yv(ya, key)) : yv(qBy.get(d), key)) ?? null;
  const instOk = new Map<string, boolean>();
  for (const it of INSTANTS) {
    const present = it.concepts.filter((c) => on(c, E) != null);
    if (!present.length) continue;
    const fail = (reason: string) => { if (instSixK()) return; blanked.push({ label: it.label, reason }); instOk.set(it.label, false); };
    // 6-K 재무상태표 — 전년 연말 열이 SEC 연말 값과 공시 단위 안에서 같을 때만(줄 대응 확인)
    function instSixK(): boolean {
      if (!sixK) return false;
      const iE = sixK.bsDates.indexOf(E), iL = sixK.bsDates.indexOf(last), iP = sixK.bsDates.indexOf(yearAgo);
      if (iE < 0 || iL < 0) return false;
      const got = present.map((c) => ({ c, r: sixKOf(c, "bs") }));
      if (got.some((g) => !g.r || !sameInUnit(on(g.c, E)! / eRate!, g.r.vals[iE]))) return false;
      for (const { c, r } of got) {
        put(c, last, r!.vals[iL] * lastRate!);
        if (iP >= 0 && yearAgoRate != null) put(c, yearAgo, r!.vals[iP] * yearAgoRate);
        fromSixK.add(c);
      }
      instOk.set(it.label, true);
      sixKFilled.push({ label: it.label, reason: `${sixK.source} · ${got.map((g) => g.r!.src).join(", ")}` });
      return true;
    }
    const yE = yAt(E, it.y), yL = yAt(last, it.y);
    if (yE == null) { fail("Yahoo FY말 값 없음"); continue; }
    const bad = present.find((c) => !sameInUnit(on(c, E)! / eRate, yE));
    // EV 구성요소(현금·단기투자·비지배지분) — Yahoo 연말 값이 SEC 와 정의가 조금 다르면(TSM 단기투자) SEC 연말 값 + Yahoo 분기 변동분(오너 결정 2026-10-01 (가) —
    // "EV를 비워두면 안된다"). 그 밖 잔액은 종전대로 공란
    // 2026-10-02 부터 EV 구성요소만이 아니라 전 잔액 항목(오너 지시 "tsm은 값넣어") — 단 EV 밖 항목은 차이가 SEC 의 15% 를 넘으면 대응이 틀린 것으로 보고 비운다
    if (bad && instSixK()) continue;
    const relI = bad ? Math.abs(on(bad, E)! / eRate - yE) / Math.max(1, Math.abs(on(bad, E)! / eRate)) : 0;
    if (bad && (it.ev || relI <= 0.15) && yAt(last, it.y) != null) {
      const yL0 = yAt(last, it.y)!, yP0 = yearAgoRate != null ? yAt(yearAgo, it.y) : null;
      for (const c of present) {
        const secE = on(c, E)! / eRate;
        put(c, last, (secE + (yL0 - yE)) * lastRate);
        if (yP0 != null) put(c, yearAgo, (secE + (yP0 - yE)) * yearAgoRate!);
      }
      instOk.set(it.label, true);
      approx.push({ label: it.label, reason: `SEC ${E} ${Math.round(on(bad, E)! / eRate).toLocaleString("en-US")} + Yahoo 변동(${Math.round(yE).toLocaleString("en-US")} → ${Math.round(yL0).toLocaleString("en-US")}) ${currency}` });
      continue;
    }
    if (bad) { fail(`Yahoo FY말 ≠ SEC(${bad}) — SEC ${Math.round(on(bad, E)! / eRate).toLocaleString("en-US")} vs Yahoo ${Math.round(yE).toLocaleString("en-US")} ${currency}`); continue; }
    if (yL == null) { fail(`Yahoo ${last} 값 없음`); continue; }
    const yP = yearAgoRate != null ? yAt(yearAgo, it.y) : null;
    for (const c of present) {
      put(c, last, yL * lastRate);
      if (yP != null) put(c, yearAgo, yP * yearAgoRate!);
    }
    instOk.set(it.label, true);
    filled.push(it.label);
  }

  // 그 밖 재무상태표 줄(INSTANTS 에 없는 개념, 또는 위에서 못 채운 것) — 6-K 재무상태표 같은 줄, 원 개념별 전년 연말 열 = SEC 연말 값 확인
  if (sixK && sixK.bsDates.includes(last)) {
    const iL = sixK.bsDates.indexOf(last), iP = sixK.bsDates.indexOf(yearAgo);
    const extra: string[] = [];
    for (const c of Object.keys(out)) {
      const vE = on(c, E);
      if (vE == null || on(c, last) != null || !(out[c]?.units?.USD ?? []).some((e) => !e.start && e.end === E)) continue;
      const r = sixKOf(c, "bs");
      if (!r || !sameInUnit(vE / eRate, r.vals[sixK.bsDates.indexOf(E)])) continue;
      put(c, last, r.vals[iL] * lastRate);
      if (iP >= 0 && yearAgoRate != null) put(c, yearAgo, r.vals[iP] * yearAgoRate);
      extra.push(c);
    }
    if (extra.length) sixKFilled.push({ label: `재무상태표 그 밖 ${extra.length}개 줄`, reason: `${sixK.source} · ${extra.join(", ")}` });
  }

  // 총차입금(본표 차입금 줄 합 — edgar-ev resolveDebt 와 같은 값)·비유동 차입금
  const debtE = resolveDebt((c) => on(c, E));
  const yDebtE = yAt(E, "totalDebt"), yDebtL = yAt(last, "totalDebt");
  let debtOk = false;
  if (!debtE && !yDebtE) debtOk = true; // 차입금 없음
  else if (!debtE || yDebtE == null) blanked.push({ label: "총차입금", reason: debtE ? "Yahoo FY말 값 없음" : "SEC FY말 차입금 없음" });
  else if (!sameInUnit(debtE.debt / eRate, yDebtE) && yDebtL != null) {
    // 정의가 조금 다름(ASML 0.37%·TSM 0.36%) — SEC 연말 + Yahoo 분기 변동분(오너 결정 2026-10-01 (가))
    debtOk = true;
    const secE = debtE.debt / eRate;
    put(SYN_DEBT_FACE, last, (secE + (yDebtL - yDebtE)) * lastRate);
    const yPD = yearAgoRate != null ? yAt(yearAgo, "totalDebt") : null;
    if (yPD != null) put(SYN_DEBT_FACE, yearAgo, (secE + (yPD - yDebtE)) * yearAgoRate!);
    approx.push({ label: "총차입금", reason: `SEC ${E} ${Math.round(secE).toLocaleString("en-US")} + Yahoo 변동(${Math.round(yDebtE).toLocaleString("en-US")} → ${Math.round(yDebtL).toLocaleString("en-US")}) ${currency}` });
  } else if (!sameInUnit(debtE.debt / eRate, yDebtE))
    blanked.push({ label: "총차입금", reason: `Yahoo FY말 ≠ SEC — SEC ${Math.round(debtE.debt / eRate).toLocaleString("en-US")} vs Yahoo ${Math.round(yDebtE).toLocaleString("en-US")} ${currency}` });
  else if (yDebtL == null) blanked.push({ label: "총차입금", reason: `Yahoo ${last} 값 없음` });
  else {
    debtOk = true;
    put(SYN_DEBT_FACE, last, yDebtL * lastRate);
    const yPD = yearAgoRate != null ? yAt(yearAgo, "totalDebt") : null;
    if (yPD != null) put(SYN_DEBT_FACE, yearAgo, yPD * yearAgoRate!);
    filled.push("총차입금");
    // 비유동 차입금 — 같은 정의일 때만(없으면 LTM 장기차입금 공란)
    const yNcE = yAt(E, "longTermDebtAndCapitalLeaseObligation"), yNcL = yAt(last, "longTermDebtAndCapitalLeaseObligation");
    if (debtE.noncurrent != null && yNcE != null && yNcL != null && sameInUnit(debtE.noncurrent / eRate, yNcE)) {
      put(SYN_DEBT_FACE_NONCURRENT, last, yNcL * lastRate);
      const yPN = yearAgoRate != null ? yAt(yearAgo, "longTermDebtAndCapitalLeaseObligation") : null;
      if (yPN != null) put(SYN_DEBT_FACE_NONCURRENT, yearAgo, yPN * yearAgoRate!);
      filled.push("비유동 차입금");
    } else if (debtE.noncurrent != null) blanked.push({ label: "비유동 차입금", reason: "Yahoo 값 없음 또는 SEC 와 다름" });
  }

  // SEC 연말 값이 0 이거나 그 줄이 없는 EV 구성요소(우선주·비지배지분)는 분기말에도 0 — 태그만 남은 회사가 LTM 에서 "모름"으로 EV 전체가 비던 문제(ASML 우선주, 2026-10-01)
  for (const c of [...PREFERRED, "MinorityInterest"]) {
    // 연말 재무상태표에 그 줄이 없거나(ASML 우선주 — 2016 년 이후 태그 없음) 0 이면 분기말도 0
    if ((on(c, E) ?? 0) === 0 && on(c, last) == null) { put(c, last, 0); if (yearAgoRate != null && on(c, yearAgo) == null) put(c, yearAgo, 0); }
  }
  // EV 완결성 — SEC FY말에 있는 구성요소는 전부 같은 기준일로 채워져야 한다
  const evMiss: string[] = [];
  if (!debtOk) evMiss.push("총차입금");
  if (instOk.get("현금및현금성자산") !== true) evMiss.push("현금");
  if (STI.some((c) => on(c, E) != null) && instOk.get("단기투자") !== true) evMiss.push("단기투자");
  if (LT_SECURITIES.some((c) => (on(c, E) ?? 0) !== 0)) evMiss.push("장기투자증권(Yahoo 대응 없음)");
  if ((on("MinorityInterest", E) ?? 0) !== 0 && instOk.get("비지배지분") !== true) evMiss.push("비지배지분");
  if (on("PartnersCapitalAttributableToNoncontrollingInterest", E) != null) evMiss.push("비지배지분(파트너십)");
  if (PREFERRED.some((c) => (on(c, E) ?? 0) !== 0)) evMiss.push("우선주(Yahoo 대응 없음)");

  return {
    facts: { ...facts, facts: { ...facts.facts, "us-gaap": out } } as CompanyFacts,
    result: {
      source: "yahoo",
      through: last,
      currency,
      filled,
      blanked,
      approx,
      sixK: sixKFilled,
      evComplete: evMiss.length === 0,
      evReason: evMiss.length ? `LTM EV 미표시(Yahoo 분기 LTM) — ${evMiss.join("·")}을(를) ${last} 기준으로 못 채움` : null,
    },
  };
}

/** LTM 열이 Yahoo 분기 기준인 20-F 발행사면 그 결과 */
export function yahooLtm(facts: CompanyFacts): Extract<YahooLtmResult, { source: "yahoo" }> | null {
  const s = facts.ltmQuarterSource;
  return s?.source === "yahoo" ? s : null;
}

/** 공란 항목을 사유 종류별로(항목 이름만 — 판정 숫자는 빼고) */
function blankGroups(bl: { label: string; reason: string }[]): string {
  const g = new Map<string, string[]>();
  for (const b of bl) {
    const miss = /^Yahoo 분기 결측\(([^)]+)\)/.exec(b.reason);
    const k = miss ? `야후 ${miss[1]} 분기 자료 없음` : /정의 차이|≠ SEC|SEC 와 다름/.test(b.reason) ? "SEC·야후 항목 정의 다름" : /Yahoo (연간|FY말) 값? ?없음|Yahoo 연간 없음|Yahoo FY말 값 없음/.test(b.reason) ? "야후에 항목 없음" : b.reason;
    g.set(k, [...(g.get(k) ?? []), b.label]);
  }
  return [...g].map(([k, ls]) => `${k}: ${ls.join(", ")}`).join(" / ");
}

/** 화면 라벨 */
export function yahooLtmLabel(r: YahooLtmResult): string {
  if (r.source !== "yahoo") return r.ltmBlank ? `⚠ LTM 열 공란: ${r.reason}(사업연도 값으로 대체하지 않음)` : `LTM 분기 보강 안 함(SEC 사업연도 유지): ${r.reason}`;
  return (
    `LTM 열 = Yahoo 분기(원통화 ${r.currency}, 연준 H.10 분기 평균·기말 환율 환산, ~${r.through}), 결측 항목 공란` +
    // 화면 각주는 항목 이름만 — 판정 숫자(SEC vs Yahoo 금액)는 칸 주석·검증 결과에(오너 지적 2026-10-02 "주석에 이상한 내용을 잔뜩")
    (r.blanked.length ? ` · 공란 — ${blankGroups(r.blanked)}` : "") +
    (r.approx?.length ? ` · SEC 연말 + Yahoo 분기 변동분: ${r.approx.map((b) => b.label).join(", ")}` : "") +
    (r.sixK?.length ? ` · 회사 6-K 분기 재무제표: ${r.sixK.map((b) => b.label).join(", ")}` : "") +
    (r.evReason ? ` · ${r.evReason}` : "")
  );
}
