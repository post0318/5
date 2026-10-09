/**
 * 서버 기동 훅(Next instrumentation) — 외부 서비스 사용량 장부(src/lib/usage/ledger.mjs)를 Next 가 fetch 에 데이터 캐시를 씌우기 전에
 * 설치한다(그래야 장부가 캐시 아래에서 실제 네트워크 요청만 센다). USAGE_DIR 이 없으면 아무것도 하지 않는다.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { installUsageFetch } = await import("./lib/usage/ledger.mjs");
  if (installUsageFetch()) console.info(`[usage] 사용량 장부 켜짐 — ${process.env.USAGE_DIR}`);
}
