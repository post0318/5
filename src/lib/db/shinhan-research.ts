import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";
import type { MarketId } from "../markets/types";

/**
 * 증권사 리서치(기업분석) 리포트 — 개인용 로컬 수집 (CLAUDE.md 예외 참고).
 * 여러 증권사를 붙일 걸 감안해 스키마에 `source`를 두고 `_id`도
 * `${source}:${게시글번호}`로 네임스페이스했다(증권사별 ID 체계가 달라 충돌
 * 방지). 원문 PDF·전체 본문은 저장하지 않고 목록에 이미 노출되는 요약
 * (summary)·메타만 저장한다(용량: 건당 1~2KB 수준). 90일(3개월) 지난
 * 리포트는 수집 시점마다 정리한다 — getShinhanResearchBySymbol.
 */
export interface ShinhanResearchDoc {
  _id: string; // `${source}:${증권사 게시글 번호}`
  /** 증권사명 — "신한투자증권" 등. 여러 증권사 연동 대비 필드. */
  source: string;
  /** 종목의 상장 시장(2026-09 추가, GlobalMonitor의 미국주식 리포트 수집으로
   * 한국 전용이 아니게 됨) — 컬렉션 이름(kr_research)은 유지하되 필드로 구분. */
  market: MarketId;
  date: string; // ISO (YYYY-MM-DD)
  title: string;
  stockName: string;
  /** 종목명 → 종목코드 매핑 실패 시 null (필터링 대상에서 제외됨). */
  symbol: string | null;
  analyst: string;
  opinion: string;
  /** 목표주가(원) — 소스에 없거나 못 뽑으면 null(예: Not Rated 리포트). */
  targetPrice: number | null;
  summary: string;
  pdfUrl: string | null;
  views: number | null;
  collectedAt: string;
  /** 기업분석/산업분석 구분(2026-09 추가) — 현재 모든 수집기가 기업분석만
   * 수집하므로 기존 데이터·미지정 시 "기업"으로 취급(라우트에서 기본값 처리).
   * 산업분석 수집은 추후 과제. */
  category: "기업" | "산업";
}

// 리서치 자료는 3개월(90일)까지만 수집·보관한다(오너 최종 확정, 2026-09
// — 각 수집기의 백필 범위도 90일, 90일 지난 문서는 DB에서 지워도 무방).
// 단, "산업" 카테고리 중 투자전략으로 분류되는 문서는 휘발성이 강해(오너
// 지시, 2026-09 — "투자전략은 7일... 오래 가져갈 내용은 아니다") 원래 7일로
// 정했으나, classifyResearchTopic() 분류 품질을 먼저 검증할 시간이 필요해
// (오너 지시, 2026-09 — "일단 자료 검증을 위해 30일로 유지한다") 30일로
// 임시 상향. 검증 끝나면 7일로 되돌릴 것. 기업분석·산업분석은 기존 90일 그대로.
const MAX_AGE_MS = 90 * 24 * 3600_000;
const RECENT_WINDOW_MS = 90 * 24 * 3600_000;
const STRATEGY_MAX_AGE_MS = 30 * 24 * 3600_000;

export async function shinhanResearchCol(): Promise<Collection<ShinhanResearchDoc>> {
  const db = await getDb();
  const col = db.collection<ShinhanResearchDoc>("kr_research");
  await col.createIndex({ market: 1, symbol: 1, date: -1 }).catch(() => {});
  return col;
}

export async function upsertShinhanResearch(
  docs: ShinhanResearchDoc[],
): Promise<{ upserted: number; pruned: number }> {
  const col = await shinhanResearchCol();
  let upserted = 0;
  if (docs.length > 0) {
    // 문서 수가 많을 때(예: 초기 백필) 건별 replaceOne 순차 호출은 Vercel
    // 서버리스 함수 60초 제한을 넘겨 FUNCTION_INVOCATION_TIMEOUT 이 났다
    // (실측: KB·신한·하나 각 68~391건 배치에서 재현). bulkWrite 로 한 번에
    // 보내 라운드트립을 줄인다.
    const result = await col.bulkWrite(
      docs.map((d) => ({
        replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true },
      })),
      { ordered: false },
    );
    upserted = result.upsertedCount + result.modifiedCount;
  }
  const cutoff = new Date(Date.now() - MAX_AGE_MS).toISOString().slice(0, 10);
  const del = await col.deleteMany({ date: { $lt: cutoff } });

  // 투자전략 7일 정리 — topic 은 DB 필드가 아니라 classifyResearchTopic() 의
  // 계산 결과라 deleteMany 조건절에 바로 못 넣는다. 7일~90일 사이의 "산업"
  // 카테고리 문서만 후보로 가져와(전체 대비 소수) JS 에서 분류 후 투자전략인
  // 것만 id로 골라 지운다 — 기업분석·산업분석은 그대로 90일 유지.
  const strategyCutoff = new Date(Date.now() - STRATEGY_MAX_AGE_MS).toISOString().slice(0, 10);
  const staleIndustryCandidates = await col
    .find({ category: "산업", date: { $lt: strategyCutoff } })
    .project<{ _id: string; stockName: string; title: string }>({ stockName: 1, title: 1 })
    .toArray();
  const staleStrategyIds = staleIndustryCandidates
    .filter((d) => classifyResearchTopic(d) === "투자전략")
    .map((d) => d._id);
  let prunedStrategy = 0;
  if (staleStrategyIds.length > 0) {
    const del2 = await col.deleteMany({ _id: { $in: staleStrategyIds } });
    prunedStrategy = del2.deletedCount ?? 0;
  }

  return { upserted, pruned: (del.deletedCount ?? 0) + prunedStrategy };
}

/**
 * 같은 증권사가 제목까지 완전히 같은 리포트를 두 게시글 번호로 중복 게시한
 * 경우(실측: 신한투자증권, 2026-09 — 인접한 두 sno에 동일 리포트) 화면엔
 * 하나만 보여준다. source가 다르면(예: 유안타증권 자체 수집 vs 한경 컨센서스
 * 경유 유안타증권) 의도적으로 별개 카드로 남겨둔다(CLAUDE.md 참고 — 기능상
 * 문제 없는 것으로 이미 합의된 트레이드오프).
 */
function dedupeBySourceTitle(docs: ShinhanResearchDoc[]): ShinhanResearchDoc[] {
  const seen = new Set<string>();
  const result: ShinhanResearchDoc[] = [];
  for (const d of docs) {
    const key = `${d.source}|${d.title.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(d);
  }
  return result;
}

export type ResearchTopic = "산업분석" | "투자전략";

/**
 * "산업" 카테고리 문서를 산업분석/투자전략으로 다시 나눈다(오너 지시, 2026-09
 * — "전체/산업분석/투자전략으로 구분"). DB 스키마엔 이 구분을 담는 별도
 * 필드가 없다 — 수집기 15곳 이상을 전부 고쳐 소스별로 정확히 태깅하는 대신,
 * 이미 있는 stockName(카테고리 라벨/업종명)·title 텍스트에 대한 키워드
 * 추측으로 화면단에서 나눈다(미래에셋 market 분류와 동일한 트레이드오프 —
 * 완전하지 않음). 하나증권처럼 소스가 이미 "글로벌 투자전략"/"글로벌
 * 산업분석"으로 라벨링한 경우는 이 키워드만으로도 정확히 갈린다.
 */
// 일간/위클리/데일리/모닝/브리핑/마감 등 주기성 코멘트는 특정 업종 심층분석이
// 아니라 시황·종목 단신을 짧은 주기로 묶어내는 성격이라 투자전략으로 분류한다
// (오너 지시, 2026-09 — "미국부터 정리하자. 산업분석에서 일간, 위클리,
// 데일리, 모닝 등은 투자전략으로 분류" + 추가 지시 "브리핑, 마감도 투자전략으로").
// "Weekly"/"Daily"/"Morning"은 제목에 자주 그대로 영문으로 붙어 있어(예:
// "Tech&Stock Weekly", "HANA US Weekly") 한글 표기(위클리/데일리/모닝)와
// 함께 넓게 잡는다.
const STRATEGY_HINT_RE =
  /전략|추천종목|포트폴리오|Portfolio|아웃룩|Outlook|자산배분|리밸런싱|Rebalancing|IPO\s?Brief|시장\s?전망|투자의견|Top\s?Picks?|일간|위클리|데일리|모닝|브리핑|마감|\bWeekly\b|\bDaily\b|\bMorning\b/i;

export function classifyResearchTopic(doc: Pick<ShinhanResearchDoc, "stockName" | "title">): ResearchTopic {
  const hay = `${doc.stockName ?? ""} ${doc.title}`;
  return STRATEGY_HINT_RE.test(hay) ? "투자전략" : "산업분석";
}

/**
 * 산업분석/투자전략 리포트(종목 무관, `symbol: null`) — 시장 전체용 화면
 * (`/[market]/research`)에서 사용. `getShinhanResearchBySymbol`(종목별
 * 기업분석)과 달리 symbol 로 좁히지 않고 market+category="산업"으로만
 * 조회한다. 2026-09 기준 KB·미래에셋·한투·NH·하나·DS·BNK·GlobalMonitor·
 * 한경컨센서스 등 다수 소스가 이미 이 카테고리로 수집 중(수집기부터 먼저
 * 구축, 화면 연동은 이번에 처음). `topic` 을 주면 classifyResearchTopic()
 * 기준으로 한 번 더 걸러낸다 — DB 필드가 아니라 후처리 필터라, 필터링 후에도
 * limit 만큼 채우려고 원본을 넉넉히 가져온다.
 */
export async function getIndustryResearch(
  market: MarketId,
  limit = 30,
  topic?: ResearchTopic,
): Promise<ShinhanResearchDoc[]> {
  const col = await shinhanResearchCol();
  // topic 필터가 있으면 DB에서 걸러낼 수 없어(계산 필드) 후보를 훨씬 넉넉히
  // 가져와야 limit 만큼 채워진다 — 최근 200건 중 한쪽 topic이 몰려 있어도
  // 안전하도록 여유있게.
  const fetchLimit = topic ? Math.max(limit * 6, 200) : limit + 20;
  const docs = await col
    .find({ market, category: "산업" })
    .sort({ date: -1 })
    .limit(fetchLimit)
    .toArray();
  const deduped = dedupeBySourceTitle(docs);
  const filtered = topic ? deduped.filter((d) => classifyResearchTopic(d) === topic) : deduped;
  return filtered.slice(0, limit);
}

/**
 * 최근 3개월 내 리포트를 우선 반환하고, 없으면(커버리지가 뜸한 종목) 기간
 * 제한 없이 가장 최근 것으로 확대해서 보여준다 — "없음"보다 "오래됐지만
 * 있는 것"이 낫다는 원칙.
 */
export async function getShinhanResearchBySymbol(
  market: MarketId,
  symbol: string,
  limit = 20,
): Promise<ShinhanResearchDoc[]> {
  const col = await shinhanResearchCol();
  // market 필드는 2026-09 미국주식 리서치(GlobalMonitor) 추가 시 도입됨 — 그
  // 이전 문서(전부 한국 브로커 수집분)는 이 필드 자체가 없다. market="kr" 조회
  // 시에만 필드 없는 레거시 문서도 함께 매칭(하위호환), 다른 시장은 필드가
  // 명시적으로 있는 문서만 — DB 마이그레이션 없이도 기존 데이터가 안 사라짐.
  const marketFilter =
    market === "kr" ? { $or: [{ market }, { market: { $exists: false } }] } : { market };
  const recentCutoff = new Date(Date.now() - RECENT_WINDOW_MS).toISOString().slice(0, 10);
  // 중복 제거로 개수가 줄어들 수 있어 limit보다 넉넉히 가져온 뒤 잘라낸다.
  const fetchLimit = limit + 10;
  const recent = await col
    .find({ ...marketFilter, symbol, date: { $gte: recentCutoff } })
    .sort({ date: -1 })
    .limit(fetchLimit)
    .toArray();
  if (recent.length > 0) return dedupeBySourceTitle(recent).slice(0, limit);
  const fallback = await col
    .find({ ...marketFilter, symbol })
    .sort({ date: -1 })
    .limit(fetchLimit)
    .toArray();
  return dedupeBySourceTitle(fallback).slice(0, Math.min(limit, 3));
}
