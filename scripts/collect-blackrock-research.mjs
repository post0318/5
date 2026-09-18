/**
 * BlackRock Investment Institute(BII) 위클리 시황 코멘터리 수집기 — 오너가
 * 제시한 해외 IB/자산운용사 리서치 5곳(골드만삭스·JP모간·모간스탠리·블랙록·
 * PIMCO) 중 실측 결과 지금 바로 만들 수 있는 곳은 블랙록뿐이었다(2026-09-19
 * 조사). 나머지 4곳은 실제 목록이 검색 위젯(Algolia/Coveo) 뒤에 있거나 목록
 * 페이지 자체에 카드가 없어(JS 지연 로드) 브라우저 네트워크 로그 역추적이
 * 더 필요해 보류 — CLAUDE.md 참고.
 *
 * `www.blackrock.com/sg/en/insights/global-weekly-commentary` 는 URL 이
 * 고정이고 내용이 매주 바뀌는 페이지(다른 수집기들의 "게시판 목록"과 달리
 * 페이지네이션이 없음, 실측 확인). 서버렌더 HTML의 <meta> 태그에 필요한
 * 값이 다 있어 PDF·API 역추적이 불필요:
 *   - articleTitle: 헤드라인 ("EM equities: back to overweight")
 *   - pageSummary: 1~2문장 요약(그대로 저장, 다른 소스의 발췌와 같은 성격)
 *   - publicationDate: "Sep 14, 2026" 형식 발행일(영문 월 이름 파싱 필요)
 * 매주 내용이 바뀌므로 `id`를 이 발행일로 만들어야 과거분이 안 덮어써진다.
 *
 * 종목 얘기가 아니라 매크로/자산배분 코멘터리라 `category:"산업"`
 * (symbol 항상 null, 목표주가·투자의견 없음) — 다른 해외 "글로벌 전략"류
 * 수집기와 같은 성격. 영문 원문 그대로 저장(번역 안 함) — 이 프로젝트의
 * 기존 "기업 발표"(NVIDIA/Apple 등 공식 블로그) 카드와 동일한 선례.
 * market:"us" — 미국주식 페이지의 산업분석 탭에서 다른 "글로벌 전략"류
 * (신한 Global Portfolio, KB Global Tracker+ 등)와 같은 자리에 노출.
 *
 * robots.txt: `User-agent: *` 기준 /insights 경로 차단 없음(오너 확인 및
 * 진행 승인, 2026-09-19 — "5곳 모두 동일 조건으로 진행").
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-blackrock-research.mjs
 *   node scripts/collect-blackrock-research.mjs --dry-run
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

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

const PAGE_URL = "https://www.blackrock.com/sg/en/insights/global-weekly-commentary";

function metaContent(html, name) {
  const m = html.match(new RegExp(`<meta name="${name}"[^>]*content="([^"]*)"`, "i"));
  return m ? m[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim() : null;
}

const MONTHS = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};
function parsePublicationDate(s) {
  // "Sep 14, 2026" -> "2026-09-14"
  const m = String(s ?? "").trim().match(/^([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})$/);
  if (!m) return null;
  const mm = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${String(m[2]).padStart(2, "0")}`;
}

console.log("▶ BlackRock Investment Institute 위클리 시황 수집");

const res = await fetch(PAGE_URL, { headers: { "User-Agent": UA } });
if (!res.ok) {
  console.error(`✗ HTTP ${res.status}`);
  process.exit(1);
}
const html = await res.text();

const title = metaContent(html, "articleTitle");
const summary = metaContent(html, "pageSummary");
const date = parsePublicationDate(metaContent(html, "publicationDate"));

if (!title || !date) {
  console.error("✗ 파싱 실패(title/date 없음) — 페이지 구조가 바뀌었을 수 있음.");
  process.exit(1);
}

const items = [
  {
    id: `weekly-commentary-${date}`,
    date,
    title,
    stockName: "글로벌 위클리 시황",
    symbol: null,
    analyst: "BlackRock Investment Institute",
    opinion: "",
    targetPrice: null,
    summary: summary ?? "",
    pdfUrl: PAGE_URL,
    views: null,
    category: "산업",
  },
];

console.log(`✔ 파싱 완료: ${date} — ${title}`);
console.log(`  요약: ${summary}`);

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
  body: JSON.stringify({ items, source: "BlackRock", market: "us" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
