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
  opts: { display?: number; start?: number } = {},
): Promise<NaverNewsItem[]> {
  const keyId = process.env.NAVER_APIHUB_KEY_ID;
  const keySecret = process.env.NAVER_APIHUB_KEY_SECRET;
  if (!keyId || !keySecret) return [];
  try {
    const display = Math.min(opts.display ?? 20, 100);
    const start = Math.max(1, opts.start ?? 1);
    const res = await fetch(
      `https://naverapihub.apigw.ntruss.com/search/v1/news?query=${encodeURIComponent(query)}` +
        `&display=${display}&start=${start}&sort=date`,
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

/**
 * 기간을 채울 때까지 페이지를 넘겨 받는다(오너 지시 2026-09-21 — A안).
 *
 * `sort=date` 는 **최신순**이라 한 번에 20건만 받으면 조회 시점 직전 몇
 * 시간치만 들어온다. 기사가 많은 주제일수록 더 심하다 — 실측(2026-09-21):
 * "원달러 환율"이 그 주 뉴스 0건으로 집계됐다. 최신 20건이 전부 조회 당일
 * 오전 기사라 리포트 주(월~금) 밖으로 버려진 것이다. 즉 기존 집계는 "그 주
 * 보도량"이 아니라 "조회 시점 직전 20건 중 우연히 창에 걸린 수"였다.
 * 네이버만 쓰는 국내 주제 5개(한국은행·원달러·코스피 수급·2차전지·조선방산)가
 * 전부 이 영향을 받았다 — 해외 주제는 구글 RSS(when:7d)가 메워줬다.
 *
 * 최신순이므로 `untilMs` 보다 새 기사는 건너뛰고, `sinceMs` 보다 오래된
 * 기사가 나오면 그 뒤는 볼 필요가 없어 멈춘다. 네이버 상한은 start+display
 * 가 1000 이고 display 는 100 이라, maxPages 로 호출 수를 묶어 둔다.
 */
export async function fetchNaverNewsInRange(
  query: string,
  sinceMs: number,
  untilMs: number,
  opts: { maxPages?: number; perPage?: number } = {},
): Promise<NaverNewsItem[]> {
  const perPage = Math.min(opts.perPage ?? 100, 100);
  const maxPages = Math.max(1, opts.maxPages ?? 5);
  const out: NaverNewsItem[] = [];
  for (let page = 0; page < maxPages; page++) {
    const start = page * perPage + 1;
    if (start > 1000) break; // 네이버 상한
    const items = await fetchNaverNewsSearch(query, { display: perPage, start });
    if (items.length === 0) break;
    let reachedOlder = false;
    for (const n of items) {
      const ms = Date.parse(n.publishedAt);
      if (!Number.isFinite(ms)) continue;
      if (ms > untilMs) continue; // 창보다 새 기사 — 다음 항목으로
      if (ms < sinceMs) {
        reachedOlder = true; // 최신순이라 이 뒤는 전부 더 오래됨
        break;
      }
      out.push(n);
    }
    if (reachedOlder || items.length < perPage) break;
  }
  return out;
}
