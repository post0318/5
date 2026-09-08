import { jsonError, ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId } from "@/lib/markets/types";
import { fetchUsCompanyFacts } from "@/lib/markets/us/edgar";
import { buildUsCashFlow } from "@/lib/markets/us/edgar-cashflow";
import { buildUsIncome } from "@/lib/markets/us/edgar-income";

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

    // 미국 상세 현금흐름표 / 손익계산서 (표준화 재분류 + LTM)
    const detailView = searchParams.get("view");
    if (market === "us" && (detailView === "cf" || detailView === "is")) {
      const { facts } = await fetchUsCompanyFacts(sym);
      const stmt =
        detailView === "cf"
          ? buildUsCashFlow(facts, period)
          : buildUsIncome(facts, period);
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
