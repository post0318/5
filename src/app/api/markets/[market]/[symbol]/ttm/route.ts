import { jsonError, ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId } from "@/lib/markets/types";
import { fetchKrDA } from "@/lib/markets/kr/xbrl";
import { getKrJurirNo } from "@/lib/markets/kr/opendart";
import { fetchKrAnnualDps } from "@/lib/markets/kr/rights-schedule";

export const maxDuration = 60;

/**
 * TTM(최근 4분기) 플로우 + 감가상각비(연결, XBRL) — 트레일링PER·EV/EBITDA 계산용.
 * 미구현 시장은 { ttm: null, da: null }.
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
    const adapter = getAdapter(market);
    const sym = adapter.normalizeSymbol(decodeURIComponent(symbol));
    const fy = new Date().getFullYear() - 1;
    const [ttm, da, dividend] = await Promise.all([
      adapter.getTtm ? adapter.getTtm(sym) : Promise.resolve(null),
      market === "kr"
        ? fetchKrDA(sym, fy)
            .then((r) => r ?? fetchKrDA(sym, fy - 1))
            .catch(() => null)
        : Promise.resolve(null),
      market === "kr"
        ? getKrJurirNo(sym)
            .then((crno) => fetchKrAnnualDps(crno))
            .catch(() => null)
        : Promise.resolve(null),
    ]);
    return ok(
      { ttm, da, dividend },
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
