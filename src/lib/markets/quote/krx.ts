import "server-only";
import { AdapterError, type QuoteBar } from "../types";

/**
 * KRX 정보데이터시스템 OPEN API — 한국 일별 시세 (L2 주 소스)
 * http://openapi.krx.co.kr, 헤더 AUTH_KEY.
 *
 * 날짜별 전체 종목 응답 → 종목별 시계열은 날짜를 순회해 수집.
 * 과거 날짜 데이터는 불변이므로 영구 캐시.
 */

const BASE = "http://data-dbg.krx.co.kr/svc/apis/sto";

function key(): string | null {
  return process.env.KRX_API_KEY ?? null;
}

export function hasKrxKey(): boolean {
  return Boolean(key());
}

interface KrxRow {
  BAS_DD: string;
  ISU_CD: string; // 단축코드(6)
  ISU_NM: string;
  MKT_NM: string;
  TDD_CLSPRC: string;
  TDD_OPNPRC: string;
  TDD_HGPRC: string;
  TDD_LWPRC: string;
  ACC_TRDVOL: string;
  MKTCAP: string;
  LIST_SHRS: string;
}

// basDd -> (shortCode -> row)
const dayCache = new Map<string, Map<string, KrxRow>>();

function num(v: string | undefined): number | null {
  if (!v || v.trim() === "" || v === "-") return null;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function fetchService(
  service: string,
  basDd: string,
  isPast: boolean,
): Promise<KrxRow[]> {
  const res = await fetch(`${BASE}/${service}?basDd=${basDd}`, {
    headers: { AUTH_KEY: key()! },
    signal: AbortSignal.timeout(15_000),
    // 과거 영업일 데이터는 불변 → 오래 캐시(Next Data Cache, 인스턴스·배포 간 공유).
    // 당일치만 1시간. 이게 없으면 종목 조회마다 전체 시장 일별 스냅샷 수십 개를
    // 매번 새로 내려받아 개요가 10초 넘게 걸림.
    next: { revalidate: isPast ? 60 * 60 * 24 * 30 : 60 * 60 },
  });
  if (!res.ok) throw new AdapterError(`KRX ${service} 실패 (${res.status})`, { status: res.status });
  const j = (await res.json()) as { OutBlock_1?: KrxRow[] };
  return j.OutBlock_1 ?? [];
}

/** 특정 영업일의 전체 종목(KOSPI+KOSDAQ) 맵. 과거일은 영구 캐시. */
async function getDay(basDd: string): Promise<Map<string, KrxRow>> {
  const cached = dayCache.get(basDd);
  if (cached) return cached;

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const isPast = basDd !== today;

  const [kospi, kosdaq] = await Promise.all([
    fetchService("stk_bydd_trd", basDd, isPast).catch(() => [] as KrxRow[]),
    fetchService("ksq_bydd_trd", basDd, isPast).catch(() => [] as KrxRow[]),
  ]);
  const map = new Map<string, KrxRow>();
  for (const r of [...kospi, ...kosdaq]) {
    if (r.ISU_CD) map.set(r.ISU_CD.trim(), r);
  }
  // 휴장일이면 빈 맵 — 캐시하되 오늘 날짜는 캐시하지 않음
  if (isPast) dayCache.set(basDd, map);
  return map;
}

function businessDaysBack(count: number): string[] {
  const out: string[] = [];
  const d = new Date();
  let guard = 0;
  while (out.length < count && guard++ < count * 3 + 10) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) {
      out.push(
        `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
          d.getDate(),
        ).padStart(2, "0")}`,
      );
    }
    d.setDate(d.getDate() - 1);
  }
  return out;
}

export interface KrxQuoteResult {
  bars: QuoteBar[];
  listedShares: number | null;
  marketCap: number | null;
  name: string | null;
  market: string | null;
}

/**
 * 종목의 최근 `days` 영업일 시세 + 상장주식수/시총.
 * 날짜별로 전체 시장 스냅샷을 받아오므로 days 를 키우면 그만큼 무거워진다.
 * 개요/멀티플은 최근 종가·전일 대비만 필요해 기본값을 작게 둔다(공휴일 여유 포함).
 */
export async function fetchKrxEod(code: string, days = 10): Promise<KrxQuoteResult> {
  if (!key()) throw new AdapterError("KRX API 키가 없습니다", { status: 501 });
  const short = code.replace(/[^0-9]/g, "").padStart(6, "0").slice(-6);
  const dates = businessDaysBack(days);

  const bars: QuoteBar[] = [];
  let latest: KrxRow | null = null;

  // 오래된 날짜부터 처리하도록 역순, 제한 병렬
  const ordered = [...dates].reverse();
  let cursor = 0;
  const rowsByDate = new Map<string, KrxRow | undefined>();
  const workers = Array.from({ length: 5 }, async () => {
    while (cursor < ordered.length) {
      const basDd = ordered[cursor++];
      try {
        const day = await getDay(basDd);
        rowsByDate.set(basDd, day.get(short));
      } catch {
        rowsByDate.set(basDd, undefined);
      }
    }
  });
  await Promise.all(workers);

  for (const basDd of ordered) {
    const r = rowsByDate.get(basDd);
    if (!r) continue;
    bars.push({
      date: `${basDd.slice(0, 4)}-${basDd.slice(4, 6)}-${basDd.slice(6, 8)}`,
      open: num(r.TDD_OPNPRC),
      high: num(r.TDD_HGPRC),
      low: num(r.TDD_LWPRC),
      close: num(r.TDD_CLSPRC),
      volume: num(r.ACC_TRDVOL),
    });
    latest = r;
  }

  if (bars.length === 0) {
    throw new AdapterError(`KRX에 시세가 없습니다: ${short}`, { status: 404 });
  }

  return {
    bars,
    listedShares: latest ? num(latest.LIST_SHRS) : null,
    marketCap: latest ? num(latest.MKTCAP) : null,
    name: latest?.ISU_NM ?? null,
    market: latest?.MKT_NM ?? null,
  };
}
