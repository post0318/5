/**
 * 골드만삭스 인사이트(`/insights/articles/*`, `/insights/goldman-sachs-research/*`,
 * `/insights/top-of-mind/*`) 수집기 — 해외 IB/자산운용사 리서치 5곳 조사
 * (2026-09-19, CLAUDE.md 참고) 중 블랙록 다음으로 구축. 목록 페이지
 * (`/insights/goldman-sachs-research`) 자체는 Algolia 검색(앱ID·검색키가
 * 페이지에 노출돼 있으나 인덱스명을 못 찾음)이 그려서 정적 fetch로는 카드가
 * 안 나오는데, **사이트맵(`/sitemap.xml` → `/sitemap-1.xml`, robots.txt에
 * 명시)에 개별 인사이트 URL이 `<lastmod>`와 함께 전부 들어있어** 이걸로
 * 대체(실측 확인 — 최신 항목이 실제 발행일과 거의 일치, 최근 것부터
 * 정렬 가능). 신한/하나 등 기존 "게시판 목록 API" 대신 "사이트맵 diff"로
 * 최신 글을 찾는 첫 사례.
 *
 * 개별 글 페이지는 서버렌더 HTML — `<meta property="og:title">`로 제목,
 * JSON-LD `"datePublished"`로 정확한 발행일을 얻는다(사이트맵 lastmod은
 * 참고용, 본문의 datePublished가 더 정확 — 실측: 최신 글에서 둘이 같은
 * 날짜였지만 오래된 글은 lastmod가 최근 편집일이라 발행일과 다를 수 있음).
 * 목록/메타에 요약문이 따로 없어(og:description이 title과 동일) 본문 첫
 * 문단을 발췌한다 — 페이지에 숨겨진 메가메뉴 nav 텍스트("What We Do"/
 * "Insights"/"Our Firm"/"Careers"로 시작하는 문단들)가 실제 본문보다 먼저
 * 나와 이 프리픽스로 걸러낸다(실측 — 필터 없이 쓰면 nav 텍스트가 그대로
 * 요약으로 저장됨). 팟캐스트형 Top of Mind 일부는 본문이 "Subscribe:..."
 * 같은 UI 텍스트뿐이라 요약 품질이 떨어질 수 있음(우선순위 낮아 보류).
 *
 * 종목 얘기가 아닌 매크로/업종 테마 콘텐츠라 `category:"산업"`(symbol 항상
 * null), `market:"us"`. 번역 안 함(영문 원문 그대로, 블랙록 수집기와 동일
 * 선례).
 *
 * robots.txt: `User-agent: *` 기준 /insights 차단 없음(GPTBot 전용 규칙은
 * /insights/top-of-mind/ 를 막지만 오너가 "5곳 모두 동일 조건으로 진행"
 * 결정, 2026-09-19 — CLAUDE.md 참고).
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-goldman-research.mjs
 *   node scripts/collect-goldman-research.mjs --days=14 --max=15 --dry-run
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

const SITEMAP_INDEX = "https://www.goldmansachs.com/sitemap.xml";
const INSIGHT_PATH_RE = /\/insights\/(articles|goldman-sachs-research|top-of-mind)\//;
const NAV_JUNK_RE =
  /^(What We Do|Insights|Our Firm|Careers|Sustainability|Newsroom|Client Solutions|Sign In|Subscribe|Related Tags|You can unsubscribe|For information about how your personal data)/;

function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&ndash;|&mdash;/g, "-")
    .trim();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

console.log("▶ 골드만삭스 인사이트 수집: 사이트맵에서 최근 URL 찾는 중...");

const sitemapIndexXml = await fetchText(SITEMAP_INDEX);
const childSitemaps = [...sitemapIndexXml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);

const cutoff = new Date(Date.now() - DAYS * 86_400_000);
const candidates = [];
for (const sm of childSitemaps) {
  const xml = await fetchText(sm);
  const re = /<loc>([^<]*)<\/loc>\s*<lastmod>([^<]*)<\/lastmod>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (INSIGHT_PATH_RE.test(m[1]) && new Date(m[2]) >= cutoff) {
      candidates.push({ url: m[1], lastmod: m[2] });
    }
  }
}
candidates.sort((a, b) => b.lastmod.localeCompare(a.lastmod));
const targets = candidates.slice(0, MAX_ITEMS);

console.log(`✔ 최근 ${DAYS}일 후보 ${candidates.length}건 중 ${targets.length}건 처리`);

const items = [];
for (const { url } of targets) {
  try {
    const html = await fetchText(url);
    const titleM = html.match(/<meta property="og:title" content="([^"]*)"/);
    const dateM = html.match(/"datePublished":"(\d{4}-\d{2}-\d{2})/);
    if (!titleM || !dateM) continue;
    const title = decodeEntities(titleM[1]);
    const date = dateM[1];

    const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
      .map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, "")))
      .filter((t) => t.length > 60 && !NAV_JUNK_RE.test(t));
    const summary = (paras[0] ?? "").slice(0, 300);

    const slug = url.split("/insights/")[1] ?? url;
    items.push({
      id: slug,
      date,
      title,
      stockName: "글로벌 인사이트",
      symbol: null,
      analyst: "Goldman Sachs Research",
      opinion: "",
      targetPrice: null,
      summary,
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
  body: JSON.stringify({ items, source: "Goldman Sachs", market: "us" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
