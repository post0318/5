import { notFound, redirect } from "next/navigation";
import { isMarketId } from "@/lib/markets/types";
import { InsightsBoard } from "@/components/insights-board";

// 인사이트(해외 IB) 탭은 미국 등 해외 시장 전용. 국내는 비상장 리서치(/kr/unlisted)로 분리했다
// (오너 지시 2026-09-26) — 옛 주소는 새 주소로 넘긴다.
export default async function InsightsPage({
  params,
}: {
  params: Promise<{ market: string }>;
}) {
  const { market } = await params;
  if (!isMarketId(market)) notFound();
  if (market === "kr") redirect("/kr/unlisted");
  return <InsightsBoard market={market} kind="insight" />;
}
