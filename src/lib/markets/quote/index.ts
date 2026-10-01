/**
 * L2 EOD 시세 오케스트레이터 (prd.md §4.1)
 * 한국: KRX(키 있으면, 마지막 거래일치가 비어 있으면 Yahoo→Stooq로 그 날만 보강) → Yahoo → Stooq
 * 미국·일본: Yahoo(개인용) → Stooq
 *
 * Yahoo 1순위(오너 결정 2026-09-24). Stooq 는 2026-09 부터 연결 자체가 안 돼(TCP 연결 시간
 * 초과 — 이 PC·외부 fetch 모두) 시세마다 약 11초를 기다린 뒤 Yahoo 로 넘어갔고, 개요의
 * 시세 제한시간(12초)을 넘겨 멀티플이 비는 원인이었다. 화면 값은 이미 Yahoo 값이었다.
 * Stooq 는 마지막 폴백으로만 남긴다(stooq.ts 차단기로 먹통이면 즉시 건너뜀).
 */

import { MARKET_CURRENCY, type EodQuote, type MarketId, type QuoteBar, type YahooSplit } from "../types";
import { fetchStooqEod } from "./stooq";
import { fetchYahooEod, fetchYahooEodWithSplits } from "./yahoo";
import { fetchKrxEod, hasKrxKey, type KrxQuoteResult } from "./krx";

interface BuildExtra {
  sharesOutstanding?: number | null;
  marketCap?: number | null;
  splits?: YahooSplit[];
}

function buildQuote(
  market: MarketId,
  symbol: string,
  bars: QuoteBar[],
  source: string,
  extra: BuildExtra = {},
): EodQuote {
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));
  const last = sorted.at(-1) ?? null;
  const prev = sorted.at(-2) ?? null;
  const change =
    last?.close != null && prev?.close != null ? last.close - prev.close : null;
  const changePct =
    change != null && prev?.close ? (change / prev.close) * 100 : null;
  return {
    symbol,
    market,
    currency: MARKET_CURRENCY[market],
    last: last?.close ?? null,
    lastDate: last?.date ?? null,
    change,
    changePct,
    bars: sorted,
    source,
    sharesOutstanding: extra.sharesOutstanding ?? null,
    marketCap: extra.marketCap ?? null,
    ...(extra.splits ? { splits: extra.splits } : {}),
  };
}

export async function getEodQuote(
  market: MarketId,
  symbol: string,
  opts: { from?: string; to?: string; yahooOverride?: string | null } = {},
): Promise<EodQuote> {
  if (market === "kr" && hasKrxKey()) {
    try {
      const krx = await fetchKrxEod(symbol);
      if (krx.bars.length > 0) return await buildKrQuoteWithLatestFill(market, symbol, krx, opts);
    } catch {
      // KRX 실패 → 폴백
    }
  }

  let yahooErr: unknown;
  try {
    const { bars, splits } = await fetchYahooEodWithSplits(market, symbol, opts);
    if (bars.length > 0) {
      // 미국: 장 마감 전 오늘 봉(진행 중)은 계산용 봉에서 빼고 표시용 live 로만(오너 결정 2026-10-02 (나))
      if (market === "us" && !opts.to) {
        const lastBar = bars.at(-1)!;
        if (isUsSessionInProgress(lastBar.date) && bars.length >= 2 && lastBar.close != null) {
          const done = bars.slice(0, -1);
          const q = buildQuote(market, symbol, done, "Yahoo Finance", { splits });
          const prevClose = q.last;
          return {
            ...q,
            live: {
              price: lastBar.close,
              date: lastBar.date,
              change: prevClose != null ? lastBar.close - prevClose : null,
              changePct: prevClose ? ((lastBar.close - prevClose) / prevClose) * 100 : null,
            },
          };
        }
      }
      return buildQuote(market, symbol, bars, "Yahoo Finance", { splits });
    }
  } catch (e) {
    yahooErr = e;
  }
  try {
    const bars = await fetchStooqEod(market, symbol, opts);
    if (bars.length > 0) return buildQuote(market, symbol, bars, "Stooq");
  } catch {
    // Stooq 도 실패 — Yahoo 오류를 올린다
  }
  throw yahooErr ?? new Error(`시세 없음: ${market}:${symbol}`);
}

/**
 * 뉴욕 장이 그 날짜에 아직 진행 중인지(정규장 마감 16:00 ET + 15분 여유 전). 날짜가 뉴욕 오늘이 아니면(과거 봉) false.
 * 공휴일 달력은 없다 — 휴장일엔 야후가 그날 봉을 만들지 않으므로 영향 없음
 */
function isUsSessionInProgress(barDate: string, now: Date = new Date()): boolean {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  const today = `${p.year}-${p.month}-${p.day}`;
  if (barDate !== today) return false;
  const hh = p.hour === "24" ? 0 : Number(p.hour), mm = Number(p.minute);
  return hh * 60 + mm < 16 * 60 + 15;
}

/** KST 기준 현재 시각의 연/월/일/시/분/요일(0=일 ~ 6=토). 서버 실행 TZ와 무관하게 항상 KST로 계산. */
function kstParts(d: Date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(p.year),
    m: Number(p.month),
    day: Number(p.day),
    // 자정을 "24"로 주는 로케일이 있어 보정
    hour: p.hour === "24" ? 0 : Number(p.hour),
    weekday: weekdayMap[p.weekday] ?? 0,
  };
}

/**
 * KRX 는 공식 API가 T+1(다음 영업일 게시)이라, 조회 시점에 "가장 최근에 끝난
 * 거래일" 종가가 아직 안 올라와 있는 게 정상이다(평일 저녁~다음날 오전, 주말
 * 내내). 이 함수는 그 "가장 최근에 끝난 거래일" 날짜를 KST 기준으로 근사한다
 * — 장마감(15:30) + 30분 여유를 넘겼으면 오늘, 아니면 그 전 영업일로 거슬러
 * 올라간다. 공휴일 달력은 없어 주말만 건너뛴다(설·추석 등 평일 휴장은 감안 못함
 * — krx.ts 의 businessDaysBack() 과 같은 한계).
 */
function mostRecentCompletedKrSessionDate(now: Date = new Date()): string {
  const p = kstParts(now);
  const todayIsBizDay = p.weekday >= 1 && p.weekday <= 5;
  const sessionClosedToday = todayIsBizDay && p.hour >= 16;
  const d = new Date(Date.UTC(p.y, p.m - 1, p.day));
  if (!sessionClosedToday) d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Yahoo → Stooq 순으로 시도해 종가 바(bar)를 가져온다. 둘 다 실패하면 null. */
async function fetchSupplementBars(
  market: MarketId,
  symbol: string,
  opts: { from?: string; to?: string; yahooOverride?: string | null },
): Promise<{ bars: QuoteBar[]; source: string } | null> {
  try {
    const bars = await fetchYahooEod(market, symbol, opts);
    if (bars.length > 0) return { bars, source: "Yahoo Finance" };
  } catch {
    // 다음 소스로
  }
  try {
    const bars = await fetchStooqEod(market, symbol, opts);
    if (bars.length > 0) return { bars, source: "Stooq" };
  } catch {
    // 보강 실패 — KRX 값만 쓴다
  }
  return null;
}

/**
 * KRX 응답으로 시세를 만들되, 마지막 바가 가장 최근 완료된 거래일보다
 * 오래됐으면(T+1 특성상 평상시에도 흔함) Stooq/Yahoo 로 그 사이 날짜만
 * 보강한다. 상장주식수는 항상 KRX(공식) 값을 쓰고, 시총은 보강된 종가가
 * 있으면 그 종가 × KRX 상장주식수로 다시 계산한다.
 */
async function buildKrQuoteWithLatestFill(
  market: MarketId,
  symbol: string,
  krx: KrxQuoteResult,
  opts: { from?: string; to?: string; yahooOverride?: string | null },
): Promise<EodQuote> {
  const sortedKrx = [...krx.bars].sort((a, b) => a.date.localeCompare(b.date));
  const krxLastDate = sortedKrx.at(-1)?.date ?? null;
  const expected = mostRecentCompletedKrSessionDate();

  if (!krxLastDate || krxLastDate >= expected) {
    return buildQuote(market, symbol, sortedKrx, "KRX 정보데이터시스템", {
      sharesOutstanding: krx.listedShares,
      marketCap: krx.marketCap,
    });
  }

  const supplement = await fetchSupplementBars(market, symbol, opts);
  const extra = (supplement?.bars ?? []).filter((b) => b.date > krxLastDate && b.date <= expected);
  if (extra.length === 0) {
    return buildQuote(market, symbol, sortedKrx, "KRX 정보데이터시스템", {
      sharesOutstanding: krx.listedShares,
      marketCap: krx.marketCap,
    });
  }

  const merged = [...sortedKrx, ...extra].sort((a, b) => a.date.localeCompare(b.date));
  const newLast = merged.at(-1)?.close ?? null;
  const marketCap =
    newLast != null && krx.listedShares != null ? newLast * krx.listedShares : krx.marketCap;
  return buildQuote(
    market,
    symbol,
    merged,
    `KRX 정보데이터시스템 + ${supplement!.source} (최신 종가 보강)`,
    { sharesOutstanding: krx.listedShares, marketCap },
  );
}
