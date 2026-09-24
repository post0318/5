import "server-only";
import { fetchFxToUsdDaily } from "../quote/yahoo";
import type { CompanyFacts, FactUnitEntry } from "./edgar";

/**
 * **외화·IFRS 공시 정규화** — 미국 상장 외국 기업(ASML·TSM·SPOT 등)의 SEC 재무를 앱의 나머지
 * 모듈이 그대로 읽을 수 있는 모양(us-gaap 개념 · USD)으로 바꾼다. companyfacts 로더에서
 * 한 번만 적용하므로 하이라이트·재무제표·분석·개요·컨센서스가 모두 같은 환산값을 쓴다.
 *
 * 왜(검증 2026-09-24) — 앱은 us-gaap 개념의 USD 단위만 읽어서, 유로로 공시하는 ASML(US-GAAP)
 * 과 IFRS 로 공시하는 TSM(대만달러)·SPOT(유로)은 연도 열이 통째로 비고 차입금·현금이 0 이었다.
 *
 * 환산 방식(오너 결정 2026-09-24 — "다른 사이트 확인 후 적용", 인포맥스와 같은 방식):
 *   - 기간 값(손익·현금흐름·주당이익) = 그 기간의 **평균 환율**(일별 종가 평균)
 *   - 시점 값(재무상태표) = 그 날짜(이전 최근 영업일)의 **환율**
 *   인포맥스 역산 환율이 이 두 값과 0.1~0.3% 안에서 일치했다(ASML·SPOT·TSM·SKHY 실측).
 *   Yahoo·MarketScreener·StockAnalysis 는 환산하지 않고 원통화로 보여준다.
 * 20-F 의 USD "편의 환산" 태그(TSM 이 원통화와 함께 단다)는 단일 환율 일괄 환산이라 쓰지 않는다.
 *
 * IFRS → us-gaap 개념 매핑은 앱이 읽는 핵심 항목만. IFRS 는 리스를 구분하지 않고 EBITDA 에
 * 리스비용이 빠져 있으므로 리스부채를 차입금에 넣는다(한국 IFRS 와 같은 규칙, CLAUDE.md B16).
 */

type Units = Record<string, FactUnitEntry[]>;
type Ns = Record<string, { label?: string; description?: string; units: Units }>;

/** IFRS 개념 → us-gaap 개념(단순 대응). 같은 대상이 여러 번 나오면 앞 개념 우선, 빈 기간만 뒤 개념으로 */
const IFRS_MAP: [string, string][] = [
  ["Revenue", "Revenues"],
  // TSM 2025 20-F 는 Revenue 없이 이 개념만 달았다(검증 2026-09-24)
  ["RevenueFromContractsWithCustomers", "Revenues"],
  ["CostOfSales", "CostOfRevenue"],
  ["GrossProfit", "GrossProfit"],
  ["ProfitLossFromOperatingActivities", "OperatingIncomeLoss"],
  ["ProfitLossBeforeTax", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest"],
  ["IncomeTaxExpenseContinuingOperations", "IncomeTaxExpenseBenefit"],
  ["ProfitLoss", "ProfitLoss"],
  ["ProfitLossAttributableToOwnersOfParent", "NetIncomeLoss"],
  ["ProfitLossAttributableToNoncontrollingInterests", "NetIncomeLossAttributableToNoncontrollingInterest"],
  ["BasicEarningsLossPerShare", "EarningsPerShareBasic"],
  ["DilutedEarningsLossPerShare", "EarningsPerShareDiluted"],
  ["WeightedAverageShares", "WeightedAverageNumberOfSharesOutstandingBasic"],
  ["Assets", "Assets"],
  ["CurrentAssets", "AssetsCurrent"],
  ["Liabilities", "Liabilities"],
  ["CurrentLiabilities", "LiabilitiesCurrent"],
  ["NoncurrentLiabilities", "LiabilitiesNoncurrent"],
  ["EquityAttributableToOwnersOfParent", "StockholdersEquity"],
  ["Equity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  ["NoncontrollingInterests", "MinorityInterest"],
  ["EquityAndLiabilities", "LiabilitiesAndStockholdersEquity"],
  ["CashAndCashEquivalents", "CashAndCashEquivalentsAtCarryingValue"],
  ["CashFlowsFromUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivities"],
  ["PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities", "PaymentsToAcquirePropertyPlantAndEquipment"],
  ["DividendsPaidClassifiedAsFinancingActivities", "PaymentsOfDividends"],
  ["ShorttermBorrowings", "ShortTermBorrowings"],
  // IFRS 16 리스 = 차입금 성격(구분 없음) → 금융리스 개념으로 넣어 차입금에 포함
  ["CurrentLeaseLiabilities", "FinanceLeaseLiabilityCurrent"],
  ["NoncurrentLeaseLiabilities", "FinanceLeaseLiabilityNoncurrent"],
  ["NumberOfSharesOutstanding", "CommonStockSharesOutstanding"],
];
/** 여러 IFRS 개념의 합 → us-gaap 개념 (같은 기간끼리) */
const IFRS_SUM: [string[], string][] = [
  [["NoncurrentPortionOfNoncurrentBondsIssued", "LongtermBorrowings"], "LongTermDebtNoncurrent"],
  [["CurrentBondsIssuedAndCurrentPortionOfNoncurrentBondsIssued", "CurrentPortionOfLongtermBorrowings", "CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings"], "LongTermDebtCurrent"],
  [["DepreciationExpense", "AmortisationExpense"], "DepreciationDepletionAndAmortization"],
  [["AdjustmentsForDepreciationExpense", "AdjustmentsForAmortisationExpense"], "DepreciationDepletionAndAmortization"],
  // 한국 IFRS 현금성자산과 같은 범위 — 현금 외 유동 상각후원가·당기손익 금융자산
  [["CurrentFinancialAssetsAtAmortisedCost", "CurrentFinancialAssetsAtFairValueThroughProfitOrLoss"], "ShortTermInvestments"],
];

const isCurrency = (u: string) => /^[A-Z]{3}$/.test(u);

/** 보고 통화 — 매출·자산·순이익 개념의 USD 외 통화 단위 중 가장 많은 것. 없으면 null(USD 공시). */
export function reportingCurrency(facts: CompanyFacts): string | null {
  const count = new Map<string, number>();
  const probe: [string, string[]][] = [
    ["us-gaap", ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "Assets", "NetIncomeLoss", "ProfitLoss"]],
    ["ifrs-full", ["Revenue", "Assets", "ProfitLoss", "ProfitLossAttributableToOwnersOfParent"]],
  ];
  const f = facts.facts as Record<string, Ns | undefined>;
  for (const [ns, tags] of probe)
    for (const t of tags)
      for (const [u, arr] of Object.entries(f[ns]?.[t]?.units ?? {}))
        if (isCurrency(u) && u !== "USD") count.set(u, (count.get(u) ?? 0) + arr.length);
  if (!count.size) return null;
  return [...count].sort((a, b) => b[1] - a[1])[0][0];
}

/** IFRS 개념을 us-gaap 이름으로(이미 us-gaap 에 있는 개념은 건드리지 않음) */
function mapIfrs(gaap: Ns, ifrs: Ns): Ns {
  const out: Ns = { ...gaap };
  const pkey = (e: FactUnitEntry) => `${e.start ?? ""}|${e.end}`;
  const mappedHere = new Set<string>();
  for (const [src, dst] of IFRS_MAP) {
    if (!ifrs[src]) continue;
    if (out[dst] && !mappedHere.has(dst)) continue; // us-gaap 원본이 있으면 건드리지 않음
    if (!out[dst]) {
      out[dst] = { units: ifrs[src].units };
      mappedHere.add(dst);
      continue;
    }
    // 앞 개념이 비운 기간만 이 개념으로 채운다
    const units: Units = { ...out[dst].units };
    for (const [u, arr] of Object.entries(ifrs[src].units)) {
      const have = new Set((units[u] ?? []).map(pkey));
      units[u] = [...(units[u] ?? []), ...arr.filter((e) => !have.has(pkey(e)))];
    }
    out[dst] = { units };
  }
  for (const [srcs, dst] of IFRS_SUM) {
    if (out[dst]) continue;
    const present = srcs.filter((s) => ifrs[s]);
    if (!present.length) continue;
    const units: Units = {};
    for (const s of present)
      for (const [u, arr] of Object.entries(ifrs[s].units)) {
        const k = (e: FactUnitEntry) => `${e.start ?? ""}|${e.end}|${e.form}|${e.filed ?? ""}`;
        // 한 개념 안에서 같은 기간·공시가 반복되면 하나만 — 반복분까지 더해 두 배가 되지 않게
        const uniq = new Map<string, FactUnitEntry>();
        for (const e of arr) if (!uniq.has(k(e))) uniq.set(k(e), e);
        const acc = new Map<string, FactUnitEntry>();
        for (const e of units[u] ?? []) acc.set(k(e), e);
        for (const e of uniq.values()) {
          const p = acc.get(k(e));
          acc.set(k(e), p ? { ...p, val: p.val + e.val } : { ...e });
        }
        units[u] = [...acc.values()];
      }
    out[dst] = { units };
  }
  return out;
}

// ── 환율 ──────────────────────────────────────────────────────────────
const FX_TTL = 1000 * 60 * 60 * 12;
const fxCache = new Map<string, { at: number; data: { date: string; rate: number }[] }>();
async function fxSeries(cur: string) {
  const hit = fxCache.get(cur);
  if (hit && Date.now() - hit.at < FX_TTL) return hit.data;
  const data = await fetchFxToUsdDaily(cur);
  fxCache.set(cur, { at: Date.now(), data });
  return data;
}
function rateAt(s: { date: string; rate: number }[], date: string): number | null {
  let lo = 0, hi = s.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid].date <= date) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best < 0) return null;
  // 기준일에서 10일 넘게 떨어진 환율은 쓰지 않는다(데이터 공백)
  return (Date.parse(date) - Date.parse(s[best].date)) / 864e5 <= 10 ? s[best].rate : null;
}
function avgRate(s: { date: string; rate: number }[], start: string, end: string): number | null {
  let sum = 0, n = 0;
  for (const q of s) if (q.date >= start && q.date <= end) { sum += q.rate; n++; }
  // 기간 영업일의 절반도 없으면 평균을 믿지 않는다
  const days = (Date.parse(end) - Date.parse(start)) / 864e5;
  return n > 0 && n >= days * 0.3 ? sum / n : null;
}

function convertNs(ns: Ns, cur: string, fx: { date: string; rate: number }[]): Ns {
  const out: Ns = {};
  for (const [concept, node] of Object.entries(ns)) {
    const units = node.units ?? {};
    if (!units[cur] && !units[`${cur}/shares`]) { out[concept] = node; continue; }
    const nu: Units = {};
    for (const [u, arr] of Object.entries(units)) {
      // 원통화가 있는 개념의 USD 단위는 20-F 편의 환산(단일 환율) — 버리고 직접 환산한 값만 쓴다
      if (u === "USD" && units[cur]) continue;
      if (u === "USD/shares" && units[`${cur}/shares`]) continue;
      if (u !== cur && u !== `${cur}/shares`) { nu[u] = arr; continue; }
      const target = u === cur ? "USD" : "USD/shares";
      const conv: FactUnitEntry[] = [];
      for (const e of arr) {
        const r = e.start ? avgRate(fx, e.start, e.end) : rateAt(fx, e.end);
        if (r == null) continue; // 환율 없는 기간은 버린다(원통화 그대로 USD 로 섞지 않음)
        conv.push({ ...e, val: e.val * r });
      }
      nu[target] = [...(nu[target] ?? []), ...conv];
    }
    out[concept] = { ...node, units: nu };
  }
  return out;
}

/**
 * 외화·IFRS 정규화. USD·us-gaap 공시 회사는 그대로 돌려준다. 환율 조회에 실패하면 예외를
 * 던진다 — 원통화 숫자를 USD 로 착각해 쓰느니 빈 화면이 낫다(로더가 원본을 쓰지 않도록).
 */
export async function withForeignNormalization(facts: CompanyFacts): Promise<CompanyFacts> {
  const cur = reportingCurrency(facts);
  const f = facts.facts as Record<string, Ns | undefined>;
  const ifrs = f["ifrs-full"];
  if (!cur && !ifrs) return facts;
  let gaap: Ns = { ...(f["us-gaap"] ?? {}) };
  if (ifrs) gaap = mapIfrs(gaap, ifrs);
  let dei = f.dei ?? {};
  if (cur) {
    const fx = await fxSeries(cur);
    gaap = convertNs(gaap, cur, fx);
    dei = convertNs(dei, cur, fx);
  }
  return {
    ...facts,
    reportingCurrency: cur ?? "USD",
    ifrsMapped: Boolean(ifrs),
    facts: { ...facts.facts, "us-gaap": gaap, dei },
  } as CompanyFacts;
}

/**
 * ADR 1주 기준으로 — 주식수(shares)는 ÷비율, 주당 값(USD/shares)은 ×비율.
 * TSM 1 ADR = 보통주 5주: EDGAR 는 보통주 기준이라 ADR 가격과 곱하면 5배가 된다.
 * 비율 = 최근 표지 주식수(보통주) ÷ 현재 ADR 주식수(인포맥스·Yahoo). 1.5배 안이면 1:1.
 */
export function toAdrBasis(facts: CompanyFacts, adrShares: number | null | undefined): { facts: CompanyFacts; ratio: number } {
  const dei = (facts.facts.dei?.EntityCommonStockSharesOutstanding?.units?.shares ?? []) as FactUnitEntry[];
  const last = dei.reduce<FactUnitEntry | null>((b, e) => (!b || e.end > b.end ? e : b), null);
  if (!last || !adrShares || !/^20-F/.test(last.form ?? "")) return { facts, ratio: 1 };
  const ratio = last.val / adrShares;
  if (ratio <= 1.5 && ratio >= 1 / 1.5) return { facts, ratio: 1 };
  const scale = (ns: Ns | undefined): Ns | undefined => {
    if (!ns) return ns;
    const out: Ns = {};
    for (const [c, node] of Object.entries(ns)) {
      const nu: Units = {};
      for (const [u, arr] of Object.entries(node.units ?? {}))
        nu[u] = u === "shares" ? arr.map((e) => ({ ...e, val: e.val / ratio }))
          : /\/shares$/.test(u) ? arr.map((e) => ({ ...e, val: e.val * ratio }))
          : arr;
      out[c] = { ...node, units: nu };
    }
    return out;
  };
  const f = facts.facts as Record<string, Ns | undefined>;
  return {
    ratio,
    facts: { ...facts, adrRatio: ratio, facts: { ...facts.facts, "us-gaap": scale(f["us-gaap"]), dei: scale(f.dei) } } as CompanyFacts,
  };
}


/**
 * Yahoo 예상치(매출·EPS)를 USD 로 — 외화 공시 기업만. 실측 규칙(인포맥스 USD 컨센서스와 대조,
 * 2026-09-24): 매출 예상은 항상 재무 통화(TSM 대만달러·ASML 유로). EPS 예상은 ADR 비율이 1 이
 * 아니면 이미 ADR 1주당 USD(TSM 16.93 ≈ 인포맥스 16.78), 1:1 상장이면 재무 통화(ASML 38.33 유로
 * × 1.147 ≈ 인포맥스 43.97). 예상은 미래 기간이라 **현재 환율**로 환산한다.
 */
export async function estimatesToUsd<
  T extends {
    currency: string;
    periods: { revenueAvg: number | null; revenueLow: number | null; revenueHigh: number | null; epsAvg: number | null; epsLow: number | null; epsHigh: number | null; epsTrend: Record<string, number | null> }[];
    surprises: { epsEstimate: number | null; epsActual: number | null }[];
  },
>(est: T, facts: CompanyFacts): Promise<T & { fxNote?: string }> {
  const cur = facts.reportingCurrency;
  if (!cur || cur === "USD") return est;
  const fx = await fxSeries(cur);
  const last = fx.at(-1);
  if (!last) return est;
  const r = last.rate;
  const epsInUsd = (facts.adrRatio ?? 1) !== 1;
  const m = (v: number | null, k: number) => (v == null ? null : v * k);
  const ek = epsInUsd ? 1 : r;
  return {
    ...est,
    currency: "USD",
    fxNote: `예상(매출${epsInUsd ? "" : "·EPS"}): ${cur} → USD 현재 환율(${last.date} ${Number(r.toPrecision(5))}) 환산${epsInUsd ? " · EPS 는 ADR 1주당 USD 로 제공" : ""}`,
    periods: est.periods.map((p) => ({
      ...p,
      revenueAvg: m(p.revenueAvg, r), revenueLow: m(p.revenueLow, r), revenueHigh: m(p.revenueHigh, r),
      epsAvg: m(p.epsAvg, ek), epsLow: m(p.epsLow, ek), epsHigh: m(p.epsHigh, ek),
      epsTrend: Object.fromEntries(Object.entries(p.epsTrend).map(([k, v]) => [k, m(v, ek)])),
    })),
    surprises: est.surprises.map((s) => ({ ...s, epsEstimate: m(s.epsEstimate, ek), epsActual: m(s.epsActual, ek) })),
  };
}
