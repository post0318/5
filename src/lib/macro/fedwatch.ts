import "server-only";
import { AdapterError } from "@/lib/markets/types";

/**
 * Kalshi — Fed 기준금리 확률 (CME FedWatch 대체)
 *
 * ⚠️ CME FedWatch 자체는 월물별 연방기금금리 선물 데이터(유료)가 있어야 계산되고,
 *    CME·investing.com 의 위젯 페이지는 스크래핑·iframe 임베드가 모두 막혀 있다.
 *    대신 CFTC 규제 예측시장인 Kalshi 의 **무인증 공개 API**(api.elections.kalshi.com)
 *    를 쓴다 — KXFED 시리즈가 FOMC 회의별 "금리 상단이 X% 초과?" 계약을 제공하므로
 *    누적 확률을 구간 확률로 분해하면 FedWatch 와 같은 형태가 나온다.
 *
 *    **ToS 긴장**: Kalshi Data Terms 는 "personal, non-commercial" 사용으로 제한하고
 *    서면 동의 없는 데이터 "공유·게시"를 금지한다. 이 앱의 거시경제 대시보드는
 *    로그인 없이 공개돼 있어 그 조항과 충돌할 소지가 있다. 오너가 위험을 인지한
 *    상태에서 "허가 없이 그냥 진행한다"고 명시 결정(2026-09-19) — 개인용 전제 +
 *    출처 표기 + kalshi.com 딥링크 병행으로 진행한다. 다른 경계선 소스들
 *    (feargreed.ts 등)과 동일 원칙으로, 실패 시 조용히 생략(null 반환, throw 금지).
 */

const BASE = "https://api.elections.kalshi.com/trade-api/v2";
const SERIES = "KXFED";
export const KALSHI_DEEPLINK = "https://kalshi.com/markets/kxfed/fed-funds-rate";

/** 회의별 페이지(오너 제시 URL 2026-09-20 — `.../fed-funds-rate/kxfed-26oct`).
 *  event_ticker `KXFED-26OCT` 를 소문자로 붙이면 그 회의 마켓으로 바로 간다.
 *  시리즈 공통 페이지로 보내면 사용자가 회의를 다시 골라야 했다. */
function eventDeepLink(eventTicker: string): string {
  return `${KALSHI_DEEPLINK}/${eventTicker.toLowerCase()}`;
}

/**
 * 현재 연방기금금리 목표범위의 **하단**(%).
 * 2026-09-16 FOMC 에서 3.75~4.00% 로 결정 → 3.75.
 *
 * **FOMC 결정이 나올 때마다 수동으로 갱신해야 한다.** 이 값이 틀리면 인상/동결/
 * 인하 분류가 통째로 한 칸씩 밀린다. `lib/weekly/comment.ts` 의 FOMC_2026·BOJ_2026
 * 회의 일정 배열과 같은 유지보수 패턴(연 1회 손으로 갱신).
 */
export const CURRENT_FED_RANGE_LOW = 3.75;

/** 연방기금금리 목표범위 폭 (25bp) */
const STEP = 0.25;

interface RawEvent {
  event_ticker?: string;
  strike_date?: string;
  title?: string;
}
interface RawMarket {
  /** 과거 일봉(candlesticks) 조회에 필요 — 예: "KXFED-26OCT-T4.00" */
  ticker?: string;
  floor_strike?: number;
  last_price_dollars?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
}
interface RawCandle {
  end_period_ts?: number;
  price?: { close_dollars?: string; mean_dollars?: string };
}

export interface FedWatch {
  /** 다음 FOMC 결정일 (ISO, YYYY-MM-DD) */
  meetingDate: string;
  /** 다음 FOMC 결정 발표 시각(ISO, UTC) — Kalshi strike_date 원본. 카운트다운용.
   *  실측(2026-09-20): 18:00Z(=오후 2시 EDT), CME/investing 표시 시각과 일치. */
  meetingDateTime: string;
  /** 예: "10월 FOMC" */
  meetingLabel: string;
  /** 0~100 */
  hikeProb: number;
  holdProb: number;
  cutProb: number;
  /** 목표범위 구간별 확률 (금리 낮은 쪽 → 높은 쪽) */
  buckets: { label: string; prob: number; isCurrent: boolean }[];
  asOf: string;
  source: "Kalshi";
  deepLink: string;
}

function num(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** 체결가 우선, 없으면 호가 중간값 — 둘 다 없으면 그 임계값은 버린다. */
function impliedProb(m: RawMarket): number | null {
  const last = num(m.last_price_dollars);
  if (last != null && last > 0) return last;
  const bid = num(m.yes_bid_dollars);
  const ask = num(m.yes_ask_dollars);
  if (bid != null && ask != null) return (bid + ask) / 2;
  return last; // 0 이라도 값이 있으면 사용 (유동성 없는 극단 임계값)
}

const pct = (p: number) => Math.round(p * 1000) / 10;
// CME FedWatch 실제 차트 라벨 스타일(오너 제시 스크린샷, 2026-09-20) —
// "3.75 ~ 4.00%" 대신 "375-400"(bp, 소수점·% 없음)로 표시.
const bp = (v: number) => Math.round(v * 100).toString();

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
    // 개인용 대시보드 — 분 단위 신선도가 필요 없다 (30분)
    next: { revalidate: 30 * 60 },
  });
  if (!res.ok) throw new AdapterError(`Kalshi ${res.status}`, { status: res.status });
  return (await res.json()) as T;
}

/** 예: "2026-10-28" → "10월 FOMC" */
function meetingLabelOf(meetingDate: string): string {
  return `${Number(meetingDate.slice(5, 7))}월 FOMC`;
}

/**
 * 임계값별 누적확률("금리 상단이 X% 초과일 확률") → 목표범위 구간확률 + 인상/
 * 동결/인하 집계. 현재 시세(`getFedWatch`)와 과거 일봉(`getFedWatchHistory`)이
 * 완전히 같은 계산을 쓰도록 공통화했다 — 둘이 어긋나면 전일 대비가 거짓이 된다.
 *
 * 인접 임계값 사이의 확률 질량이 곧 그 목표범위 구간이다. 유동성 부족으로
 * 누적확률이 단조감소하지 않을 수 있어 음수는 0 으로 막고, 절단 후 합이 1 에서
 * 벗어나므로 재정규화한다.
 */
function summarizeRows(rows: { strike: number; p: number }[]): Pick<
  FedWatch,
  "hikeProb" | "holdProb" | "cutProb" | "buckets"
> | null {
  if (rows.length < 2) return null;
  const sorted = [...rows].sort((a, b) => a.strike - b.strike);
  const buckets: { label: string; lowEdge: number; prob: number }[] = [];
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  buckets.push({
    label: `${bp(first.strike)}bp 이하`,
    lowEdge: first.strike - STEP,
    prob: Math.max(0, 1 - first.p),
  });
  for (let i = 1; i < sorted.length; i++) {
    const lo = sorted[i - 1];
    const hi = sorted[i];
    buckets.push({
      label: `${bp(lo.strike)}-${bp(hi.strike)}`,
      lowEdge: lo.strike,
      prob: Math.max(0, lo.p - hi.p),
    });
  }
  buckets.push({
    label: `${bp(last.strike)}bp 초과`,
    lowEdge: last.strike,
    prob: Math.max(0, last.p),
  });

  const total = buckets.reduce((s, b) => s + b.prob, 0);
  if (total <= 0) return null;
  for (const b of buckets) b.prob /= total;

  const eq = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  let hike = 0;
  let hold = 0;
  let cut = 0;
  for (const b of buckets) {
    if (eq(b.lowEdge, CURRENT_FED_RANGE_LOW)) hold += b.prob;
    else if (b.lowEdge > CURRENT_FED_RANGE_LOW) hike += b.prob;
    else cut += b.prob;
  }

  return {
    hikeProb: pct(hike),
    holdProb: pct(hold),
    cutProb: pct(cut),
    buckets: buckets.map((b) => ({
      label: b.label,
      prob: pct(b.prob),
      isCurrent: eq(b.lowEdge, CURRENT_FED_RANGE_LOW),
    })),
  };
}

export async function getFedWatch(): Promise<FedWatch | null> {
  try {
    const { events } = await getJson<{ events?: RawEvent[] }>(
      `${BASE}/events?series_ticker=${SERIES}&status=open`,
    );
    const now = Date.now();
    // 가장 가까운 미래 strike_date = 다음 FOMC 회의
    const next = (events ?? [])
      .filter((e) => e.event_ticker && e.strike_date && Date.parse(e.strike_date) > now)
      .sort((a, b) => Date.parse(a.strike_date!) - Date.parse(b.strike_date!))[0];
    if (!next) return null;

    const { markets } = await getJson<{ markets?: RawMarket[] }>(
      `${BASE}/markets?event_ticker=${encodeURIComponent(next.event_ticker!)}`,
    );

    // floor_strike = "금리 상단이 이 값을 초과?" 임계값(%), 확률은 초과일 확률(누적)
    const rows = (markets ?? [])
      .map((m) => ({ strike: m.floor_strike, p: impliedProb(m) }))
      .filter((r): r is { strike: number; p: number } => typeof r.strike === "number" && r.p != null);
    const summary = summarizeRows(rows);
    if (!summary) return null;

    const meetingDateTime = next.strike_date!;
    const meetingDate = meetingDateTime.slice(0, 10);

    return {
      meetingDate,
      meetingDateTime,
      meetingLabel: meetingLabelOf(meetingDate),
      ...summary,
      asOf: new Date().toISOString(),
      source: "Kalshi",
      deepLink: eventDeepLink(next.event_ticker!),
    };
  } catch {
    return null; // 비공식·경계선 소스 — 실패 시 카드 자체를 생략
  }
}

/** 하루치 과거 스냅샷 — `db/fedwatch.ts` 의 FedWatchDailyDoc 과 같은 모양. */
export interface FedWatchDay {
  /** 미국 동부 영업일 YYYY-MM-DD (일봉 구간이 끝나는 04:00Z = ET 자정) */
  date: string;
  meetingDate: string;
  meetingLabel: string;
  hikeProb: number;
  holdProb: number;
  cutProb: number;
  buckets: { label: string; prob: number; isCurrent: boolean }[];
  asOf: string;
}

/**
 * 과거 일별 확률 재구성 — Kalshi candlesticks(무인증 공개 API)로 임계값별
 * 일봉 종가를 받아 `getFedWatch()` 와 **같은 누적→구간 변환**을 날짜별로 돌린다.
 * 스냅샷을 하루 1회 쌓는 방식만으로는 "전일·전주" 비교가 배포 후 1주일이
 * 지나야 채워져서, 과거분을 한 번에 메우려고 추가했다(오너 지시 2026-09-20).
 *
 * 실측(2026-09-20): 60일 요청 시 59일치가 내려온다.
 *
 * **날짜 주의** — 일봉 구간 종료가 `04:00Z`(미국 동부 자정)라 그 캔들은 **직전
 * ET 영업일**의 종가다. `end_period_ts - 86400` 으로 맞추지 않으면 하루씩 밀린다.
 */
export async function getFedWatchHistory(days = 60): Promise<FedWatchDay[]> {
  try {
    const { events } = await getJson<{ events?: RawEvent[] }>(
      `${BASE}/events?series_ticker=${SERIES}&status=open`,
    );
    const now = Date.now();
    const next = (events ?? [])
      .filter((e) => e.event_ticker && e.strike_date && Date.parse(e.strike_date) > now)
      .sort((a, b) => Date.parse(a.strike_date!) - Date.parse(b.strike_date!))[0];
    if (!next) return [];

    const { markets } = await getJson<{ markets?: RawMarket[] }>(
      `${BASE}/markets?event_ticker=${encodeURIComponent(next.event_ticker!)}`,
    );
    const strikes = (markets ?? [])
      .map((m) => ({ ticker: m.ticker, strike: m.floor_strike }))
      .filter((s): s is { ticker: string; strike: number } => Boolean(s.ticker) && typeof s.strike === "number");
    if (strikes.length < 2) return [];

    const endTs = Math.floor(now / 1000);
    const startTs = endTs - days * 86_400;
    // 날짜 → (임계값 → 종가). 임계값 하나가 실패해도 나머지로 계산은 된다.
    const byDate = new Map<string, { strike: number; p: number }[]>();
    for (const { ticker, strike } of strikes) {
      let candles: RawCandle[] = [];
      try {
        const r = await getJson<{ candlesticks?: RawCandle[] }>(
          `${BASE}/series/${SERIES}/markets/${encodeURIComponent(ticker)}/candlesticks` +
            `?start_ts=${startTs}&end_ts=${endTs}&period_interval=1440`,
        );
        candles = r.candlesticks ?? [];
      } catch {
        continue;
      }
      for (const c of candles) {
        const close = num(c.price?.close_dollars) ?? num(c.price?.mean_dollars);
        if (close == null || !c.end_period_ts) continue;
        const date = new Date((c.end_period_ts - 86_400) * 1000).toISOString().slice(0, 10);
        const list = byDate.get(date) ?? [];
        list.push({ strike, p: close });
        byDate.set(date, list);
      }
    }

    const meetingDate = next.strike_date!.slice(0, 10);
    const label = meetingLabelOf(meetingDate);
    const out: FedWatchDay[] = [];
    for (const [date, rows] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const summary = summarizeRows(rows);
      if (!summary) continue;
      out.push({
        date,
        meetingDate,
        meetingLabel: label,
        ...summary,
        // 그날 ET 자정 종가 기준임을 남긴다(실시간 asOf 와 구분).
        asOf: `${date}T23:59:59.000Z`,
      });
    }
    return out;
  } catch {
    return [];
  }
}
