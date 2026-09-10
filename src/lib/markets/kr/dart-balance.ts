import "server-only";
import type { FinancialStatement, FinancialLineItem } from "../types";
import { type KrFacts, seriesOf, sumOf } from "./dart-facts";

/**
 * 한국 상세 재무상태표 — DART `fnlttSinglAcntAll` 정규화 재분류.
 * `edgar-balance.ts` 미러. "기타" 라인 = (구간 총계 − 매핑 라인) → 총계 항상 정합.
 */

const A_TOTAL = { ids: ["ifrs-full_Assets"], names: ["자산총계"] };
const A_CUR = { ids: ["ifrs-full_CurrentAssets"], names: ["유동자산"] };
const L_TOTAL = { ids: ["ifrs-full_Liabilities"], names: ["부채총계"] };
const L_CUR = { ids: ["ifrs-full_CurrentLiabilities"], names: ["유동부채"] };
const EQ = { ids: ["ifrs-full_Equity"], names: ["자본총계"] };
const LE_TOTAL = { ids: ["ifrs-full_EquityAndLiabilities"], names: ["부채와자본총계", "자본과부채총계"] };

// 차입금 개념은 회사·연도별 편차가 커 id 위주로 넓게 잡는다 (SK하이닉스는 유동·비유동 모두 "차입금" 명칭 → id 필수).
export const SHORT_DEBT: { ids: string[]; names?: string[] }[] = [
  {
    ids: [
      "ifrs-full_ShorttermBorrowings",
      "ifrs-full_CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings",
      "dart_ShortTermBorrowings",
    ],
    names: ["단기차입금"],
  },
  { ids: ["ifrs-full_CurrentPortionOfLongtermBorrowings", "dart_CurrentPortionOfLongTermDebt"], names: ["유동성장기부채", "유동성장기차입금"] },
  { ids: ["ifrs-full_ShorttermLeaseLiabilities", "ifrs-full_CurrentLeaseLiabilities", "dart_ShortTermLeaseLiability"], names: ["유동리스부채"] },
];
export const LONG_DEBT: { ids: string[]; names?: string[] }[] = [
  { ids: ["ifrs-full_NoncurrentPortionOfNoncurrentBondsIssued", "dart_BondsIssued"], names: ["사채"] },
  {
    ids: [
      "ifrs-full_NoncurrentPortionOfNoncurrentLoansReceived",
      "ifrs-full_LongtermBorrowings",
      "ifrs-full_NoncurrentBorrowings",
      "dart_LongTermBorrowingsGross",
      "dart_LongTermBorrowings",
    ],
    names: ["장기차입금"],
  },
  { ids: ["ifrs-full_NoncurrentLeaseLiabilities", "dart_LongTermLeaseLiability"], names: ["비유동리스부채"] },
];

interface Line {
  label: string;
  ids?: string[];
  names?: string[];
  combine?: { ids: string[]; names?: string[] }[];
  depth: number;
  kind?: "item" | "subtotal" | "total";
  plugOf?: string;
  highlight?: boolean;
}

const BLOCKS: { title: string; lines: Line[] }[] = [
  {
    title: "자산",
    lines: [
      { label: "현금·현금성자산", ids: ["ifrs-full_CashAndCashEquivalents"], names: ["현금및현금성자산"], depth: 1 },
      {
        label: "단기 투자자산",
        combine: [
          { ids: ["ifrs-full_ShorttermDepositsNotClassifiedAsCashEquivalents"], names: ["단기금융상품"] },
          { ids: ["ifrs-full_CurrentFinancialAssetsAtFairValueThroughProfitOrLoss"], names: ["단기당기손익-공정가치금융자산"] },
          { ids: ["ifrs-full_CurrentFinancialAssetsAtAmortisedCost"], names: ["단기상각후원가금융자산"] },
        ],
        depth: 1,
      },
      { label: "매출채권", ids: ["ifrs-full_CurrentTradeReceivables"], names: ["매출채권"], depth: 1 },
      { label: "재고자산", ids: ["ifrs-full_Inventories"], names: ["재고자산"], depth: 1 },
      { label: "기타 유동자산", depth: 1, plugOf: "cur" },
      { label: "유동자산 총계", depth: 0, kind: "subtotal", ids: A_CUR.ids, names: A_CUR.names },
      { label: "유형자산", ids: ["ifrs-full_PropertyPlantAndEquipment"], names: ["유형자산"], depth: 1 },
      { label: "무형자산", ids: ["ifrs-full_IntangibleAssetsAndGoodwill", "ifrs-full_IntangibleAssetsOtherThanGoodwill"], names: ["무형자산"], depth: 1 },
      { label: "관계기업 투자", ids: ["ifrs-full_InvestmentAccountedForUsingEquityMethod"], names: ["관계기업 및 공동기업 투자", "관계기업및공동기업투자"], depth: 1 },
      { label: "기타 비유동자산", depth: 1, plugOf: "noncur" },
      { label: "비유동자산 총계", depth: 0, kind: "subtotal", plugOf: "noncurTotal" },
      { label: "자산 총계", depth: 0, kind: "total", highlight: true, ids: A_TOTAL.ids, names: A_TOTAL.names },
    ],
  },
  {
    title: "부채",
    lines: [
      { label: "매입채무", ids: ["ifrs-full_TradeAndOtherCurrentPayablesToTradeSuppliers", "dart_ShortTermTradePayables"], names: ["매입채무"], depth: 1 },
      { label: "단기차입금·유동성장기부채", combine: SHORT_DEBT, depth: 1 },
      { label: "기타 유동부채", depth: 1, plugOf: "lcur" },
      { label: "유동부채 총계", depth: 0, kind: "subtotal", ids: L_CUR.ids, names: L_CUR.names },
      { label: "장기차입금·사채", combine: LONG_DEBT, depth: 1 },
      { label: "기타 장기부채", depth: 1, plugOf: "lnoncur" },
      { label: "비유동부채 총계", depth: 0, kind: "subtotal", plugOf: "lnoncurTotal" },
      { label: "부채 총계", depth: 0, kind: "total", highlight: true, ids: L_TOTAL.ids, names: L_TOTAL.names },
    ],
  },
  {
    title: "자본",
    lines: [
      {
        label: "자본금·주식발행초과금",
        combine: [
          { ids: ["ifrs-full_IssuedCapital"], names: ["자본금"] },
          { ids: ["ifrs-full_SharePremium"], names: ["주식발행초과금"] },
        ],
        depth: 1,
      },
      { label: "이익잉여금(결손금)", ids: ["ifrs-full_RetainedEarnings"], names: ["이익잉여금", "이익잉여금(결손금)"], depth: 1 },
      { label: "기타 자본 (비지배 포함)", depth: 1, plugOf: "eq" },
      { label: "자본 총계", depth: 0, kind: "total", highlight: true, ids: EQ.ids, names: EQ.names },
      { label: "부채와 자본 총계", depth: 0, kind: "total", highlight: true, ids: LE_TOTAL.ids, names: LE_TOTAL.names },
    ],
  },
];

export function buildKrBalance(facts: KrFacts): FinancialStatement {
  const labels = facts.periods.map((p) => p.label);
  const blank = (): Record<string, number | null> => Object.fromEntries(labels.map((l) => [l, null]));
  const val = (l: { ids?: string[]; names?: string[] }, sj = "BS") =>
    seriesOf(facts, l.ids ?? [], l.names ?? [], sj);

  const curTotal = val(A_CUR);
  const aTotal = val(A_TOTAL);
  const lcurTotal = val(L_CUR);
  const leTotal = val(LE_TOTAL);
  const eqRaw = val(EQ);
  const lRaw = val(L_TOTAL);
  const eqTotal = blank();
  const lTotal = blank();
  for (const l of labels) {
    const be = leTotal[l] ?? aTotal[l] ?? null;
    eqTotal[l] = eqRaw[l] ?? (be != null && lRaw[l] != null ? be - lRaw[l]! : null);
    lTotal[l] = lRaw[l] ?? (be != null && eqTotal[l] != null ? be - eqTotal[l]! : null);
  }
  const minus = (a: Record<string, number | null>, b: Record<string, number | null>) => {
    const o = blank();
    for (const l of labels) if (a[l] != null && b[l] != null) o[l] = a[l]! - b[l]!;
    return o;
  };
  const totalOf: Record<string, Record<string, number | null>> = {
    cur: curTotal,
    lcur: lcurTotal,
    eq: eqTotal,
    noncur: minus(aTotal, curTotal),
    lnoncur: minus(lTotal, lcurTotal),
    noncurTotal: minus(aTotal, curTotal),
    lnoncurTotal: minus(lTotal, lcurTotal),
  };

  const items: FinancialLineItem[] = [];
  for (const block of BLOCKS) {
    const resolved: Record<string, Record<string, number | null>> = {};
    for (const line of block.lines) {
      if (line.kind === "subtotal" || line.kind === "total" || line.plugOf) continue;
      resolved[line.label] = line.combine
        ? sumOf(facts, line.combine.map((c) => ({ ids: c.ids, names: c.names })), "BS")
        : val(line);
    }

    for (const line of block.lines) {
      let values: Record<string, number | null>;
      if (line.kind === "subtotal" || line.kind === "total") {
        const direct = line.ids || line.names ? val(line) : null;
        const derived =
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
        for (const l of labels) values[l] = direct?.[l] ?? derived?.[l] ?? plug?.[l] ?? null;
      } else if (line.plugOf) {
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

  // ── 주석 항목: 지배/비지배 지분 · 총차입금 / 순차입금 ──
  items.push({ accountName: "", accountId: "bs:sp", depth: 0, isSubtotal: false, isHighlight: false, values: blank() });
  items.push({ accountName: "[ 주석 항목 ]", accountId: "bs:note", depth: 0, isSubtotal: true, isHighlight: false, values: blank() });

  const parentEq = val({
    ids: ["ifrs-full_EquityAttributableToOwnersOfParent"],
    names: ["지배기업 소유주지분", "지배기업의 소유주지분"],
  });
  const nciEq = val({ ids: ["ifrs-full_NoncontrollingInterests"], names: ["비지배지분"] });

  const debt = sumOf(facts, [...SHORT_DEBT, ...LONG_DEBT], "BS");
  const cashLike = sumOf(
    facts,
    [
      { ids: ["ifrs-full_CashAndCashEquivalents"], names: ["현금및현금성자산"] },
      { ids: ["ifrs-full_ShorttermDepositsNotClassifiedAsCashEquivalents"], names: ["단기금융상품"] },
      { ids: ["ifrs-full_CurrentFinancialAssetsAtFairValueThroughProfitOrLoss"], names: ["단기당기손익-공정가치금융자산"] },
    ],
    "BS",
  );
  const netDebt = blank();
  for (const l of labels)
    if (debt[l] != null || cashLike[l] != null) netDebt[l] = (debt[l] ?? 0) - (cashLike[l] ?? 0);

  const nrow = (label: string, values: Record<string, number | null>): FinancialLineItem => ({
    accountName: label,
    accountId: `bs:note:${label}`,
    depth: 1,
    isSubtotal: false,
    isHighlight: false,
    values,
  });
  if (labels.some((l) => parentEq[l] != null)) items.push(nrow("지배주주 지분", parentEq));
  if (labels.some((l) => nciEq[l] != null)) items.push(nrow("비지배지분", nciEq));
  items.push(nrow("총차입금", debt));
  items.push(nrow("순차입금", netDebt));

  return {
    symbol: "",
    market: "kr",
    periodType: facts.mode === "quarter" ? "quarter" : "annual",
    unit: "원",
    currency: "KRW",
    consolidation: facts.fsDiv === "CFS" ? "consolidated" : "separate",
    periods: facts.periods.map((p) => ({
      label: p.label,
      fiscalYear: p.year,
      fiscalQuarter: p.quarter,
      endDate: p.endDate,
    })),
    sections: [{ title: "재무상태표", items }],
    source: facts.source + " · 표준화 재분류",
  };
}
