/**
 * Citigroup Insights(`www.citigroup.com/global/insights/*`) 수집기 — 해외
 * IB/자산운용사 리서치 2차 조사(2026-09-19, CLAUDE.md 참고) 중 구축 가능
 * 확인된 3곳 중 하나. 골드만삭스·JP모간·모간스탠리와 동일하게 **사이트맵**
 * (`/global/sitemap.xml`)에 개별 인사이트 URL이 `<lastmod>`와 함께 있어
 * 이걸로 최신순 추림(실측 — insights 하위만 1,800개, 최신 항목이 전날짜
 * 까지 잡힘).
 *
 * `/insights/` 경로에 Citi GPS류 정통 리서치뿐 아니라 지점 개소식·행사
 * 안내 같은 PR성 콘텐츠도 섞여 있어(실측 — "eucalyptus-grove-grand-
 * opening-event", "valley-vista-groundbreaking-event" 등) 제목에 흔한
 * 행사 키워드가 있으면 건너뛴다(완전하지 않음, 다른 소스들과 동일한
 * 트레이드오프).
 *
 * 개별 글 페이지: `<meta property="og:title">`·`<meta property="og:
 * description">` 둘 다 품질 좋은 요약을 그대로 준다(실측 확인). 발행일은
 * 사이트맵 lastmod을 그대로 씀(본문에 별도 발행일 메타가 없음, 다른 여러
 * 소스와 동일한 상황).
 *
 * 종목 얘기가 아닌 매크로/업종 테마 콘텐츠라 `category:"산업"`(symbol 항상
 * null), `market:"us"`. 번역 안 함.
 *
 * robots.txt: `User-agent: *` 기준 `/login`·`/citi/`만 차단, `/insights`는
 * 안 막힘(오너 승인 조건과 동일 — CLAUDE.md 참고).
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-citigroup-research.mjs
 *   node scripts/collect-citigroup-research.mjs --days=14 --max=15 --dry-run
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

const SITEMAP = "https://www.citigroup.com/global/sitemap.xml";
const INSIGHT_PATH_RE = /\/global\/insights\//;
// PR성 행사 안내 제외(실측) — 정통 리서치 아님.
const EVENT_NOISE_RE = /grand-opening|groundbreaking|ribbon-cutting|anniversary-celebration/i;

function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&quot;/g, '"')
    .replace(/&ndash;|&mdash;/g, "-")
    .trim();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

console.log("▶ Citigroup Insights 수집: 사이트맵에서 최근 URL 찾는 중...");

const sitemapXml = await fetchText(SITEMAP);
const cutoff = new Date(Date.now() - DAYS * 86_400_000);
const re = /<url>\s*<loc>([^<]*)<\/loc>\s*<lastmod>([^<]*)<\/lastmod>/g;
let m;
const candidates = [];
while ((m = re.exec(sitemapXml))) {
  if (INSIGHT_PATH_RE.test(m[1]) && !EVENT_NOISE_RE.test(m[1]) && new Date(m[2]) >= cutoff) {
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

    const title = decodeEntities(titleM[1]);

    items.push({
      id: url.split("/insights/")[1] ?? url,
      date: lastmod.slice(0, 10),
      title,
      stockName: "글로벌 인사이트",
      symbol: null,
      analyst: "Citigroup",
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
  body: JSON.stringify({ items, source: "Citigroup", market: "us" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
