/**
 * 유안타증권 "기업분석" 리포트 — 로컬 수집기.
 *
 * www.myasset.com 기업분석 목록은 로그인 없이 서버렌더링 HTML로 나온다
 * (robots.txt 자체가 없음 — 명시적 Disallow는 없지만 다른 예외들과 동일하게
 * "개인용·로컬 실행·저빈도" 조건으로 오너 승인, CLAUDE.md 참조). 페이지네이션도
 * 평범한 GET(`&page=N&pgCnt=30`). 종목코드가 `data-jongcode="(코드)"` 속성에
 * 그대로 있어 이름 검색 없이 바로 뽑는다.
 *
 * PDF 원문 링크: 목록 행의 `cmd-type='download' data-seq='2026/0910/172546/
 * ..._ko.pdf'` 값이 그대로 `https://file.myasset.com/sitemanager/upload/`
 * 뒤에 붙는 경로다(2026-09 확인, 로그인 불필요·200 응답).
 *
 * 본문 발췌: 다른 증권사와 달리 목록 HTML에 요약문이 없어, PDF를 내려받아
 * `pdf-parse`로 텍스트를 뽑고 "주가수익률 (%) ..." 통계 블록(항상 4줄: 헤더 +
 * 절대/상대/절대(달러환산)) 다음부터 150자 내외를 짧게 발췌한다. PDF 원문·
 * 전체 본문 텍스트는 저장하지 않고 이 짧은 발췌문만 DB에 보낸다(다른 증권사의
 * "요약 발췌만 저장" 정책과 동일 성격, 오너 확인 2026-09).
 *
 * ⚠️ 서버(/api/cron/shinhan-research)는 보낸 항목을 통째로 replace한다 —
 *    이미 수집된 옛 항목을 summary 없이 다시 보내면 예전에 뽑아둔 발췌가
 *    지워진다. 그래서 --days 기본값을 14 → 3으로 좁혀 "매일 최근 며칠만
 *    다시 훑는" 방식으로 바꿨다(하루 1회 크론 기준 안전 마진 확보 + PDF를
 *    매번 새로 받는 범위 최소화). 백필이 필요하면 --days=30 등으로 수동
 *    실행(그만큼 PDF도 더 많이 받으니 자주 돌리지 말 것).
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-yuanta-research.mjs
 *   node scripts/collect-yuanta-research.mjs --days=30 --pages=10 --dry-run
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

const LIST_URL = "https://www.myasset.com/myasset/research/rs_list/rs_list.cmd";

const isoDate = (s) => {
  const m = String(s).trim().match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
function stripHtml(s) {
  return s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();
}

const FILE_BASE = "https://file.myasset.com/sitemanager/upload/";
const EXCERPT_LEN = 150;

// 리포트 PDF 상단은 항상 "목표주가/시가총액/... /주가수익률 (%) 1개월 3개월
// 12개월" 통계 블록 + 그 아래 절대/상대/절대(달러환산) 3줄로 끝난다. 이 헤더
// 라인 다음부터가 실제 본문이라, 그 뒤 텍스트만 골라 짧게 자른다.
function excerptFromPdfText(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const anchor = lines.findIndex((l) => l.startsWith("주가수익률"));
  const bodyLines = anchor >= 0 ? lines.slice(anchor + 4) : lines.slice(17);
  const flat = bodyLines
    .filter((l) => l.length >= 10) // 짧은 소제목 줄은 건너뛰고 실제 문장부터
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!flat) return "";
  if (flat.length <= EXCERPT_LEN) return flat;
  const cut = flat.slice(0, EXCERPT_LEN);
  const boundary = Math.max(cut.lastIndexOf("다."), cut.lastIndexOf("요."), cut.lastIndexOf("함."));
  return (boundary > EXCERPT_LEN * 0.5 ? cut.slice(0, boundary + 1) : cut) + "…";
}

// 통계 블록 첫 줄이 항상 "목표주가 470,000원 (D)" 또는 미제시 시 "목표주가 -원 (M)".
function extractTargetPrice(text) {
  const m = text.match(/목표주가\s*([\d,]+|-)\s*원/);
  if (!m || m[1] === "-") return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function extractPdfExcerpt(pdfUrl) {
  if (!pdfUrl) return { summary: "", targetPrice: null };
  try {
    const res = await fetch(pdfUrl, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const parser = new PDFParse({ data: buf });
    const { text } = await parser.getText();
    await parser.destroy();
    return { summary: excerptFromPdfText(text), targetPrice: extractTargetPrice(text) };
  } catch (err) {
    console.warn(`  ⚠ PDF 본문 추출 실패 (${pdfUrl}): ${err.message}`);
    return { summary: "", targetPrice: null };
  }
}

async function fetchPage(page) {
  const url = new URL(LIST_URL);
  url.searchParams.set("cd006", "");
  url.searchParams.set("cd007", "RE01"); // 기업분석
  url.searchParams.set("cd008", "");
  url.searchParams.set("page", String(page));
  url.searchParams.set("pgCnt", "30");
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// 행(<tr>) 단위로 잘라서 필드별로 따로 매칭한다 — 느슨한 구간([\s\S]{0,N}?)
// 뒤에 선택 그룹(?:...)?을 바로 붙이면 정규식이 아무것도 건너뛰지 않고 "그룹
// 없음"으로 즉시 매칭을 끝내버려 다운로드 경로를 절대 못 찾는 문제가 있었다.
const ROW_SPLIT_RE = /<tr class="js-moveRS">([\s\S]*?)<\/tr>/g;
const DATE_RE = /<td>(\d{4}\/\d{2}\/\d{2})<\/td>/;
const JONG_RE = /data-jongcode="\(?(\d{6})\)?">([^<]+)<\/a>/;
const OPINION_RE = /class="js-ivstComment">([^<]*)<\/td>/;
const TITLE_RE = /cmd-type="view" data-seq="(\d+)"[^>]*>([^<]+)/;
const DOWNLOAD_RE = /cmd-type='download' data-seq='([^']+)'/;

function parseItems(html) {
  const items = [];
  for (const rowMatch of html.matchAll(ROW_SPLIT_RE)) {
    const row = rowMatch[1];
    const dateM = row.match(DATE_RE);
    const jongM = row.match(JONG_RE);
    const titleM = row.match(TITLE_RE);
    if (!dateM || !jongM || !titleM) continue;
    const date = isoDate(dateM[1]);
    if (!date) continue;
    const opinionM = row.match(OPINION_RE);
    const downloadM = row.match(DOWNLOAD_RE);
    items.push({
      id: titleM[1],
      date,
      title: stripHtml(titleM[2]),
      stockName: jongM[2].trim(),
      symbolHint: jongM[1],
      opinion: (opinionM?.[1] ?? "").trim(),
      pdfUrl: downloadM ? FILE_BASE + downloadM[1] : null,
    });
  }
  return items;
}

console.log(`▶ 유안타증권 기업분석 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
const cutoff = new Date(Date.now() - DAYS * 86_400_000);
const collected = [];
let stop = false;
for (let page = 1; page <= MAX_PAGES && !stop; page++) {
  const html = await fetchPage(page);
  const items = parseItems(html);
  if (items.length === 0) break;
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
console.log(
  "  최근 3건:",
  collected.slice(0, 3).map((i) => `${i.date} ${i.stockName}(${i.symbolHint}) — ${i.title}`),
);

console.log(`▶ PDF 본문 발췌 중 (${collected.length}건)...`);
const items = [];
let excerptFailCount = 0;
for (const it of collected) {
  const { summary, targetPrice } = await extractPdfExcerpt(it.pdfUrl);
  if (it.pdfUrl && !summary) excerptFailCount++;
  items.push({
    id: it.id,
    date: it.date,
    title: it.title,
    stockName: it.stockName,
    symbol: it.symbolHint,
    analyst: "",
    opinion: it.opinion,
    targetPrice,
    summary,
    pdfUrl: it.pdfUrl,
    views: null,
  });
  await sleep(500);
}
console.log(`✔ 발췌 완료 (실패 ${excerptFailCount}건)`);
console.log("  예시:", items[0]?.summary || "(없음)");

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
  body: JSON.stringify({ items, source: "유안타증권" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
