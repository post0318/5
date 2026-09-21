import { jsonError, ok } from "@/lib/api";
import { normalizationSim } from "@/lib/weekly/issues";
import { resolveReportWeek } from "@/lib/weekly/week";

/**
 * 정규화 방식 비교(오너 지시 2026-09-21). 현재는 전 주제 최댓값으로 나눠
 * 기사량이 원래 많은 주제가 항상 유리하다. "평소 대비 배수"로 바꾸면
 * 어떻게 달라지는지 본다. LLM 호출이 없어 비용 0이지만, 과거 주까지
 * 뉴스를 받아오므로 시간이 걸린다.
 */
export const maxDuration = 300;

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
    const n = Number(new URL(req.url).searchParams.get("weeks") ?? 3);
    const week = resolveReportWeek();
    const rows = await normalizationSim(week, Math.min(Math.max(n, 1), 6));
    return ok({ week, rows });
  } catch (err) {
    return jsonError(err);
  }
}
