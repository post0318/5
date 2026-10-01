/**
 * **원본 조회 실패 기록** — SEC 원본 조회가 일시 오류(429·403·5xx·시간 초과·네트워크)로 실패한 것을
 * **조회를 부른 로더(요청) 범위**에 기록한다. 로더들이 실패를 삼키고(catch → null) 부분 결과를 만드는 구조라
 * 결과만 보고는 "원래 없음"과 "조회 실패"를 가를 수 없었다 — TSM 2025 20-F 보완이 SEC 429 로 실패했는데
 * 그 결과(FY2025 없음)가 6시간 캐시돼 연도·LTM 이 통째로 비었다(2026-09-25).
 * 로더는 `withFetchScope` 안에서 조립하고 그 안에서 난 실패만 보고 ① 결과를 짧게만 캐시하고 ② 화면에 경고를 싣는다.
 * 예전엔 CIK 단위로 기록해 같은 CIK 의 다른 로더(클래스별 주식수·금융 자회사 등) 실패가 companyfacts 경고·짧은
 * 캐시로 번졌다(독립 감사 2026-09-25) — 이제 범위는 AsyncLocalStorage 로 그 로더의 비동기 흐름에만 걸린다.
 * 404 같은 "없음" 응답은 기록하지 않는다(정상적인 부재).
 *
 * **같은 URL 연속 실패 백오프**: 늘 실패하는 대형 원본(시간 초과·403)을 짧은 캐시 주기마다 다시 받지 않도록, 연속
 * 실패 n(≥2) 회째에는 2분 × 2^(n−2)(최대 6시간) 동안 그 URL 을 조회하지 않고 바로 실패로 돌린다(범위에는 "재시도 대기"로
 * 기록 — 결과가 불완전하다는 사실은 그대로 남는다). 성공하면 초기화.
 */
import { AsyncLocalStorage } from "node:async_hooks";

interface Scope {
  failures: string[];
  parent: Scope | null;
}
const scopes = new AsyncLocalStorage<Scope>();

/** fn 안(비동기 흐름 포함)에서 난 SEC 일시 오류만 모아 돌려준다. 중첩되면 바깥 범위에도 기록된다 */
export async function withFetchScope<T>(fn: () => Promise<T>): Promise<{ result: T; failures: string[] }> {
  const scope: Scope = { failures: [], parent: scopes.getStore() ?? null };
  const result = await scopes.run(scope, fn);
  return { result, failures: [...new Set(scope.failures)] };
}

function record(what: string): void {
  for (let s = scopes.getStore() ?? null; s; s = s.parent) s.failures.push(what);
}

/** SEC URL 인지 */
export function isSecUrl(url: string): boolean {
  return /sec\.gov\//.test(url);
}

export function isTransientStatus(status: number | undefined): boolean {
  return status == null || status === 429 || status === 403 || status === 408 || status >= 500;
}

const fileOf = (url: string) => url.split("?")[0].split("/").slice(-1)[0] || url;

// ── 같은 URL 연속 실패 백오프 ──
const BACKOFF_BASE_MS = 1000 * 60 * 2;
const BACKOFF_MAX_MS = 1000 * 60 * 60 * 6;
const urlFails = new Map<string, { n: number; until: number }>();

/** 백오프 중이면 남은 ms(>0) — 호출자는 조회하지 않고 실패로 처리한다. 이때 범위에 "재시도 대기"를 기록 */
export function checkBackoff(url: string): number {
  if (!isSecUrl(url)) return 0;
  const f = urlFails.get(url);
  const left = f ? f.until - Date.now() : 0;
  if (left > 0) record(`재시도 대기(연속 실패 ${f!.n}회) · ${fileOf(url)}`);
  return Math.max(0, left);
}

/** 일시 오류만 기록(SEC URL 만). 연속 실패 횟수에 따라 백오프 */
export function noteFetchFailure(url: string, status: number | undefined): void {
  if (!isTransientStatus(status) || !isSecUrl(url)) return;
  record(`${status ?? "네트워크 오류"} · ${fileOf(url)}`);
  const now = Date.now();
  const n = (urlFails.get(url)?.n ?? 0) + 1;
  // 첫 실패는 바로 다시 시도할 수 있게(일시 오류) — 연속 2회째부터 2분·4분·8분 …
  urlFails.set(url, { n, until: n < 2 ? now : now + Math.min(BACKOFF_BASE_MS * 2 ** (n - 2), BACKOFF_MAX_MS) });
  if (urlFails.size > 5000) for (const [k, v] of urlFails) if (v.until < now) urlFails.delete(k);
}

/** 성공하면 그 URL 의 연속 실패 기록을 지운다 */
export function noteFetchSuccess(url: string): void {
  if (urlFails.size) urlFails.delete(url);
}
