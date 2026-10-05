import "server-only";
import { isDbConfigured } from "@/lib/db";
import { getNaverBlogPostsByBlog } from "@/lib/db/naver-blog-posts";

/**
 * 네이버 블로그 — 제목·링크·발행시각만 쓴다(본문 없음).
 * 2026-10-05 변경: 화면 요청 시점 RSS 호출을 없앴다. 오라클 타이머 `news-naver-blog`(scripts/run/naver-blog-poll.mts)만
 * rss.blog.naver.com/{blogId}.xml(인증 불필요, ETag·Last-Modified 미제공 — 조건부 요청 불가)을 부르고,
 * 화면은 DB(`naver_blog_posts`)를 읽는다. DB 가 비어 있으면 빈 목록(라이브 RSS 로 대체하지 않음).
 */

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .trim();
}

function tag(name: string, xml: string): string | null {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : null;
}

export interface NaverBlogPost {
  title: string;
  link: string;
  publishedAt: string;
}

/** blogUrl(예: https://blog.naver.com/ranto28)에서 blogId 추출 */
export function naverBlogId(blogUrl: string): string | null {
  const m = blogUrl.match(/blog\.naver\.com\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

/** RSS 본문 → 글 목록(수집 스크립트용). 항목이 없으면 빈 배열. */
export function parseNaverBlogRss(xml: string, limit = 50): NaverBlogPost[] {
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  return blocks
    .map((b) => {
      const title = tag("title", b);
      const rawLink = tag("link", b);
      const pub = tag("pubDate", b);
      const d = pub ? new Date(pub) : null;
      // 발행시각을 못 읽은 글은 현재 시각으로 대체하지 않는다(정렬이 거짓이 됨) — 건너뜀
      if (!title || !rawLink || !d || Number.isNaN(d.getTime())) return null;
      return {
        title,
        // RSS 추적 파라미터(fromRss/trackingCode) 제거 — 클릭 시 원본 링크로
        link: rawLink.replace(/[?&](fromRss|trackingCode)=[^&]*/g, "").replace(/\?$/, ""),
        publishedAt: d.toISOString(),
      };
    })
    .filter((x): x is NaverBlogPost => x !== null)
    .slice(0, limit);
}

/** 화면용 — DB(naver_blog_posts)에서만 읽는다. */
export async function getNaverBlogFeed(blogUrl: string, limit = 10): Promise<NaverBlogPost[]> {
  if (!isDbConfigured()) return [];
  const blogId = naverBlogId(blogUrl);
  if (!blogId) return [];
  try {
    const rows = await getNaverBlogPostsByBlog(blogId, limit);
    return rows.map((r) => ({ title: r.title, link: r._id, publishedAt: r.publishedAt }));
  } catch (e) {
    console.error("[naver-blog] DB 조회 실패", e);
    return [];
  }
}
