import "server-only";
import YahooFinancePkg from "yahoo-finance2";
import { fetchJson } from "./http";
import type { MarketId } from "./types";
import { translateTitles } from "../news/translate";
import { fetchGoogleNewsRss, googleNewsUrl } from "../news/googleNews";
import { resolveCorpCode } from "./kr/corpcode";
import { judgeNewsRelevance } from "../llm/claude";
import { isBudgetExceeded, incUsage } from "../db/llm-usage";

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
    // 미국 — 2차 티어 금융매체(2026-09 확장, 오너 승인: 상위 통신사만으로는
    // 한국 종목의 영문명 검색 결과가 대부분 화이트리스트 밖이라 해외뉴스가
    // 자주 0건으로 보이는 문제 — recall 우선으로 완화)
    "TheStreet",
    "The Motley Fool",
    "Motley Fool",
    "GuruFocus.com",
    "GuruFocus",
    "Insider Monkey",
    "Kiplinger",
    // "MT Newswires" 제외(오너 확인, 2026-09) — 실측: 링크가 회원가입 필요한
    // Yahoo Finance Premium 페이지로 연결됨, 제목도 미확인 소문("Market
    // Chatter:") 형식이 잦음. 둘 다 이 소스 특유의 반복 패턴으로 확인됨.
    "Seeking Alpha",
    "Benzinga",
    "Zacks",
    "CNN Business", // 오너 요청(2026-09) — Google 뉴스 경유로만 나옴(야후엔 없음)
    // 일본
    "Nikkei Asia",
    "The Japan Times",
    "Kyodo News",
    // 한국 (도메인 매칭 결과 값 — KR_PUBLISHER_BY_DOMAIN 과 동일 목록 유지)
    "연합뉴스",
    "뉴시스", // 연합뉴스급 정식 통신사인데 누락돼 있었음(2026-09, 오너 확인)
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

/** 한국 뉴스 원문 링크 도메인 → 언론사명. 없는 도메인은 화이트리스트 밖으로 처리.
 * 세계일보 등 메이저 종합일간지가 누락돼 있던 문제가 반복 확인돼(오너 지적,
 * 2026-09) 주요 종합일간지·경제지를 폭넓게 보강 — "노이즈" 문제는 극소수
 * 초유명 대기업(별칭 목록으로 대응)에서만 발생하니 recall 우선 원칙 유지. */
const KR_PUBLISHER_BY_DOMAIN: Record<string, string> = {
  "yna.co.kr": "연합뉴스",
  "newsis.com": "뉴시스",
  "hankyung.com": "한국경제",
  "mk.co.kr": "매일경제",
  "sedaily.com": "서울경제",
  "biz.chosun.com": "조선비즈",
  "mt.co.kr": "머니투데이",
  "edaily.co.kr": "이데일리",
  "fnnews.com": "파이낸셜뉴스",
  "segye.com": "세계일보",
  "heraldcorp.com": "헤럴드경제",
  "asiae.co.kr": "아시아경제",
  "news1.kr": "뉴스1",
  "kmib.co.kr": "국민일보",
  "munhwa.com": "문화일보",
  "seoul.co.kr": "서울신문",
  "khan.co.kr": "경향신문",
  "joongang.co.kr": "중앙일보",
  "joins.com": "중앙일보",
  "donga.com": "동아일보",
  "magazine.hankyung.com": "한경비즈니스",
  "hankookilbo.com": "한국일보",
};

/** 이 도메인 맵에 있는(=사전 큐레이션된 주요 언론사) 발행사명 집합 — 중복기사
 * 정리 시 "메이저" 판단, 요약 대상 판정에도 재사용. */
const DOMESTIC_PUBLISHERS = new Set(Object.values(KR_PUBLISHER_BY_DOMAIN));

const THREE_MONTHS_MS = 90 * 24 * 3600_000;
const ONE_WEEK_MS = 7 * 24 * 3600_000;

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();
}

async function fetchUsJpNews(
  market: MarketId,
  symbol: string,
  query: string,
  opts?: { cutoffMs?: number; newsCount?: number; requireWhitelist?: boolean },
): Promise<Omit<NewsItem, "titleKo">[]> {
  const requireWhitelist = opts?.requireWhitelist ?? true;
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
    // 종목뉴스 탭(requireWhitelist=false)은 화이트리스트로 미리 걸러내지 않고
    // LLM 관련성 판정이 신뢰성까지 함께 판단하게 한다(오너 확인, 2026-09 —
    // 고정 목록을 신뢰할 수 없다는 지적). 유니버스 통합뉴스(fetchStockNews,
    // 기본값 true)는 LLM 후처리가 없어 화이트리스트를 그대로 유지.
    if (requireWhitelist && !ALLOWED_PUBLISHERS.has(n.publisher.toLowerCase())) continue;
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

/**
 * 해외뉴스 도메인 → 매체명 — Google 뉴스 RSS 의 <source> 텍스트 표기가 일관되지
 * 않아서(실측: "Bloomberg.com"/"reuters.com" 처럼 도메인 그대로 나오기도 함)
 * <source url="..."> 속성의 도메인으로 판정한다(googleNews.ts 의 sourceDomain).
 */
const OVERSEAS_PUBLISHER_BY_DOMAIN: Record<string, string> = {
  "reuters.com": "Reuters",
  "bloomberg.com": "Bloomberg",
  "apnews.com": "AP News",
  "wsj.com": "The Wall Street Journal",
  "ft.com": "Financial Times",
  "cnbc.com": "CNBC",
  "barrons.com": "Barron's",
  "marketwatch.com": "MarketWatch",
  "finance.yahoo.com": "Yahoo Finance",
  "investors.com": "Investor's Business Daily",
  "thestreet.com": "TheStreet",
  "fool.com": "The Motley Fool",
  "gurufocus.com": "GuruFocus.com",
  "insidermonkey.com": "Insider Monkey",
  "kiplinger.com": "Kiplinger",
  "seekingalpha.com": "Seeking Alpha",
  "benzinga.com": "Benzinga",
  "zacks.com": "Zacks",
  "cnn.com": "CNN Business",
  "edition.cnn.com": "CNN Business",
  "money.cnn.com": "CNN Business",
  "asia.nikkei.com": "Nikkei Asia",
  "japantimes.co.jp": "The Japan Times",
  "kyodonews.net": "Kyodo News",
};

/**
 * 해외뉴스 2차 소스(2026-09, 오너 요청) — 야후 검색 하나만으로는 커버리지가
 * 너무 좁아서(블룸버그·WSJ·CNN 등이 야후 검색 결과에 잘 안 잡힘) Google 뉴스
 * RSS(공개 신디케이션 피드, 이미 거시경제 뉴스 기능이 쓰는 것과 동일 인프라)를
 * 병행 조회한다. 고정 도메인 화이트리스트는 걸지 않는다(오너 확인, 2026-09
 * — 고정 목록을 신뢰할 수 없다는 지적, 국내뉴스 전환과 같은 방향) — LLM
 * 관련성 판정이 신뢰성까지 함께 판단. 화이트리스트 맵(OVERSEAS_PUBLISHER_
 * BY_DOMAIN)은 표시용 매체명 정리 목적으로만 남기고, 없는 도메인은 Google
 * 이 준 원문 매체명이나 도메인 자체를 그대로 쓴다.
 */
async function fetchGoogleOverseasNews(
  market: MarketId,
  symbol: string,
  query: string,
  opts?: { cutoffMs?: number; limit?: number },
): Promise<Omit<NewsItem, "titleKo">[]> {
  const url = googleNewsUrl(`search?q=${encodeURIComponent(query)}`, "hl=en-US&gl=US&ceid=US:en");
  const raw = await fetchGoogleNewsRss(url);
  const cutoff = Date.now() - (opts?.cutoffMs ?? THREE_MONTHS_MS);
  const limit = opts?.limit ?? 20;
  const items: Omit<NewsItem, "titleKo">[] = [];
  for (const n of raw) {
    const publisher =
      (n.sourceDomain ? OVERSEAS_PUBLISHER_BY_DOMAIN[n.sourceDomain] : undefined) ??
      n.source ??
      n.sourceDomain ??
      undefined;
    if (!publisher) continue;
    const t = new Date(n.publishedAt).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    items.push({ id: n.link, title: n.title, publisher, url: n.link, publishedAt: n.publishedAt, market, symbol });
    if (items.length >= limit) break;
  }
  return items;
}

interface NaverStockNewsItem {
  id: string;
  officeName: string;
  datetime: string; // "YYYYMMDDHHmm", KST
  title: string;
  body?: string;
  mobileNewsUrl: string;
}
type NaverStockNewsGroup = { total: number; items: NaverStockNewsItem[] };

/** "YYYYMMDDHHmm"(KST, UTC+9) → UTC epoch ms. */
function parseNaverStockDatetime(s: string): number {
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6)) - 1;
  const d = Number(s.slice(6, 8));
  const h = Number(s.slice(8, 10));
  const mi = Number(s.slice(10, 12));
  return Date.UTC(y, mo, d, h, mi) - 9 * 3600_000;
}

/**
 * 한국 종목의 국내뉴스 — 네이버 뉴스 검색 API(키워드 매칭) 대신 네이버 증권이
 * 종목코드별로 이미 태깅해둔 전용 API(`m.stock.naver.com/api/news/stock/{코드}`)
 * 를 쓴다(오너가 stock.naver.com 종목뉴스 페이지에서 직접 확인해 발견,
 * 2026-09). 검색 API + 소수 도메인 화이트리스트 조합은 실제로 관련 있는
 * 기사(예: 방산 전문지·경제 매거진 보도)를 반복적으로 놓쳤음(실측: 현대로템
 * 검색 결과 0건이었는데 이 API엔 정확히 관련 기사가 있었음) — 네이버가 이미
 * 종목-기사 매칭을 편집·알고리즘으로 해뒀으므로 도메인 화이트리스트도, LLM
 * 관련성 판정도 필요 없어짐(비용도 절감). CLAUDE.md 예외 2건(stock.naver.com,
 * 오너 명시 승인, robots.txt Disallow: /)의 실제 JSON 엔드포인트를 이번에
 * 찾음 — 미국 등 비 KR 티커는 빈 배열만 반환해 한국 종목 전용.
 */
async function fetchKrStockTaggedNews(
  symbol: string,
  opts?: { cutoffMs?: number; pageSize?: number; maxPages?: number },
): Promise<Omit<NewsItem, "titleKo">[]> {
  const pageSize = opts?.pageSize ?? 20;
  const maxPages = opts?.maxPages ?? 2;
  const cutoff = Date.now() - (opts?.cutoffMs ?? THREE_MONTHS_MS);
  const items: Omit<NewsItem, "titleKo">[] = [];
  let stop = false;
  for (let page = 1; page <= maxPages && !stop; page++) {
    let groups: NaverStockNewsGroup[];
    try {
      groups = await fetchJson<NaverStockNewsGroup[]>(
        `https://m.stock.naver.com/api/news/stock/${symbol}?pageSize=${pageSize}&page=${page}`,
        { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" }, revalidate: 900 },
      );
    } catch {
      break;
    }
    if (!Array.isArray(groups) || groups.length === 0) break;
    for (const g of groups) {
      const it = g.items?.[0];
      if (!it) continue;
      const t = parseNaverStockDatetime(it.datetime);
      if (!Number.isFinite(t) || t < cutoff) {
        stop = true;
        break;
      }
      items.push({
        id: it.id,
        title: stripHtml(it.title),
        publisher: it.officeName,
        url: it.mobileNewsUrl,
        publishedAt: new Date(t).toISOString(),
        market: "kr",
        symbol,
        excerpt: it.body ? stripHtml(it.body) : undefined,
      });
    }
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

/** 비 KR 종목(미국·일본)의 "국내(한국어 언론)" 커버리지 — 네이버 뉴스 검색
 * API(키워드 매칭). KR 종목은 fetchKrStockTaggedNews 를 대신 쓴다. */
async function fetchKrNewsBySearch(
  symbol: string,
  query: string,
  opts?: { cutoffMs?: number; display?: number; requireWhitelist?: boolean },
): Promise<Omit<NewsItem, "titleKo">[]> {
  const requireWhitelist = opts?.requireWhitelist ?? true;
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
    // 종목뉴스 탭(requireWhitelist=false)은 도메인 화이트리스트로 미리 걸러내지
    // 않고 LLM 관련성 판정이 신뢰성·진위까지 함께 판단하게 한다(오너 확인,
    // 2026-09) — 고정된 소수 도메인 목록보다 커버리지가 넓어짐(실측: 방산
    // 전문지 등 정당한 매체가 목록에 없어 빠지던 문제). 유니버스 통합뉴스
    // (fetchStockNews, requireWhitelist 기본값 true)는 기존 그대로 유지.
    const publisher = KR_PUBLISHER_BY_DOMAIN[host] ?? (requireWhitelist ? undefined : host);
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
  // KR은 네이버 증권의 종목코드별 태깅 API(fetchKrStockTaggedNews)를 써서
  // 애초에 검색·필터 자체가 불필요 — 나머지 시장은 기존 야후 검색 유지.
  const items =
    market === "kr" ? await fetchKrStockTaggedNews(symbol) : await fetchUsJpNews(market, symbol, query);
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
 * 수 없다는 게 여러 번의 실측으로 확인됐다: 요약에 정식명이 있는지만 보면
 * 부동산·지역 뉴스까지 다 통과(예: "삼성전자 인근 아파트")해 노이즈가 생기고,
 * "제목에 정식명·축약형이 있어야 함"으로 좁히면 대형주조차 3건까지 떨어지고
 * (실측) 나머지 대다수 종목은 뉴스량 자체가 적어 "제목에 정식명"·"(종목코드)"
 * 표기 조건까지 겹치면 사실상 전부 걸러져 "기사 없음"이 되어 버린다(오너 확인:
 * 삼성전자 외 거의 모든 종목이 그랬음). "부동산 랜드마크로 언급되는" 문제는
 * 실질적으로 삼성전자·SK·현대차 등 극히 유명한 대기업 몇 곳에서만 벌어지고,
 * 나머지 종목은 이름이 요약에 등장하면 거의 확실히 그 회사 얘기다. 그래서
 * 진짜 LLM 기반 주제 판정(relevance.ts 참고, 아직 미적용) 전까지는 전 종목
 * 공통으로 "제목·요약 어디든 이름(또는 별칭)이 있으면 통과" — recall 우선.
 * 별칭 목록은 그 소수의 유명 대기업이 즐겨 쓰는 축약형/계열사 통칭만 보강.
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
  _symbol: string,
  title: string,
  excerpt?: string,
): boolean {
  const name = companyName?.trim();
  if (!name) return true;
  const aliases = KR_COMPANY_ALIASES[name] ?? [name];
  const hay = `${title} ${excerpt ?? ""}`;
  return aliases.some((a) => hay.includes(a));
}

/**
 * 해외(야후) 검색어는 한국어 회사명을 그대로 넣으면 안 됨 — 실측(Yahoo Finance
 * search API) 결과 한글 쿼리("삼성전자")는 "Invalid Search Query" 에러로 아예
 * 실패(빈 배열로 조용히 폴백돼 "해외 뉴스 없음"처럼 보였던 원인). 영문명
 * ("Samsung Electronics")이나 티커로 바꾸면 정상 응답한다. `corpcode.ts` 의
 * 정적 상장사 목록(DART_API_KEY 불필요)에서 영문명을 찾아 대체.
 *
 * `corpEngName` 은 DART 등록 정식 법인명이라 "CO,.LTD"/"Inc." 같은 법인격
 * 접미사가 붙어있는데, 실측 결과 이 접미사가 있으면 야후 검색 품질이 다시
 * 나빠진다("SAMSUNG ELECTRONICS CO,.LTD" 는 무관한 결과 1건, "Samsung
 * Electronics" 는 관련 결과 10건). 접미사를 제거한 짧은 이름으로 검색한다.
 */
const LEGAL_SUFFIXES = new Set(["CO", "LTD", "INC", "CORP", "CORPORATION", "LIMITED", "COMPANY", "PLC"]);
function stripLegalSuffix(engName: string): string {
  const words = engName.split(/[\s,.]+/).filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1].toUpperCase())) {
    words.pop();
  }
  return words.join(" ");
}

function overseasQuery(market: MarketId, symbol: string, companyName: string): string {
  if (market !== "kr") return companyName;
  try {
    const eng = resolveCorpCode("", symbol).corpEngName;
    return eng ? stripLegalSuffix(eng) : companyName;
  } catch {
    return companyName;
  }
}

/**
 * 미국·일본 종목의 국내(네이버) 검색어 — 영문명 그대로 넣으면 네이버가 회사와
 * 무관한 콘텐츠를 반환한다(실측: "Apple" 검색 결과 전부 뉴욕타임스 칼럼 등
 * 무관한 영어 콘텐츠, "애플"은 전부 정확히 관련). 잘 알려진 대형주만 한글
 * 표기로 치환 — 없으면 영문 그대로(오너 확인, 2026-09).
 */
const US_COMPANY_KO_ALIAS: Record<string, string> = {
  Apple: "애플",
  Tesla: "테슬라",
  NVIDIA: "엔비디아",
  Microsoft: "마이크로소프트",
  Amazon: "아마존",
  "Amazon.com": "아마존",
  Alphabet: "구글",
  Google: "구글",
  Meta: "메타",
  "Meta Platforms": "메타",
  Netflix: "넷플릭스",
  Broadcom: "브로드컴",
  Qualcomm: "퀄컴",
  Intel: "인텔",
  "Advanced Micro Devices": "AMD",
  Oracle: "오라클",
  Salesforce: "세일즈포스",
  Boeing: "보잉",
  Nike: "나이키",
  Starbucks: "스타벅스",
  "Coca-Cola": "코카콜라",
  "The Coca-Cola Company": "코카콜라",
  Disney: "디즈니",
  "Walt Disney": "디즈니",
  "JPMorgan Chase": "JP모건",
  "Berkshire Hathaway": "버크셔 해서웨이",
};

function domesticQuery(market: MarketId, companyName: string): string {
  if (market === "kr") return companyName;
  const stripped = stripLegalSuffix(companyName);
  return US_COMPANY_KO_ALIAS[companyName.trim()] ?? US_COMPANY_KO_ALIAS[stripped] ?? companyName;
}

type RawNewsItem = Omit<NewsItem, "titleKo">;

/** 통신사발 기사가 여러 매체에 그대로 재게재될 때 붙는 흔한 꼬리표(속보 단계 표기 등). */
const WIRE_SUFFIX_RE = /[（(][^)）]{0,10}[)）]\s*$/;
function normalizeTitleForDedup(title: string): string {
  return title
    .replace(WIRE_SUFFIX_RE, "")
    .replace(/[\s"'“”‘’.,·]/g, "")
    .toLowerCase();
}

/**
 * 같은 내용(제목 사실상 동일)이 통신사발로 여러 매체에 재게재된 경우 대표 1건만
 * 남긴다(오너 지적, 2026-09) — 화이트리스트 도메인 요건을 완화(requireWhitelist
 * =false)하면서 같은 기사가 여러 매체 이름으로 중복 노출되는 문제가 부각됨.
 * 그룹 내 사전 큐레이션된 주요 언론사(DOMESTIC_PUBLISHERS) 소속이 있으면 그걸
 * 우선하고, 없으면 최신순으로 첫 번째를 남긴다.
 */
function dedupeByMajorPublisher(items: RawNewsItem[]): RawNewsItem[] {
  const groups = new Map<string, RawNewsItem[]>();
  for (const it of items) {
    const key = normalizeTitleForDedup(it.title);
    const group = groups.get(key);
    if (group) group.push(it);
    else groups.set(key, [it]);
  }
  const result: RawNewsItem[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    const sorted = [...group].sort(
      (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
    );
    result.push(sorted.find((it) => DOMESTIC_PUBLISHERS.has(it.publisher)) ?? sorted[0]);
  }
  return result.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
}

/**
 * LLM(Haiku) 관련성 판정 — 국내+해외 후보를 한 번의 호출로 함께 판정해 종목
 * 조회 1회당 호출 1회로 비용을 묶는다(라우트 자체가 30분 캐시라 실질 호출은
 * 더 뜸함). ANTHROPIC_API_KEY 미설정·예산 초과·호출 실패 시 null 반환 →
 * 호출부가 기존 키워드 매칭으로 폴백(뉴스 기능 자체가 죽지 않게).
 */
/** Vercel 대시보드 로그 확인이 번거로워 응답 자체에 진단 사유를 실어 curl로 바로 확인. */
export type LlmFallbackReason = "no_api_key" | "budget_exceeded" | "call_failed";

/**
 * 한쪽(국내 또는 해외)만 판정 — 국내+해외를 한 배치로 합치면(실측 재현: 17건
 * 배치에서 국내는 8→5로 정확히 걸러졌는데 해외 9건은 전부 통과) 모델이 후반부
 * 항목 판정을 덜 엄격하게 하는 경향이 확인돼, 배치를 쪼개 각각 더 일관되게
 * 판정하게 한다(비용은 호출 2회로 늘지만 여전히 무시할 수준).
 */
async function filterOneSide(
  companyName: string,
  raw: RawNewsItem[],
): Promise<{ items: RawNewsItem[]; costUsd: number }> {
  if (raw.length === 0) return { items: [], costUsd: 0 };
  const candidates = raw.map((it, i) => ({
    id: String(i),
    title: it.title,
    excerpt: it.excerpt,
    publisher: it.publisher,
  }));
  const { relevantIds, duplicateGroups, costUsd } = await judgeNewsRelevance(companyName, candidates);

  const keep = new Set(relevantIds);
  for (const group of duplicateGroups) {
    const members = group.filter((id) => keep.has(id));
    if (members.length <= 1) continue;
    const sorted = members
      .map((id) => ({ id, item: raw[Number(id)] }))
      .sort((a, b) => new Date(b.item.publishedAt).getTime() - new Date(a.item.publishedAt).getTime());
    const chosen = sorted.find((m) => DOMESTIC_PUBLISHERS.has(m.item.publisher)) ?? sorted[0];
    for (const id of members) if (id !== chosen.id) keep.delete(id);
  }

  const filtered = raw.filter((_, i) => keep.has(String(i)));
  // 안전장치: LLM이 전부 걸러내 버리면(원본은 있는데 결과 0건) 필터 없이 보여준다 —
  // "관련 기사 없음"보다 "관련성 낮은 기사 섞임"이 훨씬 나은 실패 모드.
  const items = filtered.length > 0 || raw.length === 0 ? filtered : raw;
  return { items, costUsd };
}

async function tryLlmRelevanceFilter(
  companyName: string,
  domesticRaw: RawNewsItem[],
  overseasRaw: RawNewsItem[],
  /** KR 종목의 국내뉴스는 네이버가 이미 종목코드로 태깅해준 신뢰 가능한
   * 소스(fetchKrStockTaggedNews)라 LLM 판정이 불필요 — 그대로 통과시킨다
   * (호출 1회 줄어 비용도 절감). */
  skipDomestic: boolean,
): Promise<
  | { domestic: RawNewsItem[]; overseas: RawNewsItem[]; fallback: null }
  | { domestic: null; overseas: null; fallback: LlmFallbackReason }
> {
  if (!process.env.ANTHROPIC_API_KEY) return { domestic: null, overseas: null, fallback: "no_api_key" };
  if (domesticRaw.length === 0 && overseasRaw.length === 0) {
    return { domestic: [], overseas: [], fallback: null };
  }
  try {
    if (await isBudgetExceeded()) return { domestic: null, overseas: null, fallback: "budget_exceeded" };
    const [domesticResult, overseasResult] = await Promise.all([
      skipDomestic ? { items: domesticRaw, costUsd: 0 } : filterOneSide(companyName, domesticRaw),
      filterOneSide(companyName, overseasRaw),
    ]);
    await incUsage(domesticResult.costUsd + overseasResult.costUsd);
    return { domestic: domesticResult.items, overseas: overseasResult.items, fallback: null };
  } catch (err) {
    console.error("[news] LLM 관련성 판정 실패, 키워드 매칭으로 폴백:", err);
    return { domestic: null, overseas: null, fallback: "call_failed" };
  }
}

export async function fetchStockNewsBySide(
  market: MarketId,
  symbol: string,
  companyName?: string | null,
): Promise<{
  domestic: NewsItem[];
  overseas: NewsItem[];
  debug: { rawDomestic: number; rawOverseas: number; relevance: "llm" | LlmFallbackReason | "no_company_name" };
}> {
  const query = companyName || symbol;
  const oQuery = overseasQuery(market, symbol, query);
  const isKr = market === "kr";
  const [domesticRaw, yahooOverseas, googleOverseas] = await Promise.all([
    isKr
      ? fetchKrStockTaggedNews(symbol, { cutoffMs: ONE_WEEK_MS, pageSize: 20, maxPages: 2 })
      : fetchKrNewsBySearch(symbol, domesticQuery(market, query), { cutoffMs: ONE_WEEK_MS, display: 30 }),
    fetchUsJpNews(market, symbol, oQuery, { cutoffMs: ONE_WEEK_MS, newsCount: 30, requireWhitelist: false }),
    fetchGoogleOverseasNews(market, symbol, oQuery, { cutoffMs: ONE_WEEK_MS, limit: 30 }).catch(() => []),
  ]);
  // 야후·구글 두 소스에서 같은 기사(URL 동일)가 겹칠 수 있어 합치기 전 URL 기준
  // 1차 정리(문구만 다른 별도 기사의 중복은 LLM 판정 단계에서 그룹으로 잡음).
  const seenUrls = new Set<string>();
  const overseasRaw = [...yahooOverseas, ...googleOverseas].filter((it) => {
    if (seenUrls.has(it.url)) return false;
    seenUrls.add(it.url);
    return true;
  });

  const name = companyName?.trim();
  // KR도 LLM 판정을 항상 시도 — 네이버 태깅이 검색 방식보다 훨씬 정확하지만
  // 완전히 회사 전용은 아님(실측: 현대로템 태깅 31건 중 "경남 일자리 종합박람회"
  // "삼성전자 브랜드가치" 등 무관한 업종 뉴스 소수 섞임). LLM이 남은 노이즈만
  // 걷어내되(skipDomestic=false), LLM 미사용시엔 신뢰 가능한 원본 그대로 둔다.
  const llmResult = name ? await tryLlmRelevanceFilter(name, domesticRaw, overseasRaw, false) : null;

  let domesticSafe: RawNewsItem[];
  let overseasSafe: RawNewsItem[];
  let relevance: "llm" | LlmFallbackReason | "no_company_name";
  if (llmResult && llmResult.fallback === null) {
    // LLM 경로: 신뢰도 판정을 모델이 직접 하므로 도메인 화이트리스트 없이도 안전.
    domesticSafe = llmResult.domestic;
    overseasSafe = llmResult.overseas;
    relevance = "llm";
  } else if (isKr) {
    // KR + LLM 미사용(키 없음·예산초과·호출실패): 네이버가 이미 종목코드로
    // 태깅해준 소스라 화이트리스트·키워드 매칭 없이 그대로 신뢰.
    domesticSafe = domesticRaw;
    overseasSafe = overseasRaw;
    relevance = !name ? "no_company_name" : (llmResult?.fallback ?? "no_api_key");
  } else {
    // 폴백(비KR 종목, 이름 미확인·LLM 미사용 공통): 신뢰도를 대신 판정해줄
    // 수단이 없으므로 사전 큐레이션된 화이트리스트로 되돌리고, 이름이 있으면
    // 그 안에서 키워드 매칭까지 적용.
    const whitelisted = domesticRaw.filter((it) => DOMESTIC_PUBLISHERS.has(it.publisher));
    if (name) {
      const domesticFiltered = whitelisted.filter((it) =>
        isDomesticRelevant(companyName, symbol, it.title, it.excerpt),
      );
      domesticSafe =
        domesticFiltered.length > 0 || whitelisted.length === 0 ? domesticFiltered : whitelisted;
    } else {
      domesticSafe = whitelisted;
    }
    overseasSafe = overseasRaw; // 해외는 fetchUsJpNews 단계에서 이미 ALLOWED_PUBLISHERS로 걸러짐
    relevance = !name ? "no_company_name" : (llmResult?.fallback ?? "no_api_key");
  }
  domesticSafe = dedupeByMajorPublisher(domesticSafe);

  const [domestic, overseas] = await Promise.all([
    withTranslatedTitles("ko", domesticSafe),
    withTranslatedTitles("en", overseasSafe),
  ]);
  return {
    domestic,
    overseas,
    debug: { rawDomestic: domesticRaw.length, rawOverseas: overseasRaw.length, relevance },
  };
}

/** 국내(이미 한국어) 언론사인지 — 번역·요약 대상 여부 판정(종목의 상장 시장이 아니라 기사 언론사 기준). */
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
