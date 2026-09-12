import { jsonError, ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import { getAdapter } from "@/lib/markets/registry";
import { isDbConfigured } from "@/lib/db";
import { getShinhanResearchBySymbol } from "@/lib/db/shinhan-research";

export const revalidate = 1800;

/**
 * 신한투자증권 기업분석 리포트 — 한국 종목만. DB만 읽는다(크롤링은 로컬
 * 스크립트가 별도로 수행 — src/lib/db/shinhan-research.ts 참고).
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
    if (market !== "kr" || !isDbConfigured()) return ok({ items: [] });

    const sym = getAdapter(market).normalizeSymbol(decodeURIComponent(symbol));
    const items = await getShinhanResearchBySymbol(sym);
    return ok(
      { items },
      { headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600" } },
    );
  } catch (err) {
    return jsonError(err);
  }
}
