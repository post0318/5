/**
 * GlobalMonitor(einfomax.co.kr) — 한국 증권사들의 "미국주식" 리포트 통합 수집기.
 *
 * 오너가 `https://globalmonitor.einfomax.co.kr/ds_mobile_new.html#/USA/6/01`
 * 를 직접 확인해 발견(2026-09) — 연합인포맥스(Yonhap Infomax)가 운영하는
 * 증권사 리서치 통합 열람 서비스로, 키움·신한·유진·한화·대신·유안타·DB증권 등
 * 다수 증권사의 "미국주식" 분류 리포트를 한곳에 모아준다(한경 컨센서스가
 * 국내주식을 모아주는 것과 같은 성격, 다른 3자 편집 서비스). 페이지 자체는
 * AngularJS 1.4.9 레거시 SPA라 내부 JS 번들(module_constants_base_bundle.js)에서
 * 카테고리 코드(lscCd/sscCd)를, module_controller_m_bundle.js 에서 실제 호출
 * 파라미터(cmd:"rl_011" 등)를 역추적해 확인. 로그인 없이 POST 하나로 목록을
 * 받고, PDF도 로그인 없이 바로 열림(`rreport.einfomax.co.kr/report/{secureId}.pdf`,
 * 확인됨).
 *
 * ⚠️ globalmonitor.einfomax.co.kr 은 robots.txt 자체가 없음(404) — 가장 깨끗한
 *    케이스. 오너가 URL을 직접 제시하며 사용을 지시해 예외 승인(CLAUDE.md 참조).
 *
 * 제목이 "[종목명 (거래소:티커)] 제목" 형식(예: "[오라클 (NYS:ORCL)] 내 돈
 * 말고, 고객 돈으로")이라 티커를 바로 뽑는다 — 이름 검색 불필요. 이 형식이
 * 아닌 항목(채권/경제/시황 등 종목 무관 리포트, 예: "DB Morning Express",
 * "미국 주식 데일리 뉴스")은 건너뜀. summary 필드에 이미 정리된 한국어 요약
 * 문단이 있어(다른 소스 대비 품질 좋음) 그대로 저장.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-globalmonitor-research.mjs
 *   node scripts/collect-globalmonitor-research.mjs --days=14 --pages=5 --dry-run
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
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim(); // 로컬 수동 실행 시 CRON_SECRET 없어도 인증 가능(라우트가 x-app-token도 허용)
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST_URL = "https://globalmonitor.einfomax.co.kr/bizrpt/reportlist";
const PAGE_SIZE = 50;
// module_constants_base_bundle.js 의 bizrptCodelist.usa_all 값(역추적 확인).
const USA_ALL = { lscCd: 700, sscCd: "524910,521090,523050,523070" };

// "[종목명 (거래소:티커)] 제목" — 거래소는 NYS/NAS 등, 표시엔 안 쓰고 티커만 사용.
const TITLE_RE = /^\[(.+?)\s*\(([A-Z]{2,5}):([A-Z.]+)\)\]\s*(.*)$/;

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const EXCERPT_LEN = 300;
function excerpt(text) {
  const flat = String(text ?? "").replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  return flat.length > EXCERPT_LEN ? `${flat.slice(0, EXCERPT_LEN)}…` : flat;
}

async function fetchPage(page, startDate) {
  const res = await fetch(LIST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=UTF-8", "User-Agent": UA },
    body: JSON.stringify({
      targetPeriodCheck: false,
      page,
      pagePerItem: PAGE_SIZE,
      sortType: "date",
      lscCd: USA_ALL.lscCd,
      targetPeriodDate: null,
      sscCd: USA_ALL.sscCd,
      authSscCd: 0,
      cmd: "rl_011",
      startDate,
      searchItem: "",
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.res) throw new Error(`API 응답 실패: ${JSON.stringify(json).slice(0, 200)}`);
  return json.reportlist ?? [];
}

function parseItems(rows) {
  const items = [];
  for (const r of rows) {
    const tm = String(r.title ?? "").match(TITLE_RE);
    if (!tm) continue; // 종목코드 없는 채권/경제/시황 리포트 — 건너뜀
    const [, stockName, , ticker, headline] = tm;
    const dateM = String(r.writeDate ?? "").match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    if (!dateM) continue;
    items.push({
      id: r.rptId,
      date: `${dateM[1]}-${dateM[2]}-${dateM[3]}`,
      title: headline.trim() || stockName.trim(),
      stockName: stockName.trim(),
      symbolHint: ticker,
      analyst: r.writer ?? "",
      source: r.auth ?? "",
      summary: excerpt(r.summary),
      pdfUrl: r.secureId ? `https://rreport.einfomax.co.kr/report/${r.secureId}.pdf` : null,
    });
  }
  return items;
}

console.log(`▶ GlobalMonitor 미국주식 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
const cutoff = new Date(Date.now() - DAYS * 86_400_000);
const startDate = ymd(new Date(Date.now() - DAYS * 86_400_000));
const collected = [];
let stop = false;
for (let page = 1; page <= MAX_PAGES && !stop; page++) {
  const rows = await fetchPage(page, startDate);
  if (rows.length === 0) break;
  const items = parseItems(rows);
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
  "  최근 5건:",
  collected.slice(0, 5).map((i) => `${i.date} [${i.source}] ${i.stockName}(${i.symbolHint}) — ${i.title}`),
);
if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

// 증권사(제공출처)별로 그룹핑해 나눠 전송 — 라우트가 body당 source 하나만 받음
// (한경 컨센서스 스크립트와 동일 패턴).
const bySource = new Map();
for (const it of collected) {
  const key = it.source || "GlobalMonitor";
  if (!bySource.has(key)) bySource.set(key, []);
  bySource.get(key).push({
    id: `GM:${it.id}`,
    date: it.date,
    title: it.title,
    stockName: it.stockName,
    symbol: it.symbolHint,
    analyst: it.analyst,
    opinion: "",
    summary: it.summary,
    pdfUrl: it.pdfUrl,
    views: null,
  });
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

let totalUpserted = 0;
for (const [source, group] of bySource) {
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items: group, source, market: "us" }),
  });
  const upBody = await up.text();
  if (!up.ok) {
    console.error(`✗ [${source}] 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 200)}`);
    continue;
  }
  console.log(`✔ [${source}] ${group.length}건 전송: ${upBody}`);
  totalUpserted += group.length;
}
console.log(`\n✔ 총 ${totalUpserted}건 전송 완료 (${bySource.size}개 증권사)`);
