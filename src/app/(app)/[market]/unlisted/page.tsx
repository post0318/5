import { notFound, redirect } from "next/navigation";
import { isMarketId } from "@/lib/markets/types";
import { InsightsBoard } from "@/components/insights-board";

// 비상장(프리IPO) 리서치 화면(오너 지시 2026-09-26 — "한국은 인사이트 탭을 없애고 비상장으로", 2026-09-27 — "미국과 중국도 비상장을
// 추가한다"). 국내는 /kr/unlisted, 미국은 /us/unlisted. 일본은 수집분이 없어 열지 않는다. 중국(ch)은 앱에 시장 화면이 없어 데이터만 쌓는다.
// 인사이트(해외 IB) 탭은 미국 등 해외 시장 전용(/us/insights).
// 미국 비상장은 산업분석에 합쳤다(오너 지시 2026-10-05) — /us/unlisted 는 /us/research 로 넘긴다.
export default async function UnlistedPage({
  params,
}: {
  params: Promise<{ market: string }>;
}) {
  const { market } = await params;
  if (market === "us") redirect("/us/research");
  if (!isMarketId(market) || market !== "kr") notFound();
  return <InsightsBoard market={market} kind="unlisted" />;
}
