import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { upsertMacroIssues, type MacroIssueDoc } from "@/lib/db/macro-issues";

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
    const docs: MacroIssueDoc[] = body.items.map((it) => ({
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
    return ok({ received: docs.length, ...result });
  } catch (err) {
    return jsonError(err);
  }
}
