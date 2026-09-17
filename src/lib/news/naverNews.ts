import "server-only";

/**
 * 네이버 뉴스 검색 API(API 허브) — 이미 종목뉴스(`markets/news.ts`)가 쓰는
 * 같은 엔드포인트·키를 주간 리포트용으로 재사용(무료, 일 25,000건). 구글
 * 뉴스 RSS와 달리 `description`(기사 요약문)을 줘서 제목만 있을 때보다
 * Gemini 코멘트의 근거가 구체적이다(오너 지시 2026-09 — 국내 주제는 이
 * 쪽으로 대체, 해외 주제는 구글과 함께 씀).
 */

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();
}

export interface NaverNewsItem {
  title: string;
  excerpt: string | null;
  source: string;
  url: string;
  publishedAt: string; // ISO
}

interface NaverNewsApiItem {
  title: string;
  originallink: string;
  link: string;
  pubDate: string; // RFC822
  description?: string;
}

export async function fetchNaverNewsSearch(
  query: string,
  opts: { display?: number } = {},
): Promise<NaverNewsItem[]> {
  const keyId = process.env.NAVER_APIHUB_KEY_ID;
  const keySecret = process.env.NAVER_APIHUB_KEY_SECRET;
  if (!keyId || !keySecret) return [];
  try {
    const res = await fetch(
      `https://naverapihub.apigw.ntruss.com/search/v1/news?query=${encodeURIComponent(query)}&display=${opts.display ?? 20}&sort=date`,
      {
        headers: { "X-NCP-APIGW-API-KEY-ID": keyId, "X-NCP-APIGW-API-KEY": keySecret },
        signal: AbortSignal.timeout(8000),
        next: { revalidate: 900 },
      },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { items?: NaverNewsApiItem[] };
    const out: NaverNewsItem[] = [];
    for (const n of body.items ?? []) {
      const url = n.originallink || n.link;
      const t = Date.parse(n.pubDate);
      if (!n.title || !url || !Number.isFinite(t)) continue;
      let source = "네이버뉴스";
      try {
        source = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        // ignore — keep default label
      }
      out.push({
        title: stripHtml(n.title),
        excerpt: n.description ? stripHtml(n.description) : null,
        source,
        url,
        publishedAt: new Date(t).toISOString(),
      });
    }
    return out;
  } catch {
    return [];
  }
}
