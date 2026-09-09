import "server-only";
import type { FinancialStatement, FinancialLineItem } from "../types";
import type { KrFacts, KrDaInput } from "./dart-facts";
import { buildKrIncome } from "./dart-income";
import { buildKrBalance } from "./dart-balance";
import { buildKrCashFlow } from "./dart-cashflow";

/**
 * 한국 공시기준 요약 (총괄) — `edgar-summary.ts` 미러.
 * IS·BS·CF 상세표에서 핵심 행만 추려 한 화면에. 컬럼·단위는 상세표와 동일.
 */
export function buildKrSummary(facts: KrFacts, daDoc: KrDaInput | null = null): FinancialStatement {
  const is = buildKrIncome(facts, daDoc);
  const bs = buildKrBalance(facts);
  const cf = buildKrCashFlow(facts);
  const periods = is.periods;
  const tLabels = periods.map((p) => p.label);

  const rowsFrom = (stmt: FinancialStatement, keys: string[]): Map<string, Record<string, number | null>> => {
    const by = new Map(stmt.sections[0].items.map((it) => [it.accountName, it]));
    const out = new Map<string, Record<string, number | null>>();
    for (const k of keys) {
      const it = by.get(k);
      if (!it) continue;
      const v: Record<string, number | null> = {};
      for (const tl of tLabels) v[tl] = it.values[tl] ?? null;
      out.set(k, v);
    }
    return out;
  };
  const mkItem = (name: string, values: Record<string, number | null>, id: string): FinancialLineItem => ({
    accountName: name,
    accountId: id,
    depth: 0,
    isSubtotal: false,
    isHighlight: false,
    values,
  });

  // 손익: 매출액 / 영업비용(=매출−영업이익) / 영업이익 / 당기순이익
  const isr = rowsFrom(is, ["매출액", "영업이익", "당기순이익"]);
  const rev = isr.get("매출액");
  const op = isr.get("영업이익");
  const ni = isr.get("당기순이익");
  const opCost: Record<string, number | null> = {};
  for (const tl of tLabels) {
    const r = rev?.[tl];
    const o = op?.[tl];
    opCost[tl] = r != null && o != null ? Math.round(r - o) : null;
  }
  const isItems: FinancialLineItem[] = [];
  if (rev) isItems.push(mkItem("매출액", rev, "sum:is:rev"));
  isItems.push(mkItem("영업비용", opCost, "sum:is:opcost"));
  if (op) isItems.push(mkItem("영업이익", op, "sum:is:op"));
  if (ni) isItems.push(mkItem("당기순이익", ni, "sum:is:ni"));

  // BS
  const bsMap: [string, string][] = [
    ["자산 총계", "자산"],
    ["부채 총계", "부채"],
    ["자본 총계", "자본"],
    ["부채와 자본 총계", "부채와 자본"],
  ];
  const bsr = rowsFrom(bs, bsMap.map(([k]) => k));
  const bsItems: FinancialLineItem[] = [];
  for (const [k, short] of bsMap) {
    const v = bsr.get(k);
    if (v) bsItems.push(mkItem(short, v, `sum:bs:${short}`));
  }

  // CF
  const cfKeys = [
    "영업활동으로 인한 현금흐름",
    "투자활동으로 인한 현금흐름",
    "재무활동으로 인한 현금흐름",
    "현금및현금성자산 순증감",
  ];
  const cfr = rowsFrom(cf, cfKeys);
  const cfItems: FinancialLineItem[] = [];
  for (const k of cfKeys) {
    const v = cfr.get(k);
    if (v) cfItems.push(mkItem(k, v, `sum:cf:${k}`));
  }

  const sections = [
    { title: "손익계산서", items: isItems },
    { title: "재무상태표", items: bsItems },
    { title: "현금흐름표", items: cfItems },
  ].filter((s) => s.items.length > 0);

  return {
    symbol: "",
    market: "kr",
    periodType: facts.mode === "quarter" ? "quarter" : "annual",
    unit: "원",
    currency: "KRW",
    consolidation: facts.fsDiv === "CFS" ? "consolidated" : "separate",
    periods,
    sections,
    source: facts.source + " · 표준화 재분류",
  };
}
