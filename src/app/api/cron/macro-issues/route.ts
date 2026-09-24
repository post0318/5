import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { upsertMacroIssues, type MacroIssueDoc } from "@/lib/db/macro-issues";
import { isCommonExcludedResearch } from "@/lib/research-exclude";

/**
 * 거시경제 "이슈분석"/"환율분석" 탭 수집 수신처 — 로컬 스크립트가 쓴다
 * (`scripts/collect-kiwoom-macro-issues.mjs` 등). `kr_research`용
 * `/api/cron/shinhan-research`와 같은 인증 패턴이지만 스키마가 전혀 달라
 * (종목·시장 무관) 별도 라우트로 뺐다(CLAUDE.md "거시경제 이슈분석/환율분석"
 * 참고).
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
  analyst: string;
  summary: string;
  pdfUrl: string | null;
}

export async function POST(req: Request) {
  try {
    if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });

    const body = (await req.json()) as { items?: RawItem[]; source?: string; topic?: string };
    if (!Array.isArray(body.items)) return Response.json({ error: "items 배열 필요" }, { status: 400 });
    const source = body.source?.trim();
    if (!source) return Response.json({ error: "source 필요" }, { status: 400 });
    const topic = body.topic === "환율분석" ? "환율분석" : body.topic === "이슈분석" ? "이슈분석" : null;
    if (!topic) return Response.json({ error: "topic은 이슈분석|환율분석 이어야 합니다" }, { status: 400 });

    const now = new Date().toISOString();
    // 공통 제외(주간물·일정표·추천종목·원자재 외 대체투자, 오너 지시 2026-09-25).
    const kept = body.items.filter((it) => !isCommonExcludedResearch(it.title));
    const docs: MacroIssueDoc[] = kept.map((it) => ({
      _id: `${source}:${topic}:${it.id}`,
      source,
      topic,
      date: it.date,
      title: it.title,
      analyst: it.analyst,
      summary: it.summary,
      pdfUrl: it.pdfUrl,
      collectedAt: now,
    }));

    const result = await upsertMacroIssues(docs);
    return ok({ received: body.items.length, excluded: body.items.length - kept.length, ...result });
  } catch (err) {
    return jsonError(err);
  }
}
