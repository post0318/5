import { jsonError, ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId } from "@/lib/markets/types";
import { fetchStockNews } from "@/lib/news";

export const revalidate = 1800;
export const maxDuration = 20;

/** 종목분석 "주요 코멘트" 탭용 — 특정 한 종목의 뉴스. */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const market = searchParams.get("market");
    const rawSymbol = searchParams.get("symbol");
    const name = searchParams.get("name");
    if (!market || !isMarketId(market) || !rawSymbol) {
      return Response.json({ error: "잘못된 요청" }, { status: 400 });
    }
    const symbol = getAdapter(market).normalizeSymbol(rawSymbol);
    const items = await fetchStockNews(market, symbol, name, 10);
    return ok(
      { items },
      { headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600" } },
    );
  } catch (err) {
    return jsonError(err);
  }
}
