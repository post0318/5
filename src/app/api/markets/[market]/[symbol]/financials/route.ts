import { jsonError, ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId } from "@/lib/markets/types";
import { fetchUsCompanyFacts } from "@/lib/markets/us/edgar";
import { buildUsCashFlow } from "@/lib/markets/us/edgar-cashflow";
import { buildUsIncome } from "@/lib/markets/us/edgar-income";
import { buildUsBalance } from "@/lib/markets/us/edgar-balance";
import { buildUsAnalysis } from "@/lib/markets/us/edgar-analysis";
import { buildUsSummary } from "@/lib/markets/us/edgar-summary";
import { getEodQuote } from "@/lib/markets/quote";
import { resolveCorpCode } from "@/lib/markets/kr/corpcode";
import { fetchKrFacts } from "@/lib/markets/kr/dart-facts";
import { buildKrIncome } from "@/lib/markets/kr/dart-income";
import { buildKrBalance } from "@/lib/markets/kr/dart-balance";
import { buildKrCashFlow } from "@/lib/markets/kr/dart-cashflow";
import { buildKrSummary } from "@/lib/markets/kr/dart-summary";

export const maxDuration = 60;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ market: string; symbol: string }> },
) {
  try {
    const { market, symbol } = await params;
    if (!isMarketId(market)) {
      return Response.json({ error: "알 수 없는 시장" }, { status: 404 });
    }
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") === "quarter" ? "quarter" : "annual";
    const adapter = getAdapter(market);
    const sym = adapter.normalizeSymbol(decodeURIComponent(symbol));

    // 상세 재분류 뷰 (미국·한국)
    const detailView = searchParams.get("view");
    const isDetail =
      detailView === "cf" ||
      detailView === "is" ||
      detailView === "bs" ||
      detailView === "analysis" ||
      detailView === "summary";

    if (market === "kr" && isDetail && detailView !== "analysis") {
      const { corpCode } = resolveCorpCode("", sym);
      const facts = await fetchKrFacts(corpCode, period);
      if (!facts) {
        return Response.json({ error: "재무제표를 찾을 수 없습니다" }, { status: 404 });
      }
      const stmt =
        detailView === "cf"
          ? buildKrCashFlow(facts)
          : detailView === "is"
            ? buildKrIncome(facts)
            : detailView === "bs"
              ? buildKrBalance(facts)
              : buildKrSummary(facts);
      stmt.symbol = sym;
      return ok(stmt, {
        headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=86400" },
      });
    }

    if (market === "us" && isDetail) {
      const yahoo = searchParams.get("yahoo");
      const [{ facts }, quote] = await Promise.all([
        fetchUsCompanyFacts(sym),
        detailView === "analysis"
          ? getEodQuote("us", sym, { yahooOverride: yahoo }).catch(() => null)
          : Promise.resolve(null),
      ]);
      const stmt =
        detailView === "cf"
          ? buildUsCashFlow(facts, period)
          : detailView === "is"
            ? buildUsIncome(facts, period)
            : detailView === "bs"
              ? buildUsBalance(facts, period)
              : detailView === "summary"
                ? buildUsSummary(facts, period)
                : buildUsAnalysis(facts, quote?.bars ?? []);
      stmt.symbol = sym;
      return ok(stmt, {
        headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=86400" },
      });
    }

    const statement = await adapter.getFinancials(sym, period);
    return ok(statement, {
      headers: {
        "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=86400",
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
