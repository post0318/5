/**
 * 모간스탠리 인사이트(`/insights/articles/*`) 수집기 — 해외 IB/자산운용사
 * 리서치 5곳 조사(2026-09-19, CLAUDE.md 참고) 중 골드만삭스·JP모간과 같은
 * 방식으로 구축. 제시받은 목록 페이지(`/insights/topics/investing`)는 실제
 * 기사 링크가 1개뿐인 토픽 허브라 골드만삭스·JP모간과 동일하게 **사이트맵**
 * (`/sitemap.xml`, robots.txt가 AI 크롤러까지 전부 허용하는 가장 깨끗한
 * 케이스)으로 대체. 다른 두 곳과 달리 국가별로 안 나뉜 단일 평면 사이트맵
 * (4,526개 URL)이라 자식 사이트맵을 따라갈 필요가 없다.
 *
 * `/insights/articles/` 경로엔 기관 리서치성 콘텐츠(예: "Can Stocks Keep
 * Defying Higher Rates?")와 일반 개인 재무 가이드성 콘텐츠(예: "What Is a
 * Financial Plan?")가 섞여 있음(실측 확인) — 이 프로젝트의 다른 "산업분석"
 * 소스들도 완벽한 필터링 없이 폭넓게 수집하는 기존 트레이드오프와 동일하게
 * 별도 주제 필터 없이 그대로 수집한다.
 *
 * 개별 글 페이지: `<meta property="og:title">`(" | Morgan Stanley" 접미사
 * 제거 필요)로 제목, `<meta property="og:description">`로 요약(다른
 * 두 곳보다 품질 좋음 — 이미 다듬어진 한 문장), `<meta name="content_
 * publishedAt">`(ISO 8601)로 정확한 발행일. JSON-LD datePublished 는 이
 * 사이트에 없음(실측 확인) — 사이트마다 발행일 메타 필드 위치가 다 달라
 * 골드만삭스(JSON-LD)·JP모간(publishDate 메타)·모간스탠리(content_
 * publishedAt 메타) 세 곳이 전부 다른 방식.
 *
 * 종목 얘기가 아닌 매크로/업종 테마 콘텐츠라 `category:"산업"`(symbol 항상
 * null), `market:"us"`. 번역 안 함(영문 원문 그대로, 앞선 두 수집기와 동일
 * 선례).
 *
 * robots.txt: AI 크롤러(`ClaudeBot`/`anthropic-ai`/`GPTBot` 등)까지 전부
 * `Allow: /` — 5곳 중 가장 깨끗한 케이스(오너 승인, 2026-09-19).
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-morganstanley-research.mjs
 *   node scripts/collect-morganstanley-research.mjs --days=14 --max=15 --dry-run
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

const SITEMAP = "https://www.morganstanley.com/sitemap.xml";
const INSIGHT_PATH_RE = /\/insights\/articles\//;

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

console.log("▶ 모간스탠리 인사이트 수집: 사이트맵에서 최근 URL 찾는 중...");

const sitemapXml = await fetchText(SITEMAP);
const cutoff = new Date(Date.now() - DAYS * 86_400_000);
const re = /<loc>([^<]*)<\/loc><lastmod>([^<]*)<\/lastmod>/g;
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
    const titleM = html.match(/<meta property="og:title" content="([^"]*)"/);
    const descM = html.match(/<meta property="og:description" content="([^"]*)"/);
    const dateM = html.match(/<meta name="content_publishedAt" content="([^"]*)"/);
    if (!titleM || !dateM) continue;

    const title = decodeEntities(titleM[1].replace(/\s*\|\s*Morgan Stanley\s*$/, ""));
    const date = dateM[1].slice(0, 10);

    items.push({
      id: url.split("/insights/articles/")[1] ?? url,
      date,
      title,
      stockName: "글로벌 인사이트",
      symbol: null,
      analyst: "Morgan Stanley",
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
  body: JSON.stringify({ items, source: "Morgan Stanley", market: "us" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
