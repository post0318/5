import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { getWeeklyReport, listWeeklyReports, weeklyReportsCol } from "@/lib/db/weekly-reports";

/**
 * 저장된 주간 리포트의 그라운딩 흔적만 읽어온다(오너 지시 2026-09-21 —
 * "몽고db가서"). 모델 비교에서 groundingSources 가 0 이었는데, 검색어까지
 * 안 뽑아둬서 "검색을 아예 안 했다"와 "검색은 했는데 출처를 못 얻었다"가
 * 구분되지 않았다. 원인이 다르면 대응도 다르다.
 *
 * LLM 을 호출하지 않는 조회라 비용이 없다. MONGODB_URI 가 배포 환경에만
 * 있어 다른 cron 라우트와 같은 인증으로 배포본에서 읽는다.
 */
export const maxDuration = 30;

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

    const id = new URL(req.url).searchParams.get("week");
    if (id) {
      const doc = await getWeeklyReport(id);
      if (!doc) return Response.json({ error: `${id} 리포트 없음` }, { status: 404 });
      return ok({
        weekStart: doc.weekStart,
        status: doc.status,
        model: doc.model,
        generatedAt: doc.generatedAt,
        usage: doc.usage,
        groundingQueries: doc.sources.groundingQueries,
        groundingSources: doc.sources.groundingSources,
      });
    }

    // week 미지정 — 최근 리포트들의 그라운딩 흔적을 한눈에.
    const summaries = await listWeeklyReports(8);
    const col = await weeklyReportsCol();
    const docs = await col
      .find(
        { _id: { $in: summaries.map((s) => s.weekStart) } },
        {
          projection: {
            weekStart: 1,
            status: 1,
            model: 1,
            generatedAt: 1,
            "sources.groundingQueries": 1,
            "sources.groundingSources": 1,
          },
        },
      )
      .sort({ _id: -1 })
      .toArray();
    return ok({
      reports: docs.map((d) => ({
        weekStart: d.weekStart,
        status: d.status,
        model: d.model,
        generatedAt: d.generatedAt,
        queryCount: d.sources?.groundingQueries?.length ?? 0,
        sourceCount: d.sources?.groundingSources?.length ?? 0,
        queries: d.sources?.groundingQueries ?? [],
        sources: (d.sources?.groundingSources ?? []).slice(0, 5),
      })),
    });
  } catch (err) {
    return jsonError(err);
  }
}
