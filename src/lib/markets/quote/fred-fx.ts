import "server-only";
import { fetchText } from "../http";
import { AdapterError } from "../types";

/**
 * **외화 공시(20-F·40-F·외화 10-K) USD 환산의 유일한 환율 원천 — 연준 H.10 일별 환율(FRED)**(오너 결정 2026-09-27).
 * docs/metrics/architecture.md §1.3.
 *
 * 왜 Yahoo 가 아닌가 — Yahoo FX 는 호가 피드(봉 시작 시각 값)이지 공식 기준 환율이 아니다. 봉 범위 검사에서 Yahoo 일별 봉이 공식 고시를
 * 담지 못하는 날이 많았다(TWD 연 21~93일). 공적 고시를 쓰면 앱과 검증기가 **각자** 같은 원천을 받아 SEC 원자료처럼 정확 일치를 요구할 수 있다.
 *
 * 원천: `https://fred.stlouisfed.org/graph/fredgraph.csv?id={계열}` (키 없음, CSV "observation_date,계열", 미고시일은 ".")
 *   - H.10 = 뉴욕 정오 매입률(뉴욕 연은 인증). 미국 연방 휴일은 값 없음. **주 1회(월요일) 전주분 발표** — 최신 고시일이 며칠 늦다.
 *
 * 정의(앱·검증기 공통 — scripts/verify-financials.mjs 가 따로 구현):
 *   - 환율 = "통화 1단위당 USD". 계열이 "USD 1단위당 통화"(DEXTAUS 등)면 **1 / Number(CSV 문자열)** 을 배정밀도 부동소수로 한 번 계산해
 *     그 값을 그대로 쓴다(반올림하지 않음 — 검증기도 같은 식).
 *   - 기간 평균(흐름) = [start, end] 안의 고시값(위 환율) 산술평균 — 날짜 오름차순으로 더한 뒤 개수로 나눈다. 휴일은 값이 없으므로 빠진다.
 *   - 기말(잔액) = end 당일 또는 그 이전의 마지막 고시값.
 *   - **미고시 구간**: end 가 최신 고시일보다 뒤면 그 창은 불완전 — 값 없음(null) + 사유 `H.10 공식 환율 미고시(최신 {날짜})`.
 *     Yahoo 등 다른 원천으로 대체하지 않는다. start 가 계열 첫 날보다 앞이어도 null.
 *   - 예외 — 예상치 환산의 "현재 환율"(edgar-foreign.ts estimatesToUsd)은 최신 고시값을 쓰고 그 날짜를 주석에 적는다(예상 환산은 정의상 환율이
 *     필요해 빈칸으로 두지 않는다).
 * 조회 실패는 예외(FetchError·AdapterError) — 부르는 쪽이 빈칸·Gap.FX 로 드러낸다(조용한 대체 금지).
 */

/** 통화 → H.10 계열. inv = 계열이 "USD 1단위당 통화"라 역수를 쓴다 */
export const H10_SERIES: Record<string, { id: string; inv: boolean }> = {
  EUR: { id: "DEXUSEU", inv: false }, // USD / EUR
  GBP: { id: "DEXUSUK", inv: false }, // USD / GBP
  TWD: { id: "DEXTAUS", inv: true }, // TWD / USD
  JPY: { id: "DEXJPUS", inv: true },
  CNY: { id: "DEXCHUS", inv: true },
  CHF: { id: "DEXSZUS", inv: true },
  CAD: { id: "DEXCAUS", inv: true },
  DKK: { id: "DEXDNUS", inv: true }, // NVO(덴마크 크로네 공시)
  // KRW 는 쓰지 않는다 — DART 연결 ADR(SKHY)은 ECOS(us/dart-adr.ts, 별도 결정). 문서용으로만 남긴다
  KRW: { id: "DEXKOUS", inv: true },
};

/** 계열 시작(검증기와 같은 값 — 창이 이보다 앞이면 null) */
export const H10_FROM = "2010-01-01";
const TTL = 1000 * 60 * 60 * 12;

export interface H10Series {
  cur: string;
  series: string;
  /** 날짜 오름차순, rate = 통화 1단위당 USD */
  rows: { date: string; rate: number }[];
  /** 최신 고시일 */
  latest: string;
  /** 조회 시각(ISO) */
  fetchedAt: string;
}

/** CSV → 오름차순 [{date, rate}] ("." = 미고시 → 뺀다) */
export function parseH10Csv(text: string, inv: boolean): { date: string; rate: number }[] {
  const lines = text.trim().split(/\r?\n/);
  if (!/^observation_date,/i.test(lines[0] ?? "")) throw new AdapterError("FRED H.10 CSV 머리글 이상", { status: 502 });
  const out: { date: string; rate: number }[] = [];
  for (const l of lines.slice(1)) {
    const [d, s] = l.split(",");
    if (!d || !s || s === ".") continue;
    const v = Number(s);
    if (!Number.isFinite(v) || v <= 0) continue;
    out.push({ date: d, rate: inv ? 1 / v : v });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

const mem = new Map<string, { at: number; s: H10Series }>();
const inFlight = new Map<string, Promise<H10Series>>();

async function load(cur: string): Promise<H10Series> {
  const spec = H10_SERIES[cur];
  if (!spec) throw new AdapterError(`H.10 공식 환율 계열 없음(${cur}) — 지원: ${Object.keys(H10_SERIES).join("·")}`, { status: 502 });
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${spec.id}&cosd=${H10_FROM}`;
  let text: string | null = null;
  let err: unknown = null;
  for (let attempt = 0; attempt < 2 && text == null; attempt++) {
    try {
      text = await fetchText(url, { revalidate: 60 * 60 * 12, timeoutMs: 30_000, headers: { accept: "text/csv", "user-agent": "global-market-research (personal use)" } });
    } catch (e) {
      err = e;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  if (text == null) throw new AdapterError(`H.10 공식 환율 조회 실패(${cur} ${spec.id})`, { status: 502, cause: err });
  const rows = parseH10Csv(text, spec.inv);
  if (rows.length < 100) throw new AdapterError(`H.10 공식 환율 응답 없음(${cur} ${spec.id} ${rows.length}건)`, { status: 502 });
  return { cur, series: spec.id, rows, latest: rows[rows.length - 1].date, fetchedAt: new Date().toISOString() };
}

/** 통화의 H.10 일별 계열(12시간 메모리 캐시 + Next 데이터 캐시 12시간). 실패는 예외 */
export async function fetchH10(cur: string): Promise<H10Series> {
  const hit = mem.get(cur);
  if (hit && Date.now() - hit.at < TTL) return hit.s;
  const pending = inFlight.get(cur);
  if (pending) return pending;
  const p = load(cur)
    .then((s) => {
      mem.set(cur, { at: Date.now(), s });
      return s;
    })
    .finally(() => inFlight.delete(cur));
  inFlight.set(cur, p);
  return p;
}

/** 조회 시각(ISO) — 조회 전이면 null */
export function h10FetchedAt(cur: string): string | null {
  return mem.get(cur)?.s.fetchedAt ?? null;
}

/** 창이 불완전하면 사유(최신 고시일보다 뒤), 아니면 null */
export function h10Pending(s: H10Series, end: string): string | null {
  return end > s.latest ? `H.10 공식 환율 미고시(최신 ${s.latest})` : null;
}

/** 기간 평균 — [start, end] 고시값 산술평균(오름차순 합 ÷ 개수). 미고시 창·계열 이전·고시 0개면 null */
export function h10Avg(s: H10Series, start: string, end: string): number | null {
  if (end > s.latest || start < s.rows[0].date) return null;
  let sum = 0, n = 0;
  for (const q of s.rows) {
    if (q.date < start) continue;
    if (q.date > end) break;
    sum += q.rate;
    n++;
  }
  return n > 0 ? sum / n : null;
}

/** 기말 — date 당일 또는 그 이전 마지막 고시값. 미고시(date > 최신)·계열 이전이면 null */
export function h10At(s: H10Series, date: string): number | null {
  if (date > s.latest) return null;
  let lo = 0, hi = s.rows.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s.rows[mid].date <= date) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best < 0 ? null : s.rows[best].rate;
}

/** 환산 도우미 — 통화 → USD. USD 면 1. why(start|날짜, end) = 값이 없을 때 사유(미고시) */
export interface H10Fx {
  cur: string;
  /** 최신 고시일(USD 면 null) */
  latest: string | null;
  asOf: string;
  avg(start: string, end: string): number | null;
  at(date: string): number | null;
  why(end: string): string | null;
}

export async function h10Fx(cur: string): Promise<H10Fx> {
  if (cur === "USD") return { cur, latest: null, asOf: new Date().toISOString(), avg: () => 1, at: () => 1, why: () => null };
  const s = await fetchH10(cur);
  return { cur, latest: s.latest, asOf: s.fetchedAt, avg: (a, b) => h10Avg(s, a, b), at: (d) => h10At(s, d), why: (e) => h10Pending(s, e) };
}
