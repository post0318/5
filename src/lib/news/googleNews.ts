import "server-only";

/**
 * Google 뉴스 RSS(공개 신디케이션 피드) 파서. 본문은 가져오지 않는다 —
 * 제목·매체·발행시각·원문 링크만. 크롤링이 아니라 공개 RSS 구독.
 * (post0318/4 프로젝트의 src/lib/server/brazilNews.ts 패턴을 이식)
 */

const UA = "Mozilla/5.0 (compatible; stock-research/1.0)";

export function googleNewsUrl(path: string, locale: string): string {
  return `https://news.google.com/rss/${path}${path.includes("?") ? "&" : "?"}${locale}`;
}

export interface RawNewsItem {
  title: string;
  link: string;
  source: string;
  publishedAt: string;
}

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

export async function fetchGoogleNewsRss(url: string): Promise<RawNewsItem[]> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 900 },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
    return blocks
      .map((b) => {
        const rawTitle = tag("title", b);
        const link = tag("link", b);
        if (!rawTitle || !link) return null;
        const source = tag("source", b) ?? "Google 뉴스";
        // "헤드라인 - 매체" 형식에서 매체명 꼬리 제거
        const title = rawTitle.replace(new RegExp(`\\s*[-–]\\s*${source}\\s*$`), "").trim();
        const pub = tag("pubDate", b);
        const d = pub ? new Date(pub) : null;
        return {
          title,
          link,
          source,
          publishedAt: d && !Number.isNaN(d.getTime()) ? d.toISOString() : new Date().toISOString(),
        };
      })
      .filter((x): x is RawNewsItem => x !== null);
  } catch {
    return [];
  }
}

// 잡음(복권·운세·연예·스포츠 결과 등) 공통 제외 — 시장/종목 판단에 도움 안 됨
export const NOISE =
  /lottery|horoscope|zodiac|celebrity|box office|\bfilm review\b|\bmovie review\b|\btv show\b|world cup|olympics?|\bsoccer\b|룰렛|로또|운세|사주|연예|아이돌|드라마 리뷰|영화 리뷰|박스오피스/i;
