/**
 * **원본 조회 실패 기록** — SEC 등 원본 조회가 일시 오류(429·403·5xx·시간 초과·네트워크)로 실패한 것을
 * 조회 키(SEC 는 CIK)별로 잠시 기록한다. 로더들이 실패를 삼키고(catch → null) 부분 결과를 만드는 구조라
 * 결과만 보고는 "원래 없음"과 "조회 실패"를 가를 수 없었다 — TSM 2025 20-F 보완이 SEC 429 로 실패했는데
 * 그 결과(FY2025 없음)가 6시간 캐시돼 연도·LTM 이 통째로 비었다(2026-09-25).
 * 로더는 시작 시각 이후의 실패를 보고 ① 결과를 짧게만 캐시하고 ② 화면에 경고를 싣는다.
 * 404 같은 "없음" 응답은 기록하지 않는다(정상적인 부재).
 */

interface Failure {
  key: string;
  at: number;
  what: string;
}

const log: Failure[] = [];
const KEEP_MS = 1000 * 60 * 30;

/** SEC URL → "sec:{CIK 숫자}" (없으면 null) */
export function secKeyOf(url: string): string | null {
  if (!/sec\.gov\//.test(url)) return null;
  const m = /\/edgar\/data\/(\d+)\//.exec(url) ?? /CIK0*(\d+)/.exec(url);
  return m ? `sec:${Number(m[1])}` : null;
}

export function isTransientStatus(status: number | undefined): boolean {
  return status == null || status === 429 || status === 403 || status === 408 || status >= 500;
}

/** 일시 오류만 기록. 키를 모르는 URL 은 무시 */
export function noteFetchFailure(url: string, status: number | undefined): void {
  if (!isTransientStatus(status)) return;
  const key = secKeyOf(url);
  if (!key) return;
  const now = Date.now();
  const file = url.split("?")[0].split("/").slice(-1)[0] || url;
  log.push({ key, at: now, what: `${status ?? "네트워크 오류"} · ${file}` });
  while (log.length && now - log[0].at > KEEP_MS) log.shift();
  if (log.length > 2000) log.splice(0, log.length - 2000);
}

/** CIK 의 since 이후 일시 오류 목록(중복 제거) */
export function secFailuresSince(cik: string | number, since: number): string[] {
  const key = `sec:${Number(String(cik).replace(/\D/g, ""))}`;
  return [...new Set(log.filter((f) => f.key === key && f.at >= since).map((f) => f.what))];
}
