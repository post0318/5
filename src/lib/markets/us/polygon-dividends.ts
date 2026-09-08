import "server-only";

/**
 * 미국 배당 이력 — Polygon.io(현 Massive) /v3/reference/dividends.
 * 선언일·권리락일·기준일·지급일 4개 날짜 + 금액 + 지급주기.
 * 무료 키(POLYGON_API_KEY). 미설정 시 [] → 호출자가 Yahoo 로 폴백.
 */

const EP = "https://api.polygon.io/v3/reference/dividends";

export interface PolygonDividend {
  exDate: string; // YYYY-MM-DD
  recordDate: string | null;
  payDate: string | null;
  declarationDate: string | null;
  amount: number;
  /** 연 지급 횟수 (4=분기, 2=반기, 1=연, 0=불규칙) */
  frequency: number | null;
}

interface RawResult {
  ex_dividend_date?: string;
  record_date?: string;
  pay_date?: string;
  declaration_date?: string;
  cash_amount?: number;
  frequency?: number;
}

export async function fetchPolygonDividends(ticker: string): Promise<PolygonDividend[]> {
  const key = process.env.POLYGON_API_KEY;
  if (!key) return [];
  const sym = ticker.replace(/[^A-Za-z.]/g, "").toUpperCase();
  const url =
    `${EP}?ticker=${encodeURIComponent(sym)}&limit=50&order=desc&sort=ex_dividend_date` +
    `&apiKey=${key}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const json = (await res.json()) as { results?: RawResult[] };
    return (json.results ?? [])
      .filter((r) => r.ex_dividend_date && r.cash_amount != null)
      .map((r) => ({
        exDate: r.ex_dividend_date!,
        recordDate: r.record_date ?? null,
        payDate: r.pay_date ?? null,
        declarationDate: r.declaration_date ?? null,
        amount: r.cash_amount!,
        frequency: r.frequency ?? null,
      }));
  } catch {
    return [];
  }
}
