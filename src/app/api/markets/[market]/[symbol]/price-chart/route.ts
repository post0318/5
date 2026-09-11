import { jsonError, ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId } from "@/lib/markets/types";
import { fetchYahooEod } from "@/lib/markets/quote/yahoo";

export const maxDuration = 30;

/**
 * 종가 칩 클릭 시 가격 추이 차트용 — 볼린저밴드·MACD 없이 종가만.
 * 전체 보유 기간(2000~)을 한 번에 받아 클라이언트에서 기간 버튼으로 자르므로,
 * 기간 전환 시 재조회가 없다. maxYears 로 실제 조회 가능한 최대 기간을 같이
 * 내려줘 화면에서 "3년 최대" 처럼 데이터 없는 구간을 안내할 수 있게 한다.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ market: string; symbol: string }> },
) {
  try {
    const { market, symbol } = await params;
    if (!isMarketId(market)) {
      return Response.json({ error: "알 수 없는 시장" }, { status: 404 });
    }
    const adapter = getAdapter(market);
    const sym = adapter.normalizeSymbol(decodeURIComponent(symbol));
    const yahoo = new URL(request.url).searchParams.get("yahoo");

    const bars = await fetchYahooEod(market, sym, { from: "2000-01-01", yahooOverride: yahoo });
    if (bars.length < 2) return ok({ rows: [], maxYears: 0 });

    const firstMs = new Date(bars[0].date).getTime();
    const maxYears = (Date.now() - firstMs) / (365.25 * 24 * 3600 * 1000);
    const rows = bars.map((b) => ({ date: b.date, close: b.close as number }));

    return ok(
      { rows, maxYears },
      { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
    );
  } catch (err) {
    return jsonError(err);
  }
}
