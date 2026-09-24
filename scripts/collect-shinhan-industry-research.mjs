/**
 * 신한투자증권 "산업분석" 게시판(boardName=giindustry) 수집기 — 종목 무관
 * (category:"산업", symbol 항상 null).
 *
 * 기존 기업분석 수집기(collect-shinhan-research.mjs, boardName=gicompanyanalyst)
 * 와 같은 bbs2.shinhansec.com JSON API인데 게시판명만 다르다 — 오너가 실제
 * 리포트 상세 팝업 URL(`.../view.file.pop.do?boardName=giindustry&messageId=...`)
 * 을 제시해 발견(2026-09, "기업분석 메뉴 내에 산업분석이 있는데").
 *
 * 응답 필드는 기업분석과 동일한 셰이프(f0=작성일, f1=제목, f2=종목명/업종명,
 * f3=PDF, f4=애널리스트, f5=조회수, f7=본문)인데, f2가 업종명("화장품",
 * "건설리츠" 등)이거나 특정 업종을 안 다루는 리포트는 "-"로 비어있다.
 * 제목이 "화장품; 9월 아마존 랭킹..." 처럼 "f2;헤드라인" 형식이라 f2와
 * 중복되는 접두어는 제거한다. 본문(f7)에 이미 충분히 긴 요약문이 들어있어
 * (다른 여러 수집기와 달리) PDF를 따로 받을 필요 없이 바로 발췌한다.
 *
 * ⚠️ 접근 조건은 기업분석 수집기와 동일(CLAUDE.md 참조): robots.txt
 *    Disallow: / — 개인용·로컬 실행·저빈도 조건으로 오너 승인.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-shinhan-industry-research.mjs
 *   node scripts/collect-shinhan-industry-research.mjs --days=30 --pages=10 --dry-run
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
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://macroresearch.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim(); // 로컬 수동 실행 시 CRON_SECRET 없어도 인증 가능(라우트가 x-app-token도 허용)

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = "https://bbs2.shinhansec.com/bbs/list/giindustry";

const isoDate = (s) => {
  const m = String(s).trim().match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

function decodeEntities(s) {
  return s
    .replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;|&mdash;/g, "-")
    .replace(/&middot;/g, "·")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const EXCERPT_LEN = 300;
function excerpt(text) {
  const flat = decodeEntities(String(text ?? ""))
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return flat.length > EXCERPT_LEN ? `${flat.slice(0, EXCERPT_LEN)}…` : flat;
}

async function fetchPage(curPage, startId) {
  const url = new URL(BASE);
  url.searchParams.set("v", String(Date.now()));
  url.searchParams.set("curPage", String(curPage));
  url.searchParams.set("startPage", String(curPage));
  if (startId) url.searchParams.set("startId", startId);
  const res = await fetch(url, { headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.includes("errorWrapper")) throw new Error("게시판 API 404(구조 변경?)");
  return JSON.parse(text);
}

console.log(`▶ 신한투자증권 산업분석 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);

const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));
const items = [];
let startId;
let stop = false;

for (let page = 1; page <= MAX_PAGES && !stop; page++) {
  const data = await fetchPage(page, startId);
  const list = data.list ?? [];
  if (list.length === 0) break;
  for (const it of list) {
    const date = isoDate(it.f0);
    if (!date) continue;
    if (new Date(date) < cutoff) {
      stop = true;
      break;
    }
    const stockName = it.f2 && it.f2 !== "-" ? it.f2.trim() : "산업";
    let title = decodeEntities(String(it.f1 ?? "")).trim();
    // "화장품; 9월 아마존 랭킹..." → f2("화장품")와 중복되는 접두어 제거.
    const pm = title.match(/^([^;]+);\s*(.+)$/);
    if (pm && pm[1].trim() === stockName) title = pm[2].trim();

    items.push({
      id: String(it.fn),
      date,
      title,
      stockName,
      symbol: null,
      analyst: it.f4 ?? "",
      opinion: "",
      targetPrice: null,
      summary: excerpt(it.f7),
      pdfUrl: it.f3 || null,
      views: Number(it.f5) || null,
      category: "산업",
    });
  }
  const pages = data.pageInfo?.pages ?? [];
  startId = pages.length > 1 ? pages[1] : undefined;
  if (!startId) break;
  await sleep(400); // 예의상 간격
}

if (items.length === 0) {
  console.error("✗ 파싱 결과 0건. 게시판 구조가 바뀌었을 수 있음.");
  process.exit(1);
}

console.log(`✔ 파싱 완료: ${items.length}건`);
console.log("  최근 3건:", items.slice(0, 3).map((i) => `${i.date} [${i.stockName}] ${i.title}`));

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
  body: JSON.stringify({ items, source: "신한투자증권" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
