import { isMarketId } from "@/lib/markets/types";
import { InsightsBoard } from "@/components/insights-board";

export default async function InsightsPage({
  params,
}: {
  params: Promise<{ market: string }>;
}) {
  const { market } = await params;
  if (!isMarketId(market)) return null;
  return <InsightsBoard market={market} />;
}
