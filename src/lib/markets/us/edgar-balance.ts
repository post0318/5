import "server-only";
import type { CompanyFacts } from "./edgar";
import type { FinancialStatement, FinancialLineItem, FinancialPeriod } from "../types";
import {
  annualEnds,
  firstConcept,
  instantByYear,
  instantOn,
  latestInstant,
  recentInstantQuarters,
} from "./edgar-series";

/**
 * 미국 상세 재무상태표 — SEC EDGAR companyfacts 정규화 재분류 (블룸버그 B/S 근사).
 * 컬럼: 최근 5개 사업연도말 + 현재/LTM(최근 분기말). 분기 모드는 최근 5분기말.
 * "기타" 라인은 (구간 총계 − 매핑 라인)으로 자동 정합.
 */

const LTM = "현재/LTM";
const fyKey = (y: number) => `${y}Y`;

const A_TOTAL = ["Assets"];
const A_CUR = ["AssetsCurrent"];
const L_TOTAL = ["Liabilities"];
const L_CUR = ["LiabilitiesCurrent"];
const EQ = ["StockholdersEquity"];
const LE_TOTAL = ["LiabilitiesAndStockholdersEquity"];

interface Line {
  label: string;
  concepts?: string[];
  combine?: string[]; // 합산
  depth: number;
  kind?: "item" | "subtotal" | "total";
  plugOf?: string; // 이 구간 총계 개념군의 키 → (총계 − 앞선 depth1 형제합)
  highlight?: boolean;
}

const BLOCKS: { title: string; lines: Line[] }[] = [
  {
    title: "자산",
    lines: [
      { label: "현금·현금성자산", concepts: ["CashAndCashEquivalentsAtCarryingValue"], depth: 1 },
      { label: "단기 투자자산", concepts: ["MarketableSecuritiesCurrent", "ShortTermInvestments"], depth: 1 },
      { label: "매출채권", concepts: ["AccountsReceivableNetCurrent", "ReceivablesNetCurrent"], depth: 1 },
      { label: "재고자산", concepts: ["InventoryNet"], depth: 1 },
      { label: "기타 유동자산", depth: 1, plugOf: "cur" },
      { label: "유동자산 총계", depth: 0, kind: "subtotal", concepts: A_CUR },
      { label: "유형자산 (순)", concepts: ["PropertyPlantAndEquipmentNet"], depth: 1 },
      { label: "장기 투자자산", concepts: ["MarketableSecuritiesNoncurrent", "LongTermInvestments"], depth: 1 },
      { label: "기타 비유동자산", depth: 1, plugOf: "noncur" },
      { label: "비유동자산 총계", depth: 0, kind: "subtotal", plugOf: "noncurTotal" },
      { label: "자산 총계", depth: 0, kind: "total", highlight: true, concepts: A_TOTAL },
    ],
  },
  {
    title: "부채",
    lines: [
      { label: "매입채무", concepts: ["AccountsPayableCurrent"], depth: 1 },
      { label: "단기 차입금", combine: ["CommercialPaper", "ShortTermBorrowings"], depth: 1 },
      { label: "유동성 장기부채", concepts: ["LongTermDebtCurrent"], depth: 1 },
      { label: "이연수익 (유동)", concepts: ["ContractWithCustomerLiabilityCurrent", "DeferredRevenueCurrent"], depth: 1 },
      { label: "기타 유동부채", concepts: ["OtherLiabilitiesCurrent"], depth: 1 },
      { label: "기타 (유동부채)", depth: 1, plugOf: "lcur" },
      { label: "유동부채 총계", depth: 0, kind: "subtotal", concepts: L_CUR },
      { label: "장기 차입금", concepts: ["LongTermDebtNoncurrent"], depth: 1 },
      { label: "이연수익 (비유동)", concepts: ["ContractWithCustomerLiabilityNoncurrent", "DeferredRevenueNoncurrent"], depth: 1 },
      { label: "이연법인세부채", concepts: ["DeferredTaxLiabilitiesNoncurrent", "DeferredIncomeTaxLiabilitiesNet"], depth: 1 },
      { label: "기타 비유동부채", concepts: ["OtherLiabilitiesNoncurrent"], depth: 1 },
      { label: "기타 (비유동부채)", depth: 1, plugOf: "lnoncur" },
      { label: "비유동부채 총계", depth: 0, kind: "subtotal", plugOf: "lnoncurTotal" },
      { label: "부채 총계", depth: 0, kind: "total", highlight: true, concepts: L_TOTAL },
    ],
  },
  {
    title: "자본",
    lines: [
      {
        label: "자본금·주식발행초과금",
        combine: [
          "CommonStocksIncludingAdditionalPaidInCapital",
          "CommonStockValue",
          "AdditionalPaidInCapitalCommonStock",
          "AdditionalPaidInCapital",
        ],
        depth: 1,
      },
      { label: "이익잉여금(결손금)", concepts: ["RetainedEarningsAccumulatedDeficit"], depth: 1 },
      { label: "기타포괄손익누계액", concepts: ["AccumulatedOtherComprehensiveIncomeLossNetOfTax"], depth: 1 },
      { label: "자기주식", concepts: ["TreasuryStockCommonValue", "TreasuryStockValue"], depth: 1 },
      { label: "비지배지분", concepts: ["MinorityInterest"], depth: 1 },
      { label: "기타 (자본)", depth: 1, plugOf: "eq" },
      { label: "자본 총계", depth: 0, kind: "total", highlight: true, concepts: EQ },
      { label: "부채와 자본 총계", depth: 0, kind: "total", highlight: true, concepts: LE_TOTAL },
    ],
  },
];

const DEBT = [
  "LongTermDebtNoncurrent",
  "LongTermDebtCurrent",
  "CommercialPaper",
  "ShortTermBorrowings",
];
const CASH_LIKE = [
  "CashAndCashEquivalentsAtCarryingValue",
  "MarketableSecuritiesCurrent",
  "ShortTermInvestments",
  "MarketableSecuritiesNoncurrent",
  "LongTermInvestments",
];
const SHARES = ["EntityCommonStockSharesOutstanding", "CommonStockSharesOutstanding"];

export function buildUsBalance(
  facts: CompanyFacts,
  mode: "annual" | "quarter" = "annual",
): FinancialStatement {
  const anchor = firstConcept(facts, A_TOTAL);

  let periods: FinancialPeriod[];
  let value: (concepts: string[]) => Record<string, number | null>;

  if (mode === "quarter") {
    const qEnds = recentInstantQuarters(anchor, 5); // 최신→과거
    const chron = [...qEnds].reverse();
    periods = chron.map((end) => ({
      label: end,
      fiscalYear: Number(end.slice(0, 4)),
      fiscalQuarter: null,
      endDate: end,
    }));
    value = (concepts) => {
      const e = firstConcept(facts, concepts);
      const out: Record<string, number | null> = {};
      for (const end of chron) out[end] = instantOn(e, end);
      return out;
    };
  } else {
    const years = [...instantByYear(anchor).keys()].sort((a, b) => a - b).slice(-5);
    const ends = annualEnds(anchor);
    periods = years.map((y) => ({
      label: fyKey(y),
      fiscalYear: y,
      fiscalQuarter: null,
      endDate: ends.get(y) ?? `${y}-12-31`,
    }));
    const latestEnd =
      recentInstantQuarters(anchor, 1)[0] ?? new Date().toISOString().slice(0, 10);
    periods.push({ label: LTM, fiscalYear: (years.at(-1) ?? 0) + 1, fiscalQuarter: null, endDate: latestEnd });
    value = (concepts) => {
      const e = firstConcept(facts, concepts);
      const ann = instantByYear(e);
      const out: Record<string, number | null> = {};
      for (const y of years) out[fyKey(y)] = ann.get(y) ?? null;
      out[LTM] = instantOn(e, latestEnd) ?? latestInstant(e);
      return out;
    };
  }
  const labels = periods.map((p) => p.label);
  const blank = (): Record<string, number | null> => Object.fromEntries(labels.map((l) => [l, null]));

  // 구간 총계 조회 (플러그용)
  const curTotal = value(A_CUR);
  const aTotal = value(A_TOTAL);
  const lcurTotal = value(L_CUR);
  const lTotal = value(L_TOTAL);
  const eqTotal = value(EQ);
  const totalOf: Record<string, Record<string, number | null>> = {
    cur: curTotal,
    lcur: lcurTotal,
    eq: eqTotal,
    noncur: (() => {
      const o = blank();
      for (const l of labels) if (aTotal[l] != null && curTotal[l] != null) o[l] = aTotal[l]! - curTotal[l]!;
      return o;
    })(),
    lnoncur: (() => {
      const o = blank();
      for (const l of labels) if (lTotal[l] != null && lcurTotal[l] != null) o[l] = lTotal[l]! - lcurTotal[l]!;
      return o;
    })(),
    noncurTotal: (() => {
      const o = blank();
      for (const l of labels) if (aTotal[l] != null && curTotal[l] != null) o[l] = aTotal[l]! - curTotal[l]!;
      return o;
    })(),
    lnoncurTotal: (() => {
      const o = blank();
      for (const l of labels) if (lTotal[l] != null && lcurTotal[l] != null) o[l] = lTotal[l]! - lcurTotal[l]!;
      return o;
    })(),
  };

  const items: FinancialLineItem[] = [];
  for (const block of BLOCKS) {
    // 매핑된 depth1 라인 (플러그 제외)
    const resolved: Record<string, Record<string, number | null>> = {};
    for (const line of block.lines) {
      if (line.kind === "subtotal" || line.kind === "total" || line.plugOf) continue;
      resolved[line.label] = line.combine
        ? (() => {
            const o = blank();
            for (const c of line.combine) {
              const v = value([c]);
              for (const l of labels) if (v[l] != null) o[l] = (o[l] ?? 0) + v[l]!;
            }
            return o;
          })()
        : value(line.concepts ?? []);
    }

    for (const line of block.lines) {
      let values: Record<string, number | null>;
      if (line.kind === "subtotal" || line.kind === "total") {
        values = line.concepts
          ? value(line.concepts)
          : line.plugOf
            ? totalOf[line.plugOf.replace(/Total$/, "")]
            : blank();
      } else if (line.plugOf) {
        // (구간 총계 − 직전 소계 이후 ~ 이 라인 이전의 depth1 item 합)
        const tot = totalOf[line.plugOf.replace(/Total$/, "")];
        const idx = block.lines.indexOf(line);
        let bound = -1;
        for (let i = idx - 1; i >= 0; i--)
          if (block.lines[i].kind === "subtotal" || block.lines[i].kind === "total") {
            bound = i;
            break;
          }
        values = blank();
        for (const l of labels) {
          if (tot[l] == null) continue;
          let mapped = 0;
          for (let i = bound + 1; i < idx; i++) {
            const s = block.lines[i];
            if (s.kind || s.plugOf) continue;
            mapped += resolved[s.label]?.[l] ?? 0;
          }
          values[l] = Math.round(tot[l]! - mapped);
        }
      } else {
        values = resolved[line.label];
      }
      items.push({
        accountName: line.label,
        accountId: `bs:${block.title}:${line.label}`,
        depth: line.depth,
        isSubtotal: line.kind === "subtotal" || line.kind === "total",
        isHighlight: Boolean(line.highlight),
        values,
      });
    }
  }

  // ── 주석 항목 ──
  items.push({ accountName: "", accountId: "bs:sp", depth: 0, isSubtotal: false, isHighlight: false, values: blank() });
  items.push({ accountName: "[ 주석 항목 ]", accountId: "bs:note", depth: 0, isSubtotal: true, isHighlight: false, values: blank() });

  const shares = value(SHARES); // dei/us-gaap 혼재 → firstConcept 는 us-gaap 만. dei 별도.
  const sharesDei = (() => {
    const e = (facts.facts.dei?.["EntityCommonStockSharesOutstanding"]?.units?.shares ?? []) as {
      end: string;
      val: number;
      start?: string;
      form: string;
    }[];
    const out = blank();
    for (const p of periods) {
      let best: { v: number; d: number } | null = null;
      for (const x of e) {
        const dd = Math.abs(Date.parse(p.endDate ?? "") - Date.parse(x.end));
        if (!best || dd < best.d) best = { v: x.val, d: dd };
      }
      out[p.label] = best?.v ?? null;
    }
    return out;
  })();
  const sharesRow = blank();
  for (const l of labels) sharesRow[l] = sharesDei[l] ?? shares[l];

  const debt = (() => {
    const o = blank();
    for (const c of DEBT) {
      const v = value([c]);
      for (const l of labels) if (v[l] != null) o[l] = (o[l] ?? 0) + v[l]!;
    }
    return o;
  })();
  const cashLike = (() => {
    const o = blank();
    for (const c of CASH_LIKE) {
      const v = value([c]);
      for (const l of labels) if (v[l] != null) o[l] = (o[l] ?? 0) + v[l]!;
    }
    return o;
  })();
  const netDebt = blank();
  for (const l of labels)
    if (debt[l] != null || cashLike[l] != null) netDebt[l] = (debt[l] ?? 0) - (cashLike[l] ?? 0);
  const currentRatio = blank();
  for (const l of labels) if (curTotal[l] && lcurTotal[l]) currentRatio[l] = curTotal[l]! / lcurTotal[l]!;
  const ndToEq = blank();
  for (const l of labels) if (netDebt[l] != null && eqTotal[l]) ndToEq[l] = (netDebt[l]! / eqTotal[l]!) * 100;

  const nrow = (label: string, values: Record<string, number | null>, nf?: FinancialLineItem["numberFormat"]): FinancialLineItem => ({
    accountName: label,
    accountId: `bs:note:${label}`,
    depth: 1,
    isSubtotal: false,
    isHighlight: false,
    values,
    numberFormat: nf,
  });
  items.push(nrow("유통주식수", sharesRow, "shares"));
  items.push(nrow("총차입금", debt));
  items.push(nrow("순부채", netDebt));
  items.push(nrow("유동비율", currentRatio, "eps"));
  items.push(nrow("순부채/자본 (%)", ndToEq, "pct"));

  return {
    symbol: "",
    market: "us",
    periodType: "annual",
    unit: "USD",
    currency: "USD",
    consolidation: "consolidated",
    periods,
    sections: [{ title: "재무상태표", items }],
    source: "SEC EDGAR · 표준화 재분류",
  };
}
