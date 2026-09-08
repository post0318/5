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
import type { FinancialHighlights } from "@/lib/markets/us/edgar-highlights";
import { FinancialHighlightsTable } from "@/components/financial-highlights";
import { Button } from "@/components/ui/button";
import { SymbolSearch, type SymbolHit } from "@/components/symbol-search";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
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
  const [filingScope, setFilingScope] = useState<"core" | "all">("core");

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

  // 미국 표준화 상세표 (CF·IS 하위탭)
  const cfDetailQ = useQuery({
    queryKey: ["financials-cf", market, symbol, period],
    queryFn: () =>
      apiFetch<FinancialStatement>(
        `/api/markets/${market}/${encodeURIComponent(symbol!)}/financials?view=cf&period=${period}`,
      ),
    enabled: Boolean(symbol) && market === "us",
    retry: false,
  });
  const isDetailQ = useQuery({
    queryKey: ["financials-is", market, symbol, period],
    queryFn: () =>
      apiFetch<FinancialStatement>(
        `/api/markets/${market}/${encodeURIComponent(symbol!)}/financials?view=is&period=${period}`,
      ),
    enabled: Boolean(symbol) && market === "us",
    retry: false,
  });
  const bsDetailQ = useQuery({
    queryKey: ["financials-bs", market, symbol, period],
    queryFn: () =>
      apiFetch<FinancialStatement>(
        `/api/markets/${market}/${encodeURIComponent(symbol!)}/financials?view=bs&period=${period}`,
      ),
    enabled: Boolean(symbol) && market === "us",
    retry: false,
  });
  const analysisQ = useQuery({
    queryKey: ["financials-analysis", market, symbol, yahooOverride],
    queryFn: () =>
      apiFetch<FinancialStatement>(
        `/api/markets/${market}/${encodeURIComponent(symbol!)}/financials?view=analysis` +
          (yahooOverride ? `&yahoo=${encodeURIComponent(yahooOverride)}` : ""),
      ),
    enabled: Boolean(symbol) && market === "us",
    retry: false,
  });
  const summaryQ = useQuery({
    queryKey: ["financials-summary", market, symbol, period],
    queryFn: () =>
      apiFetch<FinancialStatement>(
        `/api/markets/${market}/${encodeURIComponent(symbol!)}/financials?view=summary&period=${period}`,
      ),
    enabled: Boolean(symbol) && market === "us",
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
    queryKey: ["ttm", market, symbol, yahooOverride],
    queryFn: () =>
      apiFetch<{
        ttm: TtmFlows | null;
        dividend: {
          annual: { dps: number; year: number } | null;
          ttm: { dps: number; from: string; to: string } | null;
        } | null;
        beta: {
          beta: number;
          change: number | null;
          n: number;
          high52: number | null;
          low52: number | null;
        } | null;
      }>(
        `/api/markets/${market}/${encodeURIComponent(symbol!)}/ttm` +
          (yahooOverride ? `?yahoo=${encodeURIComponent(yahooOverride)}` : ""),
      ),
    enabled: Boolean(symbol),
    retry: false,
  });

  const daQ = useQuery({
    queryKey: ["da", market, symbol],
    queryFn: () =>
      apiFetch<{
        da: { depreciation: number | null; amortisation: number | null } | null;
      }>(`/api/markets/${market}/${encodeURIComponent(symbol!)}/da`),
    enabled: Boolean(symbol) && market === "kr",
    retry: false,
  });

  const highlightsQ = useQuery({
    queryKey: ["highlights", market, symbol, yahooOverride],
    queryFn: () =>
      apiFetch<{ highlights: FinancialHighlights | null }>(
        `/api/markets/${market}/${encodeURIComponent(symbol!)}/highlights` +
          (yahooOverride ? `?yahoo=${encodeURIComponent(yahooOverride)}` : ""),
      ),
    enabled: Boolean(symbol) && market === "us",
    retry: false,
  });

  const rightsQ = useQuery({
    queryKey: ["rights", market, symbol],
    queryFn: () =>
      apiFetch<{
        events: {
          basDt: string;
          exRightsDate: string | null;
          payoutDate: string | null;
          reason: string;
          dividendPerShare: number | null;
          dividendYield: number | null;
          filing: { title: string; url: string; date: string } | null;
          note: string | null;
        }[];
        pending?: boolean;
      }>(
        `/api/markets/${market}/${encodeURIComponent(symbol!)}/rights` +
          (yahooOverride ? `?yahoo=${encodeURIComponent(yahooOverride)}` : ""),
      ),
    enabled: Boolean(symbol) && (market === "kr" || market === "us"),
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
  const da = daQ.data?.da ?? null;
  const daTotal =
    da && (da.depreciation != null || da.amortisation != null)
      ? (da.depreciation ?? 0) + (da.amortisation ?? 0)
      : null;
  const ttmForMultiples = ttmQ.data?.ttm ?? null;
  const multiples = useMemo(() => {
    if (!ov?.quote || !annualForMultiples.data) return ov?.multiples ?? null;
    return computeTrailingMultiples({
      market,
      symbol: ov.symbol,
      quote: ov.quote,
      annual: annualForMultiples.data,
      quarterly: null,
      sharesOutstanding: ov.quote.sharesOutstanding ?? null,
      depreciationAmortisation: daTotal,
      // 미국(EDGAR): 최근분기 재무상태표·D&A·EPS(TTM) 스냅샷 → BPS·PBR·PSR·EV 정확도
      ttm: ttmForMultiples,
    });
  }, [ov, annualForMultiples.data, market, daTotal, ttmForMultiples]);
  const multiplesFallback =
    annualForMultiples.isLoading ? "…" : annualForMultiples.isError ? "n/a" : "-";
  const ccy = ov?.quote?.currency ?? "USD";
  const price = ov?.quote?.last ?? null;

  const cons = ov?.consensus ?? null;

  // ── 일본: 무료 분기 공시가 없어(四半期報告書 폐지·J-Quants 재무 유료) 자체 TTM 불가.
  //    지표 정의는 미국과 동일(TTM·최근분기·차기추정)하되 값은 Yahoo 제공치 사용.
  const jpY =
    market === "jp" && cons
      ? {
          trailingEps: cons.trailingEps,
          pbr: price != null && cons.bookValue ? price / cons.bookValue : null,
          bps: cons.bookValue,
          psr:
            cons.marketCap != null && cons.revenueTtm
              ? cons.marketCap / cons.revenueTtm
              : null,
          evEbitda:
            cons.enterpriseValue != null && cons.ebitdaTtm
              ? cons.enterpriseValue / cons.ebitdaTtm
              : null,
          dpsTtm: cons.trailingAnnualDividendRate,
        }
      : null;

  // ── PER(TTM) · EPS(TTM) ─────────────────────────────────────────
  // 국내: DART 자체 TTM(직전연간 + 당기누적 − 전년동기). 미국: EDGAR 동일 방식. 일본: Yahoo.
  const ttm = ttmQ.data?.ttm ?? null;
  const ttmEps =
    jpY
      ? (jpY.trailingEps ?? null)
      : ttm?.eps != null && ttm.eps > 0
        ? ttm.eps
        : ttm?.netIncome != null && multiples?.inputs.shares
          ? ttm.netIncome / multiples.inputs.shares
          : null;
  const ownTtmPer = price != null && ttmEps ? price / ttmEps : null;
  const trailingPer = ownTtmPer ?? cons?.trailingPer ?? null;

  const pbrVal = jpY?.pbr ?? multiples?.pbr ?? null;
  const bpsVal = jpY?.bps ?? multiples?.bps ?? null;
  const psrVal = jpY?.psr ?? multiples?.psr ?? null;
  const evEbitdaVal = jpY?.evEbitda ?? multiples?.evEbitda ?? null;
  const evEbitdaApprox = jpY ? false : (multiples?.evEbitdaIsApprox ?? true);

  // ── 추정PER ─────────────────────────────────────────────────────
  // 국내: 네이버(FnGuide) 당해년도 컨센서스. 미국: 야후 차기 회계연도(Forward).
  //   (미국은 당해 추정 EPS ≈ TTM 이라 당해 기준이면 PER(TTM)과 중복되어 차기로 잡음)
  const nvCons = naverQ.data?.consensus ?? null;
  const fwdEstEps =
    ov?.consensus?.estimates?.find((e) => e.period.startsWith("차년"))?.epsAvg ??
    null;
  const estEps = market === "kr" ? (nvCons?.estEps ?? null) : fwdEstEps;
  const estPer =
    market === "kr"
      ? (nvCons?.estPer ??
        (price != null && estEps != null && estEps > 0 ? price / estEps : null))
      : (ov?.consensus?.forwardPer ??
        (price != null && fwdEstEps != null && fwdEstEps > 0
          ? price / fwdEstEps
          : null));

  // DPS — 국내: 금융위 배당정보 API. 미국: EDGAR CommonStockDividendsPerShareDeclared.
  //   둘 다 DPS(전년 회계연도) + DPS(TTM, 최근 12개월).
  const dps =
    (ttmQ.data?.dividend?.annual?.dps ?? null) ??
    (market !== "kr" ? (cons?.dividendPerShare ?? null) : null);
  const dpsTtm = (ttmQ.data?.dividend?.ttm?.dps ?? null) ?? jpY?.dpsTtm ?? null;
  // 배당수익률 = TTM 주당배당금 / 현재가. 소수 비율(0.012 = 1.2%)로 통일 (<Percent>가 ×100)
  const divYield =
    price != null && dpsTtm != null && price > 0
      ? dpsTtm / price
      : market !== "kr"
        ? ((cons?.dividendYield ?? null) as number | null)
        : null;

  // 투자지표 표 (펀더멘털 + 참고) — 2개씩 묶어 한 행
  const metrics: { label: string; node: React.ReactNode }[] = [
    { label: "PER", node: <Multiple value={multiples?.per} fallback={multiplesFallback} /> },
    {
      label: "PER(TTM)",
      node: <Multiple value={trailingPer} fallback={ttmQ.isLoading ? "…" : "-"} />,
    },
    { label: "추정PER", node: <Multiple value={estPer} fallback="-" /> },
    { label: "PBR", node: <Multiple value={pbrVal} fallback={multiplesFallback} /> },
    {
      label: evEbitdaApprox ? "EV/EBIT" : "EV/EBITDA",
      node: <Multiple value={evEbitdaVal} fallback={multiplesFallback} />,
    },
    { label: "BPS", node: <Money value={bpsVal} currency={ccy} fallback={multiplesFallback} /> },
    {
      label: "DPS",
      node: <Money value={dps} currency={ccy} fallback="-" />,
    },
    {
      label: "DPS(TTM)",
      node: <Money value={dpsTtm} currency={ccy} fallback="-" />,
    },
    {
      label: "배당수익률",
      node: <Percent value={divYield} fallback="-" />,
    },
    { label: "PSR", node: <Multiple value={psrVal} fallback={multiplesFallback} /> },
  ];

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
              {market === "us" && <TabsTrigger value="analysis">재무분석</TabsTrigger>}
              {(market === "kr" || market === "us") && (
                <TabsTrigger value="rights">권리일정</TabsTrigger>
              )}
              <TabsTrigger value="filings">공시</TabsTrigger>
            </TabsList>

            {/* 개요 */}
            <TabsContent value="overview" className="space-y-6 pt-4">
              {/* 시세 */}
              {/* 모바일 2열: 1·4 / 2·3 → sm 이상은 원래 순서 */}
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <Stat label="종가" className="order-1 lg:order-none">
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
                <Stat label="시가총액" className="order-3 lg:order-none">
                  <span className="text-base">
                    {formatMoneyWithUnits(multiples?.marketCap ?? ov.quote?.marketCap, market)}
                  </span>
                  {market === "kr" && naverQ.data?.foreign && (
                    <div className="text-muted-foreground mt-1 text-xs">
                      외국인지분율 {naverQ.data.foreign.ratio.toFixed(2)}%
                    </div>
                  )}
                  {market === "us" && ov.consensus?.shortPercentSharesOut != null && (
                    <div className="text-muted-foreground mt-1 text-xs">
                      공매도/발행주식 {(ov.consensus.shortPercentSharesOut * 100).toFixed(2)}%
                    </div>
                  )}
                </Stat>
                <Stat label="52주 베타" className="order-4 lg:order-none">
                  <span className="tnum text-base">
                    <NumberText
                      value={ttmQ.data?.beta?.beta ?? ov.consensus?.beta ?? null}
                      digits={2}
                      fallback="-"
                    />
                    {ttmQ.data?.beta?.change != null && (
                      <span
                        className={cn(
                          "tnum ml-1 text-sm font-normal",
                          ttmQ.data.beta.change > 0 && "text-up",
                          ttmQ.data.beta.change < 0 && "text-down",
                          ttmQ.data.beta.change === 0 && "text-muted-foreground",
                        )}
                      >
                        ({ttmQ.data.beta.change > 0 ? "+" : ""}
                        {ttmQ.data.beta.change.toFixed(3)})
                      </span>
                    )}
                  </span>
                  {ttmQ.data?.beta?.beta != null ? (
                    <div className="text-muted-foreground mt-1 text-[11px]">
                      {market === "kr" ? "KOSPI" : "S&P 500"} · 52주 일간
                    </div>
                  ) : ov.consensus?.beta != null ? (
                    <div className="text-muted-foreground mt-1 text-[11px]">yahoo · 5년 월간</div>
                  ) : null}
                </Stat>
                <Stat label="52주 최고 / 최저" className="order-2 lg:order-none">
                  {(() => {
                    const hi52 =
                      ttmQ.data?.beta?.high52 ?? ov.consensus?.fiftyTwoWeekHigh ?? null;
                    const lo52 =
                      ttmQ.data?.beta?.low52 ?? ov.consensus?.fiftyTwoWeekLow ?? null;
                    return (
                      <>
                        <span className="tnum text-base">
                          <span className="text-up">
                            <Money value={hi52} currency={ccy} fallback="-" />
                          </span>
                          {" / "}
                          <span className="text-down">
                            <Money value={lo52} currency={ccy} fallback="-" />
                          </span>
                        </span>
                        <Week52Bar price={ov.quote?.last ?? null} high={hi52} low={lo52} />
                      </>
                    );
                  })()}
                </Stat>
              </div>

              {/* 재무 하이라이트 (EV 브릿지 + 5개년 + LTM + 추정) — 현재 미국만 */}
              {highlightsQ.data?.highlights && (
                <FinancialHighlightsTable data={highlightsQ.data.highlights} />
              )}

              {/* 투자지표 — 미국은 재무 하이라이트의 연도별 표로 대체 */}
              {market !== "us" && (
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">투자지표</h3>
                <div className="grid grid-cols-2 overflow-hidden rounded-lg border text-sm lg:grid-cols-4">
                  {metrics.map((m, i) => {
                    const mobShade = Math.floor(i / 2) % 2 === 1; // 모바일 2·4·6행
                    const deskShade = Math.floor(i / 4) === 1; // 데스크톱 2행(5~8번)
                    return (
                      <div
                        key={i}
                        className={cn(
                          "flex items-center justify-between gap-2 border-b border-l px-3 py-2 [&:nth-child(2n+1)]:border-l-0 lg:[&:nth-child(2n+1)]:border-l lg:[&:nth-child(4n+1)]:border-l-0",
                          mobShade && "bg-muted/70",
                          deskShade ? "lg:bg-muted/70" : "lg:bg-transparent",
                        )}
                      >
                        <span className="text-muted-foreground text-xs font-medium whitespace-nowrap">
                          {m.label}
                        </span>
                        <span className="tnum text-right font-medium">{m.node}</span>
                      </div>
                    );
                  })}
                </div>
                <p className="text-muted-foreground/80 text-[11px] leading-relaxed">
                  {market === "kr" ? (
                    <>
                      PER·PBR·PSR·BPS·PER(TTM)·EV/EBITDA : DART / DPS·DPS(TTM)·배당수익률 :
                      금융위원회 주식배당정보
                    </>
                  ) : (
                    <>
                      PER = 최근 연간 공시(EDINET) + 현재가 자체 계산 ·
                      PBR·BPS·PSR·EV/EBITDA·PER(TTM)·추정PER(차기 회계연도)·DPS·DPS(TTM)·배당수익률 =
                      yahoo-finance2 (개인용) — 일본은 무료 분기 공시가 없어 TTM·최근분기 지표는 Yahoo 제공치
                    </>
                  )}
                </p>
              </section>
              )}

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
                <FinancialsTable
                  statement={financials.data}
                  detailedCf={market === "us" ? (cfDetailQ.data ?? null) : null}
                  detailedIs={market === "us" ? (isDetailQ.data ?? null) : null}
                  detailedBs={market === "us" ? (bsDetailQ.data ?? null) : null}
                  detailedSummary={market === "us" ? (summaryQ.data ?? null) : null}
                  period={period}
                  onPeriodChange={setPeriod}
                />
              )}
            </TabsContent>

            {/* 분석 (미국) */}
            {market === "us" && (
              <TabsContent value="analysis" className="space-y-4 pt-4">
                {analysisQ.isLoading && <Skeleton className="h-64 w-full" />}
                {analysisQ.isError && (
                  <ErrorBox message={(analysisQ.error as Error).message} />
                )}
                {analysisQ.data && (
                  <FinancialsTable statement={analysisQ.data} standalone />
                )}
              </TabsContent>
            )}

            {/* 공시 */}
            <TabsContent value="filings" className="space-y-3 pt-4">
              {filings.isLoading && <Skeleton className="h-48 w-full" />}
              {filings.isError && (
                <ErrorBox message={(filings.error as Error).message} />
              )}
              {filings.data && (
                <>
                  <div className="border-border flex w-fit overflow-hidden rounded-md border text-sm">
                    {(["core", "all"] as const).map((v) => (
                      <button
                        key={v}
                        onClick={() => setFilingScope(v)}
                        className={cn(
                          "px-3 py-1 transition-colors",
                          filingScope === v
                            ? "bg-primary text-primary-foreground"
                            : "hover:bg-muted text-muted-foreground",
                        )}
                      >
                        {v === "core" ? "주요 공시" : "전체"}
                      </button>
                    ))}
                  </div>
                  {market === "us" && filingScope === "core" && (
                    <p className="text-muted-foreground/80 text-[11px]">
                      10-K(연차)·10-Q(분기)·8-K(수시)·DEF 14A(위임장)·S/424B(증권발행) 만.
                      Form 4(내부자 거래)·SC 13D/G(대량보유) 등은 &ldquo;전체&rdquo;에서.
                    </p>
                  )}
                <ul className="divide-y">
                  {filings.data.filings
                    .filter((f) => {
                      if (filingScope === "all" || market !== "us") return true;
                      return /^(10-[KQ]|8-K|20-F|6-K|DEF ?A?14A|DEFA14A|S-\d|424B|F-\d|40-F|11-K)/i.test(
                        f.type.trim(),
                      );
                    })
                    .map((f) => (
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
                </>
              )}
            </TabsContent>

            {/* 권리일정 (한국·미국) */}
            {(market === "kr" || market === "us") && (
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
                    최근 4개 분기 ~ 향후 등록된 권리일정이 없습니다.
                  </p>
                )}
                {rightsQ.data && rightsQ.data.events.length > 0 && (
                  <div className="rounded-lg border">
                    <table className="w-full table-fixed text-sm">
                      <thead>
                        <tr className="bg-muted text-muted-foreground text-left text-[11px] sm:text-sm">
                          <th className="px-1.5 py-2 font-medium sm:px-3">기준일</th>
                          <th className="px-1.5 py-2 font-medium sm:px-3">권리락일</th>
                          <th className="px-1.5 py-2 font-medium sm:px-3">지급일</th>
                          <th className="px-1.5 py-2 font-medium sm:px-3">권리사유</th>
                          <th className="px-1.5 py-2 font-medium sm:px-3">세부 내역</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {rightsQ.data.events.map((e, i) => (
                          <tr
                            key={i}
                            className={cn(
                              "hover:bg-muted/30 align-top",
                              i % 2 === 1 && "bg-muted/30",
                            )}
                          >
                            <td className="tnum px-1.5 py-2 text-[10px] tabular-nums sm:px-3 sm:text-sm">
                              {e.basDt || "-"}
                            </td>
                            <td className="tnum px-1.5 py-2 text-[10px] sm:px-3 sm:text-sm">
                              {e.exRightsDate ?? "-"}
                            </td>
                            <td className="tnum px-1.5 py-2 text-[10px] sm:px-3 sm:text-sm">
                              {e.payoutDate ?? "-"}
                            </td>
                            <td className="px-1.5 py-2 text-[11px] break-words sm:px-3 sm:text-sm">
                              {e.reason}
                            </td>
                            <td className="px-1.5 py-2 text-[11px] break-words sm:px-3 sm:text-xs">
                              <RightsDetail e={e} market={market} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="text-muted-foreground/80 text-[11px]">
                  {market === "us"
                    ? "출처: Polygon.io(Massive) 배당 이력(선언·권리락·기준·지급일) + yahoo-finance2 분할 · 최근 15개월 ~ 향후"
                    : "출처: 금융위원회_주식권리일정정보 (공공데이터포털) · 익영업일 오전 8시 갱신"}
                </p>
              </TabsContent>
            )}
          </Tabs>
        </>
      )}
    </div>
  );
}

type RightsEvent = {
  basDt: string;
  exRightsDate: string | null;
  payoutDate: string | null;
  reason: string;
  dividendPerShare: number | null;
  dividendYield: number | null;
  filing: { title: string; url: string; date: string } | null;
  note: string | null;
};

/** 권리일정 "세부 내역" 셀/줄 — 배당금·수익률·주석 또는 공시 링크. */
function RightsDetail({ e, market }: { e: RightsEvent; market: MarketId }) {
  if (e.dividendPerShare != null) {
    return (
      <span className="tnum">
        {market === "us"
          ? `주당 $${e.dividendPerShare.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          : `주당 ${e.dividendPerShare.toLocaleString()}원`}
        {e.dividendYield != null && (
          <span className="text-muted-foreground">
            {" "}· 수익률 {e.dividendYield}%{market === "us" ? " (연환산)" : ""}
          </span>
        )}
        {e.note && <span className="text-muted-foreground"> · {e.note}</span>}
      </span>
    );
  }
  if (e.filing) {
    return (
      <a
        href={e.filing.url}
        target="_blank"
        rel="noreferrer"
        className="text-primary underline underline-offset-2"
      >
        {e.filing.title}
      </a>
    );
  }
  return <span className="text-muted-foreground">{e.note ?? "-"}</span>;
}

function Stat({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("border-border rounded-lg border p-3", className)}>
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
