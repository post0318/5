import "server-only";
import { AdapterError } from "@/lib/markets/types";
import { smaSeriesSkipNulls } from "@/lib/macro/series-utils";

/**
 * CNN Business — Fear & Greed Index (시장 심리 / 위험 지표)
 *
 * ⚠️ 비공식 엔드포인트(production.dataviz.cnn.io) + CNN 소유 지표.
 *    개인용 전제 — 출처 표기 + cnn.com 딥링크 병행. 상업적 사용 시 권한 필요.
 *    깨질 수 있으므로 실패 시 조용히 생략.
 */

const URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
export const CNN_DEEPLINK = "https://www.cnn.com/markets/fear-and-greed";

interface RawFG {
  fear_and_greed?: {
    score: number;
    rating: string;
    timestamp: string;
    previous_close: number;
    previous_1_week: number;
    previous_1_month: number;
    previous_1_year: number;
  };
  fear_and_greed_historical?: { data?: { x: number; y: number; rating?: string }[] };
  [k: string]: unknown;
}

const COMPONENT_LABELS: { key: string; label: string; valueLabel: string }[] = [
  { key: "market_momentum_sp125", label: "시장 모멘텀 (S&P vs 125일선)", valueLabel: "S&P500 125일 이동평균" },
  { key: "stock_price_strength", label: "주가 강도 (신고가/신저가)", valueLabel: "52주 신고가 − 신저가 (순비율)" },
  { key: "stock_price_breadth", label: "주가 폭 (거래량 확산)", valueLabel: "McClellan 거래량 지표" },
  { key: "put_call_options", label: "풋/콜 옵션", valueLabel: "5일 풋/콜 비율" },
  { key: "market_volatility_vix", label: "변동성 (VIX)", valueLabel: "VIX" },
  { key: "safe_haven_demand", label: "안전자산 선호", valueLabel: "주식 − 국채 20일 수익률차 (%p)" },
  { key: "junk_bond_demand", label: "정크본드 수요", valueLabel: "정크본드 − 투자등급 스프레드 (%p)" },
];

export interface FearGreed {
  score: number;
  asOf: string;
  prevClose: number;
  prev1w: number;
  prev1m: number;
  prev1y: number;
  history: { date: string; value: number }[];
  components: {
    key: string;
    label: string;
    valueLabel: string;
    score: number | null;
    /** 원본 지표 추이 (정규화 전 실제 값) */
    history: { date: string; value: number }[];
    /** 보조 시리즈 (예: 모멘텀 차트의 S&P 500 지수) */
    overlay?: { label: string; history: { date: string; value: number }[] };
  }[];
  source: string;
  deepLink: string;
}

export async function getFearGreed(): Promise<FearGreed | null> {
  let raw: RawFG;
  try {
    const res = await fetch(URL, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "application/json",
        referer: "https://www.cnn.com/",
      },
      signal: AbortSignal.timeout(12_000),
      next: { revalidate: 60 * 60 },
    });
    if (!res.ok) throw new AdapterError(`CNN F&G ${res.status}`, { status: res.status });
    raw = (await res.json()) as RawFG;
  } catch {
    return null; // 비공식 엔드포인트 — 실패 시 생략
  }

  const fg = raw.fear_and_greed;
  if (!fg) return null;

  const history = (raw.fear_and_greed_historical?.data ?? [])
    .slice(-180)
    .map((d) => ({ date: new Date(d.x).toISOString().slice(0, 10), value: Math.round(d.y * 100) / 100 }));

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const toSeries = (data?: { x: number; y: number }[]) =>
    (data ?? [])
      .slice(-180)
      .map((d) => ({ date: new Date(d.x).toISOString().slice(0, 10), value: round2(d.y) }));

  const components = COMPONENT_LABELS.map(({ key, label, valueLabel }) => {
    const c = raw[key] as
      | { score?: number; rating?: string; data?: { x: number; y: number }[] }
      | undefined;

    // 모멘텀: sp125(=125일 이동평균) 차트에 실제 S&P 500 지수를 같이 표시
    let overlay: { label: string; history: { date: string; value: number }[] } | undefined;
    if (key === "market_momentum_sp125") {
      const sp = raw["market_momentum_sp500"] as { data?: { x: number; y: number }[] } | undefined;
      if (sp?.data?.length) overlay = { label: "S&P 500", history: toSeries(sp.data) };
    }
    // 변동성(VIX): 역사적 평균 고정선 대신 자체 50일 이동평균을 점선으로 표시
    // (전체 구간으로 계산 후 표시 구간만 잘라 워밍업 공백 없앰 — CNN 방법론과 동일 기준)
    if (key === "market_volatility_vix" && c?.data?.length) {
      const pts = c.data.map((d) => ({ date: new Date(d.x).toISOString().slice(0, 10), close: d.y }));
      // 결측(거래 없는 날 등) 하루만 있어도 그 뒤 50거래일 전체가 null 로
      // 전파되는 smaSeries 버그를 피해 결측-견고판을 사용 (2026-09 수정, KR
      // 쪽(kr/fear-greed.ts)에는 이미 있던 대응을 US 쪽에도 동일 적용)
      const ma50 = smaSeriesSkipNulls(
        pts.map((p) => p.close),
        50,
      );
      const maRows = pts
        .map((p, i) => (ma50[i] != null ? { date: p.date, value: round2(ma50[i] as number) } : null))
        .filter((r): r is { date: string; value: number } => r != null)
        .slice(-180);
      if (maRows.length) overlay = { label: "50일 이동평균", history: maRows };
    }

    return {
      key,
      label,
      valueLabel,
      score: typeof c?.score === "number" ? Math.round(c.score * 10) / 10 : null,
      history: toSeries(c?.data),
      overlay,
    };
  });

  // CNN 홈페이지는 점수를 정수로 반올림해 표시하고 등급도 그 정수 기준 → 동일하게
  const scoreInt = Math.round(fg.score);
  return {
    score: scoreInt,
    asOf: fg.timestamp?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
    prevClose: Math.round(fg.previous_close * 10) / 10,
    prev1w: Math.round(fg.previous_1_week * 10) / 10,
    prev1m: Math.round(fg.previous_1_month * 10) / 10,
    prev1y: Math.round(fg.previous_1_year * 10) / 10,
    history,
    components,
    source: "CNN Business",
    deepLink: CNN_DEEPLINK,
  };
}
