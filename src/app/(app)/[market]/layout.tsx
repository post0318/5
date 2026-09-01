import { notFound } from "next/navigation";
import { isMarketId } from "@/lib/markets/types";

export default async function MarketLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ market: string }>;
}) {
  const { market } = await params;
  if (!isMarketId(market)) notFound();
  return <>{children}</>;
}
