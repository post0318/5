import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";
import type { MarketId } from "../markets/types";

/**
 * 개별 애널리스트 투자의견 — StockAnalysis.com 종목별 애널리스트 평가
 * (종목당 최대 8건 — 무료로 받을 수 있는 소스 상한, 실측).
 * 개인용 로컬 수집(CLAUDE.md 예외 참고): 로컬 스크립트/GitHub Actions 가
 * 하루 1회 모아 `/api/cron/analyst-forecasts` 로 보내고, 배포된 앱은 DB 조회만
 * 한다. 원문 본문·차트는 저장하지 않고 목록에 이미 노출되는 행 정보(애널리스트명·
 * 증권사·등급·목표주가·일자)만 저장한다 — StockAnalysis ToS 가 "snippets" 사용을
 * 출처 명시 조건으로 허용하는 범위(전문 재게시만 금지).
 *
 * Yahoo `upgradeDowngradeHistory`(증권사 단위, 무제한 이력)와 상호보완:
 * 이쪽은 애널리스트 개인명·정확도가 있는 대신 종목당 최신 8건뿐이다.
 */
export interface AnalystForecastDoc {
  /** `${market}:${symbol}:${date}:${analystSlug || firm}` */
  _id: string;
  market: MarketId;
  symbol: string;
  date: string; // YYYY-MM-DD
  analyst: string;
  /** StockAnalysis 애널리스트 페이지 slug (개인 실적 페이지 링크용). */
  analystSlug: string | null;
  firm: string;
  /** 이번 의견 — "Buy" | "Hold" | "Sell" | "Outperform" 등 증권사 표현 그대로. */
  rating: string;
  /** 직전 등급 — 변경이 없으면 소스가 빈 문자열을 주므로 null 로 정규화. */
  ratingOld: string | null;
  /** "Maintains" | "Reiterates" | "Upgrade" | "Downgrade" | "Initiates" 등. */
  action: string;
  priceTarget: number | null;
  /** 직전 목표주가 — 변경이 없으면 null. */
  priceTargetOld: number | null;
  currency: string;
  /** 애널리스트 정확도 지표 (StockAnalysis 산출). 없으면 null. */
  score: number | null;
  stars: number | null;
  successRate: number | null;
  avgReturn: number | null;
  /** 전체 애널리스트 중 순위 / 모집단 크기. */
  analystRank: number | null;
  rankedExperts: number | null;
  /** 이 애널리스트의 총 평가 건수. */
  totalRatings: number | null;
  /** 이 종목에 한정한 적중률·평균수익률 — 종목별 신뢰도 판단에 가장 직접적. */
  stockSuccessRate: number | null;
  stockAvgReturn: number | null;
  collectedAt: string;
}

export async function analystForecastCol(): Promise<Collection<AnalystForecastDoc>> {
  const db = await getDb();
  const col = db.collection<AnalystForecastDoc>("analyst_forecasts");
  await col.createIndex({ market: 1, symbol: 1, date: -1 }).catch(() => {});
  return col;
}

/**
 * 종목 단위 스냅샷 교체. 저장하는 것이 "현재 상위 8건" 스냅샷이라 누적이 아니라
 * 대체가 맞다 — 옛 문서를 남겨두면 상한에서 밀려난 항목이 계속 쌓인다.
 * 수집 실패한 종목은 애초에 호출되지 않으므로 기존 데이터가 지워질 일은 없다.
 */
export async function replaceAnalystForecasts(
  market: MarketId,
  symbol: string,
  docs: AnalystForecastDoc[],
): Promise<{ replaced: number; removed: number }> {
  const col = await analystForecastCol();
  const del = await col.deleteMany({ market, symbol });
  if (docs.length > 0) {
    await col.bulkWrite(
      docs.map((d) => ({
        replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true },
      })),
      { ordered: false },
    );
  }
  return { replaced: docs.length, removed: del.deletedCount ?? 0 };
}

export async function getAnalystForecasts(
  market: MarketId,
  symbol: string,
  limit = 8,
): Promise<AnalystForecastDoc[]> {
  const col = await analystForecastCol();
  return col.find({ market, symbol }).sort({ date: -1 }).limit(limit).toArray();
}
