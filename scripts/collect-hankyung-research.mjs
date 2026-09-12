/**
 * 한경 컨센서스(consensus.hankyung.com) — 로컬 수집기.
 *
 * 한국경제신문이 거의 모든 증권사의 리포트를 한곳에 모아놓은 통합 목록.
 * "제공출처" 컬럼에 실제 작성 증권사명이 그대로 나와 여러 증권사를 한 번에
 * 커버한다(신한·하나·한화·유안타·교보 개별 스크립트를 대체하진 않고 보완 —
 * 같은 리포트가 두 소스에 중복 저장될 수 있음, source 로 구분되니 UI에서는
 * 중복 배지로 보일 뿐 기능상 문제는 없음). 로그인 없이 평범한 GET, 페이지네이션도
 * `&now_page=N`. "기업" 분류 제목이 "종목명(코드) 제목" 형식이라 이름 검색 없이
 * 코드를 바로 뽑는다. PDF 다운로드도 로그인 없이 바로 열림(`/analysis/downpdf?
 * report_idx=N`, 확인됨).
 *
 * ⚠️ consensus.hankyung.com/robots.txt 는 `Disallow: /` 다. 이 사이트는 개별
 *    증권사의 "자사 리서치 공개"가 아니라 한국경제신문이 여러 증권사 자료를
 *    재가공한 3자 편집 서비스라는 점이 다른 예외들과 다름 — 오너가 이 차이를
 *    인지한 상태로 "개인용·로컬 실행·저빈도" 조건 예외 승인(CLAUDE.md 참조).
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-hankyung-research.mjs
 *   node scripts/collect-hankyung-research.mjs --days=14 --pages=10 --dry-run
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
const DAYS = Number(ARGS.find((a) => a.startsWith("--days="))?.split("=")[1]) || 7;
const MAX_PAGES = Number(ARGS.find((a) => a.startsWith("--pages="))?.split("=")[1]) || 10;

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim(); // 로컬 수동 실행 시 CRON_SECRET 없어도 인증 가능(라우트가 x-app-token도 허용)
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST_URL = "https://consensus.hankyung.com/analysis/list";
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function fetchPage(page, sdate, edate) {
  const url = new URL(LIST_URL);
  url.searchParams.set("sdate", sdate);
  url.searchParams.set("edate", edate);
  url.searchParams.set("now_page", String(page));
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// 행 하나 = 일자, 분류, 제목(+report_idx), ...(레이어팝업)..., 작성자, 제공출처.
const ROW_RE =
  /<td[^>]*class="[^"]*txt_number[^"]*">(\d{4}-\d{2}-\d{2})<\/td>\s*<td>([^<]*)<\/td>\s*<td class="text_l">\s*<a href="\/analysis\/downpdf\?report_idx=(\d+)"[^>]*>([^<]+)<\/a>[\s\S]{0,600}?<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>/g;

// 기업 리포트 제목: "종목명(코드) 나머지 제목" — 산업/시장/파생/경제는 코드 없음.
const TITLE_RE = /^(.+?)\((\d{6})\)\s*(.*)$/;

function parseItems(html) {
  const items = [];
  for (const m of html.matchAll(ROW_RE)) {
    const [, date, category, reportIdx, rawTitle, analyst, source] = m;
    if (!category.includes("기업")) continue; // 산업/시장/파생/경제 등 종목 아닌 리포트 제외
    const title = stripHtml(rawTitle);
    const tm = title.match(TITLE_RE);
    if (!tm) continue; // 종목코드 형식이 아니면(드묾) 건너뜀
    items.push({
      id: reportIdx,
      date,
      title,
      stockName: tm[1].trim(),
      symbolHint: tm[2],
      analyst: stripHtml(analyst),
      source: stripHtml(source),
      pdfUrl: `https://consensus.hankyung.com/analysis/downpdf?report_idx=${reportIdx}`,
    });
  }
  return items;
}

console.log(`▶ 한경 컨센서스 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
const now = new Date();
const sdate = ymd(new Date(now.getTime() - DAYS * 86_400_000));
const edate = ymd(now);
const collected = [];
for (let page = 1; page <= MAX_PAGES; page++) {
  const html = await fetchPage(page, sdate, edate);
  const items = parseItems(html);
  if (items.length === 0) break;
  collected.push(...items);
  await sleep(400);
}

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. 페이지 구조가 바뀌었을 수 있음.");
  process.exit(1);
}
console.log(`✔ 파싱 완료: ${collected.length}건`);
console.log(
  "  최근 5건:",
  collected.slice(0, 5).map((i) => `${i.date} ${i.stockName}(${i.symbolHint}) [${i.source}] — ${i.title}`),
);
if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

// /api/cron/shinhan-research 는 body 최상위 하나의 source만 받아 그 안의 모든
// items에 적용한다. 이 스크립트는 항목마다 작성 증권사(제공출처)가 달라서,
// 실제 출처가 정확히 표시되도록(예: "iM증권") 증권사별로 그룹핑해 나눠 보낸다.
// _id 충돌 방지를 위해 접두어를 "한경:" 로 네임스페이스(원 증권사 스크립트의
// _id 체계와 겹치지 않게).
const bySource = new Map();
for (const it of collected) {
  const key = it.source || "한경컨센서스";
  if (!bySource.has(key)) bySource.set(key, []);
  bySource.get(key).push({
    id: `한경:${it.id}`,
    date: it.date,
    title: it.title,
    stockName: it.stockName,
    symbol: it.symbolHint,
    analyst: it.analyst,
    opinion: "",
    summary: "",
    pdfUrl: it.pdfUrl,
    views: null,
  });
}

let totalUpserted = 0;
for (const [source, group] of bySource) {
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items: group, source }),
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
