/**
 * 미래에셋증권 "기업분석" 리포트 — 로컬 수집기.
 *
 * securities.miraeasset.com 도 레거시 frameset 사이트(실제 콘텐츠는
 * contentframe → main.do)지만, 목록 자체는 평범한 서버렌더링 HTML이라
 * 직접 GET으로 받아온다: `/bbs/board/message/list.do?categoryId=1800&curPage=N`
 * (categoryId=1800 은 "투자정보 > 리서치 리포트 > 기업분석" 메뉴의
 * `javascript:openHp('/bbs/board/message/list.do?categoryId=1800')` 링크를
 * 역추적해 확인). 로그인 불필요. `robots.txt` 에 `User-agent: Yeti\nAllow: /`
 * 만 있고 다른 UA에 대한 Disallow 규칙 자체가 없음(가장 깨끗한 케이스).
 *
 * 목록에 종목명·코드(또는 해외 티커)·투자의견·PDF 직링크가 모두 들어있다.
 * 제목 형식: "종목명 (코드/의견)" + <br/> + 부제. 미래에셋은 국내(6자리 코드)와
 * 해외(예: "IONQ US", "TTAN IN") 리포트가 같은 목록에 섞여 있어 6자리 숫자
 * 코드가 아닌 항목(해외종목)은 건너뛴다. PDF는 `downConfirm(...)` 첫 인자
 * URL을 로그인 없이 그대로 GET 가능(실측: `Content-Type: application/pdf`).
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-mirae-research.mjs
 *   node scripts/collect-mirae-research.mjs --days=14 --pages=10 --dry-run
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
const DAYS = Number(ARGS.find((a) => a.startsWith("--days="))?.split("=")[1]) || 14;
const MAX_PAGES = Number(ARGS.find((a) => a.startsWith("--pages="))?.split("=")[1]) || 10;

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim(); // 로컬 수동 실행 시 CRON_SECRET 없어도 인증 가능(라우트가 x-app-token도 허용)
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST_URL = "https://securities.miraeasset.com/bbs/board/message/list.do";
const CATEGORY_ID = "1800"; // 기업분석

// "종목명 (코드/의견)" — 코드가 6자리 숫자가 아니면(해외 티커) 건너뜀.
const TITLE_RE = /^(.+?)\s*\((\d{6})\/([^)]+)\)$/;

async function fetchPage(page) {
  const url = new URL(LIST_URL);
  url.searchParams.set("categoryId", CATEGORY_ID);
  url.searchParams.set("curPage", String(page));
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new TextDecoder("euc-kr").decode(await res.arrayBuffer());
}

function parseItems(html) {
  const items = [];
  for (const rowHtml of html.split(/<tr[^>]*>/).slice(1)) {
    const dateM = rowHtml.match(/<td\s*>\s*(\d{4}-\d{2}-\d{2})\s*<\/td>/);
    const subjectM = rowHtml.match(
      /<a href="javascript:view\('(\d+)','(\d+)'\)"[^>]*><b>([^<]+)<\/b><br\/>([^<]*)<\/a>/,
    );
    if (!dateM || !subjectM) continue;
    const [, id, , rawTitle, rawSummary] = subjectM;
    const tm = rawTitle.trim().match(TITLE_RE);
    if (!tm) continue; // 해외종목(코드가 6자리 숫자 아님) — 건너뜀
    const pdfM = rowHtml.match(/downConfirm\('(https:\/\/[^']+\.pdf\?attachmentId=\d+)'/);
    const analystM = rowHtml.match(/<\/p>\s*<\/td>\s*<td\s*>\s*([^<]+?)\s*<\/td>/);
    items.push({
      id,
      date: dateM[1],
      title: rawSummary.trim() || rawTitle.trim(),
      stockName: tm[1].trim(),
      symbolHint: tm[2],
      opinion: tm[3].trim(),
      analyst: analystM ? analystM[1].trim() : "",
      pdfUrl: pdfM ? pdfM[1] : null,
    });
  }
  return items;
}

console.log(`▶ 미래에셋증권 기업분석 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
const cutoff = new Date(Date.now() - DAYS * 86_400_000);
const collected = [];
let stop = false;
for (let page = 1; page <= MAX_PAGES && !stop; page++) {
  const html = await fetchPage(page);
  const items = parseItems(html);
  if (items.length === 0) break;
  for (const it of items) {
    if (new Date(it.date) < cutoff) {
      stop = true;
      break;
    }
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
  collected.slice(0, 5).map((i) => `${i.date} ${i.stockName}(${i.symbolHint}) — ${i.title}`),
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
  symbol: it.symbolHint,
  analyst: it.analyst,
  opinion: it.opinion,
  summary: "",
  pdfUrl: it.pdfUrl,
  views: null,
}));

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;
const up = await fetch(IMPORT_URL, {
  method: "POST",
  headers,
  body: JSON.stringify({ items, source: "미래에셋증권" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
