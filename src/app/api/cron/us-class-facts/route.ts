import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { saveClassAFactsToDb } from "@/lib/db/us-class-facts";
import { listUniverse } from "@/lib/universe/repo";
import { fetchUsCompanyFacts } from "@/lib/markets/us/edgar";
import { fetchClassAFacts, needsClassAFacts } from "@/lib/markets/us/edgar-classfacts";

export const maxDuration = 300;

/**
 * 듀얼클래스 종목(Visa 등) Class A EPS·가중평균주식수 갱신 배치.
 * companyfacts 에 EPS·주식수가 통째로 없는 종목만 10-K XBRL 인스턴스를 파싱해
 * `us_class_facts` 에 upsert 한다. 10-K 는 연 1회라 분기 실행이면 충분.
 *
 *  - Vercel Cron 이 호출 (분기 1회)
 *  - ?symbol=V : 특정 종목만 (수동)
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const appPw = process.env.APP_PASSWORD;
  if (appPw && req.headers.get("x-app-token") === appPw) return true;
  if (secret) return req.headers.get("authorization") === `Bearer ${secret}`;
  return (req.headers.get("user-agent") ?? "").includes("vercel-cron");
}

export async function GET(req: Request) {
  try {
    if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });

    const only = new URL(req.url).searchParams.get("symbol");
    const symbols = only
      ? [only.toUpperCase()]
      : (await listUniverse({ market: "us", activeOnly: true })).map((u) => u.symbol);

    const results: { symbol: string; status: string; years?: number }[] = [];
    for (const symbol of symbols) {
      try {
        const { cik, facts } = await fetchUsCompanyFacts(symbol);
        if (!needsClassAFacts(facts)) {
          results.push({ symbol, status: "skip (companyfacts ok)" });
          continue;
        }
        const cf = await fetchClassAFacts(cik);
        if (cf.size === 0) {
          results.push({ symbol, status: "no class-A facts parsed" });
          continue;
        }
        const n = await saveClassAFactsToDb(cik, cf);
        results.push({ symbol, status: "saved", years: n });
      } catch (err) {
        results.push({ symbol, status: `error: ${(err as Error).message}` });
      }
      await new Promise((r) => setTimeout(r, 150)); // SEC rate-limit 여유
    }

    const saved = results.filter((r) => r.status === "saved").length;
    return ok({ mode: "us-class-facts", scanned: symbols.length, saved, results });
  } catch (err) {
    return jsonError(err);
  }
}
