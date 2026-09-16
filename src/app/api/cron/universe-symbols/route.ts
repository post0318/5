import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { isMarketId, type MarketId } from "@/lib/markets/types";
import { listUniverseDistinct } from "@/lib/universe/repo";

/**
 * 수집 스크립트용 유니버스 심볼 목록 — **전 계정 합집합**(중복 제거).
 *
 * 유니버스가 계정별로 분리되면서 `/api/universe` 가 로그인 필수가 됐는데,
 * 수집 스크립트는 사람이 아니라 사용자 세션을 가질 수 없다. 그래서 다른
 * 수집 라우트와 똑같이 CRON_SECRET(또는 로컬 수동 실행용 APP_PASSWORD)로
 * 검증하는 별도 경로를 둔다. 어떤 종목이든 하루 1회만 외부에서 받아오면
 * 되므로 소유자를 가리지 않고 합쳐서 돌려준다.
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const appPw = process.env.APP_PASSWORD;
  if (appPw && req.headers.get("x-app-token") === appPw) return true;
  if (secret) return req.headers.get("authorization") === `Bearer ${secret}`;
  return false;
}

export async function GET(req: Request) {
  try {
    if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });

    const sp = new URL(req.url).searchParams;
    const marketParam = sp.get("market");
    const market =
      marketParam && isMarketId(marketParam) ? (marketParam as MarketId) : undefined;
    const activeOnly = sp.get("active") !== "0";

    const items = await listUniverseDistinct({ market, activeOnly });
    return ok(
      {
        count: items.length,
        items: items.map((i) => ({
          market: i.market,
          symbol: i.symbol,
          name: i.name,
          yahooSymbol: i.yahooSymbol,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return jsonError(err);
  }
}
