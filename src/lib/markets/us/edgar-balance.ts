import "server-only";
import type { CompanyFacts } from "./edgar";
import type { FinancialStatement, FinancialLineItem, FinancialPeriod } from "../types";
import {
  annualEnds,
  days,
  firstConcept,
  instantByYear,
  instantOn,
  recentInstantQuarters,
  recentQuarters,
} from "./edgar-series";

/** 분기 컬럼 달력용 (duration 개념 — instant 개념엔 분기 기간이 없음). */
const REVENUE_CAL = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "Revenues",
  "SalesRevenueNet",
];

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
  /** concepts/combine 결과가 없는 기(period)만 이 개념으로 대체 — 유동/비유동 분리 없이
   * 미분류 총액 하나로만 공시하는 회사(AXP 등 금융사) 대응. */
  fallback?: string[];
  depth: number;
  kind?: "item" | "subtotal" | "total";
  plugOf?: string; // 이 구간 총계 개념군의 키 → (총계 − 앞선 depth1 형제합)
  highlight?: boolean;
}

const BLOCKS: { title: string; lines: Line[] }[] = [
  {
    title: "자산",
    lines: [
      {
        label: "현금·현금성자산",
        concepts: ["CashAndCashEquivalentsAtCarryingValue"],
        // 제한현금 포함 총액 하나로만 공시하는 회사(AXP 등) 폴백
        fallback: ["CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
        depth: 1,
      },
      {
        label: "단기 투자자산",
        concepts: [
          "MarketableSecuritiesCurrent",
          "ShortTermInvestments",
          "DebtSecuritiesCurrent",
          "DebtSecuritiesAvailableForSaleExcludingAccruedInterestCurrent", // IBM
          "AvailableForSaleSecuritiesCurrent",
          // NVIDIA FY2026~: AFS 채무증권 전액 단기 분류, 10-K 는 이 태그만
          "AvailableForSaleSecuritiesDebtSecurities",
        ],
        depth: 1,
      },
      { label: "매출채권", concepts: ["AccountsReceivableNetCurrent", "ReceivablesNetCurrent"], depth: 1 },
      { label: "재고자산", concepts: ["InventoryNet", "AirlineRelatedInventoryNet", "EnergyRelatedInventory", "RetailRelatedInventoryMerchandise", "OtherInventoryNetOfReserves"], depth: 1 },
      { label: "기타 유동자산", depth: 1, plugOf: "cur" },
      { label: "유동자산 총계", depth: 0, kind: "subtotal", concepts: A_CUR },
      {
        label: "유형자산 (순)",
        concepts: [
          "PropertyPlantAndEquipmentNet",
          "PropertyPlantAndEquipmentExcludingLessorAssetUnderOperatingLeaseAfterAccumulatedDepreciation",
          "PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization",
        ],
        depth: 1,
      },
      {
        label: "사용권자산 (리스)",
        concepts: [
          "OperatingLeaseRightOfUseAsset",
          "OperatingLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization",
        ],
        depth: 1,
      },
      { label: "장기 투자자산", concepts: ["MarketableSecuritiesNoncurrent", "LongTermInvestments", "LongTermInvestmentsAndReceivablesNet"], depth: 1 },
      { label: "기타 비유동자산", depth: 1, plugOf: "noncur" },
      { label: "비유동자산 총계", depth: 0, kind: "subtotal", plugOf: "noncurTotal" },
      { label: "자산 총계", depth: 0, kind: "total", highlight: true, concepts: A_TOTAL },
    ],
  },
  {
    title: "부채",
    lines: [
      {
        label: "매입채무",
        concepts: ["AccountsPayableCurrent"],
        fallback: ["AccountsPayableCurrentAndNoncurrent"], // 유동/비유동 미분류 회사(AXP 등)
        depth: 1,
      },
      {
        label: "단기부채",
        combine: [
          "CommercialPaper",
          "ShortTermBorrowings",
          "LongTermDebtCurrent",
          "FinanceLeaseLiabilityCurrent",
          "OperatingLeaseLiabilityCurrent",
        ],
        depth: 1,
      },
      { label: "기타 유동부채", depth: 1, plugOf: "lcur" },
      { label: "유동부채 총계", depth: 0, kind: "subtotal", concepts: L_CUR },
      {
        label: "장기부채",
        combine: [
          "LongTermDebtNoncurrent",
          "FinanceLeaseLiabilityNoncurrent",
          "OperatingLeaseLiabilityNoncurrent",
        ],
        // 유동/비유동 분리 없이 미분류 총액(LongTermDebt) 하나로만 공시하는 회사(AXP 등) 폴백
        fallback: ["LongTermDebt"],
        depth: 1,
      },
      { label: "기타 장기부채", depth: 1, plugOf: "lnoncur" },
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

export function buildUsBalance(
  facts: CompanyFacts,
  mode: "annual" | "quarter" = "annual",
): FinancialStatement {
  const anchor = firstConcept(facts, A_TOTAL);

  let periods: FinancialPeriod[];
  let value: (concepts: string[]) => Record<string, number | null>;

  if (mode === "quarter") {
    // 분기 라벨·기말은 IS/CF 와 동일하게 (duration 개념 달력 기준)
    const cal = [...recentQuarters(firstConcept(facts, REVENUE_CAL), 5)].reverse();
    const fallback =
      cal.length === 0
        ? [...recentInstantQuarters(anchor, 5)].reverse().map((end) => ({
            label: end,
            end,
            fyStartApprox: end,
          }))
        : cal;
    periods = fallback.map((q) => ({
      label: q.label,
      fiscalYear: Number(q.label.slice(0, 4)),
      fiscalQuarter: Number(q.label.slice(-1)) || null,
      endDate: q.end,
    }));
    value = (concepts) => {
      const e = firstConcept(facts, concepts);
      const out: Record<string, number | null> = {};
      for (const q of fallback) out[q.label] = instantOn(e, q.end);
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
      // LTM: 최근 분기말 값. 없으면 최근 재무상태표 값(단, 너무 오래된 건 제외 —
      // 회사가 해당 라인 보고를 중단한 경우 옛 값이 잔존하지 않도록)
      const latest = e.filter((x) => !x.start).sort((a, b) => (a.end < b.end ? 1 : -1))[0];
      const fresh =
        latest && Math.abs(days(latest.end, latestEnd)) <= 400 ? latest.val : null;
      out[LTM] = instantOn(e, latestEnd) ?? fresh;
      return out;
    };
  }
  const labels = periods.map((p) => p.label);
  const blank = (): Record<string, number | null> => Object.fromEntries(labels.map((l) => [l, null]));

  // 구간 총계 조회 (플러그용)
  const curTotal = value(A_CUR);
  const aTotal = value(A_TOTAL);
  const lcurTotal = value(L_CUR);
  const leTotal = value(LE_TOTAL); // 부채와 자본 총계 (= 자산 총계)
  const eqRaw = value(["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]);
  const lRaw = value(L_TOTAL);
  // 자기자본·부채총계 한쪽이라도 미태깅이면 (부채와자본총계 or 자산총계) 로 상호 파생
  const eqTotal = blank();
  const lTotal = blank();
  for (const l of labels) {
    const be = leTotal[l] ?? aTotal[l] ?? null;
    eqTotal[l] = eqRaw[l] ?? (be != null && lRaw[l] != null ? be - lRaw[l]! : null);
    lTotal[l] = lRaw[l] ?? (be != null && eqTotal[l] != null ? be - eqTotal[l]! : null);
  }
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
      if (line.fallback) {
        const fb = value(line.fallback);
        for (const l of labels)
          if (resolved[line.label][l] == null && fb[l] != null) resolved[line.label][l] = fb[l];
      }
    }

    for (const line of block.lines) {
      let values: Record<string, number | null>;
      if (line.kind === "subtotal" || line.kind === "total") {
        const direct = line.concepts ? value(line.concepts) : null;
        // 태그 미제공 시 파생값으로 보충 (DAL·CAT 등)
        const derived: Record<string, number | null> | null =
          line.label === "부채 총계"
            ? lTotal
            : line.label === "자본 총계"
              ? eqTotal
              : line.label === "부채와 자본 총계"
                ? (() => {
                    const o = blank();
                    for (const l of labels) o[l] = leTotal[l] ?? aTotal[l] ?? null;
                    return o;
                  })()
                : null;
        const plug = line.plugOf ? totalOf[line.plugOf.replace(/Total$/, "")] : null;
        values = blank();
        for (const l of labels)
          values[l] = direct?.[l] ?? derived?.[l] ?? plug?.[l] ?? null;
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

  const debt = (() => {
    const o = blank();
    for (const c of DEBT) {
      const v = value([c]);
      for (const l of labels) if (v[l] != null) o[l] = (o[l] ?? 0) + v[l]!;
    }
    // 장기차입금을 유동/비유동 분리 없이 미분류 총액(LongTermDebt)으로만 태깅하는
    // 회사(AXP 등) — 분리 태그가 둘 다 없는 기(period)만 폴백으로 더한다.
    const ltdNc = value(["LongTermDebtNoncurrent"]);
    const ltdCur = value(["LongTermDebtCurrent"]);
    const ltdTotal = value(["LongTermDebt"]);
    for (const l of labels)
      if (ltdNc[l] == null && ltdCur[l] == null && ltdTotal[l] != null)
        o[l] = (o[l] ?? 0) + ltdTotal[l]!;
    return o;
  })();
  const cashLike = (() => {
    const o = blank();
    for (const c of CASH_LIKE) {
      const v = value([c]);
      for (const l of labels) if (v[l] != null) o[l] = (o[l] ?? 0) + v[l]!;
    }
    // 제한현금 포함 총액 하나로만 공시하는 회사(AXP 등) 폴백
    const cashPrimary = value(["CashAndCashEquivalentsAtCarryingValue"]);
    const cashTotal = value(["CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"]);
    for (const l of labels)
      if (cashPrimary[l] == null && cashTotal[l] != null) o[l] = (o[l] ?? 0) + cashTotal[l]!;
    return o;
  })();
  const netDebt = blank();
  for (const l of labels)
    if (debt[l] != null || cashLike[l] != null) netDebt[l] = (debt[l] ?? 0) - (cashLike[l] ?? 0);

  const nrow = (label: string, values: Record<string, number | null>, nf?: FinancialLineItem["numberFormat"]): FinancialLineItem => ({
    accountName: label,
    accountId: `bs:note:${label}`,
    depth: 1,
    isSubtotal: false,
    isHighlight: false,
    values,
    numberFormat: nf,
  });
  items.push(nrow("총차입금", debt));
  items.push(nrow("순차입금", netDebt));

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
