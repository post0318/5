import { jsonError } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { getWeeklyMonthUsage, WEEKLY_MONTHLY_BUDGET_USD } from "@/lib/db/weekly-reports";
import { formatUsageReport, resolveUsageDay, usageWarnings, type GeminiMonth } from "@/lib/usage/report";
import { readUsageDay, usageDir } from "@/lib/usage/ledger.mjs";

export const dynamic = "force-dynamic";

/**
 * 외부 서비스 사용량 장부 조회(2026-10-06) — 1호기 healthcheck(80% 경고)·매일 08:00 텔레그램 보고(ops/oracle/usage-report.sh)가 부른다.
 * 외부 API 는 부르지 않는다(장부 파일 + Gemini 월 사용액 DB 읽기만).
 *   ?day=today|yesterday|YYYYMMDD(KST)  ?format=json|text
 * 인증: 다른 cron 라우트와 같음(CRON_SECRET 또는 x-app-token).
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const appPw = process.env.APP_PASSWORD;
  if (appPw && req.headers.get("x-app-token") === appPw) return true;
  return Boolean(secret) && req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  try {
    if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!usageDir()) return Response.json({ error: "USAGE_DIR 미설정 — 사용량 장부 꺼짐" }, { status: 503 });
    const sp = new URL(req.url).searchParams;
    const day = resolveUsageDay(sp.get("day"));
    if (!day) return Response.json({ error: "day 는 today·yesterday·YYYYMMDD" }, { status: 400 });
    const u = readUsageDay(day);
    let gemini: GeminiMonth | null = null;
    if (isDbConfigured()) {
      try {
        const g = await getWeeklyMonthUsage();
        gemini = { month: g._id, costUsd: g.totalCostUsd, calls: g.callCount, budgetUsd: WEEKLY_MONTHLY_BUDGET_USD };
      } catch {
        gemini = null; // DB 실패는 보고에서 Gemini 줄만 빠진다
      }
    }
    if (sp.get("format") === "text") {
      return new Response(formatUsageReport(u, gemini), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    const geminiWarn = gemini && gemini.budgetUsd > 0 && gemini.costUsd >= gemini.budgetUsd * 0.8;
    return Response.json({
      ...u,
      gemini,
      warnings: [
        ...usageWarnings(u).map((s) => ({ id: s.id, label: s.label, net: s.net, cap: s.cap, pct: s.pct })),
        ...(geminiWarn ? [{ id: "gemini-budget", label: `Gemini 월 예산 ${gemini!.month}`, net: gemini!.costUsd, cap: gemini!.budgetUsd, pct: Math.floor((gemini!.costUsd / gemini!.budgetUsd) * 100) }] : []),
      ],
    });
  } catch (err) {
    return jsonError(err);
  }
}
