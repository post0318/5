import "server-only";
import YahooFinancePkg from "yahoo-finance2";
import { fetchJson } from "./http";
import type { MarketId } from "./types";
import { translateTitles } from "../news/translate";

/**
 * 종목뉴스(선택 번역·요약용) — 한국·미국·일본.
 * 미국·일본: yahoo-finance2 뉴스 검색(이미 이 프로젝트가 쓰는 무료 소스).
 * 한국: NAVER API HUB 검색(뉴스) — 2026-06 "openapi.naver.com" 에서 이관,
 * 요금표 확인 결과 검색 API 자체는 무료(일 25,000건 한도). 발행사명이
 * 없어 원문 링크 도메인으로 화이트리스트 매칭.
 */

const YF = (YahooFinancePkg as { default?: unknown }).default ?? YahooFinancePkg;
type YFInstance = {
  search: (
    q: string,
    o: Record<string, unknown>,
  ) => Promise<{ news?: RawNews[] }>;
};
interface RawNews {
  uuid: string;
  title: string;
  publisher: string;
  link: string;
  providerPublishTime: Date | number;
}

let instance: YFInstance | null = null;
function yf(): YFInstance {
  if (!instance) {
    const Ctor = YF as new (o: Record<string, unknown>) => YFInstance;
    instance = new Ctor({ suppressNotices: ["yahooSurvey"], validation: { logErrors: false } });
  }
  return instance;
}

export interface NewsItem {
  id: string;
  title: string;
  /** 헤드라인 한국어 번역(무료 번역 API, 요약 아님) — 한국 기사는 title 과 동일. */
  titleKo: string;
  publisher: string;
  /** 원문(발행사) 링크 — 화이트리스트 판정·본문 fetch·DB 키 전부 이 값 기준. */
  url: string;
  /** 네이버뉴스에도 게재된 기사면 그 링크(가독성 좋음) — 클릭 시 이 값을 우선 사용. */
  naverUrl?: string;
  publishedAt: string; // ISO
  market: MarketId;
  symbol: string;
  /** 기사 일부(발췌) — 국내(네이버 검색 API 요약문)만 제공. 해외는 API 응답에 스니펫이 없어 미제공. */
  excerpt?: string;
}

const SOURCE_LANG: Record<MarketId, "ko" | "en" | "ja"> = { kr: "ko", us: "en", jp: "ja" };

/** 헤드라인만 무료로 번역(체크 전엔 LLM 비용 없음) — src/lib/news/translate.ts 재사용. */
async function withTranslatedTitles(
  lang: "ko" | "en" | "ja",
  items: Omit<NewsItem, "titleKo">[],
): Promise<NewsItem[]> {
  const translated = await translateTitles(items, lang, (it) => it.title);
  return items.map((it, i) => ({ ...it, titleKo: translated[i].titleKo }));
}

/** 공신력 있는 언론사만 — 미국·일본은 yahoo `publisher` 필드, 한국은 도메인 매칭 결과(아래 맵의 값). */
const ALLOWED_PUBLISHERS = new Set(
  [
    // 미국
    "Reuters",
    "Bloomberg",
    "Associated Press",
    "AP News",
    "The Wall Street Journal",
    "Financial Times",
    "CNBC",
    "Barron's",
    "Barrons.com", // yahoo-finance2 실제 publisher 필드는 이 표기
    "MarketWatch",
    "Yahoo Finance",
    "Dow Jones Newswires",
    "Investor's Business Daily", // 실측: yahoo 검색 결과 빈도 높음
    // 일본
    "Nikkei Asia",
    "The Japan Times",
    "Kyodo News",
    // 한국 (도메인 매칭 결과 값 — KR_PUBLISHER_BY_DOMAIN 과 동일 목록 유지)
    "연합뉴스",
    "한국경제",
    "매일경제",
    "서울경제",
    "조선비즈",
    "머니투데이",
    "이데일리",
    "파이낸셜뉴스",
    "한국일보",
  ].map((p) => p.toLowerCase()),
);

/** 한국 뉴스 원문 링크 도메인 → 언론사명. 없는 도메인은 화이트리스트 밖으로 처리. */
const KR_PUBLISHER_BY_DOMAIN: Record<string, string> = {
  "yna.co.kr": "연합뉴스",
  "hankyung.com": "한국경제",
  "mk.co.kr": "매일경제",
  "sedaily.com": "서울경제",
  "biz.chosun.com": "조선비즈",
  "mt.co.kr": "머니투데이",
  "edaily.co.kr": "이데일리",
  "fnnews.com": "파이낸셜뉴스",
  "hankookilbo.com": "한국일보",
};

const THREE_MONTHS_MS = 90 * 24 * 3600_000;
const ONE_WEEK_MS = 7 * 24 * 3600_000;

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();
}

async function fetchUsJpNews(
  market: MarketId,
  symbol: string,
  query: string,
  opts?: { cutoffMs?: number; newsCount?: number },
): Promise<Omit<NewsItem, "titleKo">[]> {
  const newsCount = opts?.newsCount ?? 20;
  let res: { news?: RawNews[] };
  try {
    res = await yf().search(query, { newsCount, quotesCount: 0 });
  } catch {
    return [];
  }
  const cutoff = Date.now() - (opts?.cutoffMs ?? THREE_MONTHS_MS);
  const items: Omit<NewsItem, "titleKo">[] = [];
  for (const n of res.news ?? []) {
    if (!n.title || !n.link || !n.publisher) continue;
    if (!ALLOWED_PUBLISHERS.has(n.publisher.toLowerCase())) continue;
    const t = new Date(n.providerPublishTime).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    items.push({
      id: n.uuid,
      title: n.title,
      publisher: n.publisher,
      url: n.link,
      publishedAt: new Date(t).toISOString(),
      market,
      symbol,
    });
  }
  return items;
}

interface NaverNewsItem {
  title: string;
  originallink: string;
  link: string;
  pubDate: string; // RFC822
  description?: string;
}
interface NaverNewsResponse {
  items?: NaverNewsItem[];
}

async function fetchKrNews(
  symbol: string,
  query: string,
  opts?: { cutoffMs?: number; display?: number },
): Promise<Omit<NewsItem, "titleKo">[]> {
  const keyId = process.env.NAVER_APIHUB_KEY_ID;
  const keySecret = process.env.NAVER_APIHUB_KEY_SECRET;
  if (!keyId || !keySecret) return [];
  const display = opts?.display ?? 20;
  let res: NaverNewsResponse;
  try {
    res = await fetchJson<NaverNewsResponse>(
      `https://naverapihub.apigw.ntruss.com/search/v1/news?query=${encodeURIComponent(query)}&display=${display}&sort=date`,
      {
        headers: { "X-NCP-APIGW-API-KEY-ID": keyId, "X-NCP-APIGW-API-KEY": keySecret },
        revalidate: 900,
      },
    );
  } catch {
    return [];
  }
  const cutoff = Date.now() - (opts?.cutoffMs ?? THREE_MONTHS_MS);
  const items: Omit<NewsItem, "titleKo">[] = [];
  for (const n of res.items ?? []) {
    // 화이트리스트 판정은 항상 원문(발행사) 링크 기준 — link 는 네이버뉴스
    // 재게재본일 수 있어 도메인이 news.naver.com 이라 판정에 쓰면 안 됨.
    const origLink = n.originallink || n.link;
    if (!n.title || !origLink) continue;
    let host: string;
    try {
      host = new URL(origLink).hostname.replace(/^www\./, "");
    } catch {
      continue;
    }
    const publisher = KR_PUBLISHER_BY_DOMAIN[host];
    if (!publisher) continue; // 화이트리스트 밖 도메인 — 목록에 안 보여줌
    const t = Date.parse(n.pubDate);
    if (!Number.isFinite(t) || t < cutoff) continue;
    // 네이버뉴스에도 게재됐으면(link 가 naver.com) 클릭 시 그쪽으로 — 가독성 좋음.
    let naverUrl: string | undefined;
    try {
      if (n.link && /(^|\.)naver\.com$/.test(new URL(n.link).hostname)) naverUrl = n.link;
    } catch {
      // ignore
    }
    items.push({
      id: origLink,
      title: stripHtml(n.title),
      publisher,
      url: origLink,
      naverUrl,
      publishedAt: new Date(t).toISOString(),
      market: "kr",
      symbol,
      excerpt: n.description ? stripHtml(n.description) : undefined,
    });
  }
  return items;
}

export async function fetchStockNews(
  market: MarketId,
  symbol: string,
  companyName?: string | null,
): Promise<NewsItem[]> {
  const query = companyName || symbol;
  const items =
    market === "kr" ? await fetchKrNews(symbol, query) : await fetchUsJpNews(market, symbol, query);
  // "제목에 회사명 포함" 필터는 비활성화 — 실측 결과 한국 뉴스 제목은 정식
  // 회사명을 잘 반복하지 않아(예: "삼성전자" 최신 기사 5건 중 제목에 포함된 건
  // 0건, "삼전"류 줄임말·본문 언급뿐) 관련 기사까지 대부분 걸러져 버림.
  // filterCompanySpecific(relevance.ts)는 이후 LLM 기반 판정으로 교체할 때
  // 재사용 — 지금은 미적용.
  return withTranslatedTitles(SOURCE_LANG[market], items);
}

/**
 * 종목분석 페이지 "종목뉴스" 탭 전용 — 국내(한국어 언론)·해외(영미권 등 외국 언론)
 * 를 종목의 실제 상장 시장과 무관하게 항상 함께 가져온다(예: 한국 종목도 로이터·
 * 블룸버그 보도가 있으면 해외란에 표시). 조회기간 1주일, 페이지네이션(10개×3페이지)
 * 대비 최대 30건까지 확보. 기존 fetchStockNews(유니버스통합뉴스 등에서 사용,
 * 시장별 단일 소스·90일·20건)는 동작 그대로 둔다.
 */
/**
 * 순수 텍스트 매칭으로는 "이 기사가 그 회사에 관한 것인가"를 정확히 판정할
 * 수 없다는 게 두 번의 실측으로 확인됐다: 요약에 정식명이 있는지만 보면
 * 부동산·지역 뉴스까지 다 통과(예: "삼성전자 인근 아파트")해 노이즈가 많고,
 * 반대로 "제목에 정식명·축약형이 있어야 함"으로 좁히면 대형주는 하루에도
 * 기사가 수십 건씩 나오는데 제목 조건 하나로 3건까지 떨어져 커버리지가
 * 너무 부실해진다(둘 다 실측 확인). 진짜 해결책은 LLM 기반 주제 판정인데
 * (relevance.ts 주석 참고) 아직 붙이지 않았으므로, 그때까지는:
 *  - 별칭 목록에 있는 대형주(뉴스량이 많아 약간의 노이즈보다 커버리지 부족이
 *    더 나쁨): 제목·요약 어디든 별칭이 있으면 통과 — recall 우선.
 *  - 그 외 종목(뉴스량이 적어 노이즈 허용치가 낮음): 제목에 정식명이 있거나
 *    "회사명(종목코드)" 표기가 제목·요약 어디든 있어야 통과 — precision 우선.
 */
const KR_COMPANY_ALIASES: Record<string, string[]> = {
  삼성전자: ["삼성전자", "삼성", "삼전"],
  "SK하이닉스": ["SK하이닉스", "하이닉스"],
  LG전자: ["LG전자"],
  "LG에너지솔루션": ["LG에너지솔루션", "LG엔솔"],
  현대차: ["현대차", "현대자동차"],
  기아: ["기아", "기아차"],
  삼성바이오로직스: ["삼성바이오로직스", "삼성바이오"],
  "삼성SDI": ["삼성SDI"],
  "NAVER": ["네이버", "NAVER"],
  카카오: ["카카오"],
  셀트리온: ["셀트리온"],
  "POSCO홀딩스": ["포스코"],
};

function isDomesticRelevant(
  companyName: string | null | undefined,
  symbol: string,
  title: string,
  excerpt?: string,
): boolean {
  const name = companyName?.trim();
  if (!name) return true;
  const aliases = KR_COMPANY_ALIASES[name];
  if (aliases) {
    const hay = `${title} ${excerpt ?? ""}`;
    return aliases.some((a) => hay.includes(a));
  }
  if (title.includes(name)) return true;
  const codeTag = `(${symbol})`;
  return title.includes(codeTag) || (excerpt != null && excerpt.includes(codeTag));
}

export async function fetchStockNewsBySide(
  market: MarketId,
  symbol: string,
  companyName?: string | null,
): Promise<{ domestic: NewsItem[]; overseas: NewsItem[] }> {
  const query = companyName || symbol;
  const [domesticRaw, overseasRaw] = await Promise.all([
    fetchKrNews(symbol, query, { cutoffMs: ONE_WEEK_MS, display: 30 }),
    fetchUsJpNews(market, symbol, query, { cutoffMs: ONE_WEEK_MS, newsCount: 30 }),
  ]);
  const domesticFiltered = domesticRaw.filter((it) =>
    isDomesticRelevant(companyName, symbol, it.title, it.excerpt),
  );
  // 안전장치: 휴리스틱이 전부 걸러내 버리면(오탐으로 0건) 필터 없이 보여준다 —
  // "관련 기사 없음"보다 "관련성 낮은 기사 섞임"이 훨씬 나은 실패 모드.
  const domesticSafe = domesticFiltered.length > 0 || domesticRaw.length === 0 ? domesticFiltered : domesticRaw;
  const [domestic, overseas] = await Promise.all([
    withTranslatedTitles("ko", domesticSafe),
    withTranslatedTitles("en", overseasRaw),
  ]);
  return { domestic, overseas };
}

/** 국내(이미 한국어) 언론사인지 — 번역·요약 대상 여부 판정(종목의 상장 시장이 아니라 기사 언론사 기준). */
const DOMESTIC_PUBLISHERS = new Set(Object.values(KR_PUBLISHER_BY_DOMAIN));
export function isDomesticPublisher(publisher: string): boolean {
  return DOMESTIC_PUBLISHERS.has(publisher);
}

/** 서버가 기사 1건을 재검증(클라이언트값 신뢰 안 함) — summarize 라우트에서 사용. */
export function isAllowedArticle(publisher: string, publishedAt: string): boolean {
  if (!ALLOWED_PUBLISHERS.has(publisher.toLowerCase())) return false;
  const t = Date.parse(publishedAt);
  if (!Number.isFinite(t)) return false;
  return t >= Date.now() - ONE_WEEK_MS;
}

/**
 * 체크한 기사 1건의 본문을 온디맨드로 가져와 텍스트만 추출(배치·주기적 수집 아님).
 * 완전한 본문 파싱은 아님 — 태그 제거 정도의 거친 추출이라 광고·내비 텍스트가
 * 섞일 수 있지만, LLM 이 번역·요약 시 자연스럽게 걸러낸다.
 */
export async function fetchArticleBody(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; research-bot)" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`기사 본문 요청 실패 ${res.status}`);
  const html = await res.text();
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
