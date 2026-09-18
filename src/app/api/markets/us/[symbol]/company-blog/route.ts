import { jsonError, ok } from "@/lib/api";
import { fetchCompanyBlogByTicker } from "@/lib/news/companyBlog";

export const revalidate = 900;

/**
 * 기업 공식 블로그/뉴스룸 발표 — 미국 빅테크 한정(오너 지시 2026-09-18,
 * companyBlog.ts 참고). 피드가 없는 티커는 빈 배열(화면에서 카드를 숨김).
 * DB 없이 매번 공개 RSS/Atom 피드를 직접 읽는다(짧은 캐시, 크롤링 아님).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ symbol: string }> },
) {
  try {
    const { symbol } = await params;
    const items = await fetchCompanyBlogByTicker(decodeURIComponent(symbol));
    return ok(
      { items },
      { headers: { "Cache-Control": "public, s-maxage=900, stale-while-revalidate=1800" } },
    );
  } catch (err) {
    return jsonError(err);
  }
}
