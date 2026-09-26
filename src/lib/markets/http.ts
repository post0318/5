/** 어댑터 공통 HTTP 헬퍼. 서버 전용. */

import { AdapterError } from "./types";
import { checkBackoff, isSecUrl, noteFetchFailure, noteFetchSuccess } from "./fetch-health";

export interface FetchJsonOpts {
  headers?: Record<string, string>;
  /** 초 단위. Next fetch 캐시 revalidate */
  revalidate?: number | false;
  timeoutMs?: number;
}

/**
 * **SEC 일시 오류 재시도**(2026-09-26 — 429 한 번에 본표 판독이 통째로 빠져 옛 태그 규칙 값이 조용히 표시되던 결함).
 * SEC URL 만, 429·408·5xx·시간 초과·네트워크 오류에 최대 2회. 대기 = Retry-After(초·HTTP 날짜) — 없으면 1초·3초.
 * Retry-After 가 10초를 넘으면(SEC 차단 — 보통 10분) 기다리지 않고 바로 실패로 돌린다(요청을 붙잡지 않고, 차단 중
 * 재요청으로 차단을 늘리지 않게). 403 은 SEC 가 User-Agent·차단 판정에 쓰므로 재시도하지 않는다(fetch-health 에는 일시
 * 오류로 기록). 실패 응답은 Next 데이터 캐시에 남지 않는다(Next 는 200 만 캐시 — patch-fetch).
 */
/** fetchJson·fetchText 의 조회 실패(상태 코드·시간 초과·네트워크). 기존 호출부 호환을 위해 AdapterError 하위 */
export class FetchError extends AdapterError {
  constructor(message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, opts);
    this.name = "FetchError";
  }
}

const SEC_RETRIES = 2;
const RETRY_BACKOFF_MS = [1_000, 3_000];
const RETRY_AFTER_CAP_MS = 10_000;
const retryableStatus = (s: number) => s === 429 || s === 408 || s >= 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry-After 헤더(초 또는 HTTP 날짜) → ms. 없거나 해석 불가면 null */
function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (h == null || h.trim() === "") return null;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}

async function request<T>(
  url: string,
  opts: FetchJsonOpts,
  defaultHeaders: Record<string, string>,
  read: (res: Response) => Promise<T>,
): Promise<T> {
  const { headers = {}, revalidate = 60 * 30, timeoutMs = 15_000 } = opts;
  // 같은 URL 이 연속으로 일시 오류였으면 백오프 동안 조회하지 않는다(fetch-health.ts)
  if (checkBackoff(url) > 0) throw new FetchError(`재시도 대기(연속 실패) — ${url}`, { status: 503 });
  const retries = isSecUrl(url) ? SEC_RETRIES : 0;
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let wait: number | null = null;
    let failure: FetchError;
    try {
      const res = await fetch(url, {
        headers: { ...defaultHeaders, ...headers },
        signal: controller.signal,
        next: revalidate === false ? undefined : { revalidate },
      });
      if (res.ok) {
        const body = await read(res);
        noteFetchSuccess(url);
        return body;
      }
      failure = new FetchError(`요청 실패 ${res.status} — ${url}`, { status: res.status });
      if (retryableStatus(res.status)) {
        const ra = retryAfterMs(res);
        wait = ra == null ? RETRY_BACKOFF_MS[attempt] ?? 3_000 : ra <= RETRY_AFTER_CAP_MS ? ra : null;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        failure = new FetchError(`요청 시간 초과 — ${url}`, { status: 504, cause: err });
      } else {
        failure = new FetchError(`요청 오류 — ${url}`, { cause: err });
      }
      wait = RETRY_BACKOFF_MS[attempt] ?? 3_000;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries && wait != null) {
      await sleep(wait);
      continue;
    }
    noteFetchFailure(url, failure.opts.status);
    throw failure;
  }
}

export async function fetchJson<T>(url: string, opts: FetchJsonOpts = {}): Promise<T> {
  return request(url, opts, { accept: "application/json" }, (res) => res.json() as Promise<T>);
}

export async function fetchText(url: string, opts: FetchJsonOpts = {}): Promise<string> {
  return request(url, opts, {}, (res) => res.text());
}

/** 조회 실패인지(fetchJson·fetchText 가 던진 오류 — 404·시간 초과·재시도 대기 포함). 파싱 오류 등 코드 오류와 구분한다 */
export function isFetchFailure(err: unknown): err is FetchError {
  return err instanceof FetchError;
}
