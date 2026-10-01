import { jsonError, ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId } from "@/lib/markets/types";
import { computeKr52wBeta } from "@/lib/markets/kr/beta";
import { computeUs52wBeta } from "@/lib/markets/us/beta";

export const maxDuration = 60;

/**
 * 52주 베타(+52주 최고·최저) — 일봉 두 개(종목·지수)만 쓰는 가벼운 계산이라 TTM 라우트와 분리했다(2026-10-01 — TTM 첫 조회가
 * 30초 넘게 걸려 베타까지 같이 늦던 문제). 미구현 시장은 { beta: null }.
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
    const sym = getAdapter(market).normalizeSymbol(decodeURIComponent(symbol));
    const yahoo = new URL(request.url).searchParams.get("yahoo");
    const beta =
      market === "kr"
        ? await computeKr52wBeta(sym, yahoo).catch(() => null)
        : market === "us"
          ? await computeUs52wBeta(sym, yahoo).catch(() => null)
          : null;
    return ok(
      { beta },
      { headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=86400" } },
    );
  } catch (err) {
    return jsonError(err);
  }
}
