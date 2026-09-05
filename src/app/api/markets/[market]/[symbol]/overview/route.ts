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
    // 개요 화면은 분기 재무제표를 표시하지 않는다(멀티플도 연간 우선, 분기는
    // 연간이 아예 없을 때만 쓰는 폴백). 분기 조회는 최악의 경우 OpenDART 를
    // 십수 번 순차 호출해 초기 렌더를 크게 지연시키므로 여기선 건너뛴다.
    // 분기 데이터는 "재무제표" 탭이 별도 엔드포인트로 가져온다.
    const data = await getStockOverview(market, decodeURIComponent(symbol), yahooOverride, {
      // 멀티플은 클라이언트가 "재무제표" 탭 데이터(annual)로 직접 계산한다.
      // OpenDART 전체 재무제표 호출(6~15초)이 개요 지연의 유일한 원인이었음.
      skipFinancials: true,
    });
    return ok(data, {
      headers: {
        // EOD 대시보드 — 반복 조회는 CDN에서 즉시, 백그라운드 갱신
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
