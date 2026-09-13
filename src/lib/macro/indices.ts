import "server-only";
import { hasKrxKey } from "@/lib/markets/quote/krx";
import { getYahooFinance } from "./yf-client";

/**
 * 주요 지수 스냅샷.
 * 한국: KRX 정보데이터시스템 (공식). 미국·일본: yahoo-finance2 (개인용).
 */

export interface IndexQuote {
  key: string;
  name: string;
  region: "kr" | "us" | "jp" | "cm";
  value: number | null;
  change: number | null;
  changePct: number | null;
  asOf: string | null;
  source: string;
}

const KRX_BASE = "https://data-dbg.krx.co.kr/svc/apis/idx";

// UTC 기준 — batch.ts(lastBusinessDayIso 등)와 동일 컨벤션. 로컬(getDay 등)과
// UTC 를 섞으면 로컬 개발 환경(KST 등)과 배포 환경(Vercel, UTC)에서 날짜 판정이
// 갈리는 문제가 있었음 (2026-09 수정).
function businessDaysBack(count: number): string[] {
  const out: string[] = [];
  const d = new Date();
  let guard = 0;
  while (out.length < count && guard++ < 20) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) {
      out.push(
        `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`,
      );
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

export interface KrxIndexBar {
  date: string;
  close: number;
  open: number | null;
  high: number | null;
  low: number | null;
  change: number;
  pct: number;
}

const numOrNull = (v: string | undefined): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 최근 businessDaysBack(count) 영업일 중 실제 데이터가 있는 날짜의 OHLC를 모두
 * 가져옴(오래된→최신). KOSPI/KOSDAQ 지수차트가 쓰는 금융위 지수시세(data.go.kr)는
 * 발행 지연(2~3영업일)이 있는데, 이 KRX 실시간 지수 API는 훨씬 빠르게 갱신되므로
 * 차트 꼬리(최근일)를 보충하는 용도로 index-chart.ts 에서도 재사용 (2026-09).
 * OPNPRC_IDX/HGPRC_IDX/LWPRC_IDX 필드명은 KRX 지수 시세 API 표준 스키마
 * (CLSPRC_IDX 와 동일 접미사 규칙) — 실제 배포 환경(KRX_API_KEY 있는 곳)에서
 * 검증 필요.
 */
export async function fetchRecentKrxIndexBars(
  service: "kospi_dd_trd" | "kosdaq_dd_trd",
  indexName: string,
  count = 5,
): Promise<KrxIndexBar[]> {
  const authKey = process.env.KRX_API_KEY;
  if (!authKey) return [];
  // 날짜별로 순차 조회하면 최악 count*타임아웃(예전 5×10s=50s)까지 걸림 — 날짜
  // 사이에 의존관계가 없으므로 병렬로 쏘고 성공한 것만 모음. 타임아웃도 5s로
  // 줄여 응답 없는 날짜(휴장일 등)에서 대기 시간을 더 단축 (2026-09 수정).
  const results = await Promise.all(
    businessDaysBack(count).map(async (basDd) => {
      try {
        const r = await fetch(`${KRX_BASE}/${service}?basDd=${basDd}`, {
          headers: { AUTH_KEY: authKey },
          signal: AbortSignal.timeout(5_000),
        });
        if (!r.ok) return null;
        const j = (await r.json()) as { OutBlock_1?: Record<string, string>[] };
        const row = j.OutBlock_1?.find((x) => x.IDX_NM === indexName);
        const close = row ? Number(row.CLSPRC_IDX) : NaN;
        if (!row || !Number.isFinite(close) || close <= 0) return null;
        return {
          date: `${basDd.slice(0, 4)}-${basDd.slice(4, 6)}-${basDd.slice(6, 8)}`,
          close,
          open: numOrNull(row.OPNPRC_IDX),
          high: numOrNull(row.HGPRC_IDX),
          low: numOrNull(row.LWPRC_IDX),
          change: Number(row.CMPPREVDD_IDX) || 0,
          pct: Number(row.FLUC_RT) || 0,
        } satisfies KrxIndexBar;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((b): b is KrxIndexBar => b != null).sort((a, b) => a.date.localeCompare(b.date));
}

async function krxIndex(
  service: "kospi_dd_trd" | "kosdaq_dd_trd",
  indexName: string,
): Promise<{ close: number; change: number; pct: number; date: string } | null> {
  const bars = await fetchRecentKrxIndexBars(service, indexName, 5);
  return bars.at(-1) ?? null;
}

function isoTime(t: Date | string | number | undefined): string | null {
  if (t == null) return null;
  const d = t instanceof Date ? t : new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export async function getIndices(): Promise<IndexQuote[]> {
  const out: IndexQuote[] = [];

  // 한국 (KRX 공식)
  if (hasKrxKey()) {
    const [kospi, kosdaq] = await Promise.all([
      krxIndex("kospi_dd_trd", "코스피"),
      krxIndex("kosdaq_dd_trd", "코스닥"),
    ]);
    if (kospi)
      out.push({ key: "KOSPI", name: "코스피", region: "kr", value: kospi.close, change: kospi.change, changePct: kospi.pct, asOf: kospi.date, source: "KRX" });
    if (kosdaq)
      out.push({ key: "KOSDAQ", name: "코스닥", region: "kr", value: kosdaq.close, change: kosdaq.change, changePct: kosdaq.pct, asOf: kosdaq.date, source: "KRX" });
  }

  // 미국·일본 (yahoo)
  const yhSpecs: { sym: string; key: string; name: string; region: "us" | "jp" | "cm" }[] = [
    { sym: "^GSPC", key: "SPX", name: "S&P 500", region: "us" },
    { sym: "^IXIC", key: "IXIC", name: "나스닥 종합", region: "us" },
    { sym: "^DJI", key: "DJI", name: "다우존스", region: "us" },
    { sym: "^N225", key: "N225", name: "닛케이 225", region: "jp" },
    { sym: "GC=F", key: "GOLD", name: "금 (Gold)", region: "cm" },
    { sym: "CL=F", key: "WTI", name: "WTI 원유", region: "cm" },
  ];
  try {
    const quotes = await getYahooFinance().quote(yhSpecs.map((s) => s.sym));
    const bySym = new Map(quotes.map((q) => [q.symbol, q]));
    for (const s of yhSpecs) {
      const q = bySym.get(s.sym);
      out.push({
        key: s.key,
        name: s.name,
        region: s.region,
        value: q?.regularMarketPrice ?? null,
        change: q?.regularMarketChange ?? null,
        changePct: q?.regularMarketChangePercent ?? null,
        asOf: isoTime(q?.regularMarketTime),
        source: "Yahoo Finance",
      });
    }
  } catch {
    // yahoo 실패 시 미국·일본 지수 생략
  }

  return out;
}
