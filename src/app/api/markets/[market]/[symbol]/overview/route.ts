import { jsonError, ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import { getStockOverview } from "@/lib/markets/service";

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
    const yahooOverride = searchParams.get("yahoo");
    const data = await getStockOverview(market, decodeURIComponent(symbol), yahooOverride);
    return ok(data);
  } catch (err) {
    return jsonError(err);
  }
}
