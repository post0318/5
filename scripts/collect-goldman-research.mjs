/**
 * 골드만삭스 인사이트 수집기 — 해외 IB/자산운용사 리서치 5곳 조사(2026-09-19,
 * CLAUDE.md 참고) 중 블랙록 다음으로 구축. 목록 페이지(`/insights/
 * goldman-sachs-research`) 자체는 Algolia 검색(앱ID·검색키가 페이지에
 * 노출되나 인덱스명을 못 찾음)이 그려서 정적 fetch로는 카드가 안 나오는데,
 * **사이트맵(`/sitemap.xml` → `/sitemap-1.xml`, robots.txt에 명시)에 개별
 * 인사이트 URL이 `<lastmod>`와 함께 전부 들어있어** 이걸로 대체(실측 확인).
 *
 * **경로별 분류(오너 지시, 2026-09-19)**: `/insights/` 하위 실측 결과 7개
 * 경로가 있음 — articles(554)·goldman-sachs-research(169)·top-of-mind(64)·
 * the-markets(158, 팟캐스트)·goldman-sachs-exchanges(467, 팟캐스트)·
 * videos(82)·talks-at-gs(611, 영상). 오너 결정("video는 제외다", "정리하면
 * 2개는 제외 3개는 인사이트 1개는 산업분석이다"):
 *   - **제외(수집 안 함)**: videos, talks-at-gs — 영상 콘텐츠 2종.
 *   - **인사이트 탭**(`source: "Goldman Sachs"`, `INSIGHT_SOURCES`에 포함
 *     → `/[market]/insights`): articles, top-of-mind, the-markets,
 *     goldman-sachs-exchanges — 팟캐스트 2종도 og:title/datePublished
 *     메타는 있어(실측 확인) 텍스트 요약 없이도 제목·링크로 수집.
 *   - **산업분석 탭 "해외리서치" 세그먼트**(`source: "Goldman Sachs
 *     Research"`, `FOREIGN_RESEARCH_SOURCES` → `/[market]/research`):
 *     goldman-sachs-research만 — 리서치 노트라 국내 산업분석과 같은 자리에
 *     둔다는 오너 판단("goldman-sachs-research는 산업분석으로 이동"). 다른
 *     4종과 달리 **백필·보존기간 180일**(오너 지시 — "여기만 백필기간을
 *     180일로", `shinhan-research.ts`의 `FOREIGN_RESEARCH_MAX_AGE_MS`).
 *     라우트(`/api/cron/shinhan-research`)는 POST 1회당 source 하나만
 *     받으므로 두 그룹을 나눠 두 번 전송한다(한경 컨센서스 수집기와 동일
 *     패턴 — "항목별 실제 출처로 그룹핑해 나눠 전송").
 *
 * 개별 글 페이지는 서버렌더 HTML — `<meta property="og:title">`로 제목,
 * JSON-LD `"datePublished"`로 정확한 발행일을 얻는다(사이트맵 lastmod은
 * 참고용, 본문의 datePublished가 더 정확). 목록/메타에 요약문이 따로 없어
 * (og:description이 title과 동일) 본문 첫 문단을 발췌한다 — 페이지에 숨겨진
 * 메가메뉴 nav 텍스트("What We Do"/"Insights"/"Our Firm"/"Careers"로
 * 시작하는 문단들)가 실제 본문보다 먼저 나와 이 프리픽스로 걸러낸다.
 * 팟캐스트형(top-of-mind 일부·the-markets·goldman-sachs-exchanges)은 본문이
 * "Subscribe:..." 같은 UI 텍스트뿐이라 요약이 비어있을 수 있음(정상 — 제목·
 * 링크만으로도 가치 있다고 판단, 빈 문자열로 폴백).
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
// 해외리서치(goldman-sachs-research)만 180일 고정(오너 지시) — --days 와 무관.
const RESEARCH_DAYS = 180;

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://macroresearch.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SITEMAP_INDEX = "https://www.goldmansachs.com/sitemap.xml";
const RESEARCH_PATH_RE = /\/insights\/goldman-sachs-research\//;
const INSIGHT_PATH_RE = /\/insights\/(articles|top-of-mind|the-markets|goldman-sachs-exchanges)\//;
const NAV_JUNK_RE =
  /^(What We Do|Insights|Our Firm|Careers|Sustainability|Newsroom|Client Solutions|Sign In|Subscribe|Related Tags|You can unsubscribe|For information about how your personal data)/;

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

async function parseItem(url) {
  const html = await fetchText(url);
  const titleM = html.match(/<meta property="og:title" content="([^"]*)"/);
  const dateM = html.match(/"datePublished":"(\d{4}-\d{2}-\d{2})/);
  if (!titleM || !dateM) return null;
  const title = decodeEntities(titleM[1]);
  const date = dateM[1];

  const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
    .map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, "")))
    .filter((t) => t.length > 60 && !NAV_JUNK_RE.test(t));
  const summary = (paras[0] ?? "").slice(0, 300);

  const slug = url.split("/insights/")[1] ?? url;
  return {
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
  };
}

async function sendBatch(items, source) {
  if (items.length === 0) return;
  if (DRY_RUN) {
    console.log(`\n--dry-run: ${source} ${items.length}건 전송 생략`);
    return;
  }
  const headers = { "Content-Type": "application/json" };
  if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
  else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items, source, market: "us" }),
  });
  const upBody = await up.text();
  if (!up.ok) {
    console.error(`✗ ${source} 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`✔ ${source} 전송 완료: ${upBody}`);
}

console.log("▶ 골드만삭스 인사이트 수집: 사이트맵에서 최근 URL 찾는 중...");

const sitemapIndexXml = await fetchText(SITEMAP_INDEX);
const childSitemaps = [...sitemapIndexXml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);

const insightCutoff = new Date(Date.now() - DAYS * 86_400_000);
const researchCutoff = new Date(Date.now() - RESEARCH_DAYS * 86_400_000);
const insightCandidates = [];
const researchCandidates = [];
for (const sm of childSitemaps) {
  const xml = await fetchText(sm);
  const re = /<loc>([^<]*)<\/loc>\s*<lastmod>([^<]*)<\/lastmod>/g;
  let m;
  while ((m = re.exec(xml))) {
    const [, url, lastmod] = m;
    if (RESEARCH_PATH_RE.test(url)) {
      if (new Date(lastmod) >= researchCutoff) researchCandidates.push({ url, lastmod });
    } else if (INSIGHT_PATH_RE.test(url)) {
      if (new Date(lastmod) >= insightCutoff) insightCandidates.push({ url, lastmod });
    }
  }
}
insightCandidates.sort((a, b) => b.lastmod.localeCompare(a.lastmod));
researchCandidates.sort((a, b) => b.lastmod.localeCompare(a.lastmod));
const insightTargets = insightCandidates.slice(0, MAX_ITEMS);
const researchTargets = researchCandidates.slice(0, MAX_ITEMS);

console.log(
  `✔ 인사이트 후보 ${insightCandidates.length}건 중 ${insightTargets.length}건, ` +
    `해외리서치 후보 ${researchCandidates.length}건 중 ${researchTargets.length}건 처리`,
);

const insightItems = [];
for (const { url } of insightTargets) {
  try {
    const item = await parseItem(url);
    if (item) insightItems.push(item);
  } catch (err) {
    console.error(`  ✗ ${url}: ${err.message}`);
  }
  await sleep(300);
}
const researchItems = [];
for (const { url } of researchTargets) {
  try {
    const item = await parseItem(url);
    if (item) researchItems.push(item);
  } catch (err) {
    console.error(`  ✗ ${url}: ${err.message}`);
  }
  await sleep(300);
}

if (insightItems.length === 0 && researchItems.length === 0) {
  console.error("✗ 파싱 결과 0건. 사이트맵/페이지 구조가 바뀌었을 수 있음.");
  process.exit(1);
}

console.log(`✔ 파싱 완료: 인사이트 ${insightItems.length}건, 해외리서치 ${researchItems.length}건`);
console.log("  인사이트 최근 3건:", insightItems.slice(0, 3).map((i) => `${i.date} ${i.title}`));
console.log("  해외리서치 최근 3건:", researchItems.slice(0, 3).map((i) => `${i.date} ${i.title}`));

await sendBatch(insightItems, "Goldman Sachs");
await sendBatch(researchItems, "Goldman Sachs Research");
