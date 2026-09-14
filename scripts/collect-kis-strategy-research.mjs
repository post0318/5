/**
 * 한국투자증권 "전략/이슈 리포트" 게시판(jkGubun=6) 수집기 — 산업분석/투자
 * 전략/시황 전용, 종목 무관(category:"산업", symbol 항상 null).
 *
 * 기존 두 KIS 수집기(collect-kis-research.mjs=jkGubun=10 기업/산업분석,
 * collect-kis-global-research.mjs=jkGubun=7 해외기업분석)와는 별개 게시판 —
 * 오너가 URL을 직접 제시해 발견(2026-09, "전략/이슈 리포트에 미국 산업분석,
 * 투자전략, 시황이 있는데 반영 안 된 이유는?"). 목록 HTML 구조(`<li>`,
 * `doDetail('id')`, `body_tit`/`body_sub`/`tit_info`)는 기존 두 수집기와
 * 동일한 Strategy.jsp 템플릿이라 그대로 재사용.
 *
 * 이 게시판만의 차이: 종목 티커가 아예 없고, 각 항목 앞에 `<div class="head
 * ...">라벨</div>`로 "채권분석 Note"/"투자전략Note"/"글로벌전략 Note"/
 * "자산배분전략 Note"/"경제분석 Note"/"대체투자 Note"/"계량 Weekly" 같은
 * 시리즈 라벨이 이미 붙어있다(실측) — 이 라벨을 stockName으로 그대로 쓰면
 * classifyResearchTopic()의 "전략"/"Weekly" 키워드 매칭과 자연스럽게 맞는다.
 *
 * 시장 분류: 이 게시판은 KIS 사이트 자체 메뉴명이 "전략/이슈 리포트"로
 * 국가 구분이 없는 일반 게시판이라(해외 전용 메뉴가 아님) 국내(엔화·중국 등
 * 타국 언급)·해외(미국 CPI·FOMC 등)·중립(자산배분 일반론) 콘텐츠가 섞여
 * 있다(실측). 미국 신호어가 있으면 us, 다른 나라가 명시되면 스킵(이
 * 프로젝트는 국내 브로커의 일본향 콘텐츠까지 jp 로 편입하지 않음 — 별도
 * 파이프라인), 국가 신호가 아예 없는 일반 매크로/전략은 국내 브로커의
 * 국내향 시각으로 보고 kr 기본값(키워드 추측, 완전하지 않음 — 미래에셋과
 * 동일한 트레이드오프).
 *
 * ⚠️ 접근 조건은 다른 KIS 수집기와 동일(CLAUDE.md 참고): robots.txt
 *    Disallow: / — 개인용·로컬 실행·저빈도 조건으로 오너 승인.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-kis-strategy-research.mjs
 *   node scripts/collect-kis-strategy-research.mjs --days=30 --pages=5 --dry-run
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
const DAYS = Number(ARGS.find((a) => a.startsWith("--days="))?.split("=")[1]) || 3;
const MAX_PAGES = Number(ARGS.find((a) => a.startsWith("--pages="))?.split("=")[1]) || 6;

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim(); // 로컬 수동 실행 시 CRON_SECRET 없어도 인증 가능(라우트가 x-app-token도 허용)
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST_URL = "https://securities.koreainvestment.com/main/research/research/Strategy.jsp";
const PAGE_SIZE = 50;

function isoDate(dotted) {
  const m = String(dotted).trim().match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function stripHtml(s) {
  return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s{2,}/g, " ").trim();
}
const EXCERPT_LEN = 300;
function excerpt(text) {
  return text.length > EXCERPT_LEN ? `${text.slice(0, EXCERPT_LEN)}…` : text;
}

const NON_US_RE = /중국|차이나|China|일본|엔화|엔캐리|Japan|유럽|Europe|베트남|Vietnam|인도(?!네시아)|India\b|신흥국|이머징|Emerging|브라질|Brazil|대만|Taiwan/i;
const US_HINT_RE = /미국|\bUS\b|나스닥|Nasdaq|S&P|다우|연준|\bFed\b|FOMC|월가|Wall Street/i;
function classifyMarket(text) {
  if (NON_US_RE.test(text)) return null; // 미국 외 특정국가 — 이 수집기는 미국/국내 외엔 다루지 않음(건너뜀)
  if (US_HINT_RE.test(text)) return "us";
  return "kr"; // 국가 신호 없는 일반 매크로·자산배분 전략은 국내 브로커의 국내향 시각으로 간주
}

async function fetchPage(page) {
  const url = new URL(LIST_URL);
  url.searchParams.set("jkGubun", "6");
  url.searchParams.set("rowsPerPages", String(PAGE_SIZE));
  url.searchParams.set("currentPage", String(page));
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function parseItems(html) {
  const items = [];
  for (const chunk of html.split("<li>").slice(1)) {
    const idM = chunk.match(/doDetail\('(\d+)'\)/);
    const headM = chunk.match(/<div class="head[^"]*">\s*([^<]+?)\s*<\/div>/);
    const titleM = chunk.match(/<span class="body_tit">\s*([^<]+?)\s*<\/span>/);
    const summaryM = chunk.match(/<span class="body_sub">\s*([\s\S]*?)\s*<\/span>/);
    const analystM = chunk.match(/<em>([^<]*)<\/em>\s*<em>([\d.]+)<\/em>/);
    if (!idM || !titleM || !analystM) continue;
    const date = isoDate(analystM[2]);
    if (!date) continue;

    const label = headM ? headM[1].trim() : "전략/이슈";
    let title = titleM[1].trim();
    // 제목이 라벨과 같은 말로 시작하면("채권분석:9월 FOMC...") 중복 제거.
    const labelNorm = label.replace(/\s|Note/gi, "");
    const pm = title.match(/^([^:：]+)[:：]\s*(.+)$/);
    if (pm && pm[1].replace(/\s/g, "") === labelNorm) title = pm[2].trim();

    const summary = summaryM ? excerpt(stripHtml(summaryM[1])) : "";
    const market = classifyMarket(`${label} ${title} ${summary}`);
    if (!market) continue;

    items.push({
      id: idM[1],
      date,
      title,
      stockName: label,
      analyst: analystM[1].trim(),
      summary,
      market,
      detailUrl: `https://securities.koreainvestment.com/main/research/research/StrategyDetail.jsp?jkGubun=6&id=${idM[1]}`,
    });
  }
  return items;
}

console.log(`▶ 한국투자증권 전략/이슈 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));
const collected = [];
let stop = false;
for (let page = 1; page <= MAX_PAGES && !stop; page++) {
  const html = await fetchPage(page);
  // classifyMarket 필터 때문에 items.length===0 이 페이지 끝을 뜻하지 않을 수
  // 있어(그 페이지 항목이 전부 필터에 걸렸을 수 있음) 원본(필터 전) 항목
  // 존재 여부로 페이지 끝을 판정한다.
  const rawCount = (html.match(/doDetail\('\d+'\)/g) ?? []).length;
  if (rawCount === 0) break;
  const items = parseItems(html);
  let pageStop = false;
  for (const it of items) {
    if (new Date(it.date) < cutoff) {
      pageStop = true;
      continue;
    }
    collected.push(it);
  }
  // 날짜 컷오프 판정은 원본(필터 전) 항목의 날짜로 — 필터로 다 걸러진 페이지도
  // 계속 다음 페이지로 넘어가야 하므로 items가 아니라 별도로 원본 날짜를 본다.
  const rawDates = [...html.matchAll(/<em>[^<]*<\/em>\s*<em>([\d.]+)<\/em>/g)]
    .map((m) => isoDate(m[1]))
    .filter(Boolean);
  if (rawDates.length && new Date(Math.min(...rawDates.map((d) => new Date(d).getTime()))) < cutoff) {
    stop = true;
  }
  void pageStop;
  await sleep(400);
}

if (collected.length === 0) {
  console.log("○ 최근 기간 내 항목 없음(필터 통과 0건).");
  process.exit(0);
}
console.log(`✔ 파싱 완료: ${collected.length}건`);
console.log(
  "  최근 5건:",
  collected.slice(0, 5).map((i) => `${i.date} [${i.market}] [${i.stockName}] ${i.title}`),
);

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const byMarket = new Map();
for (const it of collected) {
  if (!byMarket.has(it.market)) byMarket.set(it.market, []);
  byMarket.get(it.market).push(it);
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

for (const [market, group] of byMarket) {
  const payload = group.map((it) => ({
    id: it.id,
    date: it.date,
    title: it.title,
    stockName: it.stockName,
    symbol: null,
    analyst: it.analyst,
    opinion: "",
    targetPrice: null,
    summary: it.summary,
    pdfUrl: it.detailUrl,
    views: null,
    category: "산업",
  }));
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items: payload, source: "한국투자증권", market }),
  });
  const upBody = await up.text();
  if (!up.ok) {
    console.error(`✗ 앱 전송 실패(market=${market}) HTTP ${up.status}: ${upBody.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`\n✔ 앱 전송 완료(market=${market}, ${payload.length}건): ${upBody}`);
}
