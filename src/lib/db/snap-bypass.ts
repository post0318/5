import "server-only";

/**
 * 저장본(api_snap·ttm_snap) 우회 — 재무 검증 요청 전용(재감사 12차 ⑤, 2026-10-04).
 * 검증 도구(scripts/verify-financials.mjs)의 기준값이 24시간 묵은 저장본이나 다른 PC·브랜치가 쓴 "local" 저장본이 되지 않게, 요청이
 * `x-verify-no-snapshot: 1` 을 붙이고 cron 인증(APP_PASSWORD·CRON_SECRET)이 맞을 때만 읽기·쓰기 모두 건너뛴다. 인증이 없으면 무시 —
 * 운영 동작은 그대로. 개발 서버 전체를 우회하려면 환경변수 VERIFY_NO_SNAPSHOT=1.
 * 요청 밖(배치 스크립트·after 콜백 등 headers() 를 못 쓰는 곳)에서는 환경변수만 본다.
 */
export async function snapshotBypassed(): Promise<boolean> {
  if (process.env.VERIFY_NO_SNAPSHOT === "1") return true;
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    if (h.get("x-verify-no-snapshot") !== "1") return false;
    const pw = process.env.APP_PASSWORD, secret = process.env.CRON_SECRET;
    return (!!pw && h.get("x-app-token") === pw) || (!!secret && h.get("authorization") === `Bearer ${secret}`);
  } catch {
    return false;
  }
}
