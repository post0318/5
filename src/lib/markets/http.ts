/** 어댑터 공통 HTTP 헬퍼. 서버 전용. */

import { AdapterError } from "./types";

export interface FetchJsonOpts {
  headers?: Record<string, string>;
  /** 초 단위. Next fetch 캐시 revalidate */
  revalidate?: number | false;
  timeoutMs?: number;
}

export async function fetchJson<T>(url: string, opts: FetchJsonOpts = {}): Promise<T> {
  const { headers = {}, revalidate = 60 * 30, timeoutMs = 15_000 } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", ...headers },
      signal: controller.signal,
      next: revalidate === false ? undefined : { revalidate },
    });
    if (!res.ok) {
      throw new AdapterError(`요청 실패 ${res.status} — ${url}`, { status: res.status });
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof AdapterError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new AdapterError(`요청 시간 초과 — ${url}`, { status: 504, cause: err });
    }
    throw new AdapterError(`요청 오류 — ${url}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url: string, opts: FetchJsonOpts = {}): Promise<string> {
  const { headers = {}, revalidate = 60 * 30, timeoutMs = 15_000 } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
      next: revalidate === false ? undefined : { revalidate },
    });
    if (!res.ok) throw new AdapterError(`요청 실패 ${res.status} — ${url}`, { status: res.status });
    return await res.text();
  } catch (err) {
    if (err instanceof AdapterError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new AdapterError(`요청 시간 초과 — ${url}`, { status: 504, cause: err });
    }
    throw new AdapterError(`요청 오류 — ${url}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}
