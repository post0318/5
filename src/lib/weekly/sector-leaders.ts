import "server-only";
import { getYahooFinance } from "@/lib/macro/yf-client";
import type { SectorHighlight, WeeklySectors } from "./sectors";

/**
 * 섹터별 주도 종목 — "섹터가 몇 % 움직였다"까지만 있으면 그 주에 실제로 무슨
 * 일이 있었는지 읽는 사람이 감을 못 잡는다(오너 지시 2026-09-22 — "섹터별
 * 주도 종목은 초기 버전에서 검토했던거다보니 필요하다", "숫자의 구체성").
 * 섹터 등락률 옆에 그 방향을 실제로 끌고 간 종목 2개를 이름·등락률과 함께
 * 붙인다.
 *
 * 구성종목을 어디서 얻느냐가 시장마다 다르다 — 실측으로 확인한 결과:
 *  - **미국·일본·유럽**: 섹터를 대표하는 ETF 를 이미 쓰고 있으므로
 *    `quoteSummary(topHoldings)` 로 상위 보유 종목을 그대로 받는다
 *    (XLK → NVDA 14.4%, AAPL 12.5% … 확인).
 *  - **한국**: KRX OPEN API 의 전종목 일별매매에는 업종 필드가 아예 없고
 *    (`SECT_TP_NM` 은 빈 문자열), 국내 섹터 ETF 는 Yahoo 가 보유종목을
 *    0건으로 준다(091160/102780/091170 실측). 그래서 **종목별 섹터를
 *    Yahoo `assetProfile` 로 한 번 조회해 DB 에 캐시**해 두고, 주간 등락률은
 *    KRX 전종목 시세 2개 날짜로 계산한다.
 *
 * 한국 쪽 섹터 매칭은 근사다 — Yahoo 의 11개 분류를 KRX 의 코스피200/
 * 코스닥150 섹터명에 맞춰야 하는데 일대일이 아니다(예: KRX 는 "건설"과
 * "중공업"을 따로 두지만 Yahoo 는 둘 다 Industrials). 업종(industry)
 * 문자열이 더 잘게 나뉘어 있어 건설·중공업처럼 갈라지는 것만 industry 로
 * 먼저 판정하고 나머지는 sector 로 떨어뜨린다. 완전하지 않다.
 */

export interface SectorLeader {
  /** 표시용 종목명 */
  name: string;
  /** 주간 등락률(%) — 섹터와 같은 구간 */
  pct: number;
}

/** 섹터 하나에 붙일 주도 종목 수 */
const LEADERS_PER_SECTOR = 2;
/** ETF 상위 보유 중 몇 개까지 등락률을 조회할지 — 많을수록 정확하지만 느리다 */
const HOLDINGS_TO_CHECK = 6;

// ── 공통: 주간 등락률 ────────────────────────────────────────────────

interface Bar {
  date: string;
  close: number;
}

/** snapshot.ts 와 같은 보정 — 환율·일부 지수 봉이 전일 23:00Z 로 찍혀 날짜가
 * 하루 밀리는 문제. */
function barDate(d: Date | string | number): string {
  const t = new Date(d);
  const shifted = t.getUTCHours() >= 20 ? new Date(t.getTime() + 24 * 3600_000) : t;
  return shifted.toISOString().slice(0, 10);
}

function lastOnOrBefore(bars: Bar[], ymd: string): Bar | null {
  let found: Bar | null = null;
  for (const b of bars) {
    if (b.date <= ymd) found = b;
    else break;
  }
  return found;
}

/** 섹터와 **같은 구간**으로 종목 등락률을 낸다 — 섹터는 -3% 인데 종목은 다른
 * 기간으로 재서 +2% 가 나오면 표가 서로 모순돼 보인다. */
async function weeklyPct(symbol: string, startDate: string, endDate: string): Promise<number | null> {
  const yf = getYahooFinance();
  try {
    const period1 = new Date(Date.parse(startDate) - 12 * 86_400_000);
    const r = await yf.chart(symbol, { period1, interval: "1d" });
    const bars: Bar[] = r.quotes
      .filter((q) => q.close != null)
      .map((q) => ({ date: barDate(q.date), close: Number(q.close) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const base = lastOnOrBefore(bars, startDate);
    const last = lastOnOrBefore(bars, endDate);
    if (!base || !last || base.close === 0) return null;
    return ((last.close - base.close) / base.close) * 100;
  } catch {
    return null;
  }
}

// ── 미국·일본·유럽: ETF 상위 보유 종목 ───────────────────────────────

interface Holding {
  symbol: string;
  name: string;
}

/** 섹터 라벨 → ETF 티커. sectors.ts 의 후보 표와 같은 라벨을 쓴다. */
type TickerResolver = (market: SectorHighlight["market"], label: string) => string | null;

async function topHoldings(etf: string): Promise<Holding[]> {
  const yf = getYahooFinance();
  try {
    const r = (await yf.quoteSummary(etf, { modules: ["topHoldings"] })) as {
      topHoldings?: { holdings?: { symbol?: string; holdingName?: string }[] };
    };
    return (r.topHoldings?.holdings ?? [])
      .filter((h) => h.symbol)
      .slice(0, HOLDINGS_TO_CHECK)
      .map((h) => ({ symbol: String(h.symbol), name: h.holdingName ?? String(h.symbol) }));
  } catch {
    return [];
  }
}

async function etfLeaders(etf: string, s: SectorHighlight): Promise<SectorLeader[]> {
  const holdings = await topHoldings(etf);
  if (holdings.length === 0) return [];
  const scored: SectorLeader[] = [];
  for (const h of holdings) {
    const pct = await weeklyPct(h.symbol, s.startDate, s.endDate);
    if (pct != null) scored.push({ name: h.name, pct });
  }
  return pickLeaders(scored, s.direction);
}

/** 섹터가 오른 주에는 많이 오른 종목을, 내린 주에는 많이 내린 종목을 뽑는다 —
 * 섹터를 끌고 간 쪽이 무엇인지 보여주는 게 목적이라 방향을 맞춰야 한다. */
function pickLeaders(rows: SectorLeader[], direction: "up" | "down"): SectorLeader[] {
  const sorted = [...rows].sort((a, b) => (direction === "up" ? b.pct - a.pct : a.pct - b.pct));
  return sorted.slice(0, LEADERS_PER_SECTOR);
}

// ── 한국: 종목별 섹터 캐시 + KRX 전종목 시세 ─────────────────────────

/**
 * Yahoo 분류 → KRX 코스피200/코스닥150 섹터명. 일대일이 아니라서 갈라지는
 * 것들(건설·중공업)은 industry 문자열로 먼저 걸러낸다.
 */
const INDUSTRY_TO_LABEL: { match: RegExp; label: string }[] = [
  { match: /Engineering & Construction|Building Products|Residential Construction/i, label: "건설" },
  { match: /Shipbuilding|Aerospace & Defense|Specialty Industrial Machinery|Farm & Heavy/i, label: "중공업" },
];

const SECTOR_TO_LABELS: Record<string, string[]> = {
  Technology: ["정보기술"],
  "Financial Services": ["금융"],
  Healthcare: ["헬스케어"],
  "Communication Services": ["커뮤니케이션서비스"],
  "Consumer Cyclical": ["경기소비재", "자유소비재"],
  "Consumer Defensive": ["생활소비재", "필수소비재"],
  Industrials: ["산업재"],
  "Basic Materials": ["철강/소재", "소재", "에너지/화학"],
  Energy: ["에너지/화학"],
};

export interface KrStockSector {
  /** 6자리 종목코드 */
  code: string;
  name: string;
  /** Yahoo assetProfile 의 sector/industry 원문 */
  sector: string | null;
  industry: string | null;
}

/** 종목이 이 섹터 라벨에 속하는가 */
function matchesLabel(s: KrStockSector, label: string): boolean {
  for (const rule of INDUSTRY_TO_LABEL) {
    if (s.industry && rule.match.test(s.industry)) return rule.label === label;
  }
  const labels = s.sector ? (SECTOR_TO_LABELS[s.sector] ?? []) : [];
  return labels.includes(label);
}

/**
 * 한국 섹터의 주도 종목. `stocks` 는 호출부가 "시총 상위 N개 + 주간 등락률 +
 * 캐시된 섹터"를 이미 채워 넘긴다(여기서 다시 조회하지 않는다 — 섹터 4개마다
 * 전종목을 다시 부르면 KRX 호출이 폭증한다).
 */
function krLeaders(
  s: SectorHighlight,
  stocks: (KrStockSector & { pct: number | null; market: "KOSPI" | "KOSDAQ" })[],
): SectorLeader[] {
  const want = s.market === "kr-kospi" ? "KOSPI" : "KOSDAQ";
  const rows = stocks
    .filter((x) => x.market === want && x.pct != null && matchesLabel(x, s.label))
    .map((x) => ({ name: x.name, pct: x.pct as number }));
  return pickLeaders(rows, s.direction);
}

// ── 조립 ─────────────────────────────────────────────────────────────

function allHighlights(sectors: WeeklySectors): SectorHighlight[] {
  return [
    ...sectors.kospi.up,
    ...sectors.kospi.down,
    ...sectors.kosdaq.up,
    ...sectors.kosdaq.down,
    ...sectors.us.up,
    ...sectors.us.down,
    ...sectors.jp.up,
    ...sectors.jp.down,
    ...sectors.eu.up,
    ...sectors.eu.down,
  ];
}

/**
 * 하이라이트된 섹터마다 주도 종목을 채운다. 실패한 섹터는 그냥 비워 둔다 —
 * 주도 종목은 부가 정보라 하나가 막혀도 리포트 전체를 실패시키지 않는다.
 */
export async function attachSectorLeaders(
  sectors: WeeklySectors,
  resolveEtf: TickerResolver,
  krStocks: (KrStockSector & { pct: number | null; market: "KOSPI" | "KOSDAQ" })[],
): Promise<Map<string, SectorLeader[]>> {
  const out = new Map<string, SectorLeader[]>();
  for (const s of allHighlights(sectors)) {
    try {
      if (s.market === "kr-kospi" || s.market === "kr-kosdaq") {
        const l = krLeaders(s, krStocks);
        if (l.length > 0) out.set(s.id, l);
      } else {
        const etf = resolveEtf(s.market, s.label);
        if (!etf) continue;
        const l = await etfLeaders(etf, s);
        if (l.length > 0) out.set(s.id, l);
      }
    } catch {
      // 이 섹터만 건너뛴다
    }
  }
  return out;
}

// ── 한국 종목 목록 만들기 ────────────────────────────────────────────

/** 섹터 주도 종목 후보로 볼 시총 상위 종목 수(시장별) — 너무 넓히면 섹터
 * 조회(assetProfile) 호출만 늘고, 주도 종목으로 언급할 만한 종목도 아니다. */
const KR_TOP_BY_MARKET = { KOSPI: 150, KOSDAQ: 80 };
/** 한 번 실행에서 새로 조회할 섹터 최대 건수 — 첫 실행에 230건을 한꺼번에
 * 물면 오래 걸려서 몇 주에 걸쳐 나눠 채운다(캐시는 계속 쌓인다). */
const KR_SECTOR_LOOKUP_BUDGET = 60;

export interface KrStockRow extends KrStockSector {
  pct: number | null;
  market: "KOSPI" | "KOSDAQ";
}

function yyyymmdd(ymd: string): string {
  return ymd.replace(/-/g, "");
}

/**
 * 섹터와 같은 구간의 국내 종목 주간 등락률 + 섹터. KRX 전종목 시세를 시작·끝
 * 두 날짜만 부르고(주간이라 두 번이면 충분), 시총 상위만 남긴 뒤 섹터를
 * 캐시에서 채운다. 캐시에 없는 종목은 예산만큼만 Yahoo 에 물어 채워 둔다.
 */
export async function buildKrStocks(startDate: string, endDate: string): Promise<KrStockRow[]> {
  const { fetchAllStocks } = await import("@/lib/macro/kr/krx");
  const [base, last] = await Promise.all([
    fetchAllStocks(yyyymmdd(startDate)),
    fetchAllStocks(yyyymmdd(endDate)),
  ]);
  const baseByCode = new Map(base.map((r) => [r.code, r]));

  const rows = last
    // 우선주는 뺀다 — 보통주와 같은 회사라 "주도 종목"에 둘 다 올라오면
    // 중복이다(실측: 시총 상위 20에 삼성전자와 삼성전자우가 같이 잡힘).
    // 국내 보통주 종목코드는 끝자리가 0, 우선주는 5/7/9 등이다.
    .filter((r) => r.code && r.code.endsWith("0") && r.close != null && r.mktcap != null)
    .map((r) => {
      const b = baseByCode.get(r.code);
      const pct =
        b?.close != null && b.close !== 0 && r.close != null
          ? ((r.close - b.close) / b.close) * 100
          : null;
      return { code: r.code, name: r.name, market: r.market, mktcap: r.mktcap ?? 0, pct };
    });

  // 시장별 시총 상위만 남긴다
  const picked: typeof rows = [];
  for (const m of ["KOSPI", "KOSDAQ"] as const) {
    picked.push(
      ...rows
        .filter((r) => r.market === m)
        .sort((a, b) => b.mktcap - a.mktcap)
        .slice(0, KR_TOP_BY_MARKET[m]),
    );
  }

  const { getKrStockSectors, upsertKrStockSectors } = await import("@/lib/db/kr-stock-sectors");
  const cached = await getKrStockSectors(picked.map((r) => r.code)).catch(() => new Map());

  const missing = picked.filter((r) => !cached.has(r.code)).slice(0, KR_SECTOR_LOOKUP_BUDGET);
  const fresh: { _id: string; name: string; sector: string | null; industry: string | null; checkedAt: string }[] = [];
  const yf = getYahooFinance();
  const now = new Date().toISOString();
  for (const r of missing) {
    // 코스닥은 .KQ, 코스피는 .KS
    const suffix = r.market === "KOSPI" ? ".KS" : ".KQ";
    try {
      const p = (await yf.quoteSummary(`${r.code}${suffix}`, { modules: ["assetProfile"] })) as {
        assetProfile?: { sector?: string; industry?: string };
      };
      fresh.push({
        _id: r.code,
        name: r.name,
        sector: p.assetProfile?.sector ?? null,
        industry: p.assetProfile?.industry ?? null,
        checkedAt: now,
      });
    } catch {
      // 조회 실패도 기록해 둔다 — 상장폐지·티커 불일치 종목을 매주 다시 묻지
      // 않기 위해서. 값이 null 이면 섹터 매칭에서 그냥 빠진다.
      fresh.push({ _id: r.code, name: r.name, sector: null, industry: null, checkedAt: now });
    }
  }
  await upsertKrStockSectors(fresh).catch(() => {});
  for (const f of fresh) cached.set(f._id, f);

  return picked.map((r) => {
    const c = cached.get(r.code);
    return {
      code: r.code,
      name: r.name,
      market: r.market,
      pct: r.pct,
      sector: c?.sector ?? null,
      industry: c?.industry ?? null,
    };
  });
}
