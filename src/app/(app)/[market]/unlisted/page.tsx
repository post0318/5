import { notFound } from "next/navigation";
import { isMarketId } from "@/lib/markets/types";
import { InsightsBoard } from "@/components/insights-board";

// 국내 비상장(프리IPO) 리서치 화면(오너 지시 2026-09-26 — "한국은 인사이트 탭을 없애고 비상장으로").
// 인사이트(해외 IB) 탭은 미국에서만 쓴다 — 국내 주소는 /kr/unlisted.
export default async function UnlistedPage({
  params,
}: {
  params: Promise<{ market: string }>;
}) {
  const { market } = await params;
  if (!isMarketId(market) || market !== "kr") notFound();
  return <InsightsBoard market="kr" />;
}
