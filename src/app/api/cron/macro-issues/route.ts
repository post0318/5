import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { upsertMacroIssues, escalateToFxTopic, macroIssuesCol, type MacroIssueDoc } from "@/lib/db/macro-issues";
import { isCommonExcludedResearch } from "@/lib/research-exclude";

/**
 * 거시경제 "이슈분석"/"환율분석" 탭 수집 수신처 — 로컬 스크립트가 쓴다
 * (`scripts/collect-kiwoom-macro-issues.mjs` 등). `kr_research`용
 * `/api/cron/total-research`와 같은 인증 패턴이지만 스키마가 전혀 달라
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
    // 서버 안전망(오너 지적 2026-09-25) — 수집기가 보낸 topic을 그대로 믿지 않고
    // 제목에 FX 신호가 있으면 이슈분석→환율분석으로 한 번 더 승격한다.
    const docs: MacroIssueDoc[] = kept.map((it) => {
      const itemTopic = escalateToFxTopic(topic, it.title);
      return {
        _id: `${source}:${itemTopic}:${it.id}`,
        source,
        topic: itemTopic,
        date: it.date,
        title: it.title,
        analyst: it.analyst,
        summary: it.summary,
        pdfUrl: it.pdfUrl,
        collectedAt: now,
      };
    });

    const result = await upsertMacroIssues(docs);
    return ok({ received: body.items.length, excluded: body.items.length - kept.length, ...result });
  } catch (err) {
    return jsonError(err);
  }
}

/**
 * 소스 전환에 따른 정리용 — `/cron/total-research`의 DELETE와 동일한 패턴
 * (오너 지시 2026-09-25 — "매크로 라우터에 DELETE을 동일하게 적용"). `_id`가
 * `${source}:${topic}:${원본id}` 형태라 `idPrefix`에 "환율분석:" 같은 값을
 * 주면 그 source의 특정 topic만 좁혀서 지울 수도 있다. `source`는 항상
 * 필수라 컬렉션 전체가 실수로 삭제될 위험은 없다.
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

    const col = await macroIssuesCol();
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
