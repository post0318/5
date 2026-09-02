import "server-only";
import { unzipSync } from "fflate";
import { AdapterError } from "../types";
import type {
  FinancialLineItem,
  FinancialPeriod,
  FinancialStatement,
} from "../types";

/**
 * EDINET 有価証券報告書 CSV(type=5) 파싱 → 재무 요약.
 *
 * CSV 안의 `*SummaryOfBusinessResults` 요소(경영지표 등)는 최근 5기 매출·이익·
 * 자산·순자산·EPS 등을 원본 일본어 항목명과 함께 담고 있어 리서치 요약에 적합.
 */

const BASE = "https://api.edinet-fsa.go.jp/api/v2";

interface CsvRow {
  elementId: string;
  label: string;
  contextId: string;
  relativeYear: string;
  consolidation: string;
  unit: string;
  value: string;
}

function parseTsv(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = lines[i].split("\t").map((x) => x.replace(/^"|"$/g, ""));
    if (c.length < 9) continue;
    rows.push({
      elementId: c[0],
      label: c[1],
      contextId: c[2],
      relativeYear: c[3],
      consolidation: c[4],
      unit: c[7],
      value: c[8],
    });
  }
  return rows;
}

/** 경영지표 요소 매핑: base concept → 표시명 · 섹션 · 강조 */
interface SummarySpec {
  match: RegExp;
  label: string;
  section: "손익계산서" | "재무상태표" | "주요지표";
  highlight: boolean;
}
/**
 * 경영지표 등(SummaryOfBusinessResults) 중 금액 항목만.
 * IFRS 제출사는 요약에 売上高/営業利益가 없을 수 있음(単体만 존재) → 그 경우 공란.
 * 비율·주당 지표는 이 테이블(정수 엔화 표시)에 부적합해 제외.
 */
const SUMMARY_SPECS: SummarySpec[] = [
  { match: /^NetSalesSummaryOfBusinessResults$/, label: "売上高", section: "손익계산서", highlight: true },
  { match: /^(NetSales|Revenue|Revenues|OperatingRevenue|OperatingRevenues)IFRSSummaryOfBusinessResults$/, label: "営業収益 (IFRS)", section: "손익계산서", highlight: true },
  { match: /^OperatingIncomeSummaryOfBusinessResults$/, label: "営業利益", section: "손익계산서", highlight: true },
  { match: /^OperatingProfitLossIFRSSummaryOfBusinessResults$/, label: "営業利益 (IFRS)", section: "손익계산서", highlight: true },
  { match: /^OrdinaryIncomeLossSummaryOfBusinessResults$/, label: "経常利益", section: "손익계산서", highlight: false },
  { match: /^(ProfitLossBeforeTax|IncomeBeforeIncomeTaxes)IFRSSummaryOfBusinessResults$/, label: "税引前利益", section: "손익계산서", highlight: false },
  { match: /^ProfitLossAttributableToOwnersOfParentIFRSSummaryOfBusinessResults$/, label: "当期利益（親会社の所有者帰属）", section: "손익계산서", highlight: true },
  { match: /^NetIncomeLossSummaryOfBusinessResults$/, label: "当期純利益", section: "손익계산서", highlight: true },
  { match: /^ComprehensiveIncomeAttributableToOwnersOfParentIFRSSummaryOfBusinessResults$/, label: "当期包括利益", section: "손익계산서", highlight: false },
  { match: /^(TotalAssetsIFRS|TotalAssets)SummaryOfBusinessResults$/, label: "総資産", section: "재무상태표", highlight: true },
  { match: /^NetAssetsSummaryOfBusinessResults$/, label: "純資産額", section: "재무상태표", highlight: true },
  { match: /^EquityAttributableToOwnersOfParentIFRSSummaryOfBusinessResults$/, label: "親会社の所有者に帰属する持分", section: "재무상태표", highlight: true },
  { match: /^(NetCashProvidedByUsedInOperatingActivitiesIFRS|CashFlowsFromUsedInOperatingActivitiesIFRS|NetCashProvidedByUsedInOperatingActivities|CashFlowsFromUsedInOperatingActivities)SummaryOfBusinessResults$/, label: "営業活動によるキャッシュ・フロー", section: "재무상태표", highlight: false },
  { match: /^CashFlowsFromUsedInInvestingActivitiesIFRSSummaryOfBusinessResults$/, label: "投資活動によるキャッシュ・フロー", section: "재무상태표", highlight: false },
  { match: /^CashFlowsFromUsedInFinancingActivitiesIFRSSummaryOfBusinessResults$/, label: "財務活動によるキャッシュ・フロー", section: "재무상태표", highlight: false },
  { match: /^(BasicEarningsLossPerShareIFRS|BasicEarningsPerShare)SummaryOfBusinessResults$/, label: "基本的1株当たり当期利益 (円)", section: "손익계산서", highlight: false },
];

const CTX_TO_OFFSET: Record<string, number> = {
  CurrentYear: 0,
  Prior1Year: 1,
  Prior2Year: 2,
  Prior3Year: 3,
  Prior4Year: 4,
};

function contextOffset(ctx: string): number | null {
  // "CurrentYearDuration", "Prior2YearInstant", 単体は "_NonConsolidatedMember" 접미
  if (ctx.includes("NonConsolidated")) return null; // 個別 제외
  for (const [k, v] of Object.entries(CTX_TO_OFFSET)) {
    if (ctx.startsWith(k)) return v;
  }
  return null;
}

function parseNum(v: string): number | null {
  if (!v || v === "-" || v === "－" || v === "NaN") return null;
  const n = Number(v.replace(/,/g, "").replace(/△/g, "-").replace(/[()]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export async function fetchEdinetSummary(
  apiKey: string,
  docID: string,
  periodEndYear: number,
): Promise<FinancialStatement | null> {
  const res = await fetch(
    `${BASE}/documents/${docID}?type=5&Subscription-Key=${apiKey}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok) throw new AdapterError(`EDINET 문서 다운로드 실패 (${res.status})`, { status: 502 });
  const buf = new Uint8Array(await res.arrayBuffer());
  const files = unzipSync(buf);
  const csvName = Object.keys(files).find((n) => /jpcrp\d+-asr.*\.csv$/i.test(n));
  if (!csvName) return null;
  const text = new TextDecoder("utf-16le").decode(files[csvName]);
  const rows = parseTsv(text);

  // 기간: periodEndYear 기준 5기
  const periods: FinancialPeriod[] = [];
  for (let off = 0; off <= 4; off++) {
    const fy = periodEndYear - off;
    periods.push({
      label: `FY${fy}`,
      fiscalYear: fy,
      fiscalQuarter: null,
      endDate: `${fy}-03-31`,
    });
  }

  const bySpec = new Map<string, { spec: SummarySpec; values: Record<string, number | null> }>();
  for (const row of rows) {
    if (!/SummaryOfBusinessResults$/.test(row.elementId)) continue;
    const off = contextOffset(row.contextId);
    if (off === null) continue;
    const base = row.elementId.replace(/^.*:/, ""); // "jpigp_cor:X" → "X"
    const spec = SUMMARY_SPECS.find((s) => s.match.test(base));
    if (!spec) continue;
    const key = spec.label;
    if (!bySpec.has(key)) bySpec.set(key, { spec, values: {} });
    const entry = bySpec.get(key)!;
    const fy = periodEndYear - off;
    if (entry.values[`FY${fy}`] == null) {
      entry.values[`FY${fy}`] = parseNum(row.value);
    }
  }

  if (bySpec.size === 0) return null;

  const sectionOrder = ["손익계산서", "재무상태표", "주요지표"] as const;
  const sections = sectionOrder
    .map((title) => {
      const items: FinancialLineItem[] = [];
      for (const { spec, values } of bySpec.values()) {
        if (spec.section !== title) continue;
        if (!periods.some((p) => values[p.label] != null)) continue;
        items.push({
          accountName: spec.label,
          depth: 0,
          isSubtotal: spec.highlight,
          isHighlight: spec.highlight,
          values,
        });
      }
      return { title, items };
    })
    .filter((s) => s.items.length > 0);

  return {
    symbol: "",
    market: "jp",
    periodType: "annual",
    unit: "円",
    currency: "JPY",
    consolidation: "consolidated",
    periods,
    sections,
    source: "EDINET 有価証券報告書 (経営指標等)",
    sourceUrl: "https://disclosure2.edinet-fsa.go.jp/week0010.aspx",
  };
}
