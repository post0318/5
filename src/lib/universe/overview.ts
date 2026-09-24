import "server-only";
import type { MarketId } from "@/lib/markets/types";
import { getStockOverview } from "@/lib/markets/service";
import { fetchKrForeignOwnership, fetchKrNaverConsensus } from "@/lib/markets/kr/naver";
import { computeKrOverviewMetrics } from "@/lib/markets/kr/overview-metrics";
import { listUniverse, listUniverseDistinct } from "@/lib/universe/repo";
import { isHighDividendKr } from "@/lib/markets/kr/high-dividend";
import type { UniverseItem } from "@/lib/db/schema";
import {
  deleteOverview,
  pruneOverview,
  readOverviewByIds,
  writeOverview,
  type UniverseOverviewDoc,
} from "@/lib/db/universe-overview";

/**
 * 유니버스 통합 뷰 한 행 계산 — 저장 없이 결과만. 재무 검증 스크립트가 화면과 같은 함수의
 * 결과를 비교하려고 쓴다(`/api/cron/verify-row`, 검증 도구 감사 2026-09-24: 예전 검증기는
 * 식을 다시 짜서 비교해 실제 화면 경로를 검증하지 못했다).
 */
export async function computeUniverseRow(
  market: "kr" | "us" | "jp",
  symbol: string,
): Promise<UniverseOverviewDoc> {
  return computeDoc({
    id: `verify:${market}:${symbol}`,
    market,
    symbol,
    yahooSymbol: null,
    name: null,
    groupName: null,
    tags: [],
  } as unknown as UniverseItem);
}

async function computeDoc(item: UniverseItem): Promise<UniverseOverviewDoc> {
  const base = {
    _id: `${item.market}:${item.symbol}`,
    itemId: item.id,
    market: item.market as "kr" | "us" | "jp",
    symbol: item.symbol,
    yahooSymbol: item.yahooSymbol ?? null,
    name: item.name ?? null,
    groupName: item.groupName,
    tags: item.tags,
    updatedAt: new Date().toISOString(),
  };
  try {
    const isKr = item.market === "kr";
    const [ov, foreign, krCons, krMetrics] = await Promise.all([
      getStockOverview(item.market as MarketId, item.symbol, item.yahooSymbol, {
        skipQuarterly: true,
        // 한국은 아래 dart-facts 기반 경로로 대체 — adapter.getFinancials(rowsToStatement)
        // 왕복을 줄인다 (multiples.ts 문자열 매칭은 계정명 편차로 구멍이 많았음)
        skipFinancials: isKr,
        // 한국 시세는 computeKrOverviewMetrics 가 별도로 받아온다 — 여기서 또
        // getEodQuote 를 호출하면 종목당 KRX 요청이 중복(과거엔 두 군데서
        // 각각 fetchKrxEod 호출)돼 새로고침이 느려진다.
        skipQuote: isKr,
      }),
      isKr ? fetchKrForeignOwnership(item.symbol).catch(() => null) : Promise.resolve(null),
      isKr ? fetchKrNaverConsensus(item.symbol).catch(() => null) : Promise.resolve(null),
      isKr
        ? computeKrOverviewMetrics(item.symbol, item.yahooSymbol).catch(() => null)
        : Promise.resolve(null),
    ]);
    const inp = ov.multiples?.inputs;
    const rev = isKr ? (krMetrics?.revenueAnnual ?? null) : (inp?.revenueAnnual ?? null);
    const margin = (n: number | null | undefined) => (n != null && rev ? n / rev : null);
    const warnings = [...ov.warnings];
    if (isKr && krMetrics?.last == null) warnings.push("시세 조회 실패");
    return {
      ...base,
      name: item.name ?? ov.profile?.name ?? null,
      last: isKr ? (krMetrics?.last ?? null) : (ov.quote?.last ?? null),
      changePct: isKr ? (krMetrics?.changePct ?? null) : (ov.quote?.changePct ?? null),
      currency: isKr ? (krMetrics?.currency ?? "KRW") : (ov.quote?.currency ?? null),
      per: isKr ? null : (ov.multiples?.per ?? null),
      perTtm: isKr ? (krMetrics?.perTtm ?? null) : (ov.multiples?.perTtm ?? null),
      estPer:
        item.market === "kr"
          ? krCons?.estPer ?? null
          : ov.consensus?.forwardPer ?? null,
      pbr: isKr ? (krMetrics?.pbr ?? null) : (ov.multiples?.pbr ?? null),
      forwardPer: ov.consensus?.forwardPer ?? null,
      targetMeanPrice: ov.consensus?.targetMeanPrice ?? null,
      recommendationKey: ov.consensus?.recommendationKey ?? null,
      marketCap: isKr ? (krMetrics?.marketCap ?? null) : (ov.multiples?.marketCap ?? null),
      revenueAnnual: rev,
      opMargin: isKr ? (krMetrics?.opMargin ?? null) : margin(inp?.opIncomeAnnual),
      netMargin: isKr ? (krMetrics?.netMargin ?? null) : margin(inp?.netIncomeAnnual),
      foreignRatio: foreign?.ratio ?? null,
      foreignRatioAsOf: foreign?.asOf ?? null,
      highDividend: isKr && isHighDividendKr(item.symbol),
      warnings: [...new Set(warnings)],
      error: null,
    };
  } catch (err) {
    return {
      ...base,
      last: null,
      changePct: null,
      currency: null,
      per: null,
      perTtm: null,
      estPer: null,
      pbr: null,
      forwardPer: null,
      targetMeanPrice: null,
      recommendationKey: null,
      marketCap: null,
      revenueAnnual: null,
      opMargin: null,
      netMargin: null,
      foreignRatio: null,
      foreignRatioAsOf: null,
      highDividend: item.market === "kr" && isHighDividendKr(item.symbol),
      warnings: [],
      error: err instanceof Error ? err.message : "조회 실패",
    };
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 유니버스 요약을 재계산해 DB 에 저장. 배치·수동 새로고침용.
 *  - `ownerId` 를 주면 그 계정의 종목만 (화면의 새로고침 버튼)
 *  - 안 주면 전 계정 합집합에서 중복을 걷어낸 목록 (배치) — 같은 종목을
 *    여러 사람이 담아도 외부 API 는 한 번만 부른다.
 * 캐시가 전 계정 공유라 잔여 정리(prune)는 배치 경로에서만 한다.
 */
export async function refreshUniverseOverview(opts?: {
  ownerId?: string;
  market?: MarketId;
}): Promise<{
  count: number;
  rows: UniverseOverviewDoc[];
}> {
  const ownerId = opts?.ownerId;
  const market = opts?.market;
  const items = ownerId
    ? await listUniverse({ ownerId, market, activeOnly: true })
    : await listUniverseDistinct({ market, activeOnly: true });
  // 종목당 여러 외부 API를 호출해서(프로필·시세·재무·컨센서스 등) 동시성이
  // 낮으면 전체 새로고침이 라우트의 maxDuration(60초)을 넘겨 중간에 끊길 수
  // 있다(오너 확인 — 새로고침 클릭해도 반영 안 되던 문제). 동시성을 올려
  // 전체 라운드 수를 줄인다.
  // 다만 한국은 KRX 시세(computeKrOverviewMetrics)가 무거워 동시성을 그대로
  // 20으로 두면 콜드 상태에서 요청이 한꺼번에 몰려 오히려 느려진다 — 한국만
  // 낮은 동시성(8)으로 분리하고, market 없이 전 시장을 도는 경로(cron·bulk)도
  // 있으므로 kr/non-kr 를 나눠 병렬로 돌린 뒤 원래 순서대로 재조립한다.
  const krIdx: number[] = [];
  const otherIdx: number[] = [];
  items.forEach((item, i) => (item.market === "kr" ? krIdx : otherIdx).push(i));
  const [krRows, otherRows] = await Promise.all([
    mapWithConcurrency(
      krIdx.map((i) => items[i]),
      8,
      computeDoc,
    ),
    mapWithConcurrency(
      otherIdx.map((i) => items[i]),
      20,
      computeDoc,
    ),
  ]);
  const rows = new Array<UniverseOverviewDoc>(items.length);
  krIdx.forEach((i, j) => (rows[i] = krRows[j]));
  otherIdx.forEach((i, j) => (rows[i] = otherRows[j]));
  await writeOverview(rows);
  if (!market && !ownerId) {
    // 전 계정·전 시장 배치일 때만 안전하게 정리할 수 있다.
    await pruneOverview(rows.map((r) => r._id));
  }
  return { count: rows.length, rows };
}

/** 종목 1개만 재계산 (편집 직후 즉시 반영). */
export async function refreshOverviewItem(item: UniverseItem): Promise<void> {
  const doc = await computeDoc(item);
  await writeOverview([doc]);
}

/**
 * 캐시 삭제. 캐시가 전 계정 공유라 **다른 사람이 아직 담고 있으면 지우지
 * 않는다** — 한 사람이 삼성전자를 빼도 남은 사람 화면이 비지 않게.
 */
export async function removeOverviewItem(market: string, symbol: string): Promise<void> {
  const stillUsed = await listUniverse({ market: market as MarketId });
  if (stillUsed.some((i) => i.symbol === symbol)) return;
  await deleteOverview(market, symbol);
}

/**
 * 한 계정의 통합 뷰 조회. DB 만 읽는다(외부 API 미호출).
 * 공유 캐시에서 내 종목만 골라오고, 이름·그룹명·태그·itemId 는 내 유니버스
 * 값으로 덮어쓴다 — 캐시에 든 그 필드들은 마지막에 쓴 사람의 것이라
 * 그대로 두면 남의 그룹명이 보인다.
 */
export async function getUniverseOverview(
  ownerId: string,
  market?: MarketId,
): Promise<{
  rows: UniverseOverviewDoc[];
  stale: boolean;
}> {
  const items = await listUniverse({ ownerId, market, activeOnly: true });
  if (items.length === 0) return { rows: [], stale: false };

  const cached = await readOverviewByIds(items.map((i) => `${i.market}:${i.symbol}`));
  if (cached.length === 0) {
    const built = await refreshUniverseOverview({ ownerId, market });
    return { rows: built.rows, stale: false };
  }

  const byId = new Map(items.map((i) => [`${i.market}:${i.symbol}`, i]));
  const rows = cached.flatMap((r) => {
    const mine = byId.get(r._id);
    if (!mine) return [];
    return [
      {
        ...r,
        itemId: mine.id,
        name: mine.name ?? r.name,
        groupName: mine.groupName,
        tags: mine.tags,
      },
    ];
  });
  const oldest = rows.length
    ? rows.reduce((m, r) => (r.updatedAt < m ? r.updatedAt : m), rows[0].updatedAt)
    : new Date().toISOString();
  const ageMs = Date.now() - new Date(oldest).getTime();
  return { rows, stale: ageMs > 18 * 3600_000 || rows.length < items.length };
}
