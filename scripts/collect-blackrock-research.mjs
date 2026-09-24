/**
 * BlackRock Investment Institute(BII) 수집기 — 오너가 제시한 해외 IB/
 * 자산운용사 리서치 5곳 중 실측 결과 지금 바로 만들 수 있는 곳은 블랙록뿐
 * 이었다(2026-09-19 조사). 나머지 4곳은 실제 목록이 검색 위젯(Algolia/
 * Coveo) 뒤에 있거나 목록 페이지 자체에 카드가 없어(JS 지연 로드) 별도
 * 사이트맵 방식으로 구축(CLAUDE.md 참고).
 *
 * 두 페이지를 각각 수집한다(둘 다 URL 고정, 내용만 주기적으로 바뀌는 구조 —
 * 다른 수집기들의 "게시판 목록"과 다름, 페이지네이션 없음):
 *   - `global-weekly-commentary`(매주 교체) → `source:"BlackRock"` →
 *     인사이트 탭. `<meta name="publicationDate">`("Sep 14, 2026")로 정확한
 *     발행일 확보.
 *   - `global-investment-outlook`(반기 교체) → `source:"BlackRock
 *     Research"`(오너 지시, 2026-09-19 — "블랙락은 global-investment-
 *     outlook은 산업분석으로 정리하고 나머지는 인사이트에") →
 *     `FOREIGN_RESEARCH_SOURCES`에 포함돼 산업분석 탭 "해외리서치"
 *     세그먼트로 감(골드만삭스 리서치 노트와 같은 메커니즘). **발행일 메타가
 *     없음**(실측 확인 — articleTitle·pageSummary는 있지만 publicationDate
 *     없음) — 제목의 "2026 Midyear"/"Midyear" 표기로 반기를 추정(Midyear면
 *     7월 1일, 아니면 1월 1일)해 근사 날짜를 쓴다. 정확한 발행일이 아니라
 *     화면엔 대략적인 시점으로만 표시됨(한계, 우선순위 낮아 보류).
 *   - 그 외 블랙록 인사이트 하위 페이지(equity-market-outlook 등, 발행일
 *     메타 자체가 없는 게 더 많음)는 아직 미착수 — 추가 여부는 개별 확인
 *     후 결정.
 *
 * 종목 얘기가 아니라 매크로/자산배분 코멘터리라 둘 다 `category:"산업"`
 * (symbol 항상 null, 목표주가·투자의견 없음). 영문 원문 그대로 저장(번역
 * 안 함). market:"us".
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
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://macroresearch.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

function metaContent(html, name) {
  const m = html.match(new RegExp(`<meta name="${name}"[^>]*content="([^"]*)"`, "i"));
  return m
    ? m[1].replace(/&amp;/g, "&").replace(/&#39;|&#x27;/gi, "'").replace(/&quot;/g, '"').trim()
    : null;
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

// 발행일 메타가 없는 반기 아웃룩 전용 — 제목+요약의 연도 + Midyear 표기로
// 근사(실측 — articleTitle엔 "Midyear"가 안 남고 pageSummary에만 있었음).
function guessSemiAnnualDate(title, summary) {
  const hay = `${title ?? ""} ${summary ?? ""}`;
  const year = hay.match(/\b(20\d\d)\b/)?.[1];
  if (!year) return null;
  const isMidyear = /mid[\s-]?year/i.test(hay);
  return `${year}-${isMidyear ? "07" : "01"}-01`;
}

async function fetchPage(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function sendBatch(items, source) {
  if (items.length === 0) return;
  if (DRY_RUN) {
    console.log(`--dry-run: ${source} ${items.length}건 전송 생략`);
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

console.log("▶ BlackRock Investment Institute 수집");

const weeklyItems = [];
{
  const url = "https://www.blackrock.com/sg/en/insights/global-weekly-commentary";
  const html = await fetchPage(url);
  const title = metaContent(html, "articleTitle");
  const summary = metaContent(html, "pageSummary");
  const date = parsePublicationDate(metaContent(html, "publicationDate"));
  if (title && date) {
    weeklyItems.push({
      id: `weekly-commentary-${date}`,
      date,
      title,
      stockName: "글로벌 위클리 시황",
      symbol: null,
      analyst: "BlackRock Investment Institute",
      opinion: "",
      targetPrice: null,
      summary: summary ?? "",
      pdfUrl: url,
      views: null,
      category: "산업",
    });
    console.log(`✔ 위클리 시황: ${date} — ${title}`);
  } else {
    console.error("✗ 위클리 시황 파싱 실패(title/date 없음) — 페이지 구조가 바뀌었을 수 있음.");
  }
}

const outlookItems = [];
{
  const url = "https://www.blackrock.com/sg/en/insights/global-investment-outlook";
  const html = await fetchPage(url);
  const title = metaContent(html, "articleTitle");
  const summary = metaContent(html, "pageSummary");
  const date = guessSemiAnnualDate(title, summary);
  if (title && date) {
    outlookItems.push({
      id: `global-investment-outlook-${date}`,
      date,
      title,
      stockName: "글로벌 인사이트",
      symbol: null,
      analyst: "BlackRock Investment Institute",
      opinion: "",
      targetPrice: null,
      summary: summary ?? "",
      pdfUrl: url,
      views: null,
      category: "산업",
    });
    console.log(`✔ 글로벌 투자전망(해외리서치): ${date} — ${title}`);
  } else {
    console.error("✗ 글로벌 투자전망 파싱 실패(title/date 없음) — 페이지 구조가 바뀌었을 수 있음.");
  }
}

if (weeklyItems.length === 0 && outlookItems.length === 0) {
  process.exit(1);
}

await sendBatch(weeklyItems, "BlackRock");
await sendBatch(outlookItems, "BlackRock Research");
