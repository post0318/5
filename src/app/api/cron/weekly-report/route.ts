import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import {
  generateWeeklyReport,
  previewWeeklyInputs,
  reprocessWeeklyReport,
  WeeklyGenerateError,
  weeklyAutoRunGate,
} from "@/lib/weekly/generate";

// Gemini Pro 호출(입력 10만 토큰 + 웹검색)이 1~3분 걸릴 수 있음.
export const maxDuration = 300;

/**
 * 주간 거시·시황 리포트 초안 생성 — 오라클 타이머 weekly-report(월~금 06:00 KST,
 * ops/oracle/install-schedules.sh)가 {"auto":true} 로 호출하고, 그 주 첫 한국 거래일에만
 * 실제로 만든다(weeklyAutoRunGate — 월요일 휴장이면 화요일). 화면의
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
      /** 타이머 자동 실행 — 그 주 첫 한국 거래일·초안 없음일 때만 생성 */
      auto?: boolean;
    };
    // preview: LLM 없이 스냅샷·코퍼스만 조립(파이프라인 점검용, 비용 0)
    if (body.preview) return ok(await previewWeeklyInputs());
    // reprocess: 저장된 초안에 후처리만 재적용(비용 0)
    if (body.reprocess) {
      const doc = await reprocessWeeklyReport(body.reprocess);
      return ok({ id: doc._id, bodyChars: doc.body.length });
    }
    if (body.auto) {
      const gate = await weeklyAutoRunGate();
      console.log(`[weekly-report] 자동 실행 ${gate.run ? "진행" : "건너뜀"} — ${gate.reason}`);
      if (!gate.run) return ok({ skipped: true, reason: gate.reason });
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
