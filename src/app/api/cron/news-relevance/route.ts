import { jsonError, ok } from "@/lib/api";
import { newsRelevanceReport } from "@/lib/weekly/issues";
import { resolveReportWeek } from "@/lib/weekly/week";

/**
 * 뉴스 관련성 정규식 튜닝용 진단(오너 지시 2026-09-21). 주제별 통과/탈락
 * 건수와 탈락 제목 표본을 돌려준다. 필터를 켜니 감소율이 -5% ~ -100% 로
 * 제각각이었는데, 기사가 없어서가 아니라 match 정규식 정밀도가 주제마다
 * 달라서다. LLM 호출이 없어 비용이 없다.
 */
export const maxDuration = 120;

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
    const week = resolveReportWeek();
    return ok({ week, topics: await newsRelevanceReport(week) });
  } catch (err) {
    return jsonError(err);
  }
}
