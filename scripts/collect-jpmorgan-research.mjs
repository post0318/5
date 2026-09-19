/**
 * JP모간 글로벌 리서치(`/insights/global-research/*`) 수집기 — 해외 IB/
 * 자산운용사 리서치 5곳 조사(2026-09-19, CLAUDE.md 참고) 중 골드만삭스와
 * 같은 방식으로 구축. 목록 페이지(`/insights/global-research`)는 히어로
 * 1개만 서버렌더에 있고 "Latest research" 구간은 JS 지연 로드라 정적
 * fetch로는 목록이 안 나오는데, 골드만삭스와 동일하게 **사이트맵**
 * (`/sitemap.xml`→국가별 자식 사이트맵, robots.txt에 `Allow: /sitemap.xml`
 * 명시)에 개별 글이 `<lastmod>`와 함께 있어 이걸로 대체(실측 확인 — 최신
 * 항목이 전날짜까지 잡힘). 미국 사이트맵(`/US/en/sitemap.xml`) 기준
 * `/insights/global-research/` 경로만 필터.
 *
 * **"해외리서치" 이관 후 인사이트로 원복(오너 지시, 2026-09-19 — "jpm은
 * 해외리서치로 싹다옮겼네 내가 원한건 그게 아닌데.. 인사이트로 다시
 * 옮겨라")**: 한때 전량을 `source: "J.P. Morgan Research"`
 * (`FOREIGN_RESEARCH_SOURCES`)로 산업분석 탭 "해외리서치" 세그먼트로
 * 보냈었는데, 오너가 원한 건 그게 아니었음 — 다시 `source: "J.P. Morgan"`
 * (`INSIGHT_SOURCES`)으로 되돌려 인사이트 탭으로 복귀.
 *
 * 개별 글 페이지는 서버렌더 HTML — `<h1>`에 실제 헤드라인(`<title>` 태그는
 * "... | J.P. Morgan" 접미사가 붙어 지저분함), `<meta name="description">`
 * 에 2~3문장 요약이 이미 있어(골드만삭스와 달리 nav 텍스트 필터링 불필요)
 * 발췌 로직이 더 간단하다. `<meta name="publishDate">`가 "September 15,
 * 2026" 형식 발행일을 준다(사이트맵 lastmod보다 정확 — 실측: 같은 글에서
 * lastmod 은 9/17(편집일), publishDate 는 9/15(실제 발행일)로 다름).
 *
 * 종목 얘기가 아닌 매크로/업종 테마 콘텐츠라 `category:"산업"`(symbol 항상
 * null), `market:"us"`. 번역 안 함(영문 원문 그대로, 앞선 두 수집기와 동일
 * 선례).
 *
 * robots.txt: `User-agent: *` 기준 /insights 차단 없음(오너 승인,
 * 2026-09-19 — CLAUDE.md 참고).
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-jpmorgan-research.mjs
 *   node scripts/collect-jpmorgan-research.mjs --days=14 --max=15 --dry-run
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

const SITEMAP = "https://www.jpmorgan.com/US/en/sitemap.xml";
const INSIGHT_PATH_RE = /\/insights\/global-research\//;

function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&ndash;|&mdash;/g, "-")
    .trim();
}

const MONTHS = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};
function parsePublishDate(s) {
  // "September 15, 2026" -> "2026-09-15"
  const m = String(s ?? "").trim().match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (!m) return null;
  const mm = MONTHS[m[1].toLowerCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${String(m[2]).padStart(2, "0")}`;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

console.log("▶ JP모간 글로벌 리서치 수집: 사이트맵에서 최근 URL 찾는 중...");

const sitemapXml = await fetchText(SITEMAP);
const cutoff = new Date(Date.now() - DAYS * 86_400_000);
const re = /<loc>([^<]*)<\/loc>\s*<lastmod>([^<]*)<\/lastmod>/g;
let m;
const candidates = [];
while ((m = re.exec(sitemapXml))) {
  if (INSIGHT_PATH_RE.test(m[1]) && new Date(m[2]) >= cutoff) {
    candidates.push({ url: m[1], lastmod: m[2] });
  }
}
candidates.sort((a, b) => b.lastmod.localeCompare(a.lastmod));
const targets = candidates.slice(0, MAX_ITEMS);

console.log(`✔ 최근 ${DAYS}일 후보 ${candidates.length}건 중 ${targets.length}건 처리`);

const items = [];
for (const { url } of targets) {
  try {
    const html = await fetchText(url);
    const h1M = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    const titleTagM = html.match(/<title>([^<]*)<\/title>/);
    const descM = html.match(/<meta name="description" content="([^"]*)"/);
    const publishM = html.match(/<meta name="publishDate" content="([^"]*)"/);

    const title = decodeEntities(
      (h1M ? h1M[1].replace(/<[^>]+>/g, "") : titleTagM?.[1]?.replace(/\s*\|\s*J\.P\. Morgan\s*$/, "")) ?? "",
    );
    const date = parsePublishDate(publishM?.[1]);
    if (!title || !date) continue;

    items.push({
      id: url.split("/insights/global-research/")[1] ?? url,
      date,
      title,
      stockName: "글로벌 인사이트",
      symbol: null,
      analyst: "J.P. Morgan",
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
  body: JSON.stringify({ items, source: "J.P. Morgan", market: "us" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
