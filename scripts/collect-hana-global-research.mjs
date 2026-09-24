/**
 * 하나증권 "글로벌 기업분석" 게시판 수집기 (미국 종목).
 *
 * 국내 기업분석 수집기(collect-hana-research.mjs)와 같은 사이트·같은 목록
 * 구조인데 게시판만 다르다(pid=8&cid=3). 오너가 미국 종목 리서치가 비어
 * 있다고 지적해 추가(2026-09).
 *
 * 제목이 "종목명(TICKER.거래소): 제목" 형식이고 거래소가 .US/.SH/.HK/.FP 로
 * 섞여 있어 .US 만 골라 미국 종목으로 저장한다(실측: AVGO.US, GEV.US,
 * SNOW.US, PONY.US / 600183.SH, 0992.HK, NEX.FP).
 *
 * 투자의견·목표주가는 제목에 없어 본문 → PDF 순으로 추출한다
 * (scripts/lib/us-research-extract.mjs — 달러 표기 대응).
 *
 * ⚠️ 접근 조건은 국내 수집기와 동일(CLAUDE.md 하나증권 항목): robots.txt 가
 *    Disallow: / 라 개인용·로컬 실행·하루 1회 조건으로 오너 승인.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-hana-global-research.mjs
 *   node scripts/collect-hana-global-research.mjs --days=14 --dry-run
 */

import { readFileSync } from "node:fs";
import { enrichUsResearch } from "./lib/us-research-extract.mjs";

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
// pid=3&cid=2 = 산업/기업 > 기업분석 게시판.
const BASE_PARAMS = { pid: "8", cid: "3", srchTitle: "", srchWord: "", startDate: "1900-01-01", endDate: "9999-12-31" };

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

// 제목 형식: "종목명(TICKER.US): 나머지 제목". 국내 게시판과 달리 투자의견이
// 제목에 없다. .US 가 아닌 항목(중국·홍콩·유럽)은 건너뛴다.
const TITLE_RE = /^(.+?)\(([A-Za-z0-9.-]{1,10})\.US\)\s*:\s*(.+)$/;

async function fetchPage(page) {
  const url = new URL(LIST_URL);
  for (const [k, v] of Object.entries(BASE_PARAMS)) url.searchParams.set(k, v);
  url.searchParams.set("curPage", String(page));
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// 각 리포트 항목의 제목 앵커를 앵커로 삼아 뒤따르는 날짜·본문·PDF 링크를 뽑는다.
const ITEM_RE =
  /<a href="#" class="more_btn title" title="더보기" id="(\d+)_(\d+)">([^<]+)<\/a>[\s\S]{0,80}?<li class="mb7 m-info info">[\s\S]*?<span class="txtbasic">([\d.]+)<\/span>[\s\S]{0,400}?<li class="mb7 j_bbsContn[^"]*">([\s\S]*?)<\/li>[\s\S]{0,600}?class="j_fileLink"[^>]*>([^<]*)<\/a>/g;

/**
 * 목록에서 뽑은 항목. `rawRows` 는 **미국 필터를 걸기 전** 행 수다 — 0건일 때
 * "페이지 구조가 바뀐 것"과 "최근에 미국 종목 리포트가 없는 것"을 구분하려면
 * 이 값이 필요하다(오너 지적 2026-09-17: 6회 연속 빨간불이었는데 실제로는
 * 최근 3일치가 홍콩·중국·유럽 종목뿐이라 정상이었다).
 */
function parseItems(html) {
  const items = [];
  let rawRows = 0;
  for (const m of html.matchAll(ITEM_RE)) {
    rawRows += 1;
    const [, bbsCd, bbsSeq, rawTitle, rawDate, rawBody] = m;
    const title = stripHtml(rawTitle);
    const date = isoDate(rawDate);
    if (!date) continue;
    const tm = title.match(TITLE_RE);
    if (!tm) continue; // .US 아닌 종목(중국·홍콩·유럽) 또는 종목 없는 리포트
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
    });
  }
  return { items, rawRows };
}

console.log(`▶ 하나증권 기업분석 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);

// 항목 날짜가 'YYYY-MM-DD'(=UTC 자정)라 컷오프도 자정으로 맞춘다.
// Date.now() 기준 그대로 두면 '정확히 DAYS일 전' 리포트가 시:분 차이로
// 매번 잘려나간다(실측 2026-09: 미래에셋 최신 리포트가 3시간 차이로 탈락).
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));
const collected = [];
let stop = false;
let totalRows = 0;

for (let page = 1; page <= MAX_PAGES && !stop; page++) {
  const html = await fetchPage(page);
  const { items, rawRows } = parseItems(html);
  totalRows += rawRows;
  if (rawRows === 0) break;
  if (items.length === 0) continue; // 이 페이지엔 미국 종목이 없을 뿐
  for (const it of items) {
    if (new Date(it.date) < cutoff) {
      stop = true;
      break;
    }
    collected.push(it);
  }
  await sleep(400); // 예의상 간격
}

if (collected.length === 0) {
  if (totalRows > 0) {
    // 목록은 멀쩡히 읽혔는데 조건에 맞는 게 없었을 뿐 — 실패가 아니다.
    console.log(
      `· 최근 ${DAYS}일 안에 미국(.US) 종목 리포트가 없습니다 (목록 ${totalRows}건 정상 조회).`,
    );
    process.exit(0);
  }
  console.error("✗ 목록에서 항목을 하나도 못 읽었습니다. 페이지 구조가 바뀌었을 수 있음(정규식 재확인 필요).");
  process.exit(1);
}

console.log(`✔ 파싱 완료: ${collected.length}건`);
console.log(
  "  최근 3건:",
  collected.slice(0, 3).map((i) => `${i.date} ${i.stockName}(${i.symbolHint}) — ${i.title}`),
);


await enrichUsResearch(collected);

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

// analyst 필드는 이 정규식에서 안정적으로 못 뽑아 빈 값으로 보냄(제목·요약·PDF가
// 핵심이라 우선순위 낮음) — /api/cron/shinhan-research 는 analyst 없어도 저장됨.
// symbol 은 제목에서 이미 뽑은 6자리 코드를 그대로 넘겨 서버의 이름 검색을 건너뛴다.
const items = collected.map((it) => ({
  id: it.id,
  date: it.date,
  title: it.title,
  stockName: it.stockName,
  symbol: it.symbolHint,
  analyst: "",
  opinion: it.opinion,
  targetPrice: it.targetPrice,
  summary: it.summary,
  pdfUrl: it.pdfUrl,
  views: null,
}));

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;
const up = await fetch(IMPORT_URL, {
  method: "POST",
  headers,
  body: JSON.stringify({ items, source: "하나증권", market: "us" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
