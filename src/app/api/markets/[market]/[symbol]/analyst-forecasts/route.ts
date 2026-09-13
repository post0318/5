import { jsonError, ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import { getAdapter } from "@/lib/markets/registry";
import { isDbConfigured } from "@/lib/db";
import { getAnalystForecasts } from "@/lib/db/analyst-forecasts";

export const revalidate = 1800;

/**
 * 개별 애널리스트 투자의견(상위 5명). DB만 읽는다 — 수집은 로컬 스크립트가
 * 하루 1회 별도로 수행(src/lib/db/analyst-forecasts.ts 참고).
 * 미수집 종목·DB 미설정이면 빈 배열을 주고, 화면은 Yahoo 증권사 단위 표로
 * 폴백한다.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ market: string; symbol: string }> },
) {
  try {
    const { market, symbol } = await params;
    if (!isMarketId(market)) {
      return Response.json({ error: "알 수 없는 시장" }, { status: 404 });
    }
    if (!isDbConfigured()) return ok({ items: [] });

    const sym = getAdapter(market).normalizeSymbol(decodeURIComponent(symbol));
    const items = await getAnalystForecasts(market, sym);
    return ok(
      { items },
      { headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600" } },
    );
  } catch (err) {
    return jsonError(err);
  }
}
