/**
 * 신한투자증권 "해외 산업 및 기업분석" 리포트 수집기 (미국 종목).
 *
 * 국내 수집기(collect-shinhan-research.mjs)와 같은 API 베이스(bbs2.shinhansec.com)
 * 인데 게시판만 다르다 — 화면(투자정보 > 투자전략 > 해외 산업 및 기업분석,
 * /siw/insights/global/foreignstock/view.do)의 Knockout.js 바인딩에 찍힌
 * `boardName=foreignstock` 을 그대로 bbs2 API 슬러그로 썼더니 바로 맞았다
 * (국내와 동일 페이징 방식: startId 커서, 오너가 화면 위치를 짚어줘 발견,
 * 2026-09).
 *
 * GlobalMonitor(자체 lscCd=700, 미국 전용) 대비 비교 실측(14일): GM 8건 vs
 * 이 게시판 34건 — GM 은 미국만 다루는데 이 게시판은 미국·일본·중국·유럽까지
 * 나온다. 이 프로젝트는 kr/us/jp 만 지원하므로(MarketId) 그중 미국(.US)만
 * 수집하고 나머지 시장은 건너뛴다(미래에셋 수집기와 동일 선택).
 *
 * 제목 형식 "종목명(TICKER.US)" 에서 티커를 뽑는다. PDF 표지에 "목표주가
 * (LSEG, 컨센서스) 248.8 달러"·"투자판단 ★★★★★" 처럼 실려 있다 — 후자는
 * 매수/매도 텍스트가 아니라 별점이라 등급 필드엔 못 쓰지만(실측 확인 — 전문에
 * 매수/매도 문구 자체가 없음), 전자는 공용 추출기(us-research-extract.mjs)의
 * 컨센서스 목표가 패턴으로 그대로 잡힌다 — "해외는 자사 목표가가 아니어도
 * 컨센서스가 있으면 표시"라는 정책(오너 확인, 2026-09)이 공용 모듈에 있다.
 *
 * ⚠️ bbs2.shinhansec.com/robots.txt 는 `Disallow: /` — 국내 수집기와 동일 조건
 *    (개인용·로컬 실행·저빈도)으로 예외 승인(CLAUDE.md 참조).
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-shinhan-overseas-research.mjs
 *   node scripts/collect-shinhan-overseas-research.mjs --days=90 --dry-run
 */

import { readFileSync } from "node:fs";
import { enrichUsResearch } from "./lib/us-research-extract.mjs";

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
// 이 게시판은 게시량이 많아(위클리·매크로·개별종목 뒤섞임) 10페이지로는
// 며칠치도 못 채운다(실측: pages=10 → 최근 65건이 90일에 한참 못 미침,
// pages=30 → 180건). 하루 1회 배치라 기본값을 넉넉히 잡는다.
const MAX_PAGES = Number(arg("pages")) || 30;

const BASE = "https://bbs2.shinhansec.com/bbs/list/foreignstock";
const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isoDate = (s) => {
  const m = String(s).trim().match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

// "종목명(TICKER.US)" — 국내와 달리 시장 접미사가 붙는다. US 만 받는다
// (JP·SH·DE 등은 이 프로젝트가 지원하지 않는 시장 — 미래에셋 수집기와 동일).
const TITLE_US_RE = /\(([A-Z][A-Z.]{0,5})\.US\)\s*$/;

const EXCERPT_LEN = 300;
function excerpt(text) {
  const flat = String(text ?? "")
    .replace(/&middot;/g, "·")
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

console.log(`▶ 신한투자증권 해외 기업분석 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
// 항목 날짜가 'YYYY-MM-DD'(=UTC 자정)라 컷오프도 자정으로 맞춘다.
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));
const collected = [];
let startId;
let stop = false;
let rawTotal = 0;

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
    rawTotal++;
    const tm = String(it.f2 ?? "").match(TITLE_US_RE);
    if (!tm) continue; // 미국 외 시장(JP/SH/DE 등) 또는 종목 없는 전략/위클리 리포트
    collected.push({
      id: String(it.fn),
      date,
      title: it.f1,
      stockName: String(it.f2 ?? "").replace(TITLE_US_RE, "").trim(),
      symbol: tm[1],
      analyst: it.f4 ?? "",
      opinion: "",
      targetPrice: null,
      summary: excerpt(it.f7),
      pdfUrl: it.f3 || null,
      views: Number(it.f5) || null,
    });
  }
  const pages = data.pageInfo?.pages ?? [];
  startId = pages.length > 1 ? pages[1] : undefined;
  if (!startId) break;
  await sleep(400); // 예의상 간격
}

if (collected.length === 0) {
  console.error(`✗ 종목 매핑 결과 0건(원본 ${rawTotal}건). 게시판 구조가 바뀌었을 수 있음.`);
  process.exit(1);
}
console.log(`✔ 파싱 완료: ${collected.length}건 (원본 ${rawTotal}건 중 미국 종목만)`);
console.log(
  "  최근 3건:",
  collected.slice(0, 3).map((i) => `${i.date} ${i.stockName}(${i.symbol}) — ${i.title}`),
);

await enrichUsResearch(collected);

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const items = collected.map((it) => ({
  id: it.id,
  date: it.date,
  title: it.title,
  stockName: it.stockName,
  symbol: it.symbol,
  analyst: it.analyst,
  opinion: it.opinion,
  targetPrice: it.targetPrice,
  summary: it.summary,
  pdfUrl: it.pdfUrl,
  views: it.views,
}));

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;
const up = await fetch(IMPORT_URL, {
  method: "POST",
  headers,
  body: JSON.stringify({ items, source: "신한투자증권", market: "us" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
