/**
 * PIMCO 인사이트(`/us/en/insights/*`) 수집기 — 해외 IB/자산운용사 리서치
 * 5곳 조사(2026-09-19, CLAUDE.md 참고) 중 마지막으로 구축, 이걸로 5곳 모두
 * 완료. 제시받은 홈페이지(`/us/en`)는 큐레이션된 카드 몇 개뿐이고 전체
 * 목록은 Coveo 검색 위젯 뒤에 있는데, 앞선 세 곳과 동일하게 **사이트맵**
 * (`robots.txt`의 `Sitemap: /sitemap_index.xml` → 국가별 자식, `/us/en/
 * sitemap.xml`)으로 대체(실측 확인 — 최신 항목이 전날짜까지 잡힘, 하루
 * 2건 안팎으로 갱신). `/insights/podcasts/` 하위(오디오 에피소드)는
 * 제외 — 텍스트 요약이 없어 다른 소스들의 "PDF/영상 대신 텍스트 있는
 * 것만" 원칙과 동일.
 *
 * 개별 글 페이지: `<meta property="og:title">`(" | PIMCO" 접미사 제거)로
 * 제목, `<meta property="og:description">`로 요약(이미 잘 다듬어진 1~2문장
 * — 모간스탠리와 같은 품질). **날짜는 사이트맵 lastmod을 그대로 씀** —
 * 이 사이트는 본문에 datePublished 류 메타가 없고(실측 확인), 대신
 * lastmod 자체가 날짜 단위(시각 없음)로 기사 수만큼 세밀하게 찍혀 있어
 * 앞선 세 곳과 달리 편집일이 아니라 사실상 발행일로 봐도 무방(실측 —
 * 기사마다 값이 다르고 최신 항목이 실제 최근 뉴스 이슈와 일치).
 *
 * 종목 얘기가 아닌 채권/매크로 테마 콘텐츠라 `category:"산업"`(symbol
 * 항상 null), `market:"us"`. 번역 안 함(영문 원문 그대로, 앞선 세 수집기와
 * 동일 선례).
 *
 * robots.txt: `User-agent: *` 전체 허용, 별도 Disallow 없음(오너 승인,
 * 2026-09-19 — CLAUDE.md 참고).
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-pimco-research.mjs
 *   node scripts/collect-pimco-research.mjs --days=14 --max=15 --dry-run
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

const SITEMAP = "https://www.pimco.com/us/en/sitemap.xml";
const INSIGHT_PATH_RE = /\/us\/en\/insights\/(?!$)/;
const PODCAST_RE = /\/insights\/podcasts\//;

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

console.log("▶ PIMCO 인사이트 수집: 사이트맵에서 최근 URL 찾는 중...");

const sitemapXml = await fetchText(SITEMAP);
const cutoff = new Date(Date.now() - DAYS * 86_400_000);
const re = /<loc>([^<]*)<\/loc>\s*<lastmod>([^<]*)<\/lastmod>/g;
let m;
const candidates = [];
while ((m = re.exec(sitemapXml))) {
  if (INSIGHT_PATH_RE.test(m[1]) && !PODCAST_RE.test(m[1]) && new Date(m[2]) >= cutoff) {
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

    const title = decodeEntities(titleM[1].replace(/\s*\|\s*PIMCO\s*$/, ""));

    items.push({
      id: url.split("/us/en/insights/")[1] ?? url,
      date: lastmod.slice(0, 10),
      title,
      stockName: "글로벌 인사이트",
      symbol: null,
      analyst: "PIMCO",
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
  body: JSON.stringify({ items, source: "PIMCO", market: "us" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
