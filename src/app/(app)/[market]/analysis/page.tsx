import { isMarketId } from "@/lib/markets/types";
import { StockAnalysis } from "@/components/stock-analysis";

export default async function AnalysisPage({
  params,
  searchParams,
}: {
  params: Promise<{ market: string }>;
  searchParams: Promise<{ symbol?: string; yahoo?: string; name?: string }>;
}) {
  const { market } = await params;
  const { symbol, yahoo, name } = await searchParams;
  if (!isMarketId(market)) return null;
  return (
    <StockAnalysis
      key={`${market}:${symbol ?? ""}`}
      market={market}
      initialSymbol={symbol ?? null}
      initialYahoo={yahoo ?? null}
      initialName={name ?? null}
    />
  );
}
