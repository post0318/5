/**
 * SEC EDGAR 어댑터 (미국 L1) — prd.md §4.1
 * 공식 무료 API. API 키 불필요. User-Agent 헤더 필수.
 * https://www.sec.gov/search-filings/edgar-application-programming-interfaces
 */

import { fetchJson } from "../http";
import { consensusDeepLinks, filingsDeepLink, newsDeepLinks } from "../deeplinks";
import {
  AdapterError,
  type CompanyProfile,
  type DeepLink,
  type Filing,
  type FinancialLineItem,
  type FinancialPeriod,
  type FinancialPeriodType,
  type FinancialStatement,
  type MarketAdapter,
} from "../types";

const UA =
  process.env.SEC_USER_AGENT ??
  "global-market-research (personal use) contact@example.com";

const SEC_HEADERS = { "user-agent": UA, "accept-encoding": "gzip, deflate" };

function cik10(cik: number | string): string {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

// ---- ticker → CIK 매핑 (캐시) --------------------------------------------

interface TickerRow {
  cik_str: number;
  ticker: string;
  title: string;
}
let tickerMap: Map<string, TickerRow> | null = null;

async function loadTickerMap(): Promise<Map<string, TickerRow>> {
  if (tickerMap) return tickerMap;
  const data = await fetchJson<Record<string, TickerRow>>(
    "https://www.sec.gov/files/company_tickers.json",
    { headers: SEC_HEADERS, revalidate: 60 * 60 * 24 },
  );
  const map = new Map<string, TickerRow>();
  for (const row of Object.values(data)) map.set(row.ticker.toUpperCase(), row);
  tickerMap = map;
  return map;
}

async function resolveCik(symbol: string): Promise<{ cik: string; row: TickerRow }> {
  const map = await loadTickerMap();
  const row = map.get(symbol.toUpperCase());
  if (!row) throw new AdapterError(`EDGAR에서 티커를 찾을 수 없습니다: ${symbol}`, { status: 404 });
  return { cik: cik10(row.cik_str), row };
}

/** 티커 또는 회사명으로 EDGAR 상장사 검색 */
export async function searchEdgarTickers(
  query: string,
): Promise<{ ticker: string; title: string }[]> {
  const map = await loadTickerMap();
  const q = query.trim().toUpperCase();
  if (!q) return [];
  const starts: { ticker: string; title: string }[] = [];
  const contains: { ticker: string; title: string }[] = [];
  for (const row of map.values()) {
    const ticker = row.ticker.toUpperCase();
    const title = row.title.toUpperCase();
    if (ticker === q || title.startsWith(q)) {
      starts.push({ ticker: row.ticker, title: row.title });
    } else if (ticker.startsWith(q) || title.includes(q)) {
      contains.push({ ticker: row.ticker, title: row.title });
    }
    if (starts.length >= 8) break;
  }
  return [...starts, ...contains].slice(0, 8);
}

// ---- submissions (프로필 + 공시) ----------------------------------------

interface SubmissionsResponse {
  cik: string;
  name: string;
  tickers: string[];
  exchanges: string[];
  sic: string;
  sicDescription: string;
  category: string;
  fiscalYearEnd: string;
  addresses?: { business?: Record<string, string> };
  website?: string;
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      form: string[];
      primaryDocument: string[];
      primaryDocDescription: string[];
    };
  };
}

async function getSubmissions(cik: string): Promise<SubmissionsResponse> {
  return fetchJson<SubmissionsResponse>(
    `https://data.sec.gov/submissions/CIK${cik}.json`,
    { headers: SEC_HEADERS, revalidate: 60 * 30 },
  );
}

// companyfacts 응답은 종종 2MB 초과 → Next fetch 캐시 불가.
// 프로세스 메모리에 짧게 캐시한다 (본격적으로는 배치→DB, prd.md §4.5).
const factsCache = new Map<string, { at: number; data: CompanyFacts }>();
const FACTS_TTL = 1000 * 60 * 60 * 6;

async function getCompanyFacts(cik: string): Promise<CompanyFacts> {
  const hit = factsCache.get(cik);
  if (hit && Date.now() - hit.at < FACTS_TTL) return hit.data;
  const data = await fetchJson<CompanyFacts>(
    `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
    { headers: SEC_HEADERS, revalidate: false },
  );
  factsCache.set(cik, { at: Date.now(), data });
  return data;
}

// ---- companyfacts (재무제표) -------------------------------------------

interface FactUnitEntry {
  start?: string;
  end: string;
  val: number;
  fy: number;
  fp: string; // "FY" | "Q1".."Q4"
  form: string; // "10-K" | "10-Q" | ...
  frame?: string;
}
interface CompanyFacts {
  entityName: string;
  facts: {
    "us-gaap"?: Record<
      string,
      { label?: string; description?: string; units: Record<string, FactUnitEntry[]> }
    >;
  };
}

/**
 * 표시할 us-gaap 계정. 원본 XBRL 개념을 그대로 쓰되, 사람이 읽는 라벨과
 * 강조/소계 플래그, 섹션 분류를 붙인다 (prd.md §6).
 */
interface ConceptSpec {
  concept: string;
  label: string;
  section: "손익계산서" | "재무상태표" | "현금흐름표";
  depth: number;
  isSubtotal: boolean;
  isHighlight: boolean;
}

const CONCEPTS: ConceptSpec[] = [
  // 손익계산서
  { concept: "RevenueFromContractWithCustomerExcludingAssessedTax", label: "Revenues", section: "손익계산서", depth: 0, isSubtotal: false, isHighlight: true },
  { concept: "Revenues", label: "Revenues (legacy)", section: "손익계산서", depth: 0, isSubtotal: false, isHighlight: true },
  { concept: "CostOfRevenue", label: "Cost of Revenue", section: "손익계산서", depth: 1, isSubtotal: false, isHighlight: false },
  { concept: "GrossProfit", label: "Gross Profit", section: "손익계산서", depth: 0, isSubtotal: true, isHighlight: false },
  { concept: "ResearchAndDevelopmentExpense", label: "R&D Expense", section: "손익계산서", depth: 1, isSubtotal: false, isHighlight: false },
  { concept: "SellingGeneralAndAdministrativeExpense", label: "SG&A Expense", section: "손익계산서", depth: 1, isSubtotal: false, isHighlight: false },
  { concept: "OperatingIncomeLoss", label: "Operating Income", section: "손익계산서", depth: 0, isSubtotal: true, isHighlight: true },
  { concept: "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", label: "Pretax Income", section: "손익계산서", depth: 0, isSubtotal: true, isHighlight: false },
  { concept: "IncomeTaxExpenseBenefit", label: "Income Tax Expense", section: "손익계산서", depth: 1, isSubtotal: false, isHighlight: false },
  { concept: "NetIncomeLoss", label: "Net Income", section: "손익계산서", depth: 0, isSubtotal: true, isHighlight: true },
  { concept: "EarningsPerShareBasic", label: "EPS (Basic)", section: "손익계산서", depth: 1, isSubtotal: false, isHighlight: false },
  { concept: "EarningsPerShareDiluted", label: "EPS (Diluted)", section: "손익계산서", depth: 1, isSubtotal: false, isHighlight: true },
  // 재무상태표
  { concept: "CashAndCashEquivalentsAtCarryingValue", label: "Cash & Equivalents", section: "재무상태표", depth: 1, isSubtotal: false, isHighlight: false },
  { concept: "AssetsCurrent", label: "Current Assets", section: "재무상태표", depth: 0, isSubtotal: true, isHighlight: false },
  { concept: "Assets", label: "Total Assets", section: "재무상태표", depth: 0, isSubtotal: true, isHighlight: true },
  { concept: "LiabilitiesCurrent", label: "Current Liabilities", section: "재무상태표", depth: 0, isSubtotal: true, isHighlight: false },
  { concept: "Liabilities", label: "Total Liabilities", section: "재무상태표", depth: 0, isSubtotal: true, isHighlight: true },
  { concept: "StockholdersEquity", label: "Stockholders' Equity", section: "재무상태표", depth: 0, isSubtotal: true, isHighlight: true },
  { concept: "LongTermDebtNoncurrent", label: "Long-term Debt", section: "재무상태표", depth: 1, isSubtotal: false, isHighlight: false },
  // 현금흐름표
  { concept: "NetCashProvidedByUsedInOperatingActivities", label: "Operating Cash Flow", section: "현금흐름표", depth: 0, isSubtotal: true, isHighlight: true },
  { concept: "NetCashProvidedByUsedInInvestingActivities", label: "Investing Cash Flow", section: "현금흐름표", depth: 0, isSubtotal: true, isHighlight: false },
  { concept: "NetCashProvidedByUsedInFinancingActivities", label: "Financing Cash Flow", section: "현금흐름표", depth: 0, isSubtotal: true, isHighlight: false },
  { concept: "PaymentsToAcquirePropertyPlantAndEquipment", label: "CapEx", section: "현금흐름표", depth: 1, isSubtotal: false, isHighlight: false },
];

function periodKey(e: FactUnitEntry): string {
  return e.fp === "FY" ? `FY${e.fy}` : `${e.fy} ${e.fp}`;
}

function pickEntries(
  entries: FactUnitEntry[],
  periodType: FinancialPeriodType,
): Map<string, FactUnitEntry> {
  const wanted = periodType === "annual" ? ["10-K", "10-K/A", "20-F"] : ["10-Q", "10-Q/A"];
  const byPeriod = new Map<string, FactUnitEntry>();
  for (const e of entries) {
    if (periodType === "annual" && e.fp !== "FY") continue;
    if (periodType === "quarter" && e.fp === "FY") continue;
    if (!wanted.includes(e.form)) continue;
    const key = periodKey(e);
    // 같은 기간 중복이면 최신 end 우선
    const prev = byPeriod.get(key);
    if (!prev || e.end > prev.end) byPeriod.set(key, e);
  }
  return byPeriod;
}

// ---- 어댑터 ------------------------------------------------------------

export const usEdgarAdapter: MarketAdapter = {
  market: "us",
  currency: "USD",

  isConfigured() {
    return true; // 키 불필요
  },
  configHint() {
    return "SEC EDGAR는 API 키가 필요 없습니다. (SEC_USER_AGENT 환경변수로 User-Agent를 지정하는 것을 권장)";
  },

  normalizeSymbol(input) {
    return input.trim().toUpperCase();
  },

  async getCompanyProfile(symbol): Promise<CompanyProfile> {
    const { cik, row } = await resolveCik(symbol);
    const sub = await getSubmissions(cik);
    const biz = sub.addresses?.business;
    const address = biz
      ? [biz.street1, biz.street2, biz.city, biz.stateOrCountry, biz.zipCode].filter(Boolean).join(", ")
      : undefined;
    return {
      symbol: this.normalizeSymbol(symbol),
      market: "us",
      name: sub.name || row.title,
      identifiers: { CIK: cik, ticker: symbol.toUpperCase(), SIC: sub.sic ?? "" },
      industry: sub.sicDescription,
      homepage: sub.website,
      address,
      source: "SEC EDGAR",
      sourceUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=&dateb=&owner=include&count=40`,
    };
  },

  async getFinancials(symbol, periodType): Promise<FinancialStatement> {
    const { cik } = await resolveCik(symbol);
    const facts = await getCompanyFacts(cik);
    const gaap = facts.facts["us-gaap"] ?? {};

    // 1) 모든 컨셉에서 기간 집합 수집
    const periodEntries = new Map<string, Map<string, FactUnitEntry>>(); // concept -> period -> entry
    const periodMeta = new Map<string, FinancialPeriod>();

    for (const spec of CONCEPTS) {
      const node = gaap[spec.concept];
      if (!node) continue;
      const usd = node.units["USD"] ?? node.units["USD/shares"] ?? node.units["shares"];
      if (!usd) continue;
      const picked = pickEntries(usd, periodType);
      periodEntries.set(spec.concept, picked);
      for (const [key, e] of picked) {
        if (!periodMeta.has(key)) {
          periodMeta.set(key, {
            label: key,
            fiscalYear: e.fy,
            fiscalQuarter: e.fp === "FY" ? null : Number(e.fp.replace("Q", "")),
            endDate: e.end,
          });
        }
      }
    }

    // 2) 최근 기간 우선, 최대 8개
    const periods = [...periodMeta.values()]
      .sort((a, b) => (b.endDate ?? "").localeCompare(a.endDate ?? ""))
      .slice(0, 8);
    const periodLabels = periods.map((p) => p.label);

    // 3) 섹션별 라인 구성
    const sectionsOrder = ["손익계산서", "재무상태표", "현금흐름표"] as const;
    const sections = sectionsOrder.map((title) => {
      const items: FinancialLineItem[] = [];
      for (const spec of CONCEPTS) {
        if (spec.section !== title) continue;
        const picked = periodEntries.get(spec.concept);
        if (!picked || picked.size === 0) continue;
        const values: Record<string, number | null> = {};
        let hasAny = false;
        for (const label of periodLabels) {
          const e = picked.get(label);
          values[label] = e ? e.val : null;
          if (e) hasAny = true;
        }
        if (!hasAny) continue;
        items.push({
          accountName: spec.label,
          accountId: spec.concept,
          depth: spec.depth,
          isSubtotal: spec.isSubtotal,
          isHighlight: spec.isHighlight,
          values,
        });
      }
      return { title, items };
    }).filter((s) => s.items.length > 0);

    return {
      symbol: this.normalizeSymbol(symbol),
      market: "us",
      periodType,
      unit: "USD",
      currency: "USD",
      consolidation: "consolidated",
      periods,
      sections,
      source: "SEC EDGAR (XBRL companyfacts)",
      sourceUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=10-K`,
    };
  },

  async getFilings(symbol, opts): Promise<Filing[]> {
    const { cik } = await resolveCik(symbol);
    const sub = await getSubmissions(cik);
    const r = sub.filings.recent;
    const limit = opts?.limit ?? 20;
    const out: Filing[] = [];
    for (let i = 0; i < r.accessionNumber.length && out.length < limit; i++) {
      const accession = r.accessionNumber[i].replace(/-/g, "");
      const doc = r.primaryDocument[i];
      out.push({
        id: r.accessionNumber[i],
        symbol: symbol.toUpperCase(),
        market: "us",
        date: r.filingDate[i],
        title: r.primaryDocDescription[i] || r.form[i],
        type: r.form[i],
        url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession}/${doc}`,
        source: "SEC EDGAR",
      });
    }
    return out;
  },

  consensusDeepLinks(symbol): DeepLink[] {
    return consensusDeepLinks("us", symbol);
  },
  newsDeepLinks(symbol): DeepLink[] {
    return newsDeepLinks("us", symbol);
  },
  filingsDeepLink(symbol): DeepLink | null {
    return filingsDeepLink("us", symbol);
  },
};
