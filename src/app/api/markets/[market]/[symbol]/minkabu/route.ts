import { jsonError, ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { getMinkabuConsensus } from "@/lib/markets/jp/minkabu";

/**
 * 민카부(minkabu.jp) 애널리스트 컨센서스 — 일본 종목만(lib/markets/jp/minkabu.ts).
 * 화면 조회 때 가져오고 종목당 12시간 캐시. 실패해도 200 + warning(화면은 그 블록만 빠짐).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ market: string; symbol: string }> },
) {
  try {
    const { market, symbol } = await params;
    if (market !== "jp") return Response.json({ error: "일본 종목만 지원" }, { status: 404 });
    const sym = getAdapter("jp").normalizeSymbol(decodeURIComponent(symbol));
    const result = await getMinkabuConsensus(sym);
    return ok(result, {
      headers: {
        "Cache-Control": result.warning
          ? "no-store"
          : "public, s-maxage=3600, stale-while-revalidate=43200",
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
