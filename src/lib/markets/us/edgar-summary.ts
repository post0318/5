import "server-only";
import type { CompanyFacts } from "./edgar";
import type { FinancialStatement, FinancialLineItem } from "../types";
import { buildUsIncome } from "./edgar-income";
import { buildUsBalance } from "./edgar-balance";
import { buildUsCashFlow } from "./edgar-cashflow";
import type { ClassAFacts } from "./edgar-classfacts";

/**
 * 미국 공시기준 요약 (총괄) — IS·BS·CF 상세표에서 핵심 행만 추려 한 화면에.
 * 컬럼·단위는 상세표와 동일 (5개년 + 현재/LTM, 백만). 분기 모드는 최근 5분기.
 * 본문은 강조(연주황) 없이 평범한 행으로 — 표시측에서 짝수행 옅은 배경 처리.
 */
export function buildUsSummary(
  facts: CompanyFacts,
  mode: "annual" | "quarter" = "annual",
  opts: { sharesHint?: number | null; classFacts?: ClassAFacts | null } = {},
): FinancialStatement {
  const is = buildUsIncome(facts, mode, opts);
  const bs = buildUsBalance(facts, mode);
  const cf = buildUsCashFlow(facts, mode);

  const periods = is.periods;
  const tLabels = periods.map((p) => p.label);

  /** stmt 의 지정 계정 행을 총괄 컬럼(라벨 우선, 없으면 index 정렬)으로 재매핑. */
  const rowsFrom = (
    stmt: FinancialStatement,
    keys: string[],
  ): Map<string, Record<string, number | null>> => {
    const src = stmt.periods.map((p) => p.label);
    const by = new Map(stmt.sections[0].items.map((it) => [it.accountName, it]));
    const out = new Map<string, Record<string, number | null>>();
    for (const k of keys) {
      const it = by.get(k);
      if (!it) continue;
      const v: Record<string, number | null> = {};
      tLabels.forEach((tl, i) => {
        v[tl] =
          it.values[tl] ??
          (src.length === tLabels.length ? (it.values[src[i]] ?? null) : null);
      });
      out.set(k, v);
    }
    return out;
  };

  const mkItem = (
    name: string,
    values: Record<string, number | null>,
    id: string,
  ): FinancialLineItem => ({
    accountName: name,
    accountId: id,
    depth: 0,
    isSubtotal: false,
    isHighlight: false,
    values,
  });

  // ── 손익계산서: 매출액 / 영업비용 / 영업이익 / 당기순이익 ──
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

  // ── 재무상태표: 자산 / 부채 / 자본 / 부채와 자본 ("총계" 제거, 유동 항목 제외) ──
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

  // ── 현금흐름표 ──
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
    market: "us",
    periodType: "annual",
    unit: "USD",
    currency: "USD",
    consolidation: "consolidated",
    periods,
    sections,
    source: "SEC EDGAR · 표준화 재분류",
  };
}
