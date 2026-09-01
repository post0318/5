/**
 * Stooq EOD 시세 (L2 주 소스) — prd.md §4.1
 * 무료 CSV. API 키 불필요.
 * https://stooq.com/q/d/l/?s=aapl.us&i=d
 *
 * 커버리지(특히 한국)가 부족하면 야후 폴백 또는 공공데이터포털 (prd.md §12).
 */

import { fetchText } from "../http";
import { AdapterError, type MarketId, type QuoteBar } from "../types";
import { stooqSymbol } from "./symbols";

export async function fetchStooqEod(
  market: MarketId,
  symbol: string,
  opts: { from?: string; to?: string } = {},
): Promise<QuoteBar[]> {
  const s = stooqSymbol(market, symbol);
  const params = new URLSearchParams({ s, i: "d" });
  if (opts.from) params.set("d1", opts.from.replace(/-/g, ""));
  if (opts.to) params.set("d2", opts.to.replace(/-/g, ""));

  const csv = await fetchText(`https://stooq.com/q/d/l/?${params.toString()}`, {
    revalidate: 60 * 60 * 6,
    headers: { accept: "text/csv" },
  });

  const trimmed = csv.trim();
  if (!trimmed || /no data|exceeded the daily hits limit/i.test(trimmed)) {
    throw new AdapterError(`Stooq에 시세 데이터가 없습니다: ${s}`, { status: 404 });
  }

  const lines = trimmed.split(/\r?\n/);
  const header = lines[0].toLowerCase().split(",");
  const iDate = header.indexOf("date");
  const iOpen = header.indexOf("open");
  const iHigh = header.indexOf("high");
  const iLow = header.indexOf("low");
  const iClose = header.indexOf("close");
  const iVol = header.indexOf("volume");
  if (iDate < 0 || iClose < 0) {
    throw new AdapterError(`Stooq 응답 형식을 해석할 수 없습니다: ${s}`, { status: 502 });
  }

  const num = (v: string | undefined): number | null => {
    if (v === undefined || v === "" || v === "N/D") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const bars: QuoteBar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < header.length) continue;
    bars.push({
      date: cols[iDate],
      open: num(cols[iOpen]),
      high: num(cols[iHigh]),
      low: num(cols[iLow]),
      close: num(cols[iClose]),
      volume: iVol >= 0 ? num(cols[iVol]) : null,
    });
  }
  return bars;
}
