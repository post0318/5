import { isMarketId } from "@/lib/markets/types";
import { NewsBoard } from "@/components/news-board";

export default async function NewsPage({
  params,
}: {
  params: Promise<{ market: string }>;
}) {
  const { market } = await params;
  if (!isMarketId(market)) return null;
  return <NewsBoard market={market} />;
}
