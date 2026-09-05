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
    const period = searchParams.get("period") === "quarter" ? "quarter" : "annual";
    const adapter = getAdapter(market);
    const statement = await adapter.getFinancials(
      adapter.normalizeSymbol(decodeURIComponent(symbol)),
      period,
    );
    return ok(statement, {
      headers: {
        "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=86400",
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
