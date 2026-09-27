import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";
import type { MarketId } from "../markets/types";
import { isCommonExcludedResearch } from "../research-exclude";

/**
 * 산업/기업분석 리서치는 이 앱의 4대 시장(`MarketId`: kr/us/jp) 밖의 소스도
 * 다룰 수 있다 — 중국(`ch`)이 첫 사례(오너 지시, 2026-09-24 — "ch는 마켓은
 * ch다 us분류하면 안된다"). 종목분석(EDGAR/DART/EDINET 어댑터, `registry.ts`)
 * 은 아직 중국을 지원하지 않으므로 `MarketId` 자체는 건드리지 않고, 리서치
 * 문서·조회 함수만 이 더 넓은 타입을 쓴다 — 종목분석 쪽 코드는 전혀 영향
 * 없음. `/ch/research` 같은 전용 화면은 아직 없어(추후 과제) 이 태그가 붙은
 * 문서는 당장 화면에 노출되지 않지만, 최소한 "us"로 잘못 섞이는 것은 막는다.
 */
// "eu" — 유럽(오너 지시 2026-09-25 — "중국 일본 유럽도 시장은 추가해놔라").
// ch 와 같이 리서치 태깅 전용이고 종목분석 어댑터(MarketId)와는 별개.
export type ResearchMarketId = MarketId | "ch" | "eu";
export function isResearchMarketId(v: string): v is ResearchMarketId {
  return v === "kr" || v === "us" || v === "jp" || v === "ch" || v === "eu";
}

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
   * 한국 전용이 아니게 됨) — 컬렉션 이름(kr_research)은 유지하되 필드로 구분.
   * `MarketId`(kr/us/jp) 뿐 아니라 종목분석 미지원 시장(예: "ch")도 태깅
   * 가능(`ResearchMarketId` 참고). */
  market: ResearchMarketId;
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
  /** category:"산업" 리포트가 실질적으로 다루는 대형주(2026-09-19 추가,
   * 오너 지적 — BNK "반도체" 산업분석 PDF에 삼성전자가 26번 언급되는데
   * category:"산업"이라 symbol이 항상 null이라서 삼성전자 페이지에서
   * 전혀 안 보였음). 수집기가 PDF 본문에서 미리 정한 대형주 목록의 언급
   * 횟수를 세어(원문은 저장 안 함, 횟수만) 임계값을 넘으면 채운다 — 이름
   * 검색으로 종목코드를 추측하는 것과 달리 오탐 위험이 없다(실제 언급
   * 빈도 기반). 기업분석(category:"기업")엔 안 쓰임(이미 symbol 있음). */
  relatedSymbols?: string[];
}

// 리서치 자료는 3개월(90일)까지만 수집·보관한다(오너 최종 확정, 2026-09
// — 각 수집기의 백필 범위도 90일, 90일 지난 문서는 DB에서 지워도 무방).
// 단, "산업" 카테고리 중 투자전략/시황으로 분류되는 문서는 휘발성이 강해
// 짧게만 보관한다 — 투자전략(주식)/(채권)은 30일(오너 지시, 2026-09 —
// "그 이상은 불필요하다. 화면에서도 제외한다", **30일이 최종 값, 7일로
// 되돌릴 계획 없음** — 시황과 달리 임시 상향이 아님). 시황은 원래 7일
// 지시("시황은 7일 이상은 불필요하다. db도 필요없다")였다가 분류 검증
// 기간 동안 14일로 임시 상향(오너 지시, 2026-09 — "시황은 일단 14일까지
// 유지한다... 테스트가 필요하니") — **시황만** 검증 끝나면 7일로 되돌릴
// 것. 기업분석·산업분석은 기존 90일 그대로.
const MAX_AGE_MS = 90 * 24 * 3600_000;
const RECENT_WINDOW_MS = 90 * 24 * 3600_000;
// 전면 개편(오너 지시 2026-09-26 — "macro_issues를 kr_research로 흡수").
// 보관기간은 오너가 직접 지정한 값 그대로: 이슈분석 30일 · 환율분석 30일 ·
// 시황분석:Daily 7일 · 시황분석:Monthly 30일 · 시황분석:투자전략 90일 ·
// 비상장 180일 · 글로벌IB 90일(기존 180일에서 단축) · 인사이트/산업분석/
// 종목분석은 기존 90일 그대로.
const ISSUE_MAX_AGE_MS = 30 * 24 * 3600_000;
const FX_MAX_AGE_MS = 30 * 24 * 3600_000;
const MARKET_DAILY_MAX_AGE_MS = 7 * 24 * 3600_000;
const MARKET_MONTHLY_MAX_AGE_MS = 30 * 24 * 3600_000;
const MARKET_STRATEGY_MAX_AGE_MS = 90 * 24 * 3600_000; // == MAX_AGE_MS, 별도 조기 정리 불필요
const UNLISTED_MAX_AGE_MS = 180 * 24 * 3600_000;
const GLOBAL_IB_MAX_AGE_MS = 90 * 24 * 3600_000;
/** 해외리서치(골드만삭스 리서치 노트) 전용 보존기간 — 오너 지시,
 * 2026-09-19 "여기만 백필기간을 180일로". 다른 "산업" 카테고리는 90일. */

export async function shinhanResearchCol(): Promise<Collection<ShinhanResearchDoc>> {
  const db = await getDb();
  const col = db.collection<ShinhanResearchDoc>("kr_research");
  await col.createIndex({ market: 1, symbol: 1, date: -1 }).catch(() => {});
  return col;
}

/**
 * 같은 제목이 여러 번 올라온 것은 내용 업데이트본이라 최신 1건만 남긴다(오너 지시 2026-09-27 — 모든 수집기 공통).
 * 키 = 출처·시장·카테고리·종목·제목(공백 정규화). 최신 = 날짜가 늦은 것, 같은 날이면 _id 가 큰 것.
 */
const dupKey = (d: ShinhanResearchDoc) =>
  [d.source, d.market ?? "kr", d.category ?? "", d.symbol ?? "", (d.title ?? "").replace(/\s+/g, " ").trim()].join("|");
const isNewer = (a: ShinhanResearchDoc, b: ShinhanResearchDoc) =>
  a.date > b.date || (a.date === b.date && a._id > b._id);
function keepLatestPerTitle(docs: ShinhanResearchDoc[]): ShinhanResearchDoc[] {
  const latest = new Map<string, ShinhanResearchDoc>();
  for (const d of docs) {
    const k = dupKey(d);
    const cur = latest.get(k);
    if (!cur || isNewer(d, cur)) latest.set(k, d);
  }
  return [...latest.values()];
}

export async function upsertShinhanResearch(
  allDocs: ShinhanResearchDoc[],
): Promise<{ upserted: number; pruned: number }> {
  const col = await shinhanResearchCol();
  let upserted = 0;
  const docs = keepLatestPerTitle(allDocs);
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
  // DB 에 이미 있는 같은 제목의 옛 문서는 지운다(들어온 문서가 더 최신일 때만).
  if (docs.length > 0) {
    await col.bulkWrite(
      docs.map((d) => ({
        deleteMany: {
          filter: {
            _id: { $ne: d._id },
            source: d.source,
            title: d.title,
            category: d.category,
            $or: [{ date: { $lt: d.date } }, { date: d.date, _id: { $lt: d._id } }],
          },
        },
      })),
      { ordered: false },
    );
  }
  const cutoff = new Date(Date.now() - MAX_AGE_MS).toISOString().slice(0, 10);
  const del = await col.deleteMany({
    date: { $lt: cutoff },
    source: { $nin: FOREIGN_RESEARCH_SOURCES as unknown as string[] },
  });
  // 글로벌IB(market!=="kr")·비상장(market==="kr") — 소스는 같지만(FOREIGN_
  // RESEARCH_SOURCES) market에 따라 보관기간이 다르다(오너 지시 2026-09-26 —
  // 글로벌IB 90일, 비상장 180일).
  const globalIbCutoff = new Date(Date.now() - GLOBAL_IB_MAX_AGE_MS).toISOString().slice(0, 10);
  const unlistedCutoff = new Date(Date.now() - UNLISTED_MAX_AGE_MS).toISOString().slice(0, 10);
  const delGlobalIb = await col.deleteMany({
    date: { $lt: globalIbCutoff },
    source: { $in: FOREIGN_RESEARCH_SOURCES as unknown as string[] },
    market: { $ne: "kr" },
  });
  const delUnlisted = await col.deleteMany({
    date: { $lt: unlistedCutoff },
    source: { $in: FOREIGN_RESEARCH_SOURCES as unknown as string[] },
    market: "kr",
  });

  // 이슈분석/환율분석/시황분석(Daily·Monthly) 조기 정리 — topic은 DB 필드가
  // 아니라 classifyResearchTopic()의 계산 결과라 deleteMany 조건절에 바로
  // 못 넣는다. 가장 짧은 컷오프(시황분석:Daily 7일)~90일 사이의 "산업"
  // 카테고리 문서만 후보로 가져와(전체 대비 소수) JS에서 분류 후 각자의
  // 컷오프를 넘겼으면 id로 골라 지운다. 산업분석·시황분석:투자전략(둘 다
  // 90일)은 위 일반 del이 이미 처리하므로 여기서 안 건드린다.
  const issueCutoff = new Date(Date.now() - ISSUE_MAX_AGE_MS).toISOString().slice(0, 10);
  const fxCutoff = new Date(Date.now() - FX_MAX_AGE_MS).toISOString().slice(0, 10);
  const dailyCutoff = new Date(Date.now() - MARKET_DAILY_MAX_AGE_MS).toISOString().slice(0, 10);
  const monthlyCutoff = new Date(Date.now() - MARKET_MONTHLY_MAX_AGE_MS).toISOString().slice(0, 10);
  // 후보 조회는 넷 중 가장 넓은(=가장 최근인) 컷오프를 써야 한다 — 시황분석:
  // Daily(7일)가 가장 짧아서, 7일 기준으로 가져와야 "7~30일 사이의 이슈분석/
  // 환율분석/Monthly"도 후보에 걸린다.
  const staleIndustryCandidates = await col
    .find({
      category: "산업",
      date: { $lt: dailyCutoff },
      source: { $nin: [...INSIGHT_SOURCES, ...FOREIGN_RESEARCH_SOURCES] as unknown as string[] },
    })
    .project<{ _id: string; date: string; stockName: string; title: string; source: string; market: ResearchMarketId; summary: string }>({
      date: 1,
      stockName: 1,
      title: 1,
      source: 1,
      market: 1,
      summary: 1,
    })
    .toArray();
  const staleStrategyIds = staleIndustryCandidates
    .filter((d) => {
      const t = classifyResearchTopic(d);
      if (t === "이슈분석") return d.date < issueCutoff;
      if (t === "환율분석") return d.date < fxCutoff;
      if (t === "시황분석:Daily") return true; // 후보 자체가 이미 7일 이전만 가져왔음
      if (t === "시황분석:Monthly") return d.date < monthlyCutoff;
      return false; // 산업분석·시황분석:투자전략은 일반 90일 정리에 맡김
    })
    .map((d) => d._id);
  let prunedStrategy = 0;
  if (staleStrategyIds.length > 0) {
    const del2 = await col.deleteMany({ _id: { $in: staleStrategyIds } });
    prunedStrategy = del2.deletedCount ?? 0;
  }

  return {
    upserted,
    pruned:
      (del.deletedCount ?? 0) +
      (delGlobalIb.deletedCount ?? 0) +
      (delUnlisted.deletedCount ?? 0) +
      prunedStrategy,
  };
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

/** 리매핑 전 내부 분류(과거 이름 그대로 유지, 잘 튜닝된 휴리스틱 그대로 재사용). */
type LegacyResearchTopic = "산업분석" | "투자전략(주식)" | "투자전략(채권)" | "시황" | "해외리서치";

/**
 * 공개 분류 체계(오너 지시 2026-09-26, "리서치 파이프라인 구조 전면 개편") —
 * macro_issues 컬렉션을 kr_research로 흡수하면서 이슈분석/환율분석이 이제
 * 여기서도 판정된다. LegacyResearchTopic → ResearchTopic 매핑:
 *   산업분석 → 산업분석(그대로)
 *   투자전략(채권) → 이슈분석 | 환율분석(제목에 FX 신호 있으면 환율분석)
 *   시황 → 시황분석:Daily | 시황분석:Monthly(제목에 "월간"/"month" 신호 있으면
 *     Monthly, 그 외 기본값 Daily)
 *   투자전략(주식) → 시황분석:투자전략
 *   해외리서치 → 글로벌IB(market!=="kr") | 비상장(market==="kr", 현재
 *     FOREIGN_RESEARCH_SOURCES가 전부 market:"us"라 이론적 케이스)
 */
export type ResearchTopic =
  | "산업분석"
  | "이슈분석"
  | "환율분석"
  | "시황분석:Daily"
  | "시황분석:Monthly"
  | "시황분석:투자전략"
  | "글로벌IB"
  | "비상장";

/**
 * "산업" 카테고리 문서를 산업분석/투자전략/시황 세 갈래로 나눈다(오너 지시,
 * 2026-09 — "전체/산업분석/투자전략으로 구분" → 이후 "투자전략도 투자전략과
 * 시황으로 분리...전체/산업분석/투자전략/시황"). DB 스키마엔 이 구분을 담는
 * 별도 필드가 없다 — 수집기 15곳 이상을 전부 고쳐 소스별로 정확히 태깅하는
 * 대신, 이미 있는 stockName(카테고리 라벨/업종명)·title 텍스트에 대한 키워드
 * 추측으로 화면단에서 나눈다(미래에셋 market 분류와 동일한 트레이드오프 —
 * 완전하지 않음).
 *
 * 판정 순서: **시황(주기성) 신호를 먼저 본다.** "마감/브리핑/시황/모니터/
 * 마켓레이더" 등(MARKET_CONDITION_STRONG_RE)은 stockName이 뭐든 항상 시황
 * 이다(오너 지시, 2026-09 — "투자전략에서 시황, 마감, 브리핑, 위클리 등은
 * 시황으로 분류" + "데일리, 모닝, 일간도 시황으로 분류" + "NH투자증권
 * 투자전략은 투자전략으로 분류하나 모닝, 위클리, 주간 등 특정 단어가
 * 포함되면 시황으로 분류"). "한화 주간전략"처럼 제목에 "전략"이 있어도
 * "주간"이 있으면 시황이 우선한다 — 하나증권처럼 소스가 게시판 자체를
 * "글로벌 투자전략"으로 라벨링해둔 경우(stockName에 "전략"이 그대로
 * 들어있음) 그 라벨이 개별 항목의 실제 형식("Tech&Stock Weekly" 같은
 * 정기물)을 가려버리는 문제가 실측됐기 때문.
 *
 * 다만 "일간/위클리/주간/데일리/모닝/아침/Weekly/Daily/Morning"(주기성만
 * 있고 시황임을 확정 짓지는 못하는 약한 신호, MARKET_CONDITION_PERIOD_RE)
 * 은 stockName이 실제 업종명(예: "철강금속", "인터넷/게임")일 때는 시황으로
 * 확정하지 않는다(오너 지적, 2026-09 — "단순히 위클리만 따라가면 답없다") —
 * 하나증권의 "철강금속 Weekly"/"Battery Weekly"/"유틸리티 Weekly", IBK
 * "IBKS Daily"(stockName "인터넷/게임") 등은 특정 업종의 **정기 커버리지**
 * 이지 시장 전체 시황이 아니다(실측: 90일치 산업 카테고리에서 100건 이상
 * 오분류 확인). stockName이 업종명이 아니라 "산업"/"시장"(수집기 기본값
 * 라벨) 이거나 게시판 라벨 자체가 전략/시장 성격(STRATEGY_HINT_RE 매치)일
 * 때만 이 약한 신호도 시황으로 확정한다(`isGenericOrBoardLabel()`).
 * "Weekly"/"Daily"/"Morning"은 제목에 자주 그대로 영문으로 붙어 있어
 * 한글 표기(위클리/데일리/모닝)와 함께 넓게 잡는다.
 *
 * stockName 시리즈명 강제 분류: GlobalMonitor(einfomax) 경유 리포트는 목록
 * API가 헤드라인만 줘서 정기물 표시("데일리"/"Monitor" 등 브랜드명)가 PDF
 * 본문에만 있고 목록 헤드라인 텍스트엔 전혀 없는 경우가 있다(오너 실측 확인,
 * 2026-09 — PDF를 직접 열어 확인. 예: KB증권 "KB Global Tracker+"는 PDF
 * 제목이 "데일리"인데 목록 헤드라인엔 "데일리"가 없음, 상상인증권은 "모니터"
 * 라는 자체 브랜드를 씀). 이런 시리즈는 stockName(=GlobalMonitor의 리포트
 * 시리즈명 필드, 종목명이 아니라 상품명이 들어있음)으로 통째로 시황 강제.
 *
 * source+market 조합 강제 분류: LS증권은 "산업" 카테고리 안에서도 국내(kr)는
 * 정상적인 개별 테마 심층분석("AI시대 조선 산업의 변화" 등)인데 해외(us)는
 * 전부 시리즈명 없이 매일 지수·유가·금리 동향만 요약하는 시황 단신이었다
 * (실측 확인, 2026-09 — market:"us" 27건 전수 확인, 예외 없음). stockName
 * 이 다른 소스처럼 시리즈명을 안 주고 그냥 "산업"(기본값)이라 stockName
 * 으로는 못 가리므로 source+market 조합으로 강제 — **국내(kr)는 절대
 * 포함하지 않는다**(같은 소스라도 시장에 따라 성격이 다름).
 */
// "매크로"/"Macro"(특정 섹터가 아닌 거시경제 코멘트 전반, 예: SK증권
// "매크로 Comment") — 산업분석 아니면 투자전략이라는 원칙에서, 섹터명이
// 아닌 매크로 코멘트류는 투자전략 기본값(오너 지적, 2026-09). "고용/CPI/PPI/
// PCE/물가"(미국 고용·물가 지표 발표 코멘트, 실측 다수 확인 — 전부 오너가
// 투자전략(채권)으로 지적)와 "FOMC"(FOMC 자체 언급은 주식/채권 어느 쪽도
// 될 수 있어 — 실측: "나스닥 신고가 기대" 는 주식, "CPI…금리 인상" 은
// 채권 — STRATEGY 승격까지만 담당하고 isBond() 가 최종 구분)도 추가.
// "전략"은 "치료 전략"/"임상 전략"처럼 금융과 무관한 일반 단어로도 흔히 쓰여
// (실측: 바이오 섹터 리포트 "비소세포폐암 차세대 치료 전략..."이 산업분석
// 인데 투자전략(주식)으로 잘못 넘어감, 오너 지적 2026-09) "치료"/"임상" 바로
// 앞에 오는 경우는 제외(부정 전방탐색).
// "실적상향/실적하향"(어닝 리비전 스크리닝, 예: "신흥국 실적 상향 상위에
// 한국 10개 종목 진입" — 여러 종목을 실적 모멘텀 기준으로 스크리닝하는
// 투자전략물이지 업종 얘기가 아님) 추가(오너 지적, 2026-09).
//
// 한글 "전략" 단독(영문 Strategy/Strategic 제외)은 업종 심층분석 리포트가
// 결론부에 "…변화와 투자전략"/"9월 전략: …" 식으로 흔히 쓰는 관용구라(실측:
// LS증권 "AI시대 조선 산업의 변화와 투자전략", DS증권 "9월 전략: 높은
// 파도도 항로를 바꾸지 못한다"(stockName="반도체") 둘 다 산업분석인데
// 투자전략(주식)으로 잘못 넘어감, 오너 지적 2026-09 — "단순히 위클리만
// 따라가면 답없다"와 같은 성격의 문제) MARKET_CONDITION_PERIOD_RE와 똑같이
// stockName이 실제 업종명일 땐 무시해야 한다. 그래서 STRATEGY_HINT_RE를
// 두 그룹으로 나눈다: STRATEGY_HINT_STRONG_RE(영문 Strategy/매크로/
// 추천종목 등, stockName과 무관하게 항상 승격)와 BARE_STRATEGY_RE(한글
// "전략" 단독, stockName이 업종명이 아닐 때만 승격 — isGenericOrBoardLabel).
const STRATEGY_HINT_STRONG_RE =
  /\bStrateg(y|ic)\b|매크로|\bMacro\b|추천종목|아웃룩|Outlook|자산배분|리밸런싱|Rebalancing|IPO\s?Brief|시장\s?전망|월간\s?전망|투자의견|Top\s?Picks?|\bFICC\b|Fixed\s?Income|고용|실업|비농업|물가|\bCPI\b|\bPPI\b|\bPCE\b|FOMC|실적\s?(상향|하향)/i;
// "포트폴리오/Portfolio"도 여기(라벨이 업종명이 아닐 때만 전략 신호) — 은행 "조달 포트폴리오의 악화"처럼 업종 리포트의
// 자금 조달·자산 구성 얘기에 걸려 투자전략으로 새던 오분류 수정(오너 지적 2026-09-26). 라벨 자체가 전략/보드 라벨이면
// (STRATEGY_HINT_RE에 포트폴리오 포함) 그대로 걸린다.
const BARE_STRATEGY_RE = /(?<!치료\s?)(?<!임상\s?)전략|포트폴리오|Portfolio/i;
// isGenericOrBoardLabel()에서 stockName 자체가 전략/보드 라벨인지 판별할
// 때는 강한 신호와 bare 전략을 합친 전체를 쓴다 — "글로벌 투자전략"처럼
// stockName 자체에 "전략"이 있으면 그건 진짜 전략 게시판이라는 뜻이라
// bare 전략도 신뢰해도 안전하다(hay 전체가 아니라 stockName만 검사하므로
// 제목에만 있는 bare 전략은 여기 안 걸림).
const STRATEGY_HINT_RE = /(?<!치료\s?)(?<!임상\s?)전략|\bStrateg(y|ic)\b|매크로|\bMacro\b|추천종목|포트폴리오|Portfolio|아웃룩|Outlook|자산배분|리밸런싱|Rebalancing|IPO\s?Brief|시장\s?전망|월간\s?전망|투자의견|Top\s?Picks?|\bFICC\b|Fixed\s?Income|고용|실업|비농업|물가|\bCPI\b|\bPPI\b|\bPCE\b|FOMC|실적\s?(상향|하향)/i;
// "Check-up"(신한 FX/Econ Check-up), "Economy/Economic Brief"(iM증권 등,
// "IPO Brief"와 충돌 안 하게 일반 Brief 단독은 안 넣음), "N주)"/"N주차"
// (키움 "키움 글로벌 키차트(9월 1주)"처럼 주차 표기가 괄호 안에만 있고
// "위클리/주간" 단어 자체는 없는 경우), "Economist"(대신증권 "AI
// Economist"), "모니터/Monitor"(대신증권 "S&P 500 분기 실적 시즌 모니터"),
// "클로징"/Closing(미래에셋 "한국&중국 마켓 클로징") 추가(오너 지적, 2026-09).
// 항상 시황을 확정하는 신호 — stockName 이 구체적 업종명이어도 이 단어들이
// 있으면 무조건 시황(모두 특정 업종 얘기가 아니라 시장 전체 마감/브리핑
// 성격이라 예외가 실측된 적이 없음).
// "마켓 뷰(9월 11일)"(미래에셋 — "마켓 클로징(9월 11일)"과 같은 날짜별
// 시황 시리즈 포맷) 추가(오너 지적, 2026-09).
// "ETF Flows"(NH "[NH투자/하재석]Weekly KR/US ETF Flows" — stockName이
// 애널리스트 바이라인("NH투자/하재석")이라 업종명이 아닌데도 이 자체만으로
// 자금흐름 집계물(시장 전체)임이 확정된다, 오너 지적 2026-09) 추가.
const MARKET_CONDITION_STRONG_RE =
  /시황|마감|브리핑|마켓레이더|모니터|\bMonitor\b|\bPMI\b|Market\s?(Radar|Pulse|Insight)\b|Check-?up|Econom(y|ic)\s?Brief|Economist|\d+주(차)?[)\s]|클로징|\bClosing\b|마켓\s?뷰|ETF\s?Flows?/i;
// "일간/위클리/주간/데일리/모닝/아침/Weekly/Daily/Morning" 같은 주기성
// 단어는 STRONG과 달리 그 자체만으로 시황을 확정하지 못한다(오너 지적,
// 2026-09 — "단순히 위클리만 따라가면 답없다") — 하나증권의 "철강금속
// Weekly"/"Battery Weekly"/"유틸리티 Weekly", IBK "IBKS Daily"(stockName
// "인터넷/게임") 등은 stockName 이 실제 업종명인 **정기 업종분석**이지
// 시장 전체 시황이 아니다(실측: 90일치 산업 카테고리에서 100건 이상
// 오분류 확인). 반대로 stockName 이 업종명이 아니라 "산업"/"시장"(수집기
// 기본값 라벨, 실제 업종을 특정 못 한 경우) 이거나, "글로벌 투자전략"처럼
// 게시판 자체가 전략/시장 라벨인 경우(개별 항목이 "Tech&Stock Weekly" 같은
// 정기물이어도 진짜 시황)엔 여전히 시황으로 확정한다 — isGenericOrBoardLabel()
// 로 이 둘을 가른다.
const MARKET_CONDITION_PERIOD_RE = /일간|위클리|주간|데일리|모닝|아침|\bWeek(ly)?\b|\bDaily\b|\bMorning\b/i;
const MARKET_CONDITION_STOCKNAMES = new Set([
  "경제분석 · Econ Signal",
  "투자전략 · Econ Signal", // 신한 월간 거시 시황(하건형, 오너 지시 2026-09-27)
  "이.글.스.", // 한화 "이번달 글로벌 스토리" 월간 글로벌 주식 전략(글로벌리서치팀) — 월간 시황(오너 지시 2026-09-27)
  "KB Global Tracker+",
  "KB데일리", // 오너 지적, 2026-09
  "상상인 US Monitor",
  // 신한투자증권 "글로벌 전략; Global Portfolio" — 거의 매 거래일 올라오는 연속
  // 시리즈(실측: 8~9월 사이 거의 매일)라 제목에 "전략"이 들어있어도 실질은
  // 일일 시황 업데이트다(오너 지적, 2026-09 — PDF 원문 확인).
  "글로벌전략",
  // 한경컨센서스(LS증권 작성) "마켓 BEAT" — 실측 2건 모두 시장 전반 코멘트
  // (오너 지적, 2026-09).
  "마켓 BEAT",
  // 키움증권 "일간증시전망" 게시판 — 매일 나오는 데일리 시황 코멘트라
  // 개별 업종 얘기가 아님(오너 지시, 2026-09-24 — "일간증시전망은 시황이다").
  "키움 일간증시전망",
  // KB증권 "KB데일리" 게시판(tab=1, categoryid 79) — 매일 나오는 데일리
  // 시황 코멘트(오너 지시, 2026-09-24 — "kb데일리는 산업분석>시황에
  // 해당한다").
  "KB데일리",
  // KB증권 "KB Asia Market Headline"(tab=4, categoryid 86, market:"ch") —
  // 거의 매일 올라오는 아시아 시장 헤드라인 코멘트, KB데일리와 같은 성격
  // (오너 지시 2026-09-24 — "kb 중국과 일본도 수집기는 만들어두고").
  "KB Asia Market Headline",
  // 삼성증권 "Daily시황"(GUBUN=daily) — 오너 지시, 2026-09-25 — "daily시황은
  // 시황으로". "국내 마감시황"은 이 라벨(market:"kr"), "미국 마감시황"은 아래
  // "삼성증권 미국 시황"(market:"us")으로 갈린다(오너 지시 — "삼성 daily 시황에서
  // 미국은 미국 시황으로 분류").
  "삼성증권 Daily시황",
  "삼성증권 미국 시황",
  // 한경 경유 → 직접 수집 전환 증권사들의 데일리 시황 게시판(오너 결정 2026-09-25,
  // 삼성증권과 같은 기준 — 데일리·시황은 시황). iM증권 Morning Brief(R_E010)는
  // 이후 게시판째 수집 제외(오너 결정 2026-09-25 — "im증권 Morning Brief는
  // 수집제외다") — 라벨은 더 이상 생성되지 않는다.
  "메리츠 Strategy Daily",
  "IBKS Daily",
  "대신증권 시황",
]);
// stockName 뒤에 " | Weekly" 같은 부가 표기가 붙어 정확히 일치하지 않는
// 경우가 있어(예: "KB Global Tracker+ | Weekly") 접두어로도 매칭(오너 지적
// 사례로 발견한 기존 누락, 2026-09).
const MARKET_CONDITION_STOCKNAME_PREFIXES = ["KB Global Tracker+"];
const MARKET_CONDITION_SOURCE_MARKETS = new Set(["LS증권:us"]);
// KB증권 "Global Insights" — 오너 지시, 2026-09("KB증권 Global Insights는
// 투자전략임"). 제목에 "전략"/Strategy 등 키워드가 없는 경우가 많아 시리즈명
// 기준으로 강제.
// "NAV Dashboard Weekly"(미래에셋 — 지주회사 NAV 할인율 스크리닝 시리즈,
// 업종 얘기가 아니라 밸류에이션 갭을 노리는 투자전략물, 오너 지적 2026-09)
// 추가.
// 키움증권 "월간증시전망"·"중장기증시전망" 게시판(오너 지시, 2026-09-24 —
// "월간증시전망은 투자전략(주식)", "중장기증시전망은 투자전략(주식)이다").
const STRATEGY_STOCKNAMES = new Set([
  "신한 해외주식 탑픽", // 신한 월간 해외주식 탑픽 10선 — 투자전략(주식)(오너 지적 2026-09-27)
  "한화 해외주식 전략", // 한화 해외주식분석 게시판의 종목·업종 없는 미국·중국 시장 노트 — "호르무즈보다 중요한 건 유동성"·"미중 정상회담: 높아질 기대, 숨 고를 증시"(오너 지적 2026-09-27)
  "Now Japan 시리즈", // 삼성증권 일본 시장 시리즈 — "10월, 新 TOPIX 시대 개막"(오너 지적 2026-09-27)
  "Global Insights",
  "Global Watchlist",
  "마켓픽",
  "NAV Dashboard Weekly",
  "키움 월간증시전망",
  "키움 중장기증시전망",
  // KB증권 "KB 전략" 게시판(tab=3, "한국 투자 > 주식전략") — 오너 지시,
  // 2026-09-24 — "한국투자에서 kb전략은 투자전략(주식)에 해당된다".
  "KB 전략",
  // 삼성증권 "투자전략"(GUBUN=market)·"SPOT코멘트(전략)"(GUBUN=spot1) — 오너
  // 지시, 2026-09-25 — "투자전략은 투자전략(주식)으로", "spot코멘트(전략)은
  // 투자전략(주식)으로".
  "삼성증권 투자전략",
  "삼성증권 SPOT코멘트(전략)",
  // 삼성증권 "이슈리포트"(GUBUN=issue) — 오너 지시, 2026-09-25.
  "삼성증권 이슈리포트",
  // 한경 경유 → 직접 수집 전환 증권사들의 투자전략 게시판(오너 결정 2026-09-25 —
  // 삼성증권과 같은 기준, 투자전략은 투자전략(주식)).
  "iM증권 투자전략",
  "메리츠 투자전략",
  "IBK 투자전략",
  "대신증권 투자전략",
  "한화 투자전략",
  // BNK투자증권 금융시장 게시판의 "甲論乙駁"(주식시장 코멘트) — 오너 지시 2026-09-26.
  "BNK 甲論乙駁",
  // 한화 [해외시황](박제인) 기본은 투자전략 — 채권 관련 글만 "한화 해외시황 채권"(이슈분석)으로 수집기가 바꾼다(오너 지시 2026-09-27).
  "한화 해외시황",
]);
// 미래에셋증권 "월스트리트파인더 Ep.201, 202, ..." — 매회 에피소드 번호가
// 붙어 정확히 일치하지 않아 접두어로 매칭. 계절성·금리 대응·엔비디아
// 내러티브 등 시장 전반 투자 아이디어 시리즈(오너 확인, 2026-09).
// DS투자증권 "거버넌스 - 베어허그 시리즈 N" — 특정 업종이 아니라 상법개정·
// 지배구조 개혁 테마 투자전략 시리즈(오너 지적, 2026-09).
const STRATEGY_STOCKNAME_PREFIXES = [/^월스트리트파인더/, /^거버넌스/];
// 한국투자증권 "전략/이슈 리포트" 게시판(collect-kis-strategy-research.mjs,
// jkGubun=6) 라벨들 — 처음엔 전부 시황으로 강제했으나(오너 지시, "한국투자는
// 시황으로 분류"), 이후 "위클리, 데일리 등이 아니면 투자전략이다"로 정정됨
// (오너 지시, 2026-09) — "채권분석 Note"/"경제분석 Note" 등은 "전략" 텍스트가
// 없어 STRATEGY_HINT_RE 에 안 걸리므로, 이 라벨들만 기본값을 투자전략으로
// 깔아준다. MARKET_CONDITION_STRONG_RE(마감/브리핑 등) 검사가 이보다 먼저
// 실행되므로 실제로 시황성이면 여전히 먼저 걸러진다 — 이 세트는 "그 외엔
// 전부 투자전략"만 담당. "대체투자 Note"는 여기서 제외됐다 — 수집기
// (collect-kis-strategy-research.mjs)에서 아예 수집을 건너뛴다(오너 지시,
// 2026-09 — "대체투자는 제외하자", NH FICC 게시판의 대체투자/부동산 제외와
// 같은 취지).
const KIS_STRATEGY_DEFAULT_STOCKNAMES = new Set([
  "채권분석 Note",
  "경제분석 Note",
  "투자전략Note",
  "자산배분전략 Note",
  "글로벌전략 Note",
  "전략/이슈",
]);
// 투자전략을 다시 주식/채권으로 나눈다(오너 지시, 2026-09 — "투자전략도
// 분리하자 투자전략(주식) 투자전략(채권)" + "크레딧, 채권, 금리 등은
// 투자전략(채권)으로 분류"). "FICC"는 일부러 뺐다 — NH FICC 게시판 수집기가
// stockName에 항상 "FICC · " 접두어를 붙이는데(투자전략 키워드 유지 목적),
// 이 키워드까지 여기 넣으면 디지털자산·리츠 같은 FICC 하위 항목까지 전부
// 채권으로 쓸려버린다(오너 지적, 2026-09 — "로빈후드에 이어 블록체인을
// 출시하는 써클"은 투자전략(주식)이어야 함). 실제 크레딧/채권/금리 언급
// 여부로만 판정.
// "채권"은 "연체채권"(부실채권 등 대출채권)·"매출채권"(외상매출금) 처럼
// 채권(bond)과 무관한 여신·회계 용어에도 부분일치한다(실측 — 은행 연체율
// 리포트가 "연체채권"의 "채권" 때문에 투자전략(채권)으로 잘못 넘어감, 오너
// 지적 2026-09 "내용을 보면 주식과 채권인지 구분이 안되냐?"). 그 앞에
// "매출"/"연체"/"부실"이 오거나 뒤에 "단"/"자"/"회수"/"추심"이 붙는(채권단
// ·채권자·채권회수·채권추심 — 전부 대출채권 문맥) 경우는 제외.
// "국채"(채권과 별개 합성어라 "채권" 부분문자열 매칭에 안 걸림), "중앙은행"/
// "Central Bank"(통화정책 자체가 FICC의 금리 데스크 영역) 추가(오너 지적,
// 2026-09 — "안전자산으로서의 가치를 의심받는 국채..."·"Central Bank Working
// Paper" 둘 다 투자전략(채권) 누락 확인).
// 미국 고용·물가 지표 발표 코멘트("8월 고용", "미국 8월 CPI" 등)는 실측
// 다수(오너 확인)가 전부 투자전략(채권)이었다 — Fed 금리 결정에 직결되는
// 지표라 채권 데스크 소관으로 본다. "FOMC" 자체는 주식/채권 둘 다 될 수
// 있어(나스닥 반응 vs 금리 코멘트) 여기엔 안 넣음 — STRATEGY_HINT_RE에서만
// 승격 신호로 쓰고, 실제 채권 여부는 이 정규식의 다른 키워드로 판정.
// 미국 매크로 지표 발표 코멘트는 종류를 가리지 않고 실측상 전부 채권 데스크
// 소관이었다(오너 지적 다수, 2026-09) — 고용/물가류에 이어 "소매판매"/GDP도
// 추가. 예외: PMI/ISM 은 시황으로 확정됐으므로(오너 지적) 여기 넣지 않음.
// "CPI(무색폴리이미드)" 처럼 소재 산업 리포트가 CPI 를 화학 소재 약어로 쓴
// 사례가 실측돼(오너 지적, 2026-09) CPI/PPI/PCE 뒤에 괄호가 바로 오면
// (통상 약어 설명 패턴) 제외.
//
// 두 그룹으로 나눈다(오너 지적, 2026-09 — 위 두 사례 모두 "채권" 판정이
// 요약문 전체에서 단어 하나만 보고 내려짐): "크레딧/채권/국채/부채" 등은
// 채권 얘기가 아니면 거의 안 쓰는 강한 신호라 항상 적용. "금리/고용/물가/
// GDP/CPI" 등은 주식 전략 코멘트에도 배경 설명으로 흔히 등장하는 약한
// 매크로 신호라(실측: "반도체 위주의 주식시장 상승 기대"의 배경으로 "금리
// 급등"만 언급된 SK증권 코멘트, "국내주식전략"이 stockName인 신한 M.R.I가
// "금리·유가 매크로 불안"을 배경으로 언급 — 둘 다 투자전략(주식)이어야
// 하는데 이 약한 신호만으로 투자전략(채권)으로 잘못 넘어감) stockName이
// 구체적 업종/종목이 아닌 경우(isGenericOrBoardLabel)에만, 그리고 본문에
// 명시적 주식 신호(코스피/코스닥/나스닥/주식 등)가 없을 때만 채권으로 본다.
// "ECB"(유럽중앙은행) 추가 — "중앙은행"/"Central Bank" 처럼 일반 단어가
// 아니라 특정 기관명이라 별도로 안 걸림(오너 지적, 2026-09 — "ECB, 인상
// 사이클 연장" 누락 확인).
const BOND_STRONG_RE =
  /(?<!매출)(?<!연체)(?<!부실)채권(?!단|자|회수|추심)|크레딧|국채|부채|Beige\s?Book|\bCredit\b|\bBond\b|\bDebt\b|Fixed\s?Income/i;
// "환율"(FX) 추가 — 한국투자증권 "경제분석 Note" 환율 FAQ 사례가 채권/
// FICC 데스크 소관인데 신호가 없어 투자전략(주식)으로 잘못 넘어감(오너
// 지적, 2026-09).
const BOND_MACRO_RE =
  /금리|중앙은행|통화정책|고용|실업|비농업|물가|소매판매|환율|\bCPI\b(?!\()|\bPPI\b(?!\()|\bPCE\b(?!\()|\bGDP\b|Retail\s?Sales|\bRate[s]?\b|Central\s?Bank|Monetary\s?Policy|\bECB\b/i;
// "코스피/코스닥/나스닥" 등 지수명 자체가 이미 주식시장 얘기라는 강한 신호
// (오너 지적, 2026-09). 한글 표기뿐 아니라 리포트에 흔한 영문 표기(KOSPI/
// KOSDAQ/NASDAQ)도 포함.
const EQUITY_HINT_RE =
  /주식|증시|코스피|코스닥|나스닥|다우|\bKOSPI\b|\bKOSDAQ\b|\bNASDAQ\b|S&P\s?500|\bEquity\b|\bStock\b/i;
// source 자체가 "FRB"(연방준비제도)면 내용이 뭐든 채권/통화정책 자료다
// ("FOMC Minutes"처럼 본문에 흔한 채권 키워드가 하나도 없는 경우 있음,
// 오너 지적 2026-09).
const BOND_SOURCES = new Set(["FRB"]);

/**
 * 해외 IB/자산운용사 리서치 5곳(오너 지시, 2026-09-19 — 골드만삭스·JP모간·
 * 모간스탠리·블랙록·PIMCO 추가 후 "산업분석탭에서 빼서... 인사이트 탭
 * 만들자"). 이 소스들은 국내 산업분석/투자전략/시황 분류 체계(`classify
 * ResearchTopic()`)가 애초에 안 맞는 성격이라(예: 블랙록 stockName
 * "글로벌 위클리 시황"이 문자 그대로 "시황"에 걸려 14일 만에 삭제되던 문제)
 * `getIndustryResearch()`(산업분석 탭)·정리 로직 양쪽에서 전부 제외하고,
 * `getInsightResearch()`(인사이트 탭)에서만 별도로 90일 그대로 유지한다.
 *
 * **국내는 "키움증권 비상장리서치"로 대체(오너 지시, 2026-09-24 — "국내는
 * 인사이트가 없다. 따라서 미국은 유지하나 한국은 인사이트를 비상장 리서치로
 * 대체한다")**: 위 10곳은 전부 해외(market:"us") 소스뿐이라 국내(market:"kr")
 * 인사이트 탭은 늘 비어 있었다 — 대신 키움증권 CI(산업분석) 게시판 중
 * "회사명(비상장-IPO예정) : 헤드라인" 형식(상장 종목이 아니라 프리IPO
 * 기업 리포트)을 이 소스로 별도 전송해 같은 인프라를 국내 시장에도 채운다
 * (`scripts/collect-kiwoom-research.mjs`). market이 "kr"이라 위 해외
 * 소스들의 market:"us" 조회와 자연히 분리되고, `getIndustryResearch()`의
 * `INSIGHT_SOURCES` 제외 로직 덕분에 일반 산업분석(source:"키움증권") 풀에도
 * 안 섞인다.
 */
export const INSIGHT_SOURCES = [
  "BlackRock",
  "Goldman Sachs",
  "J.P. Morgan",
  "Morgan Stanley",
  "PIMCO",
  "BNP Paribas",
  "Citigroup",
  "Bank of America Institute",
  "HSBC",
  "Deutsche Bank Research",
  "키움증권 비상장리서치",
  // KB증권 "KB IPO Brief"("산업/기업 > 스몰캡")·"비상장 Tracker+"/"케이비
  // 비상장 플러스"("산업/기업 > 비상장기업") — 오너 지시, 2026-09-24 —
  // "IPO나 비상장인 경우는 종목분석>인사이트에 해당한다". 키움과 같은 패턴.
  "KB증권 비상장리서치",
  // NH투자증권 "[NH 비상장]" 라벨(기업/산업분석 게시판) — 오너 지시,
  // 2026-09-24 — "국내 비상장은 종목분석 인사이트로 해외 비상장은 그대로
  // 산업분석으로 유지"(국내(market:"kr")만 인사이트 대상, 삼성증권의 해외
  // (market:"us") 비상장 콘텐츠는 그대로 산업분석 유지 — 손대지 않음).
  "NH투자증권 비상장리서치",
  "신한투자증권 비상장리서치",
  // 삼성증권 국내기업·국내산업 게시판의 비상장 글("BPMG (비상장): …",
  // "비상장 위클리 업데이트") — 위와 같은 국내 비상장 규칙(2026-09-25).
  "삼성증권 비상장리서치",
  // 한화투자증권 해외주식분석의 상장 전 기업 리포트("[IPO 101] [스페이스X]") — 미국·중국 비상장(오너 지시 2026-09-27).
  "한화투자증권 비상장리서치",
] as const;

/**
 * 비상장 리서치 source 판별 — 시장과 무관하다(오너 지시 2026-09-27 — "미국과 중국도 비상장을 추가한다").
 * 같은 source 이름을 시장별로 재사용한다(예: "삼성증권 비상장리서치"는 kr·us·ch 모두). 화면은 미국에서 인사이트(해외 IB)와
 * 비상장을 별도 탭으로 나눠 보여주므로 이 접미어로 두 그룹을 가른다.
 */
export const isUnlistedSource = (source: string): boolean => /비상장리서치$/.test(source);

/**
 * "해외리서치" — 산업분석 탭의 새 세그먼트(오너 지시, 2026-09-19 —
 * "goldman-sachs-research는 산업분석으로 이동하는데 시황 오른쪽에
 * 해외리서치라고 분류추가해서... video는 제외다... 정리하면 2개는 제외
 * 3개는 인사이트 1개는 산업분석이다"). 골드만삭스 인사이트 하위 7개
 * 경로(articles/goldman-sachs-research/top-of-mind/the-markets/
 * goldman-sachs-exchanges/videos/talks-at-gs) 중 영상 2종(videos,
 * talks-at-gs)은 제외, 텍스트 3종(articles/top-of-mind/the-markets +
 * goldman-sachs-exchanges)은 `INSIGHT_SOURCES`의 "Goldman Sachs"로 계속
 * 인사이트 탭, 리서치 노트 1종(goldman-sachs-research)만 `source: "Goldman
 * Sachs Research"`로 구분해 이 분류를 탄다 — `getIndustryResearch()`가
 * `INSIGHT_SOURCES`만 걸러내므로 이 소스는 자동으로 산업분석 탭 조회에
 * 포함되고, `classifyResearchTopic()`이 이 소스면 무조건 "해외리서치"로
 * 분류한다(다른 국내 분류 로직 우회). 백필·보존기간만 180일로 다른 산업
 * 분석(90일)보다 길게 둔다(오너 지시 — "여기만 백필기간을 180일로").
 */
export const FOREIGN_RESEARCH_SOURCES = ["Goldman Sachs Research", "BlackRock Research"] as const;

function isStrategyStockname(stockName: string): boolean {
  if (STRATEGY_STOCKNAMES.has(stockName)) return true;
  return STRATEGY_STOCKNAME_PREFIXES.some((re) => re.test(stockName));
}

function isMarketConditionStockname(stockName: string): boolean {
  if (MARKET_CONDITION_STOCKNAMES.has(stockName)) return true;
  return MARKET_CONDITION_STOCKNAME_PREFIXES.some((p) => stockName.startsWith(p));
}

/**
 * stockName 이 실제 업종/종목명이 아니라 "산업"/"시장"(수집기 기본값,
 * 업종을 못 뽑았을 때) 이거나, 게시판 자체가 전략/시장 라벨(STRATEGY_HINT_RE
 * 매치, 예: "글로벌 투자전략")인 경우 true. 이럴 땐 주기성 키워드나 약한
 * 매크로 신호만으로도 시황/투자전략 판정을 신뢰할 수 있지만, false(=구체적
 * 업종명)면 정기 업종분석일 가능성이 높아 그 신호들을 무시한다.
 *
 * stockName만 검사한다(hay=stockName+title 전체가 아님) — 제목에만 있는
 * bare "전략"까지 여기 걸리면 "반도체"(stockName) + "9월 전략: …"(title)
 * 같은 순수 업종 리포트가 전부 "보드 라벨"로 오인된다(실측, 오너 지적
 * 2026-09). stockName 자체에 전략 관련 단어가 있으면("글로벌 투자전략" 등)
 * 그건 진짜 게시판 라벨이라는 뜻이라 안전하게 걸어도 된다.
 * KIS_STRATEGY_DEFAULT_STOCKNAMES("경제분석 Note" 등)도 업종명이 아니라
 * 게시판 라벨이라 포함 — 안 그러면 이 라벨들은 bond 약한 신호(환율/금리
 * 등)가 EQUITY_HINT_RE 억제 없이도 무시돼버린다(실측: "경제분석 Note" +
 * "환율 관련 FAQ" 가 투자전략(채권)이어야 하는데 투자전략(주식)으로 새던
 * 문제, 오너 지적 2026-09).
 */
/**
 * stockName 이 "제약/바이오 산업"처럼 **업종명**으로 보이는가.
 *
 * 수집기에 따라 stockName 과 title 에 같은 업종명을 넣는 소스가 있다(KB증권
 * 산업 리포트 등). 그래서 "stockName === title" 만으로 게시판 기본 라벨이라고
 * 보면 멀쩡한 업종 리포트가 generic 으로 취급돼, 요약문에 우연히 섞인 지수명
 * 하나로 투자전략으로 넘어간다(실측·오너 지적 2026-09-22 — KB증권 "제약/
 * 바이오 산업"이 투자전략(주식)으로 분류됨. 요약이 "자료: Bloomberg, KB증권
 * / 주: 1M 이전 종가 기준 NASDAQ 1M 1.14%" 라는 표 각주였는데 거기 있는
 * NASDAQ 이 EQUITY_HINT_RE 에 걸렸다).
 */
const SECTOR_LABEL_TAIL_RE = /(산업|업종|섹터)$/;
function looksLikeSectorLabel(stockName: string): boolean {
  const s = stockName.trim();
  if (!s) return false;
  if (SECTOR_LABEL_TAIL_RE.test(s)) return true;
  // 업종명은 짧고, 문장이 아니고, 숫자를 안 쓴다 — 헤드라인이 통째로
  // stockName 에 들어온 경우(그건 진짜 라벨 없음)와 시리즈명(한국투자증권
  // "해외주식369" 처럼 회차 번호가 붙는다, 실측)을 이걸로 걸러낸다.
  return (
    s.length <= 12 && !/\d/.test(s) && !/[.!?:·…]|\s{2,}/.test(s) && s.split(/\s+/).length <= 2
  );
}

function isGenericOrBoardLabel(doc: { stockName: string; title: string }): boolean {
  if (!doc.stockName || doc.stockName === "산업" || doc.stockName === "시장") return true;
  if (doc.stockName === doc.title && !looksLikeSectorLabel(doc.stockName)) return true;
  if (KIS_STRATEGY_DEFAULT_STOCKNAMES.has(doc.stockName)) return true;
  return STRATEGY_HINT_RE.test(doc.stockName);
}

function isBond(doc: { stockName: string; title: string }, hayWithSummary: string): boolean {
  if (BOND_STRONG_RE.test(hayWithSummary)) return true;
  return isGenericOrBoardLabel(doc) && BOND_MACRO_RE.test(hayWithSummary) && !EQUITY_HINT_RE.test(hayWithSummary);
}

const LABEL_FIRST_STRATEGY_STOCKNAMES = new Set<string>(["삼성증권 투자전략"]);

function classifyLegacyTopic(
  doc: Pick<ShinhanResearchDoc, "stockName" | "title" | "source" | "market" | "summary">,
): LegacyResearchTopic {
  if ((FOREIGN_RESEARCH_SOURCES as readonly string[]).includes(doc.source)) return "해외리서치";
  if (isMarketConditionStockname(doc.stockName)) return "시황";
  if (MARKET_CONDITION_SOURCE_MARKETS.has(`${doc.source}:${doc.market}`)) return "시황";
  const hay = `${doc.stockName ?? ""} ${doc.title}`;
  // 채권 판정만 요약(summary)까지 넓혀 본다("Econ Guide" 라벨 + 제목엔 채권
  // 신호가 전혀 없고 요약에만 "국채"/"장기금리"가 있던 사례, 오너 지적,
  // 2026-09) — STRATEGY_HINT_RE·MARKET_CONDITION_STRONG_RE는 제목/라벨만
  // 본다(전략/시황 같은 범용 단어는 일반 산업분석 요약문에도 흔히 섞여
  // 나와 요약까지 넓히면 진짜 산업분석까지 오분류할 위험이 큼 — 채권
  // 키워드는 상대적으로 금융 용어라 그 위험이 작음).
  const hayWithSummary = `${hay} ${doc.summary ?? ""}`;
  if (BOND_SOURCES.has(doc.source)) return "투자전략(채권)";
  // 라벨 우선(오너 지시 2026-09-27): 삼성증권 "투자전략(market)" 게시판 글은 제목에 금리·채권 단어가 있어도(예: "업종 및 종목의 금리 민감도")
  // 게시판이 곧 분류라 항상 투자전략(주식)이다. 다른 증권사 투자전략 라벨은 기존대로 채권 여부를 따진다.
  if (LABEL_FIRST_STRATEGY_STOCKNAMES.has(doc.stockName)) return "투자전략(주식)";
  if (isStrategyStockname(doc.stockName)) return isBond(doc, hayWithSummary) ? "투자전략(채권)" : "투자전략(주식)";
  if (MARKET_CONDITION_STRONG_RE.test(hay)) return "시황";
  const generic = isGenericOrBoardLabel(doc);
  if (MARKET_CONDITION_PERIOD_RE.test(hay) && generic) return "시황";
  // 강한 채권 신호는 항상, 약한 매크로 신호·명시적 주식 신호는 stockName이
  // 구체적 업종이 아닐 때만 투자전략 승격 신호로 쓴다("미국 10년물 금리
  // 5%의 시험대"처럼 STRATEGY_HINT_RE 쪽 키워드가 없는 순수 채권·금리
  // 코멘트, "우리는 이 게임을 해본 적이 있다"처럼 반도체·주식시장 얘기인데
  // 배경으로 "금리"만 잠깐 나오는 순수 주식 코멘트 둘 다 승격 자체가 안 돼
  // 산업분석으로 새던 문제, 오너 지적, 2026-09).
  const bondStrong = BOND_STRONG_RE.test(hayWithSummary);
  const bondMacro = generic && BOND_MACRO_RE.test(hayWithSummary);
  const equitySignal = generic && EQUITY_HINT_RE.test(hayWithSummary);
  const bond = bondStrong || (bondMacro && !equitySignal);
  // bare "전략"은 stockName이 업종명이 아닐 때만(generic) 승격 신호로 쓴다 —
  // 영문 Strategy/매크로 등 강한 신호는 항상.
  if (
    STRATEGY_HINT_STRONG_RE.test(hay) ||
    (generic && BARE_STRATEGY_RE.test(hay)) ||
    bondStrong ||
    bondMacro ||
    equitySignal ||
    KIS_STRATEGY_DEFAULT_STOCKNAMES.has(doc.stockName)
  ) {
    return bond ? "투자전략(채권)" : "투자전략(주식)";
  }
  return "산업분석";
}

// FX 판정(오너 지시 2026-09-26) — scripts/lib/exclude-filters.mjs의
// isFxContent()·구 macro-issues.ts의 escalateToFxTopic()과 같은 정규식.
// 배제가 아니라 분류라 research-exclude.ts로 옮기지 않고 이 파일에 로컬로
// 둔다(이 파일의 다른 분류용 정규식 BOND_STRONG_RE 등과 같은 관례).
const FX_RE =
  /\bFX\b|환율|엔화|달러화|위안화|유로화|파운드화|원화\s*(?:강세|약세|절상|절하)|달러[-\s]?엔|달러\s*인덱스|\bDXY\b/i;
// 시황분석 Daily/Monthly 분기(오너 지시 2026-09-26 — "Daily는 일간, 데일리,
// 모닝브리프 등을 분류, Monthly는 월간, month 등을 분류"). 기본값은 Daily —
// 기존 "시황" 판정 자체가 이미 데일리성 신호(MARKET_CONDITION_STRONG_RE·
// PERIOD_RE)로 확정된 것들이라 Monthly만 명시적으로 가르면 된다.
const MARKET_CONDITION_MONTHLY_RE = /월간|\bmonth\b|이\.글\.스\.|Econ\s?Signal/i;

// macro_issues에서 흡수한 콘텐츠 중 "게시판 코드가 topic을 확정"하던
// 것들(제목 텍스트만으론 이슈분석/환율분석이 안 갈리는 경우)을 위한 고정
// 라벨 강제 분류 — MARKET_CONDITION_STOCKNAMES/STRATEGY_STOCKNAMES와 같은
// 패턴(오너 지시 2026-09-26). 대부분의 이관 콘텐츠는 제목에 채권/금리/환율
// 신호가 실제로 있어 기존 휴리스틱(classifyLegacyTopic)만으로도 자연스럽게
// "투자전략(채권)"으로 걸린 뒤 아래 FX_RE로 갈라지지만, 제목만으론 신호가
// 약한 고정 시리즈(예: "KB Bond"·"KB Fed Watch"·키움 SI/FE 게시판)는 여기
// 등록해 안전망으로 확정한다.
const FORCED_ISSUE_STOCKNAMES = new Set([
  "신한 채권전략",
  "신한 경제",
  "Macro Week Ahead",
  "Weekly Economic Issue",
  "Market Issue",
  "투자전략 · 자산가격 메커니즘 변화",
  "투자전략 · 자산가격 매커니즘 변화",
  "KB Bond",
  "KB Fed Watch",
  "KB 자산배분매크로",
  "키움 이슈분석",
  "삼성증권 경제",
  "삼성증권 채권",
  "삼성증권 원자재",
  "iM증권 경제분석",
  "iM증권 채권",
  "iM증권 원자재",
  "메리츠 경제분석",
  "메리츠 채권분석",
  "메리츠 원자재",
  "IBK 경제",
  "IBK 원자재",
  "대신증권 매크로",
  "대신증권 원자재",
  "한화 국내외경제",
  "한화 채권전략",
  "한화 원자재",
  "유안타 경제분석",
  "유안타 해외전략",
  "유안타 원자재",
  "상상인 경제",
  "상상인 채권",
  "상상인 원자재",
  "LS TGIF",
  "DS 경제", // DS투자증권 "[DS 경제 서동화] Macro Issue …" 경제 담당 시리즈 — 이슈분석(경제)(오너 지시 2026-09-27)
  "키움 중국 경제", // 키움 중국/신흥국(CH) 게시판 "[중국은 지금]" 중국 거시 시리즈 — 이슈분석(경제)(오너 지시 2026-09-27)
  "한화 해외시황 채권", // 한화 [해외시황] 중 채권·회사채·크레딧 내용 — 이슈분석(채권). 기본(채권 아님)은 STRATEGY_STOCKNAMES 의 "한화 해외시황"
  "BNK 금융시장",
  // macro_issues 컬렉션 이관(scripts/migrate-macro-issues.mjs) 중 알려진 소스
  // (키움증권·KB증권) 매핑에 없는 예상 밖 source 가 나올 때만 쓰는 안전망.
  "이슈분석",
]);
const FORCED_FX_STOCKNAMES = new Set([
  "KB 자산배분매크로 FX",
  "키움 환율분석",
  "삼성증권 경제 FX",
  "삼성증권 채권 FX",
  "삼성증권 원자재 FX",
  "iM증권 경제분석 FX",
  "iM증권 채권 FX",
  "iM증권 원자재 FX",
  "메리츠 경제분석 FX",
  "메리츠 채권분석 FX",
  "메리츠 원자재 FX",
  "IBK 경제 FX",
  "IBK 원자재 FX",
  "대신증권 매크로 FX",
  "대신증권 원자재 FX",
  "한화 국내외경제 FX",
  "한화 채권전략 FX",
  "한화 원자재 FX",
  "유안타 경제분석 FX",
  "유안타 해외전략 FX",
  "유안타 원자재 FX",
  "상상인 경제 FX",
  "상상인 채권 FX",
  "상상인 원자재 FX",
  "환율분석", // macro_issues 이관 안전망(위 "이슈분석"과 동일 취지).
]);

/**
 * 공개 분류 함수 — classifyLegacyTopic()의 결과를 새 taxonomy로 리매핑한다.
 * 레거시 휴리스틱 자체는 절대 건드리지 않는다(오너 지시 — 실측 이력이 많은
 * 잘 튜닝된 로직).
 */
export function classifyResearchTopic(
  doc: Pick<ShinhanResearchDoc, "stockName" | "title" | "source" | "market" | "summary">,
): ResearchTopic {
  if (FORCED_ISSUE_STOCKNAMES.has(doc.stockName)) return "이슈분석";
  if (FORCED_FX_STOCKNAMES.has(doc.stockName)) return "환율분석";
  // 신한 경제분석 게시판(gieconomy)의 비시리즈 글 — 다른 증권사 경제·채권 게시판과 같이 게시판이 곧 이슈분석이다. 제목 키워드에만 맡기면
  // 키워드가 없는 글("한국 7월 산업활동동향" 등)이 산업분석 기타로 새었다(2026-09-27). 환율 글만 환율분석으로 가른다.
  if (doc.stockName === "경제분석 · 경제분석") return FX_RE.test(doc.title) ? "환율분석" : "이슈분석";
  const legacy = classifyLegacyTopic(doc);
  switch (legacy) {
    case "산업분석":
      return "산업분석";
    case "해외리서치":
      return doc.market === "kr" ? "비상장" : "글로벌IB";
    case "투자전략(채권)": {
      const hay = `${doc.stockName ?? ""} ${doc.title}`;
      return FX_RE.test(hay) ? "환율분석" : "이슈분석";
    }
    case "투자전략(주식)":
      return "시황분석:투자전략";
    case "시황": {
      const hay = `${doc.stockName ?? ""} ${doc.title}`;
      return MARKET_CONDITION_MONTHLY_RE.test(hay) ? "시황분석:Monthly" : "시황분석:Daily";
    }
  }
}

/**
 * 산업분석 리포트(종목 무관, `symbol: null`) — 시장 전체용 화면
 * (`/[market]/research`)에서 사용. `getShinhanResearchBySymbol`(종목별
 * 기업분석)과 달리 symbol 로 좁히지 않고 market+category="산업"으로만
 * 조회한다.
 *
 * **전면 개편(오너 지시 2026-09-26)**: 이 탭은 이제 "산업분석"·"글로벌IB"
 * 두 토픽만 다룬다 — 시황·투자전략·이슈분석·환율분석·비상장은 완전히
 * 제거해 각자의 전용 함수(`getMacroIssueResearch`·`getMarketConditionResearch`)
 * 로 옮겼다("산업분석 탭에서 완전히 제거"). `topic`을 주면
 * classifyResearchTopic() 기준으로 한 번 더 걸러낸다.
 */
export async function getIndustryResearch(
  market: MarketId,
  limit = 30,
  topic?: "산업분석" | "글로벌IB",
): Promise<ShinhanResearchDoc[]> {
  const col = await shinhanResearchCol();
  // "글로벌IB"는 국내 고빈도 소스들과 같은 900건 풀에서 걸러내면 밀려서
  // 안 보일 수 있어(실측 — 8건 중 2건만 노출됨) source로 직접 좁혀 조회.
  // 90일 보존(GLOBAL_IB_MAX_AGE_MS)에 맞춰 볼륨이 원래 적어 별도 페이지네이션
  // 없이 바로 반환해도 된다.
  if (topic === "글로벌IB") {
    const docs = await col
      .find({
        market,
        category: "산업",
        pdfUrl: { $ne: null },
        source: { $in: FOREIGN_RESEARCH_SOURCES as unknown as string[] },
      })
      .sort({ date: -1 })
      .limit(limit * 3)
      .toArray();
    return dedupeBySourceTitle(docs).slice(0, limit);
  }
  // topic 유무와 무관하게 항상 넉넉히 가져온다(오너 지적, 2026-09 — "전체는
  // 129개인데 산업분석만 150개로 표시되고... 머가맞는건가?").
  const fetchLimit = Math.max(limit * 6, 200);
  // pdfUrl 이 없으면 화면에서 클릭할 게 없어 조회 단계에서 제외한다(오너
  // 지적, 2026-09 — "링크가 없다 링크안되면 삭제다").
  const docs = await col
    .find({ market, category: "산업", pdfUrl: { $ne: null }, source: { $nin: INSIGHT_SOURCES as unknown as string[] } })
    .sort({ date: -1 })
    .limit(fetchLimit)
    .toArray();
  // 공통 제외(리츠·ETF/ETP·ESG·주간물·일정표·추천종목·원자재 외 대체투자,
  // 오너 지시 2026-09-25) — 이미 쌓인 문서에 함께 적용, 수신 라우트가 새
  // 문서는 이미 거른다.
  const withoutEsg = docs.filter(
    (d) => !isCommonExcludedResearch(`${d.stockName} ${d.title}`, d.category ?? "기업"),
  );
  const deduped = dedupeBySourceTitle(withoutEsg);
  // 이 탭은 "산업분석"·"글로벌IB"만 다룬다 — 나머지 토픽(이슈분석·환율분석·
  // 시황분석·비상장)은 여기서 완전히 제외한다(오너 지시 — "완전히 제거").
  const scoped = deduped.filter((d) => {
    const t = classifyResearchTopic(d);
    return t === "산업분석" || t === "글로벌IB";
  });
  const filtered = topic ? scoped.filter((d) => classifyResearchTopic(d) === topic) : scoped;
  return filtered.slice(0, limit);
}

/**
 * 거시경제 "이슈분석"/"환율분석" 탭 — `/macro/issues`, `/macro/fx`. 원래
 * `macro_issues` 별도 컬렉션에서 읽었으나 오너 지시(2026-09-26 —
 * "macro_issues를 kr_research로 흡수")로 kr_research에서 classifyResearchTopic()
 * 결과를 기준으로 조회한다. market 구분이 없다(국내 매크로 코멘트 성격이라
 * 원래도 시장 무관).
 */
export type IssueKind = "경제" | "채권";

// 이슈분석 탭의 "경제/채권" 구분(오너 지시 2026-09-27 — 전체/증권사명 → 전체/경제/채권). 라벨(stockName)에
// 채권·Bond·크레딧·Fixed Income 이 있거나 제목에 채권·국채·회사채·크레딧·스프레드가 있으면 채권, 그 외(경제·원자재·
// 통화정책 등 거시)는 경제. FOMC·금리 인상 같은 통화정책은 경제로 둔다(채권 리포트는 라벨/제목에 채권 계열 단어가 있음).
const ISSUE_BOND_LABEL_RE = /채권|Bond|크레딧|Credit|Fixed\s?Income|\bFICC\b/i;
const ISSUE_ECON_LABEL_RE = /경제|매크로|Macro|원자재|Econ/i;
const ISSUE_BOND_TITLE_RE = /Fixed\s?Income|채권|국채|회사채|크레딧|Credit|\bBond|Treasur|스프레드|\bSpread/i;
/**
 * 라벨(증권사 게시판 이름)이 우선이다(오너 지시 2026-09-27 — "iM증권 채권은 채권", "한화 채권전략은 채권"): 라벨에 채권 계열 단어면 채권,
 * 경제·매크로·원자재 계열이면 경제. 라벨이 "산업"·"시장"·"글로벌 인사이트"처럼 뭉뚱그려졌을 때만 제목의 채권 계열 단어로 판정한다.
 */
// 경제 지표 해설과 금리·국채 코멘트가 한 라벨에 섞여 올라오는 게시판 — 라벨 우선이 아니라 제목의 채권 계열 단어로 가른다
// (오너 지적 2026-09-27 — 대신증권 "매크로"에 "국채 발행, 물량 만큼 만기도 중요하다"·"버틸만한 장기금리 5%" 같은 채권 글이 경제에 섞임).
// FOMC·기준금리 인상 같은 통화정책 글은 경제로 둔다(장·단기금리·국채·만기·입찰 등 채권시장 단어가 있을 때만 채권).
// 라벨에 "Macro"가 있어 경제로 읽히지만 채권 콘텐츠인 시리즈(미래에셋 "Macro Week Ahead" — 오너 지시 2026-09-27 "채권으로 분류")
const BOND_ISSUE_LABELS: ReadonlySet<string> = new Set(["Macro Week Ahead"]);
const MIXED_ISSUE_LABELS: ReadonlySet<string> = new Set(["대신증권 매크로"]);
const MIXED_BOND_TITLE_RE = /채권|국채|회사채|크레딧|스프레드|장기\s?금리|단기\s?금리|만기|입찰|\bBond|Credit|Treasur/i;
export function classifyIssueKind(doc: Pick<ShinhanResearchDoc, "stockName" | "title">): IssueKind {
  const label = doc.stockName ?? "";
  if (BOND_ISSUE_LABELS.has(label)) return "채권";
  if (MIXED_ISSUE_LABELS.has(label)) return MIXED_BOND_TITLE_RE.test(doc.title ?? "") ? "채권" : "경제";
  if (ISSUE_BOND_LABEL_RE.test(label)) return "채권";
  if (ISSUE_ECON_LABEL_RE.test(label)) return "경제";
  return ISSUE_BOND_TITLE_RE.test(doc.title ?? "") ? "채권" : "경제";
}

export async function getMacroIssueResearch(
  topic: "이슈분석" | "환율분석",
  source?: string,
  limit = 150,
  kind?: IssueKind,
): Promise<ShinhanResearchDoc[]> {
  const col = await shinhanResearchCol();
  const cutoff = new Date(Date.now() - (topic === "이슈분석" ? ISSUE_MAX_AGE_MS : FX_MAX_AGE_MS))
    .toISOString()
    .slice(0, 10);
  const filter: Record<string, unknown> = {
    category: "산업",
    date: { $gte: cutoff },
    pdfUrl: { $ne: null },
  };
  if (source) filter.source = source;
  const docs = await col.find(filter).sort({ date: -1 }).limit(limit * 4).toArray();
  const withoutExcluded = docs.filter(
    (d) => !isCommonExcludedResearch(`${d.stockName} ${d.title}`, d.category ?? "기업"),
  );
  const deduped = dedupeBySourceTitle(withoutExcluded);
  const scoped = deduped.filter(
    (d) => classifyResearchTopic(d) === topic && (!kind || topic !== "이슈분석" || classifyIssueKind(d) === kind),
  );
  return scoped.slice(0, limit);
}

/** 탭 UI용 — 해당 topic에 실제로 존재하는 증권사명 목록(문서 수 많은 순). classifyResearchTopic 이 DB 필드가 아니라 JS에서 매번 계산해야 해서 $group 집계 대신 후보를 가져와 직접 센다. */
export async function getMacroIssueSources(topic: "이슈분석" | "환율분석"): Promise<string[]> {
  const col = await shinhanResearchCol();
  const cutoff = new Date(Date.now() - (topic === "이슈분석" ? ISSUE_MAX_AGE_MS : FX_MAX_AGE_MS))
    .toISOString()
    .slice(0, 10);
  const docs = await col
    .find({ category: "산업", date: { $gte: cutoff }, pdfUrl: { $ne: null } })
    .project<{ source: string; stockName: string; title: string; market: ResearchMarketId; summary: string }>({
      source: 1,
      stockName: 1,
      title: 1,
      market: 1,
      summary: 1,
    })
    .toArray();
  const counts = new Map<string, number>();
  for (const d of docs) {
    if (classifyResearchTopic(d) !== topic) continue;
    counts.set(d.source, (counts.get(d.source) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
}

/**
 * 신규 "시황분석" 탭(오너 지시 2026-09-26) — `/macro/market-condition`.
 * Daily/Monthly/투자전략 3개 세그먼트로 구분. 구 "시황"·"투자전략(주식)"이
 * 여기로 이동했다(산업분석 탭에서 완전히 제거).
 */
export async function getMarketConditionResearch(
  segment: "Daily" | "Monthly" | "투자전략",
  limit = 150,
): Promise<ShinhanResearchDoc[]> {
  const col = await shinhanResearchCol();
  const cutoffMs =
    segment === "Daily"
      ? MARKET_DAILY_MAX_AGE_MS
      : segment === "Monthly"
        ? MARKET_MONTHLY_MAX_AGE_MS
        : MARKET_STRATEGY_MAX_AGE_MS;
  const cutoff = new Date(Date.now() - cutoffMs).toISOString().slice(0, 10);
  const wantedTopic: ResearchTopic = `시황분석:${segment}`;
  const docs = await col
    .find({ category: "산업", date: { $gte: cutoff }, pdfUrl: { $ne: null } })
    .sort({ date: -1 })
    .limit(limit * 4)
    .toArray();
  const withoutExcluded = docs.filter(
    (d) => !isCommonExcludedResearch(`${d.stockName} ${d.title}`, d.category ?? "기업"),
  );
  const deduped = dedupeBySourceTitle(withoutExcluded);
  const scoped = deduped.filter((d) => classifyResearchTopic(d) === wantedTopic);
  return scoped.slice(0, limit);
}

/**
 * 해외 IB/자산운용사 인사이트 — `/[market]/insights`(오너 지시, 2026-09-19
 * — "해외ib에서 발취되는 것은 산업분석에 빼서 산업분석 옆에 인사이트라고
 * 탭 만들도록... 전체/각사별구분으로"). `getIndustryResearch()`와 달리
 * 국내 산업분석/투자전략/시황 분류(`classifyResearchTopic()`)를 아예 거치지
 * 않는다 — 이 소스들은 그 분류 체계 대상이 아니고(예: 블랙록 stockName이
 * 문자 그대로 "시황"을 포함해 오분류·조기삭제될 뻔한 문제, 위 상수 주석
 * 참고), 대신 90일 산업분석 기본 보존기간을 그대로 쓴다. `source`를 주면
 * 그 소스 하나로만 좁힌다(화면의 "각사별" 세그먼트).
 */
export async function getInsightResearch(
  market: MarketId,
  limit = 100,
  source?: string,
  kind: "insight" | "unlisted" = market === "kr" ? "unlisted" : "insight",
): Promise<ShinhanResearchDoc[]> {
  const col = await shinhanResearchCol();
  // kind: 해외 IB 인사이트와 비상장 리서치는 같은 source 목록(INSIGHT_SOURCES)을 공유하지만 화면(탭)은 갈라져 있다.
  const pool = (INSIGHT_SOURCES as readonly string[]).filter((s) => isUnlistedSource(s) === (kind === "unlisted"));
  const filter: Record<string, unknown> = {
    market,
    category: "산업",
    pdfUrl: { $ne: null },
    source: source && pool.includes(source) ? source : { $in: pool },
  };
  const docs = await col.find(filter).sort({ date: -1 }).limit(limit * 3).toArray();
  const kept = docs.filter((d) => !isCommonExcludedResearch(`${d.stockName} ${d.title}`, d.category ?? "기업"));
  return dedupeBySourceTitle(kept).slice(0, limit);
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
  // 산업분석이 이 종목을 실질적으로 다루면(relatedSymbols) 기업분석과
  // 함께 보여준다(2026-09-19 추가 — BNK "반도체" 산업분석이 삼성전자를
  // 26번 언급하는데도 symbol이 null이라 안 보이던 문제).
  const symbolFilter = { $or: [{ symbol }, { relatedSymbols: symbol }] };
  // 중복 제거로 개수가 줄어들 수 있어 limit보다 넉넉히 가져온 뒤 잘라낸다.
  const fetchLimit = limit + 10;
  const recent = await col
    .find({ ...marketFilter, ...symbolFilter, date: { $gte: recentCutoff } })
    .sort({ date: -1 })
    .limit(fetchLimit)
    .toArray();
  // 공통 제외(오너 지시 2026-09-25) — 이미 쌓인 문서용 안전망.
  const keep = (d: ShinhanResearchDoc) => !isCommonExcludedResearch(`${d.stockName} ${d.title}`, d.category ?? "기업");
  const recentKept = recent.filter(keep);
  if (recentKept.length > 0) return dedupeBySourceTitle(recentKept).slice(0, limit);
  const fallback = await col
    .find({ ...marketFilter, ...symbolFilter })
    .sort({ date: -1 })
    .limit(fetchLimit)
    .toArray();
  return dedupeBySourceTitle(fallback.filter(keep)).slice(0, Math.min(limit, 3));
}
