import { jsonError, ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import { getAdapter } from "@/lib/markets/registry";
import { fetchUsCompanyFacts, fetchUsSic } from "@/lib/markets/us/edgar";
import { isMortgageReit } from "@/lib/markets/us/edgar-ev";

export const revalidate = 86400;

/**
 * 종목분석 지원 여부. 모기지 리츠(NLY·AGNC 등)는 분석 대상에서 제외한다
 * (오너 결정 2026-09-23 — 차입금이 영업용인 금융업 구조라 EV/EBITDA 등이
 * 성립하지 않고, 전용 지표를 따로 만들지 않기로 함).
 *
 * 판정이 실패하면(SEC 장애 등) 지원으로 둔다 — 정상 종목을 막는 쪽이 더 나쁘다.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ market: string; symbol: string }> },
) {
  try {
    const { market, symbol } = await params;
    if (!isMarketId(market)) return Response.json({ error: "알 수 없는 시장" }, { status: 404 });
    if (market !== "us") return ok({ supported: true });

    const sym = getAdapter(market).normalizeSymbol(decodeURIComponent(symbol));
    try {
      const [{ facts }, sic] = await Promise.all([fetchUsCompanyFacts(sym), fetchUsSic(sym)]);
      if (isMortgageReit(facts, sic)) {
        return ok(
          {
            supported: false,
            reason: "모기지 리츠는 부동산이 아니라 모기지 채권에 투자하는 금융업 구조라 종목분석 대상에서 제외됩니다.",
          },
          { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" } },
        );
      }
    } catch {
      /* 판정 실패 → 지원으로 둔다 */
    }
    return ok(
      { supported: true },
      { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" } },
    );
  } catch (err) {
    return jsonError(err);
  }
}
