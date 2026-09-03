import "server-only";
import YahooFinancePkg from "yahoo-finance2";
import { hasKrxKey } from "@/lib/markets/quote/krx";

/**
 * 주요 지수 스냅샷.
 * 한국: KRX 정보데이터시스템 (공식). 미국·일본: yahoo-finance2 (개인용).
 */

const YahooFinance = (YahooFinancePkg as { default?: unknown }).default ?? YahooFinancePkg;

type YF = { quote: (s: string[]) => Promise<RawQuote[]> };
interface RawQuote {
  symbol: string;
  regularMarketPrice?: number;
  regularMarketChange?: number;
  regularMarketChangePercent?: number;
  regularMarketTime?: Date | string | number;
}

let yf: YF | null = null;
function yfi(): YF {
  if (!yf) {
    const C = YahooFinance as new (o: Record<string, unknown>) => YF;
    yf = new C({ suppressNotices: ["yahooSurvey"], validation: { logErrors: false } });
  }
  return yf;
}

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

const KRX_BASE = "http://data-dbg.krx.co.kr/svc/apis/idx";

function businessDaysBack(count: number): string[] {
  const out: string[] = [];
  const d = new Date();
  let guard = 0;
  while (out.length < count && guard++ < 20) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) {
      out.push(
        `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`,
      );
    }
    d.setDate(d.getDate() - 1);
  }
  return out;
}

async function krxIndex(service: string, indexName: string): Promise<{ close: number; change: number; pct: number; date: string } | null> {
  const authKey = process.env.KRX_API_KEY;
  if (!authKey) return null;
  for (const basDd of businessDaysBack(5)) {
    try {
      const r = await fetch(`${KRX_BASE}/${service}?basDd=${basDd}`, {
        headers: { AUTH_KEY: authKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) continue;
      const j = (await r.json()) as { OutBlock_1?: Record<string, string>[] };
      const row = j.OutBlock_1?.find((x) => x.IDX_NM === indexName);
      const close = row ? Number(row.CLSPRC_IDX) : NaN;
      if (row && Number.isFinite(close) && close > 0) {
        return {
          close,
          change: Number(row.CMPPREVDD_IDX) || 0,
          pct: Number(row.FLUC_RT) || 0,
          date: `${basDd.slice(0, 4)}-${basDd.slice(4, 6)}-${basDd.slice(6, 8)}`,
        };
      }
    } catch {
      // 다음 날짜
    }
  }
  return null;
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
    const quotes = await yfi().quote(yhSpecs.map((s) => s.sym));
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
        source: "Yahoo · 개인용",
      });
    }
  } catch {
    // yahoo 실패 시 미국·일본 지수 생략
  }

  return out;
}
