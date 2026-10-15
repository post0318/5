import { jsonError, ok } from "@/lib/api";
import { getNewsSummaries } from "@/lib/db/news-summary";

export const dynamic = "force-dynamic";

/**
 * 해외 시황 기사 팝업(2026-10-14) — 저장된 한글 제목·요약을 돌려준다(만들지는 않는다 — 예약 작업이 만든다).
 * `?url=` 목록 항목의 url 그대로. 응답: { ok: true, summary } | { ok: false, reason: "pending" | "unreadable" }
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url).searchParams.get("url")?.slice(0, 2000) ?? "";
    if (!/^https?:\/\//.test(url)) return Response.json({ error: "url 필요" }, { status: 400 });
    const doc = (await getNewsSummaries([url])).get(url);
    if (!doc) return ok({ ok: false, reason: "pending" });
    const summary = { titleKo: doc.titleKo, bullets: doc.bullets, url: doc.url, basis: doc.basis, sources: doc.sources ?? [] };
    return ok(doc.bullets.length ? { ok: true, summary } : { ok: false, reason: "unreadable", summary });
  } catch (err) {
    return jsonError(err);
  }
}
