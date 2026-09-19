/**
 * BNP Paribas Economic Research(`economic-research.bnpparibas.com`) 수집기
 * — 오너가 제시한 해외 IB/자산운용사 리서치 2차 6곳(ING THINK·BNP Paribas·
 * Deutsche Bank·UBS CIO·Citi GPS·BofA Institute) 조사(2026-09-19) 중
 * 구축 가능으로 확인된 3곳 중 하나. `sitemap.xml`엔 개별 리포트가 아니라
 * "Eco-Flash"/"Eco-Week"/"Eco-Conjoncture" 같은 게시판 허브 URL만 있고
 * lastmod도 전부 2022-12-05로 고정(실측 — 사이트맵으로 최신순 추림 불가,
 * 골드만삭스·JP모간·모간스탠리·PIMCO와 다른 케이스). 대신 **게시판 자체가
 * `/Publications/Eco-Flash/en-US/Page-N` 형식으로 페이지네이션되는 평범한
 * 서버렌더 HTML**이라(실측 확인) 신한/하나 같은 기존 "게시판 목록" 패턴을
 * 그대로 쓴다 — 목록에서 `/Publication/{id}/en-US` 링크만 뽑고 개별 글
 * 페이지를 연다.
 *
 * 개별 글 페이지엔 발행일 메타가 없어(실측 확인) **제목에 박힌 날짜**를
 * 파싱한다 — "Eco Week September 14, 2026"/"Eco Week 1 June 2026"/
 * "Special Edition July 2, 2026"처럼 "Month D, YYYY"·"D Month YYYY" 두
 * 형식이 섞여 있고(실측), 드물게 "Energy shock... June 2026"처럼 일(day)
 * 없이 월만 있는 경우도 있어 그때는 1일로 근사한다(블랙록 반기 아웃룩과
 * 같은 트레이드오프). 날짜를 못 뽑으면 그 항목은 건너뛴다.
 *
 * 요약은 `id="MainContent_hSummary"` 다음 문단이 "Contents"류 라벨뿐이라
 * 못 쓰고, 본문 첫 실제 문단(사이트 공통 안내문 "Three teams of
 * economists..." 등은 걸러냄)을 발췌한다.
 *
 * 종목 얘기가 아닌 매크로/채권금리 테마 콘텐츠라 `category:"산업"`(symbol
 * 항상 null), `market:"us"`(다른 해외 IB 소스와 같은 자리). 번역 안 함.
 *
 * robots.txt: `User-agent: *` 기준 `/handlers`·특정 파라미터만 차단, 이
 * 게시판 경로는 안 막힘(오너 승인 조건과 동일 — CLAUDE.md 참고).
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-bnpparibas-research.mjs
 *   node scripts/collect-bnpparibas-research.mjs --days=14 --pages=5 --dry-run
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
const MAX_PAGES = Number(ARGS.find((a) => a.startsWith("--pages="))?.split("=")[1]) || 5;

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 여러 게시판을 함께 훑는다 — 전부 같은 /Publication/{id} 상세로 연결됨.
// 실측(사이트맵)으로 확인된 게시판 중 팟캐스트(Podcast---Macro-Waves)·
// 참고자료(French-Economy-Pocket-Atlas)는 제외, 텍스트 위주 매크로 리서치만.
const BOARDS = ["Eco-Week", "Eco-Flash", "Eco-Conjoncture", "Eco-Emerging", "Special-Edition"];

const MONTHS = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&quot;/g, '"')
    .replace(/&ndash;|&mdash;/g, "-")
    .replace(/&rsquo;|&lsquo;/g, "'")
    .trim();
}

// "September 14, 2026" | "1 June 2026" | "June 2026"(일자 없음 → 1일 근사)
function parseTitleDate(title) {
  const t = String(title ?? "");
  let m = t.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (m) {
    const mm = MONTHS[m[1].toLowerCase()];
    if (mm) return `${m[3]}-${mm}-${String(m[2]).padStart(2, "0")}`;
  }
  m = t.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (m) {
    const mm = MONTHS[m[2].toLowerCase()];
    if (mm) return `${m[3]}-${mm}-${String(m[1]).padStart(2, "0")}`;
  }
  m = t.match(/([A-Za-z]+)\s+(\d{4})/);
  if (m) {
    const mm = MONTHS[m[1].toLowerCase()];
    if (mm) return `${m[2]}-${mm}-01`;
  }
  return null;
}

const NAV_JUNK_RE = /^(Three teams of economists|Equity indices, currencies|Subscribe|Accept|Cookies)/;

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

console.log("▶ BNP Paribas Economic Research 수집");

const seenIds = new Set();
for (const board of BOARDS) {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url =
      page === 1
        ? `https://economic-research.bnpparibas.com/Publications/${board}/en-US`
        : `https://economic-research.bnpparibas.com/Publications/${board}/en-US/Page-${page}`;
    let html;
    try {
      html = await fetchText(url);
    } catch {
      break;
    }
    const ids = [...html.matchAll(/\/Publication\/(\d+)\/en-US/g)].map((m) => m[1]);
    if (ids.length === 0) break;
    let newCount = 0;
    for (const id of ids) {
      if (!seenIds.has(id)) {
        seenIds.add(id);
        newCount++;
      }
    }
    if (newCount === 0) break; // 이 페이지가 전부 이미 본 id면 더 넘길 필요 없음
    await sleep(300);
  }
}

console.log(`✔ 게시판 ${BOARDS.length}곳에서 후보 ${seenIds.size}건 발견`);

const cutoff = new Date(Date.now() - DAYS * 86_400_000);
const items = [];
for (const id of seenIds) {
  const url = `https://economic-research.bnpparibas.com/Publication/${id}/en-US`;
  try {
    const html = await fetchText(url);
    const h1 = html.match(/<h1[^>]*>([\s\S]{0,300}?)<\/h1>/);
    const title = decodeEntities(h1?.[1]?.replace(/<[^>]+>/g, "") ?? "");
    const date = parseTitleDate(title);
    if (!title || !date || new Date(date) < cutoff) {
      await sleep(250);
      continue;
    }

    const paras = [...html.matchAll(/<p[^>]*>([\s\S]{0,400}?)<\/p>/g)]
      .map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, "")))
      .filter((t) => t.length > 40 && !NAV_JUNK_RE.test(t));
    const summary = (paras[0] ?? "").slice(0, 300);

    items.push({
      id,
      date,
      title,
      stockName: "글로벌 인사이트",
      symbol: null,
      analyst: "BNP Paribas Economic Research",
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
  console.error("✗ 파싱 결과 0건. 게시판 구조가 바뀌었을 수 있음.");
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
  body: JSON.stringify({ items, source: "BNP Paribas", market: "us" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
