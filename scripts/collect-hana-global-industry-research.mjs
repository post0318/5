/**
 * 하나증권 "글로벌 산업분석"(pid=8&cid=2)·"글로벌 투자전략"(pid=8&cid=1)
 * 게시판 수집기 — 종목 무관 산업/전략 리포트(category:"산업").
 *
 * CLAUDE.md 에는 이 두 게시판이 "모던 그리드(WEB-APP) 컴포넌트라 정적
 * HTML에 데이터가 없고 별도 AJAX 엔드포인트를 못 찾음"으로 미결 남아있었으나
 * (2026-09), 직접 확인한 결과 국내/해외 기업분석 게시판과 완전히 같은
 * 서버렌더링 HTML 목록이었다 — 이전 조사가 잘못됐던 것으로 보임(오너 지시,
 * 2026-09 — "하나증권의 문제는 그러면서 해결해보자").
 *
 * 목록에 "해외주식 > 글로벌 산업분석"/"해외주식 > 글로벌 투자전략" 카테고리
 * 라벨이 그대로 있어 이걸 stockName(라벨)으로 쓴다. 종목명·티커가 없는
 * 업종/전략 리포트라 symbol 은 항상 null, category:"산업"으로 저장 —
 * 목표주가·투자의견 추출도 건너뛴다(다른 증권사 산업분석 수집기와 동일 정책).
 *
 * 시장 분류: 이 두 게시판은 "해외주식" 산하이지만 실제 내용은 미국뿐 아니라
 * 중국·인도·일본·신흥국 등도 섞여 있다(실측: "[Hana China Weekly]", "[신흥국
 * 전략] 인도 외국인 자금..." 등) — 이 프로젝트는 미국만 지원하므로 명시적으로
 * 다른 나라가 언급된 항목은 건너뛰고, 미국/글로벌 매크로 신호어가 있는
 * 항목만 market:"us"로 수집한다(키워드 추측, 미래에셋과 동일한 트레이드오프
 * — 완전하지 않음). 국내 ETF·업종 얘기("[New K-ETF] K-HBM반도체" 등, 국가
 * 신호어 없음)처럼 애매한 항목은 보수적으로 건너뛴다.
 *
 * ⚠️ 접근 조건은 다른 하나증권 수집기와 동일(CLAUDE.md 하나증권 항목 참고):
 *    robots.txt 가 Disallow: / 라 개인용·로컬 실행·하루 1회 조건으로 오너 승인.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-hana-global-industry-research.mjs
 *   node scripts/collect-hana-global-industry-research.mjs --days=14 --dry-run
 */

import { readFileSync } from "node:fs";

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
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://macroresearch.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim(); // 로컬 수동 실행 시 CRON_SECRET 없어도 인증 가능(라우트가 x-app-token도 허용)

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST_URL = "https://www.hanaw.com/main/research/research/list.cmd";
// pid=8&cid=1 = 글로벌 투자전략, pid=8&cid=2 = 글로벌 산업분석.
const BOARDS = [
  { cid: "1", label: "글로벌 투자전략" },
  { cid: "2", label: "글로벌 산업분석" },
];
const BASE_PARAMS = { pid: "8", srchTitle: "", srchWord: "", startDate: "1900-01-01", endDate: "9999-12-31" };

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

// 다른 나라가 명시된 항목은 건너뛴다(이 수집기는 미국 전용) — "일본"이 신흥국
// 전략 얘기 중 하나로만 스쳐 지나가는 경우도 있지만, 오분류보다 누락이 낫다는
// 원칙(recall 대신 precision 우선, NH/DS 사례와 동일)에 따라 보수적으로 제외.
const NON_US_RE =
  /중국|차이나|China|인도(?!네시아)|India\b|베트남|Vietnam|신흥국|이머징|Emerging|브라질|Brazil|대만|Taiwan|일본|Japan|유럽|Europe/i;
// "반도체"/"데이터센터"류 일반 용어는 국내 리포트에도 흔해 오탐(예: "[New
// K-ETF] K-HBM반도체" — 국내 ETF인데 매칭됨, 실측)이 나 US_HINT_RE에서 뺐다.
const US_HINT_RE = /미국|\bUS\b|나스닥|Nasdaq|S&P|다우|연준|\bFed\b|FOMC|월가|Wall Street|빅테크/i;

function classifyMarket(text) {
  if (NON_US_RE.test(text)) return null;
  if (US_HINT_RE.test(text)) return "us";
  return null; // 애매하면 건너뜀(예: 국내 ETF 얘기, 유가·금리 등 국가 신호 없는 항목)
}

// 각 리포트 항목의 제목 앵커를 앵커로 삼아 뒤따르는 애널리스트·날짜·카테고리
// 라벨·본문·PDF 링크를 뽑는다(collect-hana-global-research.mjs 와 같은 목록
// 구조, "해외주식 > {카테고리}" 라벨만 추가로 캡처).
const ITEM_RE =
  /<a href="#" class="more_btn title" title="더보기" id="(\d+)_(\d+)">([^<]+)<\/a>[\s\S]{0,80}?<li class="mb7 m-info info">[\s\S]*?<span class="none m-name">([^<]*)<\/span>[\s\S]*?<span class="txtbasic">([\d.]+)<\/span>[\s\S]{0,400}?해외주식\s*>\s*([^<]+?)<\/li>[\s\S]{0,400}?<li class="mb7 j_bbsContn[^"]*">([\s\S]*?)<\/li>[\s\S]{0,600}?class="j_fileLink"[^>]*>([^<]*)<\/a>/g;

async function fetchPage(cid, page) {
  const url = new URL(LIST_URL);
  for (const [k, v] of Object.entries(BASE_PARAMS)) url.searchParams.set(k, v);
  url.searchParams.set("cid", cid);
  url.searchParams.set("curPage", String(page));
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function parseItems(html) {
  const items = [];
  for (const m of html.matchAll(ITEM_RE)) {
    const [, bbsCd, bbsSeq, rawTitle, analyst, rawDate, category, rawBody] = m;
    const title = stripHtml(rawTitle);
    const date = isoDate(rawDate);
    if (!date) continue;
    const market = classifyMarket(`${title} ${stripHtml(rawBody)}`);
    if (!market) continue;
    items.push({
      id: `${bbsCd}_${bbsSeq}`,
      date,
      title,
      stockName: category.trim(), // 업종/전략 라벨(예: "글로벌 산업분석")
      analyst: analyst.trim(),
      market,
      summary: excerpt(stripHtml(rawBody)),
      pdfUrl: `https://www.hanaw.com/main/research/research/download.cmd?bbsSeq=${bbsSeq}&attachFileSeq=1&bbsId=&dbType=&bbsCd=${bbsCd}`,
    });
  }
  return items;
}

console.log(`▶ 하나증권 글로벌 산업분석/투자전략 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지 × ${BOARDS.length}개 게시판`);

const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));
const collected = [];

for (const board of BOARDS) {
  let stop = false;
  for (let page = 1; page <= MAX_PAGES && !stop; page++) {
    const html = await fetchPage(board.cid, page);
    const items = parseItems(html);
    // classifyMarket 필터 때문에 items.length===0 이 "더 이상 페이지 없음"과
    // "이 페이지엔 미국 얘기가 하나도 없음"을 구분 못 함 — 원본 항목 수(필터
    // 전)로 페이지 끝을 판정해야 하므로 별도로 다시 센다.
    const rawCount = [...html.matchAll(ITEM_RE)].length;
    if (rawCount === 0) break;
    for (const it of items) collected.push(it);
    // 페이지 끝 판정은 날짜 컷오프로 — 원본(필터 전) 항목 중 가장 오래된 걸 기준.
    const rawDates = [...html.matchAll(ITEM_RE)]
      .map((m) => isoDate(m[5]))
      .filter(Boolean);
    if (rawDates.length && new Date(Math.min(...rawDates.map((d) => new Date(d).getTime()))) < cutoff) {
      stop = true;
    }
    await sleep(400); // 예의상 간격
  }
}

if (collected.length === 0) {
  console.log("○ 최근 기간 내 미국/글로벌 산업분석·투자전략 리포트 없음(필터 통과 0건).");
  process.exit(0);
}

// 컷오프 이후 날짜만 최종 필터(위 루프는 페이지 단위로만 끊었으므로).
const final = collected.filter((it) => new Date(it.date) >= cutoff);

console.log(`✔ 파싱 완료: ${final.length}건`);
console.log(
  "  최근 3건:",
  final.slice(0, 3).map((i) => `${i.date} [${i.stockName}] ${i.title}`),
);

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

// market 이 종목별로 다를 수 있어(현재는 전부 "us") 그룹핑해서 보낸다 —
// 라우트가 요청 하나당 market 하나만 받으므로.
const byMarket = new Map();
for (const it of final) {
  const key = it.market;
  if (!byMarket.has(key)) byMarket.set(key, []);
  byMarket.get(key).push(it);
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

for (const [market, group] of byMarket) {
  const payload = group.map((it) => ({
    id: it.id,
    date: it.date,
    title: it.title,
    stockName: it.stockName,
    symbol: null,
    analyst: it.analyst,
    opinion: "",
    targetPrice: null,
    summary: it.summary,
    pdfUrl: it.pdfUrl,
    views: null,
    category: "산업",
  }));
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items: payload, source: "하나증권", market }),
  });
  const upBody = await up.text();
  if (!up.ok) {
    console.error(`✗ 앱 전송 실패(market=${market}) HTTP ${up.status}: ${upBody.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`\n✔ 앱 전송 완료(market=${market}, ${payload.length}건): ${upBody}`);
}
