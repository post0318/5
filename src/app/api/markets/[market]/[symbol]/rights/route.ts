import { ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId } from "@/lib/markets/types";
import { getKrJurirNo } from "@/lib/markets/kr/opendart";
import { fetchKrRightsSchedule } from "@/lib/markets/kr/rights-schedule";
import { fetchUsRightsSchedule } from "@/lib/markets/us/rights-schedule";

export const maxDuration = 30;

/**
 * 주식 권리일정. 한국: 금융위 주식권리일정정보 + 배당정보 + DART 공시.
 * 미국: yahoo-finance2 배당/분할 이벤트 + calendarEvents. 최선노력형.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ market: string; symbol: string }> },
) {
  const { market, symbol } = await params;
  if (!isMarketId(market)) {
    return Response.json({ error: "알 수 없는 시장" }, { status: 404 });
  }

  if (market === "us") {
    const adapter = getAdapter("us");
    const sym = adapter.normalizeSymbol(decodeURIComponent(symbol));
    const yahoo = new URL(request.url).searchParams.get("yahoo");
    try {
      const events = await fetchUsRightsSchedule(sym, yahoo);
      return ok(
        { events },
        { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
      );
    } catch (err) {
      return ok({ events: [], detail: err instanceof Error ? err.message : String(err) });
    }
  }

  if (market !== "kr") return ok({ events: [] });

  const adapter = getAdapter("kr");
  const code = adapter.normalizeSymbol(decodeURIComponent(symbol));
  try {
    const [crno, filings] = await Promise.all([
      getKrJurirNo(code),
      adapter.getFilings(code, { limit: 100 }).catch(() => []),
    ]);
    if (!crno) return ok({ events: [], detail: "법인등록번호 조회 실패" });
    const events =
      (await fetchKrRightsSchedule(
        crno,
        code,
        filings.map((f) => ({ title: f.title, url: f.url, date: f.date })),
      )) ?? [];
    return ok(
      { events },
      { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return ok({ events: [], pending: true, detail });
  }
}
