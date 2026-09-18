import "server-only";

/**
 * 빅테크 공식 블로그/뉴스룸 RSS — 파급력이 큰 자체 발표(예: NVIDIA의 신규
 * 파트너십·인프라 발표)는 로이터·블룸버그 등이 받아쓰기 전까진 기존 뉴스
 * 파이프라인(`markets/news.ts` 화이트리스트, Google/네이버 뉴스 검색)에
 * 안 잡힌다(오너 지적 2026-09-18 — "엔비디아 블로그... 다른 어떤것보다
 * 파급력이 큰데"). 공개 RSS/Atom 피드 구독이라 크롤링이 아니다(Google 뉴스
 * RSS와 같은 성격) — NVIDIA 도 "무료·개인용 한정" 조건으로 RSS 를 제공한다고
 * 명시.
 *
 * 실측 확인한 소스: NVIDIA(RSS 2.0)·Google(RSS 2.0)·Meta(RSS 2.0)·
 * Microsoft(RSS 2.0)·Oracle(RSS 2.0, 공식 보도자료 피드)·
 * Apple(Atom — `<entry>`/`<link href>`/`<updated>`/`<content>` 형식이 달라
 * 별도 파싱). Microsoft 는 처음에 봇 차단(403)으로 막혔다가 UA 를 실제
 * 브라우저 문자열로 바꾸니 통과됨(아래 UA 상수) — Broadcom/AMD/Tesla 는
 * 이번 조사에서 RSS 자체를 못 찾아 보류(오너 지시 2026-09-18 — "미국
 * 유니버스가 대형주 대부분", 확인되는 대로 계속 추가할 것).
 *
 * 블로그엔 게임(NVIDIA GeForce NOW)·엔터테인먼트(Apple Arcade, Apple TV
 * Emmy 수상 등)·지역사회 기부(Oracle 의 CSR 보도자료 등) 소비자/비市場
 * 콘텐츠가 섞여 있어(실측 확인) 기업별 `relevance` 정규식으로 AI·반도체·
 * 재무·제품 발표 등 시장 관련 콘텐츠만 거른다.
 */

interface BlogFeedConfig {
  source: string;
  /** 대응하는 미국 종목 티커 — 종목 페이지에서 조회할 때 이 값으로 찾는다. */
  ticker: string;
  feedUrl: string;
  format: "rss" | "atom";
  relevance: RegExp;
}

const BLOG_FEEDS: BlogFeedConfig[] = [
  {
    source: "NVIDIA",
    ticker: "NVDA",
    feedUrl: "https://blogs.nvidia.com/feed/",
    format: "rss",
    relevance:
      /\bAI\b|artificial intelligence|data cent|datacenter|\bGPU\b|enterprise|partnership|alliance|cloud comput|inference|training|Grace|Blackwell|Hopper|capex|energy|infrastructure|\bresearch\b|earnings|revenue|supply chain|chip/i,
  },
  {
    source: "Apple",
    ticker: "AAPL",
    feedUrl: "https://www.apple.com/newsroom/rss-feed.rss",
    format: "atom",
    relevance:
      /\bAI\b|Apple Intelligence|\bchip\b|silicon|\bM\d\b|earnings|revenue|financial results|manufactur|supply chain|privacy|security|antitrust|European Union|\bEU\b|App Store|data center/i,
  },
  {
    source: "Google",
    ticker: "GOOGL",
    feedUrl: "https://blog.google/rss/",
    format: "rss",
    relevance:
      /\bAI\b|artificial intelligence|Gemini|TPU|data cent|datacenter|cloud comput|enterprise|earnings|revenue|antitrust|regulat|search|advertis|chip|infrastructure/i,
  },
  {
    source: "Meta",
    ticker: "META",
    feedUrl: "https://about.fb.com/news/feed/",
    format: "rss",
    relevance:
      /\bAI\b|artificial intelligence|Llama|data cent|datacenter|infrastructure|earnings|revenue|antitrust|regulat|advertis|reality lab|metaverse|chip/i,
  },
  {
    source: "Microsoft",
    ticker: "MSFT",
    feedUrl: "https://blogs.microsoft.com/feed/",
    format: "rss",
    relevance:
      /\bAI\b|artificial intelligence|Azure|Copilot|OpenAI|data cent|datacenter|cloud comput|infrastructure|earnings|revenue|antitrust|regulat|enterprise|chip|HPC|supercomput/i,
  },
  {
    source: "Oracle",
    ticker: "ORCL",
    feedUrl: "https://www.oracle.com/corporate/press/rss/rss-pr.xml",
    format: "rss",
    relevance:
      /\bAI\b|artificial intelligence|cloud infrastructure|OCI\b|data cent|datacenter|earnings|revenue|quarterly results|fiscal (?:Q|year)|financial results|stock|acqui|partnership|investor/i,
  },
];

export interface CompanyBlogItem {
  title: string;
  url: string;
  publishedAt: string; // ISO
  excerpt: string | null;
  source: string;
}

// 일부 기업 뉴스룸(Microsoft 실측 확인)이 정직하게 밝히는 UA 를 봇으로
// 차단해서(403) 실제 브라우저 UA 로 바꿨다 — 콘텐츠 자체는 공개 RSS라
// 접근 자체엔 문제 없고, 서버가 UA 만으로 걸러내는 것뿐이다.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

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

/** Atom `<link href="...">` 는 자기 닫힘 태그라 속성에서 뽑아야 한다(RSS
 * 의 `<link>텍스트</link>` 와 다름). */
function atomLink(xml: string): string | null {
  const m = xml.match(/<link\b[^>]*\shref="([^"]*)"/i);
  return m ? decode(m[1]) : null;
}

function categoriesOf(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<category\b[^>]*\bterm="([^"]*)"/gi)) out.push(decode(m[1]));
  for (const m of xml.matchAll(/<category>([\s\S]*?)<\/category>/gi)) out.push(decode(m[1]));
  return out;
}

async function fetchOne(cfg: BlogFeedConfig): Promise<CompanyBlogItem[]> {
  try {
    const res = await fetch(cfg.feedUrl, {
      headers: { "user-agent": UA, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 900 },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const blockTag = cfg.format === "atom" ? "entry" : "item";
    const blocks = xml.match(new RegExp(`<${blockTag}>[\\s\\S]*?</${blockTag}>`, "gi")) ?? [];
    const out: CompanyBlogItem[] = [];
    for (const b of blocks) {
      const title = tag("title", b);
      const link = cfg.format === "atom" ? atomLink(b) : tag("link", b);
      const dateStr = cfg.format === "atom" ? (tag("published", b) ?? tag("updated", b)) : tag("pubDate", b);
      const description = cfg.format === "atom" ? (tag("summary", b) ?? tag("content", b)) : tag("description", b);
      if (!title || !link || !dateStr) continue;
      const hay = `${title} ${categoriesOf(b).join(" ")} ${description ?? ""}`;
      if (!cfg.relevance.test(hay)) continue;
      const t = Date.parse(dateStr);
      if (!Number.isFinite(t)) continue;
      out.push({
        title,
        url: link.trim(),
        publishedAt: new Date(t).toISOString(),
        excerpt: description ? stripHtml(description).slice(0, 200) : null,
        source: `${cfg.source} 공식 발표`,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** @param companySource BLOG_FEEDS 의 source(예: "NVIDIA") */
export async function fetchCompanyBlog(companySource: string): Promise<CompanyBlogItem[]> {
  const cfg = BLOG_FEEDS.find((f) => f.source === companySource);
  return cfg ? fetchOne(cfg) : [];
}

/** 종목 페이지("기업 발표" 카드)용 — 티커로 피드가 있는지 찾아 바로 가져온다.
 * 피드가 없는 티커는 빈 배열(화면에서 카드 자체를 숨김). */
export async function fetchCompanyBlogByTicker(ticker: string): Promise<CompanyBlogItem[]> {
  const cfg = BLOG_FEEDS.find((f) => f.ticker === ticker.toUpperCase());
  return cfg ? fetchOne(cfg) : [];
}

export function hasCompanyBlog(ticker: string): boolean {
  return BLOG_FEEDS.some((f) => f.ticker === ticker.toUpperCase());
}
