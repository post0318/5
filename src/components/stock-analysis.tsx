"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { apiFetch } from "@/lib/query";
import { cn } from "@/lib/utils";
import { formatMoneyWithUnits } from "@/lib/format";
import type { MarketId } from "@/lib/markets/types";
import type { StockOverview } from "@/lib/markets/service";
import { computeTrailingMultiples } from "@/lib/markets/multiples";
import type { FinancialStatement, Filing, TtmFlows } from "@/lib/markets/types";
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
import { ChangePercent, Money, Multiple, NumberText, Percent } from "@/components/num";
import { StockPptButton } from "@/components/ppt-export";
import { FinancialsTable } from "@/components/financials-table";
import { DeepLinkList } from "@/components/deep-links";
import { ConsensusPanel } from "@/components/consensus-panel";

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
  const qc = useQueryClient();
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

  // 멀티플용 연간 재무제표 — period 탭과 무관하게 항상 연간. period가 "annual"이면
  // 위 financials 쿼리와 키가 같아 자동 중복 제거된다.
  const annualForMultiples = useQuery({
    queryKey: ["financials", market, symbol, "annual"],
    queryFn: () =>
      apiFetch<FinancialStatement>(
        `/api/markets/${market}/${encodeURIComponent(symbol!)}/financials?period=annual`,
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

  const ttmQ = useQuery({
    queryKey: ["ttm", market, symbol],
    queryFn: () =>
      apiFetch<{ ttm: TtmFlows | null }>(
        `/api/markets/${market}/${encodeURIComponent(symbol!)}/ttm`,
      ),
    enabled: Boolean(symbol),
    retry: false,
  });

  const rightsQ = useQuery({
    queryKey: ["rights", market, symbol],
    queryFn: () =>
      apiFetch<{
        events: {
          basDt: string;
          reason: string;
          startDt: string | null;
          endDt: string | null;
          closeStartDt: string | null;
          closeEndDt: string | null;
        }[];
        pending?: boolean;
      }>(
        `/api/markets/${market}/${encodeURIComponent(symbol!)}/rights` +
          (overview.data?.profile?.name
            ? `?name=${encodeURIComponent(overview.data.profile.name)}`
            : ""),
      ),
    enabled: Boolean(symbol) && market === "kr",
    retry: false,
  });

  const naverQ = useQuery({
    queryKey: ["kr-naver", market, symbol],
    queryFn: () =>
      apiFetch<{
        foreign: { ratio: number; asOf: string } | null;
        consensus: {
          estYear: number | null;
          estEps: number | null;
          estPer: number | null;
          targetMean: number | null;
          recommMean: number | null;
        } | null;
      }>(`/api/markets/${market}/${encodeURIComponent(symbol!)}/foreign`),
    enabled: Boolean(symbol) && market === "kr",
    retry: false,
  });

  const universe = useQuery({
    queryKey: ["universe"],
    queryFn: () =>
      apiFetch<{ items: { market: string; symbol: string }[] }>("/api/universe"),
  });
  const normSym = (s: string) => {
    const d = s.replace(/[^0-9]/g, "");
    return d.length >= 4 && d.length <= 6 ? d.padStart(6, "0") : s.toUpperCase();
  };
  const inUniverse = Boolean(
    symbol &&
      universe.data?.items.some(
        (i) => i.market === market && normSym(i.symbol) === normSym(symbol),
      ),
  );

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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["universe"] });
      qc.invalidateQueries({ queryKey: ["universe-overview"] });
    },
  });
  // 페이지 내에서 다른 종목을 조회하면 "추가됨" 상태가 남지 않도록 초기화
  useEffect(() => {
    addToUniverse.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  const ov = overview.data;

  // 개요 엔드포인트는 속도를 위해 재무제표를 안 받아온다 → 멀티플은 여기서 계산.
  const multiples = useMemo(() => {
    if (!ov?.quote || !annualForMultiples.data) return ov?.multiples ?? null;
    return computeTrailingMultiples({
      market,
      symbol: ov.symbol,
      quote: ov.quote,
      annual: annualForMultiples.data,
      quarterly: null,
      sharesOutstanding: ov.quote.sharesOutstanding ?? null,
    });
  }, [ov, annualForMultiples.data, market]);
  const multiplesFallback =
    annualForMultiples.isLoading ? "…" : annualForMultiples.isError ? "n/a" : "-";
  const ccy = ov?.quote?.currency ?? "USD";
  const price = ov?.quote?.last ?? null;

  // ── 트레일링PER (TTM) ────────────────────────────────────────────
  // 국내: DART 자체 TTM. 미국: Yahoo trailingPE, 없으면 자체 TTM.
  const ttm = ttmQ.data?.ttm ?? null;
  const ttmEps =
    ttm?.eps != null && ttm.eps > 0
      ? ttm.eps
      : ttm?.netIncome != null && multiples?.inputs.shares
        ? ttm.netIncome / multiples.inputs.shares
        : null;
  const ownTtmPer = price != null && ttmEps ? price / ttmEps : null;
  const trailingPer =
    market === "kr" ? ownTtmPer : (ov?.consensus?.trailingPer ?? ownTtmPer);

  // ── 추정PER — 당해년도 컨센서스 추정 EPS 기준 ──
  // 국내: 네이버(FnGuide) 컨센서스. 해외: 야후 earningsTrend, 폴백 forwardPE.
  const nvCons = naverQ.data?.consensus ?? null;
  const yhEstEps =
    ov?.consensus?.estimates?.find((e) => e.period.startsWith("당해"))?.epsAvg ??
    ov?.consensus?.estimates?.[0]?.epsAvg ??
    null;
  const estEps = market === "kr" ? nvCons?.estEps ?? null : yhEstEps;
  const estPer =
    market === "kr"
      ? nvCons?.estPer ??
        (price != null && estEps != null && estEps > 0 ? price / estEps : null)
      : price != null && yhEstEps != null && yhEstEps > 0
        ? price / yhEstEps
        : (ov?.consensus?.forwardPer ?? null);

  // 투자지표 표 (펀더멘털 + 참고) — 2개씩 묶어 한 행
  const metrics: { label: string; node: React.ReactNode }[] = [
    { label: "PER", node: <Multiple value={multiples?.per} fallback={multiplesFallback} /> },
    {
      label: "PER(TTM)",
      node: <Multiple value={trailingPer} fallback={ttmQ.isLoading ? "…" : "-"} />,
    },
    { label: "추정PER", node: <Multiple value={estPer} fallback="-" /> },
    { label: "PBR", node: <Multiple value={multiples?.pbr} fallback={multiplesFallback} /> },
    { label: "EPS", node: <Money value={multiples?.eps} currency={ccy} fallback={multiplesFallback} /> },
    { label: "EPS(TTM)", node: <Money value={ttmEps} currency={ccy} fallback="-" /> },
    { label: "PSR", node: <Multiple value={multiples?.psr} fallback={multiplesFallback} /> },
    { label: "BPS", node: <Money value={multiples?.bps} currency={ccy} fallback={multiplesFallback} /> },
    { label: "EV/EBITDA", node: <Multiple value={multiples?.evEbitda} fallback={multiplesFallback} /> },
    { label: "DPS", node: <Money value={ov?.consensus?.dividendPerShare} currency={ccy} fallback="-" /> },
    { label: "배당수익률", node: <Percent value={ov?.consensus?.dividendYield} fallback="-" /> },
  ];
  const metricRows: (typeof metrics)[] = [];
  for (let i = 0; i < metrics.length; i += 4) metricRows.push(metrics.slice(i, i + 4));

  return (
    <div className="space-y-6">
      <SymbolSearch
        market={market}
        onSelect={pick}
        initialLabel={
          initialSymbol
            ? initialName
              ? `${initialName} (${initialSymbol})`
              : initialSymbol
            : ""
        }
      />

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
              <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
                {ov.profile?.name ?? ov.symbol}
                {ov.highDividend && (
                  <Badge variant="secondary" className="text-xs font-medium">
                    고배당기업
                  </Badge>
                )}
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
                disabled={
                  inUniverse || addToUniverse.isPending || addToUniverse.isSuccess
                }
                onClick={() => addToUniverse.mutate()}
              >
                {inUniverse || addToUniverse.isSuccess
                  ? "유니버스에 있음"
                  : "유니버스에 추가"}
              </Button>
            </div>
          </div>

          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">개요</TabsTrigger>
              <TabsTrigger value="financials">재무제표</TabsTrigger>
              <TabsTrigger value="filings">공시</TabsTrigger>
              {market === "kr" && (
                <TabsTrigger value="rights">권리일정</TabsTrigger>
              )}
            </TabsList>

            {/* 개요 */}
            <TabsContent value="overview" className="space-y-6 pt-4">
              {/* 시세 */}
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label="종가">
                  <span className="inline-flex items-baseline gap-1.5">
                    <Money value={ov.quote?.last} currency={ccy} />
                    {ov.quote?.changePct != null && (
                      <span className="text-sm font-normal">
                        (<ChangePercent value={ov.quote.changePct} />)
                      </span>
                    )}
                  </span>
                  <div className="text-muted-foreground mt-1 text-xs">
                    {ov.quote?.lastDate ?? "-"} · {ov.quote?.source ?? ""}
                  </div>
                </Stat>
                <Stat label="시가총액">
                  <span className="text-base">
                    {formatMoneyWithUnits(multiples?.marketCap ?? ov.quote?.marketCap, market)}
                  </span>
                  {market === "kr" && naverQ.data?.foreign && (
                    <div className="text-muted-foreground mt-1 text-xs">
                      외국인지분율 {naverQ.data.foreign.ratio.toFixed(2)}%
                    </div>
                  )}
                </Stat>
                <Stat label="52주 베타">
                  <span className="tnum text-base">
                    <NumberText value={ov.consensus?.beta} digits={2} fallback="-" />
                  </span>
                </Stat>
                <Stat label="52주 최고 / 최저">
                  <span className="tnum text-base">
                    <span className="text-up">
                      <Money value={ov.consensus?.fiftyTwoWeekHigh} currency={ccy} fallback="-" />
                    </span>
                    {" / "}
                    <span className="text-down">
                      <Money value={ov.consensus?.fiftyTwoWeekLow} currency={ccy} fallback="-" />
                    </span>
                  </span>
                  <Week52Bar
                    price={ov.quote?.last ?? null}
                    high={ov.consensus?.fiftyTwoWeekHigh ?? null}
                    low={ov.consensus?.fiftyTwoWeekLow ?? null}
                  />
                </Stat>
              </div>

              {/* 투자지표 (펀더멘털 + 참고) */}
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">투자지표</h3>
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full min-w-[820px] text-sm">
                    <tbody>
                      {metricRows.map((row, i) => (
                        <tr key={i} className="border-b last:border-b-0">
                          {row.map((m, j) => (
                            <MetricCells key={j} m={m} first={j === 0} />
                          ))}
                          {row.length < 4 &&
                            Array.from({ length: 4 - row.length }).map((_, k) => (
                              <td key={`f${k}`} colSpan={2} className="border-l" />
                            ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-muted-foreground/80 text-[11px]">
                  PER/PBR/EPS/BPS/EV·EBITDA = 최근 연간 공시 재무 + 현재가 자체 계산 · PER(TTM) = 최근 4분기(국내 DART·해외 yahoo) · 추정PER/유동비율/배당 = yahoo 개인용
                </p>
              </section>

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
                  </CardContent>
                </Card>
              )}

              <ConsensusPanel market={market} symbol={ov.symbol} yahoo={yahooOverride} />

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

            {/* 권리일정 (한국) */}
            {market === "kr" && (
              <TabsContent value="rights" className="space-y-3 pt-4">
                {rightsQ.isLoading && <Skeleton className="h-48 w-full" />}
                {rightsQ.isError && (
                  <ErrorBox message={(rightsQ.error as Error).message} />
                )}
                {rightsQ.data?.pending && (
                  <p className="text-muted-foreground text-sm">
                    권리일정 API 전파 대기 중입니다 (공공데이터포털 승인 직후 최대 1영업일).
                  </p>
                )}
                {rightsQ.data && !rightsQ.data.pending && rightsQ.data.events.length === 0 && (
                  <p className="text-muted-foreground text-sm">
                    최근 1년 ~ 향후 등록된 권리일정이 없습니다.
                  </p>
                )}
                {rightsQ.data && rightsQ.data.events.length > 0 && (
                  <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full min-w-[560px] text-sm">
                      <thead>
                        <tr className="bg-muted/50 text-muted-foreground text-left">
                          <th className="px-3 py-2 font-medium">기준일</th>
                          <th className="px-3 py-2 font-medium">권리사유</th>
                          <th className="px-3 py-2 font-medium">권리행사 시작</th>
                          <th className="px-3 py-2 font-medium">권리행사 종료</th>
                          <th className="px-3 py-2 font-medium">명부폐쇄</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {rightsQ.data.events.map((e, i) => (
                          <tr key={i} className="hover:bg-muted/30">
                            <td className="tnum px-3 py-2">{e.basDt || "-"}</td>
                            <td className="px-3 py-2">{e.reason}</td>
                            <td className="tnum px-3 py-2">{e.startDt ?? "-"}</td>
                            <td className="tnum px-3 py-2">{e.endDt ?? "-"}</td>
                            <td className="tnum text-muted-foreground px-3 py-2 text-xs">
                              {e.closeStartDt
                                ? `${e.closeStartDt} ~ ${e.closeEndDt ?? ""}`
                                : "-"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="text-muted-foreground/80 text-[11px]">
                  출처: 금융위원회_주식권리일정정보 (공공데이터포털) · 익영업일 13시 이후 갱신
                </p>
              </TabsContent>
            )}
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

/** 52주 고점=100 기준 현재가 위치를 가로 바로. 고점比 마이너스(고점 미달)=하락색 / 고점 초과=상승색. */
function Week52Bar({
  price,
  high,
  low,
}: {
  price: number | null;
  high: number | null;
  low: number | null;
}) {
  if (price == null || high == null || high <= 0) return null;
  const pct = (price / high) * 100; // 고점 대비 %
  const over = pct > 100;
  const fill = Math.max(0, Math.min(100, pct));
  const lowPct = low != null && low > 0 ? (price / low - 1) * 100 : null;
  return (
    <div className="mt-1.5">
      <div className="bg-muted relative h-1.5 w-full overflow-hidden rounded-full">
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${over ? 100 : fill}%`,
            background: over
              ? "linear-gradient(90deg, oklch(0.78 0.1 145), oklch(0.6 0.17 145))"
              : "linear-gradient(90deg, oklch(0.82 0.08 27), oklch(0.58 0.2 27))",
          }}
        />
      </div>
      <div className="text-muted-foreground tnum mt-0.5 flex justify-between text-[10px]">
        <span className="text-up">{lowPct != null ? `저점比 +${lowPct.toFixed(0)}%` : " "}</span>
        <span className="text-down">고점比 −{Math.max(0, 100 - pct).toFixed(0)}%</span>
      </div>
    </div>
  );
}

function MetricCells({
  m,
  first,
}: {
  m: { label: string; node: React.ReactNode };
  first: boolean;
}) {
  return (
    <>
      <th
        className={cn(
          "text-muted-foreground bg-muted/30 px-3 py-2 text-left text-xs font-medium whitespace-nowrap",
          !first && "border-l",
        )}
      >
        {m.label}
      </th>
      <td className="tnum px-3 py-2 text-right font-medium">{m.node}</td>
    </>
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
