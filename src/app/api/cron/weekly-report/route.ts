import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import {
  generateWeeklyReport,
  previewWeeklyInputs,
  reprocessWeeklyReport,
  WeeklyGenerateError,
} from "@/lib/weekly/generate";

// Gemini Pro 호출(입력 10만 토큰 + 웹검색)이 1~3분 걸릴 수 있음.
export const maxDuration = 300;

/**
 * 주간 거시·시황 리포트 초안 생성 — GitHub Actions(월요일 09:00 KST,
 * .github/workflows/weekly-report.yml)가 CRON_SECRET 으로 호출. 화면의
 * "초안 생성" 버튼은 로그인 세션으로 POST /api/weekly 를 대신 쓴다.
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
    const body = (await req.json().catch(() => ({}))) as {
      force?: boolean;
      preview?: boolean;
      reprocess?: string;
    };
    // preview: LLM 없이 스냅샷·코퍼스만 조립(파이프라인 점검용, 비용 0)
    if (body.preview) return ok(await previewWeeklyInputs());
    // reprocess: 저장된 초안에 후처리만 재적용(비용 0)
    if (body.reprocess) {
      const doc = await reprocessWeeklyReport(body.reprocess);
      return ok({ id: doc._id, bodyChars: doc.body.length });
    }
    const doc = await generateWeeklyReport({ force: Boolean(body.force) });
    return ok({
      id: doc._id,
      status: doc.status,
      model: doc.model,
      usage: doc.usage,
      sources: doc.sources,
      bodyChars: doc.body.length,
    });
  } catch (err) {
    if (err instanceof WeeklyGenerateError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return jsonError(err);
  }
}
