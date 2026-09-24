import "server-only";
import { fetchYahooShares } from "../quote/yahoo";

/**
 * 미국 종목 **현재 발행주식수 보정** (시가총액·현재 PBR·PSR·EV 의 분모).
 *
 * 왜 필요한가 (검증 2026-09-24, docs/verification-status.md §1 시가총액) —
 * EDGAR 표지 주식수만으로는 인포맥스와 38종목 중 6종목이 어긋났다.
 * - 표지 기준일 뒤의 증자·자사주(INTC 08-12 유상증자 2.4억 주)는 다음 분기
 *   공시 전까지 EDGAR 에 없다.
 * - 복수 클래스 종목(V)은 as-converted 합계를 EDGAR 에서 연 1회만 얻는다.
 *
 * 순서(오너 결정 2026-09-24 — "EDGAR 보강, 인포맥스로 보정, 실패시 야후보정"):
 * 1. 인포맥스 종목분석(FactSet) `주식수` — SEC 최신 표지와 대조한 5건 모두 일치,
 *    같은 조건에서 Yahoo 는 0건(MRVL +2.5% 등). 기준일(`주식수일`)도 준다.
 * 2. 인포맥스 실패 시 Yahoo(시가총액 ÷ 현재가). Yahoo 는 옛 값이 남는 경우가 있어
 *    edgar-shares.ts 가 **EDGAR 표지가 오래됐을 때만** 채택한다.
 * EDGAR 자체 보강(누락 공시·클래스별 표지 합산)은 edgar-gapfill.ts.
 *
 * 인포맥스: globalmonitor.einfomax.co.kr 의 종목분석 화면이 부르는 공개 API
 * (`/facset/tickerlist/usa` → 인포맥스코드, `/facset/getPriceData` → 주식수).
 * 로그인 불필요. 주가는 하루 늦은 값이라 쓰지 않고 주식수만 쓴다.
 */

export interface CurrentShares {
  val: number;
  /** 주식수 기준일 (YYYY-MM-DD). Yahoo 는 알 수 없어 null */
  date: string | null;
  source: "infomax" | "yahoo";
}

const IM_BASE = "https://globalmonitor.einfomax.co.kr";
const TTL = 1000 * 60 * 60 * 6;
const cache = new Map<string, { at: number; data: CurrentShares | null; ttl: number }>();
const inFlight = new Map<string, Promise<CurrentShares | null>>();

async function imPost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(IM_BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", referer: `${IM_BASE}/sss.html` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(6_000),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`인포맥스 ${path} HTTP ${r.status}`);
  return (await r.json()) as T;
}

interface ImTicker {
  _source?: { 인포맥스코드?: string; 티커?: string; 국가명?: string };
}
interface ImPrice {
  주식수?: number | null;
  주식수일?: string | null;
}

async function fetchInfomaxShares(symbol: string): Promise<CurrentShares | null> {
  const t = await imPost<ImTicker>("/facset/tickerlist/usa", { ticker: symbol });
  const src = t?._source;
  // 검색이 비슷한 티커로 대체 매칭하는 경우가 있어 티커 일치를 확인
  if (!src?.인포맥스코드 || src.티커?.toUpperCase() !== symbol.toUpperCase()) return null;
  const rows = await imPost<ImPrice[]>("/facset/getPriceData", { param: src.인포맥스코드 });
  const p = rows?.[0];
  // 단위: 천 주 (INTC 5,286,110 = 52.86억 주 — 424B5 증자 후 주식수와 일치 확인)
  if (p?.주식수 == null || !(p.주식수 > 0)) return null;
  return { val: p.주식수 * 1000, date: p.주식수일 ?? null, source: "infomax" };
}

/** degraded = 인포맥스 조회가 오류로 실패해 폴백한 결과 — 짧게만 캐시(일시 오류가 6시간 굳지 않게) */
async function load(symbol: string): Promise<{ data: CurrentShares | null; degraded: boolean }> {
  let degraded = false;
  try {
    const im = await fetchInfomaxShares(symbol);
    if (im) return { data: im, degraded };
  } catch {
    degraded = true; // Yahoo 로 폴백
  }
  try {
    const y = await fetchYahooShares(symbol);
    return { data: y != null && y > 0 ? { val: y, date: null, source: "yahoo" } : null, degraded };
  } catch {
    return { data: null, degraded: true };
  }
}
const TTL_DEGRADED = 1000 * 60 * 2;

/** 현재 주식수 보정값 (없으면 null — EDGAR 표지 주식수를 그대로 쓴다). */
export async function loadUsCurrentShares(symbol: string): Promise<CurrentShares | null> {
  const key = symbol.toUpperCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.data;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const p = load(key)
    .then(({ data, degraded }) => {
      cache.set(key, { at: Date.now(), data, ttl: degraded ? TTL_DEGRADED : TTL });
      return data;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}
