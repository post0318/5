import { isMarketId } from "@/lib/markets/types";
import { NewsBoard } from "@/components/news-board";
import { AuthGate } from "@/components/auth/auth-gate";

export default async function NewsPage({
  params,
}: {
  params: Promise<{ market: string }>;
}) {
  const { market } = await params;
  if (!isMarketId(market)) return null;
  return (
    <AuthGate>
      <NewsBoard market={market} />
    </AuthGate>
  );
}
