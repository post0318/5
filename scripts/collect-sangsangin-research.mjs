/**
 * 상상인증권 "기업리포트" 수집기 (국내 종목).
 *
 * 화면(www.sangsanginib.com/research/enterpriseReport/enterpriseReportView)이
 * 목록을 AJAX 로 채워서 HTML 만 받아서는 아무것도 안 나온다. 브라우저 네트워크
 * 로그로 내부 API 를 역추적했다(2026-09):
 *   POST /notice/getNoticeList  (form-urlencoded)
 *   cmsCd=CM0079(기업리포트) · rowNum · startRow · src=all · sdt/edt
 *   → [{ getNoticeList: [...], getCount: 4466 }]
 *
 * 응답이 이 프로젝트에서 다룬 소스 중 가장 깔끔하다 — STOCK_CD(종목코드)·
 * STOCK_NM·TITLE·REGDT·NM(작성자)이 구조화돼 있어 제목 파싱도 이름 검색도
 * 필요 없다. 전체 4,466건으로 한경 컨센서스 경유분(90일 12건)보다 훨씬 많다
 * — 오너가 "사이트에는 리서치가 엄청 많다"고 지적해 자체 수집으로 전환.
 *
 * PDF 는 로그인 없이 규칙적인 경로로 열린다:
 *   /_upload/attFile/CM0079/CM0079_{NT_NO}_1.pdf
 * 투자의견·목표주가는 목록에 없어 PDF 에서 뽑는다(국내 표기 "N원").
 *
 * ⚠️ 다른 예외들과 동일 조건: 개인용·하루 1회·저빈도(CLAUDE.md 참고).
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-sangsangin-research.mjs
 *   node scripts/collect-sangsangin-research.mjs --days=90 --dry-run
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
const arg = (n) => ARGS.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const DRY_RUN = ARGS.includes("--dry-run");
const DAYS = Number(arg("days")) || 14;
const PAGE_SIZE = 50;
const MAX_PAGES = Number(arg("pages")) || 10;

const LIST_URL = "https://www.sangsanginib.com/notice/getNoticeList";
const CMS_CD = "CM0079"; // 기업리포트
const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 국내 리포트라 목표주가는 "N원" 표기. */
function extractTargetPrice(text) {
  const m = String(text ?? "").match(/목표\s*주가[^\d]{0,16}([\d,]{4,12})\s*원/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}
function extractOpinion(text) {
  const m = String(text ?? "").match(
    /투자의견[^가-힣A-Za-z]{0,8}(매수|적극매수|중립|보유|매도|비중확대|비중축소|Buy|Hold|Sell|Not\s*Rated|N\.?R\.?)/i,
  );
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

async function fetchPage(startRow) {
  const res = await fetch(LIST_URL, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: new URLSearchParams({
      cmsCd: CMS_CD,
      rowNum: String(PAGE_SIZE),
      startRow: String(startRow),
      src: "all",
      sdt: "",
      edt: "",
    }).toString(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const node = Array.isArray(json) ? json[0] : json;
  return { rows: node?.getNoticeList ?? [], total: node?.getCount ?? 0 };
}

async function pdfText(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return "";
    const parser = new PDFParse({ data: Buffer.from(await res.arrayBuffer()) });
    const { text } = await parser.getText();
    await parser.destroy();
    return String(text ?? "");
  } catch {
    return "";
  }
}

console.log(`▶ 상상인증권 기업리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
// 항목 날짜가 'YYYY-MM-DD'(=UTC 자정)라 컷오프도 자정으로 맞춘다.
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));
const collected = [];
let stop = false;
let total = 0;
for (let page = 0; page < MAX_PAGES && !stop; page++) {
  const { rows, total: t } = await fetchPage(page * PAGE_SIZE);
  total = t;
  if (rows.length === 0) break;
  for (const r of rows) {
    const date = String(r.REGDT ?? "").replace(/\./g, "-");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (new Date(date) < cutoff) {
      stop = true;
      break;
    }
    const code = String(r.STOCK_CD ?? "").trim();
    if (!/^\d{6}$/.test(code)) continue; // 종목 없는 공지/기타
    // 제목이 "종목명(코드):부제" 형식이라 부제만 남긴다.
    const title = String(r.TITLE ?? "").replace(/^.*?\(\d{6}\)\s*[:：]?\s*/, "").trim();
    collected.push({
      id: String(r.NT_NO),
      date,
      title: title || String(r.TITLE ?? "").trim(),
      stockName: String(r.STOCK_NM ?? "").trim(),
      symbol: code,
      analyst: String(r.NM ?? "").trim(),
      opinion: "",
      targetPrice: null,
      summary: "",
      pdfUrl:
        r.FILE_YN === "Y"
          ? `https://www.sangsanginib.com/_upload/attFile/${CMS_CD}/${CMS_CD}_${r.NT_NO}_1.pdf`
          : null,
      views: typeof r.HIT === "number" ? r.HIT : null,
    });
  }
  await sleep(400);
}

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. API 구조가 바뀌었을 수 있음.");
  process.exit(1);
}
console.log(`✔ 파싱 완료: ${collected.length}건 (사이트 전체 ${total}건)`);
console.log(
  "  최근 3건:",
  collected.slice(0, 3).map((i) => `${i.date} ${i.stockName}(${i.symbol}) — ${i.title}`),
);

console.log(`▶ 투자의견·목표주가 추출 중 (${collected.length}건)...`);
for (const it of collected) {
  if (!it.pdfUrl) continue;
  const text = await pdfText(it.pdfUrl);
  if (text) {
    it.opinion = extractOpinion(text);
    it.targetPrice = extractTargetPrice(text);
  }
  await sleep(300);
}
console.log(
  `✔ 보강 완료 — 등급 ${collected.filter((i) => i.opinion).length}/${collected.length}` +
    ` · 목표주가 ${collected.filter((i) => i.targetPrice != null).length}/${collected.length}`,
);

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
  body: JSON.stringify({ items: collected, source: "상상인증권" }),
});
const body = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${body.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${body}`);
