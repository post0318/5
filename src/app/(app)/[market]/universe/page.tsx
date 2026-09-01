import { isMarketId } from "@/lib/markets/types";
import { UniverseOverview } from "@/components/universe-overview";

export default async function UniversePage({
  params,
}: {
  params: Promise<{ market: string }>;
}) {
  const { market } = await params;
  if (!isMarketId(market)) return null;
  return <UniverseOverview market={market} />;
}
