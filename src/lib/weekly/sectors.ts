import "server-only";
import { getYahooFinance } from "@/lib/macro/yf-client";
import type { ReportWeek } from "./week";

/**
 * "주요 섹터 이슈" — 한주간 한국·미국·일본 증시의 주요 섹터 등락 (오너 지시
 * 2026-09-19). 종목이 아니라 섹터 단위로 광의적 시황을 보는 게 목적이라
 * "기업분석은 범위 밖" 원칙과 충돌하지 않는다(오너 확인).
 *
 * 등락률 = **전주 금요일 종가 → 당주 금요일 종가**(`week.baseFriday` →
 * `week.weekEnd`, 스냅샷 표와 같은 구간). 둘 다 휴장이면(오너 지시 실측
 * 예시 — "금주 금요일부터 차주 금요일까지 연휴면 기준점은 금주 목요일,
 * 비교점은 차차주 금요일"):
 *  - **기준점(시작)은 뒤로**: target 이하 중 가장 최근 거래일.
 *  - **비교점(끝)은 앞으로**: target 이상 중 가장 이른 거래일.
 * 이렇게 비대칭으로 해야 극단적으로 긴 연휴에도 두 점이 같은 날로 붕괴하지
 * 않는다(기준점만 뒤로 밀면 연휴 시작 전날로 수렴해 버려 비교 구간이
 * 사라짐).
 *
 * 섹터 후보는 전부 이미 있는 인프라로 구한다(새 API 연동 없음):
 *  - 한국: KRX 정보데이터시스템 OPEN API 의 지수 시세(`idx/kospi_dd_trd`·
 *    `idx/kosdaq_dd_trd`)가 코스피/코스닥 종합지수 외에 "코스피 200 정보
 *    기술"처럼 섹터별 지수도 같은 응답(OutBlock_1)에 함께 준다(실측 확인,
 *    2026-09-19) — 코스피 200 11개 + 코스닥 150 7개.
 *  - 미국: SPDR Select Sector ETF 11개(GICS 11개 업종과 1:1).
 *  - 일본: NEXT FUNDS TOPIX-17 ETF(1617~1633.T) 17개 — 실측으로 티커·
 *    섹터명 전부 확인(2026-09-19).
 *
 * 한국은 KRX(count 기반 fetch, `data-dbg.krx.co.kr`)를 재사용하고, 미국·
 * 일본은 `yahoo-finance2`(개인용 한정, prd.md §4.3와 동일 제약)를 쓴다.
 */

export type SectorMarket = "kr-kospi" | "kr-kosdaq" | "us" | "jp";

export interface SectorReturn {
  market: SectorMarket;
  label: string;
  pct: number;
  startDate: string;
  endDate: string;
}

export interface SectorHighlight extends SectorReturn {
  /** LLM 코멘트 매칭용 안정 키(섹터명이 아니라 순위로 만들어 흔들리지 않음) */
  id: string;
  direction: "up" | "down";
  rank: number;
}

export interface WeeklySectors {
  kospi: { up: SectorHighlight[]; down: SectorHighlight[] };
  kosdaq: { up: SectorHighlight[]; down: SectorHighlight[] };
  us: { up: SectorHighlight[]; down: SectorHighlight[] };
  jp: { up: SectorHighlight[]; down: SectorHighlight[] };
  combined: { up: SectorHighlight[]; down: SectorHighlight[] };
}

interface DatedClose {
  date: string;
  close: number;
}

// ── 한국: KRX 지수 패밀리 ────────────────────────────────────────────
const KRX_IDX_BASE = "https://data-dbg.krx.co.kr/svc/apis/idx";

const KR_KOSPI_SECTOR_NAMES = [
  "커뮤니케이션서비스",
  "건설",
  "중공업",
  "철강/소재",
  "에너지/화학",
  "정보기술",
  "금융",
  "생활소비재",
  "경기소비재",
  "산업재",
  "헬스케어",
];
const KR_KOSDAQ_SECTOR_NAMES = ["정보기술", "헬스케어", "커뮤니케이션서비스", "소재", "산업재", "필수소비재", "자유소비재"];

interface KrSectorCandidate {
  service: "kospi_dd_trd" | "kosdaq_dd_trd";
  indexName: string;
  label: string;
}

const KR_SECTOR_CANDIDATES: KrSectorCandidate[] = [
  ...KR_KOSPI_SECTOR_NAMES.map((s) => ({
    service: "kospi_dd_trd" as const,
    indexName: `코스피 200 ${s}`,
    label: s,
  })),
  ...KR_KOSDAQ_SECTOR_NAMES.map((s) => ({
    service: "kosdaq_dd_trd" as const,
    indexName: `코스닥 150 ${s}`,
    label: s,
  })),
];

// ── 미국: SPDR Select Sector ETF (GICS 11개) ─────────────────────────
const US_SECTOR_CANDIDATES: { ticker: string; label: string }[] = [
  { ticker: "XLK", label: "정보기술" },
  { ticker: "XLF", label: "금융" },
  { ticker: "XLE", label: "에너지" },
  { ticker: "XLV", label: "헬스케어" },
  { ticker: "XLI", label: "산업재" },
  { ticker: "XLY", label: "경기소비재" },
  { ticker: "XLP", label: "필수소비재" },
  { ticker: "XLU", label: "유틸리티" },
  { ticker: "XLB", label: "소재" },
  { ticker: "XLRE", label: "부동산" },
  { ticker: "XLC", label: "커뮤니케이션서비스" },
];

// ── 일본: NEXT FUNDS TOPIX-17 ETF ────────────────────────────────────
const JP_SECTOR_CANDIDATES: { ticker: string; label: string }[] = [
  { ticker: "1617.T", label: "식품" },
  { ticker: "1618.T", label: "에너지·자원" },
  { ticker: "1619.T", label: "건설·자재" },
  { ticker: "1620.T", label: "소재·화학" },
  { ticker: "1621.T", label: "의약품" },
  { ticker: "1622.T", label: "자동차·운송기기" },
  { ticker: "1623.T", label: "철강·비철금속" },
  { ticker: "1624.T", label: "기계" },
  { ticker: "1625.T", label: "전기·정밀기기" },
  { ticker: "1626.T", label: "IT·서비스 등" },
  { ticker: "1627.T", label: "전력·가스" },
  { ticker: "1628.T", label: "운송·물류" },
  { ticker: "1629.T", label: "상사·도소매" },
  { ticker: "1630.T", label: "소매업" },
  { ticker: "1631.T", label: "은행" },
  { ticker: "1632.T", label: "금융(은행 제외)" },
  { ticker: "1633.T", label: "부동산" },
];

function addDaysIso(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** fromIso~toIso(포함) 사이의 평일만 YYYYMMDD 로. 공휴일은 걸러지지 않고
 * 응답이 비어(빈 맵) 자연스럽게 제외된다 — krx.ts businessDaysBack() 과
 * 같은 한계(공휴일 달력 없음, 주말만 스킵). */
function weekdaysYmd(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  const d = new Date(`${fromIso}T00:00:00Z`);
  const end = new Date(`${toIso}T00:00:00Z`);
  let guard = 0;
  while (d <= end && guard++ < 60) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) {
      out.push(
        `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`,
      );
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function fetchKrxIdxDaySnapshot(
  service: "kospi_dd_trd" | "kosdaq_dd_trd",
  basDd: string,
  authKey: string,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const today = todayIso().replace(/-/g, "");
  const isPast = basDd !== today;
  try {
    const res = await fetch(`${KRX_IDX_BASE}/${service}?basDd=${basDd}`, {
      headers: { AUTH_KEY: authKey },
      signal: AbortSignal.timeout(8_000),
      // 과거 영업일은 불변 → 영구 캐시. 당일치만 짧게(krx.ts 와 동일 정책).
      next: { revalidate: isPast ? 60 * 60 * 24 * 30 : 60 * 60 },
    });
    if (!res.ok) return map;
    const j = (await res.json()) as { OutBlock_1?: Record<string, string>[] };
    for (const row of j.OutBlock_1 ?? []) {
      const close = Number(row.CLSPRC_IDX);
      if (row.IDX_NM && Number.isFinite(close) && close > 0) map.set(row.IDX_NM, close);
    }
  } catch {
    // 휴장·오류 — 빈 맵(호출부가 다른 날짜로 보충)
  }
  return map;
}

/** 지정한 날짜 목록(평일)의 KRX 지수 패밀리 응답을 한 번씩만 받아, 후보
 * 섹터명 전부의 시계열을 한 번에 만든다(섹터마다 같은 날짜를 반복 조회
 * 하지 않음 — 후보가 11~18개라 이렇게 안 묶으면 날짜당 요청이 그만큼
 * 배가된다). */
async function fetchKrSeriesByDay(
  service: "kospi_dd_trd" | "kosdaq_dd_trd",
  indexNames: string[],
  dates: string[],
  authKey: string,
): Promise<Map<string, DatedClose[]>> {
  const out = new Map<string, DatedClose[]>(indexNames.map((n) => [n, []]));
  let cursor = 0;
  const workers = Array.from({ length: 6 }, async () => {
    while (cursor < dates.length) {
      const basDd = dates[cursor++];
      const snap = await fetchKrxIdxDaySnapshot(service, basDd, authKey);
      if (snap.size === 0) continue;
      const iso = `${basDd.slice(0, 4)}-${basDd.slice(4, 6)}-${basDd.slice(6, 8)}`;
      for (const name of indexNames) {
        const close = snap.get(name);
        if (close != null) out.get(name)!.push({ date: iso, close });
      }
    }
  });
  await Promise.all(workers);
  for (const arr of out.values()) arr.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/** target 이하 중 가장 최근(시작점 — 연휴면 그 전 거래일로). */
function resolveBackward(series: DatedClose[], target: string): DatedClose | null {
  let best: DatedClose | null = null;
  for (const p of series) {
    if (p.date <= target) best = p;
    else break;
  }
  return best;
}

/** target 이상 중 가장 이른(끝점 — 연휴면 재개 후 첫 거래일로). 없으면 null
 * (연휴 케이스는 이걸로 처리하되, 데이터가 아직 안 들어온 경우의 폴백은
 * 호출부가 resolveBackward 로 대신한다 — 아래 computeReturn 참고). */
function resolveForward(series: DatedClose[], target: string): DatedClose | null {
  for (const p of series) {
    if (p.date >= target) return p;
  }
  return null;
}

function computeReturn(
  market: SectorMarket,
  label: string,
  series: DatedClose[],
  week: ReportWeek,
): SectorReturn | null {
  const start = resolveBackward(series, week.baseFriday);
  // 끝점은 "target 이상 중 가장 이른 날"을 우선(연휴로 밀린 재개일을 잡기
  // 위해)으로 찾되, 그게 없으면(아직 시장이 재개 전이거나 — 더 흔하게는 —
  // 소스가 최신 거래일 데이터를 아직 다 못 받은 경우, 실측 확인 2026-09-19:
  // 미국 장 마감 직후엔 Yahoo 가 그날 종가를 일부 티커에서만 내려줌, 일본은
  // 장이 훨씬 일찍 끝나 안정적) "target 이하 중 가장 최근 날"로 물러선다 —
  // 아예 없는 것보다 조금 묵은 값이라도 있는 게 낫다(실제 사용된 날짜는
  // endDate 로 그대로 노출되니 화면에서 확인 가능, render.ts 참고).
  const end = resolveForward(series, week.weekEnd) ?? resolveBackward(series, week.weekEnd);
  if (!start || !end || end.date <= start.date || start.close <= 0) return null;
  const pct = ((end.close - start.close) / start.close) * 100;
  return { market, label, pct, startDate: start.date, endDate: end.date };
}

async function fetchKrSectorReturns(week: ReportWeek): Promise<SectorReturn[]> {
  const authKey = process.env.KRX_API_KEY;
  if (!authKey) return [];
  const fromIso = addDaysIso(week.baseFriday, -10);
  const toIso = todayIso();
  const dates = weekdaysYmd(fromIso, toIso);

  const kospiNames = KR_SECTOR_CANDIDATES.filter((c) => c.service === "kospi_dd_trd").map((c) => c.indexName);
  const kosdaqNames = KR_SECTOR_CANDIDATES.filter((c) => c.service === "kosdaq_dd_trd").map((c) => c.indexName);
  const [kospiSeries, kosdaqSeries] = await Promise.all([
    fetchKrSeriesByDay("kospi_dd_trd", kospiNames, dates, authKey),
    fetchKrSeriesByDay("kosdaq_dd_trd", kosdaqNames, dates, authKey),
  ]);
  const seriesByName = new Map([...kospiSeries, ...kosdaqSeries]);

  const out: SectorReturn[] = [];
  for (const c of KR_SECTOR_CANDIDATES) {
    const series = seriesByName.get(c.indexName) ?? [];
    const market: SectorMarket = c.service === "kospi_dd_trd" ? "kr-kospi" : "kr-kosdaq";
    const r = computeReturn(market, c.label, series, week);
    if (r) out.push(r);
  }
  return out;
}

function isoDate(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toISOString().slice(0, 10);
}

async function fetchYahooSeries(ticker: string, fromIso: string, toIso: string): Promise<DatedClose[]> {
  try {
    const res = await getYahooFinance().chart(ticker, { period1: fromIso, period2: toIso, interval: "1d" });
    return res.quotes
      .filter((q): q is typeof q & { close: number } => q.close != null)
      .map((q) => ({ date: isoDate(q.date), close: q.close }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch (err) {
    console.warn(`[weekly/sectors] Yahoo 조회 실패 — ${ticker}:`, err instanceof Error ? err.message : err);
    return [];
  }
}

async function fetchYahooSectorReturns(
  market: SectorMarket,
  candidates: { ticker: string; label: string }[],
  week: ReportWeek,
): Promise<SectorReturn[]> {
  const fromIso = addDaysIso(week.baseFriday, -10);
  // yahoo-finance2 의 period2 는 그 날짜 자정(UTC) **미만**만 포함하는
  // 배타적 상한이다(실측 확인, 2026-09-19 — XLK를 period2="오늘"로 조회하면
  // 정규장 시간(13:30Z 등)에 찍힌 "오늘" 봉이 빠짐). +2일 버퍼를 둬서
  // 오늘·어제 봉이 안전하게 포함되게 한다 — 미래 데이터가 없으니 버퍼를
  // 넉넉히 잡아도 결과에는 영향 없다.
  const toIso = addDaysIso(todayIso(), 2);
  const results = await Promise.all(
    candidates.map(async (c) => {
      const series = await fetchYahooSeries(c.ticker, fromIso, toIso);
      return computeReturn(market, c.label, series, week);
    }),
  );
  return results.filter((r): r is SectorReturn => r != null);
}

/**
 * 상승 상위 2 + 하락 상위 2. **하락은 하락률이 큰 쪽이 표에서 맨 아래로
 * 가도록**(오너 지시 2026-09-19) 정렬 순서를 그대로 둔다 — `slice(-2)`
 * 결과가 이미 [덜 빠진 것, 가장 많이 빠진 것] 순서라 추가로 뒤집지 않는다
 * (전에는 `.reverse()`로 가장 많이 빠진 걸 맨 위로 올렸었음).
 */
function pickTop(returns: SectorReturn[], market: SectorMarket, prefix: string): { up: SectorHighlight[]; down: SectorHighlight[] } {
  const sorted = [...returns].sort((a, b) => b.pct - a.pct);
  const up = sorted
    .slice(0, 2)
    .filter((r) => r.pct > 0)
    .map((r, i) => ({ ...r, market, id: `${prefix}-up-${i + 1}`, direction: "up" as const, rank: i + 1 }));
  const down = sorted
    .slice(-2)
    .filter((r) => r.pct < 0)
    .map((r, i) => ({ ...r, market, id: `${prefix}-down-${i + 1}`, direction: "down" as const, rank: i + 1 }));
  return { up, down };
}

const MARKET_LABEL: Record<SectorMarket, string> = {
  "kr-kospi": "코스피",
  "kr-kosdaq": "코스닥",
  us: "미국",
  jp: "일본",
};

export async function buildWeeklySectors(week: ReportWeek): Promise<WeeklySectors> {
  const [kr, us, jp] = await Promise.all([
    fetchKrSectorReturns(week).catch(() => [] as SectorReturn[]),
    fetchYahooSectorReturns("us", US_SECTOR_CANDIDATES, week).catch(() => [] as SectorReturn[]),
    fetchYahooSectorReturns("jp", JP_SECTOR_CANDIDATES, week).catch(() => [] as SectorReturn[]),
  ]);

  const kospi = kr.filter((r) => r.market === "kr-kospi");
  const kosdaq = kr.filter((r) => r.market === "kr-kosdaq");
  const all = [...kr, ...us, ...jp];

  return {
    kospi: pickTop(kospi, "kr-kospi", "kospi"),
    kosdaq: pickTop(kosdaq, "kr-kosdaq", "kosdaq"),
    us: pickTop(us, "us", "us"),
    jp: pickTop(jp, "jp", "jp"),
    combined: pickTopCombined(all),
  };
}

/** 통합 랭킹도 하락은 같은 규칙(많이 빠진 게 맨 아래)으로 둔다. */
function pickTopCombined(all: SectorReturn[]): { up: SectorHighlight[]; down: SectorHighlight[] } {
  const sorted = [...all].sort((a, b) => b.pct - a.pct);
  const withMarketLabel = (r: SectorReturn) => `${MARKET_LABEL[r.market]} ${r.label}`;
  const up = sorted
    .slice(0, 2)
    .filter((r) => r.pct > 0)
    .map((r, i) => ({
      ...r,
      label: withMarketLabel(r),
      id: `combined-up-${i + 1}`,
      direction: "up" as const,
      rank: i + 1,
    }));
  const down = sorted
    .slice(-2)
    .filter((r) => r.pct < 0)
    .map((r, i) => ({
      ...r,
      label: withMarketLabel(r),
      id: `combined-down-${i + 1}`,
      direction: "down" as const,
      rank: i + 1,
    }));
  return { up, down };
}
