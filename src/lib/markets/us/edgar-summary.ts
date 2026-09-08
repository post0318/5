import "server-only";
import type { CompanyFacts } from "./edgar";
import type { FinancialStatement, FinancialLineItem } from "../types";
import { buildUsIncome } from "./edgar-income";
import { buildUsBalance } from "./edgar-balance";
import { buildUsCashFlow } from "./edgar-cashflow";

/**
 * 미국 공시기준 요약 (총괄) — IS·BS·CF 상세표에서 핵심 행만 추려 한 화면에.
 * 컬럼·단위는 상세표와 동일 (5개년 + 현재/LTM, 백만).
 */
export function buildUsSummary(
  facts: CompanyFacts,
  mode: "annual" | "quarter" = "annual",
): FinancialStatement {
  const is = buildUsIncome(facts, mode);
  const bs = buildUsBalance(facts, mode);
  const cf = buildUsCashFlow(facts, mode);

  const pick = (stmt: FinancialStatement, keys: string[]): FinancialLineItem[] => {
    const by = new Map(stmt.sections[0].items.map((it) => [it.accountName, it]));
    return keys
      .map((k) => by.get(k))
      .filter((x): x is FinancialLineItem => Boolean(x))
      .map((x) => ({ ...x, depth: 0 }));
  };

  const sections = [
    {
      title: "손익계산서",
      items: pick(is, ["매출액", "매출총이익", "영업이익", "세전이익", "당기순이익"]),
    },
    {
      title: "재무상태표",
      items: pick(bs, [
        "유동자산 총계",
        "자산 총계",
        "유동부채 총계",
        "부채 총계",
        "자본 총계",
        "부채와 자본 총계",
      ]),
    },
    {
      title: "현금흐름표",
      items: pick(cf, [
        "영업활동으로 인한 현금흐름",
        "투자활동으로 인한 현금흐름",
        "재무활동으로 인한 현금흐름",
        "현금및현금성자산 순증감",
      ]),
    },
  ].filter((s) => s.items.length > 0);

  return {
    symbol: "",
    market: "us",
    periodType: "annual",
    unit: "USD",
    currency: "USD",
    consolidation: "consolidated",
    periods: is.periods,
    sections,
    source: "SEC EDGAR · 표준화 재분류",
  };
}
