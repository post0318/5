/**
 * 삼성증권 "해외기업/해외산업" 리서치 수집기 (미국 종목 + 글로벌 테마).
 *
 * 오너가 POP(www.samsungpop.com) "투자정보 > 해외주식 > 해외주식투자정보"
 * 화면을 제시해 확인(2026-09-24). 이 화면 자체는 레거시 frameset + XCMS
 * 메뉴 시스템(코드 → URL 매핑이 서버 세션에서 동적으로 채워지는 구조,
 * NH/미래에셋과 유사)이라 메뉴코드로는 콘텐츠 URL을 못 찾았지만, **모바일
 * 리포트 검색 화면**(`/mbw/invest/investInfo.do?cmd=report_search`)이 훨씬
 * 단순한 서버렌더 HTML이라 그 검색 폼을 그대로 GET 으로 호출한다:
 *
 *   GET /mbw/search/search.do?cmd=report_search&GUBUN={구분}&startDate=...
 *       &endDate=...&searchField=TITLE&range=A&periodType=1&moreCheck=N
 *
 * `GUBUN` 값 중 `company2`=해외기업, `industry2`=해외산업(둘 다 화면의
 * "리포트 구분" 드롭다운에서 확인) 두 개를 돈다. 응답에 최근 리포트가
 * 최대 30건(실측) 서버렌더 HTML로 그대로 들어있다 — 로그인 불필요.
 *
 * **PDF는 로그인 없이 받아진다(실측 확인)** — 모바일 화면의
 * `downloadPdf()` 함수 자체는 "로그인 후 이용 가능합니다" 확인창을 띄우는
 * 로그인 게이트 UI지만, 그 함수가 넘겨받는 `fileName` 값을 레거시 다운로드
 * 엔드포인트에 직접 넣으면(`common.do?cmd=down&saveKey=research.pdf&
 * fileName=...`) 오늘 날짜 파일도 그대로 200으로 받아진다 — UI만 로그인을
 * 요구할 뿐 엔드포인트 자체는 열려 있는 경우(다른 소스에서도 나온 패턴).
 *
 * 제목이 "(작성자) 종목명 (TICKER US): 헤드라인" 형식(작성자 접두어는 dd의
 * 세 번째 span과 중복이라 제거, 종목-티커 구분은 "TICKER.US"가 아니라
 * "TICKER US"로 공백 — 다른 증권사와 다름)이라 그 패턴에서 티커를 뽑는다.
 * 안 걸리는 항목(예: "글로벌 포트폴리오 전략(9월 4주 차)...", "글로벌 AI/SW:
 * ...")은 종목 얘기가 아닌 산업분석/투자전략 성격이라 `category:"산업"`으로
 * 수집(symbol 항상 null).
 *
 * www.samsungpop.com/robots.txt 는 `Allow: /`(제한 없음) — 가장 깨끗한
 * 케이스. 그래도 다른 예외들과 동일 조건(개인용·로컬 실행·저빈도)으로 진행.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-samsung-research.mjs
 *   node scripts/collect-samsung-research.mjs --days=30 --dry-run
 */

import { readFileSync } from "node:fs";
import { enrichUsResearch } from "./lib/us-research-extract.mjs";
import { isEtfOrEtpContent, isEsgContent } from "./lib/exclude-filters.mjs";
import { industryLabelAndHeadline } from "./lib/label-extract.mjs";

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
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://macroresearch.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST_URL = "https://www.samsungpop.com/mbw/search/search.do";
const PDF_BASE = "https://www.samsungpop.com/common.do";
// GUBUN → category("기업"이면 티커 패턴 기대, "산업"이면 애초에 종목 얘기가 아님)
const BOARDS = [
  { gubun: "company2", label: "해외기업" },
  { gubun: "industry2", label: "해외산업" },
];

const TITLE_RE = /^(.+?)\s*\(([A-Za-z0-9.-]{1,10})\s+US\)\s*:\s*(.+)$/;
const ITEM_RE =
  /downloadPdf\('([^']+)','(\d+)','(\d+)'\)[\s\S]*?<dt><strong>([^<]+)<\/strong><\/dt>[\s\S]*?<span>([\d-]+)&nbsp;[\d:]+<\/span>\s*<span>([^<]*)<\/span>\s*<span>([^<]*)<\/span>/g;

function ymdDot(d) {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

async function fetchBoard(gubun, startDate, endDate) {
  const url = new URL(LIST_URL);
  const params = {
    cmd: "report_search",
    startCount: "0",
    range: "A",
    startDate,
    endDate,
    writer: "",
    moreCheck: "N",
    GUBUN: gubun,
    searchField: "TITLE",
    periodType: "1",
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function parseItems(html, analystFallback) {
  const items = [];
  for (const m of html.matchAll(ITEM_RE)) {
    const [, fileName, , , rawTitle, date, , author] = m;
    // 제목 앞의 "(작성자)" 접두어는 dd의 세 번째 span(작성자)과 중복이라 제거.
    const title = rawTitle.replace(/^\([^)]+\)\s*/, "").trim();
    // ETF/ETP 리포트 제외(오너 지시 2026-09-24, 공용 필터) — "ETP Weekly
    // Insight"·"모두의 ETP Biweekly"·"오토콜러블 ETF" 등이 여기서 걸러진다.
    if (isEtfOrEtpContent(title)) continue;
    // ESG 공용 제외(오너 지시 2026-09-24 — "esg는 공통으로 제외처리").
    if (isEsgContent(title)) continue;
    const pdfUrl = `${PDF_BASE}?cmd=down&saveKey=research.pdf&fileName=${encodeURIComponent(fileName)}&contentType=application/pdf`;
    const tm = title.match(TITLE_RE);
    if (tm) {
      const [, stockName, ticker, headline] = tm;
      items.push({
        id: fileName,
        date,
        title: headline.trim(),
        stockName: stockName.trim(),
        symbol: ticker.toUpperCase(),
        analyst: author.trim() || analystFallback,
        opinion: "",
        targetPrice: null,
        summary: "",
        pdfUrl,
        views: null,
        category: "기업",
      });
    } else {
      const { label, headline } = industryLabelAndHeadline(title);
      items.push({
        id: fileName,
        date,
        title: headline,
        stockName: label,
        symbol: null,
        analyst: author.trim() || analystFallback,
        opinion: "",
        targetPrice: null,
        summary: "",
        pdfUrl,
        views: null,
        category: "산업",
      });
    }
  }
  return items;
}

console.log(`▶ 삼성증권 해외기업/해외산업 리포트 수집: 최근 ${DAYS}일`);
const now = new Date();
const startDate = ymdDot(new Date(now.getTime() - DAYS * 86_400_000));
const endDate = ymdDot(now);
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));

const collected = [];
for (const board of BOARDS) {
  const html = await fetchBoard(board.gubun, startDate, endDate);
  const items = parseItems(html, "");
  for (const it of items) {
    if (new Date(it.date) < cutoff) continue;
    collected.push(it);
  }
  await sleep(400);
}

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. 페이지 구조가 바뀌었을 수 있음.");
  process.exit(1);
}
console.log(`✔ 파싱 완료: ${collected.length}건`);
console.log(
  "  최근 5건:",
  collected.slice(0, 5).map((i) => `${i.date} ${i.symbol ?? "(산업)"} — ${i.title}`),
);

console.log(`▶ 투자의견/목표주가 조회 중 (PDF 포함, 로그인 불필요) — ${collected.length}건...`);
await enrichUsResearch(collected.filter((it) => it.category !== "산업"), { sleepMs: 400, usePdf: true });
console.log(
  "  예시:",
  collected[0] && `${collected[0].opinion || "(없음)"} / ${collected[0].targetPrice ?? "(없음)"}`,
);

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const items = collected.map((it) => ({
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
}));

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;
const up = await fetch(IMPORT_URL, {
  method: "POST",
  headers,
  body: JSON.stringify({ items, source: "삼성증권", market: "us" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
