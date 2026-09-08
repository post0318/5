import { jsonError, ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId } from "@/lib/markets/types";
import { getKrJurirNo } from "@/lib/markets/kr/opendart";
import { fetchKrAnnualDps } from "@/lib/markets/kr/rights-schedule";
import { computeKr52wBeta } from "@/lib/markets/kr/beta";
import { computeUs52wBeta } from "@/lib/markets/us/beta";

export const maxDuration = 60;

/**
 * TTM(최근 4분기) 플로우 + 국내 보조지표(주당배당금, 52주 베타).
 * 미구현 시장은 { ttm: null, dividend: null, beta: null }.
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
    const yahoo = new URL(request.url).searchParams.get("yahoo");
    const [ttm, krDividend, beta] = await Promise.all([
      adapter.getTtm ? adapter.getTtm(sym) : Promise.resolve(null),
      market === "kr"
        ? getKrJurirNo(sym)
            .then((crno) => fetchKrAnnualDps(crno))
            .catch(() => null)
        : Promise.resolve(null),
      market === "kr"
        ? computeKr52wBeta(sym, yahoo).catch(() => null)
        : market === "us"
          ? computeUs52wBeta(sym, yahoo).catch(() => null)
          : Promise.resolve(null),
    ]);

    // 미국(EDGAR)은 주당배당금도 TTM 페이로드에 실려 온다 → 국내와 동일 형태로 변환.
    let dividend = krDividend as {
      annual: { dps: number; year: number } | null;
      ttm: { dps: number; from: string; to: string } | null;
    } | null;
    if (!dividend && ttm?.dpsAnnual) {
      dividend = {
        annual: {
          dps: ttm.dpsAnnual.dps,
          year: Number(ttm.dpsAnnual.label.match(/FY(\d{4})/)?.[1]) || 0,
        },
        ttm: ttm.dpsTtm ?? null,
      };
    }

    return ok(
      { ttm, dividend, beta },
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
