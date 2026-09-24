import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { verifyResultsCol, type VerifyResultDoc } from "@/lib/db/verify-results";
import { isMarketId } from "@/lib/markets/types";
import { listUniverseDistinct } from "@/lib/universe/repo";

export const maxDuration = 60;

/**
 * 재무 검증 결과 수신·미검증 목록 — 검증 스크립트(GitHub Actions) 전용. 다른 수집 라우트와 같이
 * CRON_SECRET(로컬 수동 실행은 x-app-token: APP_PASSWORD)으로 검증한다.
 *
 *  POST { results: VerifyResultDoc[] }  → 종목별 최신 결과로 교체
 *  GET  ?missing=1&market=us            → 유니버스(전 계정 합집합) 중 검증 결과가 없는 종목
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const appPw = process.env.APP_PASSWORD;
  if (appPw && req.headers.get("x-app-token") === appPw) return true;
  if (secret) return req.headers.get("authorization") === `Bearer ${secret}`;
  return false;
}

export async function POST(req: Request) {
  try {
    if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });
    const body = (await req.json()) as { results?: Omit<VerifyResultDoc, "_id">[] };
    if (!Array.isArray(body.results)) return Response.json({ error: "results 배열 필요" }, { status: 400 });
    const col = await verifyResultsCol();
    let saved = 0;
    for (const r of body.results) {
      if (!isMarketId(r.market) || !r.symbol) continue;
      const _id = `${r.market}:${r.symbol}`;
      await col.replaceOne({ _id }, r, { upsert: true });
      saved++;
    }
    return ok({ saved });
  } catch (err) {
    return jsonError(err);
  }
}

export async function GET(req: Request) {
  try {
    if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });
    const m = new URL(req.url).searchParams.get("market");
    const market = m && isMarketId(m) ? m : undefined;
    const universe = await listUniverseDistinct({ market, activeOnly: true });
    const col = await verifyResultsCol();
    const done = new Set((await col.find({}, { projection: { _id: 1 } }).toArray()).map((d) => d._id));
    const missing = universe.filter((u) => !done.has(`${u.market}:${u.symbol}`)).map((u) => ({ market: u.market, symbol: u.symbol }));
    return ok({ count: missing.length, items: missing }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return jsonError(err);
  }
}
