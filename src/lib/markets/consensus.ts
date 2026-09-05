import "server-only";
import { getAdapter } from "./registry";
import { getEodQuote } from "./quote";
import { fetchKrxCloseOn } from "./quote/krx";
import { fetchYahooEstimates } from "./quote/yahoo";
import { consensusDeepLinks } from "./deeplinks";
import {
  AdapterError,
  type DeepLink,
  type FinancialStatement,
  type MarketId,
  type QuoteBar,
} from "./types";

/**
 * 컨센서스 패널 데이터 (FnGuide "주가 & 컨센서스" 근사판).
 *  - 실적: OpenDART / EDGAR / EDINET 연간 재무제표
 *  - 추정: yahoo-finance2 earningsTrend (개인용) — 매출·EPS 만. 영업이익·순이익
 *    컨센서스는 무료 소스에 없어 빈칸.
 *  - 연도별 PER/PBR: 각 회계연도 말 시점 주가 기준
 */

const norm = (s: string) => s.replace(/\s/g, "");
const ACCT = {
  revenue: [
    "매출액", "수익(매출액)", "매출", "영업수익",
    "Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax",
    "売上高", "営業収益 (IFRS)",
  ],
  opIncome: [
    "영업이익", "영업이익(손실)", "OperatingIncomeLoss", "Operating Income",
    "営業利益", "営業利益 (IFRS)",
  ],
  netIncome: [
    "당기순이익", "당기순이익(손실)", "연결당기순이익",
    "NetIncomeLoss", "Net Income", "当期利益（親会社の所有者帰属）", "当期純利益",
  ],
  equity: [
    "자본총계", "StockholdersEquity", "Stockholders' Equity",
    "純資産額", "親会社の所有者に帰属する持分",
  ],
  liabilities: ["부채총계", "Liabilities", "Total Liabilities"],
  cash: [
    "현금및현금성자산", "기말현금및현금성자산",
    "CashAndCashEquivalentsAtCarryingValue", "Cash & Equivalents",
  ],
  eps: [
    "희석주당이익", "희석주당순이익", "기본주당이익", "주당이익",
    "EarningsPerShareDiluted", "EarningsPerShareBasic", "EPS (Diluted)",
    "基本的1株当たり当期利益 (円)", "1株当たり当期純利益 (円)",
  ],
};

function valueForYear(
  fs: FinancialStatement,
  fy: number,
  accountIds: string[],
): number | null {
  const label = `FY${fy}`;
  const targets = new Set(accountIds.map(norm));
  for (const sec of fs.sections) {
    for (const it of sec.items) {
      if (!targets.has(norm(it.accountId ?? it.accountName))) continue;
      const v = it.values[label];
      if (v != null) return v;
    }
  }
  return null;
}

function closeFromBars(bars: QuoteBar[], onIso: string): number | null {
  let best: number | null = null;
  for (const b of bars) {
    if (b.date <= onIso && b.close != null) best = b.close;
  }
  return best;
}

export interface ConsensusRow {
  fy: number;
  label: string; // "2024.12"
  isEstimate: boolean;
  revenue: number | null;
  revenueYoY: number | null;
  opIncome: number | null;
  netIncome: number | null;
  eps: number | null;
  bps: number | null;
  per: number | null;
  pbr: number | null;
  roe: number | null;
  evEbitda: number | null;
  /** PER/PBR 계산에 쓴 주가 (실적행=연말가, 추정행=현재가) */
  priceBasis: number | null;
}

export interface ConsensusData {
  currency: string;
  /** 금액 원본 단위 (예: "원") */
  unit: string;
  fiscalMonth: number; // 결산월 (대개 12)
  price: number | null;
  targetPrice: number | null;
  recommendationMean: number | null;
  rows: ConsensusRow[];
  /** 당해년도 EPS 추정치 리비전 (현재/1주전/1개월전/3개월전) + 각 PER */
  epsRevision:
    | { asOf: string[]; eps: (number | null)[]; per: (number | null)[] }
    | null;
  /** 최근 분기 EPS 어닝 서프라이즈 */
  earningsSurprise: {
    period: string;
    epsEstimate: number | null;
    epsActual: number | null;
    surprisePct: number | null;
  }[];
  deepLinks: DeepLink[];
  asOf: string;
  notes: string[];
}

export async function getConsensusData(
  market: MarketId,
  rawSymbol: string,
  yahooOverride?: string | null,
): Promise<ConsensusData> {
  const adapter = getAdapter(market);
  const symbol = adapter.normalizeSymbol(rawSymbol);
  const notes: string[] = [];

  const [annual, quote, estimates] = await Promise.all([
    adapter.getFinancials(symbol, "annual").catch((e) => {
      throw new AdapterError(
        e instanceof AdapterError ? e.message : "연간 재무제표 조회 실패",
        { status: 502 },
      );
    }),
    getEodQuote(market, symbol, { yahooOverride }).catch(() => null),
    fetchYahooEstimates(market, symbol, yahooOverride).catch(() => null),
  ]);
  if (!estimates) notes.push("추정치(yahoo) 조회 실패 — 실적만 표시");

  const price = quote?.last ?? null;
  const shares =
    quote?.sharesOutstanding ??
    (quote?.marketCap != null && price ? quote.marketCap / price : null);
  if (shares == null) notes.push("상장주식수 미확인 — EPS·BPS 일부 공란");

  const fiscalMonth = annual.periods[0]?.endDate
    ? Number(annual.periods[0].endDate.slice(5, 7)) || 12
    : 12;

  // ── 실적 행 ──────────────────────────────────────────────────────
  const years = [...annual.periods.map((p) => p.fiscalYear)]
    .filter((y, i, a) => a.indexOf(y) === i)
    .sort((a, b) => a - b)
    .slice(-4);

  const actualRows: ConsensusRow[] = [];
  for (const fy of years) {
    const revenue = valueForYear(annual, fy, ACCT.revenue);
    const opIncome = valueForYear(annual, fy, ACCT.opIncome);
    const netIncome = valueForYear(annual, fy, ACCT.netIncome);
    const equity = valueForYear(annual, fy, ACCT.equity);
    const liab = valueForYear(annual, fy, ACCT.liabilities);
    const cash = valueForYear(annual, fy, ACCT.cash);
    const epsStmt = valueForYear(annual, fy, ACCT.eps);

    const eps = epsStmt ?? (netIncome != null && shares ? netIncome / shares : null);
    const bps = equity != null && shares ? equity / shares : null;

    // 연말(결산월 말일) 시점 주가
    const endYmd = `${fy}${String(fiscalMonth).padStart(2, "0")}31`;
    let yePrice: number | null = null;
    if (market === "kr") {
      yePrice = await fetchKrxCloseOn(symbol, endYmd).catch(() => null);
    } else if (quote?.bars?.length) {
      yePrice = closeFromBars(
        quote.bars,
        `${fy}-${String(fiscalMonth).padStart(2, "0")}-31`,
      );
    }
    yePrice = yePrice ?? price; // 못 구하면 현재가로 대체

    const per = yePrice != null && eps ? yePrice / eps : null;
    const pbr = yePrice != null && bps ? yePrice / bps : null;
    const roe = netIncome != null && equity ? (netIncome / equity) * 100 : null;
    const mcap = yePrice != null && shares ? yePrice * shares : null;
    const ev = mcap != null ? mcap + (liab ?? 0) - (cash ?? 0) : null;
    const evEbitda = ev != null && opIncome ? ev / opIncome : null;

    actualRows.push({
      fy,
      label: `${fy}.${String(fiscalMonth).padStart(2, "0")}`,
      isEstimate: false,
      revenue,
      revenueYoY: null,
      opIncome,
      netIncome,
      eps: eps != null ? Math.round(eps * 100) / 100 : null,
      bps: bps != null ? Math.round(bps) : null,
      per: fin(per),
      pbr: fin(pbr),
      roe: fin(roe),
      evEbitda: fin(evEbitda),
      priceBasis: yePrice,
    });
  }

  // ── 추정 행 ──────────────────────────────────────────────────────
  const estRows: ConsensusRow[] = [];
  const fyPeriods = (estimates?.periods ?? []).filter((p) =>
    ["0y", "+1y", "+2y"].includes(p.period),
  );
  for (const p of fyPeriods) {
    const fy = p.endDate ? Number(p.endDate.slice(0, 4)) : null;
    if (fy == null) continue;
    if (actualRows.some((r) => r.fy === fy)) continue; // 이미 실적 있음
    const eps = p.epsAvg;
    const per = price != null && eps ? price / eps : null;
    estRows.push({
      fy,
      label: `${fy}.${String(fiscalMonth).padStart(2, "0")}`,
      isEstimate: true,
      revenue: p.revenueAvg,
      revenueYoY: null,
      opIncome: null,
      netIncome: null,
      eps: eps != null ? Math.round(eps * 100) / 100 : null,
      bps: null,
      per: fin(per),
      pbr: null,
      roe: null,
      evEbitda: null,
      priceBasis: price,
    });
  }

  const rows = [...actualRows, ...estRows].sort((a, b) => a.fy - b.fy);
  // YoY (매출)
  for (let i = 1; i < rows.length; i++) {
    const cur = rows[i].revenue;
    const prev = rows[i - 1].revenue;
    if (cur != null && prev != null && prev !== 0) {
      rows[i].revenueYoY = Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10;
    }
  }

  // ── EPS 리비전 (당해년도) ───────────────────────────────────────
  let epsRevision: ConsensusData["epsRevision"] = null;
  const cy = estimates?.periods.find((p) => p.period === "0y");
  if (cy?.epsTrend) {
    const t = cy.epsTrend;
    const eps = [t.current, t.d7, t.d30, t.d90];
    epsRevision = {
      asOf: ["현재", "1주 전", "1개월 전", "3개월 전"],
      eps,
      per: eps.map((e) => (price != null && e ? Math.round((price / e) * 100) / 100 : null)),
    };
  }

  return {
    currency: quote?.currency ?? "USD",
    unit: annual.unit || (market === "kr" ? "원" : market === "jp" ? "円" : "USD"),
    fiscalMonth,
    price,
    targetPrice: estimates?.targetMeanPrice ?? null,
    recommendationMean: estimates?.recommendationMean ?? null,
    rows,
    epsRevision,
    earningsSurprise: (estimates?.surprises ?? []).slice(-4),
    deepLinks: consensusDeepLinks(market, symbol),
    asOf: quote?.lastDate ?? new Date().toISOString().slice(0, 10),
    notes: [...new Set(notes)],
  };
}

function fin(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}
