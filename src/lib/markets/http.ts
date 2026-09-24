/** 어댑터 공통 HTTP 헬퍼. 서버 전용. */

import { AdapterError } from "./types";
import { checkBackoff, noteFetchFailure, noteFetchSuccess } from "./fetch-health";

export interface FetchJsonOpts {
  headers?: Record<string, string>;
  /** 초 단위. Next fetch 캐시 revalidate */
  revalidate?: number | false;
  timeoutMs?: number;
}

export async function fetchJson<T>(url: string, opts: FetchJsonOpts = {}): Promise<T> {
  const { headers = {}, revalidate = 60 * 30, timeoutMs = 15_000 } = opts;
  // 같은 URL 이 연속으로 일시 오류였으면 백오프 동안 조회하지 않는다(fetch-health.ts)
  if (checkBackoff(url) > 0) throw new AdapterError(`재시도 대기(연속 실패) — ${url}`, { status: 503 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", ...headers },
      signal: controller.signal,
      next: revalidate === false ? undefined : { revalidate },
    });
    if (!res.ok) {
      noteFetchFailure(url, res.status);
      throw new AdapterError(`요청 실패 ${res.status} — ${url}`, { status: res.status });
    }
    const json = (await res.json()) as T;
    noteFetchSuccess(url);
    return json;
  } catch (err) {
    if (err instanceof AdapterError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      noteFetchFailure(url, 504);
      throw new AdapterError(`요청 시간 초과 — ${url}`, { status: 504, cause: err });
    }
    noteFetchFailure(url, undefined);
    throw new AdapterError(`요청 오류 — ${url}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url: string, opts: FetchJsonOpts = {}): Promise<string> {
  const { headers = {}, revalidate = 60 * 30, timeoutMs = 15_000 } = opts;
  // 같은 URL 이 연속으로 일시 오류였으면 백오프 동안 조회하지 않는다(fetch-health.ts)
  if (checkBackoff(url) > 0) throw new AdapterError(`재시도 대기(연속 실패) — ${url}`, { status: 503 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
      next: revalidate === false ? undefined : { revalidate },
    });
    if (!res.ok) {
      noteFetchFailure(url, res.status);
      throw new AdapterError(`요청 실패 ${res.status} — ${url}`, { status: res.status });
    }
    const text = await res.text();
    noteFetchSuccess(url);
    return text;
  } catch (err) {
    if (err instanceof AdapterError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      noteFetchFailure(url, 504);
      throw new AdapterError(`요청 시간 초과 — ${url}`, { status: 504, cause: err });
    }
    noteFetchFailure(url, undefined);
    throw new AdapterError(`요청 오류 — ${url}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}
