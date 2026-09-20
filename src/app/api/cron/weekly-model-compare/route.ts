import { jsonError, ok } from "@/lib/api";
import { compareWeeklyModels } from "@/lib/weekly/generate";

/**
 * Gemini 모델 비교(오너 지시 2026-09-21 — "비교해줘"). 같은 주 입력으로
 * 모델 여러 개를 각각 돌려 결과를 나란히 돌려준다. **DB 에 저장하지 않는다** —
 * 진행 중인 초안을 건드리지 않는다.
 *
 * 인증은 다른 cron 라우트와 동일(CRON_SECRET / x-app-token) — 실제 과금되는
 * 호출이라 공개로 두면 안 된다. GEMINI_API_KEY 가 배포 환경에만 있어서
 * GitHub Actions 로 돌린다(fedwatch 백필과 같은 패턴).
 *
 * 예: /api/cron/weekly-model-compare?models=gemini-3.1-pro-preview,gemini-3.8-flash
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
    const raw = new URL(req.url).searchParams.get("models") ?? "";
    const models = raw
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean)
      .slice(0, 3); // 한 번에 3개까지 — 그 이상은 시간·비용이 과하다
    if (models.length < 2) {
      return Response.json(
        { error: "models 파라미터에 비교할 모델을 2개 이상 쉼표로 넘겨야 한다" },
        { status: 400 },
      );
    }
    return ok(await compareWeeklyModels(models));
  } catch (err) {
    return jsonError(err);
  }
}
