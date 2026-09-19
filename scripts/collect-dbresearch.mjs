/**
 * Deutsche Bank Research(`dbresearch.com`) 수집기 — 오너가 처음 제시한
 * URL(`corporatebank.db.com/.../Research`)은 다른 도메인으로 리다이렉트
 * 되며 404였는데, 오너가 실제 작동하는 URL(`dbresearch.com/PROD/IE-PROD/
 * HOME.alias`)을 다시 제시해 재조사 후 구축(2026-09-19, CLAUDE.md 참고).
 *
 * 레거시 CMS(Reweb) 사이트라 사이트맵이 없지만, 홈/주제별 허브 페이지
 * (Macro·Geopolitics·Corporate Landscape 등, `RI_*.alias`)가 전부 평범한
 * 서버렌더 HTML이고 각 리포트 카드가 `class="...-date"`·`class="...-title"`
 * (제목+PDF 링크)·`class="...-teaser"`(요약) 세 블록이 순서대로 붙어있는
 * 구조라(실측 확인) 정규식으로 바로 뽑는다. 날짜는 "September 15, 2026"
 * 형식으로 이미 영문 텍스트로 박혀있어 파싱이 간단하다(다른 소스들의
 * 제목-내장 날짜 추출보다 안정적).
 *
 * PDF는 로그인 없이 바로 받아진다(`/PROD/IE-PROD/{id}/{제목}.pdf`, 실측
 * 확인). 여러 주제 허브(Macro·Geopolitics·Germany·Corporate Landscape·
 * Featured)를 함께 훑어 커버리지를 넓힌다 — 하나씩은 리포트 수가 적음
 * (허브당 실측 5~15건).
 *
 * 종목 얘기가 아닌 매크로/지정학 테마 콘텐츠라 `category:"산업"`(symbol
 * 항상 null), `market:"us"`(다른 해외 소스와 같은 자리). 번역 안 함.
 *
 * robots.txt 확인 결과 이 경로들 차단 없음(오너 승인 조건과 동일 —
 * CLAUDE.md 참고).
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-dbresearch.mjs
 *   node scripts/collect-dbresearch.mjs --days=14 --dry-run
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

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HUBS = [
  "https://www.dbresearch.com/PROD/IE-PROD/HOME.alias",
  "https://www.dbresearch.com/PROD/IE-PROD/Macro__Research_Institute/RI_MAC.alias",
  "https://www.dbresearch.com/PROD/IE-PROD/Geopolitics__Research_Institute/RI_GEO.alias",
  "https://www.dbresearch.com/PROD/IE-PROD/Germany__Research_Institute/RI_GER.alias",
  "https://www.dbresearch.com/PROD/IE-PROD/Corporate_Landscape__Research_Institute/RI_COR.alias",
];

const MONTHS = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};
function parseEnDate(s) {
  const m = String(s ?? "").trim().match(/([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return null;
  const mm = MONTHS[m[1].toLowerCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${String(m[2]).padStart(2, "0")}`;
}

function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&quot;/g, '"')
    .replace(/&ndash;|&mdash;/g, "-")
    .replace(/&rsquo;|&lsquo;/g, "'")
    .trim();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

// 카드 구조: ...-date">{날짜}</div><div class="...-title">...<a href="{pdf}"
// title="{제목}" ...>{제목}</a>...</div><div class="...-teaser">
// (빈 정렬용 div 0~여러 개)...{요약}</div>
const CARD_RE =
  /-date"\s*>([^<]*)<\/div>[\s\S]{0,200}?-title"\s*>[\s\S]{0,120}?<a href="([^"]*\.pdf)"\s*title="([^"]*)"[\s\S]{0,300}?-teaser"\s*>(?:<div[^>]*><\/div>)*([^<]*)</g;

console.log("▶ Deutsche Bank Research 수집");

const cutoff = new Date(Date.now() - DAYS * 86_400_000);
const byId = new Map();
for (const hub of HUBS) {
  try {
    const html = await fetchText(hub);
    let m;
    CARD_RE.lastIndex = 0;
    while ((m = CARD_RE.exec(html))) {
      const date = parseEnDate(m[1]);
      const pdfUrl = m[2].startsWith("http") ? m[2] : `https://www.dbresearch.com${m[2]}`;
      const title = decodeEntities(m[3]);
      const summary = decodeEntities(m[4]).slice(0, 300);
      if (!date || !title || new Date(date) < cutoff) continue;
      const idMatch = pdfUrl.match(/PROD(\d+)/);
      const id = idMatch ? idMatch[1] : pdfUrl;
      if (!byId.has(id)) byId.set(id, { id, date, title, pdfUrl, summary });
    }
  } catch (err) {
    console.error(`  ✗ ${hub}: ${err.message}`);
  }
  await sleep(400);
}

const items = [...byId.values()].map((it) => ({
  id: it.id,
  date: it.date,
  title: it.title,
  stockName: "글로벌 인사이트",
  symbol: null,
  analyst: "Deutsche Bank Research",
  opinion: "",
  targetPrice: null,
  summary: it.summary,
  pdfUrl: it.pdfUrl,
  views: null,
  category: "산업",
}));

if (items.length === 0) {
  console.error("✗ 파싱 결과 0건. 페이지 구조가 바뀌었을 수 있음.");
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
  body: JSON.stringify({ items, source: "Deutsche Bank Research", market: "us" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
