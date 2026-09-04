"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { apiFetch } from "@/lib/query";
import type { MarketId } from "@/lib/markets/types";
import type { StockOverview } from "@/lib/markets/service";
import type { FinancialStatement, Filing } from "@/lib/markets/types";
import { Button } from "@/components/ui/button";
import { SymbolSearch, type SymbolHit } from "@/components/symbol-search";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ChangePercent, Money, Multiple, NumberText } from "@/components/num";
import { StockPptButton } from "@/components/ppt-export";
import { FinancialsTable } from "@/components/financials-table";
import { DeepLinkList } from "@/components/deep-links";

export function StockAnalysis({
  market,
  initialSymbol = null,
  initialYahoo = null,
  initialName = null,
}: {
  market: MarketId;
  initialSymbol?: string | null;
  initialYahoo?: string | null;
  initialName?: string | null;
}) {
  const [symbol, setSymbol] = useState<string | null>(initialSymbol);
  const [yahooOverride, setYahooOverride] = useState<string | null>(initialYahoo);
  const [period, setPeriod] = useState<"annual" | "quarter">("annual");

  function pick(hit: SymbolHit) {
    setSymbol(hit.symbol);
    setYahooOverride(hit.yahooSymbol ?? null);
  }

  const overview = useQuery({
    queryKey: ["overview", market, symbol, yahooOverride],
    queryFn: () =>
      apiFetch<StockOverview>(
        `/api/markets/${market}/${encodeURIComponent(symbol!)}/overview` +
          (yahooOverride ? `?yahoo=${encodeURIComponent(yahooOverride)}` : ""),
      ),
    enabled: Boolean(symbol),
  });

  const financials = useQuery({
    queryKey: ["financials", market, symbol, period],
    queryFn: () =>
      apiFetch<FinancialStatement>(
        `/api/markets/${market}/${encodeURIComponent(symbol!)}/financials?period=${period}`,
      ),
    enabled: Boolean(symbol),
    retry: false,
  });

  const filings = useQuery({
    queryKey: ["filings", market, symbol],
    queryFn: () =>
      apiFetch<{ filings: Filing[] }>(
        `/api/markets/${market}/${encodeURIComponent(symbol!)}/filings?limit=30`,
      ),
    enabled: Boolean(symbol),
    retry: false,
  });

  const addToUniverse = useMutation({
    mutationFn: () =>
      apiFetch(`/api/universe`, {
        method: "POST",
        body: JSON.stringify({
          market,
          symbol,
          name: overview.data?.profile?.name ?? undefined,
          yahooSymbol: yahooOverride ?? undefined,
        }),
      }),
  });

  const ov = overview.data;

  return (
    <div className="space-y-6">
      <SymbolSearch market={market} onSelect={pick} />

      {!symbol && (
        <p className="text-muted-foreground text-sm">
          종목명 또는 코드로 검색하세요.
        </p>
      )}

      {symbol && overview.isLoading && (
        <>
          {initialName && (
            <h1 className="text-xl font-semibold">
              {initialName}{" "}
              <span className="text-muted-foreground tnum text-sm font-normal">
                {symbol}
              </span>
            </h1>
          )}
          <OverviewSkeleton />
        </>
      )}

      {symbol && overview.isError && (
        <ErrorBox message={(overview.error as Error).message} />
      )}

      {ov && (
        <>
          {!ov.configured && (
            <div className="border-border bg-muted/40 flex items-start gap-2 rounded-lg border p-3 text-sm">
              <TriangleAlert className="text-muted-foreground mt-0.5 size-4 shrink-0" />
              <p className="text-muted-foreground">{ov.configHint}</p>
            </div>
          )}

          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold">
                {ov.profile?.name ?? ov.symbol}
              </h1>
              <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-2 text-sm">
                <span className="tnum">{ov.symbol}</span>
                {ov.profile?.industry && <span>· {ov.profile.industry}</span>}
                {ov.profile?.homepage && (
                  <a
                    href={ov.profile.homepage}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline underline-offset-2"
                  >
                    홈페이지
                  </a>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <StockPptButton
                market={market}
                symbol={ov.symbol}
                yahoo={yahooOverride}
                name={ov.profile?.name}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={addToUniverse.isPending || addToUniverse.isSuccess}
                onClick={() => addToUniverse.mutate()}
              >
                {addToUniverse.isSuccess ? "유니버스에 추가됨" : "유니버스에 추가"}
              </Button>
            </div>
          </div>

          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">개요</TabsTrigger>
              <TabsTrigger value="financials">재무제표</TabsTrigger>
              <TabsTrigger value="filings">공시</TabsTrigger>
            </TabsList>

            {/* 개요 */}
            <TabsContent value="overview" className="space-y-6 pt-4">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label="종가">
                  <Money
                    value={ov.quote?.last}
                    currency={ov.quote?.currency ?? "USD"}
                  />
                  <div className="text-muted-foreground mt-1 text-xs">
                    {ov.quote?.lastDate ?? "-"} · {ov.quote?.source ?? ""}
                  </div>
                </Stat>
                <Stat label="전일 대비">
                  <ChangePercent value={ov.quote?.changePct} />
                </Stat>
                <Stat label="PER (최근 연간)">
                  <Multiple value={ov.multiples?.per} />
                </Stat>
                <Stat label="PBR">
                  <Multiple value={ov.multiples?.pbr} />
                </Stat>
                <Stat label="PSR">
                  <Multiple value={ov.multiples?.psr} />
                </Stat>
                <Stat label="EV/EBITDA(근사)">
                  <Multiple value={ov.multiples?.evEbitda} />
                </Stat>
                <Stat label="시가총액">
                  <Money
                    value={ov.multiples?.marketCap}
                    currency={ov.quote?.currency ?? "USD"}
                  />
                </Stat>
                <Stat label="Forward PER">
                  <Multiple value={ov.consensus?.forwardPer} />
                  <div className="text-muted-foreground mt-1 text-xs">개인용 · yahoo</div>
                </Stat>
              </div>

              {ov.consensus && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">
                      포워드 컨센서스{" "}
                      <span className="text-muted-foreground font-normal">
                        · {ov.consensus.source}
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-4 sm:grid-cols-4">
                      <Stat label="목표주가(평균)">
                        <Money
                          value={ov.consensus.targetMeanPrice}
                          currency={ov.consensus.currency}
                        />
                      </Stat>
                      <Stat label="목표주가(범위)">
                        <span className="tnum text-sm">
                          <Money
                            value={ov.consensus.targetLowPrice}
                            currency={ov.consensus.currency}
                          />
                          {" ~ "}
                          <Money
                            value={ov.consensus.targetHighPrice}
                            currency={ov.consensus.currency}
                          />
                        </span>
                      </Stat>
                      <Stat label="애널리스트 수">
                        <NumberText value={ov.consensus.numberOfAnalysts} />
                      </Stat>
                      <Stat label="투자의견">
                        <span className="text-sm">
                          {ov.consensus.recommendationKey ?? "-"}
                        </span>
                      </Stat>
                    </div>

                    {ov.consensus.estimates.length > 0 && (
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[420px] text-sm">
                          <thead>
                            <tr className="text-muted-foreground border-b text-left">
                              <th className="py-2 font-medium">기간</th>
                              <th className="py-2 text-right font-medium">EPS 평균</th>
                              <th className="py-2 text-right font-medium">EPS 범위</th>
                              <th className="py-2 text-right font-medium">매출 평균</th>
                            </tr>
                          </thead>
                          <tbody>
                            {ov.consensus.estimates.map((e) => (
                              <tr key={e.period} className="border-b">
                                <td className="py-1.5">{e.period}</td>
                                <td className="tnum py-1.5 text-right">
                                  <NumberText value={e.epsAvg} digits={2} />
                                </td>
                                <td className="tnum text-muted-foreground py-1.5 text-right text-xs">
                                  <NumberText value={e.epsLow} digits={2} /> ~{" "}
                                  <NumberText value={e.epsHigh} digits={2} />
                                </td>
                                <td className="tnum py-1.5 text-right">
                                  <NumberText value={e.revenueAvg} digits={0} />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              <div className="grid gap-6 sm:grid-cols-3">
                <DeepLinkList
                  title="포워드 컨센서스 (원본 확인)"
                  links={ov.deepLinks.consensus}
                  hint="인앱 수치는 개인용. 상세·검증은 원본에서."
                />
                <DeepLinkList title="관련 뉴스" links={ov.deepLinks.news} />
                <DeepLinkList
                  title="공시"
                  links={ov.deepLinks.filings ? [ov.deepLinks.filings] : []}
                />
              </div>

              {ov.warnings.length > 0 && (
                <div className="text-muted-foreground space-y-1 text-xs">
                  {ov.warnings.map((w, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <TriangleAlert className="size-3" />
                      {w}
                    </div>
                  ))}
                </div>
              )}

              {ov.profile?.address && (
                <p className="text-muted-foreground text-xs">
                  {ov.profile.address}
                </p>
              )}
            </TabsContent>

            {/* 재무제표 */}
            <TabsContent value="financials" className="space-y-4 pt-4">
              <ToggleGroup
                type="single"
                value={period}
                onValueChange={(v) => v && setPeriod(v as "annual" | "quarter")}
                variant="outline"
                size="sm"
              >
                <ToggleGroupItem value="annual">연간</ToggleGroupItem>
                <ToggleGroupItem value="quarter">분기</ToggleGroupItem>
              </ToggleGroup>

              {financials.isLoading && <Skeleton className="h-64 w-full" />}
              {financials.isError && (
                <ErrorBox message={(financials.error as Error).message} />
              )}
              {financials.data && financials.data.sections.length === 0 && (
                <p className="text-muted-foreground text-sm">
                  표시할 재무 데이터가 없습니다.
                </p>
              )}
              {financials.data && financials.data.sections.length > 0 && (
                <FinancialsTable statement={financials.data} />
              )}
            </TabsContent>

            {/* 공시 */}
            <TabsContent value="filings" className="space-y-3 pt-4">
              {filings.isLoading && <Skeleton className="h-48 w-full" />}
              {filings.isError && (
                <ErrorBox message={(filings.error as Error).message} />
              )}
              {filings.data && (
                <ul className="divide-y">
                  {filings.data.filings.map((f) => (
                    <li key={f.id} className="flex items-center gap-3 py-2 text-sm">
                      <Badge variant="secondary" className="tnum shrink-0">
                        {f.type}
                      </Badge>
                      <span className="text-muted-foreground tnum shrink-0 text-xs">
                        {f.date}
                      </span>
                      <a
                        href={f.url}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:text-primary truncate"
                      >
                        {f.title}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-border rounded-lg border p-3">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="mt-1 text-lg font-semibold">{children}</div>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-20 w-full" />
      ))}
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="border-destructive/40 bg-destructive/5 text-destructive flex items-center gap-2 rounded-lg border p-3 text-sm">
      <TriangleAlert className="size-4 shrink-0" />
      {message}
    </div>
  );
}
