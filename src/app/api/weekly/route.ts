import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { listWeeklyReports } from "@/lib/db/weekly-reports";
import { generateWeeklyReport, WeeklyGenerateError } from "@/lib/weekly/generate";

export const maxDuration = 300;
// 목록은 매번 DB 최신값(빌드 시 정적 캐시 금지)
export const dynamic = "force-dynamic";

/** 주간 리포트 목록(메타만). 조회는 공개(다른 GET 과 동일 정책). */
export async function GET() {
  try {
    if (!isDbConfigured()) return ok({ items: [] });
    const items = await listWeeklyReports();
    return ok({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return jsonError(err);
  }
}

/** 화면의 "초안 생성/재생성" — proxy.ts 매처로 로그인 필요(LLM 비용 발생). */
export async function POST(req: Request) {
  try {
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });
    const body = (await req.json().catch(() => ({}))) as { force?: boolean };
    const doc = await generateWeeklyReport({ force: Boolean(body.force) });
    return ok(doc);
  } catch (err) {
    if (err instanceof WeeklyGenerateError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return jsonError(err);
  }
}
