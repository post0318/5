import "server-only";

/**
 * 네이버 블로그 RSS(공개 신디케이션 피드) — lib/news/googleNews.ts 와 동일한
 * 이유로 실시간 fetch(로컬 스크립트 아님). 본문 전체가 아니라 RSS가 주는
 * 제목·링크·발행시각만 사용. rss.blog.naver.com/{blogId}.xml 는 인증 불필요.
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

export async function fetchNaverBlogPosts(blogUrl: string, limit = 10): Promise<NaverBlogPost[]> {
  const blogId = naverBlogId(blogUrl);
  if (!blogId) return [];
  try {
    const res = await fetch(`https://rss.blog.naver.com/${blogId}.xml`, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; stock-research/1.0)" },
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 900 },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
    return blocks
      .map((b) => {
        const title = tag("title", b);
        const rawLink = tag("link", b);
        if (!title || !rawLink) return null;
        const pub = tag("pubDate", b);
        const d = pub ? new Date(pub) : null;
        return {
          title,
          // RSS 추적 파라미터(fromRss/trackingCode) 제거 — 클릭 시 원본 링크로
          link: rawLink.replace(/[?&](fromRss|trackingCode)=[^&]*/g, "").replace(/\?$/, ""),
          publishedAt: d && !Number.isNaN(d.getTime()) ? d.toISOString() : new Date().toISOString(),
        };
      })
      .filter((x): x is NaverBlogPost => x !== null)
      .slice(0, limit);
  } catch {
    return [];
  }
}
