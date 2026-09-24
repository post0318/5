import { jsonError, ok } from "@/lib/api";
import { getStockOverview } from "@/lib/markets/service";
import { computeUniverseRow } from "@/lib/universe/overview";

/**
 * 재무 검증 스크립트(scripts/verify-financials.mjs) 전용 — 화면이 실제로 쓰는 계산 함수의
 * 결과를 그대로 돌려준다. 검증기가 식을 따로 짜서 비교하면 화면과 다른 경로를 검증하게
 * 된다(검증 도구 감사 2026-09-24).
 *   - universe: 유니버스 통합 뷰 한 행(computeUniverseRow — 한국은 computeKrOverviewMetrics)
 *   - overview: 종목분석 개요 멀티플(getStockOverview + computeTrailingMultiples, 재무 포함)
 * 인증은 다른 cron 경로와 같다(CRON_SECRET, 로컬은 APP_PASSWORD). DB 불필요.
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const appPw = process.env.APP_PASSWORD;
  if (appPw && req.headers.get("x-app-token") === appPw) return true;
  if (secret) return req.headers.get("authorization") === `Bearer ${secret}`;
  return false;
}

export const maxDuration = 120;

export async function GET(req: Request) {
  try {
    if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const sp = new URL(req.url).searchParams;
    const market = sp.get("market");
    const symbol = sp.get("symbol");
    if ((market !== "us" && market !== "kr") || !symbol)
      return Response.json({ error: "market=us|kr, symbol 필요" }, { status: 400 });
    // 순서대로 — 동시에 돌리면 같은 시세를 두 번 받다가 제한시간(12초)에 걸려 결과가 비었다
    const universe = await computeUniverseRow(market, symbol);
    const overview = await getStockOverview(market, symbol, null, { skipQuarterly: true });
    return ok({ universe, overview: { multiples: overview.multiples, warnings: overview.warnings } });
  } catch (e) {
    return jsonError(e);
  }
}
