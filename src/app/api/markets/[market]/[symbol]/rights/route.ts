import { jsonError, ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import {
  fetchKrRightsSchedule,
  resolveKrIsin,
} from "@/lib/markets/kr/rights-schedule";

export const maxDuration = 30;

/**
 * 주식 권리일정 (한국만). 금융위원회_주식권리일정정보.
 * ?name= 주식발행회사명 (선택 — 없으면 ISIN 으로만 조회)
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
    if (market !== "kr") return ok({ events: [] });

    const code = decodeURIComponent(symbol);
    const name = new URL(request.url).searchParams.get("name");
    const isin = await resolveKrIsin(code);
    try {
      const events = (await fetchKrRightsSchedule(name, isin)) ?? [];
      return ok(
        { events },
        {
          headers: {
            "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
          },
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // API 미승인/전파대기는 500 대신 안내 상태로
      if (msg.includes("NO_OPENAPI") || msg.includes("전파대기") || msg.includes("미승인")) {
        return ok({ events: [], pending: true, detail: msg });
      }
      throw err;
    }
  } catch (err) {
    return jsonError(err);
  }
}
