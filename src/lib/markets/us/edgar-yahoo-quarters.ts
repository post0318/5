import "server-only";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { YahooFundamentalsRow } from "../quote/yahoo";
import { DA_TOTAL, SYN_DA_CF, daAnnualByYear, resolveDebt } from "./edgar-ev";
import { SYN_DEBT_FACE, SYN_DEBT_FACE_NONCURRENT } from "./edgar-bs-structure";
import { fiscalYearOf, instantOn } from "./edgar-series";

/**
 * **20-F 발행사 LTM 열 = Yahoo 분기(원통화) 최근 4개 분기** (오너 결정 2026-09-25 — Yahoo·인포맥스 분기 구성 비교 후.
 * 인포맥스는 검증 도구의 대조 원천으로만 쓴다).
 *
 * 20-F 발행사(TSM·ASML·SPOT 등)는 SEC 에 분기 XBRL 이 없어 LTM 이 최근 사업연도(FY)에 머문다. 예전 인포맥스 경로는
 * 매출·영업이익·순이익·감가상각비만 최근 4개 분기로 바꾸고 나머지(매출원가·세전이익·법인세·현금흐름·재무상태표)는 FY 로
 * 남겨, 한 LTM 열 안에서 기간이 섞였다(TSM 매출총이익률 51.39% < 영업이익률 55.84%, 독립 감사 2026-09-25).
 *
 * 원칙 — LTM 열 안에서 원천·기간이 하나:
 *  - 흐름 = Yahoo 최근 4개 분기 합. 분기마다 **그 분기 평균 환율**(앱 공통 환율 규칙, edgar-foreign.ts fxToUsd)로 USD 환산.
 *  - 잔액 = Yahoo 최신 분기말 값 × 기말 환율. 평균 잔액용으로 1년 전 분기말 값도 넣는다(있을 때).
 *  - 항목마다 **연간 경계 확인**: Yahoo 연간(SEC FY 말일) = SEC FY(원통화, 공시 단위 안). 다르면 정의가 다른 것 — 그 항목만
 *    LTM 공란(FY 값 유지·다른 원천 혼합 금지). 최근 4개 분기 중 하나라도 결측이어도 공란.
 *  - 매핑하지 않은 흐름 개념은 최근 FY 항목에 `ltmNone` 을 달아 LTM 이 비게 한다(edgar-series.ttmCombine). 매핑하지 않은
 *    잔액 개념은 소비 모듈이 LTM 기준일(balanceDate)의 값만 읽어 자연히 빈다.
 *  - EV 구성요소(차입금·현금·단기투자·장기 투자증권·비지배지분·우선주) 중 SEC FY 말에 있는 것이 하나라도 Yahoo 로 같은
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
      /** LTM EV·순차입금을 같은 기준일로 계산할 수 있는지 */
      evComplete: boolean;
      evReason: string | null;
    }
  | { source: "none"; reason: string };

type Units = Record<string, FactUnitEntry[]>;
type Ns = Record<string, { label?: string; description?: string; units: Units }>;
type Fx = { avg(start: string, end: string): number | null; at(date: string): number | null };

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

const REV = [
  "Revenues",
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
];
const PRETAX = [
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesAndExtraordinaryItemsNoncontrollingInterest",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndEquityMethodInvestments",
];
const INTEREST = ["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt", "InterestAndDebtExpense"];

/** 흐름 항목 — Yahoo 필드 → us-gaap 개념(외화·IFRS 정규화 후). sign: SEC 부호 = sign × Yahoo */
const FLOWS: { label: string; y: string; concepts: string[]; sign?: 1 | -1; da?: true }[] = [
  { label: "매출", y: "totalRevenue", concepts: REV },
  { label: "매출원가", y: "costOfRevenue", concepts: ["CostOfRevenue", "CostOfGoodsAndServicesSold"] },
  { label: "매출총이익", y: "grossProfit", concepts: ["GrossProfit"] },
  { label: "판관비", y: "sellingGeneralAndAdministration", concepts: ["SellingGeneralAndAdministrativeExpense"] },
  { label: "연구개발비", y: "researchAndDevelopment", concepts: ["ResearchAndDevelopmentExpense", "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost"] },
  // Yahoo operatingIncome 은 정규화 값(TSM FY2025 1,936,095.6백만 TWD) — 공시값은 totalOperatingIncomeAsReported(1,936,091.7 = SEC)
  { label: "영업이익", y: "totalOperatingIncomeAsReported", concepts: ["OperatingIncomeLoss"] },
  { label: "이자비용", y: "interestExpense", concepts: INTEREST },
  { label: "세전이익", y: "pretaxIncome", concepts: PRETAX },
  { label: "법인세", y: "taxProvision", concepts: ["IncomeTaxExpenseBenefit"] },
  { label: "순이익", y: "netIncome", concepts: ["NetIncomeLoss"] },
  { label: "보통주 귀속 순이익", y: "netIncomeCommonStockholders", concepts: ["NetIncomeLossAvailableToCommonStockholdersBasic"] },
  { label: "연결 순이익", y: "netIncomeIncludingNoncontrollingInterests", concepts: ["ProfitLoss"] },
  { label: "감가상각비", y: "reconciledDepreciation", concepts: [SYN_DA_CF, ...DA_TOTAL], da: true },
  { label: "영업활동현금흐름", y: "operatingCashFlow", concepts: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"] },
  { label: "투자활동현금흐름", y: "investingCashFlow", concepts: ["NetCashProvidedByUsedInInvestingActivities", "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations"] },
  { label: "재무활동현금흐름", y: "financingCashFlow", concepts: ["NetCashProvidedByUsedInFinancingActivities", "NetCashProvidedByUsedInFinancingActivitiesContinuingOperations"] },
  { label: "CapEx", y: "capitalExpenditure", concepts: ["PaymentsToAcquirePropertyPlantAndEquipment"], sign: -1 },
  { label: "배당금 지급", y: "cashDividendsPaid", concepts: ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"], sign: -1 },
  { label: "자사주 매입", y: "repurchaseOfCapitalStock", concepts: ["PaymentsForRepurchaseOfCommonStock"], sign: -1 },
];

/** 잔액 항목. ev: EV 구성요소 */
const STI = ["MarketableSecuritiesCurrent", "ShortTermInvestments", "AvailableForSaleSecuritiesDebtSecuritiesCurrent", "DebtSecuritiesCurrent"];
const LT_SECURITIES = ["MarketableSecuritiesNoncurrent", "AvailableForSaleSecuritiesDebtSecuritiesNoncurrent", "DebtSecuritiesNoncurrent"];
const PREFERRED = ["PreferredStockValue", "PreferredStockValueOutstanding"];
const INSTANTS: { label: string; y: string; concepts: string[]; ev?: true }[] = [
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
];

/** 공시 단위 안에서 같은가 — 단위 = SEC 원통화 값의 끝자리 0 개수(최대 10^6). 역환산 부동소수 오차만큼 여유 */
function sameInUnit(sec: number, yv: number): boolean {
  const r = Math.round(Math.abs(sec));
  let unit = 1;
  while (unit < 1e6 && r !== 0 && r % (unit * 10) === 0) unit *= 10;
  return Math.abs(sec - yv) < unit + Math.abs(sec) * 1e-9;
}

/** 정규화(USD) 이후의 facts 에 Yahoo 분기 LTM 을 붙인다 */
export function withYahooLtm(
  facts: CompanyFacts,
  y: { quarterly: YahooFundamentalsRow[]; annual: YahooFundamentalsRow[] },
  fx: Fx,
  currency: string,
): { facts: CompanyFacts; result: YahooLtmResult } {
  const none = (reason: string) => ({ facts, result: { source: "none" as const, reason } });
  const gaap = (facts.facts["us-gaap"] ?? {}) as Ns;
  const usd = (c: string): FactUnitEntry[] => gaap[c]?.units?.USD ?? [];
  const latestFy = (c: string) =>
    usd(c).filter(isAnnualE).sort((a, b) => b.end.localeCompare(a.end) || (b.filed ?? "").localeCompare(a.filed ?? ""))[0];

  // SEC 최근 사업연도 = 매출 개념의 최근 FY
  const fyRev = REV.map(latestFy).filter(Boolean).sort((a, b) => b!.end.localeCompare(a!.end))[0];
  if (!fyRev?.start) return none("SEC 연간 매출 없음");
  const E = fyRev.end, fyStart = fyRev.start;
  if (!isMonthEnd(E)) return none("달 말 결산 아님");

  const qBy = new Map(y.quarterly.map((r) => [r.end, r.values]));
  const ya = y.annual.find((r) => Math.abs(span(r.end, E)) <= 10)?.values;
  if (!ya) return none(`Yahoo FY${E.slice(0, 4)} 연간 없음 — 연간 경계 확인 불가`);
  const newQ: string[] = [];
  for (let i = 1; i <= 4 && qBy.has(monthEndShift(E, 3 * i)); i++) newQ.push(monthEndShift(E, 3 * i));
  if (!newQ.length) return none(`Yahoo 에 SEC FY${E.slice(0, 4)} 이후 분기 없음 — LTM = SEC 사업연도`);
  if (newQ.length >= 4) return none("Yahoo 분기가 SEC 연간보다 1년 이상 앞섬 — 새 연간 공시 대기");
  const k = newQ.length;
  const last = newQ[k - 1];
  const tail: string[] = [];
  for (let j = 3 - k; j >= 0; j--) tail.push(monthEndShift(E, -3 * j));
  const last4 = [...tail, ...newQ];
  const priorEnd = monthEndShift(E, -3 * (4 - k));
  const qStart = (d: string) => addDay(monthEndShift(d, -3), 1);

  // 환율 — 분기 평균(흐름)·기말(잔액). 하나라도 없으면 LTM 전체 보강 안 함(FY 유지 + 사유)
  const qRate = new Map<string, number>();
  for (const d of last4) {
    const r = fx.avg(qStart(d), d);
    if (r == null) return none(`환율 없음(${d} 분기)`);
    qRate.set(d, r);
  }
  const fyRate = fx.avg(fyStart, E), priorRate = fx.avg(fyStart, priorEnd), lastRate = fx.at(last), eRate = fx.at(E);
  if (fyRate == null || priorRate == null || lastRate == null || eRate == null) return none("환율 없음(연간·기말)");
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

  // ── 흐름 ──
  for (const it of FLOWS) {
    const present = it.concepts.filter((c) => latestFy(c)?.end === E);
    if (!present.length) continue;
    const sign = it.sign ?? 1;
    const fail = (reason: string) => blanked.push({ label: it.label, reason });
    // 영업이익 태그가 없는 회사는 세전이익 기반 합성(edgar-ev opIncomeEntries)이 이 값을 가공한다 — 합성값의 ltmQ 를
    // 맞출 수 없어 세전이익·이자비용도 비운다(항목 간 기간 혼합 방지)
    if (!opPresent && (it.concepts === PRETAX || it.concepts === INTEREST)) { fail("영업이익 태그 없음(세전이익 기반 합성)"); continue; }
    const yA = ya[it.y];
    if (yA == null) { fail("Yahoo 연간 없음"); continue; }
    // 연간 경계: SEC FY(원통화) = Yahoo 연간
    const secVals = it.da
      ? [daAnnualByYear(facts).get(fyYear) ?? null]
      : present.map((c) => latestFy(c)!.val);
    const bad = secVals.find((v) => v == null || !sameInUnit(v / fyRate, sign * yA));
    if (bad !== undefined) {
      fail(`Yahoo 연간 ≠ SEC FY${E.slice(0, 4)}(정의 차이) — SEC ${bad == null ? "없음" : Math.round(bad / fyRate).toLocaleString("en-US")} vs Yahoo ${Math.round(sign * yA).toLocaleString("en-US")} ${currency}`);
      continue;
    }
    const missing = last4.filter((d) => qBy.get(d)?.[it.y] == null);
    if (missing.length) { fail(`Yahoo 분기 결측(${missing.join("·")})`); continue; }
    const q = (d: string) => sign * qBy.get(d)![it.y] * qRate.get(d)!;
    const tailUsd = tail.reduce((s, d) => s + q(d), 0);
    const newUsd = newQ.reduce((s, d) => s + q(d), 0);
    const priorOrig = sign * yA - tail.reduce((s, d) => s + sign * qBy.get(d)![it.y], 0);
    const priorUsd = priorOrig * priorRate;
    for (const c of present) {
      const fy = latestFy(c)!;
      const arr = usd(c).map((e) => (isAnnualE(e) && e.end === E && e.start === fy.start ? { ...e, ltmQ: tailUsd + priorUsd } : e));
      arr.push(
        { ...base, start: addDay(E, 1), end: last, val: newUsd, ltmQ: newUsd },
        { ...base, start: fyStart, end: priorEnd, val: priorUsd, ltmQ: priorUsd },
      );
      out[c] = { ...out[c], units: { ...out[c].units, USD: arr } };
      filledConcepts.add(c);
    }
    filled.push(it.label);
  }

  // 매핑하지 않은(또는 비운) 흐름 개념 — 최근 FY 항목에 ltmNone(LTM 공란). 주식수 단위(가중평균)는 LTM 에 안 쓴다
  for (const [c, node] of Object.entries(out)) {
    if (filledConcepts.has(c)) continue;
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

  // ── 잔액(최신 분기말) ──
  const on = (c: string, d: string) => instantOn(usd(c), d);
  const put = (c: string, d: string, v: number) => {
    const arr = [...(out[c]?.units?.USD ?? []), { ...base, end: d, val: v }];
    out[c] = { ...(out[c] ?? {}), units: { ...(out[c]?.units ?? {}), USD: arr } };
  };
  const yAt = (d: string, key: string) => (d === E ? (qBy.get(E)?.[key] ?? ya[key]) : qBy.get(d)?.[key]) ?? null;
  const instOk = new Map<string, boolean>();
  for (const it of INSTANTS) {
    const present = it.concepts.filter((c) => on(c, E) != null);
    if (!present.length) continue;
    const fail = (reason: string) => { blanked.push({ label: it.label, reason }); instOk.set(it.label, false); };
    const yE = yAt(E, it.y), yL = yAt(last, it.y);
    if (yE == null) { fail("Yahoo FY말 값 없음"); continue; }
    const bad = present.find((c) => !sameInUnit(on(c, E)! / eRate, yE));
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

  // 총차입금(본표 차입금 줄 합 — edgar-ev resolveDebt 와 같은 값)·비유동 차입금
  const debtE = resolveDebt((c) => on(c, E));
  const yDebtE = yAt(E, "totalDebt"), yDebtL = yAt(last, "totalDebt");
  let debtOk = false;
  if (!debtE && !yDebtE) debtOk = true; // 차입금 없음
  else if (!debtE || yDebtE == null) blanked.push({ label: "총차입금", reason: debtE ? "Yahoo FY말 값 없음" : "SEC FY말 차입금 없음" });
  else if (!sameInUnit(debtE.debt / eRate, yDebtE))
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

  // EV 완결성 — SEC FY말에 있는 구성요소는 전부 같은 기준일로 채워져야 한다
  const evMiss: string[] = [];
  if (!debtOk) evMiss.push("총차입금");
  if (instOk.get("현금및현금성자산") !== true) evMiss.push("현금");
  if (STI.some((c) => on(c, E) != null) && instOk.get("단기투자") !== true) evMiss.push("단기투자");
  if (LT_SECURITIES.some((c) => (on(c, E) ?? 0) !== 0)) evMiss.push("장기 투자증권(Yahoo 대응 없음)");
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

/** 화면 라벨 */
export function yahooLtmLabel(r: YahooLtmResult): string {
  if (r.source !== "yahoo") return `LTM 분기 보강 안 함(SEC 사업연도 유지): ${r.reason}`;
  return (
    `LTM 열 = Yahoo 분기(원통화 ${r.currency}, 분기 평균·기말 환율 환산, ~${r.through}), 결측 항목 공란` +
    (r.blanked.length ? ` — 공란: ${r.blanked.map((b) => `${b.label}(${b.reason})`).join(", ")}` : "") +
    (r.evReason ? ` · ${r.evReason}` : "")
  );
}
