import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import {
  replaceAnalystForecasts,
  type AnalystForecastDoc,
} from "@/lib/db/analyst-forecasts";
import { isMarketId } from "@/lib/markets/types";

export const maxDuration = 60;

/**
 * 개별 애널리스트 투자의견 수집 수신처 — 로컬 스크립트(scripts/
 * collect-analyst-forecasts.mjs)가 종목 단위로 보낸다. 이 라우트 자체는
 * 외부를 크롤링하지 않는다: 이미 수집된 결과를 받아 DB 에 적재만 하고,
 * 배포된 앱은 DB 조회만 한다(다른 리서치 수집기와 동일 구조).
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const appPw = process.env.APP_PASSWORD;
  if (appPw && req.headers.get("x-app-token") === appPw) return true;
  if (secret) return req.headers.get("authorization") === `Bearer ${secret}`;
  return false;
}

interface RawItem {
  date: string;
  analyst: string;
  analystSlug?: string | null;
  firm: string;
  rating: string;
  ratingOld?: string | null;
  action: string;
  priceTarget?: number | null;
  priceTargetOld?: number | null;
  currency?: string | null;
  score?: number | null;
  stars?: number | null;
  successRate?: number | null;
  avgReturn?: number | null;
  analystRank?: number | null;
  rankedExperts?: number | null;
  totalRatings?: number | null;
  stockSuccessRate?: number | null;
  stockAvgReturn?: number | null;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export async function POST(req: Request) {
  try {
    if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });

    const body = (await req.json()) as {
      items?: RawItem[];
      symbol?: string;
      market?: string;
    };
    if (!Array.isArray(body.items)) {
      return Response.json({ error: "items 배열 필요" }, { status: 400 });
    }
    const symbol = body.symbol?.trim().toUpperCase();
    if (!symbol) return Response.json({ error: "symbol 필요" }, { status: 400 });
    const market = body.market && isMarketId(body.market) ? body.market : "us";

    const now = new Date().toISOString();
    const docs: AnalystForecastDoc[] = body.items
      .filter((it) => it.date && it.firm)
      .map((it) => ({
        _id: `${market}:${symbol}:${it.date}:${it.analystSlug || it.firm}`,
        market,
        symbol,
        date: it.date,
        analyst: it.analyst?.trim() || "",
        analystSlug: it.analystSlug?.trim() || null,
        firm: it.firm.trim(),
        rating: it.rating?.trim() || "",
        ratingOld: it.ratingOld?.trim() || null,
        action: it.action?.trim() || "",
        priceTarget: num(it.priceTarget),
        priceTargetOld: num(it.priceTargetOld),
        currency: it.currency?.trim() || "USD",
        score: num(it.score),
        stars: num(it.stars),
        successRate: num(it.successRate),
        avgReturn: num(it.avgReturn),
        analystRank: num(it.analystRank),
        rankedExperts: num(it.rankedExperts),
        totalRatings: num(it.totalRatings),
        stockSuccessRate: num(it.stockSuccessRate),
        stockAvgReturn: num(it.stockAvgReturn),
        collectedAt: now,
      }));

    const result = await replaceAnalystForecasts(market, symbol, docs);
    return ok({ symbol, market, received: docs.length, ...result });
  } catch (err) {
    return jsonError(err);
  }
}
