import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { ageMs, getCachedStockNews } from "@/lib/db/stock-news";
import { getAdapter } from "@/lib/markets/registry";
import { refreshStockNews } from "@/lib/markets/stock-news-cache";
import { isMarketId, type MarketId } from "@/lib/markets/types";
import { listUniverseDistinct } from "@/lib/universe/repo";

export const maxDuration = 300;

/**
 * 유니버스 종목뉴스 미리 수집 — `stock_news` 컬렉션을 채운다(2026-09-17).
 *
 * 종목뉴스를 요청 시점에 긁으면 처음 보는 종목이 4.5~9.3초 걸린다(실측).
 * 크론이 미리 받아두면 화면은 DB 만 읽어 0.2초 안에 뜬다.
 *
 * 한 종목이 5~10초라 77종목을 순차로 돌면 300초 한도를 넘는다. 동시 4건으로
 * 묶고, 시간 예산을 넘기면 남은 종목은 다음 회차로 넘긴다(오래된 것부터 처리
 * 하므로 몇 회차 안에 한 바퀴 돈다).
 *
 * 쿼리:
 *  · `?market=kr`  특정 시장만
 *  · `?limit=20`   이번 회차 최대 종목 수
 *  · `?force=1`    신선도와 무관하게 전부 다시 받는다
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const appPw = process.env.APP_PASSWORD;
  if (appPw && req.headers.get("x-app-token") === appPw) return true;
  if (secret) return req.headers.get("authorization") === `Bearer ${secret}`;
  return false;
}

/** 동시 실행 수 — 외부 API(네이버·야후·구글)에 과부하를 주지 않는 선 */
const CONCURRENCY = 4;
/** 함수 한도(300초)에 여유를 두고 끊는다 */
const TIME_BUDGET_MS = 240_000;
/** 이보다 최근에 받은 종목은 건너뛴다 — 크론이 자주 돌아도 헛일하지 않게 */
const SKIP_IF_NEWER_MS = 30 * 60_000;

export async function GET(req: Request) {
  try {
    if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });

    const sp = new URL(req.url).searchParams;
    const marketParam = sp.get("market");
    const market =
      marketParam && isMarketId(marketParam) ? (marketParam as MarketId) : undefined;
    const limit = Number(sp.get("limit")) || 0;
    const force = sp.get("force") === "1";

    const universe = await listUniverseDistinct({ market, activeOnly: true });

    // 오래된 것부터 — 시간 예산에 걸려 중간에 끊겨도 신선도가 고르게 유지된다
    const withAge = await Promise.all(
      universe.map(async (item) => {
        const m = item.market as MarketId;
        const sym = getAdapter(m).normalizeSymbol(item.symbol);
        const doc = await getCachedStockNews(m, sym);
        return { market: m, symbol: sym, age: ageMs(doc) };
      }),
    );
    let targets = withAge
      .filter((t) => force || t.age >= SKIP_IF_NEWER_MS)
      .sort((a, b) => b.age - a.age);
    const skipped = withAge.length - targets.length;
    if (limit > 0) targets = targets.slice(0, limit);

    const started = Date.now();
    const done: string[] = [];
    const failed: { symbol: string; error: string }[] = [];
    let ranOutOfTime = 0;

    let cursor = 0;
    async function worker() {
      for (;;) {
        const i = cursor++;
        if (i >= targets.length) return;
        if (Date.now() - started > TIME_BUDGET_MS) {
          ranOutOfTime = targets.length - i;
          cursor = targets.length; // 다른 워커도 멈춘다
          return;
        }
        const t = targets[i];
        try {
          const r = await refreshStockNews(t.market, t.symbol);
          done.push(`${t.market}:${t.symbol}(${r.domestic.length}+${r.overseas.length})`);
        } catch (err) {
          failed.push({
            symbol: `${t.market}:${t.symbol}`,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker),
    );

    return ok(
      {
        universe: universe.length,
        targeted: targets.length,
        skippedFresh: skipped,
        refreshed: done.length,
        failed: failed.length,
        remaining: ranOutOfTime,
        elapsedMs: Date.now() - started,
        done,
        errors: failed,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return jsonError(err);
  }
}
