import { jsonError, ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId } from "@/lib/markets/types";

export const maxDuration = 60;

/** TTM(최근 4분기) 플로우 — 트레일링PER 계산용. 미구현 시장은 { ttm: null }. */
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
    const ttm = adapter.getTtm
      ? await adapter.getTtm(adapter.normalizeSymbol(decodeURIComponent(symbol)))
      : null;
    return ok(
      { ttm },
      {
        headers: {
          "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=86400",
        },
      },
    );
  } catch (err) {
    return jsonError(err);
  }
}
