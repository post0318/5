import "server-only";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import { annualByYear, entriesOf, ttmOf } from "./edgar-series";
import { opUnitsFrom } from "../op-units";

/**
 * 미국 종목 **EV 브릿지·EBITDA 단일 기준**.
 *
 * 왜 따로 뺐나 — 같은 회사의 EV/EBITDA 가 화면마다 달랐다(오너 지적
 * 2026-09-23, WMT). 하이라이트는 운용리스를 차입금에 넣고 장기 투자증권을
 * 현금으로 뺐고, 재무분석은 리스를 빼고 보험 투자자산(LongTermInvestments)까지
 * 현금으로 뺐으며, 컨센서스·멀티플은 차입금이 아니라 부채총계를 썼다.
 * 발행주식수를 edgar-shares.ts 로 모은 것과 같은 방식으로 여기 한 곳에 모은다.
 *
 * 정의(오너 결정 2026-09-23, 42종목·200종목 실측 후 확정):
 *   EV = 시가총액 + 이자부 차입금(금융리스 포함, **운용리스 제외**)
 *        + 우선주 + 비지배지분 − (현금 + 단기투자 + 장기 투자증권)
 *   EBITDA = 보고 영업이익 + 감가상각비 (SEC 보고 기준, 조정 없음)
 *
 * - 운용리스 제외: 미국 GAAP 은 운용리스 비용이 이미 EBITDA 안(영업비용)에
 *   있어 부채로 더하면 이중 반영된다. MarketScreener 와 같은 기준(Yahoo·
 *   StockAnalysis 는 포함 — 그쪽이 이중 반영).
 * - 장기투자자산(LongTermInvestments)은 현금으로 빼지 않는다: UNH(EV 의 15%)·
 *   GE(11%)에선 보험 가입자 지급용 투자자산, MSFT 등에선 지분법 투자라 영업용.
 *   조사한 사이트(Yahoo·Finviz·StockAnalysis·MarketScreener) 모두 제외.
 *   장기 투자증권(AAPL 841억 달러 등 채권형)은 여유현금이라 뺀다(MarketScreener
 *   와 동일).
 */

// ── 태그 목록 (실측으로 확정 — 각 항목 주석의 사례 참고) ─────────────────

/** 비유동 차입금 — 하나만 채택. VZ·T·HD·BA 는 두 번째 태그만 쓴다. */
const DEBT_NONCURRENT = ["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations"];
/** 유동 차입금 — 하나만 채택. DebtCurrent 는 단기차입금·CP 까지 포함한 상위 개념. */
const DEBT_CURRENT = [
  "DebtCurrent",
  "LongTermDebtAndCapitalLeaseObligationsCurrent",
  "LongTermDebtCurrent",
];
/** DebtCurrent 를 못 썼을 때만 더한다(중복 방지). */
const SHORT_BORROWINGS = ["ShortTermBorrowings", "OtherShortTermBorrowings", "CommercialPaper"];
/** 비유동/유동 구분이 없을 때의 합계 태그 — 하나만 채택.
 *  CVX 는 첫 번째(유동성 포함 합계)만, 리츠 O 는 NotesPayable 만 쓴다. */
const DEBT_TOTAL = [
  "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities",
  "LongTermDebt",
  "DebtLongtermAndShorttermCombinedAmount",
  "DebtInstrumentCarryingAmount",
  "NotesPayable",
];
/** 금융리스 — LongTermDebtAndCapitalLeaseObligations 계열을 쓰면 이미 포함. */
const FIN_LEASE = ["FinanceLeaseLiabilityNoncurrent", "FinanceLeaseLiabilityCurrent"];
/** 차입금 태그가 하나라도 있는지 판정용(기준일 폴백). */
const ANY_DEBT = [...DEBT_NONCURRENT, ...DEBT_CURRENT, ...DEBT_TOTAL];
/** 대차대조표에 차입금 태그가 없을 때 "빚이 없다"와 "태그를 안 달았다"를
 *  가르는 신호 — 최근 1년 안에 차입·상환·이자 흐름이 있으면 후자(Ford).
 *  무차입 기업(PLTR)은 이 흐름이 전혀 없다. */
const DEBT_ACTIVITY = [
  "ProceedsFromIssuanceOfLongTermDebt",
  "RepaymentsOfLongTermDebt",
  "InterestPaidNet",
  "InterestPaid",
];

/** 현금 — 표준 태그를 중단한 회사(GE 2017·SBUX 2022 이후, 200종목 중 13개)는
 *  "현금+제한현금" 합계만 공시한다. 사이트들도 이 합계를 쓴다. */
const CASH = [
  "CashAndCashEquivalentsAtCarryingValue",
  "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
];
/** 단기투자 — 같은 금액을 두 태그로 다는 회사가 있어 최댓값. */
const STI = [
  "MarketableSecuritiesCurrent",
  "ShortTermInvestments",
  "AvailableForSaleSecuritiesDebtSecuritiesCurrent",
  "DebtSecuritiesCurrent",
];
/** 장기 투자증권(채권형) — 최댓값. LongTermInvestments 는 넣지 않는다(위 설명). */
const LT_SECURITIES = [
  "MarketableSecuritiesNoncurrent",
  "AvailableForSaleSecuritiesDebtSecuritiesNoncurrent",
  "DebtSecuritiesNoncurrent",
];
const PREFERRED = ["PreferredStockValue", "PreferredStockValueOutstanding"];
/** 파트너십(ET 등)은 우선 지분을 별도 태그로 단다 — 위와 합산. */
const PREFERRED_UNITS = ["PreferredUnitsPreferredPartnersCapitalAccounts"];
const NCI = ["MinorityInterest", "PartnersCapitalAttributableToNoncontrollingInterest"];
/** UP-REIT 의 운영 파트너십 지분(장부가) — 시가로 대체할 때 NCI 에서 뺀다. */
const NCI_OP_UNITS = ["MinorityInterestInOperatingPartnerships"];

/** 감가상각비 합계 태그 — 같은 기간에 여럿이면 **최댓값**.
 *  MCD 는 DepreciationDepletionAndAmortization(4.6억, 일부 항목)과
 *  DepreciationAndAmortization(22억, 전체)을 동시에 단다. 200종목 실측에서
 *  "앞 태그 우선"보다 나빠진 종목 0개, CRM·MCK·UPS·VST 등 8종목 개선. */
export const DA_TOTAL = [
  "DepreciationDepletionAndAmortization",
  "DepreciationAmortizationAndAccretionNet",
  "DepreciationAndAmortization",
  "DepreciationAmortizationAndOther",
  "CostDepreciationAmortizationAndDepletion",
];
export const DA_DEPRECIATION = ["Depreciation", "DepreciationNonproduction"];
export const DA_INTANGIBLE = "AmortizationOfIntangibleAssets";
/** 구성항목(감가상각+무형자산상각) 합이 합계 태그보다 이만큼 크면 합계 태그가
 *  무형자산상각을 빠뜨린 것(TTWO·HD·HUM)으로 보고 구성항목 합을 쓴다. */
const DA_COMPONENT_MARGIN = 1.02;

/**
 * 이자부 차입금(+금융리스) 계산 — 값 조회 함수만 받는다. companyfacts(연결)와
 * XBRL 인스턴스의 부문별 값(금융 자회사, edgar-captive.ts) 양쪽에서 같은 규칙을
 * 쓰기 위해 분리했다. 태그가 하나도 없으면 null.
 */
export function resolveDebt(
  get: (concept: string) => number | null,
): { debt: number; noncurrent: number | null; partial: boolean } | null {
  const first = (cs: string[]) => {
    for (const c of cs) {
      const v = get(c);
      if (v != null) return { c, v };
    }
    return null;
  };
  const sum = (cs: string[]) => cs.reduce((s, c) => s + (get(c) ?? 0), 0);
  const nc = first(DEBT_NONCURRENT);
  const cur = first(DEBT_CURRENT);
  const tot = nc ? null : first(DEBT_TOTAL);
  if (!nc && !cur && !tot && SHORT_BORROWINGS.every((c) => get(c) == null)) return null;
  const stb = cur?.c === "DebtCurrent" ? 0 : sum(SHORT_BORROWINGS);
  let debt: number;
  let usedCombinedLease = nc?.c === "LongTermDebtAndCapitalLeaseObligations";
  let partial = false;
  if (nc) {
    debt = nc.v + (cur?.v ?? 0) + stb;
  } else if (tot?.c === "NotesPayable") {
    // 리츠 O: 어음·대출금은 합계 태그가 있지만 기간대출은 건별로만 있다.
    partial = true;
    debt = tot.v + (get("LoansPayable") ?? 0) + stb;
  } else if (tot) {
    if (tot.c === "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities")
      usedCombinedLease = true;
    // 합계 태그는 유동성 장기차입금을 포함하므로 단기차입금·CP 만 더한다.
    debt = tot.v + stb;
  } else {
    debt = (cur?.v ?? 0) + stb;
  }
  if (!usedCombinedLease) debt += sum(FIN_LEASE);
  // 비유동 차입금(+비유동 금융리스) — "장기차입금" 지표용. 비유동/유동 구분 없이
  // 합계 태그만 있는 회사는 가를 수 없어 null.
  const noncurrent = nc
    ? nc.v + (usedCombinedLease ? 0 : (get("FinanceLeaseLiabilityNoncurrent") ?? 0))
    : null;
  return { debt, noncurrent, partial };
}

// ── 기본 조회 헬퍼 ────────────────────────────────────────────────────

/** 기준일 ±6일 안의 시점 값 (분기말 표기가 하루이틀 어긋나는 회사 대응). */
function instantOn(entries: FactUnitEntry[], date: string): number | null {
  let best: { val: number; d: number; filed: string } | null = null;
  for (const e of entries) {
    if (e.start || e.val == null || !e.end) continue;
    const d = Math.abs(Date.parse(e.end) - Date.parse(date)) / 86_400_000;
    if (d > 6) continue;
    const filed = e.filed ?? "";
    if (!best || d < best.d || (d === best.d && filed >= best.filed))
      best = { val: e.val, d, filed };
  }
  return best?.val ?? null;
}

// ── 공개 타입 ─────────────────────────────────────────────────────────

/**
 * EV 를 계산할 수 없는 이유. null 이면 계산 가능.
 * - financial: 은행·카드사(차입금이 영업용) — 기존 isFinancialCompany 판정
 * - captive-unsplit: 금융 자회사가 있는데 XBRL 에서 부문 구분이 안 됨(DE)
 * - debt-untagged: 차입금이 있는데 표준 태그가 없음(Ford — 부문별로만 태깅)
 */
export type EvBlocker = "financial" | "captive-unsplit" | "debt-untagged";

export interface EvBridge {
  /** 재무상태표 값을 실제로 가져온 날짜 */
  balanceDate: string;
  /** 요청 기준일에 값이 없어 이전 연말 값을 썼는지 (CAT·CVX·TMUS·ORCL — 10-K 만 태깅) */
  stale: boolean;
  /** 이자부 차입금 + 금융리스 (금융 자회사가 있으면 제조 부문분만) */
  debt: number;
  /** 비유동 차입금(+비유동 금융리스) — 운용리스 제외. 구분 불가면 null */
  debtNoncurrent: number | null;
  /** 운용리스 부채(유동+비유동) — 차입금에는 넣지 않고 주석 표시용. 미공시면 null */
  operatingLease: number | null;
  /** 현금 + 단기투자 + 장기 투자증권 */
  cash: number;
  preferred: number;
  /** 비지배지분 (UP-REIT 운영 파트너십 지분을 시가로 대체한 경우 그 장부가는 제외) */
  nci: number;
  /** 차입금 일부가 개별 대출 건별로만 태깅돼 합계가 과소할 수 있음(리츠 O) */
  debtPartial: boolean;
  /** 금융 자회사 차입금을 제외했다면 그 금액 */
  captiveDebtExcluded: number | null;
  /** 운영 파트너십 지분 장부가(비지배지분 중) — 파트너 지분을 시가로 더할 때 빼야 이중 계산이 없다 */
  opUnitNciBook: number;
}

/** 금융 자회사 부문 차입금 (XBRL 인스턴스에서 부문 차원으로 추출). */
export interface CaptiveDebtPoint {
  /** 재무상태표 기준일 */
  date: string;
  /** 제조(비금융) 부문 이자부 차입금 */
  industrialDebt: number;
  /** 금융 부문 차입금 (표시·감사용) */
  financialDebt: number;
}

export interface EvContext {
  /** SEC SIC 코드 */
  sic?: string | null;
  /** 은행·카드사 등 — 호출 측의 isFinancialCompany 결과 */
  isFinancial?: boolean;
  /** 금융 자회사 판정 결과. null 이면 금융 자회사 없음. */
  captive?: { points: CaptiveDebtPoint[] } | "unsplit" | null;
  /**
   * UP-REIT 운영 파트너십 지분 수(Yahoo impliedShares − sharesOutstanding).
   * 리츠(SIC 6798)만 호출 측이 넘긴다 — 일반 기업은 implied 가 다른 뜻
   * (GOOGL 은 전 클래스 합)이라 파트너 지분으로 오인하면 안 된다.
   */
  opUnits?: number | null;
}

export interface EvResolver {
  /** 가장 최근 재무상태표 기준일 (Assets 기준 — 현금 태그 기준이면 GE 가 2017년이 된다) */
  latestBalanceDate(): string | null;
  /** EV 를 계산할 수 없으면 그 이유, 가능하면 null */
  blocker(asOf: string): EvBlocker | null;
  /** 기준일의 EV 브릿지. 계산 불가(blocker)면 null. */
  bridgeAt(asOf: string): EvBridge | null;
  /** 시가총액(보통주) → EV. UP-REIT 는 파트너 지분 시가를 더한다. 계산 불가면 null. */
  evAt(asOf: string, commonMarketCap: number | null, price: number | null): number | null;
}

// ── 리졸버 ────────────────────────────────────────────────────────────

export function buildEvResolver(facts: CompanyFacts, ctx: EvContext = {}): EvResolver {
  const E = (c: string) => entriesOf(facts, c);
  const on = (c: string, d: string) => instantOn(E(c), d);
  const firstOn = (cs: string[], d: string): { c: string; v: number } | null => {
    for (const c of cs) {
      const v = on(c, d);
      if (v != null) return { c, v };
    }
    return null;
  };
  const maxOn = (cs: string[], d: string): number => {
    let m = 0;
    for (const c of cs) {
      const v = on(c, d);
      if (v != null && v > m) m = v;
    }
    return m;
  };
  const sumOn = (cs: string[], d: string): number => {
    let s = 0;
    for (const c of cs) s += on(c, d) ?? 0;
    return s;
  };

  const assets = E("Assets");
  const latest = (() => {
    let best: string | null = null;
    for (const e of assets) if (!e.start && e.end && (!best || e.end > best)) best = e.end;
    return best;
  })();

  /** 날짜 d 에 차입금 태그가 있는가 */
  const hasDebtOn = (d: string) => ANY_DEBT.some((c) => on(c, d) != null);

  /** 요청일에 없으면 1년 안쪽의 가장 최근 연말(10-K) 날짜로 폴백. */
  const debtDateFor = (asOf: string): { date: string; stale: boolean } | null => {
    if (hasDebtOn(asOf)) return { date: asOf, stale: false };
    let best: string | null = null;
    for (const c of ANY_DEBT)
      for (const e of E(c)) {
        if (e.start || !e.end || e.end > asOf) continue;
        const age = (Date.parse(asOf) - Date.parse(e.end)) / 86_400_000;
        if (age > 400) continue;
        if (!best || e.end > best) best = e.end;
      }
    return best ? { date: best, stale: true } : null;
  };

  /** 최근 1년 차입·상환·이자 흐름이 있는가 (Ford 형 판정) */
  const hasDebtActivity = (asOf: string): boolean =>
    DEBT_ACTIVITY.some((c) =>
      E(c).some((e) => {
        if (!e.start || !e.end || !e.val) return false;
        const age = (Date.parse(asOf) - Date.parse(e.end)) / 86_400_000;
        return age >= -6 && age <= 400;
      }),
    );

  const debtOn = (d: string) => resolveDebt((c) => on(c, d));

  const cashOn = (d: string): number | null => {
    const c = firstOn(CASH, d);
    if (c == null) return null;
    return c.v + maxOn(STI, d) + maxOn(LT_SECURITIES, d);
  };
  const cashDateFor = (asOf: string): { date: string; stale: boolean } | null => {
    if (firstOn(CASH, asOf)) return { date: asOf, stale: false };
    // TT: 분기 보고서에 현금 태그가 없고 10-K 에만 있다.
    let best: string | null = null;
    for (const c of CASH)
      for (const e of E(c)) {
        if (e.start || !e.end || e.end > asOf) continue;
        if ((Date.parse(asOf) - Date.parse(e.end)) / 86_400_000 > 400) continue;
        if (!best || e.end > best) best = e.end;
      }
    return best ? { date: best, stale: true } : null;
  };

  const captivePoint = (d: string): CaptiveDebtPoint | null => {
    if (!ctx.captive || ctx.captive === "unsplit") return null;
    for (const p of ctx.captive.points)
      if (Math.abs(Date.parse(p.date) - Date.parse(d)) / 86_400_000 <= 6) return p;
    return null;
  };

  const blocker = (asOf: string): EvBlocker | null => {
    if (ctx.isFinancial) return "financial";
    if (ctx.captive === "unsplit") return "captive-unsplit";
    // **임시(오너 지시 2026-09-23 — "ev/ebitda 최종은 뒤로 미루고")**: 금융
    // 자회사가 있으면 부문 분리가 되더라도 EV 를 비운다. 차입금만 제조 부문으로
    // 빼면 EBITDA 는 연결 기준이라 리스 차량 감가상각(GM 약 70억 달러)이 섞여
    // EV/EBITDA 가 GM 1.8배·포드 1.79배처럼 무의미해진다. 제조 부문 현금·EBITDA·
    // 금융 자회사 자본까지 맞출지 최종 방식이 정해지면 이 줄을 걷어낸다.
    // (부문 분리 로직 captivePoint·industrialDebt 는 그때 쓰려고 남겨 둔다.)
    if (ctx.captive) return "captive-unsplit";
    if (!ctx.captive && !debtDateFor(asOf) && hasDebtActivity(asOf)) return "debt-untagged";
    return null;
  };

  const bridgeAt = (asOf: string): EvBridge | null => {
    if (blocker(asOf)) return null;
    const cp = captivePoint(asOf);
    const dd = cp ? { date: asOf, stale: false } : debtDateFor(asOf);
    const cd = cashDateFor(asOf);
    // 차입금 날짜 기준으로 나머지를 맞춘다 (없으면 현금 날짜, 둘 다 없으면 요청일)
    const bal = dd?.date ?? cd?.date ?? asOf;
    const { debt: rawDebt, noncurrent, partial } = (dd ? debtOn(dd.date) : null) ?? {
      debt: 0,
      noncurrent: null,
      partial: false,
    };
    const olNc = on("OperatingLeaseLiabilityNoncurrent", bal);
    const olCur = on("OperatingLeaseLiabilityCurrent", bal);
    const operatingLease =
      olNc != null || olCur != null ? (olNc ?? 0) + (olCur ?? 0) : on("OperatingLeaseLiability", bal);
    const debt = cp ? cp.industrialDebt : rawDebt;
    const cash = cd ? (cashOn(cd.date) ?? 0) : 0;
    const preferred = (firstOn(PREFERRED, bal)?.v ?? 0) + sumOn(PREFERRED_UNITS, bal);
    let nci = firstOn(NCI, bal)?.v ?? 0;
    const opUnitNciBook = on(NCI_OP_UNITS[0], bal) ?? 0;
    if (ctx.opUnits && ctx.opUnits > 0) nci = Math.max(0, nci - opUnitNciBook);
    return {
      balanceDate: bal,
      stale: Boolean(dd?.stale || cd?.stale),
      debt,
      debtNoncurrent: cp ? null : noncurrent,
      operatingLease,
      cash,
      preferred,
      nci,
      debtPartial: partial,
      captiveDebtExcluded: cp ? cp.financialDebt : null,
      opUnitNciBook,
    };
  };

  return {
    latestBalanceDate: () => latest,
    blocker,
    bridgeAt,
    evAt(asOf, commonMarketCap, price) {
      const b = bridgeAt(asOf);
      if (!b || commonMarketCap == null) return null;
      const opValue = ctx.opUnits && ctx.opUnits > 0 && price != null ? ctx.opUnits * price : 0;
      return commonMarketCap + opValue + b.debt + b.preferred + b.nci - b.cash;
    },
  };
}

// ── 감가상각비 (EBITDA 용) ────────────────────────────────────────────

/**
 * 한 기간의 감가상각비 판정 — 규칙 C. 합계 태그 값들(같은 기간) 중 최댓값,
 * 단 감가상각+무형상각 구성항목 합이 그보다 2% 넘게 크면 그 합(합계 태그가
 * 무형상각을 빠뜨린 경우). 합계 태그가 없으면 구성항목 합.
 * 연간·TTM·분기 어디서나 같은 판정을 쓰도록 값만 받는다.
 */
export function pickDa(
  totals: (number | null | undefined)[],
  depreciation: number | null | undefined,
  intangible: number | null | undefined,
): number | null {
  const tv = totals.filter((v): v is number => v != null);
  const total = tv.length ? Math.max(...tv) : null;
  const comp =
    depreciation != null || intangible != null ? (depreciation ?? 0) + (intangible ?? 0) : null;
  if (total == null) return comp;
  if (comp != null && depreciation != null && intangible != null && comp > total * DA_COMPONENT_MARGIN)
    return comp;
  return total;
}

/** 연도별 감가상각비 (pickDa 규칙). */
export function daAnnualByYear(facts: CompanyFacts): Map<number, number> {
  const out = new Map<number, number>();
  const totals = DA_TOTAL.map((c) => annualByYear(entriesOf(facts, c)));
  const dep = (() => {
    for (const c of DA_DEPRECIATION) {
      const m = annualByYear(entriesOf(facts, c));
      if (m.size) return m;
    }
    return new Map<number, number>();
  })();
  const am = annualByYear(entriesOf(facts, DA_INTANGIBLE));
  const years = new Set<number>([...totals.flatMap((m) => [...m.keys()]), ...dep.keys(), ...am.keys()]);
  for (const y of years) {
    const v = pickDa(totals.map((m) => m.get(y)), dep.get(y), am.get(y));
    if (v != null) out.set(y, v);
  }
  return out;
}

/** 최근 12개월 감가상각비 (pickDa 규칙). */
export function daTtm(facts: CompanyFacts): number | null {
  const dep = (() => {
    for (const c of DA_DEPRECIATION) {
      const v = ttmOf(entriesOf(facts, c));
      if (v != null) return v;
    }
    return null;
  })();
  return pickDa(
    DA_TOTAL.map((c) => ttmOf(entriesOf(facts, c))),
    dep,
    ttmOf(entriesOf(facts, DA_INTANGIBLE)),
  );
}

// ── 영업이익 (EBITDA 용) ──────────────────────────────────────────────

const PRETAX = [
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesAndExtraordinaryItemsNoncontrollingInterest",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndEquityMethodInvestments",
];

/**
 * 연도별 영업이익 — 하이라이트 규칙과 동일: OperatingIncomeLoss → (태그 자체가
 * 없으면) 매출총이익 − 판관비 − 연구개발비 → 그래도 없는 연도는 세전이익.
 * 컨센서스 표가 하이라이트와 같은 EBITDA 를 쓰도록 공유한다(GE 는 영업이익
 * 태그를 중단해 최근 연도가 세전이익으로 채워진다).
 */
export function opIncomeAnnualByYear(facts: CompanyFacts): Map<number, number> {
  const out = new Map(annualByYear(entriesOf(facts, "OperatingIncomeLoss")));
  if (!out.size) {
    const gp = annualByYear(entriesOf(facts, "GrossProfit"));
    const merged = (cs: string[]) => {
      const m = new Map<number, number>();
      for (const c of cs) for (const [y, v] of annualByYear(entriesOf(facts, c))) if (!m.has(y)) m.set(y, v);
      return m;
    };
    const sga = merged(["SellingGeneralAndAdministrativeExpense", "GeneralAndAdministrativeExpense"]);
    const rnd = annualByYear(entriesOf(facts, "ResearchAndDevelopmentExpense"));
    for (const [y, g] of gp) out.set(y, g - (sga.get(y) ?? 0) - (rnd.get(y) ?? 0));
  }
  for (const c of PRETAX)
    for (const [y, v] of annualByYear(entriesOf(facts, c))) if (!out.has(y)) out.set(y, v);
  return out;
}

// ── 모기지 리츠 판정 ──────────────────────────────────────────────────

/**
 * 모기지 리츠(NLY·AGNC 등) — 종목분석 대상에서 제외한다(오너 결정 2026-09-23:
 * "해당 종목은 지원되지 않습니다" 팝업). 부동산이 아니라 모기지 채권에 투자하고
 * 레포로 조달해 차입금이 영업용이다(은행과 같은 구조).
 *
 * SIC 는 지분형 리츠와 같은 6798 이라 재무 구성으로 가른다. 실측: 알려진 모기지
 * 리츠 20개 중 18개 판정(놓친 ARI 는 자산 58%가 현금·40%가 압류 부동산으로
 * 대출 사업을 사실상 정리한 상태, EFC 는 SIC 6500), 지분형 리츠 57개 오탐 0.
 */
export function isMortgageReit(facts: CompanyFacts, sic: string | null | undefined): boolean {
  if (sic !== "6798") return false;
  if (!entriesOf(facts, "InterestIncomeExpenseNet").length) return false;
  let d: string | null = null;
  for (const e of entriesOf(facts, "Assets")) if (!e.start && e.end && (!d || e.end > d)) d = e.end;
  if (!d) return false;
  const a = instantOn(entriesOf(facts, "Assets"), d);
  if (!a) return false;
  const maxOf = (cs: string[]) =>
    Math.max(0, ...cs.map((c) => instantOn(entriesOf(facts, c), d!) ?? 0));
  const repo = maxOf([
    "SecuritiesSoldUnderAgreementsToRepurchase",
    "SecuritiesSoldUnderAgreementsToRepurchaseCarryingAmount",
  ]);
  const fin = maxOf([
    "AvailableForSaleSecuritiesDebtSecurities",
    "AvailableForSaleSecurities",
    "MarketableSecurities",
    "DebtSecuritiesAvailableForSaleExcludingAccruedInterest",
    "LoansAndLeasesReceivableNetReportedAmount",
    "LoansReceivableHeldForInvestmentNet",
    "FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLoss",
    "MortgageLoansOnRealEstateCommercialAndConsumerNet",
    "TradingSecurities",
    "HeldToMaturitySecurities",
    "MortgageLoansOnRealEstate",
    "LoansAndLeasesReceivableNetOfDeferredIncome",
  ]);
  if (repo / a >= 0.1 || fin / a >= 0.1) return true;
  // 이자수익 비중 (RC 처럼 대출 태그가 후보 밖인 경우)
  const annualLatest = (c: string) => {
    const m = annualByYear(entriesOf(facts, c));
    const ys = [...m.keys()].sort((x, y) => y - x);
    return ys.length ? m.get(ys[0])! : null;
  };
  const interest = Math.max(
    0,
    ...[
      "InterestAndDividendIncomeOperating",
      "InterestIncomeOperating",
      "InterestAndFeeIncomeLoansAndLeases",
      "InterestIncome",
    ].map((c) => annualLatest(c) ?? 0),
  );
  const revenue = Math.max(
    0,
    ...["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "OperatingLeaseLeaseIncome"].map(
      (c) => annualLatest(c) ?? 0,
    ),
  );
  const denom = Math.max(revenue, interest);
  return denom > 0 && interest / denom >= 0.5;
}

// ── UP-REIT 운영 파트너십 지분 ────────────────────────────────────────

/** 리츠(SIC 6798)의 운영 파트너십 지분 수 — 규칙은 op-units.ts 참고. */
export function reitOpUnits(
  sic: string | null | undefined,
  sharesOutstanding: number | null | undefined,
  impliedShares: number | null | undefined,
): number | null {
  return opUnitsFrom(sic === "6798", sharesOutstanding, impliedShares);
}
