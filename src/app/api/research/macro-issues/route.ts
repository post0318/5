import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { getMacroIssues, getMacroIssueSources } from "@/lib/db/macro-issues";

export const revalidate = 1800;

/**
 * 거시경제 "이슈분석"/"환율분석" 탭 조회 — `/macro/issues`, `/macro/fx`.
 * `source` 쿼리로 "전체"/증권사별을 나눈다(오너 지시 2026-09-24 — "전체/
 * 증권사명 으로 해서 증권사별로 구분"). DB만 읽는다(수집은 로컬 스크립트).
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const topicParam = url.searchParams.get("topic");
    const topic = topicParam === "환율분석" ? "환율분석" : "이슈분석";
    const sourceParam = url.searchParams.get("source");
    const source = sourceParam && sourceParam !== "전체" ? sourceParam : undefined;

    if (!isDbConfigured()) return ok({ items: [], sources: [] });

    const [items, sources] = await Promise.all([
      getMacroIssues(topic, source, 150),
      getMacroIssueSources(topic),
    ]);
    return ok(
      { items, sources },
      { headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600" } },
    );
  } catch (err) {
    return jsonError(err);
  }
}
