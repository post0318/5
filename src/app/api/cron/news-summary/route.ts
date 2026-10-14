import { jsonError, ok } from "@/lib/api";
import { fetchMacroNewsRaw } from "@/lib/markets/news";
import { summarizePending } from "@/lib/news/summary";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * 해외 시황 뉴스 한글 제목·요약 만들기(2026-10-14) — 1호기 타이머(30분, `news-macro-summary`)가 call-cron.sh 로 부른다.
 * 목록(최대 30건, 최신순) 중 저장본이 없는 기사만 무료 Gemini 키로 요약해 `news_summary` 에 넣는다.
 * NEWS_GEMINI_API_KEY 가 없으면 아무것도 부르지 않고 대기 건수만 돌려준다.
 *
 * 쿼리: `?limit=8` 이번 회차 최대 건수(기본 8 — 기사당 Gemini ~10초 + 간격 7초 + 원문 수집, 함수 한도 300초 안)
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const appPw = process.env.APP_PASSWORD;
  if (appPw && req.headers.get("x-app-token") === appPw) return true;
  if (secret) return req.headers.get("authorization") === `Bearer ${secret}`;
  return false;
}

const TIME_BUDGET_MS = 270_000;

export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const started = Date.now();
    const limit = Math.min(30, Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || 8));
    const raw = await fetchMacroNewsRaw("us");
    const result = await summarizePending(
      raw.map((r) => ({ url: r.url, title: r.title })),
      { maxItems: limit, deadline: started + TIME_BUDGET_MS },
    );
    console.log(
      `[news-summary] 후보 ${result.candidates} · 대기 ${result.pending} · 저장 ${result.saved}(본문 못 읽음 ${result.unreadable}) · 실패 ${result.failed.length}` +
        (result.stoppedByQuota ? " · 무료 한도로 중단" : "") +
        (result.configured ? "" : " · NEWS_GEMINI_API_KEY 미설정"),
    );
    return ok({ ...result, ms: Date.now() - started });
  } catch (err) {
    return jsonError(err);
  }
}
