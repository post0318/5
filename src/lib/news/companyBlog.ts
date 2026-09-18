import "server-only";

/**
 * 빅테크 공식 블로그 RSS — 파급력이 큰 자체 발표(예: NVIDIA의 신규 파트너십·
 * 인프라 발표)는 로이터·블룸버그 등이 받아쓰기 전까진 기존 뉴스 파이프라인
 * (`markets/news.ts` 화이트리스트, Google/네이버 뉴스 검색)에 안 잡힌다
 * (오너 지적 2026-09-18 — "엔비디아 블로그... 다른 어떤것보다 파급력이
 * 큰데"). 공개 RSS 피드 구독이라 크롤링이 아니다(Google 뉴스 RSS와 같은
 * 성격) — NVIDIA 도 "무료·개인용 한정" 조건으로 RSS 를 제공한다고 명시.
 *
 * 블로그엔 게임(GeForce NOW 등) 소비자 콘텐츠가 섞여 있어(실측 확인)
 * `relevance` 정규식으로 AI·데이터센터·기업용 콘텐츠만 거른다.
 */

interface BlogFeedConfig {
  source: string;
  feedUrl: string;
  relevance: RegExp;
}

const BLOG_FEEDS: BlogFeedConfig[] = [
  {
    source: "NVIDIA",
    feedUrl: "https://blogs.nvidia.com/feed/",
    relevance:
      /\bAI\b|artificial intelligence|data cent|datacenter|\bGPU\b|enterprise|partnership|alliance|cloud comput|inference|training|Grace|Blackwell|Hopper|capex|energy|infrastructure|\bresearch\b|earnings|revenue|supply chain|chip/i,
  },
];

export interface CompanyBlogItem {
  title: string;
  url: string;
  publishedAt: string; // ISO
  excerpt: string | null;
  source: string;
}

const UA = "Mozilla/5.0 (compatible; stock-research/1.0)";

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

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

function tag(name: string, xml: string): string | null {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : null;
}

/** @param companySource BLOG_FEEDS 의 source(예: "NVIDIA") */
export async function fetchCompanyBlog(companySource: string): Promise<CompanyBlogItem[]> {
  const cfg = BLOG_FEEDS.find((f) => f.source === companySource);
  if (!cfg) return [];
  try {
    const res = await fetch(cfg.feedUrl, {
      headers: { "user-agent": UA, accept: "application/rss+xml, application/xml, text/xml" },
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 900 },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
    const out: CompanyBlogItem[] = [];
    for (const b of blocks) {
      const title = tag("title", b);
      const link = tag("link", b);
      const pubDate = tag("pubDate", b);
      const description = tag("description", b);
      if (!title || !link || !pubDate) continue;
      const categories = [...b.matchAll(/<category>([\s\S]*?)<\/category>/gi)].map((m) => decode(m[1]));
      const hay = `${title} ${categories.join(" ")} ${description ?? ""}`;
      if (!cfg.relevance.test(hay)) continue;
      const t = Date.parse(pubDate);
      if (!Number.isFinite(t)) continue;
      out.push({
        title,
        url: link.trim(),
        publishedAt: new Date(t).toISOString(),
        excerpt: description ? stripHtml(description).slice(0, 200) : null,
        source: `${cfg.source} 공식 블로그`,
      });
    }
    return out;
  } catch {
    return [];
  }
}
