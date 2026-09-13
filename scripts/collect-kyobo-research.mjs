/**
 * 교보증권 "기업분석" 리포트 — 로컬 수집기.
 *
 * www.iprovest.com 의 리서치 화면은 화면 자체는 4중 iframe(레거시 웹로직)
 * 구조지만, 실제 데이터를 뿌리는 서블릿(`/weblogic/RSReportServlet`)은 로그인
 * 없이 평범한 GET으로 직접 열린다(오너가 실제 사이트에서 확인해 알려준 링크로
 * 역추적). 응답이 EUC-KR 인코딩이라 TextDecoder로 변환한다. 페이지네이션도
 * 평범한 GET(`&pageNum=N`). 종목명은 코드 없이 이름만 나와 corpcode.ts 이름
 * 검색으로 매핑한다. "산업분석"(구분 컬럼) 행은 종목이 아니라 업종이라 제외.
 *
 * ⚠️ www.iprovest.com/robots.txt 확인 안 됨(사이트 자체가 4중 프레임이라
 *    표준 경로가 애매) — 다른 예외들과 동일하게 "개인용·로컬 실행·저빈도"
 *    조건으로 오너 승인(CLAUDE.md 참조).
 *
 * PDF/본문 발췌(2026-09 갱신): 이전엔 "PDF는 로그인 필요"로 기록돼 있었으나
 * 실측 결과 상세 페이지(`mode=detail&sno=..&rno=1`)의 `fileDown('/weblogic/
 * RSDownloadServlet?filePath=..pdf')` 링크는 로그인 없이 그대로 받아진다
 * (오너 확인, 2026-09). 상세 페이지 자체의 "본문"은 이미지(png)라 텍스트
 * 추출이 안 되지만, 이 실제 PDF는 유안타증권과 동일하게 "주가수익률(%) ..."
 * 통계 블록(헤더+절대주가/상대주가 2줄) 다음부터 `pdf-parse`로 150자 내외를
 * 발췌한다. PDF 원문·전체 본문은 저장하지 않음. 목록→상세 페이지→PDF 순으로
 * 항목당 두 번 더 요청이 늘어 --days 기본값을 14 → 3으로 좁혔다(서버가
 * 통째로 replace하는 구조라 매일 재다운로드 범위를 최소화 — 유안타증권과
 * 동일 이유). 백필은 --days=30 등으로 수동 실행.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-kyobo-research.mjs
 *   node scripts/collect-kyobo-research.mjs --days=30 --pages=10 --dry-run
 */

import { readFileSync } from "node:fs";
import { PDFParse } from "pdf-parse";

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
const DAYS = Number(ARGS.find((a) => a.startsWith("--days="))?.split("=")[1]) || 3;
const MAX_PAGES = Number(ARGS.find((a) => a.startsWith("--pages="))?.split("=")[1]) || 5;

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim(); // 로컬 수동 실행 시 CRON_SECRET 없어도 인증 가능(라우트가 x-app-token도 허용)
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST_URL = "https://www.iprovest.com/weblogic/RSReportServlet";
const eucKr = new TextDecoder("euc-kr");

const isoDate = (s) => {
  const m = String(s).trim().match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
}

const ymd = (d) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;

async function fetchPage(page) {
  const url = new URL(LIST_URL);
  url.searchParams.set("scr_id", "32");
  url.searchParams.set("menuCode", "1");
  url.searchParams.set("srch_db", "0");
  // 서버 기본값(폼 hidden 필드)에 의존하지 않고 명시적으로 넉넉한 기간을 지정
  // (지정 안 하면 실제로 결과가 거의 안 나오는 현상 확인됨).
  url.searchParams.set("DT1", ymd(new Date(Date.now() - 120 * 86_400_000)));
  url.searchParams.set("DT2", ymd(new Date()));
  url.searchParams.set("pageNum", String(page));
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return eucKr.decode(buf);
}

// 행 하나 = 일자, 제목(+상세 링크의 sno), 종목/업종, 구분(기업분석/산업분석 등).
const ROW_RE =
  /<td>(\d{4}\/\d{2}\/\d{2})<\/td>[\s\S]{0,400}?<a href="[^"]*sno=(\d+)[^"]*">([^<]+)<\/a>[\s\S]{0,100}?<td>([^<]*)<\/td>[\s\S]{0,100}?<i>([^<]*)<\/i>/g;

function parseItems(html) {
  const items = [];
  for (const m of html.matchAll(ROW_RE)) {
    const [, rawDate, sno, rawTitle, rawStock, category] = m;
    const date = isoDate(rawDate);
    if (!date) continue;
    if (!category.includes("기업분석")) continue; // 산업분석 등 종목 아닌 리포트 제외
    items.push({
      id: sno,
      date,
      title: stripHtml(rawTitle),
      stockName: stripHtml(rawStock),
    });
  }
  return items;
}

const DETAIL_URL = "https://www.iprovest.com/weblogic/RSReportServlet";
const FILEDOWN_RE = /fileDown\('(\/weblogic\/RSDownloadServlet\?filePath=[^']+)'\)/;
const EXCERPT_LEN = 150;

async function fetchPdfUrl(sno) {
  const url = new URL(DETAIL_URL);
  url.searchParams.set("scr_id", "32");
  url.searchParams.set("mode", "detail");
  url.searchParams.set("menuCode", "1");
  url.searchParams.set("pageNum", "1");
  url.searchParams.set("sno", sno);
  url.searchParams.set("rno", "1");
  const res = await fetch(url, { headers: { "User-Agent": UA, Referer: DETAIL_URL } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = eucKr.decode(await res.arrayBuffer());
  const m = html.match(FILEDOWN_RE);
  return m ? `https://www.iprovest.com${m[1]}` : null;
}

function excerptFromPdfText(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const anchor = lines.findIndex((l) => l.startsWith("주가수익률"));
  const bodyLines = anchor >= 0 ? lines.slice(anchor + 3) : lines.slice(20);
  const flat = bodyLines
    .filter((l) => l.length >= 10)
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!flat) return "";
  if (flat.length <= EXCERPT_LEN) return flat;
  const cut = flat.slice(0, EXCERPT_LEN);
  const boundary = Math.max(cut.lastIndexOf("다."), cut.lastIndexOf("요."), cut.lastIndexOf("함."));
  return (boundary > EXCERPT_LEN * 0.5 ? cut.slice(0, boundary + 1) : cut) + "…";
}

// 교보는 "Buy\t상향" + "TP 380,000 원\t상향" 처럼 다른 증권사와 다른 라벨을
// 쓴다("목표주가"가 아니라 "TP"). "Spot Brief"·"탐방노트" 등 약식 리포트는
// 이 헤더 자체가 없어 null.
function extractOpinion(text) {
  const m = text.match(/^(Strong\s*Buy|Buy|Hold|Sell|Not\s*Rated)\b/m);
  return m ? m[1] : "";
}
function extractTargetPrice(text) {
  const m = text.match(/\bTP\s*([\d,]+)\s*원/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function extractExcerpt(sno) {
  try {
    const pdfUrl = await fetchPdfUrl(sno);
    if (!pdfUrl) return { pdfUrl: null, summary: "", opinion: "", targetPrice: null };
    const res = await fetch(pdfUrl, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const parser = new PDFParse({ data: buf });
    const { text } = await parser.getText();
    await parser.destroy();
    return {
      pdfUrl,
      summary: excerptFromPdfText(text),
      opinion: extractOpinion(text),
      targetPrice: extractTargetPrice(text),
    };
  } catch (err) {
    console.warn(`  ⚠ PDF 본문 추출 실패 (sno=${sno}): ${err.message}`);
    return { pdfUrl: null, summary: "", opinion: "", targetPrice: null };
  }
}

console.log(`▶ 교보증권 기업분석 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
// 항목 날짜가 'YYYY-MM-DD'(=UTC 자정)라 컷오프도 자정으로 맞춘다.
// Date.now() 기준 그대로 두면 '정확히 DAYS일 전' 리포트가 시:분 차이로
// 매번 잘려나간다(실측 2026-09: 미래에셋 최신 리포트가 3시간 차이로 탈락).
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));
const collected = [];
let stop = false;
for (let page = 1; page <= MAX_PAGES && !stop; page++) {
  const html = await fetchPage(page);
  const items = parseItems(html);
  if (items.length === 0 && page > 1) break;
  for (const it of items) {
    if (new Date(it.date) < cutoff) {
      stop = true;
      break;
    }
    collected.push(it);
  }
  await sleep(400);
}

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. 페이지 구조가 바뀌었을 수 있음.");
  process.exit(1);
}
console.log(`✔ 파싱 완료: ${collected.length}건`);
console.log("  최근 3건:", collected.slice(0, 3).map((i) => `${i.date} ${i.stockName} — ${i.title}`));

console.log(`▶ PDF 본문 발췌 중 (${collected.length}건)...`);
let excerptFailCount = 0;
for (const it of collected) {
  const { pdfUrl, summary, opinion, targetPrice } = await extractExcerpt(it.id);
  // rno=1 없으면 "서비스 이용에 불편을 드려 죄송합니다" 에러 페이지로 감(실측 확인).
  it.pdfUrl = pdfUrl ?? `https://www.iprovest.com/weblogic/RSReportServlet?scr_id=32&mode=detail&menuCode=1&pageNum=1&sno=${it.id}&rno=1`;
  it.summary = summary;
  it.opinion = opinion;
  it.targetPrice = targetPrice;
  if (!summary) excerptFailCount++;
  await sleep(400);
}
console.log(`✔ 발췌 완료 (실패 ${excerptFailCount}건)`);
console.log("  예시:", collected[0]?.summary || "(없음)");

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const items = collected.map((it) => ({
  id: it.id,
  date: it.date,
  title: it.title,
  stockName: it.stockName,
  symbol: null, // 서버가 corpcode.ts 이름 검색으로 매핑
  analyst: "",
  opinion: it.opinion,
  targetPrice: it.targetPrice,
  summary: it.summary,
  pdfUrl: it.pdfUrl,
  views: null,
}));

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;
const up = await fetch(IMPORT_URL, {
  method: "POST",
  headers,
  body: JSON.stringify({ items, source: "교보증권" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
