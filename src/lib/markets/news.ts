import "server-only";
import YahooFinancePkg from "yahoo-finance2";
import { fetchJson } from "./http";
import type { MarketId } from "./types";
import { translateTitles, type TranslateOptions } from "../news/translate";
import { fetchGoogleNewsRss, googleNewsUrl } from "../news/googleNews";
import { resolveCorpCode } from "./kr/corpcode";
import { JP_ALIAS_SPORTS_RE, KO_PRODUCT_ALIASES, KR_COMPANY_ALIASES, KR_CONTEXT_ALIASES, judgeDomesticTitle, judgeOverseasTitle, koAcronymName, koTitleHit, enTitleHit, shortAliasHit, type ShortAlias, type Verdict } from "./news-rules";

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
  opts: TranslateOptions = {},
): Promise<NewsItem[]> {
  const translated = await translateTitles(items, lang, (it) => it.title, opts);
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
    "Investing.com", // 오너 요청(2026-09) — Google 뉴스 경유로만 나옴(야후엔 없음)
    "CNN Business", // 오너 요청(2026-09) — Google 뉴스 경유로만 나옴(야후엔 없음)
    // 미국 — 메이저 종합·테크 매체(2026-09-15 추가, 오너 승인): AMZN 후보 43건
    // 실측에서 탈락 33건이 전부 "목록 밖" 사유였고 그중 상당수가 아래 매체였음.
    // 지역 방송(교통사고·배심원 출석)·기업 블로그 노이즈는 여전히 목록 밖.
    "Axios",
    "USA Today",
    "CBS News",
    "NBC News",
    "NPR",
    "Fox Business",
    "Fortune",
    "TechCrunch",
    "The Guardian",
    "Variety",
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
  "chosun.com": "조선일보",
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

/**
 * 한국 언론사 판정 — **해외뉴스에서 걸러내기 위한 것**(오너 지적 2026-09:
 * "해외뉴스에 국내 언론사는 제외하라 했는데 한화에어로스페이스 해외뉴스에
 * 조선일보가 나온다").
 *
 * 전에는 `KR_PUBLISHER_BY_DOMAIN` 의 **정확히 일치**하는 도메인과 매체명만
 * 걸렀는데, 실측해 보니 세 방향으로 샜다.
 *  - 목록 누락: `chosun.com`(조선일보)이 없었다. 조선비즈만 있었다.
 *  - 하위 도메인: `en.sedaily.com`(서울경제 영문판)은 `sedaily.com` 과
 *    정확히 같지 않아 통과했다.
 *  - 한국 매체의 영문판: 코리아헤럴드·코리아중앙데일리·한국경제 영문판
 *    (kedglobal)·코리아타임스·비즈니스코리아. 이름도 도메인도 영어라
 *    한국 매체 목록 어디에도 안 걸렸다.
 *
 * 그래서 목록을 늘리는 대신 판정을 바꾼다 — `.kr` 최상위 도메인, 도메인
 * 접미사 일치, 매체명에 한글 포함. 셋 중 하나면 국내로 본다. 영문 피드에
 * 한글 이름이 찍히는 매체는 사실상 전부 한국 매체라 이 신호가 특히 강하다.
 */
const KR_MEDIA_DOMAINS = [
  // 위 KR_PUBLISHER_BY_DOMAIN 과 별개 — 여기는 "해외뉴스에서 뺄 대상"이라
  // 영문판·전문지까지 더 넓게 잡는다.
  "chosun.com",
  "donga.com",
  "joongang.co.kr",
  "joins.com",
  "koreajoongangdaily.com",
  "koreaherald.com",
  "koreatimes.co.kr",
  "kedglobal.com",
  "businesskorea.co.kr",
  "koreabizwire.com",
  "pulsenews.co.kr",
  "hankyung.com",
  "sedaily.com",
  "mk.co.kr",
  "newsis.com",
  "segye.com",
  "heraldcorp.com",
  "munhwa.com",
  "hankookilbo.com",
  "fnnews.com",
  "etnews.com",
  "thelec.net",
  "newspim.com",
  "ajunews.com",
  "ajudaily.com",
  "inews24.com",
  "mt.co.kr",
  "asiae.co.kr",
  "starnewskorea.com",
];

/**
 * 도메인에 "korea" 가 들어가면 한국 매체로 본다. 영문 이름·`.com` 을 쓰는
 * 한국 매체(코리아헤럴드·코리아중앙데일리·비즈니스코리아·스타뉴스코리아 …)
 * 가 길게 이어져 목록으로는 계속 새기 때문이다. 한국을 다루는 외국 매체가
 * 드물게 함께 걸릴 수 있으나, 그런 기사는 국내뉴스 쪽에서 이미 다루는
 * 내용이라 손실이 작다고 보고 recall 을 택했다.
 */
const KOREA_IN_DOMAIN_RE = /(^|[.-])korea/i;

/**
 * 한국에 있지만 **한글판이 없는 영문 전용 매체** — 해외뉴스에 남긴다
 * (오너 지적 2026-09: "코리아타임스는 한글판이 없지 않니?").
 *
 * 국내 매체를 해외뉴스에서 빼는 근거는 "같은 내용이 국내뉴스에 이미 나오니
 * 손실이 없다"였는데, 이 매체들은 한국어 기사 자체가 없어 국내뉴스(네이버
 * 한국어 검색)에 잡히지 않는다. 빼면 어느 탭에서도 안 보인다.
 *
 * 반대로 **한글판이 있는 영문판**(서울경제 en.sedaily.com, 연합뉴스
 * en.yna.co.kr, 코리아중앙데일리=중앙일보, KED Global=한국경제, Pulse=매일경제,
 * english.chosun.com=조선일보)은 계속 제외한다 — 같은 기사가 국내뉴스에 있다.
 *
 * 이 목록은 다른 모든 판정보다 먼저 본다(`.kr` TLD·korea 도메인 규칙에
 * 먼저 걸리기 때문).
 */
const KR_ENGLISH_ONLY_DOMAINS = [
  "koreatimes.co.kr",
  "koreaherald.com",
  "theinvestor.co.kr", // 코리아헤럴드 영문 경제 사이트
  "businesskorea.co.kr",
  "koreabizwire.com",
];

export function isKoreanNewsSource(
  domain: string | null | undefined,
  source: string | null | undefined,
): boolean {
  const d = (domain ?? "").toLowerCase().replace(/^www\./, "");
  if (d) {
    // 영문 전용 국내 매체는 해외뉴스에 남긴다 — 다른 규칙보다 먼저 본다.
    if (KR_ENGLISH_ONLY_DOMAINS.some((k) => d === k || d.endsWith(`.${k}`))) return false;
    if (d === "kr" || d.endsWith(".kr")) return true;
    if (KR_MEDIA_DOMAINS.some((k) => d === k || d.endsWith(`.${k}`))) return true;
    if (KR_PUBLISHER_BY_DOMAIN[d]) return true;
    if (KOREA_IN_DOMAIN_RE.test(d)) return true;
  }
  const src = (source ?? "").trim();
  if (!src) return false;
  if (/[가-힣]/.test(src)) return true;
  return DOMESTIC_PUBLISHERS.has(src);
}

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
  "investing.com": "Investing.com",
  "cnn.com": "CNN Business",
  "edition.cnn.com": "CNN Business",
  "money.cnn.com": "CNN Business",
  "axios.com": "Axios",
  "usatoday.com": "USA Today",
  "cbsnews.com": "CBS News",
  "nbcnews.com": "NBC News",
  "npr.org": "NPR",
  "foxbusiness.com": "Fox Business",
  "fortune.com": "Fortune",
  "techcrunch.com": "TechCrunch",
  "theguardian.com": "The Guardian",
  // 종합 일간지·방송사 보강 (오너 지적 2026-09-17 — "뉴욕타임스가 유명 뉴스
  // 아닌가?"). 목록이 미국 경제지·통신사 위주로 짜여 있어 정작 가장 빠른
  // 기사를 내는 종합지들이 통째로 빠지고 있었다. 실측: 거시경제 해외뉴스의
  // 최신이 4.7시간 전이었는데, 버려진 상위 기사가 뉴욕타임스 1.0시간 전·
  // 워싱턴포스트 1.1시간 전·BBC 3.7시간 전이었다.
  "nytimes.com": "The New York Times",
  "washingtonpost.com": "The Washington Post",
  "bbc.com": "BBC",
  "bbc.co.uk": "BBC",
  "economist.com": "The Economist",
  "politico.com": "Politico",
  "thehill.com": "The Hill",
  "abcnews.go.com": "ABC News",
  "businessinsider.com": "Business Insider",
  "forbes.com": "Forbes",
  "time.com": "TIME",
  "latimes.com": "Los Angeles Times",
  "aljazeera.com": "Al Jazeera",
  "scmp.com": "South China Morning Post",
  // 2차 보강 (오너 지시 2026-09-17 — "유명한데 리스트에 포함 안 된 곳 찾아봐라").
  // 실제 피드에서 주제 필터는 통과하는데 목록에 없어 버려지던 도메인을 세어
  // 골랐다. 상위권의 FXStreet·Kitco·FXEmpire·OilPrice 는 특정 상품 전문
  // 사이트라 시황에 노이즈가 되고, StockTwits·TradingView 는 커뮤니티·도구,
  // 인도 매체들은 이 화면 범위 밖이라 일부러 뺐다.
  "morningstar.com": "Morningstar",
  "global.morningstar.com": "Morningstar",
  "investopedia.com": "Investopedia",
  "pbs.org": "PBS",
  "abcnews.com": "ABC News",
  "uk.finance.yahoo.com": "Yahoo Finance",
  "theglobeandmail.com": "The Globe and Mail",
  "variety.com": "Variety",
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
  opts?: {
    cutoffMs?: number;
    limit?: number;
    requireWhitelist?: boolean;
    /** 주면 그 회사가 직접 운영하는 페이지(보도자료)를 제외한다 */
    companyName?: string | null;
  },
): Promise<Omit<NewsItem, "titleKo">[]> {
  const url = googleNewsUrl(`search?q=${encodeURIComponent(query)}`, "hl=en-US&gl=US&ceid=US:en");
  const raw = await fetchGoogleNewsRss(url);
  const cutoff = Date.now() - (opts?.cutoffMs ?? THREE_MONTHS_MS);
  const limit = opts?.limit ?? 20;
  const requireWhitelist = opts?.requireWhitelist ?? false;
  const items: Omit<NewsItem, "titleKo">[] = [];
  for (const n of raw) {
    // Google 뉴스 RSS는 hl=en-US 로 요청해도 국내 매체 기사를 섞어 보낸다
    // (실측, 2026-09 — 서울경제에 이어 조선일보·코리아헤럴드 등). 한국어
    // 제목을 sl="en" 으로 잘못 번역 시도하면 원문 그대로 노출되기도 해서
    // 여기서 원천 차단한다. 판정 근거는 isKoreanNewsSource() 주석 참고.
    if (isKoreanNewsSource(n.sourceDomain, n.source)) continue;
    // 회사 자체 홍보 페이지(보도자료)는 언론 보도가 아니라 제외
    if (isSelfPromoSource(n.sourceDomain, opts?.companyName)) continue;
    const mapped = n.sourceDomain ? OVERSEAS_PUBLISHER_BY_DOMAIN[n.sourceDomain] : undefined;
    // 종목뉴스 탭은 LLM 관련성 판정이 신뢰도까지 함께 보므로 화이트리스트 밖
    // 매체도 표시용 이름을 그대로 써서 통과시킨다(requireWhitelist 기본 false).
    // 거시경제 뉴스는 LLM 판정이 없어 화이트리스트 밖 매체를 걸러내야 한다
    // (requireWhitelist=true로 호출, fetchMacroNews 참고).
    if (requireWhitelist && !mapped) continue;
    const publisher = mapped ?? n.source ?? n.sourceDomain ?? undefined;
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
  opts?: { cutoffMs?: number; pageSize?: number; maxPages?: number; code?: string },
): Promise<Omit<NewsItem, "titleKo">[]> {
  // KR 은 종목코드 그대로, 해외는 네이버 reutersCode(예: NFLX.O / KO / CPNG.K).
  const code = opts?.code ?? symbol;
  const pageSize = opts?.pageSize ?? 20;
  const maxPages = opts?.maxPages ?? 2;
  const cutoff = Date.now() - (opts?.cutoffMs ?? THREE_MONTHS_MS);
  const items: Omit<NewsItem, "titleKo">[] = [];
  let stop = false;
  for (let page = 1; page <= maxPages && !stop; page++) {
    let groups: NaverStockNewsGroup[];
    try {
      groups = await fetchJson<NaverStockNewsGroup[]>(
        `https://m.stock.naver.com/api/news/stock/${encodeURIComponent(code)}?pageSize=${pageSize}&page=${page}`,
        { headers: { "user-agent": NAVER_UA }, revalidate: 300 },
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

/** 네이버 해외종목 자동완성 응답 1건. */
interface NaverAcItem {
  code?: string;
  name?: string;
  reutersCode?: string;
  nationCode?: string;
  typeCode?: string;
}

/**
 * 미국·일본 티커 → 네이버 해외종목 코드(reutersCode)와 한국어 종목명.
 * 나스닥은 "NFLX.O", 뉴욕은 접미사 없음("KO") 또는 ".K"(예: CPNG.K)로 제각각이라
 * 접미사를 추측하지 않고 자동완성 API(ac.stock.naver.com)로 정확히 해석한다
 * (오너가 stock.naver.com 해외종목 뉴스 화면을 짚어줘 발견, 2026-09).
 * 종목명("넷플릭스")은 국내뉴스 검색어로도 그대로 쓴다 — 하드코딩 별칭 맵보다
 * 커버리지가 넓다.
 */
async function resolveNaverWorldStock(
  symbol: string,
): Promise<{ code: string; koreanName: string | null } | null> {
  let res: { items?: NaverAcItem[] };
  try {
    res = await fetchJson<{ items?: NaverAcItem[] }>(
      `https://ac.stock.naver.com/ac?q=${encodeURIComponent(symbol)}&target=stock`,
      { headers: { "user-agent": NAVER_UA }, revalidate: 86400 },
    );
  } catch {
    return null;
  }
  const items = res.items ?? [];
  const hit =
    items.find((i) => i.code?.toUpperCase() === symbol.toUpperCase()) ?? null;
  if (!hit?.reutersCode) return null;
  return { code: hit.reutersCode, koreanName: hit.name?.trim() || null };
}

/**
 * 약칭(회사명 첫 낱말)으로 시작하는 다른 종목 이름 — 같은 자동완성 API 를 약칭으로 부른다("어플라이드" → 어플라이드 디지털·옵토일렉트로닉스·
 * 인더스트리얼 테크놀로지 …, "Applied" → Applied Digital Corporation …). 판정에서 "어플라이드 디지털" 을 AMAT 기사로 잡지 않게 쓴다.
 * 목록을 손으로 두지 않아 유니버스에 어떤 종목이 들어와도 같은 규칙이 돈다. 실패하면 빈 목록(약칭 판정은 대소문자·경계만으로).
 */
async function resolveNaverNameRivals(prefix: string, symbol: string): Promise<string[]> {
  let res: { items?: NaverAcItem[] };
  try {
    res = await fetchJson<{ items?: NaverAcItem[] }>(
      `https://ac.stock.naver.com/ac?q=${encodeURIComponent(prefix)}&target=stock`,
      { headers: { "user-agent": NAVER_UA }, revalidate: 86400 },
    );
  } catch {
    return [];
  }
  const p = prefix.toLowerCase();
  return (res.items ?? [])
    .filter((i) => i.code?.toUpperCase() !== symbol.toUpperCase())
    .map((i) => i.name?.trim() ?? "")
    .filter((n) => n.toLowerCase().startsWith(p));
}

/**
 * 미국 종목 한글 약칭 — 네이버 한글명이 두 낱말 이상이고 첫 낱말이 한글 2자 이상이며, 영문명 첫 낱말이 흔한 말(Global·American·Taiwan 등)이
 * 아니고 4자 이상일 때만 그 첫 낱말("어플라이드 머티어리얼즈" → "어플라이드", "마이크론 테크놀로지" → "마이크론"). "램 리서치"(1자)·
 * "아메리칸 익스프레스"(흔한 말)는 약칭을 두지 않는다.
 */
function koShortAlias(koName: string, enName: string): { alias: string; next: string } | null {
  const words = koName.trim().split(/\s+/);
  if (words.length < 2 || !/^[가-힣]{2,}$/.test(words[0])) return null;
  const en = normalizeForMatch(enName.split(/\s+/)[0] ?? "");
  if (en.length < 4 || GENERIC_NAME_WORDS.has(en)) return null;
  return { alias: words[0], next: words[1] };
}

/**
 * 일본 종목 한글명 — 국내 기사 판정용 전체 이름과 약칭(2026-10-10 오너 지적 "일본 종목 국내뉴스가 없다").
 * 네이버 한글명("토요타자동차")·화면 표시명(ko-dict "도요타자동차")이 붙여 쓴 한 낱말이라 미국 규칙(koShortAlias, 두 낱말 이상)으로는 약칭이
 * 안 생기고, 기사 제목은 "도요타·렉서스 리콜"처럼 약칭을 쓴다(7203 국내 원본 153건 전부 "제목에 회사명 없음").
 *  - 괄호 속 다른 표기도 이름("혼다(혼다기연공업)", "일본전신전화(NTT)"). 네이버의 미국 ADR 표기(" ADR")는 뗀다.
 *  - 첫 글자 초성 ㄷ↔ㅌ·ㄱ↔ㅋ 이형 표기(도요타/토요타, 가와사키/카와사키) — 일본어 ト·カ 를 매체마다 다르게 적는다. 3자 이상만.
 *  - 약칭 = 뒤의 회사 형태·업종 접미어를 뗀 이름("도요타자동차" → "도요타", "소니그룹" → "소니", "미쓰비시UFJ파이낸셜그룹" → "미쓰비시UFJ").
 *    한글 2자 이상일 때만. 다른 종목과 겹치는지는 호출부가 네이버 자동완성으로 따로 본다(jpAliasUsable).
 */
const JP_KO_SUFFIXES = ["파이낸셜그룹", "홀딩스", "그룹", "제작소", "자동차", "기연공업", "약품공업", "화학공업", "중공업", "공업"];
const KO_INITIAL_SWAP: Record<number, number> = { 3: 16, 16: 3, 0: 15, 15: 0 }; // ㄷ↔ㅌ, ㄱ↔ㅋ (초성 번호)
function koInitialVariant(word: string): string | null {
  const code = word.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171 || word.length < 3) return null;
  const swap = KO_INITIAL_SWAP[Math.floor(code / 588)];
  if (swap == null) return null;
  return String.fromCharCode(0xac00 + swap * 588 + (code % 588)) + word.slice(1);
}
function jpKoNames(raw: (string | null | undefined)[]): { names: string[]; aliases: { alias: string; next: string }[] } {
  const base = new Set<string>();
  for (const r of raw) {
    if (!r) continue;
    const s = r.replace(/\s*ADR$/i, "").trim();
    for (const part of [s.replace(/\(.*?\)/g, ""), ...[...s.matchAll(/\(([^()]+)\)/g)].map((m) => m[1])]) {
      const w = part.replace(/\s+/g, "");
      if (w) base.add(w);
    }
  }
  const names = new Set<string>();
  const aliases = new Map<string, string>();
  for (const w of base) {
    for (const v of [w, koInitialVariant(w)]) if (v) names.add(v);
    const suf = JP_KO_SUFFIXES.find((x) => w.endsWith(x) && w.length > x.length);
    const alias = suf ? w.slice(0, -suf.length) : null;
    if (!alias || !/^[가-힣]{2,}/.test(alias)) continue;
    for (const v of [alias, koInitialVariant(alias)]) if (v && !names.has(v)) aliases.set(v, suf!);
  }
  return { names: [...names], aliases: [...aliases].map(([alias, next]) => ({ alias, next })) };
}

/**
 * 일본 종목 약칭을 쓸 수 있는지 — 같은 말로 시작하는 다른 종목(네이버 자동완성)으로 판단한다.
 *  - 약칭과 이름이 똑같은 다른 종목이 있으면 그 말은 다른 회사다("소프트뱅크그룹" → "소프트뱅크" = 9434 소프트뱅크).
 *  - 같은 말로 시작하는 다른 **일본** 상장사가 둘 이상이면 그룹 이름이다("미쓰비시" → 미쓰비시상사·미쓰비시전기·미쓰비시UFJ … — 제목의 "미쓰비시"가
 *    어느 회사인지 모른다). 하나뿐이면 약칭으로 쓰고 그 종목 자리는 shortAliasHit 이 거른다("도요타" → 도요타쯔우쇼).
 *  - ADR(같은 회사의 미국 상장)과 다른 나라 종목(미국 "소니다 시니어 리빙")은 세지 않는다 — 앞은 같은 회사, 뒤는 다른 낱말이라 경계 검사로 걸러진다.
 * 2026-10-10 네이버 자동완성 실측: 도요타 1·토요타 1·소니 1·히타치 1 → 사용, 미쓰비시 9 → 제외, 소프트뱅크 = 동명 종목 → 제외.
 */
function jpAliasUsable(alias: { alias: string; next: string }, items: NaverAcItem[], symbol: string): boolean {
  const others = new Set<string>();
  for (const it of items) {
    const name = it.name?.trim() ?? "";
    if (!name || it.code?.toUpperCase() === symbol.toUpperCase() || /\bADR$/i.test(name)) continue;
    const squashed = name.replace(/\s+/g, "");
    if (!squashed.startsWith(alias.alias)) continue;
    const rest = squashed.slice(alias.alias.length);
    if (!rest) return false;
    if (it.nationCode !== "JPN" || rest.startsWith(alias.next)) continue;
    others.add(it.code ?? name);
  }
  return others.size < 2;
}

/** 네이버 자동완성 원본 항목 — 실패하면 빈 목록 */
async function naverAcItems(q: string): Promise<NaverAcItem[]> {
  try {
    const res = await fetchJson<{ items?: NaverAcItem[] }>(`https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock`, {
      headers: { "user-agent": NAVER_UA },
      revalidate: 86400,
    });
    return res.items ?? [];
  } catch {
    return [];
  }
}

/** 티커로도 국내 검색할지 — 3자 이상 영문만(1~2자 "V"·"BE"·"MU" 는 검색 결과가 회사와 무관한 기사로 채워진다), 한글명·영문명에 이미 들어 있으면 생략 */
function tickerQueryOk(symbol: string, names: string[]): boolean {
  if (!/^[A-Z]{3,}$/.test(symbol)) return false;
  return !names.some((n) => new RegExp(`(^|[^A-Za-z])${symbol}([^A-Za-z]|$)`, "i").test(n));
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
  opts?: {
    cutoffMs?: number;
    display?: number;
    requireWhitelist?: boolean;
    /**
     * 네이버 뉴스에 제휴돼 `naverUrl` 이 있는 기사만 남긴다. 거시경제 국내뉴스
     * 에서 쓴다(오너 지시 2026-09 — "광고 때문에 네이버 뉴스로 열리게 해
     * 놨는데 그냥 원사이트로 간다").
     *
     * 화면은 `naverUrl ?? url` 로 여는데, 매체 화이트리스트를 끄면서 네이버에
     * 제휴되지 않은 군소 매체가 대거 들어와 대부분 원문으로 열렸다(실측 —
     * 30건 중 네이버 링크가 9건). 제휴 매체만 남기면 전부 네이버로 열리고,
     * 광고 많은 군소 매체도 함께 걸러진다.
     */
    requireNaverLink?: boolean;
    /**
     * 한 페이지(display 건)가 꽉 찼고 마지막 기사도 기간 안이면 다음 페이지를 받는다(최대 이 수만큼, 기본 1 = 다음 페이지 없음).
     * 기사가 많은 종목은 100건이 1~2일치뿐이다(실측 2026-10-05: "마이크론" 100건이 전부 1주일 안).
     */
    maxPages?: number;
  },
): Promise<Omit<NewsItem, "titleKo">[]> {
  const requireWhitelist = opts?.requireWhitelist ?? true;
  const keyId = process.env.NAVER_APIHUB_KEY_ID;
  const keySecret = process.env.NAVER_APIHUB_KEY_SECRET;
  if (!keyId || !keySecret) return [];
  const display = opts?.display ?? 20;
  const cutoff = Date.now() - (opts?.cutoffMs ?? THREE_MONTHS_MS);
  const all: NaverNewsItem[] = [];
  for (let page = 0; page < (opts?.maxPages ?? 1); page++) {
    let res: NaverNewsResponse;
    try {
      res = await fetchJson<NaverNewsResponse>(
        `https://naverapihub.apigw.ntruss.com/search/v1/news?query=${encodeURIComponent(query)}&display=${display}&start=${1 + page * display}&sort=date`,
        {
          headers: { "X-NCP-APIGW-API-KEY-ID": keyId, "X-NCP-APIGW-API-KEY": keySecret },
          revalidate: 600,
        },
      );
    } catch {
      if (page === 0) return [];
      break;
    }
    const got = res.items ?? [];
    all.push(...got);
    const last = got.length ? Date.parse(got[got.length - 1].pubDate) : NaN;
    if (got.length < display || !(last >= cutoff)) break;
  }
  const items: Omit<NewsItem, "titleKo">[] = [];
  for (const n of all) {
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
    if (opts?.requireNaverLink && !naverUrl) continue;
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
  opts?: {
    /** 최신순 상위 N건만 반환·번역(유니버스통합뉴스처럼 종목당 1건만 쓸 때
     * 나머지를 번역하느라 시간을 낭비하지 않게 — 오너 지적 2026-09-22,
     * "미국/한국 유니버스 통합뉴스뜨는게 매우느리다": 실제 쓰는 건 종목당
     * 최신 1건뿐인데 화이트리스트 통과분 전부(많으면 10여 건)를 매번
     * 번역하고 있었다. */
    limit?: number;
  },
): Promise<NewsItem[]> {
  const query = companyName || symbol;
  // KR은 네이버 증권의 종목코드별 태깅 API(fetchKrStockTaggedNews)를 써서
  // 애초에 검색·필터 자체가 불필요 — 나머지 시장은 기존 야후 검색 유지.
  // limit=1이면 2페이지째를 아예 안 받는다(최신 1건은 1페이지에 이미 있음 —
  // 90일치 40건을 받아놓고 1건만 쓰던 낭비 제거).
  const items =
    market === "kr"
      ? await fetchKrStockTaggedNews(symbol, opts?.limit ? { maxPages: 1 } : undefined)
      : await fetchUsJpNews(market, symbol, yahooQuery(market, symbol, query));
  const picked = opts?.limit
    ? [...items].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, opts.limit)
    : items;
  return withTranslatedTitles(SOURCE_LANG[market], picked);
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
// (2026-10-04) 위 설명은 옛 판단이다 — 지금 판정은 news-rules.ts(제목 기준 + 기사가 적은 종목은 요약 보충).

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

/**
 * SEC EDGAR 등록명("CORNING INC /NY", "APPLE INC", "ALPHABET INC.")을 검색어로
 * 쓸 수 있게 정리 — 주(州) 꼬리표(" /NY", "/DE/")와 법인 접미사를 뗀다. 실측
 * (2026-09, 오너 지적 "코닝 뉴스가 너무 평온하다"): "CORNING INC /NY"로 Yahoo
 * 검색하면 지붕 시공·코인쉐어스 등 무관한 기사만 10건, "Corning"이면 당일
 * 급락 기사가 바로 나왔다. 미국 종목의 Yahoo 검색은 아예 티커로 한다(아래).
 */
function cleanEdgarName(name: string): string {
  const noState = name.replace(/\s*\/[A-Z]{2}\/?\s*$/i, "").trim();
  return stripLegalSuffix(noState) || name;
}

/** 미국·일본 종목의 Yahoo 검색어 — 티커. Yahoo 는 티커 검색 시 그 종목에 태깅된
 * 기사를 돌려줘 회사명 검색보다 정확하고 최신이다(실측: "GLW" → 당일 기사 10건). */
function yahooQuery(market: MarketId, symbol: string, companyName: string): string {
  return market === "kr" ? companyName : symbol;
}

/** 구두점·공백·대소문자를 무시한 비교용 정규화("Coca-Cola"→"cocacola", "McDonald's"→"mcdonalds") */
function normalizeForMatch(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9가-힣]+/g, "");
}

/** 첫 단어 매칭에서 제외할 흔한 회사명 앞말(다른 회사·일반 문장에 너무 자주 등장) */
const GENERIC_NAME_WORDS = new Set([
  "international", "american", "advanced", "united", "general", "global", "national", "first",
  "micro", "digital", "energy", "capital", "financial", "technology", "technologies", "holdings",
  // 지명 — "TAIWAN SEMICONDUCTOR…"의 "Taiwan"으로 검색·매칭하면 정치 뉴스가 쏟아짐
  "taiwan", "china", "japan", "korea", "america", "europe", "european", "canada", "texas",
]);

/** 회사명 첫 단어가 그 회사를 특정할 만큼 고유하면("Amazon", "Marriott", "Applied")
 * 반환, 아니면 null(5자 미만 "Coca", 일반어 "International", 지명 "Taiwan"). Google
 * 검색 보조 질의와 폴백 관련성 판정이 같은 규칙을 쓴다. */
function distinctiveFirstWord(cleanName: string): string | null {
  const first = cleanName.split(/\s+/)[0] ?? "";
  const norm = normalizeForMatch(first);
  if (norm.length < 5 || GENERIC_NAME_WORDS.has(norm)) return null;
  return first;
}


/**
 * 회사가 직접 운영하는 페이지인지 — 해외뉴스에서 제외한다(오너 지시 2026-09:
 * "해외뉴스에 자체홍보페이지는 뺀다"). 실측: 한화에어로스페이스 해외뉴스에
 * `hanwha.com`("Hanwha Group") 기사가 12건 들어와 있었다. 언론사가 아니라
 * 회사 보도자료 페이지다.
 *
 * 목록을 만들지 않고 회사명과 도메인을 맞춰 본다 — 유니버스에 어떤 종목이
 * 들어와도 따로 등록할 필요가 없다. 도메인의 대표 라벨(`ir.hanwha.com` →
 * `hanwha`)이 회사명 전체 또는 고유한 낱말 하나와 같으면 자사 도메인으로 본다.
 * 흔한 낱말(Global·Energy·Korea 등 GENERIC_NAME_WORDS)과 4자 미만은 다른
 * 회사·매체와 겹칠 수 있어 제외한다.
 */
function domainBase(domain: string): string {
  const parts = domain.toLowerCase().replace(/^www\./, "").split(".");
  if (parts.length < 2) return parts[0] ?? "";
  // co.kr / or.kr 처럼 2단계 접미사면 라벨을 하나 더 뗀다
  const cut = parts.length >= 3 && ["co", "or", "ne", "go", "ac"].includes(parts[parts.length - 2]) ? 2 : 1;
  return parts[parts.length - 1 - cut] ?? "";
}

export function isSelfPromoSource(
  domain: string | null | undefined,
  companyName: string | null | undefined,
): boolean {
  if (!domain || !companyName) return false;
  const base = domainBase(domain);
  if (base.length < 4) return false;

  const words = stripLegalSuffix(companyName)
    .split(/[\s,.()\-]+/)
    .map(normalizeForMatch)
    .filter(Boolean);
  if (words.length === 0) return false;

  const full = words.join("");
  if (full && (base === full || base.startsWith(full))) return true;
  return words.some((w) => w.length >= 5 && !GENERIC_NAME_WORDS.has(w) && base === w);
}

function overseasQuery(market: MarketId, symbol: string, companyName: string): string {
  if (market !== "kr") return cleanEdgarName(companyName);
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
const NAVER_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";

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

/** 별칭 맵을 소문자 키로 미리 펼쳐둔다 — SEC EDGAR 회사명은 전부 대문자로
 * 오기 때문에("NETFLIX INC") 대소문자를 구분하면 전부 미스가 난다(실측). */
const US_COMPANY_KO_ALIAS_LC: Record<string, string> = Object.fromEntries(
  Object.entries(US_COMPANY_KO_ALIAS).map(([k, v]) => [k.toLowerCase(), v]),
);

function domesticQuery(market: MarketId, companyName: string): string {
  if (market === "kr") return companyName;
  const raw = companyName.trim().toLowerCase();
  const stripped = stripLegalSuffix(companyName).toLowerCase();
  return US_COMPANY_KO_ALIAS_LC[raw] ?? US_COMPANY_KO_ALIAS_LC[stripped] ?? companyName;
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
 * 종목뉴스 관련성·중복 판정 — **규칙만으로, 비용 0**(2026-10-03 오너 지시: "종목뉴스에 llm 에이전트 사용 금지", 필요 시 Gemini 만).
 * 예전엔 갱신마다 기사 72건 전체를 Claude Haiku 로 다시 판정해 하루 약 2.5달러가 나갔다.
 *
 * 판정(2026-10-04, 기준 세트로 잰 규칙 — news-rules.ts 머리 주석에 성적표):
 *  - 국내·해외 모두 **제목**에 회사명(통칭·대표 제품·티커 포함, 낱말 경계 확인)이 있어야 남긴다. 네이버 태깅만으로는 믿지 않는다
 *    (기준 세트에서 태깅 기사의 69%가 무관 — 부동산·유통·다른 회사).
 *  - 시황·마감·나열 기사, 경쟁 제품 나란히, "…다음 타자·Not …", 할인 목록, 같은 낱말 다른 대상(사과·지명·Owens Corning)은 뺀다.
 *  - 국내 기사가 MIN_DOMESTIC 건 미만인 종목(중소형주 — 제목에 회사명이 드물다)은 요약에 회사명이 있는 네이버 태깅 기사로 보충한다.
 *  - 중복: 정규화 제목이 같거나(통신사 재게재) 글자 유사도가 높고 48시간 안이면 같은 사건으로 보고 주요 매체 1건만 남긴다.
 */
export type NewsRelevanceMode = "rules" | "no_company_name";

/** 국내 기사가 이보다 적으면 요약 기준 태깅 기사로 보충 */
const MIN_DOMESTIC = 5;

/** 한국 종목 약칭 — DART 상장사 목록(corpcodes.json)의 이름. 목록에 없으면 null */
function krShortName(symbol: string): string | null {
  try {
    return resolveCorpCode("", symbol).corpName || null;
  } catch {
    return null;
  }
}

/**
 * 미국 종목 국내 기사 중 제목에 약칭("어플라이드"·"블룸"·"델타")이나 티커("AMAT"·"WDC")만 있는 것 — 같은 말을 다른 대상이 쓰는 일이 잦다
 * (2026-10-05 표본: "피크민 블룸" 게임, "UFC 델타 센터", "세계디자인수도(WDC)", "웨스턴 스타일" 패션, 비상장사 "어플라이드 인튜이션").
 *  - 제목·요약에 회사 전체 이름(한글명·약칭+다음 낱말·영문명)이나 티커가 같이 있으면 확인된 것으로 남긴다.
 *  - 확인 안 된 것은, 이번 묶음에서 그 약칭(티커)으로 잡힌 기사의 절반 이상이 확인되고 확인 건수가 3건 이상일 때만 남긴다 — 그 말이 국내 기사에서
 *    이 회사를 가리키는 게 보통인 경우("마이크론"). 그래도 요약에 "어플라이드 인튜이션(Applied Intuition)"처럼 영문 첫 낱말로 시작하는 다른
 *    이름이 괄호로 붙어 있으면 뺀다.
 */
function confirmWeakDomesticHits(
  dom: { it: RawNewsItem; v: Verdict }[],
  n: { koNames: string[]; koAliases: ShortAlias[]; enName: string; enFirst: string | null; ticker: string | null },
): void {
  const squashKo = (s: string) => s.replace(/\s+/g, "");
  const kindOf = (v: Verdict): "alias" | "ticker" | null => {
    if (!v.keep) return null;
    const hit = v.reason.replace(/^제목에 /, "");
    if (n.koAliases.some((a) => hit === a.alias) || (n.enFirst && hit === n.enFirst)) return "alias";
    if (n.ticker && hit === n.ticker) return "ticker";
    return null;
  };
  const fullName = (text: string) =>
    n.koNames.some((k) => squashKo(text).includes(squashKo(k))) ||
    n.koAliases.some((a) => !!a.next && new RegExp(`${a.alias}\\s?${a.next.slice(0, 2)}`).test(text)) ||
    enTitleHit(text, n.enName);
  const confirmed = (kind: "alias" | "ticker", text: string) =>
    fullName(text) ||
    (kind === "alias"
      ? !!n.ticker && enTitleHit(text, n.ticker, true)
      : n.koAliases.some((a) => shortAliasHit(text, a)) ||(!!n.enFirst && shortAliasHit(text, { alias: n.enFirst, rivals: [] })));
  // "어플라이드 인튜이션(Applied Intuition)" — 영문 첫 낱말로 시작하지만 회사명·티커가 아닌 괄호 속 이름
  const otherEntity = (text: string) =>
    !!n.enFirst &&
    [...text.matchAll(/\(([A-Za-z][^()]*)\)/g)].some(
      (m) => enTitleHit(m[1], n.enFirst!) && !enTitleHit(m[1], n.enName) && !(n.ticker && enTitleHit(m[1], n.ticker, true)),
    );
  const weak = dom
    .map((d) => ({ d, kind: kindOf(d.v) }))
    .filter((w): w is { d: (typeof dom)[number]; kind: "alias" | "ticker" } => !!w.kind)
    .map((w) => ({ ...w, ok: confirmed(w.kind, `${w.d.it.title} ${w.d.it.excerpt ?? ""}`) }));
  for (const kind of ["alias", "ticker"] as const) {
    const group = weak.filter((w) => w.kind === kind);
    const ok = group.filter((w) => w.ok).length;
    const usual = ok >= 3 && ok / group.length >= 0.5;
    for (const w of group) {
      const text = `${w.d.it.title} ${w.d.it.excerpt ?? ""}`;
      if (w.ok) w.d.v = { keep: true, reason: `${w.d.v.reason}(요약에서 회사명 확인)` };
      else if (usual && !otherEntity(text)) w.d.v = { keep: true, reason: `${w.d.v.reason}(이 약칭 기사 ${ok}/${group.length} 확인)` };
      else w.d.v = { keep: false, reason: `${kind === "alias" ? "약칭" : "티커"}만 있고 요약에 회사명 없음` };
    }
  }
}

type JudgeLog = { side: "domestic" | "overseas"; item: RawNewsItem; tagged: boolean; keep: boolean; reason: string };

/**
 * 판정 본체(네트워크 없음) — fetchStockNewsBySide 와 기준 세트 채점 스크립트가 같은 함수를 쓴다.
 * enShortName: 영문 회사명(EDGAR 정리명 / 한국 종목은 DART 영문명), koBase: 한글 회사명(한국 종목은 법인명, 미국 종목은 네이버 한글명)
 */
export function judgeStockNews(a: {
  isKr: boolean;
  symbol: string;
  enShortName: string;
  koBase: string;
  /** 한국 종목: DART 상장사 목록 약칭(corpcodes) */
  koShort?: string | null;
  domesticRaw: RawNewsItem[];
  overseasRaw: RawNewsItem[];
  taggedUrls: Set<string>;
  /** 미국 종목 — 영문 첫 낱말로 시작하는 다른 종목 이름(네이버 자동완성) */
  enRivals?: string[];
  /** 미국 종목 — 한글 약칭과 그 약칭으로 시작하는 다른 종목 이름 */
  koAlias?: ShortAlias | null;
  /** 일본 종목 — 한글 이름(이형 표기 포함)과 약칭 여러 개(jpKoNames). 주면 koAlias 대신 쓴다 */
  jpKo?: { names: string[]; aliases: ShortAlias[] } | null;
  /** 해외 기사 중 영문 첫 낱말 구글 검색에서만 나온 것(티커·전체 이름 검색에는 없던 것) */
  firstWordOnlyUrls?: Set<string>;
}): { domestic: RawNewsItem[]; overseas: RawNewsItem[]; log: JudgeLog[] } {
  // 영문 이름: 정리된 회사명(대소문자 무관) + 고유한 첫 낱말(대문자로 시작할 때만·다른 종목 이름이 이어지면 제외), 티커는 대소문자 구분으로 따로
  const first = distinctiveFirstWord(a.enShortName);
  const enNames = [a.enShortName];
  const enShort: ShortAlias | null =
    first && first !== a.enShortName
      ? { alias: first, next: a.enShortName.split(/\s+/)[1] ?? null, rivals: a.enRivals ?? [] }
      : null;
  const enTicker = a.isKr ? null : a.symbol;
  // 한글 이름: 한국 종목은 법인명(㈜ 뗌)·통칭, 미국 종목은 한글명·대표 제품
  // 한국 종목은 DART 기업개황 정식명("에스케이하이닉스(주)")과 상장사 목록 약칭("SK하이닉스")이 다르다 — 기사 제목은 약칭을 쓴다(2026-10-04 실측:
  // 정식명만 쓰면 SK하이닉스 국내 기사 0건). 둘 다 인정하고, 각각의 통칭 별칭도 합친다.
  // 영문 약자를 한글로 적은 정식명("엘에스일렉트릭")은 기사 표기("LS일렉트릭")로도 바꿔 인정한다.
  const formal = a.koBase.replace(/\(주\)|㈜|주식회사/g, "").trim();
  const koKeys = a.isKr
    ? [...new Set([a.koShort, formal, koAcronymName(formal), a.koShort ? koAcronymName(a.koShort) : null].filter((x): x is string => !!x))]
    : [a.koBase];
  // 미국 종목은 붙여 쓴 한글명("어플라이드머티어리얼즈")도 인정
  const koNames = a.isKr
    ? [...new Set(koKeys.flatMap((k) => KR_COMPANY_ALIASES[k] ?? [k]))]
    : [...new Set([a.koBase, a.koBase.replace(/\s+/g, ""), ...(KO_PRODUCT_ALIASES[a.koBase] ?? []), ...(a.jpKo?.names ?? [])])];
  const koContext = a.isKr ? (koKeys.map((k) => KR_CONTEXT_ALIASES[k]).find(Boolean) ?? null) : null;
  const koAliases: ShortAlias[] = a.isKr ? [] : a.jpKo ? a.jpKo.aliases : a.koAlias ? [a.koAlias] : [];
  const judgeDom = (it: RawNewsItem) => {
    let v = judgeDomesticTitle(it.title, koNames, koContext, koAliases[0] ?? null);
    // 일본 종목 약칭은 이형 표기까지 여럿("도요타"·"토요타") — 앞 약칭에 안 걸렸을 때만 다음 약칭으로
    for (const al of koAliases.slice(1)) {
      if (v.keep || v.reason !== "제목에 회사명 없음") break;
      v = judgeDomesticTitle(it.title, koNames, koContext, al);
    }
    // 일본 종목 약칭이 사람 이름으로 쓰인 스포츠 기사("소니" = 손흥민 별명, "타케다" = SSG 투수) — 2026-10-10 6758·4502 표본
    if (v.keep && a.jpKo && koAliases.some((al) => v.reason === `제목에 ${al.alias}`) && JP_ALIAS_SPORTS_RE.test(it.title))
      return { keep: false, reason: "약칭이 사람 이름(스포츠 기사)" };
    // 미국 종목 국내 기사는 영문 회사명·약칭·티커로 쓴 제목도 인정
    if (!v.keep && v.reason === "제목에 회사명 없음" && !a.isKr) {
      const en = judgeOverseasTitle(it.title, enNames, enTicker, enShort);
      if (en.keep) return en;
    }
    return v;
  };
  const dom = a.domesticRaw.map((it) => ({ it, v: judgeDom(it) }));
  // 일본 종목 한글 약칭("도요타"·"소니")은 요약 확인을 걸지 않는다 — 미국 약칭("어플라이드"·"블룸")과 달리 일반 낱말이 아니고, 다른 상장사와
  // 겹치는 약칭은 jpAliasUsable 이 이미 뺐다. 확인을 걸면 요약에 정식명("도요타자동차")이 드물어 진짜 기사 대부분이 빠졌다(7203: 22건 중 4건만 남음).
  if (!a.isKr)
    confirmWeakDomesticHits(dom, {
      koNames,
      koAliases: a.jpKo ? [] : koAliases,
      enName: a.enShortName,
      enFirst: enShort?.alias ?? null,
      ticker: enTicker,
    });
  // 기사가 적은 종목(제목에 회사명이 드문 중소형주) — 요약에 회사명이 있는 네이버 태깅 기사로 MIN_DOMESTIC 건까지 보충(최신순)
  let kept = dom.filter((d) => d.v.keep).length;
  for (const d of dom) {
    // 한국 종목만 — 미국 종목의 국내 기사는 한글명 검색 결과라 요약에 이름만 스치는 무관 기사가 많다(처음 보는 표본: MSFT 보충 3건 모두 오탐)
    if (!a.isKr || kept >= MIN_DOMESTIC) break;
    if (d.v.keep || d.v.reason !== "제목에 회사명 없음" || !a.taggedUrls.has(d.it.url) || !d.it.excerpt) continue;
    const ex = d.it.excerpt;
    if (koNames.some((n) => koTitleHit(ex, n))) {
      d.v = { keep: true, reason: "요약에 회사명(기사 적은 종목 보충)" };
      kept++;
    }
  }
  // 영문 첫 낱말이 흔한 낱말이면("applied"·"bloom"·"western"·"intuitive" — 이번 해외 기사 제목에 소문자로 쓰인 적이 있으면 흔한 낱말로 본다)
  // 그 낱말로만 검색한 구글 결과(firstWordOnlyUrls)는 회사 전체 이름이나 티커가 있어야 남긴다. 2026-10-05 표본: "Applied Math Professor",
  // "Western Michigan 20-17 Buffalo", "Orlando Bloom", "Intuitive eating" 이 회사 기사로 들어왔다. 티커 검색(야후)·전체 이름 검색 결과는 그대로.
  const firstWordCommon =
    !!enShort && a.overseasRaw.some((it) => new RegExp(`(^|[^A-Za-z])${enShort.alias.toLowerCase()}(?![A-Za-z])`).test(it.title));
  const ovs = a.overseasRaw.map((it) => {
    const v = judgeOverseasTitle(it.title, enNames, enTicker, enShort);
    if (v.keep && firstWordCommon && enShort && v.reason === `제목에 ${enShort.alias}` && a.firstWordOnlyUrls?.has(it.url))
      return { it, v: { keep: false, reason: "흔한 낱말(첫 낱말 검색 결과) — 회사 전체 이름·티커 없음" } };
    return { it, v };
  });
  return {
    domestic: dom.filter((d) => d.v.keep).map((d) => d.it),
    overseas: ovs.filter((d) => d.v.keep).map((d) => d.it),
    log: [
      ...dom.map((d) => ({ side: "domestic" as const, item: d.it, tagged: a.taggedUrls.has(d.it.url), ...d.v })),
      ...ovs.map((d) => ({ side: "overseas" as const, item: d.it, tagged: false, ...d.v })),
    ],
  };
}

/** 제목 글자 2-gram 집합 — 문구만 조금 다른 같은 사건 기사("팀 쿡이 갤럭시로 바꿨다"/"팀 쿡도 갤럭시로 바꿨다")를 잡는다 */
function titleBigrams(title: string): Set<string> {
  const t = normalizeTitleForDedup(title);
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
const SIMILAR_TITLE = 0.6;
const SIMILAR_WINDOW_MS = 48 * 3600_000;

/** 비슷한 제목 묶기 — 묶인 것 중 주요 매체(국내 DOMESTIC_PUBLISHERS·해외 ALLOWED_PUBLISHERS, Yahoo 게재본은 후순위) 1건만 남긴다 */
function dedupeSimilarTitles(items: RawNewsItem[]): RawNewsItem[] {
  const rank = (it: RawNewsItem) =>
    (DOMESTIC_PUBLISHERS.has(it.publisher) || ALLOWED_PUBLISHERS.has(it.publisher.toLowerCase()) ? 2 : 0) +
    (it.publisher.toLowerCase() === "yahoo finance" ? -1 : 0);
  const grams = items.map((it) => titleBigrams(it.title));
  const taken = new Array(items.length).fill(false);
  const out: RawNewsItem[] = [];
  for (let i = 0; i < items.length; i++) {
    if (taken[i]) continue;
    const group = [i];
    for (let j = i + 1; j < items.length; j++) {
      if (taken[j]) continue;
      const dt = Math.abs(Date.parse(items[i].publishedAt) - Date.parse(items[j].publishedAt));
      if (dt <= SIMILAR_WINDOW_MS && jaccard(grams[i], grams[j]) >= SIMILAR_TITLE) group.push(j);
    }
    for (const g of group) taken[g] = true;
    out.push(group.map((g) => items[g]).sort((a, b) => rank(b) - rank(a) || Date.parse(b.publishedAt) - Date.parse(a.publishedAt))[0]);
  }
  return out.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

/** 해외 기사 중복 정리 — 같은 기사가 원매체(Motley Fool 등)와 Yahoo Finance 게재본,
 * Yahoo 티커 검색·Google 검색 양쪽에서 제목만 같고 URL 이 달라 2~3번 나오던 문제
 * (실측 2026-09-15: KO "Coca-Cola Loses to 30-year U.S. Treasury Bonds" 3회). 정규화
 * 제목이 같으면 한 건만 남기되 원매체를 우선(Yahoo Finance 게재본은 후순위). */
function dedupeOverseasSyndication(items: RawNewsItem[]): RawNewsItem[] {
  const byTitle = new Map<string, RawNewsItem>();
  const order: string[] = [];
  for (const it of items) {
    const key = normalizeTitleForDedup(it.title);
    const prev = byTitle.get(key);
    if (!prev) {
      byTitle.set(key, it);
      order.push(key);
    } else if (prev.publisher.toLowerCase() === "yahoo finance" && it.publisher.toLowerCase() !== "yahoo finance") {
      byTitle.set(key, it);
    }
  }
  return order.map((k) => byTitle.get(k)!);
}

export async function fetchStockNewsBySide(
  market: MarketId,
  symbol: string,
  companyName?: string | null,
  /** 검증 도구용 — 판정 전 원본 목록과 기사별 판정 사유를 함께 돌려준다(화면·저장에는 쓰지 않음) */
  opts?: {
    includeRaw?: boolean;
    /** 일본 종목 — 화면 표시 한글명(ko-dict·무료 번역). companyName 은 해외 검색·판정용 영문명이라 따로 받는다 */
    koName?: string | null;
  },
): Promise<{
  domestic: NewsItem[];
  overseas: NewsItem[];
  debug: {
    rawDomestic: number;
    rawOverseas: number;
    relevance: NewsRelevanceMode;
    raw?: { side: "domestic" | "overseas"; item: RawNewsItem; tagged: boolean; keep: boolean; reason: string }[];
  };
}> {
  const query = companyName || symbol;
  const oQuery = overseasQuery(market, symbol, query);
  const isKr = market === "kr";
  // 해외종목도 네이버가 종목-기사 태깅을 해준다(예: NFLX.O). 접미사 규칙이
  // 거래소마다 달라 자동완성 API 로 코드를 먼저 해석한다. 한국어 종목명도 같이
  // 얻어 검색 폴백의 질의어로 쓴다("NETFLIX INC" 로는 국내 기사가 안 잡힘).
  const naver = isKr ? null : await resolveNaverWorldStock(symbol);
  const isJp = market === "jp";
  const searchQuery = isKr ? query : (naver?.koreanName ?? (isJp ? opts?.koName : null) ?? domesticQuery(market, query));
  // 일본 종목 한글 이름·약칭(jpKoNames) — 약칭은 같은 말로 시작하는 다른 종목을 보고 쓸 것만 남긴다(jpAliasUsable)
  const jpBase = isJp ? jpKoNames([naver?.koreanName, opts?.koName]) : null;
  const jpKo = jpBase
    ? {
        names: jpBase.names,
        aliases: (
          await Promise.all(
            jpBase.aliases.map(async (al) => {
              const items = await naverAcItems(al.alias);
              const rivals = items
                .filter((i) => i.code?.toUpperCase() !== symbol.toUpperCase())
                .map((i) => i.name?.trim() ?? "")
                .filter((n) => n.startsWith(al.alias));
              return { ...al, rivals, usable: jpAliasUsable(al, items, symbol) };
            }),
          )
        )
          .filter((al) => al.usable)
          .map(({ alias, next, rivals }) => ({ alias, next, rivals })),
      }
    : null;
  // 미국·일본 종목 국내 검색은 질의 여러 개를 합친다(2026-10-05 오너 지적 — AMAT 국내뉴스 3건): 네이버 한글명 하나("어플라이드 머티어리얼즈")로
  // 30건만 받으면 표기가 다른 기사("머티리얼즈")·약칭 기사("어플라이드·베시 …")·티커 기사("AMAT 'EPIC 센터'…")를 못 받고, 상위 30건이 ETF·시황
  // 기사로 채워졌다(실측 1주일: 한글명 81건·다른 표기 48건·티커 17건). 한글명 + 한글 약칭 + 티커(3자 이상), 질의당 100건(검색 API 최대).
  const enClean = !isKr && companyName?.trim() ? cleanEdgarName(companyName.trim()) : null;
  const koAliasBase = enClean && !isJp ? koShortAlias(searchQuery, enClean) : null;
  const enFirst = enClean ? distinctiveFirstWord(enClean) : null;
  const domesticQueries = isKr
    ? []
    : [
        ...new Set(
          [
            searchQuery,
            koAliasBase?.alias,
            // 일본 종목은 약칭 검색(이형 표기 포함 최대 2개) — 기사 대부분이 약칭 제목("도요타 …")이다
            ...(jpKo?.aliases.slice(0, 2).map((al) => al.alias) ?? []),
            tickerQueryOk(symbol, [searchQuery, enClean ?? query]) ? symbol : null,
          ].filter((q): q is string => !!q),
        ),
      ];
  // 검색 API 쪽수 — 한글명·첫 약칭 2쪽(200건), 티커·일본 종목의 둘째 약칭 1쪽. 종목당 갱신 1회 최대 5건(무료 한도 하루 25,000건)
  const searchPages = (q: string) => (q === symbol || (isJp && q === jpKo?.aliases[1]?.alias) ? 1 : 2);

  const [domesticTagged, domesticSearched, yahooOverseas, googleOverseas, googleOverseasAlt, koRivals, enRivals] = await Promise.all([
    isKr
      ? fetchKrStockTaggedNews(symbol, { cutoffMs: ONE_WEEK_MS, pageSize: 20, maxPages: 2 })
      : naver
        ? fetchKrStockTaggedNews(symbol, {
            cutoffMs: ONE_WEEK_MS,
            pageSize: 20,
            maxPages: 2,
            code: naver.code,
          })
        : Promise.resolve([]),
    // 비 KR 은 태깅 뉴스만으로는 커버리지가 들쭉날쭉해(실측: NFLX·TSLA 는 많고
    // JPM·PLTR 은 0건) 한국어 종목명 검색을 함께 돌려 보완한다. 주가 기사뿐
    // 아니라 사업·콘텐츠 관련 기사까지 나오도록 도메인 화이트리스트는 걸지
    // 않고(오너 지시, 2026-09) 뒤의 LLM 관련성 판정에 맡긴다.
    Promise.all(
      domesticQueries.map((q) =>
        fetchKrNewsBySearch(symbol, q, {
          cutoffMs: ONE_WEEK_MS,
          display: 100,
          requireWhitelist: false,
          maxPages: searchPages(q),
        }),
      ),
    ).then((lists) => lists.flat()),
    fetchUsJpNews(market, symbol, yahooQuery(market, symbol, oQuery), {
      cutoffMs: ONE_WEEK_MS,
      newsCount: 30,
      requireWhitelist: false,
    }),
    fetchGoogleOverseasNews(market, symbol, oQuery, {
      cutoffMs: ONE_WEEK_MS,
      limit: 30,
      companyName: oQuery,
    }).catch(() => []),
    // EDGAR 정리명이 "AMAZON COM"처럼 검색어로 어색하면 Google 결과가 빈약하다(실측:
    // "AMAZON COM" 10건 vs "Amazon" 30건, AP·로이터·WSJ 는 후자에만). 첫 단어가
    // 고유하면 그 단어로 한 번 더 조회해 합친다(URL 중복은 아래서 제거).
    (() => {
      const first = isKr ? null : distinctiveFirstWord(oQuery);
      return first && first.toLowerCase() !== oQuery.toLowerCase()
        ? fetchGoogleOverseasNews(market, symbol, first, {
            cutoffMs: ONE_WEEK_MS,
            limit: 30,
            companyName: oQuery,
          }).catch(() => [])
        : Promise.resolve([] as RawNewsItem[]);
    })(),
    koAliasBase ? resolveNaverNameRivals(koAliasBase.alias, symbol) : Promise.resolve([] as string[]),
    enFirst && enClean && enFirst !== enClean ? resolveNaverNameRivals(enFirst, symbol) : Promise.resolve([] as string[]),
  ]);

  // 네이버가 직접 태깅한 기사는 관련성이 이미 보장된 소스 — LLM 미사용 폴백에서
  // 화이트리스트·키워드 매칭을 건너뛰게 표시해둔다(KR 경로와 같은 취급).
  const taggedUrls = new Set(domesticTagged.map((it) => it.url));
  const seenDomestic = new Set<string>();
  const domesticRaw = [...domesticTagged, ...domesticSearched]
    .filter((it) => {
      if (seenDomestic.has(it.url)) return false;
      seenDomestic.add(it.url);
      return true;
    })
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  // 야후·구글 두 소스에서 같은 기사(URL 동일)가 겹칠 수 있어 합치기 전 URL 기준
  // 1차 정리(문구만 다른 별도 기사의 중복은 LLM 판정 단계에서 그룹으로 잡음).
  const seenUrls = new Set<string>();
  const overseasRaw = [...yahooOverseas, ...googleOverseas, ...googleOverseasAlt].filter((it) => {
    if (seenUrls.has(it.url)) return false;
    seenUrls.add(it.url);
    return true;
  });
  const mainUrls = new Set([...yahooOverseas, ...googleOverseas].map((it) => it.url));
  const firstWordOnlyUrls = new Set(googleOverseasAlt.map((it) => it.url).filter((u) => !mainUrls.has(u)));

  const name = companyName?.trim();
  let domesticSafe: RawNewsItem[];
  let overseasSafe: RawNewsItem[];
  let relevance: NewsRelevanceMode;
  const rawLog: { side: "domestic" | "overseas"; item: RawNewsItem; tagged: boolean; keep: boolean; reason: string }[] = [];
  if (!name) {
    // 회사명을 모르면 태깅 기사·화이트리스트 매체만(예전 폴백과 같음)
    domesticSafe = domesticRaw.filter((it) => taggedUrls.has(it.url) || DOMESTIC_PUBLISHERS.has(it.publisher));
    overseasSafe = overseasRaw.filter((it) => ALLOWED_PUBLISHERS.has(it.publisher.toLowerCase()));
    relevance = "no_company_name";
  } else {
    const j = judgeStockNews({
      isKr,
      symbol,
      enShortName: isKr ? oQuery : cleanEdgarName(name),
      koBase: isKr ? name : (naver?.koreanName ?? (isJp ? opts?.koName : null) ?? domesticQuery(market, name)),
      koShort: isKr ? krShortName(symbol) : null,
      domesticRaw,
      overseasRaw,
      taggedUrls,
      enRivals,
      koAlias: koAliasBase ? { ...koAliasBase, rivals: koRivals } : null,
      jpKo,
      firstWordOnlyUrls,
    });
    domesticSafe = j.domestic;
    overseasSafe = j.overseas;
    if (opts?.includeRaw) rawLog.push(...j.log);
    relevance = "rules";
  }
  domesticSafe = dedupeSimilarTitles(dedupeByMajorPublisher(domesticSafe));
  overseasSafe = dedupeSimilarTitles(dedupeOverseasSyndication(overseasSafe));

  const [domestic, overseas] = await Promise.all([
    withTranslatedTitles("ko", domesticSafe),
    withTranslatedTitles("en", overseasSafe),
  ]);
  return {
    domestic,
    overseas,
    debug: { rawDomestic: domesticRaw.length, rawOverseas: overseasRaw.length, relevance, ...(opts?.includeRaw ? { raw: rawLog } : {}) },
  };
}

/**
 * 거시경제(시황) 뉴스 — 종목뉴스 탭과 레이아웃·발췌 방식(국내는 요약 포함)은
 * 공유하되, 특정 종목이 아니라 시장 전반의 화제를 검색어로 쓴다(오너 확인,
 * 2026-09 — 거시경제 페이지의 "시장 뉴스" 섹션이 옛 Google 뉴스 RSS
 * 헤드라인-only 방식이라 종목뉴스 탭과 구성이 어긋나 있던 문제 수정).
 * 해외 신뢰도 판정은 종목뉴스용 매체 화이트리스트 대신 주제 적합성 필터를
 * 쓴다(아래 filterMacroRelevant 참고, 오너 지적 반영) — 이유는 그 아래 주석.
 *
 * NAVER 뉴스검색·Yahoo Finance 검색 모두 boolean OR 질의를 지원하지 않아(둘 다
 * 단순 키워드 매칭) Google 뉴스 RSS의 "(A OR B OR C)" 질의 하나로 대체할 수
 * 없다 — 대신 핵심 주제별로 여러 번 조회해 합치는 방식으로 같은 효과를 낸다.
 */
const KR_MACRO_TOPICS = ["코스피 마감", "한국은행 기준금리", "원달러 환율", "수출 반도체 업황"];
const US_MACRO_TOPICS = ["Federal Reserve interest rate", "S&P 500 Nasdaq stock market", "inflation jobs report"];
/**
 * 해외 시황용 Google 뉴스 질의 — 원래는 boolean OR 하나로 묶은 질의였는데 실측
 * (2026-09-15, 오너 지적 "거시경제 해외뉴스 2건인데 맞냐") 100건 중 최근 1주일
 * 기사가 3건뿐이었다(기간 지정이 없으면 관련도순으로 오래된 기사가 섞임).
 * 단순 주제 질의 + `when:7d` 로 바꾸니 질의당 60~100건이 전부 1주일 내 기사
 * (CNBC·로이터·WSJ·블룸버그 등). 질의별로 나눠 받고 URL 로 합친다.
 */
const US_MACRO_GOOGLE_QUERIES = [
  "Federal Reserve interest rates when:7d",
  "Treasury yields bond market when:7d",
  "stock market Wall Street when:7d",
  "inflation CPI economy when:7d",
  "oil prices markets when:7d",
  "gold price when:7d",
  "Nasdaq S&P 500 tech stocks when:7d",
  "jobs report unemployment when:7d",
];

/**
 * Yahoo Finance 검색은 주제 질의("S&P 500 Nasdaq stock market")를 줘도 개별
 * 종목 단신(예: "AtriCure CTO Sells Shares")까지 섞어 보낸다(실측, 2026-09) —
 * 화이트리스트·번역만으론 이 노이즈를 못 거른다. 거시경제 화제어가 제목에
 * 하나도 없으면 시황 기사가 아니라고 보고 제외(LLM 없이 싼 값에 필터링).
 * 전부 걸러지면(원본은 있는데 0건) 필터 없이 원본을 그대로 보여준다 — 다른
 * 곳의 "관련 기사 없음보다 노이즈 섞임이 낫다" 안전장치와 동일 원칙.
 *
 * 이 주제 필터가 진짜 품질 게이트라, 해외 Google 뉴스 RSS 쪽엔 종목뉴스용
 * 화이트리스트(ALLOWED_PUBLISHERS/OVERSEAS_PUBLISHER_BY_DOMAIN)를 강제하지
 * 않는다(오너 지적, 2026-09) — 그 목록은 "종목 콕 집어 다루는" 매체 위주라
 * Chase Bank·Fortune·AFR·Il Sole 24 Ore·SMH.com.au 처럼 거시경제·시황을
 * 폭넓게 다루는 유용한 매체를 걸러내 버렸다. 도메인이 아니라 주제 적합성으로
 * 신뢰도를 판단한다.
 */
const MACRO_RELEVANT_KO =
  /코스피|코스닥|증시|환율|금리|물가|수출|경기|경제|한국은행|기준금리|달러|주가지수|성장률|무역|수지|인플레이션|연준|투자자/;
/**
 * 거시 주제 적합성. 복수형·변형을 놓쳐 정당한 기사가 버려지던 문제를 고쳤다
 * (실측 2026-09-17: BBC "US interest rates raised for first time in three
 * years" 가 `interest rate` 단수형만 보는 규칙에 안 걸려 탈락 — 단어 경계
 * 때문에 복수형이 매칭되지 않는다). 끝에 s? 를 붙이고 자주 쓰는 표현을 보강.
 */
const MACRO_RELEVANT_EN =
  /\b(fed|federal reserve|interest rates?|rate hikes?|rate cuts?|rate rise|inflation|deflation|cpi|ppi|gdp|jobs report|payrolls?|unemployment|stock markets?|equities|s&p|nasdaq|dow jones|treasury|treasuries|yields?|bond markets?|recession|economy|economic|tariffs?|trade war|fomc|wall street|markets?|central banks?|monetary policy|dollar|oil prices?|gold price)\b/i;
function filterMacroRelevant(raw: RawNewsItem[], re: RegExp): RawNewsItem[] {
  const filtered = raw.filter((it) => re.test(it.title));
  return filtered.length > 0 || raw.length === 0 ? filtered : raw;
}

export async function fetchMacroNews(region: "kr" | "us"): Promise<NewsItem[]> {
  const symbol = "MACRO";
  let raw: RawNewsItem[];
  let lang: "ko" | "en";
  if (region === "kr") {
    lang = "ko";
    // 도메인 화이트리스트(KR_PUBLISHER_BY_DOMAIN, 22곳)를 그대로 쓰면 NAVER
    // 검색 결과 15건 중 살아남는 게 topic당 1~4건뿐이라 "국내 시황"란이 거의
    // 비다시피 했다(실측, 2026-09 — 오너 지적: "국내시황은 왜 저리 적은가").
    // 이미 아래 MARKET_RELEVANT_KO 로 주제 적합성을 따로 거르고 있어(종목뉴스
    // 탭이 화이트리스트 대신 LLM 판정으로 넘어간 것과 같은 이유 — 고정된 소수
    // 도메인 목록보다 신뢰도 낮음) 화이트리스트는 끄고 주제 필터에 맡긴다.
    const results = await Promise.all(
      KR_MACRO_TOPICS.map((q) =>
        fetchKrNewsBySearch(symbol, q, {
          cutoffMs: ONE_WEEK_MS,
          // 제휴 기사만 남기느라 줄어드는 만큼 더 넉넉히 받아 온다
          display: 40,
          requireWhitelist: false,
          requireNaverLink: true,
        }),
      ),
    );
    raw = filterMacroRelevant(results.flat(), MACRO_RELEVANT_KO);
  } else {
    lang = "en";
    const [yahooResults, google] = await Promise.all([
      Promise.all(
        US_MACRO_TOPICS.map((q) =>
          fetchUsJpNews("us", symbol, q, { cutoffMs: ONE_WEEK_MS, newsCount: 15 }),
        ),
      ),
      // 질의당 수십 건이 들어오므로 여기선 매체 화이트리스트를 켠다(Kitco·FXStreet·
      // 지역지 등 걸러도 CNBC·로이터·WSJ·블룸버그·FT·CNN 만으로 충분히 남음).
      Promise.all(
        US_MACRO_GOOGLE_QUERIES.map((q) =>
          fetchGoogleOverseasNews("us", symbol, q, {
            cutoffMs: ONE_WEEK_MS,
            limit: 40,
            requireWhitelist: true,
          }).catch(() => [] as RawNewsItem[]),
        ),
      ),
    ]);
    raw = filterMacroRelevant([...yahooResults.flat(), ...google.flat()], MACRO_RELEVANT_EN);
  }
  const seenUrls = new Set<string>();
  const deduped = raw.filter((it) => {
    if (seenUrls.has(it.url)) return false;
    seenUrls.add(it.url);
    return true;
  });
  const merged = dedupeByMajorPublisher(deduped);
  // 거시경제 시황(국내/해외) 헤드라인은 무료 번역만 — LLM 폴백 없음(오너 지시 2026-09-15).
  const items = await withTranslatedTitles(lang, merged, { llmFallback: false });
  return items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 30);
}

/** 국내(이미 한국어) 언론사인지 — 번역·요약 대상 여부 판정(종목의 상장 시장이 아니라 기사 언론사 기준). */
export function isDomesticPublisher(publisher: string): boolean {
  return DOMESTIC_PUBLISHERS.has(publisher);
}


