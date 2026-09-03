import { jsonError, ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId } from "@/lib/markets/types";

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
    const limit = Math.min(Number(searchParams.get("limit") ?? 20) || 20, 100);
    const adapter = getAdapter(market);
    const filings = await adapter.getFilings(
      adapter.normalizeSymbol(decodeURIComponent(symbol)),
      { limit },
    );
    return ok({ filings });
  } catch (err) {
    return jsonError(err);
  }
}
