import "server-only";
import { AdapterError } from "@/lib/markets/types";

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

const RATING_KO: Record<string, string> = {
  "extreme fear": "극도의 공포",
  fear: "공포",
  neutral: "중립",
  greed: "탐욕",
  "extreme greed": "극도의 탐욕",
};

const COMPONENT_LABELS: { key: string; label: string }[] = [
  { key: "market_momentum_sp125", label: "시장 모멘텀 (S&P vs 125일선)" },
  { key: "stock_price_strength", label: "주가 강도 (신고가/신저가)" },
  { key: "stock_price_breadth", label: "주가 폭 (거래량 확산)" },
  { key: "put_call_options", label: "풋/콜 옵션" },
  { key: "market_volatility_vix", label: "변동성 (VIX)" },
  { key: "safe_haven_demand", label: "안전자산 선호" },
  { key: "junk_bond_demand", label: "정크본드 수요" },
];

export interface FearGreed {
  score: number;
  rating: string;
  ratingKo: string;
  asOf: string;
  prevClose: number;
  prev1w: number;
  prev1m: number;
  prev1y: number;
  history: { date: string; value: number }[];
  components: { label: string; score: number | null; rating: string | null }[];
  source: string;
  deepLink: string;
}

function ratingOf(score: number): string {
  if (score < 25) return "extreme fear";
  if (score < 45) return "fear";
  if (score <= 55) return "neutral";
  if (score <= 75) return "greed";
  return "extreme greed";
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

  const components = COMPONENT_LABELS.map(({ key, label }) => {
    const c = raw[key] as { score?: number; rating?: string } | undefined;
    return {
      label,
      score: typeof c?.score === "number" ? Math.round(c.score * 10) / 10 : null,
      rating: c?.rating ?? null,
    };
  });

  return {
    score: Math.round(fg.score * 10) / 10,
    rating: fg.rating || ratingOf(fg.score),
    ratingKo: RATING_KO[fg.rating || ratingOf(fg.score)] ?? fg.rating,
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
