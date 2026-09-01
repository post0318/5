import { isMarketId } from "@/lib/markets/types";
import { StockAnalysis } from "@/components/stock-analysis";

export default async function AnalysisPage({
  params,
}: {
  params: Promise<{ market: string }>;
}) {
  const { market } = await params;
  if (!isMarketId(market)) return null;
  return <StockAnalysis market={market} />;
}
