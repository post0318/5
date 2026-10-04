// 자동 작업(수집 스크립트·워크플로)이 부르는 메인 서버 주소 — 한 곳에서만 정한다.
// 2026-10-03 오너 결정: 오라클(메인)로 이전. 예전엔 각 스크립트에 Vercel 주소가 직접 적혀 있었다.
// 덮어쓰기: 환경변수 APP_URL(GitHub 저장소 변수 vars.APP_URL, 로컬은 .env.local). 개별 *_IMPORT_URL 이 있으면 그쪽이 우선.
export const DEFAULT_APP_URL = "https://macro-insights.duckdns.org";

export function appUrl(env = process.env) {
  return String(env.APP_URL || DEFAULT_APP_URL).trim().replace(/\/+$/, "");
}
