/**
 * HSBC Business Insights(`www.business.hsbc.com/en-gb/insights/*`) 수집기 —
 * 해외 IB/자산운용사 리서치 조사(2026-09-19, CLAUDE.md 참고)에서 처음
 * 확인했던 `gbm.hsbc.com`(HSBC Global Banking & Markets)은 공개 콘텐츠가
 * 79건뿐이고 최신 항목도 1년 가까이 정체돼 있어 보류했었는데, 오너가 실제
 * 살아있는 URL(`business.hsbc.com` — HSBC Commercial Banking)을 제시해
 * 재조사 후 구축. **사이트맵이 UTF-16LE(BOM 포함)로 인코딩**돼 있어(실측
 * 확인, 다른 소스는 전부 UTF-8) `res.arrayBuffer()`로 받아 직접 디코딩
 * 해야 한다 — 그대로 `res.text()`를 쓰면 깨짐. 골드만삭스·JP모간 등과
 * 동일하게 사이트맵의 `<lastmod>`로 최신순 추림(실측 — 362개 URL, 최신
 * 항목이 당일까지 잡힘).
 *
 * `/insights/` 경로에 거시경제·트레저리 분석 외에 고객사 도입 사례
 * ("...-streamline-collections-hsbc-dms", "...-implements-sap-multi-
 * bank-connectivity" 류, 실측)도 섞여 있어 제목에 흔한 사례 키워드가
 * 있으면 건너뛴다(완전하지 않음, Citigroup과 동일한 트레이드오프).
 *
 * 개별 글 페이지: `<meta property="og:title">`·`<meta property="og:
 * description">` 둘 다 품질 좋은 요약을 그대로 준다(실측 확인).
 *
 * 종목 얘기가 아닌 매크로/트레저리 테마 콘텐츠라 `category:"산업"`(symbol
 * 항상 null), `market:"us"`(다른 해외 소스와 같은 자리 — HSBC는 영국계지만
 * 이 프로젝트의 해외 리서치는 시장 구분 없이 전부 market:"us" 로 모아둠).
 * 번역 안 함.
 *
 * robots.txt: `User-agent: *` 기준 `/en-gb/cib-products/`·`/products-and-
 * solutions-2` 만 차단, `/insights`는 안 막힘(오너 승인 조건과 동일 —
 * CLAUDE.md 참고).
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-hsbc-research.mjs
 *   node scripts/collect-hsbc-research.mjs --days=14 --max=15 --dry-run
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
const MAX_ITEMS = Number(ARGS.find((a) => a.startsWith("--max="))?.split("=")[1]) || 15;

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SITEMAP = "https://www.business.hsbc.com/sitemap.xml";
const INSIGHT_PATH_RE = /\/en-gb\/insights\//;
// 고객사 도입 사례("~은 어떻게 HSBC로 …했다"류) 제외 — 실측으로 발견된
// 흔한 패턴만 걸러냄(완전하지 않음).
const CASE_STUDY_NOISE_RE = /streamline|implements-sap|multi-bank-connectivity|success-story|case-study/i;

async function fetchTextUtf16(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // UTF-16LE BOM(FF FE) 확인 — 없으면 평범한 UTF-8로 취급.
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString("utf16le");
  }
  return buf.toString("utf8");
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&quot;/g, '"')
    .replace(/&ndash;|&mdash;/g, "-")
    .trim();
}

console.log("▶ HSBC Business Insights 수집: 사이트맵에서 최근 URL 찾는 중...");

const sitemapText = await fetchTextUtf16(SITEMAP);
const cutoff = new Date(Date.now() - DAYS * 86_400_000);
const re = /<loc>([^<]*)<\/loc>\s*<lastmod>([^<]*)<\/lastmod>/g;
let m;
const candidates = [];
while ((m = re.exec(sitemapText))) {
  if (INSIGHT_PATH_RE.test(m[1]) && !CASE_STUDY_NOISE_RE.test(m[1]) && new Date(m[2]) >= cutoff) {
    candidates.push({ url: m[1], lastmod: m[2] });
  }
}
candidates.sort((a, b) => b.lastmod.localeCompare(a.lastmod));
const targets = candidates.slice(0, MAX_ITEMS);

console.log(`✔ 최근 ${DAYS}일 후보 ${candidates.length}건 중 ${targets.length}건 처리`);

const items = [];
for (const { url, lastmod } of targets) {
  try {
    const html = await fetchText(url);
    const titleM = html.match(/<meta property="og:title" content="([^"]*)"/);
    const descM = html.match(/<meta property="og:description" content="([^"]*)"/);
    if (!titleM) continue;

    items.push({
      id: url.split("/en-gb/insights/")[1] ?? url,
      date: lastmod.slice(0, 10),
      title: decodeEntities(titleM[1]),
      stockName: "글로벌 인사이트",
      symbol: null,
      analyst: "HSBC",
      opinion: "",
      targetPrice: null,
      summary: decodeEntities(descM?.[1] ?? "").slice(0, 300),
      pdfUrl: url,
      views: null,
      category: "산업",
    });
  } catch (err) {
    console.error(`  ✗ ${url}: ${err.message}`);
  }
  await sleep(300);
}

if (items.length === 0) {
  console.error("✗ 파싱 결과 0건. 사이트맵/페이지 구조가 바뀌었을 수 있음.");
  process.exit(1);
}

console.log(`✔ 파싱 완료: ${items.length}건`);
console.log("  최근 3건:", items.slice(0, 3).map((i) => `${i.date} ${i.title}`));

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;
const up = await fetch(IMPORT_URL, {
  method: "POST",
  headers,
  body: JSON.stringify({ items, source: "HSBC", market: "us" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
