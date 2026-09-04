"use client";

import Link from "next/link";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/query";
import type { MarketId } from "@/lib/markets/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ChangePercent, Money, Multiple, Percent } from "@/components/num";
import { UniversePptButton } from "@/components/ppt-export";
import { formatBigAmount, formatMarketCap } from "@/lib/format";

interface Row {
  itemId: string;
  market: MarketId;
  symbol: string;
  yahooSymbol: string | null;
  name: string | null;
  groupName: string | null;
  tags: string[];
  last?: number | null;
  changePct?: number | null;
  currency?: "KRW" | "USD" | "JPY" | null;
  per?: number | null;
  pbr?: number | null;
  forwardPer?: number | null;
  targetMeanPrice?: number | null;
  recommendationKey?: string | null;
  marketCap?: number | null;
  revenueAnnual?: number | null;
  opMargin?: number | null;
  netMargin?: number | null;
  warnings?: string[];
  error?: string | null;
  updatedAt?: string;
}

const CAP_UNIT: Record<MarketId, string> = { kr: "십억원", us: "십억$", jp: "억엔" };
const REV_UNIT: Record<MarketId, string> = { kr: "억원", us: "백만$", jp: "천만엔" };

function analysisHref(r: Row): string {
  const p = new URLSearchParams({ symbol: r.symbol });
  if (r.yahooSymbol) p.set("yahoo", r.yahooSymbol);
  if (r.name) p.set("name", r.name);
  return `/${r.market}/analysis?${p.toString()}`;
}

function fmtUpdated(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "방금";
  if (mins < 60) return `${mins}분 전`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}시간 전`;
  return `${Math.round(hrs / 24)}일 전`;
}

export function UniverseOverview({ market }: { market: MarketId }) {
  const q = useQuery({
    queryKey: ["universe-overview", market],
    queryFn: () => apiFetch<{ rows: Row[] }>(`/api/universe/overview?market=${market}`),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
  const capUnit = CAP_UNIT[market];
  const revUnit = REV_UNIT[market];

  const refresh = async () => {
    await apiFetch<{ rows: Row[] }>(`/api/universe/overview?market=${market}&refresh=1`);
    await q.refetch();
  };

  const updated = q.data?.rows?.reduce<string | undefined>(
    (min, r) => (r.updatedAt && (!min || r.updatedAt < min) ? r.updatedAt : min),
    undefined,
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">유니버스 통합 뷰</h1>
          <p className="text-muted-foreground text-sm">
            등록 종목의 시세 · 트레일링 멀티플 · 포워드 컨센서스 요약
            {updated && (
              <span className="ml-2 text-xs">· 갱신 {fmtUpdated(updated)}</span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {q.data && q.data.rows.length > 0 && <UniversePptButton market={market} />}
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={q.isFetching}
          >
            <RefreshCw className={q.isFetching ? "size-4 animate-spin" : "size-4"} />
            새로고침
          </Button>
        </div>
      </div>

      {q.isLoading && <Skeleton className="h-64 w-full" />}
      {q.isError && (
        <p className="text-destructive text-sm">{(q.error as Error).message}</p>
      )}

      {q.data && q.data.rows.length === 0 && (
        <p className="text-muted-foreground text-sm">
          이 시장에 등록된 유니버스 종목이 없습니다.{" "}
          <Link href="/manage" className="text-primary underline underline-offset-2">
            유니버스 관리
          </Link>
          에서 추가하세요.
        </p>
      )}

      {q.data && q.data.rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[1080px] text-sm">
            <thead>
              <tr className="bg-muted/50 text-muted-foreground text-left">
                <th className="px-3 py-2 font-medium">종목</th>
                <th className="px-3 py-2 font-medium">그룹</th>
                <th className="px-3 py-2 text-right font-medium">종가</th>
                <th className="px-3 py-2 text-right font-medium">등락</th>
                <th className="px-3 py-2 text-right font-medium">시가총액({capUnit})</th>
                <th className="px-3 py-2 text-right font-medium">매출액({revUnit})</th>
                <th className="px-3 py-2 text-right font-medium">영업이익률</th>
                <th className="px-3 py-2 text-right font-medium">순이익률</th>
                <th className="px-3 py-2 text-right font-medium">PER</th>
                <th className="px-3 py-2 text-right font-medium">PBR</th>
                <th className="px-3 py-2 text-right font-medium">Fwd PER</th>
                <th className="px-3 py-2 text-right font-medium">목표주가</th>
                <th className="px-3 py-2 font-medium">의견</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {q.data.rows.map((r) => (
                <tr key={r.itemId} className="hover:bg-muted/30">
                  <td className="px-3 py-2">
                    <Link
                      href={analysisHref(r)}
                      className="hover:text-primary font-medium"
                    >
                      {r.name ?? r.symbol}
                    </Link>
                    <div className="text-muted-foreground tnum text-xs">{r.symbol}</div>
                  </td>
                  <td className="px-3 py-2">
                    {r.groupName && (
                      <Badge variant="secondary" className="text-xs">
                        {r.groupName}
                      </Badge>
                    )}
                  </td>
                  {r.error ? (
                    <td colSpan={11} className="text-muted-foreground px-3 py-2 text-xs">
                      {r.error}
                    </td>
                  ) : (
                    <>
                      <td className="px-3 py-2 text-right">
                        <Money value={r.last} currency={r.currency ?? "USD"} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <ChangePercent value={r.changePct} />
                      </td>
                      <td className="tnum px-3 py-2 text-right">
                        {formatMarketCap(r.marketCap, r.market)}
                      </td>
                      <td className="tnum px-3 py-2 text-right">
                        {formatBigAmount(r.revenueAnnual, r.market)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Percent value={r.opMargin} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Percent value={r.netMargin} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Multiple value={r.per} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Multiple value={r.pbr} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Multiple value={r.forwardPer} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Money
                          value={r.targetMeanPrice}
                          currency={r.currency ?? "USD"}
                        />
                      </td>
                      <td className="text-muted-foreground px-3 py-2 text-xs">
                        {r.recommendationKey ?? "-"}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
