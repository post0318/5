import { jsonError, ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import { fetchKrForeignOwnership } from "@/lib/markets/kr/foreign-ownership";

export const maxDuration = 30;

/** 외국인 보유비율 (한국 종목만). 그 외 시장은 { foreign: null }. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ market: string; symbol: string }> },
) {
  try {
    const { market, symbol } = await params;
    if (!isMarketId(market)) {
      return Response.json({ error: "알 수 없는 시장" }, { status: 404 });
    }
    const foreign =
      market === "kr"
        ? await fetchKrForeignOwnership(decodeURIComponent(symbol))
        : null;
    return ok(
      { foreign },
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
