import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";

/**
 * 유니버스 통합 뷰 사전 계산 캐시 (prd.md §4 — "조회는 DB 우선").
 *  - 매일 배치가 종목별 요약을 계산해 upsert
 *  - 편집/삭제 시 해당 종목만 즉시 갱신
 *  - 조회 API 는 이 컬렉션만 읽어 즉시 응답 (외부 API 미호출)
 *
 * **계정 간 공유 캐시**(2026-09, 유니버스 계정별 분리). 키가 `market:symbol`
 * 이라 A·B·C 가 모두 삼성전자를 담아도 시세·멀티플 계산은 한 번뿐이다.
 * 반면 이름·그룹명·태그·itemId 는 사람마다 다르므로 이 문서에 든 값은
 * "마지막으로 쓴 사람의 것"이라 신뢰하지 않는다 — 조회 시점에 각 계정의
 * `universe_items` 값으로 덮어쓴다(`lib/universe/overview.ts`).
 */

export interface UniverseOverviewDoc {
  _id: string; // `${market}:${symbol}` — 계정과 무관한 공유 키
  /** 조회 시 각 계정의 유니버스 항목 id 로 덮어씀 (편집·삭제 버튼이 씀) */
  itemId: string;
  market: "kr" | "us" | "jp";
  symbol: string;
  yahooSymbol: string | null;
  /** 아래 세 개도 조회 시 각 계정 값으로 덮어씀 — 저장값은 참고용 */
  name: string | null;
  groupName: string | null;
  tags: string[];
  last: number | null;
  changePct: number | null;
  currency: "KRW" | "USD" | "JPY" | null;
  per: number | null;
  perTtm: number | null;
  /** 추정PER — 국내: 네이버 FnGuide 컨센서스, 해외: 야후 forwardPE */
  estPer: number | null;
  pbr: number | null;
  forwardPer: number | null;
  targetMeanPrice: number | null;
  recommendationKey: string | null;
  marketCap: number | null;
  revenueAnnual: number | null;
  opMargin: number | null;
  netMargin: number | null;
  /** 외국인 보유비율 (%) — 한국 종목만, 네이버 일 1회 배치 */
  foreignRatio: number | null;
  foreignRatioAsOf: string | null;
  /** KRX KIND 고배당기업 명단 소속 여부 — 한국 종목만 */
  highDividend: boolean;
  warnings: string[];
  error: string | null;
  updatedAt: string;
}

export async function universeOverviewCol(): Promise<Collection<UniverseOverviewDoc>> {
  const col = (await getDb()).collection<UniverseOverviewDoc>("universe_overview");
  await col.createIndex({ market: 1 }).catch(() => {});
  return col;
}

export async function readOverview(
  market?: "kr" | "us" | "jp",
): Promise<UniverseOverviewDoc[]> {
  const col = await universeOverviewCol();
  const q = market ? { market } : {};
  return col.find(q).sort({ market: 1, symbol: 1 }).toArray();
}

/** 지정한 `market:symbol` 들만 읽기 — 계정별 조회용 */
export async function readOverviewByIds(ids: string[]): Promise<UniverseOverviewDoc[]> {
  if (ids.length === 0) return [];
  const col = await universeOverviewCol();
  return col
    .find({ _id: { $in: ids } })
    .sort({ market: 1, symbol: 1 })
    .toArray();
}

export async function writeOverview(docs: UniverseOverviewDoc[]): Promise<number> {
  if (docs.length === 0) return 0;
  const col = await universeOverviewCol();
  const res = await col.bulkWrite(
    docs.map((d) => ({
      replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true },
    })),
  );
  return res.upsertedCount + res.modifiedCount;
}

export async function deleteOverview(market: string, symbol: string): Promise<void> {
  const col = await universeOverviewCol();
  await col.deleteOne({ _id: `${market}:${symbol}` });
}

/**
 * 유니버스에서 빠진 종목의 잔여 캐시 정리.
 * 캐시가 전 계정 공유라 `keepIds` 는 **전 계정 합집합**이어야 한다 — 한 사람의
 * 목록만 넘기면 다른 사람 종목의 캐시까지 지워진다. 그래서 호출부는 배치
 * (전 시장·전 계정) 경로 하나뿐이다.
 */
export async function pruneOverview(keepIds: string[]): Promise<number> {
  const col = await universeOverviewCol();
  const res = await col.deleteMany({ _id: { $nin: keepIds } });
  return res.deletedCount;
}
