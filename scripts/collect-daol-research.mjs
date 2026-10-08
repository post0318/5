/**
 * 다올투자증권 리서치 수집기 — 기업(종목)·산업·경제/전략/채권·Morning Express(국내).
 * 조사 근거(오너 결정 2026-10-04 — "만들되 퀀트는 제외"):
 *  - www.daolsecurities.com/robots.txt 는 `Diallow:/img/keditor` 한 줄뿐(오타라 사실상 제한 없음). 로그인 없이 목록·PDF 가 열린다(실측).
 *    한경 컨센서스에도 다올 리포트가 없어(DB 0건) 직접 수집한다. 다른 수집기와 같은 조건(개인용·요청 간격 ≥400ms).
 *  - 화면(`/research/article/common.jspx?rGubun=&sctrGubun=&web=0`)은 목록을 내부 요청으로 채운다:
 *    POST `common.jspx?cmd=list&templet-bypass=true` + 폼(curPage·rGubun·sctrGubun·web·startDate·endDate=YYYY/MM/DD …),
 *    응답은 `<tr>` 조각(UTF-8), 전체 건수는 응답 헤더 `totCount`. 페이지당 10건.
 *  - 행: `<td>날짜</td>`, `fn_download_before('/attach_file/RESEARCH/{seq}/1', '{파일}.pdf', '{seq}')` 와 title 속성(전체 제목),
 *    `<td>조회수</td><td>작성자</td>`.
 *  - PDF: `/common/download.jspx?path=/attach_file/RESEARCH/{seq}/1/{파일}` 이 로그인 없이 내려온다(실측 application/octet-stream,
 *    %PDF). `/attach_file/...` 직접 경로는 404 로 돌려보낸다.
 *  - 게시판(rGubun/sctrGubun) → 앱 목적지:
 *    | 게시판               | 코드            | 제목 형식                               | 목적지                                   |
 *    |----------------------|-----------------|-----------------------------------------|------------------------------------------|
 *    | 기업(업종별 8개)     | I01 / I01~I08   | "오리온(271560) - 헤드라인"             | 국내 종목분석(category 기업)             |
 *    | 산업(업종별 6개)     | S01 / S01~S06   | "제약/바이오(Overweight) - 헤드라인"    | 국내 산업분석(괄호 앞 업종명 라벨)       |
 *    | 경제분석             | M01 / M01       |                                         | 이슈분석("다올 경제", 환율이면 FX)       |
 *    | 주식전략             | M01 / M02       | Market Weekly·캘린더는 공통 규칙으로 제외 | 투자전략("다올 투자전략", 월간은 Monthly) |
 *    | 채권전략·크레딧      | M01 / M03·M06   |                                         | 이슈분석("다올 채권") — 크레딧은 공통 제외 |
 *    | 파생                 | M01 / M04       |                                         | 이슈분석("다올 파생")                    |
 *    | 퀀트                 | M01 / M05       |                                         | **수집 안 함**(오너 결정)                |
 *    | Morning Express      | X01 / X01       |                                         | 시황 Daily("다올 시황")                  |
 *    기업분석·산업분석 코멘터리(C01)는 3개월 0건이라 넣지 않았다.
 *  - 목록에 요약이 없다 → PDF 텍스트에서 발췌(서버 디스크 캐시라 회차마다 다시 받지 않음), 기업은 공용 추출기로 의견·목표가.
 *  - 공통 제외: ETF/ETP·ESG·주간물·일정표·추천종목·퀀트 등(`isCommonExcludedContent`).
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-daol-research.mjs
 *   node scripts/collect-daol-research.mjs --days=14 --dry-run
 */

import { readFileSync } from "node:fs";
import { enrichResearch, readPdfText, excerptFromPdfText } from "./lib/research-extract.mjs";
import { isCommonExcludedContent, isFxContent } from "./lib/exclude-filters.mjs";
import { appUrl } from "./lib/app-url.mjs";
import { appSendFailed, exitNoItems } from "./lib/collector-status.mjs";

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
const MAX_PAGES = Number(ARGS.find((a) => a.startsWith("--pages="))?.split("=")[1]) || 10;

const IMPORT_URL = (ENV.SHINHAN_RESEARCH_IMPORT_URL || `${appUrl(ENV)}/api/cron/total-research`).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const GAP_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = "https://www.daolsecurities.com";
const SOURCE = "다올투자증권";

// kind: company(종목) | industry(업종) | fixed(고정 라벨)
const BOARDS = [
  ...["I01", "I02", "I03", "I04", "I05", "I06", "I07", "I08"].map((s) => ({ r: "I01", s, kind: "company", label: "기업" })),
  ...[["S01", "통신/미디어"], ["S02", "IT"], ["S03", "소재"], ["S04", "산업재"], ["S05", "금융"], ["S06", "내수"]].map(([s, sector]) => ({ r: "S01", s, kind: "industry", label: "산업", sector })),
  { r: "M01", s: "M01", kind: "fixed", label: "경제분석", stockName: "다올 경제", fx: true },
  { r: "M01", s: "M02", kind: "fixed", label: "주식전략", stockName: "다올 투자전략" },
  { r: "M01", s: "M03", kind: "fixed", label: "채권전략", stockName: "다올 채권", fx: true },
  { r: "M01", s: "M04", kind: "fixed", label: "파생", stockName: "다올 파생" },
  { r: "M01", s: "M06", kind: "fixed", label: "크레딧", stockName: "다올 채권" },
  { r: "X01", s: "X01", kind: "fixed", label: "Morning Express", stockName: "다올 시황" },
];

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", hellip: "…" };
const decode = (s) =>
  String(s ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .trim();
const slash = (d) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;

/** 목록 한 페이지 → [{seq, date, title, views, analyst, pdfUrl}] */
async function fetchPage(b, page, start, end) {
  await sleep(GAP_MS);
  const body = new URLSearchParams({
    curPage: String(page), bbSeq: "", rGubun: b.r, sctrGubun: b.s, web: "0", hts: "", filepath: "", attaFileNm: "",
    startDate: start, endDate: end, searchSelect: "1", searchNm1: "", searchNm2: "",
  });
  const res = await fetch(`${BASE}/research/article/common.jspx?cmd=list&templet-bypass=true`, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Referer: `${BASE}/research/article/common.jspx?rGubun=${b.r}&sctrGubun=${b.s}&web=0` },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const total = Number(res.headers.get("totCount") ?? 0);
  const rows = [];
  for (const tr of html.split(/<\/tr>/i)) {
    const a = tr.match(/fn_download_before\('([^']+)',\s*'([^']+)',\s*'(\d+)'\)[^>]*title="([^"]*)"/);
    if (!a) continue;
    const tds = [...tr.matchAll(/<td[^>]*>([^<]*)<\/td>/gi)].map((m) => decode(m[1]));
    const date = (tds.find((t) => /^\d{4}\/\d{2}\/\d{2}$/.test(t)) ?? "").replace(/\//g, "-");
    rows.push({
      seq: a[3],
      date,
      title: decode(a[4]),
      views: Number(tds[tds.length - 2]) || 0,
      analyst: tds[tds.length - 1] ?? "",
      pdfUrl: `${BASE}/common/download.jspx?path=${a[1]}/${encodeURIComponent(a[2])}`,
    });
  }
  return { rows, total };
}

/** 게시판·제목 → 앱 분류. null 이면 건너뜀 */
function classify(row, b) {
  const t = row.title;
  if (b.kind === "company") {
    const m = t.match(/^(.+?)\s*\((\d{6})\)\s*[-–]\s*(.+)$/);
    if (m) return { category: "기업", stockName: m[1].trim(), symbol: m[2], title: m[3].trim() };
    // 코드 없는 글(해외기업 등) — 회사명만 뽑고 서버 이름 검색에 맡긴다
    const n = t.match(/^(.+?)\s*[-–]\s*(.+)$/);
    return { category: "기업", stockName: (n?.[1] ?? t).trim(), symbol: null, title: (n?.[2] ?? t).trim() };
  }
  if (b.kind === "industry") {
    // "제약/바이오(Overweight) - 헤드라인" 이 기본. 앞부분이 길면(제목 속 하이픈 — "다올 선박: VLCC …, 200K - CBM …") 업종명이 아니다 →
    // "X: …" 접두어나 게시판 업종명을 라벨로, 제목은 원문 그대로.
    const m = t.match(/^(.{1,20}?)(?:\s*\(([^)]*)\))?\s*[-–]\s*(.+)$/);
    if (m && !/[:：]/.test(m[1])) return { category: "산업", stockName: m[1].trim(), symbol: null, title: m[3].trim() };
    const colon = t.match(/^([^:：]{2,12})[:：]\s*/);
    // "다올 선박: …" 같은 시리즈명은 회사명 접두어를 떼고 업종명으로(선박 → 조선)
    const label = (colon?.[1] ?? b.sector).replace(/^다올s*/, "").trim().replace(/^선박$/, "조선");
    return { category: "산업", stockName: label || b.sector, symbol: null, title: t };
  }
  // 주식전략 게시판에 섞인 "Morning Brief_8/28" 은 매일 나오는 시황 — 시황 Daily
  if (/mornings*brief/i.test(t)) return { category: "산업", stockName: "다올 시황", symbol: null, title: t };
  const stockName = b.fx && isFxContent(t) ? `${b.stockName} FX` : b.stockName;
  return { category: "산업", stockName, symbol: null, title: t };
}

console.log(`▶ 다올투자증권 리서치 수집: 최근 ${DAYS}일(퀀트 제외)`);
const end = new Date();
const startD = new Date(Date.now() - DAYS * 86_400_000);
const cutoff = startD.toISOString().slice(0, 10);
const collected = [];
let excluded = 0;
for (const b of BOARDS) {
  let got = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let r;
    try {
      r = await fetchPage(b, page, slash(startD), slash(end));
    } catch (e) {
      console.error(`  ✗ ${b.label}(${b.r}/${b.s}) ${page}쪽: ${e.message}`);
      break;
    }
    for (const row of r.rows) {
      if (!row.date || row.date < cutoff) continue;
      const c = classify(row, b);
      if (!c) continue;
      if (isCommonExcludedContent(`${c.stockName} ${row.title}`, c.category, "kr")) {
        excluded++;
        continue;
      }
      collected.push({ id: row.seq, date: row.date, market: "kr", analyst: row.analyst, views: row.views, pdfUrl: row.pdfUrl, opinion: "", targetPrice: null, summary: "", board: `${b.label}(${b.r}/${b.s})`, ...c });
      got++;
    }
    if (r.rows.length < 10 || page * 10 >= r.total) break;
  }
  if (got) console.log(`  ${b.label}(${b.r}/${b.s}): ${got}건`);
}
console.log(`  공통 제외 ${excluded}건`);

if (collected.length === 0) exitNoItems({ market: "kr", label: "daol" });

// 요약 발췌: PDF 텍스트(디스크 캐시) 앞부분. 기업은 같은 텍스트로 의견·목표가 추출.
console.log(`▶ PDF 발췌·투자의견/목표주가 (${collected.length}건)...`);
for (const it of collected) {
  const text = await readPdfText(it.pdfUrl);
  it.summary = excerptFromPdfText(text, 300);
  if (it.category === "기업") it.pdfText = text;
}
await enrichResearch(collected.filter((i) => i.category === "기업"), { market: "kr", sleepMs: GAP_MS, usePdf: true });
for (const it of collected) delete it.pdfText;

for (const i of collected) {
  console.log(`  [${i.board}] ${i.date} ${i.symbol ?? "-"} ${i.stockName}${i.opinion ? ` (${i.opinion})` : ""}${i.targetPrice != null ? ` TP ${i.targetPrice}` : ""} — ${i.title} [${i.analyst}]`);
}
if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;
const items = collected.map((it) => ({
  id: it.id, date: it.date, title: it.title, stockName: it.stockName, symbol: it.symbol, analyst: it.analyst,
  opinion: it.opinion, targetPrice: it.targetPrice, summary: it.summary, pdfUrl: it.pdfUrl, views: it.views,
  category: it.category, board: `다올투자증권 > ${it.board}`,
}));
const up = await fetch(IMPORT_URL, { method: "POST", headers, body: JSON.stringify({ items, source: SOURCE, market: "kr" }) });
const upBody = await up.text();
if (appSendFailed(up, upBody)) {
  console.error(`✗ [${SOURCE}/kr] 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`✔ [${SOURCE}/kr] 앱 전송 완료 (${items.length}건): ${upBody}`);
