import { jsonError, ok } from "@/lib/api";

// 기본 리전(iad1=미국 동부)에서는 BNK·kirs 가 그대로 막혀서, 서울 리전으로
// 고정했을 때도 막히는지 추가로 확인한다.
export const preferredRegion = "icn1";

/**
 * 임시 진단 라우트 — Vercel 서버(icn1 서울 리전)가 BNK투자증권에 직접 접속
 * 가능한지 1회성으로 확인한다(오너 질문 2026-09-28 — "bnk는 로컬 말고는
 * 방법이 없는가?"). 데이터를 저장하지도, 크롤링하지도 않는다 — 순수 연결
 * 가능 여부·응답 시간만 재고 확인 후 이 파일은 삭제한다("앱 배포본에는
 * 크롤링 코드가 없다" 원칙은 이 진단이 끝나면 그대로 복원됨).
 */
export async function GET() {
  const targets = ["https://www.bnkfn.co.kr/", "https://www.kirs.or.kr/"];
  const results: { url: string; ok?: boolean; status?: number; ms: number; error?: string }[] = [];
  for (const url of targets) {
    const start = Date.now();
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      });
      results.push({ url, ok: res.ok, status: res.status, ms: Date.now() - start });
    } catch (err) {
      results.push({ url, ms: Date.now() - start, error: err instanceof Error ? err.message : String(err) });
    }
  }
  try {
    return ok({ results, region: process.env.VERCEL_REGION ?? null });
  } catch (err) {
    return jsonError(err);
  }
}
