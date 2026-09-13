import { isMarketId } from "@/lib/markets/types";
import { IndustryResearchBoard } from "@/components/industry-research-board";

export default async function IndustryResearchPage({
  params,
}: {
  params: Promise<{ market: string }>;
}) {
  const { market } = await params;
  if (!isMarketId(market)) return null;
  return <IndustryResearchBoard market={market} />;
}
