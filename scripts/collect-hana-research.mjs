/**
 * 하나증권 "기업분석" 리포트 — 로컬 수집기.
 *
 * www.hanaw.com 의 리서치센터 목록은 로그인 없이 그대로 서버렌더링된 HTML로
 * 나온다(신한과 달리 별도 JSON API 역추적이 필요 없음 — 페이지네이션도 평범한
 * GET 쿼리스트링). 제목이 "종목명(종목코드.거래소/투자의견): 제목" 형식으로
 * 고정돼 있어 종목코드를 별도 매핑 없이 제목에서 바로 뽑는다.
 *
 * ⚠️ www.hanaw.com/robots.txt 는 `Disallow: /` (Googlebot·Yeti 제외)다. 신한과
 *    동일하게 "개인용·로컬 실행·저빈도" 조건으로 오너 승인(CLAUDE.md 참조).
 *    앱 배포본(Vercel)에는 이 수집 코드가 없다 — DB 적재 라우트는 결과만 받는다.
 *
 * 목표주가(2026-09 추가): 목록 요약(rawBody)에는 목표주가가 거의 안 나온다
 * (오너 확인 — 실적 속보성 문단이라 재언급 안 함). 대신 PDF 표지 옆
 * "BUY (유지)\n목표주가(12M) 220,000원\n현재주가(9.11) 119,300원" 블록에
 * 항상 있어(pdf-parse 추출 순서상 본문 뒤쪽에 나옴, 실측 확인) PDF를 내려받아
 * 그 값을 우선 사용한다(목록 요약에서 먼저 찾아보고 없으면 PDF로 폴백).
 * PDF 다운로드가 매번 비용이 드는 작업이라 --days 기본값을 14 → 3으로
 * 좁혔다(다른 PDF 기반 수집기와 동일 이유 — 서버가 통째로 replace하므로
 * 넓게 잡으면 매일 옛 PDF까지 재다운로드하게 됨).
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-hana-research.mjs             # 최근 3일, 최대 5페이지
 *   node scripts/collect-hana-research.mjs --days=30 --pages=10
 *   node scripts/collect-hana-research.mjs --dry-run   # 전송 안 하고 파싱 결과만
 *
 * ── 설정 (.env.local, 선택) ─────────────────────────────────────────
 *   SHINHAN_RESEARCH_IMPORT_URL="https://macroresearch.vercel.app/api/cron/total-research"
 *   CRON_SECRET="앱에 설정한 값이 있으면"
 * (신한 수집기와 같은 수신 라우트를 재사용 — source 로 구분됨)
 */

import { readFileSync } from "node:fs";
import { enrichResearch } from "./lib/research-extract.mjs";
import { isCommonExcludedContent } from "./lib/exclude-filters.mjs";
import { marketFromLabel, marketFromTitleLead } from "./lib/overseas-market.mjs";

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
const MAX_PAGES = Number(ARGS.find((a) => a.startsWith("--pages="))?.split("=")[1]) || 5;

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://macroresearch.vercel.app/api/cron/total-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim(); // 로컬 수동 실행 시 CRON_SECRET 없어도 인증 가능(라우트가 x-app-token도 허용)

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST_URL = "https://www.hanaw.com/main/research/research/list.cmd";
// pid=3&cid=2 = 산업/기업 > 기업분석 게시판, cid=1 = 같은 메뉴의 산업분석
// 게시판(2026-09 추가, 오너 지시 — "한국과 미국 모두 동일하게 수집 기반
// 구축"). 제목이 "업종명(투자의견): 제목"(괄호 생략되는 경우도 있음, 예:
// "에너지/화학: Weekly Monitor: ...") 형식이라 종목 제목과 다른 정규식
// (INDUSTRY_TITLE_RE)으로 업종명만 뽑는다 — 특정 종목이 아니므로 symbol
// 항상 null, 목표주가·투자의견 추출도 건너뜀.
const BASE_PARAMS = { pid: "3", cid: "2", srchTitle: "", srchWord: "", startDate: "1900-01-01", endDate: "9999-12-31" };
const INDUSTRY_TITLE_RE = /^(.+?)(?:\([^)]*\))?\s*:\s*(.+)$/;

const isoDate = (s) => {
  const m = String(s).trim().match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

const EXCERPT_LEN = 300;
function excerpt(text) {
  const flat = String(text ?? "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return flat.length > EXCERPT_LEN ? `${flat.slice(0, EXCERPT_LEN)}…` : flat;
}

function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .trim();
}

// 제목 형식: "종목명(코드.거래소/투자의견): 나머지 제목" — 코드는 숫자 6자리
// (뒤에 영문 붙는 스팩/우선주 등은 그대로 두되 앞 6자리만 씀).
const TITLE_RE = /^(.+?)\((\d{6}[A-Z0-9]*)\.[A-Z]+\s*\/\s*([^)]+)\)\s*:\s*(.+)$/;

async function fetchPage(page, cid = "2") {
  const url = new URL(LIST_URL);
  for (const [k, v] of Object.entries(BASE_PARAMS)) url.searchParams.set(k, v);
  url.searchParams.set("cid", cid);
  url.searchParams.set("curPage", String(page));
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// 각 리포트 항목의 제목 앵커를 앵커로 삼아 뒤따르는 날짜·본문·PDF 링크를 뽑는다.
const ITEM_RE =
  /<a href="#" class="more_btn title" title="더보기" id="(\d+)_(\d+)">([^<]+)<\/a>[\s\S]{0,80}?<li class="mb7 m-info info">[\s\S]*?<span class="txtbasic">([\d.]+)<\/span>[\s\S]{0,400}?<li class="mb7 j_bbsContn[^"]*">([\s\S]*?)<\/li>[\s\S]{0,600}?class="j_fileLink"[^>]*>([^<]*)<\/a>/g;

function parseItems(html) {
  const items = [];
  for (const m of html.matchAll(ITEM_RE)) {
    const [, bbsCd, bbsSeq, rawTitle, rawDate, rawBody] = m;
    const title = stripHtml(rawTitle);
    const date = isoDate(rawDate);
    if (!date || isCommonExcludedContent(title, "기업")) continue;
    const tm = title.match(TITLE_RE);
    items.push({
      id: `${bbsCd}_${bbsSeq}`,
      date,
      title,
      stockName: tm ? tm[1].trim() : title,
      symbolHint: tm ? tm[2].slice(0, 6) : null,
      opinion: tm ? tm[3].trim() : "",
      opinionFrom: "title", // "종목명(코드.거래소/의견)" 제목 — 공용 추출기 C2 검증 제외
      targetPrice: null,
      summary: excerpt(stripHtml(rawBody)),
      bodyText: stripHtml(rawBody),
      pdfUrl: `https://www.hanaw.com/main/research/research/download.cmd?bbsSeq=${bbsSeq}&attachFileSeq=1&bbsId=&dbType=&bbsCd=${bbsCd}`,
      category: "기업",
      board: "하나증권 > 산업/기업 > 기업분석(pid=3, cid=2)",
    });
  }
  return items;
}

function parseIndustryItems(html) {
  const items = [];
  for (const m of html.matchAll(ITEM_RE)) {
    const [, bbsCd, bbsSeq, rawTitle, rawDate, rawBody] = m;
    const title = stripHtml(rawTitle);
    const date = isoDate(rawDate);
    if (!date || isCommonExcludedContent(title, "산업")) continue;
    const tm = title.match(INDUSTRY_TITLE_RE);
    const label = tm ? tm[1].trim() : "산업";
    const headline = tm ? tm[2].trim() : title;
    items.push({
      id: `${bbsCd}_${bbsSeq}`,
      date,
      title: headline,
      stockName: label,
      // 라벨이 국가명으로 시작하면 그 나라 시장("중국 자동차 판매동향" → ch), 라벨에 국가가 없어도 제목이 "중국 …"으로 시작하면 ch. 아니면 국내(kr).
      market: marketFromLabel(label) ?? marketFromTitleLead(headline) ?? "kr",
      symbolHint: null,
      opinion: "",
      targetPrice: null,
      summary: excerpt(stripHtml(rawBody)),
      pdfUrl: `https://www.hanaw.com/main/research/research/download.cmd?bbsSeq=${bbsSeq}&attachFileSeq=1&bbsId=&dbType=&bbsCd=${bbsCd}`,
      category: "산업",
      board: "하나증권 > 산업/기업 > 산업분석(pid=3, cid=1)",
    });
  }
  return items;
}

// 글로벌 기업분석(pid=8&cid=3, 미국만 .US 필터) — 구
// collect-hana-global-research.mjs.
const GLOBAL_TITLE_RE = /^(.+?)\(([A-Za-z0-9.-]{1,10})\.US\)\s*:\s*(.+)$/;
async function fetchGlobalPage(page) {
  const url = new URL(LIST_URL);
  for (const [k, v] of Object.entries({ pid: "8", cid: "3", srchTitle: "", srchWord: "", startDate: "1900-01-01", endDate: "9999-12-31" })) {
    url.searchParams.set(k, v);
  }
  url.searchParams.set("curPage", String(page));
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
function parseGlobalItems(html) {
  const items = [];
  let rawRows = 0;
  for (const m of html.matchAll(ITEM_RE)) {
    rawRows += 1;
    const [, bbsCd, bbsSeq, rawTitle, rawDate, rawBody] = m;
    const title = stripHtml(rawTitle);
    const date = isoDate(rawDate);
    if (!date) continue;
    const tm = title.match(GLOBAL_TITLE_RE);
    if (!tm) continue;
    if (isCommonExcludedContent(title, "기업")) continue;
    items.push({
      id: `${bbsCd}_${bbsSeq}`,
      date,
      title,
      stockName: tm[1].trim(),
      symbolHint: tm[2].toUpperCase(),
      opinion: "",
      targetPrice: null,
      summary: excerpt(stripHtml(rawBody)),
      pdfUrl: `https://www.hanaw.com/main/research/research/download.cmd?bbsSeq=${bbsSeq}&attachFileSeq=1&bbsId=&dbType=&bbsCd=${bbsCd}`,
      category: "기업",
      market: "us",
      board: "하나증권 > 글로벌리서치 > 글로벌 기업분석(pid=8, cid=3)",
    });
  }
  return { items, rawRows };
}

// 글로벌 산업분석(cid=2)/투자전략(cid=1) — 구
// collect-hana-global-industry-research.mjs. 목록 구조는 같지만 애널리스트·
// "해외주식 > {카테고리}" 라벨을 추가로 캡처하는 별도 정규식이 필요.
const GLOBAL_INDUSTRY_BOARDS = [
  { cid: "1", label: "글로벌 투자전략" },
  { cid: "2", label: "글로벌 산업분석" },
];
const NON_US_RE =
  /중국|차이나|China|인도(?!네시아)|India\b|베트남|Vietnam|신흥국|이머징|Emerging|브라질|Brazil|대만|Taiwan|일본|Japan|유럽|Europe/i;
const US_HINT_RE = /미국|\bUS\b|나스닥|Nasdaq|S&P|다우|연준|\bFed\b|FOMC|월가|Wall Street|빅테크/i;
function classifyMarket(text) {
  if (NON_US_RE.test(text)) return null;
  if (US_HINT_RE.test(text)) return "us";
  return null;
}
const INDUSTRY_ITEM_RE =
  /<a href="#" class="more_btn title" title="더보기" id="(\d+)_(\d+)">([^<]+)<\/a>[\s\S]{0,80}?<li class="mb7 m-info info">[\s\S]*?<span class="none m-name">([^<]*)<\/span>[\s\S]*?<span class="txtbasic">([\d.]+)<\/span>[\s\S]{0,400}?해외주식\s*>\s*([^<]+?)<\/li>[\s\S]{0,400}?<li class="mb7 j_bbsContn[^"]*">([\s\S]*?)<\/li>[\s\S]{0,600}?class="j_fileLink"[^>]*>([^<]*)<\/a>/g;
async function fetchGlobalIndustryPage(cid, page) {
  const url = new URL(LIST_URL);
  for (const [k, v] of Object.entries({ pid: "8", srchTitle: "", srchWord: "", startDate: "1900-01-01", endDate: "9999-12-31" })) {
    url.searchParams.set(k, v);
  }
  url.searchParams.set("cid", cid);
  url.searchParams.set("curPage", String(page));
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
function parseGlobalIndustryItems(html, boardLabel) {
  const items = [];
  for (const m of html.matchAll(INDUSTRY_ITEM_RE)) {
    const [, bbsCd, bbsSeq, rawTitle, analyst, rawDate, category, rawBody] = m;
    const title = stripHtml(rawTitle);
    const date = isoDate(rawDate);
    if (!date) continue;
    const market = classifyMarket(`${title} ${stripHtml(rawBody)}`);
    if (!market || isCommonExcludedContent(`${category.trim()} ${title}`, "산업")) continue;
    items.push({
      id: `${bbsCd}_${bbsSeq}`,
      date,
      title,
      stockName: category.trim(),
      symbolHint: null,
      analyst: analyst.trim(),
      opinion: "",
      targetPrice: null,
      market,
      board: boardLabel,
      summary: excerpt(stripHtml(rawBody)),
      pdfUrl: `https://www.hanaw.com/main/research/research/download.cmd?bbsSeq=${bbsSeq}&attachFileSeq=1&bbsId=&dbType=&bbsCd=${bbsCd}`,
      category: "산업",
    });
  }
  return items;
}

console.log(`▶ 하나증권 기업분석 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);

// 항목 날짜가 'YYYY-MM-DD'(=UTC 자정)라 컷오프도 자정으로 맞춘다.
// Date.now() 기준 그대로 두면 '정확히 DAYS일 전' 리포트가 시:분 차이로
// 매번 잘려나간다(실측 2026-09: 미래에셋 최신 리포트가 3시간 차이로 탈락).
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));
const collected = [];
let stop = false;

for (let page = 1; page <= MAX_PAGES && !stop; page++) {
  const html = await fetchPage(page, "2");
  const items = parseItems(html);
  if (items.length === 0) break;
  for (const it of items) {
    if (new Date(it.date) < cutoff) {
      stop = true;
      break;
    }
    collected.push(it);
  }
  await sleep(400); // 예의상 간격
}

stop = false;
for (let page = 1; page <= MAX_PAGES && !stop; page++) {
  const html = await fetchPage(page, "1");
  const items = parseIndustryItems(html);
  if (items.length === 0) break;
  for (const it of items) {
    if (new Date(it.date) < cutoff) {
      stop = true;
      break;
    }
    collected.push(it);
  }
  await sleep(400); // 예의상 간격
}

// 글로벌 기업분석(pid=8&cid=3, .US만).
console.log(`▶ 하나증권 글로벌 기업분석 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
let gStop = false;
let gTotalRows = 0;
for (let page = 1; page <= MAX_PAGES && !gStop; page++) {
  const html = await fetchGlobalPage(page);
  const { items, rawRows } = parseGlobalItems(html);
  gTotalRows += rawRows;
  if (rawRows === 0) break;
  if (items.length === 0) continue;
  for (const it of items) {
    if (new Date(it.date) < cutoff) {
      gStop = true;
      break;
    }
    collected.push(it);
  }
  await sleep(400);
}
if (gTotalRows > 0 && !collected.some((it) => it.market === "us" && it.category === "기업")) {
  console.log(`· 최근 ${DAYS}일 안에 미국(.US) 종목 리포트가 없습니다(목록 ${gTotalRows}건 정상 조회).`);
}

// 글로벌 산업분석(cid=2)/투자전략(cid=1).
console.log(`▶ 하나증권 글로벌 산업분석/투자전략 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지 × ${GLOBAL_INDUSTRY_BOARDS.length}개 게시판`);
for (const board of GLOBAL_INDUSTRY_BOARDS) {
  let iStop = false;
  for (let page = 1; page <= MAX_PAGES && !iStop; page++) {
    const html = await fetchGlobalIndustryPage(board.cid, page);
    const items = parseGlobalIndustryItems(html, `하나증권 > 글로벌리서치 > ${board.label}(pid=8, cid=${board.cid})`);
    const rawCount = [...html.matchAll(INDUSTRY_ITEM_RE)].length;
    if (rawCount === 0) break;
    for (const it of items) {
      if (new Date(it.date) < cutoff) continue;
      collected.push(it);
    }
    const rawDates = [...html.matchAll(INDUSTRY_ITEM_RE)].map((m) => isoDate(m[5])).filter(Boolean);
    if (rawDates.length && new Date(Math.min(...rawDates.map((d) => new Date(d).getTime()))) < cutoff) {
      iStop = true;
    }
    await sleep(400);
  }
}

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. 페이지 구조가 바뀌었을 수 있음(정규식 재확인 필요).");
  process.exit(1);
}

console.log(`✔ 파싱 완료: ${collected.length}건`);
console.log(
  "  최근 3건:",
  collected.slice(0, 3).map((i) => `${i.date} ${i.stockName}(${i.symbolHint}) — ${i.title}`),
);

console.log(`▶ 목표주가 보강 중 (${collected.length}건)...`);
// 공용 추출기(본문 → PDF, 산업분석은 내부에서 건너뜀).
await enrichResearch(collected, { market: "kr" });
console.log(
  "  예시:",
  collected.find((it) => it.targetPrice != null)?.targetPrice ?? "(없음)",
);

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

// analyst 필드는 이 정규식에서 안정적으로 못 뽑아 빈 값으로 보냄(제목·요약·PDF가
// 핵심이라 우선순위 낮음) — /api/cron/total-research 는 analyst 없어도 저장됨.
// symbol 은 제목에서 이미 뽑은 6자리 코드를 그대로 넘겨 서버의 이름 검색을 건너뛴다.
// 글로벌 기업분석·산업분석 병합으로 market이 kr/us 섞이므로 market별로 나눠 전송.
const byMarket = new Map();
for (const it of collected) {
  const market = it.market ?? "kr";
  if (!byMarket.has(market)) byMarket.set(market, []);
  byMarket.get(market).push({
    id: it.id,
    date: it.date,
    title: it.title,
    stockName: it.stockName,
    symbol: it.symbolHint,
    analyst: it.analyst ?? "",
    opinion: it.opinion,
    targetPrice: it.targetPrice,
    summary: it.summary,
    pdfUrl: it.pdfUrl,
    views: null,
    category: it.category,
    board: it.board,
  });
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

for (const [market, items] of byMarket) {
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items, source: "하나증권", market }),
  });
  const upBody = await up.text();
  if (!up.ok) {
    console.error(`✗ 앱 전송 실패(market=${market}) HTTP ${up.status}: ${upBody.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`\n✔ 앱 전송 완료(market=${market}, ${items.length}건): ${upBody}`);
}
