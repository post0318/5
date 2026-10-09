/** 어댑터 공통 HTTP 헬퍼. 서버 전용. */

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AdapterError } from "./types";
import { checkBackoff, isSecUrl, noteFetchFailure, noteFetchSuccess } from "./fetch-health";
import { recordUsage, usageServiceOf, withNetProbe } from "../usage/ledger.mjs";

export interface FetchJsonOpts {
  headers?: Record<string, string>;
  /** 초 단위. Next fetch 캐시 revalidate */
  revalidate?: number | false;
  timeoutMs?: number;
  /** Next 데이터 캐시를 쓰지 않는다(캐시에 빈 응답이 남았을 때 다시 받기 — secText) */
  noStore?: boolean;
}

/**
 * **SEC 일시 오류 재시도**(2026-09-26 — 429 한 번에 본표 판독이 통째로 빠져 옛 태그 규칙 값이 조용히 표시되던 결함).
 * SEC URL 만, 429·408·5xx·시간 초과·네트워크 오류에 최대 2회. 대기 = Retry-After(초·HTTP 날짜) — 없으면 1초·3초.
 * Retry-After 가 10초를 넘으면(SEC 차단 — 보통 10분) 기다리지 않고 바로 실패로 돌린다(요청을 붙잡지 않고, 차단 중
 * 재요청으로 차단을 늘리지 않게). 403 은 SEC 가 User-Agent·차단 판정에 쓰므로 재시도하지 않는다(fetch-health 에는 일시
 * 오류로 기록). 실패 응답은 Next 데이터 캐시에 남지 않는다(Next 는 200 만 캐시 — patch-fetch).
 */
/**
 * 오류 문구에 넣는 URL — 쿼리의 인증 값(DART crtfc_key·공공데이터 serviceKey 등)을 가린다(2026-10-09 — 앱 화면 ⚠ 경고에 DART 키가 그대로 실렸다)
 */
export const redactUrl = (url: string): string =>
  url.replace(/([?&](?:crtfc_key|servicekey|apikey|api_key|key|token|access_token|auth|cert_key)=)[^&#]*/gi, "$1***");

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
  const { headers = {}, revalidate = 60 * 30, timeoutMs = 15_000, noStore = false } = opts;
  // 같은 URL 이 연속으로 일시 오류였으면 백오프 동안 조회하지 않는다(fetch-health.ts)
  if (checkBackoff(url) > 0) throw new FetchError(`재시도 대기(연속 실패) — ${redactUrl(url)}`, { status: 503 });
  const retries = isSecUrl(url) ? SEC_RETRIES : 0;
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let wait: number | null = null;
    let failure: FetchError;
    try {
      // 사용량 장부(src/lib/usage/ledger.mjs): 장부 fetch 는 Next 데이터 캐시 아래에 있어 캐시에서 나온 응답이면 net=false → 캐시 적중으로 따로 센다
      const svc = usageServiceOf(url);
      const { value: res, net } = await withNetProbe(() =>
        fetch(url, {
          headers: { ...defaultHeaders, ...headers },
          signal: controller.signal,
          ...(noStore ? { cache: "no-store" as const } : { next: revalidate === false ? undefined : { revalidate } }),
        }),
      );
      if (svc && !net) recordUsage(svc, "hit");
      if (res.ok) {
        const body = await read(res);
        noteFetchSuccess(url);
        return body;
      }
      failure = new FetchError(`요청 실패 ${res.status} — ${redactUrl(url)}`, { status: res.status });
      if (retryableStatus(res.status)) {
        const ra = retryAfterMs(res);
        wait = ra == null ? RETRY_BACKOFF_MS[attempt] ?? 3_000 : ra <= RETRY_AFTER_CAP_MS ? ra : null;
      }
    } catch (err) {
      // 사용량 상한(배치만 막힘) — 네트워크로 나가지 않았으므로 연속 실패 백오프(fetch-health)에 넣지 않는다(같은 URL 의 화면 요청까지 막히지 않게)
      if ((err as Error | null)?.name === "UsageLimitError") {
        throw new FetchError((err as Error).message, { status: 429, cause: err });
      }
      if (err instanceof DOMException && err.name === "AbortError") {
        failure = new FetchError(`요청 시간 초과 — ${redactUrl(url)}`, { status: 504, cause: err });
      } else {
        failure = new FetchError(`요청 오류 — ${redactUrl(url)}`, { cause: err });
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

// ── SEC 요청 줄 세우기(2026-09-26) ──
// 한 종목 화면 여러 개(하이라이트·재무제표·컨센서스…)가 같은 SEC 파일을 동시에 따로 받으러 가 SEC 초당 한도(10건)를 넘겨 429 →
// 연속 실패 백오프(fetch-health)로 그 종목 전체가 2분간 막혔다. SEC URL 은 (1) 요청 시작 간격 최소 SEC_MIN_GAP_MS(초당 5건 —
// 검증기 초당 3건과 합쳐 8건 이하) (2) 같은 URL 을 동시에 요청하면 한 번만 받아 나눠 쓴다(본문 문자열 공유, JSON 은 호출마다 파싱).
const SEC_MIN_GAP_MS = 200;
let secChain: Promise<void> = Promise.resolve();
let secLast = 0;
function secSlot(): Promise<void> {
  secChain = secChain.then(async () => {
    const w = secLast + SEC_MIN_GAP_MS - Date.now();
    if (w > 0) await sleep(w);
    secLast = Date.now();
  });
  return secChain;
}
const secInflight = new Map<string, Promise<string>>();

// ── SEC 공시 원본 디스크 캐시(2026-09-27, 오너 지적 — "sec 자료는 확정치인데 왜 계속 받지?") ──
// 접수번호 폴더 아래 파일(/Archives/edgar/data/{CIK}/{접수번호 18자리}/…)은 제출 후 바뀌지 않는다. Next 데이터 캐시는 2MB 넘는
// 응답을 저장하지 못해("Failed to set fetch cache") 10-K·10-Q 인스턴스를 요청마다 다시 받아 SEC 줄 서기에 수십 분이 걸렸다 —
// 한 번 받으면 디스크에 두고 계속 쓴다. companyfacts·submissions 처럼 갱신되는 파일은 대상 아님(기존 revalidate 그대로).
// 위치: SEC_ARCHIVE_CACHE_DIR, 없으면 로컬 .cache/sec-archives(gitignore), Vercel 운영은 /tmp(인스턴스 수명 동안). 로컬 .env.local 에도
// vercel env pull 로 VERCEL="1" 이 들어오므로 NODE_ENV=production 일 때만 /tmp(개발 서버가 C:	mp 에 쓰던 문제, 2026-09-27).
const SEC_ARCHIVE_RE = /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d{18}\//;
/**
 * SEC 캐시 루트 — `SEC_CACHE_DIR`(집·회사 PC 가 같은 캐시를 쓰려면 동기화 폴더로 지정), 없으면 로컬 `.cache`(gitignore),
 * Vercel 운영은 /tmp. 옛 `SEC_ARCHIVE_CACHE_DIR` 는 공시 원본 폴더로 계속 인정한다.
 */
function secCacheRoot(): string {
  return process.env.SEC_CACHE_DIR ?? path.join(process.env.VERCEL && process.env.NODE_ENV === "production" ? "/tmp" : process.cwd(), ".cache");
}
function archiveCachePath(key: string): string {
  const dir = process.env.SEC_ARCHIVE_CACHE_DIR ?? path.join(secCacheRoot(), "sec-archives");
  return path.join(dir, createHash("sha1").update(key).digest("hex"));
}

// ── SEC 갱신형 파일 디스크 캐시(2026-09-28, 오너 지시 — "sec 자료는 디스크에 넣어두고 사용") ──
// companyfacts·submissions(data.sec.gov)·company_tickers.json 은 새 공시가 나오면 바뀐다. 디스크에 두고 SEC_API_CACHE_TTL_H
// (기본 12시간) 안이면 디스크 것을 쓰고, 넘었으면 새로 받는다. **새로 받기가 실패하면(429 차단·시간 초과 등) 오래된 디스크 사본으로
// 대신한다** — SEC 차단(보통 10분) 동안 화면이 통째로 비던 문제. 사본 나이는 secApiCacheAge() 로 알 수 있다.
const SEC_API_RE = /^https:\/\/(data\.sec\.gov\/(api\/xbrl\/companyfacts|submissions)\/|www\.sec\.gov\/files\/company_tickers)/;
const SEC_API_TTL_MS = Number(process.env.SEC_API_CACHE_TTL_H ?? 12) * 3_600_000;
function apiCachePath(key: string): string {
  return path.join(secCacheRoot(), "sec-api", createHash("sha1").update(key).digest("hex"));
}
async function apiRead(key: string): Promise<{ body: string; ageMs: number } | null> {
  try {
    const f = apiCachePath(key);
    const [body, st] = await Promise.all([readFile(f, "utf8"), stat(f)]);
    return { body, ageMs: Date.now() - st.mtimeMs };
  } catch {
    return null;
  }
}
async function apiWrite(key: string, body: string): Promise<void> {
  try {
    const f = apiCachePath(key);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, body, "utf8");
  } catch {
    /* 캐시 실패는 조회 결과에 영향 없음 */
  }
}
/** 디스크 사본으로 대신한 URL → 사본 나이(ms). 화면·로그가 "최신이 아닐 수 있음"을 알릴 때 쓴다 */
const staleServed = new Map<string, number>();
export function secApiCacheAge(url: string): number | null {
  return staleServed.get(url) ?? null;
}
async function archiveRead(key: string): Promise<string | null> {
  try {
    return await readFile(archiveCachePath(key), "utf8");
  } catch {
    return null;
  }
}
async function archiveWrite(key: string, body: string): Promise<void> {
  try {
    const f = archiveCachePath(key);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, body, "utf8");
  } catch {
    /* 캐시 실패는 조회 결과에 영향 없음 */
  }
}

/**
 * 쓸 수 있는 본문인지 — 빈 응답·JSON 이어야 하는데 파싱 안 되는 응답은 저장·사용하지 않는다(2026-10-01: SEC 요청 제한 때 받은 빈 응답이
 * 캐시에 남아 같은 종목만 계속 "Unexpected end of JSON input" 으로 조립 실패 — 재무 배치 17종목)
 */
function usableBody(body: string | null, json: boolean): body is string {
  if (body == null || body.trim() === "") return false;
  if (!json) return true;
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

function secText(url: string, opts: FetchJsonOpts, accept: Record<string, string>): Promise<string> {
  const key = `${url}|${accept.accept ?? ""}`;
  let p = secInflight.get(key);
  if (!p) {
    const archive = SEC_ARCHIVE_RE.test(url);
    const api = !archive && SEC_API_RE.test(url);
    const json = accept.accept === "application/json";
    p = (async () => {
      if (archive) {
        const hit = await archiveRead(key);
        if (usableBody(hit, json)) {
          recordUsage("sec", "hit");
          return hit;
        }
      }
      const c0 = api ? await apiRead(key) : null;
      const cached = c0 && usableBody(c0.body, json) ? c0 : null;
      if (cached && cached.ageMs <= SEC_API_TTL_MS) {
        recordUsage("sec", "hit");
        return cached.body;
      }
      try {
        await secSlot();
        let body = await request(url, opts, accept, (res) => res.text());
        // 빈 응답·깨진 JSON — Next 데이터 캐시에 남은 것일 수 있어 캐시 없이 한 번 더, 그래도면 조회 실패(저장하지 않음)
        if (!usableBody(body, json)) {
          await secSlot();
          body = await request(url, { ...opts, noStore: true }, accept, (res) => res.text());
          if (!usableBody(body, json)) throw new FetchError(`빈 응답·JSON 아님 — ${redactUrl(url)}`, { status: 502 });
        }
        if (archive) await archiveWrite(key, body);
        if (api) {
          await apiWrite(key, body);
          staleServed.delete(url);
        }
        return body;
      } catch (err) {
        // 새로 받기 실패 — 디스크 사본이 있으면(나이 무관) 그걸 쓴다. 조회 실패만 대신하고 코드 오류는 그대로 던진다.
        if (cached && err instanceof FetchError) {
          staleServed.set(url, cached.ageMs);
          return cached.body;
        }
        throw err;
      }
    })()
      .finally(() => secInflight.delete(key));
    secInflight.set(key, p);
  }
  return p;
}

/**
 * OpenDART 오류 응답인지 — DART 는 한도 초과(020)·키 오류 등도 HTTP 200 + JSON status 로 돌려준다. 캐시에서 꺼낸 본문이 이런
 * 오류면 캐시 없이 다시 받는다(2026-10-05: 한도 초과 응답이 6~24시간 데이터 캐시에 남아 한도가 풀려도 운영 한국 재무가 계속 막힐 수 있었다).
 * 000 정상·013 자료 없음만 정상으로 본다.
 */
function dartErrorBody(url: string, body: string | null): boolean {
  if (body == null || !url.includes("opendart.fss.or.kr")) return false;
  try {
    const s = (JSON.parse(body) as { status?: unknown }).status;
    return typeof s === "string" && s !== "000" && s !== "013";
  } catch {
    return false;
  }
}

export async function fetchJson<T>(url: string, opts: FetchJsonOpts = {}): Promise<T> {
  if (isSecUrl(url)) return JSON.parse(await secText(url, opts, { accept: "application/json" })) as T;
  // 빈 응답·깨진 JSON(Next 데이터 캐시에 남은 것일 수 있음)은 캐시 없이 한 번 더, 그래도면 조회 실패 — SyntaxError 가 코드 오류처럼 새지 않게
  let body = await request(url, opts, { accept: "application/json" }, (res) => res.text());
  if (!usableBody(body, true) || dartErrorBody(url, body)) {
    body = await request(url, { ...opts, noStore: true }, { accept: "application/json" }, (res) => res.text());
    if (!usableBody(body, true)) throw new FetchError(`빈 응답·JSON 아님 — ${redactUrl(url)}`, { status: 502 });
  }
  return JSON.parse(body) as T;
}

export async function fetchText(url: string, opts: FetchJsonOpts = {}): Promise<string> {
  if (isSecUrl(url)) return secText(url, opts, {});
  return request(url, opts, {}, (res) => res.text());
}

/** 조회 실패인지(fetchJson·fetchText 가 던진 오류 — 404·시간 초과·재시도 대기 포함). 파싱 오류 등 코드 오류와 구분한다 */
export function isFetchFailure(err: unknown): err is FetchError {
  return err instanceof FetchError;
}
