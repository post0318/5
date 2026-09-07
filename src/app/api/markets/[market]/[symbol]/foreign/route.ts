import { jsonError, ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import {
  fetchKrForeignOwnership,
  fetchKrNaverConsensus,
} from "@/lib/markets/kr/naver";

export const maxDuration = 30;

/**
 * 한국 종목 네이버 보조지표: 외국인 보유비율 + FnGuide 컨센서스.
 * 그 외 시장은 { foreign: null, consensus: null }.
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
    if (market !== "kr") return ok({ foreign: null, consensus: null });

    const code = decodeURIComponent(symbol);
    const [foreign, consensus] = await Promise.all([
      fetchKrForeignOwnership(code),
      fetchKrNaverConsensus(code),
    ]);
    return ok(
      { foreign, consensus },
      {
        headers: {
          "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
        },
      },
    );
  } catch (err) {
    return jsonError(err);
  }
}
