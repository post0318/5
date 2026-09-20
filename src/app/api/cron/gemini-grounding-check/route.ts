import { jsonError, ok } from "@/lib/api";
import { geminiGroundingDiagnostic } from "@/lib/weekly/gemini";

/**
 * 그라운딩 진단(오너 지시 2026-09-21). 모델 비교 실행에서 두 모델 다
 * `groundingSources: 0` 이 나왔다 — 웹검색을 켰는데 출처를 못 가져왔다.
 * 그러면 코멘트의 구체적 주장이 실제 검색이 아니라 모델 내부 지식에서
 * 나온 게 되므로 사실 여부가 확인되지 않는다.
 *
 * 원인 후보가 셋이라 실제 응답을 봐야 한다:
 *  (1) tools 선언 형식이 3.x 에서 바뀌어 검색이 아예 안 걸림
 *  (2) 응답 필드 이름이 바뀌어 우리가 못 읽음(검색은 됐는데 0 으로 보임)
 *  (3) 모델이 스스로 "검색 필요 없음"으로 판단(문서상 강제 옵션 없음)
 *
 * 인증은 다른 cron 라우트와 동일 — 과금되는 호출이다.
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
    const model = new URL(req.url).searchParams.get("model") ?? undefined;
    return ok(await geminiGroundingDiagnostic(model));
  } catch (err) {
    return jsonError(err);
  }
}
