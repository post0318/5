import "server-only";
import YahooFinancePkg from "yahoo-finance2";
import { fetchJson } from "./http";
import type { MarketId } from "./types";
import { translateTitles, type TranslateOptions } from "../news/translate";
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
        { headers: { "user-agent": NAVER_UA }, revalidate: 900 },
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
  },
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
): Promise<NewsItem[]> {
  const query = companyName || symbol;
  // KR은 네이버 증권의 종목코드별 태깅 API(fetchKrStockTaggedNews)를 써서
  // 애초에 검색·필터 자체가 불필요 — 나머지 시장은 기존 야후 검색 유지.
  const items =
    market === "kr"
      ? await fetchKrStockTaggedNews(symbol)
      : await fetchUsJpNews(market, symbol, yahooQuery(market, symbol, query));
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
 * 해외 폴백(LLM 미사용)용 관련성 판정기 — 기사 제목(+요약)에
 *  (1) 정리된 회사명 전체(정규화 비교: "AMAZON COM"→"amazoncom") 또는
 *  (2) 회사명 첫 단어(5자 이상, 흔한 단어 제외 — "Amazon", "Marriott", "Applied") 또는
 *  (3) 티커(대소문자 구분, 단어 경계 — "BE"가 영어 "be"에 걸리지 않게)
 * 가 있으면 통과. 실측(2026-09): EDGAR 명 "AMAZON COM INC"/"COCA COLA CO"/"MCDONALDS
 * CORP"는 단순 소문자 포함 비교로는 제목의 "Amazon"/"Coca-Cola"/"McDonald's"와
 * 안 맞았음.
 */
function overseasNameMatcher(shortName: string, symbol: string): (hay: string) => boolean {
  const nameNorm = normalizeForMatch(shortName);
  const first = distinctiveFirstWord(shortName);
  const firstWord = first ? normalizeForMatch(first) : "";
  const useFirst = firstWord.length > 0;
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tickerRe = new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`);
  return (hay: string) => {
    const hayNorm = normalizeForMatch(hay);
    if (nameNorm && hayNorm.includes(nameNorm)) return true;
    if (useFirst && hayNorm.includes(firstWord)) return true;
    return tickerRe.test(hay);
  };
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
): Promise<{
  domestic: NewsItem[];
  overseas: NewsItem[];
  debug: { rawDomestic: number; rawOverseas: number; relevance: "llm" | LlmFallbackReason | "no_company_name" };
}> {
  const query = companyName || symbol;
  const oQuery = overseasQuery(market, symbol, query);
  const isKr = market === "kr";
  // 해외종목도 네이버가 종목-기사 태깅을 해준다(예: NFLX.O). 접미사 규칙이
  // 거래소마다 달라 자동완성 API 로 코드를 먼저 해석한다. 한국어 종목명도 같이
  // 얻어 검색 폴백의 질의어로 쓴다("NETFLIX INC" 로는 국내 기사가 안 잡힘).
  const naver = isKr ? null : await resolveNaverWorldStock(symbol);
  const searchQuery = isKr ? query : (naver?.koreanName ?? domesticQuery(market, query));

  const [domesticTagged, domesticSearched, yahooOverseas, googleOverseas, googleOverseasAlt] = await Promise.all([
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
    isKr
      ? Promise.resolve([])
      : fetchKrNewsBySearch(symbol, searchQuery, {
          cutoffMs: ONE_WEEK_MS,
          display: 30,
          requireWhitelist: false,
        }),
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
    const whitelisted = domesticRaw.filter(
      (it) => taggedUrls.has(it.url) || DOMESTIC_PUBLISHERS.has(it.publisher),
    );
    if (name) {
      const domesticFiltered = whitelisted.filter(
        (it) =>
          taggedUrls.has(it.url) ||
          isDomesticRelevant(companyName, symbol, it.title, it.excerpt),
      );
      domesticSafe =
        domesticFiltered.length > 0 || whitelisted.length === 0 ? domesticFiltered : whitelisted;
    } else {
      domesticSafe = whitelisted;
    }
    // 해외 폴백: 종목뉴스 탭은 requireWhitelist=false 로 원본을 받아오므로(LLM이
    // 신뢰도까지 판정하는 전제) LLM 이 없을 땐 여기서 화이트리스트를 되살리고,
    // 제목에 회사명(EDGAR 명 정리본) 또는 티커가 있는 기사만 남긴다 — Yahoo 티커
    // 검색은 그 종목에 느슨하게 태깅된 시황·타종목 기사(실측: GLW 검색에 "Iren
    // 더블 업그레이드", "오일 콜 스프레드")를 섞어 보내기 때문. 회사명이 제목에
    // 다른 표기로만 등장하는 경우(예: Alphabet→Google)는 놓칠 수 있음 — LLM
    // 경로가 살아나면 그쪽이 처리.
    const shortName = name ? cleanEdgarName(name) : null;
    const matcher = shortName ? overseasNameMatcher(shortName, symbol) : null;
    overseasSafe = overseasRaw.filter((it) => {
      if (!ALLOWED_PUBLISHERS.has(it.publisher.toLowerCase())) return false;
      return matcher ? matcher(`${it.title} ${it.excerpt ?? ""}`) : true;
    });
    relevance = !name ? "no_company_name" : (llmResult?.fallback ?? "no_api_key");
  }
  domesticSafe = dedupeByMajorPublisher(domesticSafe);
  overseasSafe = dedupeOverseasSyndication(overseasSafe);

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
const MACRO_RELEVANT_EN =
  /\b(fed|federal reserve|interest rate|rate hike|rate cut|inflation|cpi|ppi|gdp|jobs report|unemployment|stock market|s&p|nasdaq|dow jones|treasury|yield|recession|economy|economic|tariff|trade war|fomc|wall street|markets?)\b/i;
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
