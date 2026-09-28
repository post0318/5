import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import {
  shinhanResearchCol,
  upsertShinhanResearch,
  isResearchMarketId,
  type ShinhanResearchDoc,
} from "@/lib/db/shinhan-research";
import { findCorpsByExactName } from "@/lib/markets/kr/corpcode";
import { isCommonExcludedResearch } from "@/lib/research-exclude";
import { normalizeIndustryLabel, marketFromIndustryLabel, marketFromTitleLead } from "@/lib/research-sector";

export const maxDuration = 60;

/**
 * 증권사·기관 리서치 리포트 수집 수신처(`kr_research`) — 47개 로컬 수집기
 * 전부가 이 라우트 하나를 공유한다(오너 지시 2026-09-25 — "/cron/shinhan-
 * research는 total-research로 수정이 맞고"). 원래 신한투자증권 수집기
 * (scripts/collect-shinhan-research.mjs)가 첫 번째로 붙어 경로 이름이
 * "shinhan-research"였지만, 처음부터 `source`를 body에 실어 보내는 다중
 * 소스 스키마였고(증권사 하나로 한정하지 않음) 지금은 47곳 전부가 재사용
 * 중이라 경로 이름을 실제 역할에 맞게 바꿨다. `source`는 이제 필수 —
 * 기본값("신한투자증권")을 두지 않는다(오너 지시 — "source 미지정 시
 * 기본값은 없는게 맞다", `/cron/macro-issues`와 동일 원칙).
 * bbs2.shinhansec.com/robots.txt 가 Disallow: / 라 다른 예외들과 동일하게
 * 개인용·로컬 실행 조건으로 오너 승인(CLAUDE.md 참조). 이 라우트 자체는
 * 크롤링을 하지 않는다 — 로컬에서 이미 수집된 결과를 받아 DB에 적재만 한다
 * (배포된 앱은 DB 조회만 함).
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const appPw = process.env.APP_PASSWORD;
  if (appPw && req.headers.get("x-app-token") === appPw) return true;
  if (secret) return req.headers.get("authorization") === `Bearer ${secret}`;
  return false;
}

interface RawItem {
  id: string;
  date: string;
  title: string;
  stockName: string;
  /** 수집기가 제목 등에서 이미 6자리 종목코드를 뽑아낸 경우(예: 하나증권 —
   * 제목이 "종목명(코드.거래소/의견)" 형식이라 이름 검색 없이 바로 나옴).
   * 있으면 이름 검색을 건너뛰고 그대로 쓴다. */
  symbol?: string | null;
  analyst: string;
  opinion: string;
  targetPrice?: number | null;
  summary: string;
  pdfUrl: string | null;
  views: number | null;
  /** 없으면 "기업"(현재 모든 수집기가 기업분석만 수집 — 산업분석 수집은 추후 과제). */
  category?: "기업" | "산업";
  /** category:"산업" 전용(2026-09-19 추가) — 수집기가 PDF 본문에서 대형주
   * 언급 횟수를 세어 임계값 넘긴 종목코드 목록. shinhan-research.ts 참고. */
  relatedSymbols?: string[];
}

/**
 * 리포트에 자주 쓰이는 약칭 → 정식 회사명. 완전일치가 안 될 때만 이걸로 한 번
 * 더 찾는다. 여기 없는 약칭은 못 푼 것으로 남긴다(symbol null) — "비슷한
 * 이름"을 고르는 것보다 안 붙이는 쪽이 낫다.
 */
const CORP_ALIASES: Record<string, string> = {
  현대차: "현대자동차",
  기아차: "기아",
  하이닉스: "SK하이닉스",
  LG엔솔: "LG에너지솔루션",
  포스코: "POSCO홀딩스",
  포스코홀딩스: "POSCO홀딩스",
  한전: "한국전력",
  한국전력공사: "한국전력",
  SKT: "SK텔레콤",
  삼바: "삼성바이오로직스",
  엔씨: "엔씨소프트",
  카뱅: "카카오뱅크",
  네이버: "NAVER",
  현대중공업: "HD현대중공업",
  두산에너빌: "두산에너빌리티",
  KT: "케이티",
};

/**
 * 이름 → 종목코드. **완전일치만** 인정한다(정규화: 대소문자·공백·(주)).
 *
 * 예전엔 완전일치가 없으면 검색 첫 후보를 그냥 썼는데, 그게 리서치 감사
 * (2026-09-28)에서 오매칭의 주원인이었다 — 현대차→현대차증권, CJ→씨제이
 * 인터넷(상폐), 삼성물산→000830(2015년 소멸 법인). 첫 후보 폴백을 없애고,
 * 동명이 2건 이상이면 애매하므로 붙이지 않는다. 약칭은 CORP_ALIASES 로만
 * 푼다. 종목표 자체도 현재 상장사만 담게 정제했다(build-kr-corpcodes.mjs).
 */
/** 출처명 표기 통일(저장 직전 1회). 왼쪽이 들어오는 라벨, 오른쪽이 정식 표기. */
const SOURCE_ALIASES: Record<string, string> = {
  한화증권: "한화투자증권",
  "Goldman Sachs Research": "Goldman Sachs",
  "BlackRock Research": "BlackRock",
};

function resolveSymbol(stockName: string): string | null {
  const q = stockName.trim();
  if (!q) return null;
  let hits = findCorpsByExactName(q);
  if (hits.length === 0) {
    const alias = CORP_ALIASES[q] ?? CORP_ALIASES[q.split(" ").join("")];
    if (alias) hits = findCorpsByExactName(alias);
  }
  return hits.length === 1 ? hits[0].stockCode : null;
}

export async function POST(req: Request) {
  try {
    if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });

    const body = (await req.json()) as { items?: RawItem[]; source?: string; market?: string };
    if (!Array.isArray(body.items)) return Response.json({ error: "items 배열 필요" }, { status: 400 });
    const source = body.source?.trim();
    // 출처명 정규화 — 한경 컨센서스의 "제공출처" 라벨이 자체 수집기와 다르게
    // 표기돼 같은 증권사가 둘로 갈라졌다(감사 2026-09-28: 한화증권 46건 vs
    // 한화투자증권 246건). 배지가 갈라지고 source|title 중복 제거도 못 묶는다.
    // 저장 직전 이 한 곳에서만 맞춘다.
    if (!source) return Response.json({ error: "source 필요" }, { status: 400 });
    const sourceCanon = SOURCE_ALIASES[source] ?? source;
    const market = body.market && isResearchMarketId(body.market) ? body.market : "kr";

    const now = new Date().toISOString();
    // 공통 제외(주간물·일정표·추천종목·원자재 외 대체투자) — 모든 수집기가 이
    // 라우트를 거치므로 여기서 한 번에 거른다(오너 지시 2026-09-25).
    const kept = body.items.filter((it) => !isCommonExcludedResearch(`${it.stockName ?? ""} ${it.title ?? ""}`, it.category ?? "기업"));
    const excluded = body.items.length - kept.length;
    const docs: ShinhanResearchDoc[] = kept.map((it) => ({
      _id: `${sourceCanon}:${it.id}`,
      source: sourceCanon,
      // 국내 게시판으로 들어온 산업 글도 라벨이 국가명으로 시작하면 그 나라 시장("중국 자동차 판매동향" → ch) — 모든 수집기 공통(오너 지시 2026-09-27).
      // 이미 해외 시장으로 온 항목은 건드리지 않는다.
      market: market === "kr" && it.category === "산업" ? (marketFromIndustryLabel(it.stockName) ?? marketFromTitleLead(it.title) ?? market) : market,
      date: it.date,
      title: it.title,
      // 산업분석 업종 라벨은 표준 이름으로 정규화("대조선"→"조선") — 모든 수집기가 거치는 한 지점에서 보장(오너 지시 2026-09-27).
      stockName: it.category === "산업" ? normalizeIndustryLabel(it.stockName) : it.stockName,
      // 산업분석 리포트는 stockName 이 업종명("반도체" 등)이라 이름 검색으로
      // 종목코드를 추측하면 안 됨(예: "반도체"가 우연히 어떤 회사명과 부분
      // 일치해 잘못된 종목에 달라붙을 위험) — 카테고리로 아예 이름 검색을 건너뜀.
      symbol:
        it.category === "산업"
          ? null
          : (it.symbol ?? (market === "kr" ? resolveSymbol(it.stockName) : null)),
      analyst: it.analyst,
      opinion: it.opinion,
      targetPrice: it.targetPrice ?? null,
      summary: it.summary,
      pdfUrl: it.pdfUrl,
      views: it.views,
      collectedAt: now,
      ...(it.relatedSymbols && it.relatedSymbols.length > 0 ? { relatedSymbols: it.relatedSymbols } : {}),
      category: it.category ?? "기업",
    }));

    const result = await upsertShinhanResearch(docs);
    const unresolved = docs.filter((d) => d.symbol == null).length;
    return ok({ received: body.items.length, excluded, unresolved, ...result });
  } catch (err) {
    return jsonError(err);
  }
}

/**
 * 소스 전환에 따른 정리용 — GlobalMonitor 를 거쳐 저장된 문서를 자체 수집기로
 * 대체한 뒤(예: 신한투자증권 해외, 2026-09) 옛 GM 경유 문서가 남아 같은
 * 종목·날짜가 두 번 뜨는 문제(실측: AVGO 신한투자증권 2건)를 지운다.
 * `_id` 가 `${source}:GM:${원본id}` 로 네임스페이스돼 있어 `source`+`idPrefix`
 * 로 안전하게 좁혀서만 삭제한다. `idPrefix` 생략 시 그 `source` 전체를
 * 지운다 — 콘텐츠 종류를 나눠 다른 source로 재전송할 때(예: JP모간
 * "J.P. Morgan" → "J.P. Morgan Research", 2026-09-19) 옛 source 문서
 * 전량이 고아로 남는 걸 정리하는 용도(source 는 여전히 필수라 전체
 * 컬렉션을 잘못 지울 위험은 없음).
 */
export async function DELETE(req: Request) {
  try {
    if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });

    const body = (await req.json().catch(() => ({}))) as { source?: string; idPrefix?: string };
    const source = body.source?.trim();
    const idPrefix = body.idPrefix?.trim();
    if (!source) {
      return Response.json({ error: "source 필요" }, { status: 400 });
    }

    const col = await shinhanResearchCol();
    const result = await col.deleteMany(
      idPrefix
        ? { source, _id: { $regex: `^${source}:${idPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` } }
        : { source },
    );
    return ok({ source, idPrefix: idPrefix ?? null, deleted: result.deletedCount ?? 0 });
  } catch (err) {
    return jsonError(err);
  }
}
