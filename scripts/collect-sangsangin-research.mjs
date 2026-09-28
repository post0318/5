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
import { enrichResearch } from "./lib/research-extract.mjs";
import { isCommonExcludedContent } from "./lib/exclude-filters.mjs";

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
const BOARD_LABEL = "상상인증권 > 리서치 > 기업리포트(CM0079)"; // item 의 board 필드(분류 대조용)
const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://macroresearch.vercel.app/api/cron/total-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
// Vercel 배포 보호(Vercel Authentication)가 프로덕션에 켜져 있으면 앱에 닿기
// 전에 401 이 난다 — 자동화 우회 비밀값이 있으면 헤더로 같이 보낸다(없으면 생략).
const VERCEL_BYPASS = (ENV.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    if (isCommonExcludedContent(`${String(r.STOCK_NM ?? "").trim()} ${title}`, "기업")) continue;
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
      board: BOARD_LABEL,
    });
  }
  await sleep(400);
}

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. API 구조가 바뀌었을 수 있음.");
  // 0건은 실패가 아니다 — 주말·휴일이나 새 글이 없는 날에도 워크플로가 "실패"로
  // 찍혀 진짜 장애를 가리고 로컬 재실행 도구가 헛돌았다(감사 2026-09-28: 일요일
  // 8개 수집기 전부 거짓 실패). 경고만 남기고 정상 종료한다. 파서가 진짜 깨진
  // 경우는 DB 최신 날짜가 며칠째 안 움직이는 것으로 드러난다.
  console.log("::warning::파싱 결과 0건 — 새 글이 없거나 구조가 바뀌었을 수 있음");
  process.exit(0);
}
console.log(`✔ 파싱 완료: ${collected.length}건 (사이트 전체 ${total}건)`);
console.log(
  "  최근 3건:",
  collected.slice(0, 3).map((i) => `${i.date} ${i.stockName}(${i.symbol}) — ${i.title}`),
);

console.log(`▶ 투자의견·목표주가 추출 중 (${collected.length}건)...`);
// 공용 추출기(국내 규칙) — 본문 → PDF 순.
await enrichResearch(collected, { market: "kr", sleepMs: 300 });

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
  if (VERCEL_BYPASS) headers["x-vercel-protection-bypass"] = VERCEL_BYPASS;
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
