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
  floor_strike?: number;
  last_price_dollars?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
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
      .filter((r): r is { strike: number; p: number } => typeof r.strike === "number" && r.p != null)
      .sort((a, b) => a.strike - b.strike);
    if (rows.length < 2) return null;

    // 누적확률 → 구간확률. 인접 임계값 사이의 확률 질량이 곧 그 목표범위 구간.
    // 유동성 부족으로 누적확률이 단조감소하지 않을 수 있어 음수는 0 으로 막는다.
    const buckets: { label: string; lowEdge: number; prob: number }[] = [];
    const first = rows[0];
    const last = rows[rows.length - 1];
    buckets.push({
      label: `${bp(first.strike)}bp 이하`,
      lowEdge: first.strike - STEP,
      prob: Math.max(0, 1 - first.p),
    });
    for (let i = 1; i < rows.length; i++) {
      const lo = rows[i - 1];
      const hi = rows[i];
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

    // 음수 절단 후 합이 1 에서 벗어나므로 재정규화
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

    const meetingDateTime = next.strike_date!;
    const meetingDate = meetingDateTime.slice(0, 10);
    const month = Number(meetingDate.slice(5, 7));

    return {
      meetingDate,
      meetingDateTime,
      meetingLabel: `${month}월 FOMC`,
      hikeProb: pct(hike),
      holdProb: pct(hold),
      cutProb: pct(cut),
      buckets: buckets.map((b) => ({
        label: b.label,
        prob: pct(b.prob),
        isCurrent: eq(b.lowEdge, CURRENT_FED_RANGE_LOW),
      })),
      asOf: new Date().toISOString(),
      source: "Kalshi",
      deepLink: KALSHI_DEEPLINK,
    };
  } catch {
    return null; // 비공식·경계선 소스 — 실패 시 카드 자체를 생략
  }
}
