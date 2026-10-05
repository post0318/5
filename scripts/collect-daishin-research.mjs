/**
 * 대신증권 리서치 수집기 — 모바일 웹(money2.daishin.com) 직접 수집.
 *
 * 경위: 예전엔 PC 게시판("기업분석"·"글로벌 기업분석")이 로그인 페이지로
 * 리다이렉트돼 "제외, 재검토 안 함"으로 결정했었다. 오너가 2026-09-25 모바일
 * 웹 경로로 전환을 결정 — 모바일은 로그인 없이 열린다(iPhone Safari UA, 실측).
 *
 * ── 조사 결과(실측 2026-09-25) ────────────────────────────────────────
 *  - 목록: GET /E5/ResearchCenter/DM_ResearchList.aspx?pr_code=2&page=N
 *    서버렌더 HTML. page=N 이면 최신부터 N×10건이 누적으로 온다(page=40 → 400건,
 *    약 45일치, 0.5초). pr_code=1 은 "오늘의리포트"(Morning Meeting Brief 모음).
 *  - 본문: GET /E5/ResearchCenter/DM_ResearchRead.aspx?rowid=N&pr_code=2&page=1
 *    제목(`board-title"><strong>`)·날짜(`<li>2026/09/23</li>`)·조회수(`<li>조회 N</li>`)·
 *    본문(텍스트 또는 이미지 한 장)·PDF 링크(`class='file-link' href='/PDF/Out\...pdf'`).
 *    없는 rowid 는 200 + 빈 제목으로 온다.
 *  - PDF: 링크를 그대로 붙이면 로그인 없이 받아진다. 경로의 백슬래시는 URL 규격상
 *    슬래시와 같은 요청이라(WHATWG URL 이 http(s) 에서 "\"→"/" 정규화) 슬래시로 바꿔 저장.
 *  - **모바일 목록은 글의 절반쯤을 빼고 보여준다**: 62600~62826 중 106개 rowid 가
 *    목록에 없었고, 빠진 쪽에 오히려 종목 리포트(Issue Comment — 두산·한섬·삼성전자·
 *    휴젤, Issue & News — XOM·LMT·AMZN)·원자재·BOJ·THE GLOBAL NOTE 가 몰려 있었다.
 *    그래서 목록은 "기준점(최대 rowid)과 이미 아는 제목"으로만 쓰고, --days 범위의
 *    rowid 를 본문 페이지로 하나씩 연속 조회한다(목록에 있고 제목만으로 제외되는 글은
 *    건너뜀). 3일이면 대략 40~60요청(요청 간격 450ms).
 *  - **재게시(repost)**: 2026-09-23 에 옛 글 30여 건이 새 rowid·새 날짜로 다시
 *    올라왔다(예: 62809 = 62763 "한국 생산자물가", 62802 = 62661 "글로벌 뉴스
 *    다이제스트 26.09.11"). ① 같은 제목이 더 작은 rowid 로 있거나(이번 조회분 + 목록
 *    약 45일치) ② 제목·PDF 파일명에 박힌 날짜가 게시일보다 3일 넘게 앞서면 재게시로
 *    보고 버린다.
 *  - robots.txt 는 방화벽(WAF)이 요청 자체를 400 으로 막아 확인할 수 없었다.
 *    오너 승인(2026-09-25) — 다른 예외와 같은 "개인용·저빈도" 조건(하루 2회, 요청 간격
 *    ≥400ms, 로그인 없음).
 *  - 목록·본문에 종목명·종목코드·투자의견·목표주가 구조화 필드가 없다.
 *
 * ── 분류(오너 결정 — 삼성증권과 같은 기준) ───────────────────────────
 *  제목은 "[대신증권 애널리스트][시리즈] 헤드라인"(대괄호 없는 글도 있음). 앞의
 *  "[대신증권 이름]"은 작성자로 떼고, 이어지는 대괄호들을 시리즈로 본다.
 *  순서대로 첫 규칙이 이긴다(규칙 표는 classify() 주석).
 *   1. 제외: 오늘의리포트 모음(Morning Meeting Brief)·ETF/ETP·ESG·공통 제외(주간물·
 *      일정표·추천종목·원자재 외 대체투자)·"포트폴리오가 커지는 Stock"(위클리 리테일
 *      추천종목 모음 — 오너 확인 2026-09-25, PDF 샘플(2026-08-10자) 검토 후 제외 확정).
 *   2. 미국 종목: "[Issue & News] 종목명: …" + PDF 파일명 "event_{TICKER}_" → 기업/us.
 *   3. 시황 시리즈(장마감 시황·데일리 뉴스·뉴스 다이제스트·실적 대시보드·실적 시즌
 *      모니터) → 산업/kr, stockName "대신증권 시황".
 *   4. 전략 시리즈(퀀틴전시 플랜·다음주 시장은?·증시 전망·투자전략·THE GLOBAL·
 *      KOSPI/KOSDAQ 언급, PDF 파일명 THE_GLOBAL·Strategy_Daily) → 산업/kr,
 *      stockName "대신증권 투자전략".
 *   4'. 종목 시리즈(Issue Comment·Issue & News·기업분석 등)면 여기서 7번 국내 종목
 *      판별을 먼저 한다("[고배당 고금리 Issue Comment] 삼성전자" 가 "금리" 때문에
 *      이슈분석으로 새던 문제).
 *   5. 원자재(제목 또는 PDF 파일명 Commodity) → 거시경제 이슈분석.
 *   6. 거시 키워드(AI Economist·Fed Oracle·FOMC·금리·물가·GDP·고용 등) → 이슈분석
 *      (환율/FX 가 주제면 환율분석).
 *   7. 국내 종목: PDF 1쪽 "종목명 (6자리코드)" 를 corpcodes.json 으로 검증, 없으면
 *      종목 시리즈(Issue Comment 등)일 때만 헤드라인 앞 회사명 매칭 → 기업/kr.
 *   8. 나머지: 스트래티지스트(이경민·문남중·권순호) 글은 투자전략, 그 외는 산업
 *      (stockName = 시리즈 대괄호, 없으면 "산업").
 *  "대신증권 시황"/"대신증권 투자전략"은 src/lib/db/shinhan-research.ts 의
 *  MARKET_CONDITION_/STRATEGY_STOCKNAMES 에 이미 등록돼 있다.
 *
 * 투자의견·목표주가는 공용 추출기(enrichResearch) — 종목 판별에 읽은 PDF 텍스트를
 * 넘겨 두 번 받지 않는다. pdfUrl 은 PDF 직링크 우선, PDF 가 없는 글만 본문 페이지 URL.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-daishin-research.mjs
 *   node scripts/collect-daishin-research.mjs --days=7 --dry-run
 */

import { readFileSync } from "node:fs";
import { enrichResearch, readPdfText } from "./lib/research-extract.mjs";
import { isEtfOrEtpContent, isEsgContent, isCommonExcludedContent, isCommodityContent, isFxContent } from "./lib/exclude-filters.mjs";
import { refineSectorLabels } from "./lib/sector-label.mjs";
import { resolveUsTickerByName } from "./lib/overseas-market.mjs";
import { appUrl } from "./lib/app-url.mjs";
import { appSendFailed, exitNoItems } from "./lib/collector-status.mjs";

function loadEnvLocal() {
  const env = { ...process.env };
  try {
    const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*?)"?\s*$/);
      if (m && (env[m[1]] === undefined || env[m[1]] === "")) env[m[1]] = m[2];
    }
  } catch {
    /* .env.local 없어도 됨 */
  }
  return env;
}
const ENV = loadEnvLocal();
const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes("--dry-run");
const DAYS = Number(ARGS.find((a) => a.startsWith("--days="))?.split("=")[1]) || 3;

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || `${appUrl(ENV)}/api/cron/total-research`
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GAP_MS = 450;

const BASE = "https://money2.daishin.com";
const LIST_URL = `${BASE}/E5/ResearchCenter/DM_ResearchList.aspx`;
const READ_URL = `${BASE}/E5/ResearchCenter/DM_ResearchRead.aspx`;
const SOURCE = "대신증권";
const LABEL_MARKET = "대신증권 시황";
const LABEL_STRATEGY = "대신증권 투자전략";
// 목록 조회 범위 — 재게시 판정용 제목을 넉넉히(약 45일) 받는다.
const LIST_PAGES = Math.min(80, Math.max(40, Math.ceil(DAYS * 1.2) + 30));
// 한 번 실행의 본문 조회 상한(방어) — 하루 약 15~25건.
const MAX_READS = DAYS * 40 + 60;

// ── corpcodes(국내 종목 검증) ─────────────────────────────────────────
const CORPS = JSON.parse(
  readFileSync(new URL("../src/lib/markets/kr/data/corpcodes.json", import.meta.url), "utf8"),
).filter((c) => c.s && /^\d{6}$/.test(c.s));
const NAME_BY_CODE = new Map(CORPS.map((c) => [c.s, c.n]));
const NAMES_LONGEST_FIRST = [...new Set(CORPS.map((c) => c.n))].sort((a, b) => b.length - a.length);
const CODE_BY_NAME = new Map(CORPS.map((c) => [c.n, c.s]));

/** 헤드라인이 회사명으로 시작하고 바로 뒤가 경계(끝·공백·구두점)면 그 회사. */
function matchCorpPrefix(headline) {
  const h = headline.trim();
  for (const n of NAMES_LONGEST_FIRST) {
    if (n.length < 2 || !h.startsWith(n)) continue;
    const next = h.charAt(n.length);
    if (next === "" || /[\s,:：;·(\-–]/.test(next)) return { stockName: n, symbol: CODE_BY_NAME.get(n) };
  }
  return null;
}

// ── 파싱 ────────────────────────────────────────────────────────────
const LIST_ITEM_RE =
  /rowid=(\d+)&GroupCode=\d+[^>]*>([^<]*)<\/a><\/h2>\s*<ul class="board-info">\s*<li>([\d/]+)<\/li>/g;

function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
const toIsoDate = (s) => s.replace(/\//g, "-");

async function getHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

async function fetchList() {
  const html = await getHtml(`${LIST_URL}?pr_code=2&page=${LIST_PAGES}`);
  return [...html.matchAll(LIST_ITEM_RE)].map((m) => ({
    rowid: Number(m[1]),
    title: decodeEntities(m[2]).trim(),
    date: toIsoDate(m[3]),
  }));
}

async function fetchRead(rowid) {
  const html = await getHtml(`${READ_URL}?rowid=${rowid}&pr_code=2&page=1`);
  const title = decodeEntities(html.match(/board-title"><strong>([^<]*)<\/strong>/)?.[1] ?? "").trim();
  const date = html.match(/<ul class="board-info">\s*<li>([\d/]+)<\/li>/)?.[1];
  if (!title || !date) return null; // 없는 rowid
  const views = Number(html.match(/<li>조회\s*([\d,]+)<\/li>/)?.[1]?.replace(/,/g, "")) || null;
  const pdfHref = html.match(/class='file-link' href='([^']+\.pdf)'/i)?.[1] ?? "";
  const pdfPath = pdfHref.replace(/\\/g, "/");
  // 본문: board-body inner-block 안, 첨부 영역 앞까지. 이미지 한 장뿐이면 빈 문자열.
  const bodyHtml = html.match(/<div class="board-body">\s*<div class="inner-block">([\s\S]*?)<div class="board-body-bottom">/)?.[1] ?? "";
  const bodyText = decodeEntities(bodyHtml.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return {
    rowid,
    rawTitle: title,
    date: toIsoDate(date),
    views,
    pdfUrl: pdfPath ? `${BASE}${pdfPath.startsWith("/") ? "" : "/"}${pdfPath}` : "",
    pdfName: pdfPath.split("/").pop() ?? "",
    bodyText,
  };
}

/** "[대신증권 이경민][퀀틴전시 플랜] 헤드라인" → 작성자·시리즈·헤드라인. */
function splitTitle(raw) {
  let t = raw.trim();
  let analyst = "";
  const am = t.match(/^\[대신증권\s+([^\]]+)\]\s*/);
  if (am) {
    analyst = am[1].trim();
    t = t.slice(am[0].length);
  }
  const series = [];
  for (;;) {
    const bm = t.match(/^\[([^\]]+)\]\s*/);
    if (!bm) break;
    series.push(bm[1].trim());
    t = t.slice(bm[0].length);
  }
  return { analyst, series, headline: t.trim(), full: t === "" ? raw : `${series.map((s) => `[${s}]`).join("")} ${t}`.trim() };
}

// ── 재게시 판정 ──────────────────────────────────────────────────────
const normTitle = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** 제목·PDF 파일명에 박힌 날짜 중 가장 늦은 것(없으면 null). */
function latestEmbeddedDate(text) {
  const out = [];
  const push = (y, m, d) => {
    const mm = Number(m);
    const dd = Number(d);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) out.push(new Date(`${y}-${m}-${d}T00:00:00Z`).getTime());
  };
  for (const m of text.matchAll(/(20\d{2})[-.]?(\d{2})[-.]?(\d{2})(?!\d{3})/g)) push(m[1], m[2], m[3]);
  // "26.09.11"(제목), "_260918"·"_260918073555"(파일명) — 앞 두 자리를 20YY 로.
  for (const m of text.matchAll(/(?:^|[^\d])(2\d)\.?(\d{2})\.?(\d{2})(?:\d{6})?(?=[^\d]|$)/g)) push(`20${m[1]}`, m[2], m[3]);
  return out.length ? Math.max(...out) : null;
}

function isStaleRepost(it) {
  const posted = new Date(`${it.date}T00:00:00Z`).getTime();
  const embedded = latestEmbeddedDate(`${it.rawTitle} ${it.pdfName}`);
  return embedded != null && posted - embedded > 3 * 86_400_000;
}

// ── 분류 ────────────────────────────────────────────────────────────
const MMB_RE = /Morning\s*Meeting\s*Brief/i;
const LOCAL_EXCLUDE_RE = /포트폴리오가\s*커지는\s*Stock/i;
const US_NEWS_RE = /Issue\s*&\s*News/i;
const US_EVENT_PDF_RE = /^\d+_event_([A-Z][A-Z.]{0,6})_/;
// 퀀틴전시 플랜(PDF 파일명 Strategy_Daily)은 매일 나오는 장 마감 코멘트라 시황(오너 결정
// 2026-09-25 — "시황으로"). 시황 규칙이 전략 규칙보다 먼저 적용된다.
const MARKET_SERIES_RE = /장마감\s*시황|데일리\s*뉴스|뉴스\s*다이제스트|실적\s*대시보드|실적\s*시즌\s*모니터|마감\s*시황|퀀틴전시/;
const MARKET_PDF_RE = /Strategy_Daily/i;
const STRATEGY_SERIES_RE =
  /다음\s*주\s*시장|증시\s*전망|투자\s*전략|THE\s*GLOBAL|Global\s*Daishin\s*View|KOSPI|KOSDAQ|코스피|코스닥/i;
const STRATEGY_PDF_RE = /THE_GLOBAL/i;
const MACRO_RE =
  /AI\s*Economist|Fed\s*Oracle|FOMC|BOJ|ECB|금통위|연준|중앙은행|기준금리|금리|국채|채권|물가|인플레|CPI|PPI|PCE|GDP|PMI|고용|실업|임금|소매판매|산업생산|기계수주|주택가격|경기|경제지표|매크로|Macro|환율|\bFX\b|달러|엔화|위안/i;
const COMPANY_SERIES_RE = /Issue\s*Comment|Issue\s*&\s*News|기업\s*분석|Initiat|Company|실적\s*(?:리뷰|프리뷰)|Preview|Review/i;
// 기업분석 PDF 1쪽: "휴젤\n(145020) 미국에서 …", "삼성전자\n(005930)"
const PDF_CODE_RE = /\((\d{6})\)/g;
const STRATEGISTS = new Set(["이경민", "문남중", "권순호"]);
const US_TICKER_FIX = { BRKB: "BRK-B", BRKA: "BRK-A", BFB: "BF-B" };

/**
 * 한 건 분류. 반환: { kind: "skip", reason } | { kind: "research", ... }(거시경제도
 * category:"산업"+고정 stockName의 research 로 합류한다).
 * 규칙 순서(첫 규칙 승):
 *  | # | 조건                                              | 결과                           |
 *  |---|---------------------------------------------------|--------------------------------|
 *  | 1 | Morning Meeting Brief / 포트폴리오가 커지는 Stock | 제외                           |
 *  | 1 | ETF·ESG·공통 제외(주간·일정표·추천종목·대체투자)  | 제외                           |
 *  | 2 | Issue & News + PDF event_{TICKER}_                | 기업/us (symbol=티커)          |
 *  | 3 | 시황 시리즈                                        | 산업/kr "대신증권 시황"        |
 *  | 4 | 전략 시리즈·KOSPI 언급·PDF THE_GLOBAL/Strategy_Daily | 산업/kr "대신증권 투자전략" |
 *  | 4'| 종목 시리즈 + 7번 판별 성공                        | 기업/kr                        |
 *  | 5 | 원자재(제목/PDF 파일명 Commodity)                  | 이슈분석                       |
 *  | 6 | 거시 키워드                                        | 이슈분석(환율/FX → 환율분석)   |
 *  | 7 | PDF 1쪽 (6자리코드) 검증 / 종목 시리즈+회사명      | 기업/kr                        |
 *  | 8 | 스트래티지스트 글                                  | 산업/kr "대신증권 투자전략"    |
 *  | 8 | 나머지                                             | 산업/kr (시리즈 라벨 또는 "산업") |
 */
async function classify(it) {
  const { analyst, series, headline, full } = splitTitle(it.rawTitle);
  const seriesText = series.join(" ");
  const text = `${seriesText} ${headline}`;
  it.analyst = analyst;
  if (MMB_RE.test(text)) return { kind: "skip", reason: "오늘의리포트 모음" };
  if (LOCAL_EXCLUDE_RE.test(text)) return { kind: "skip", reason: "위클리 리테일 추천종목 모음(오너 확인)" };
  if (isEtfOrEtpContent(text)) return { kind: "skip", reason: "ETF/ETP" };
  if (isEsgContent(text)) return { kind: "skip", reason: "ESG" };

  // 2. 미국 종목 속보
  const ev = it.pdfName.match(US_EVENT_PDF_RE);
  if (US_NEWS_RE.test(seriesText) && ev) {
    const [name, ...rest] = headline.split(/\s*[:：]\s*/);
    const ticker = ev[1].replace(/\.$/, "");
    return {
      kind: "research",
      category: "기업",
      market: "us",
      stockName: name.trim(),
      symbol: US_TICKER_FIX[ticker] ?? ticker,
      title: rest.join(": ").trim() || headline,
      rule: "2 미국 Issue&News",
    };
  }
  if (isCommonExcludedContent(text)) return { kind: "skip", reason: "공통 제외(주간·일정표·추천·대체투자)" };

  // 3·4. 시리즈 확정 분류
  if (MARKET_SERIES_RE.test(text) || MARKET_PDF_RE.test(it.pdfName)) {
    return { kind: "research", category: "산업", market: "kr", stockName: LABEL_MARKET, symbol: null, title: full, rule: "3 시황" };
  }
  // THE GLOBAL NOTE 는 제목에 시리즈 대괄호가 빠지는 회차가 있어 PDF 파일명으로도 본다.
  if (STRATEGY_SERIES_RE.test(text) || STRATEGY_PDF_RE.test(it.pdfName)) {
    return { kind: "research", category: "산업", market: "kr", stockName: LABEL_STRATEGY, symbol: null, title: full, rule: "4 전략" };
  }
  // 종목 시리즈("[고배당 고금리 Issue Comment] 삼성전자: …")는 제목의 "금리" 같은 거시
  // 키워드보다 종목 판별을 먼저 한다.
  const companySeries = COMPANY_SERIES_RE.test(seriesText);
  if (companySeries) {
    const c = await detectKrCompany(it, headline, true);
    if (c) return c;
  }
  // 5·6. 거시경제 — 리서치 분류 체계 전면 개편(2026-09-26)으로 macro_issues
  // 컬렉션 폐지, 고정 stockName(shinhan-research.ts FORCED_ISSUE_STOCKNAMES/
  // FORCED_FX_STOCKNAMES 등록)으로 kr_research에 합류시킨다.
  if (isCommodityContent(text) || /commodity/i.test(it.pdfName)) {
    const isFx = isFxContent(text);
    return {
      kind: "research",
      category: "산업",
      market: "kr",
      stockName: isFx ? "대신증권 원자재 FX" : "대신증권 원자재",
      symbol: null,
      title: full,
      rule: "5 원자재",
    };
  }
  if (MACRO_RE.test(text)) {
    const isFx = isFxContent(text);
    return {
      kind: "research",
      category: "산업",
      market: "kr",
      stockName: isFx ? "대신증권 매크로 FX" : "대신증권 매크로",
      symbol: null,
      title: full,
      rule: "6 거시 키워드",
    };
  }

  // 7. 국내 종목
  if (!companySeries) {
    const c = await detectKrCompany(it, headline, false);
    if (c) return c;
  }
  // 8. 나머지
  if (STRATEGISTS.has(analyst)) {
    return { kind: "research", category: "산업", market: "kr", stockName: LABEL_STRATEGY, symbol: null, title: full, rule: "8 스트래티지스트(추정)" };
  }
  // 미국 종목 프리뷰: 시리즈 태그가 "[코스트코 26Q4 Preview] …"처럼 "회사명 + 분기 + Preview"이면 종목 리포트다 — 회사명으로
  // 미국 티커를 조회해 기업/us 로(오너 지적 2026-09-27 — "종목분석 같은데", 라벨 "26Q4 Preview"로 산업분석에 새던 건).
  // 태그가 "[26Q4 Preview] 코스트코: 헤드라인"처럼 분기 Preview 만 있고 회사명이 헤드라인 앞 "회사명:"에 있는 형태도 같다.
  const pv = series.map((x) => x.match(/^(.+?)\s+\d{2}Q\d\s+Preview$/i)).find(Boolean)
    ?? (series.some((x) => /^\d{2}Q\d\s+Preview$/i.test(x)) ? headline.match(/^([^:：]{1,30})[:：]/) : null);
  if (pv) {
    const hit = await resolveUsTickerByName(pv[1].trim());
    if (hit) {
      return { kind: "research", category: "기업", market: "us", stockName: hit.stockName, symbol: hit.symbol, title: headline || full, rule: "8' 미국 종목 Preview" };
    }
  }
  return {
    kind: "research",
    category: "산업",
    market: "kr",
    stockName: series[series.length - 1] || "산업",
    symbol: null,
    title: headline || full,
    rule: "8 기타(추정)",
  };
}

/**
 * 국내 종목 판별 — PDF 1쪽의 "(6자리코드)"를 corpcodes 로 검증, 없으면 헤드라인 앞
 * 회사명 매칭. PDF 가 기업분석 양식이거나 종목 시리즈일 때만 인정한다.
 */
async function detectKrCompany(it, headline, companySeries) {
  let pdfText = "";
  if (it.pdfUrl) {
    pdfText = await readPdfText(it.pdfUrl);
    await sleep(GAP_MS);
  }
  const head = pdfText.slice(0, 800);
  const isCompanyPdf = /기업\s*분석|Issue\s*Comment|ISSUE\s*\n?\s*COMMENT/i.test(head);
  let hit = null;
  if (isCompanyPdf || companySeries) {
    for (const m of head.matchAll(PDF_CODE_RE)) {
      if (NAME_BY_CODE.has(m[1])) {
        hit = { stockName: NAME_BY_CODE.get(m[1]), symbol: m[1] };
        break;
      }
    }
    if (!hit) hit = matchCorpPrefix(headline);
  }
  if (hit) {
    // 헤드라인 앞의 "회사명:"/"회사명," 는 떼어 제목만 남긴다.
    const rest = headline.startsWith(hit.stockName)
      ? headline.slice(hit.stockName.length).replace(/^\s*[:：,，]\s*/, "").trim()
      : headline;
    return {
      kind: "research",
      category: "기업",
      market: "kr",
      stockName: hit.stockName,
      symbol: hit.symbol,
      title: rest || headline,
      pdfText,
      rule: "7 국내 종목",
    };
  }
  return null;
}

// ── 실행 ────────────────────────────────────────────────────────────
console.log(`▶ 대신증권 리서치 수집(모바일 웹): 최근 ${DAYS}일`);
const cutoffIso = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);

const listItems = await fetchList();
if (listItems.length === 0) {
  // 목록은 기간과 무관하게 최신 글부터 쌓여 오므로 비면 휴장일이 아니라 조회·파서 고장 — 조회 실패와 같이 exit 1(공통 규칙의 "0건"과 다름).
  console.error("✗ 목록 파싱 0건(기간 무관 전체 목록이 빔). 페이지 구조가 바뀌었을 수 있음.");
  process.exit(1);
}
const listByRowid = new Map(listItems.map((x) => [x.rowid, x]));
const maxListRowid = Math.max(...listItems.map((x) => x.rowid));
const inRangeListed = listItems.filter((x) => x.date >= cutoffIso);
const minInRange = inRangeListed.length ? Math.min(...inRangeListed.map((x) => x.rowid)) : maxListRowid;
console.log(`  목록 ${listItems.length}건(최대 rowid ${maxListRowid}, 범위 안 ${inRangeListed.length}건)`);
await sleep(GAP_MS);

let reads = 0;
const fetched = [];
const skippedByListTitle = [];
async function visit(rowid) {
  const listed = listByRowid.get(rowid);
  // 목록에 있고 제목만으로 제외되는 글은 본문을 받지 않는다.
  if (listed && listed.date >= cutoffIso) {
    const t = listed.title;
    if (MMB_RE.test(t) || isEtfOrEtpContent(t) || isEsgContent(t) || (isCommonExcludedContent(t) && !US_NEWS_RE.test(t))) {
      skippedByListTitle.push(listed);
      return { date: listed.date };
    }
  }
  if (listed && listed.date < cutoffIso) return { date: listed.date };
  if (reads >= MAX_READS) return null;
  reads++;
  const it = await fetchRead(rowid);
  await sleep(GAP_MS);
  if (it) fetched.push(it);
  return it;
}

// 위로: 목록 최대 rowid 뒤의 목록에 안 뜬 새 글 — 빈 번호 5개 연속이면 멈춤.
let emptyRun = 0;
for (let r = maxListRowid + 1; emptyRun < 5 && r <= maxListRowid + 60; r++) {
  const got = await visit(r);
  emptyRun = got ? 0 : emptyRun + 1;
}
// 아래로: 범위 안 가장 오래된 목록 글보다 더 내려가, 범위 밖 글이 5개 연속이면 멈춤.
let oldRun = 0;
for (let r = maxListRowid; r > 0 && reads < MAX_READS; r--) {
  const got = await visit(r);
  if (got && got.date < cutoffIso) oldRun++;
  else if (got) oldRun = 0;
  if (r < minInRange && oldRun >= 5) break;
}
console.log(`  본문 조회 ${reads}건(제목만으로 제외 ${skippedByListTitle.length}건)`);

// 범위·재게시 거르기
const known = new Map(); // 제목 → 가장 작은 rowid
for (const x of [...listItems, ...fetched.map((f) => ({ rowid: f.rowid, title: f.rawTitle }))]) {
  const k = normTitle(x.title);
  if (!known.has(k) || known.get(k) > x.rowid) known.set(k, x.rowid);
}
const candidates = [];
const reposts = [];
for (const it of fetched.sort((a, b) => b.rowid - a.rowid)) {
  if (it.date < cutoffIso) continue;
  if (known.get(normTitle(it.rawTitle)) < it.rowid || isStaleRepost(it)) {
    reposts.push(it);
    continue;
  }
  candidates.push(it);
}
console.log(`  범위 안 ${candidates.length + reposts.length}건 중 재게시 ${reposts.length}건 제외`);

const research = [];
const skipped = [];
for (const it of candidates) {
  const c = await classify(it);
  const pdfUrl = it.pdfUrl || `${READ_URL}?rowid=${it.rowid}&pr_code=2&page=1`;
  const summary = it.bodyText.slice(0, 300);
  if (c.kind === "skip") {
    skipped.push({ ...it, reason: c.reason });
    continue;
  }
  research.push({
    id: String(it.rowid),
    date: it.date,
    title: c.title,
    stockName: c.stockName,
    symbol: c.symbol,
    analyst: it.analyst,
    opinion: "",
    targetPrice: null,
    summary,
    pdfUrl,
    views: it.views,
    category: c.category,
    market: c.market,
    rule: c.rule,
    ...(c.pdfText ? { pdfText: c.pdfText } : {}),
  });
}

// 범위 안 0건은 공통 규칙대로 실패가 아니다(예전엔 exit 1 → 2026-10-05 대체공휴일 거짓 경보). 며칠째 0건은 신선도 감시가 잡는다.
if (research.length === 0 && candidates.length === 0) exitNoItems({ market: "kr", label: "daishin" });

// 분류별 건수
const tally = new Map();
const bump = (k) => tally.set(k, (tally.get(k) ?? 0) + 1);
for (const x of research) {
  const dest = x.category === "기업" ? "종목" : [LABEL_MARKET, LABEL_STRATEGY].includes(x.stockName) ? x.stockName : "업종 라벨";
  bump(`${x.rule} → ${x.category}/${x.market}/${dest}`);
}
for (const x of skipped) bump(`제외: ${x.reason}`);
tally.set("제외: 목록 제목으로 선제외", skippedByListTitle.length);
tally.set("제외: 재게시", reposts.length);
console.log(`✔ 분류: 리서치 ${research.length}건 · 제외 ${skipped.length + skippedByListTitle.length + reposts.length}건`);
for (const [k, v] of [...tally].sort()) console.log(`    ${k}: ${v}`);

// 투자의견·목표주가(종목만) — 시장별 통화 규칙.
const stockItems = research.filter((it) => it.category === "기업");
console.log(`▶ 투자의견/목표주가 조회 중 (PDF, 로그인 불필요) — ${stockItems.length}건...`);
for (const mk of ["kr", "us"]) {
  const part = stockItems.filter((it) => it.market === mk);
  if (part.length) await enrichResearch(part, { market: mk, sleepMs: GAP_MS, usePdf: true });
}
for (const it of research) delete it.pdfText;

for (const i of research) {
  console.log(
    `  [${i.market}/${i.category}] ${i.date} ${i.symbol ?? i.stockName}${i.symbol ? ` ${i.stockName}` : ""}${i.opinion ? ` (${i.opinion}${i.targetPrice != null ? ` · TP ${i.targetPrice}` : ""})` : i.targetPrice != null ? ` (TP ${i.targetPrice})` : ""} — ${i.title} [${i.analyst}] <${i.rule}>`,
  );
}
for (const i of skipped) console.log(`  [제외:${i.reason}] ${i.date} ${i.rawTitle}`);
for (const i of reposts) console.log(`  [재게시] ${i.date} #${i.rowid} ${i.rawTitle}`);

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

async function post(url, body, label) {
  const up = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const upBody = await up.text();
  if (appSendFailed(up, upBody)) {
    console.error(`✗ [${label}] 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`✔ [${label}] 앱 전송 완료 (${body.items.length}건): ${upBody}`);
}

// 업종 리포트의 뭉뚱그린 라벨("산업")을 제목·PDF 표지의 실제 업종명으로 보정(공통 lib).
console.log(`▶ 업종 라벨 보정: ${await refineSectorLabels(research)}건`);

// 라우트가 POST 1회당 market 하나만 받으므로 시장별로 나눠 전송.
for (const mk of ["kr", "us"]) {
  const items = research
    .filter((it) => it.market === mk)
    .map((it) => ({
      id: it.id,
      date: it.date,
      title: it.title,
      stockName: it.stockName,
      symbol: it.symbol,
      analyst: it.analyst,
      opinion: it.opinion,
      targetPrice: it.targetPrice,
      summary: it.summary,
      pdfUrl: it.pdfUrl,
      views: it.views,
      category: it.category,
      // 원 게시판(사이트 메뉴) — 대조·검수용. 모바일 웹 리서치 목록 하나(pr_code=2)에서 전부 온다.
      board: "대신증권 > 모바일 리서치센터 리서치(DM_ResearchList pr_code=2)",
    }));
  if (items.length) await post(IMPORT_URL, { items, source: SOURCE, market: mk }, `${SOURCE}/${mk}`);
}
