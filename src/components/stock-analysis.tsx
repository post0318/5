"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { apiFetch } from "@/lib/query";
import { useAppAuth } from "@/components/auth/app-auth";
import { cn } from "@/lib/utils";
import { formatMoneyWithUnits, formatNumber } from "@/lib/format";
import type { MarketId } from "@/lib/markets/types";
import type { StockOverview } from "@/lib/markets/service";
import { computeTrailingMultiples } from "@/lib/markets/multiples";
import { opUnitsFrom } from "@/lib/markets/op-units";
import type { FinancialStatement, Filing, TtmFlows } from "@/lib/markets/types";
import type { FinancialHighlights } from "@/lib/markets/us/edgar-highlights";
import { FinancialHighlightsTable } from "@/components/financial-highlights";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  SymbolSearch,
  formatSymbolLabel,
  type SymbolHit,
} from "@/components/symbol-search";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ChangePercent, Money, Multiple, NumberText, Percent, stockDirClass } from "@/components/num";
import { StockPptButton } from "@/components/ppt-export";
import { FinancialsTable } from "@/components/financials-table";
import { ConsensusPanel } from "@/components/consensus-panel";
import { BrokerRatings } from "@/components/broker-ratings";
import { StockNews } from "@/components/stock-news";
import { ShinhanResearch } from "@/components/shinhan-research";
import { CompanyBlog } from "@/components/company-blog";
import { PriceChartPanel } from "@/components/price-chart-panel";

/** 시장별로 마지막에 보던 종목을 담아 두는 sessionStorage 키 */
function lastViewedKey(market: MarketId): string {
  return `stock-analysis:last:${market}`;
}

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
  const [pickedSymbol, setSymbol] = useState<string | null>(initialSymbol);
  const [yahooOverride, setYahooOverride] = useState<string | null>(initialYahoo);
  const [name, setName] = useState<string | null>(initialName);
  const [period, setPeriod] = useState<"annual" | "quarter">("annual");
  const [filingScope, setFilingScope] = useState<"core" | "all">("core");
  const [showPriceChart, setShowPriceChart] = useState(false);

  function pick(hit: SymbolHit) {
    setSymbol(hit.symbol);
    setYahooOverride(hit.yahooSymbol ?? null);
    setName(hit.name ?? null);
  }

  /**
   * 보던 종목 기억 (오너 지적 2026-09 — "유니버스 갔다가 종목 가면 전 종목이
   * 지워져 있다"). 통합 뷰에서 넘어올 때만 주소에 종목이 실리고, 검색으로 고른
   * 종목이나 헤더의 「종목분석」 링크(`/{market}/analysis`)에는 쿼리가 없어
   * 화면을 벗어나면 선택이 통째로 날아갔다. 시장별로 마지막 종목을
   * sessionStorage 에 남겨 두고, **주소에 종목이 없을 때만** 복원한다 —
   * 통합 뷰에서 특정 종목을 눌러 들어온 경우를 덮어쓰지 않기 위해서다.
   * 탭(브라우저 탭) 단위 저장이라 새로고침에는 남고 창을 닫으면 사라진다.
   */
  useEffect(() => {
    if (initialSymbol) return;
    let saved: { symbol?: string; yahoo?: string | null; name?: string | null };
    try {
      const raw = sessionStorage.getItem(lastViewedKey(market));
      if (!raw) return;
      saved = JSON.parse(raw);
    } catch {
      return; // 시크릿 모드·저장 차단 등 — 복원만 건너뛴다
    }
    if (!saved.symbol) return;
    // 효과 안에서 곧바로 setState 하면 연쇄 렌더 경고가 난다 — 한 틱 미룬다.
    const id = setTimeout(() => {
      setSymbol(saved.symbol!);
      setYahooOverride(saved.yahoo ?? null);
      setName(saved.name ?? null);
    }, 0);
    return () => clearTimeout(id);
  }, [market, initialSymbol]);

  /**
   * 지원 종목 확인 — 모기지 리츠(NLY·AGNC 등)는 종목분석 대상에서 제외한다
   * (오너 결정 2026-09-23). 판정이 끝나기 전엔 아래 조회를 전부 보류하고(symbol
   * = null), 미지원이면 팝업을 띄운 뒤 선택을 해제한다. 판정 API 가 실패하면
   * 막지 않는다(정상 종목을 막는 쪽이 더 나쁘다).
   */
  const supportQ = useQuery({
    queryKey: ["support", market, pickedSymbol],
    queryFn: () =>
      apiFetch<{ supported: boolean; reason?: string }>(
        `/api/markets/${market}/${encodeURIComponent(pickedSymbol!)}/support`,
      ),
    enabled: market === "us" && Boolean(pickedSymbol),
    staleTime: 1000 * 60 * 60 * 24,
  });
  const symbol =
    !pickedSymbol || market !== "us"
      ? pickedSymbol
      : supportQ.data?.supported || supportQ.isError
        ? pickedSymbol
        : null;
  const unsupported = market === "us" && Boolean(pickedSymbol) && supportQ.data?.supported === false;

  useEffect(() => {
    if (!symbol) return;
    try {
      sessionStorage.setItem(
        lastViewedKey(market),
        JSON.stringify({ symbol, yahoo: yahooOverride, name }),
      );
    } catch {
      // 저장 실패는 조용히 무시 — 기억만 안 될 뿐 화면은 그대로 동작
    }
  }, [market, symbol, yahooOverride, name]);

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

  // 표준화 상세표 (총괄·BS·IS·CF 하위탭) — 미국·한국
  const hasDetail = market === "us" || market === "kr";
  const cfDetailQ = useQuery({
    queryKey: ["financials-cf", market, symbol, period],
    queryFn: () =>
      apiFetch<FinancialStatement>(
        `/api/markets/${market}/${encodeURIComponent(symbol!)}/financials?view=cf&period=${period}`,
      ),
    enabled: Boolean(symbol) && hasDetail,
    retry: false,
  });
  const isDetailQ = useQuery({
    queryKey: ["financials-is", market, symbol, period],
    queryFn: () =>
      apiFetch<FinancialStatement>(
        `/api/markets/${market}/${encodeURIComponent(symbol!)}/financials?view=is&period=${period}`,
      ),
    enabled: Boolean(symbol) && hasDetail,
    retry: false,
  });
  const bsDetailQ = useQuery({
    queryKey: ["financials-bs", market, symbol, period],
    queryFn: () =>
      apiFetch<FinancialStatement>(
        `/api/markets/${market}/${encodeURIComponent(symbol!)}/financials?view=bs&period=${period}`,
      ),
    enabled: Boolean(symbol) && hasDetail,
    retry: false,
  });
  const analysisQ = useQuery({
    queryKey: ["financials-analysis", market, symbol, yahooOverride],
    queryFn: () =>
      apiFetch<FinancialStatement>(
        `/api/markets/${market}/${encodeURIComponent(symbol!)}/financials?view=analysis` +
          (yahooOverride ? `&yahoo=${encodeURIComponent(yahooOverride)}` : ""),
      ),
    enabled: Boolean(symbol) && (market === "us" || market === "kr"),
    retry: false,
  });
  const summaryQ = useQuery({
    queryKey: ["financials-summary", market, symbol, period],
    queryFn: () =>
      apiFetch<FinancialStatement>(
        `/api/markets/${market}/${encodeURIComponent(symbol!)}/financials?view=summary&period=${period}`,
      ),
    enabled: Boolean(symbol) && hasDetail,
    retry: false,
  });

  // 상세 뷰(cf/is/bs/summary)가 아직 로딩 중인데 기본 financials 쿼리가 먼저
  // 끝나버리면, financials-table.tsx가 그 사이 statement(기본 쿼리, 분기여도
  // "FY" 라벨을 쓰는 옛 단일-최근분기 계산)로 잠깐 폴백해 보여준다 — 화면에
  // "분기"가 선택된 채 연간 라벨의 옛 수치가 떴다 사라지는 문제(오너 지적,
  // 2026-09-22 — 하이닉스 스크린샷으로 직접 확인). 상세 쿼리까지 다 끝나야
  // 테이블을 그려서 이 폴백이 화면에 노출되지 않게 한다.
  const financialsPending =
    financials.isLoading ||
    (hasDetail && (cfDetailQ.isLoading || isDetailQ.isLoading || bsDetailQ.isLoading || summaryQ.isLoading));

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
    queryKey: ["filings", market, symbol, market === "kr" ? filingScope : "all"],
    queryFn: () =>
      apiFetch<{ filings: Filing[] }>(
        `/api/markets/${market}/${encodeURIComponent(symbol!)}/filings?limit=${market === "kr" ? 60 : 30}` +
          (market === "kr" && filingScope === "core" ? "&scope=core" : ""),
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
    enabled: Boolean(symbol) && (market === "us" || market === "kr"),
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

  // 유니버스는 계정별이라 로그인한 경우에만 조회한다 — 비로그인에서 부르면
  // 401 이라 「유니버스에 추가」 버튼도 함께 감춘다.
  const auth = useAppAuth();
  const canUseUniverse = auth.isSignedIn && auth.allowed === true;
  const universe = useQuery({
    queryKey: ["universe"],
    queryFn: () =>
      apiFetch<{ items: { market: string; symbol: string }[] }>("/api/universe"),
    enabled: canUseUniverse,
    retry: false,
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
    // 듀얼클래스(V·비자 등)는 발행주식수·EPS 를 EDGAR 에 클래스별로만 태깅 →
    // undimensioned 값이 없다. Yahoo 컨센서스의 주식수·시가총액으로 폴백.
    const cShares = ov.consensus?.sharesOutstanding ?? null;
    const cMktCap = ov.consensus?.marketCap ?? null;
    const quote =
      (ov.quote.sharesOutstanding == null && cShares != null) ||
      (ov.quote.marketCap == null && cMktCap != null)
        ? {
            ...ov.quote,
            sharesOutstanding: ov.quote.sharesOutstanding ?? cShares,
            marketCap: ov.quote.marketCap ?? cMktCap,
          }
        : ov.quote;
    return computeTrailingMultiples({
      market,
      symbol: ov.symbol,
      quote,
      annual: annualForMultiples.data,
      quarterly: null,
      sharesOutstanding: quote.sharesOutstanding ?? null,
      depreciationAmortisation: daTotal,
      // 미국(EDGAR): 최근분기 재무상태표·D&A·EPS(TTM) 스냅샷 → BPS·PBR·PSR·EV 정확도
      ttm: ttmForMultiples,
      // UP-REIT 운영 파트너십 지분(하이라이트·분석 지표와 같은 규칙)
      opUnits: opUnitsFrom(
        Boolean(ttmForMultiples?.snapshot?.isReit),
        ov.consensus?.sharesOutstanding,
        ov.consensus?.impliedSharesOutstanding,
      ),
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
        initialLabel={symbol ? formatSymbolLabel(name, symbol) : ""}
      />

      <Dialog
        open={unsupported}
        onOpenChange={(open) => {
          if (open) return;
          setSymbol(null);
          setName(null);
          setYahooOverride(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>해당 종목은 지원되지 않습니다</DialogTitle>
            <DialogDescription>
              {formatSymbolLabel(name, pickedSymbol ?? "")} — {supportQ.data?.reason}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => {
                setSymbol(null);
                setName(null);
                setYahooOverride(null);
              }}
            >
              확인
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {!pickedSymbol && (
        <p className="text-muted-foreground text-sm">
          종목명 또는 코드로 검색하세요.
        </p>
      )}

      {pickedSymbol && !symbol && supportQ.isLoading && <OverviewSkeleton />}

      {symbol && overview.isLoading && (
        <>
          {name && name !== symbol && (
            <h1 className="text-xl font-semibold">
              {name}{" "}
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
              {canUseUniverse && (
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
              )}
            </div>
          </div>

          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">개요</TabsTrigger>
              <TabsTrigger value="financials">재무제표</TabsTrigger>
              {(market === "us" || market === "kr") && <TabsTrigger value="analysis">재무분석</TabsTrigger>}
              {(market === "kr" || market === "us") && (
                <TabsTrigger value="rights">권리일정</TabsTrigger>
              )}
              <TabsTrigger value="filings">공시</TabsTrigger>
              <TabsTrigger value="news">종목뉴스</TabsTrigger>
              {(market === "kr" || market === "us") && (
                <TabsTrigger value="research">리서치</TabsTrigger>
              )}
            </TabsList>

            {/* 개요 */}
            <TabsContent value="overview" className="space-y-6 pt-4">
              {/* 시세 */}
              {/* 모바일 2열: 1·4 / 2·3 → sm 이상은 원래 순서 */}
              <div
                className={cn(
                  "grid grid-cols-2 gap-4",
                  ov.consensus ? "lg:grid-cols-5" : "lg:grid-cols-4",
                )}
              >
                <Stat
                  label="종가"
                  className="order-1 lg:order-none"
                  onClick={() => setShowPriceChart((v) => !v)}
                >
                  <span className="inline-flex items-baseline gap-1.5">
                    <Money value={ov.quote?.last} currency={ccy} />
                    {ov.quote?.changePct != null && (
                      <span className="text-sm font-normal">
                        (<ChangePercent value={ov.quote.changePct} market={market} />)
                      </span>
                    )}
                  </span>
                  {/* 출처 주석 삭제(오너 지시 2026-09-21) — "KRX 정보데이터시스템
                      + Yahoo Finance (최신 종가 보강)" 같은 내부 폴백 설명이
                      화면에 그대로 노출됐다. 날짜만 남긴다. */}
                  <div className="text-muted-foreground mt-1 text-xs">{ov.quote?.lastDate ?? "-"}</div>
                </Stat>
                <Stat label="시가총액" className="order-3 lg:order-none">
                  <span className="text-base">
                    {formatMoneyWithUnits(multiples?.marketCap ?? ov.quote?.marketCap, market)}
                  </span>
                  {market === "kr" && naverQ.data?.foreign && (
                    <div className="text-muted-foreground mt-1 text-xs">
                      외국인지분율 {formatNumber(naverQ.data.foreign.ratio, 2)}%
                    </div>
                  )}
                  {market === "us" && ov.consensus?.shortPercentSharesOut != null && (
                    <div className="text-muted-foreground mt-1 text-xs">
                      공매도/발행주식 {formatNumber(ov.consensus.shortPercentSharesOut * 100, 2)}%
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
                        {formatNumber(ttmQ.data.beta.change, 3)})
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
                          <span className={stockDirClass(true, market)}>
                            <Money value={hi52} currency={ccy} fallback="-" />
                          </span>
                          {" / "}
                          <span className={stockDirClass(false, market)}>
                            <Money value={lo52} currency={ccy} fallback="-" />
                          </span>
                        </span>
                        <Week52Bar price={ov.quote?.last ?? null} high={hi52} low={lo52} market={market} />
                      </>
                    );
                  })()}
                </Stat>
                {ov.consensus && (
                  <Stat label="목표주가(Yahoo)" className="order-5 lg:order-none">
                    <span className="inline-flex flex-wrap items-baseline gap-1.5">
                      <Money value={ov.consensus.targetMeanPrice} currency={ov.consensus.currency} />
                      {ov.quote?.last != null && ov.consensus.targetMeanPrice != null && (
                        <span className="text-sm font-normal">
                          (
                          <ChangePercent
                            value={
                              ((ov.consensus.targetMeanPrice - ov.quote.last) / ov.quote.last) * 100
                            }
                            market={market}
                          />
                          )
                        </span>
                      )}
                      {ov.consensus.recommendationKey &&
                        (() => {
                          const rec = recommendationKo(ov.consensus.recommendationKey, market);
                          return (
                            <span className={cn("text-sm font-medium", rec.className)}>
                              {rec.label}
                              {ov.consensus.recommendationMean != null &&
                                `(${formatNumber(ov.consensus.recommendationMean, 2)})`}
                            </span>
                          );
                        })()}
                    </span>
                    <div className="text-muted-foreground mt-1 text-xs">
                      목표주가 범위{" "}
                      <Money value={ov.consensus.targetLowPrice} currency={ov.consensus.currency} />
                      {" ~ "}
                      <Money value={ov.consensus.targetHighPrice} currency={ov.consensus.currency} />
                    </div>
                  </Stat>
                )}
              </div>

              {showPriceChart && symbol && (
                <PriceChartPanel
                  market={market}
                  symbol={ov.symbol}
                  yahoo={yahooOverride}
                  currency={ccy}
                  onClose={() => setShowPriceChart(false)}
                />
              )}

              {/* 재무 하이라이트 (EV 브릿지 + 5개년 + LTM + 추정) — 현재 미국만 */}
              {highlightsQ.data?.highlights && (
                <FinancialHighlightsTable data={highlightsQ.data.highlights} />
              )}

              {/* 요약 칩 (FCF 마진 / PEG) — 재무 하이라이트와 컨센서스 사이 */}
              {(market === "us" || market === "kr") &&
                analysisQ.data &&
                (() => {
                  const its = analysisQ.data.sections[0]?.items ?? [];
                  const pick = (name: string) =>
                    its.find((x) => x.accountName === name)?.values?.["현재/LTM"] ??
                    null;
                  const fcfM = pick("FCF 마진 (%)");
                  const peg = pick("PEG (EPS 3Y CAGR)");
                  const ndEbitda = pick("순차입금 / EBITDA");
                  const curRatio = pick("유동비율");
                  const dToE = pick("총차입금 / 자기자본 (%)");
                  const icov =
                    pick("이자보상배율 (EBIT/이자)") ?? pick("EBIT / 현금이자");
                  const altZ = pick("알트만 Z-스코어");
                  if (
                    fcfM == null &&
                    peg == null &&
                    ndEbitda == null &&
                    curRatio == null &&
                    dToE == null &&
                    icov == null &&
                    altZ == null
                  )
                    return null;
                  return (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                      {fcfM != null && (
                        <MetricChip
                          label="FCF 마진"
                          value={`${formatNumber(fcfM, 1)}%`}
                          hint="20%↑ 우수 · 0~20% 보통 · 0%↓ 취약"
                          verdict={fcfM >= 20 ? "우수" : fcfM >= 0 ? "보통" : "취약"}
                          tone={fcfM >= 20 ? "good" : fcfM >= 0 ? "mid" : "bad"}
                        />
                      )}
                      {peg != null && (
                        <MetricChip
                          label="PEG"
                          value={`${formatNumber(peg, 2)}x`}
                          hint="1미만 저평가 · 1~1.5 적정 · 1.5↑ 고평가 (EPS 3년 CAGR 기준)"
                          verdict={peg < 1 ? "저평가" : peg < 1.5 ? "적정" : "고평가"}
                          tone={peg < 1 ? "good" : peg < 1.5 ? "mid" : "bad"}
                        />
                      )}
                      {ndEbitda != null && (
                        <MetricChip
                          label="순차입금/EBITDA"
                          value={`${formatNumber(ndEbitda, 2)}x`}
                          hint="2배 미만 안전 · 2~5배 주의 · 5배↑ 위험"
                          verdict={
                            ndEbitda < 2 ? "안전" : ndEbitda < 5 ? "주의" : "위험"
                          }
                          tone={
                            ndEbitda < 2 ? "good" : ndEbitda < 5 ? "mid" : "bad"
                          }
                        />
                      )}
                      {curRatio != null && (
                        <MetricChip
                          label="유동비율"
                          value={`${formatNumber(curRatio, 2)}x`}
                          hint="2배 이상 우수 · 1~2배 적정 · 1배 미만 취약"
                          verdict={
                            curRatio >= 2 ? "우수" : curRatio >= 1 ? "적정" : "취약"
                          }
                          tone={
                            curRatio >= 2 ? "good" : curRatio >= 1 ? "mid" : "bad"
                          }
                        />
                      )}
                      {dToE != null && (
                        <MetricChip
                          label="총차입금/자기자본"
                          value={`${formatNumber(dToE, 0)}%`}
                          hint="100% 미만 우수 · 100~200% 주의 · 200% 이상 위험 (이자부 차입금 기준, 운용리스 제외)"
                          verdict={
                            dToE < 100 ? "우수" : dToE < 200 ? "주의" : "위험"
                          }
                          tone={dToE < 100 ? "good" : dToE < 200 ? "mid" : "bad"}
                        />
                      )}
                      {icov != null && (
                        <MetricChip
                          label="이자보상배율"
                          value={`${formatNumber(icov, 1)}x`}
                          hint="1배 미만 위험 · 1~2배 주의 · 2~5배 안정 · 5배↑ 우수"
                          verdict={
                            icov < 1
                              ? "위험"
                              : icov < 2
                                ? "주의"
                                : icov < 5
                                  ? "안정"
                                  : "우수"
                          }
                          tone={icov < 1 ? "bad" : icov < 2 ? "mid" : "good"}
                        />
                      )}
                      {altZ != null && (
                        <MetricChip
                          label="알트만 Z"
                          value={formatNumber(altZ, 2)}
                          hint="3.0 이상 안전 · 1.81~2.99 회색지대 · 1.81 미만 위험"
                          verdict={
                            altZ >= 3 ? "안전" : altZ >= 1.81 ? "회색" : "위험"
                          }
                          tone={altZ >= 3 ? "good" : altZ >= 1.81 ? "mid" : "bad"}
                        />
                      )}
                    </div>
                  );
                })()}

              {/* 투자지표 — 미국·한국은 재무 하이라이트의 연도별 표로 대체 */}
              {market !== "us" && market !== "kr" && (
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
                  PER = 최근 연간 공시(EDINET) + 현재가 자체 계산 ·
                  PBR·BPS·PSR·EV/EBITDA·PER(TTM)·추정PER(차기 회계연도)·DPS·DPS(TTM)·배당수익률 =
                  yahoo-finance2 (개인용) — 일본은 무료 분기 공시가 없어 TTM·최근분기 지표는 Yahoo 제공치
                </p>
              </section>
              )}

              <ConsensusPanel market={market} symbol={ov.symbol} yahoo={yahooOverride} />

              {market === "us" && (
                <BrokerRatings market={market} symbol={ov.symbol} yahoo={yahooOverride} />
              )}

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
            </TabsContent>

            {/* 재무제표 */}
            <TabsContent value="financials" className="space-y-4 pt-4">
              {financialsPending && <Skeleton className="h-64 w-full" />}
              {!financialsPending && financials.isError && (
                <ErrorBox message={(financials.error as Error).message} />
              )}
              {!financialsPending && financials.data && financials.data.sections.length === 0 && (
                <p className="text-muted-foreground text-sm">
                  표시할 재무 데이터가 없습니다.
                </p>
              )}
              {!financialsPending && financials.data && financials.data.sections.length > 0 && (
                <FinancialsTable
                  statement={financials.data}
                  detailedCf={hasDetail ? (cfDetailQ.data ?? null) : null}
                  detailedIs={hasDetail ? (isDetailQ.data ?? null) : null}
                  detailedBs={hasDetail ? (bsDetailQ.data ?? null) : null}
                  detailedSummary={hasDetail ? (summaryQ.data ?? null) : null}
                  period={period}
                  onPeriodChange={setPeriod}
                />
              )}
            </TabsContent>

            {/* 분석 (미국·한국) */}
            {(market === "us" || market === "kr") && (
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
                  {market === "kr" && filingScope === "core" && (
                    <p className="text-muted-foreground/80 text-[11px]">
                      정기보고서(사업·반기·분기)·감사보고서·주요사항보고서·실적공시·배당/자기주식·
                      증자/감자·사채발행·대형 공급계약·합병/분할 만.
                    </p>
                  )}
                <ul className="divide-y">
                  {filings.data.filings
                    .filter((f) => {
                      if (filingScope === "all") return true;
                      // 한국은 서버(DART pblntf_ty)에서 이미 주요공시만 조회
                      if (market === "kr") return true;
                      if (market !== "us") return true;
                      return /^(10-[KQ]|8-K|20-F|6-K|DEF ?A?14A|DEFA14A|S-\d|424B|F-\d|40-F|11-K)/i.test(
                        f.type.trim(),
                      );
                    })
                    .map((f) => (
                    <li key={f.id} className="flex items-center gap-3 py-2 text-sm">
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

            {/* 종목뉴스 */}
            <TabsContent value="news" className="pt-4">
              <StockNews market={market} symbol={ov.symbol} />
            </TabsContent>

            {/* 리서치 (한국·미국) */}
            {(market === "kr" || market === "us") && (
              <TabsContent value="research" className="space-y-3 pt-4">
                <ShinhanResearch market={market} symbol={ov.symbol} />
                {market === "us" && <CompanyBlog symbol={ov.symbol} />}
              </TabsContent>
            )}

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
                  <>
                    {/* 모바일: 카드 목록 (가로 스크롤 없이 한 화면) */}
                    <ul className="space-y-2 sm:hidden">
                      {rightsQ.data.events.map((e, i) => (
                        <li key={i} className="rounded-lg border p-3 text-sm">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="font-medium">{e.reason}</span>
                            <span className="tnum text-muted-foreground text-xs whitespace-nowrap">
                              기준 {e.basDt || "-"}
                            </span>
                          </div>
                          <div className="text-muted-foreground tnum mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                            <span>권리락 {e.exRightsDate ?? "-"}</span>
                            <span>지급 {e.payoutDate ?? "-"}</span>
                          </div>
                          <div className="mt-1.5 text-xs leading-snug break-words">
                            <RightsDetail e={e} market={market} />
                          </div>
                        </li>
                      ))}
                    </ul>

                    {/* 데스크톱: 표 */}
                    <div className="hidden overflow-x-auto rounded-lg border sm:block">
                      <table className="w-full min-w-[560px] text-sm">
                        <thead>
                          <tr className="bg-muted text-muted-foreground text-left">
                            <th className="px-3 py-2 font-medium">기준일</th>
                            <th className="px-3 py-2 font-medium">권리락일</th>
                            <th className="px-3 py-2 font-medium">배당금지급일</th>
                            <th className="px-3 py-2 font-medium">권리사유</th>
                            <th className="px-3 py-2 font-medium">세부 내역</th>
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
                              <td className="tnum px-3 py-2 whitespace-nowrap">{e.basDt || "-"}</td>
                              <td className="tnum px-3 py-2 whitespace-nowrap">
                                {e.exRightsDate ?? "-"}
                              </td>
                              <td className="tnum px-3 py-2 whitespace-nowrap">
                                {e.payoutDate ?? "-"}
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap">{e.reason}</td>
                              <td className="px-3 py-2 text-xs">
                                <RightsDetail e={e} market={market} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
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

/** Yahoo recommendationKey → 한글 표기 + 매수/매도 색상. market="kr"이면 상승(매수)=빨강·하락(매도)=파랑으로 반전. */
export function recommendationKo(key: string, market?: MarketId): { label: string; className: string } {
  const k = key.toLowerCase();
  const buy = stockDirClass(true, market);
  const sell = stockDirClass(false, market);
  if (k.includes("strong_buy") || k === "strongbuy") return { label: "강력매수", className: buy };
  if (k.includes("buy")) return { label: "매수", className: buy };
  if (k.includes("strong_sell") || k === "strongsell")
    return { label: "강력매도", className: sell };
  if (k.includes("sell") || k.includes("underperform")) return { label: "매도", className: sell };
  if (k.includes("hold") || k.includes("neutral")) return { label: "중립", className: "text-muted-foreground" };
  return { label: key.replace(/_/g, " "), className: "" };
}

function Stat({
  label,
  children,
  className,
  onClick,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => (e.key === "Enter" || e.key === " ") && onClick() : undefined}
      className={cn(
        "border-border rounded-lg border p-3",
        onClick && "hover:border-primary/50 cursor-pointer transition-colors",
        className,
      )}
    >
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="mt-1 text-lg font-semibold">{children}</div>
    </div>
  );
}

type ChipTone = "good" | "mid" | "bad";
const CHIP_TONE: Record<ChipTone, string> = {
  good: "bg-up/10 text-up border-up/30",
  mid: "border-border bg-muted text-muted-foreground",
  bad: "bg-down/10 text-down border-down/30",
};

function MetricChip({
  label,
  value,
  verdict,
  tone,
  hint,
}: {
  label: string;
  value: string;
  verdict: string;
  tone: ChipTone;
  hint?: string;
}) {
  return (
    <div
      className="border-border flex flex-col gap-1 rounded-lg border px-3 py-2"
      title={hint}
    >
      <span className="text-muted-foreground truncate text-xs font-medium">
        {label}
      </span>
      <div className="flex items-baseline justify-between gap-2">
        <span className="tnum text-sm font-semibold">{value}</span>
        <span
          className={cn(
            "shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
            CHIP_TONE[tone],
          )}
        >
          {verdict}
        </span>
      </div>
    </div>
  );
}

/** 52주 고점=100 기준 현재가 위치를 가로 바로. 고점比 마이너스(고점 미달)=하락색 / 고점 초과=상승색. */
function Week52Bar({
  price,
  high,
  low,
  market,
}: {
  price: number | null;
  high: number | null;
  low: number | null;
  market?: MarketId;
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
        <span className={stockDirClass(true, market)}>{lowPct != null ? `저점比 +${formatNumber(lowPct, 0)}%` : " "}</span>
        <span className={stockDirClass(false, market)}>고점比 −{formatNumber(Math.max(0, 100 - pct), 0)}%</span>
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
