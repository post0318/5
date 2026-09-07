import { ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import { getKrJurirNo } from "@/lib/markets/kr/opendart";
import { fetchKrRightsSchedule } from "@/lib/markets/kr/rights-schedule";

export const maxDuration = 30;

/**
 * 주식 권리일정 (한국만). 금융위원회_주식권리일정정보.
 * 종목 필터는 법인등록번호(crno) — DART 기업개황에서 조회.
 * 최선노력형 — 실패해도 500 대신 { events: [], pending, detail }.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ market: string; symbol: string }> },
) {
  const { market, symbol } = await params;
  if (!isMarketId(market)) {
    return Response.json({ error: "알 수 없는 시장" }, { status: 404 });
  }
  if (market !== "kr") return ok({ events: [] });

  const code = decodeURIComponent(symbol);
  try {
    const crno = await getKrJurirNo(code);
    if (!crno) return ok({ events: [], detail: "법인등록번호 조회 실패" });
    const events = (await fetchKrRightsSchedule(crno)) ?? [];
    return ok(
      { events },
      { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return ok({ events: [], pending: true, detail });
  }
}
