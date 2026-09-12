import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { upsertShinhanResearch, type ShinhanResearchDoc } from "@/lib/db/shinhan-research";
import { searchCorps } from "@/lib/markets/kr/corpcode";

export const maxDuration = 60;

/**
 * 증권사 리서치 리포트 수집 수신처 — 신한투자증권 로컬 스크립트(scripts/
 * collect-shinhan-research.mjs)가 쓰지만, `source`를 body에 실어 보내면 다른
 * 증권사 수집 스크립트도 이 라우트를 그대로 재사용할 수 있게 만들었다(증권사
 * 하나로 한정하지 않음 — 스키마·라우트 모두 다중 소스 대비).
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
  summary: string;
  pdfUrl: string | null;
  views: number | null;
  /** 없으면 "기업"(현재 모든 수집기가 기업분석만 수집 — 산업분석 수집은 추후 과제). */
  category?: "기업" | "산업";
}

function resolveSymbol(stockName: string): string | null {
  const q = stockName.trim();
  if (!q) return null;
  const candidates = searchCorps("", q);
  const exact = candidates.find((c) => c.corpName === q);
  return (exact ?? candidates[0])?.stockCode ?? null;
}

export async function POST(req: Request) {
  try {
    if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });

    const body = (await req.json()) as { items?: RawItem[]; source?: string };
    if (!Array.isArray(body.items)) return Response.json({ error: "items 배열 필요" }, { status: 400 });
    const source = body.source?.trim() || "신한투자증권";

    const now = new Date().toISOString();
    const docs: ShinhanResearchDoc[] = body.items.map((it) => ({
      _id: `${source}:${it.id}`,
      source,
      date: it.date,
      title: it.title,
      stockName: it.stockName,
      symbol: it.symbol ?? resolveSymbol(it.stockName),
      analyst: it.analyst,
      opinion: it.opinion,
      summary: it.summary,
      pdfUrl: it.pdfUrl,
      views: it.views,
      collectedAt: now,
      category: it.category ?? "기업",
    }));

    const result = await upsertShinhanResearch(docs);
    const unresolved = docs.filter((d) => d.symbol == null).length;
    return ok({ received: docs.length, unresolved, ...result });
  } catch (err) {
    return jsonError(err);
  }
}
