import { isMarketId } from "@/lib/markets/types";
import { UniverseOverview } from "@/components/universe-overview";
import { AuthGate } from "@/components/auth/auth-gate";

export default async function UniversePage({
  params,
}: {
  params: Promise<{ market: string }>;
}) {
  const { market } = await params;
  if (!isMarketId(market)) return null;
  return (
    <AuthGate>
      <UniverseOverview market={market} />
    </AuthGate>
  );
}
