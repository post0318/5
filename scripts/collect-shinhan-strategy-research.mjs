/**
 * 신한투자증권 "투자전략"(boardName=gicomment, 화면 메뉴명 "주식전략")·
 * "경제분석"(boardName=gieconomy) 게시판 수집기 — 종목 무관(category:"산업",
 * symbol 항상 null).
 *
 * 기업분석(gicompanyanalyst)·산업분석(giindustry)과 같은 bbs2.shinhansec.com
 * JSON API — 오너가 실제 화면 URL(`/siw/insights/strategy/gicomment/view.do`,
 * `/siw/insights/strategy/gieconomy/view.do`)을 제시해 발견(2026-09). 두
 * 게시판 모두 f2(종목명 필드)가 공백이고 제목 구분자 패턴이 동일해 한
 * 스크립트에서 같이 처리한다.
 *
 * 이 게시판은 f2(종목명 필드)가 항상 공백이고, 대신 제목 자체에 "라벨;
 * 헤드라인"(예: "국내주식전략; 신한 M.R.I: 삼각수렴...") 또는 "라벨 -
 * 헤드라인"(예: "마켓레이더 - WTI 102$...") 두 가지 구분자가 섞여 쓰인다
 * (실측). 국내/시황/전략 성격이 제목 앞부분에 이미 드러나 있어 그대로
 * stockName으로 살리고, 실제 topic 분류는 다른 소스와 동일하게
 * classifyResearchTopic()의 키워드 판정에 맡긴다.
 *
 * 시장 분류: "국내"로 시작하면 kr, 미국/글로벌 신호가 있으면 us, 중국·일본
 * 등 다른 나라가 명시되면 스킵(이 수집기는 미국 전용), 그 외(신호 없는
 * 일반 시황 코멘트)는 kr 기본값 — 다른 신규 수집기(하나 글로벌 산업분석,
 * 한국투자·NH 전략 게시판)와 동일한 트레이드오프.
 *
 * ⚠️ 접근 조건은 다른 신한 수집기와 동일(CLAUDE.md 참조): robots.txt
 *    Disallow: / — 개인용·로컬 실행·저빈도 조건으로 오너 승인.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-shinhan-strategy-research.mjs
 *   node scripts/collect-shinhan-strategy-research.mjs --days=30 --pages=10 --dry-run
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
const MAX_PAGES = Number(ARGS.find((a) => a.startsWith("--pages="))?.split("=")[1]) || 10;

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim(); // 로컬 수동 실행 시 CRON_SECRET 없어도 인증 가능(라우트가 x-app-token도 허용)

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BOARDS = ["gicomment", "gieconomy"];

const isoDate = (s) => {
  const m = String(s).trim().match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

function decodeEntities(s) {
  return s
    .replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;|&mdash;/g, "-")
    .replace(/&middot;/g, "·")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const EXCERPT_LEN = 300;
function excerpt(text) {
  const flat = decodeEntities(String(text ?? ""))
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return flat.length > EXCERPT_LEN ? `${flat.slice(0, EXCERPT_LEN)}…` : flat;
}

// "국내주식전략; 신한 M.R.I: ..." / "마켓레이더 - WTI 102$..." 두 구분자 형식.
const SEMI_RE = /^([^;]+);\s*(.+)$/;
const DASH_RE = /^(\S[^-]{0,20}\S)\s*-\s*(.+)$/;
function splitLabel(title) {
  const sm = title.match(SEMI_RE);
  if (sm) return { label: sm[1].trim(), rest: sm[2].trim() };
  const dm = title.match(DASH_RE);
  if (dm) return { label: dm[1].trim(), rest: dm[2].trim() };
  return { label: "투자전략", rest: title };
}

const NON_US_RE =
  /중국|차이나|China|일본|엔화|엔캐리|Japan|유럽|Europe|베트남|Vietnam|인도(?!네시아)|India\b|신흥국|이머징|Emerging|브라질|Brazil|대만|Taiwan/i;
const US_HINT_RE =
  /미국|\bUS\b|나스닥|Nasdaq|S&P|다우|연준|\bFed\b|FOMC|월가|Wall Street|글로벌|Global/i;
function classifyMarket(label, title) {
  if (/^국내/.test(label) || /^국내/.test(title)) return "kr";
  if (NON_US_RE.test(`${label} ${title}`)) return null;
  if (US_HINT_RE.test(`${label} ${title}`)) return "us";
  return "kr"; // 국가 신호 없는 일반 시황 코멘트는 국내 브로커의 국내향 시각으로 간주
}

async function fetchPage(board, curPage, startId) {
  const url = new URL(`https://bbs2.shinhansec.com/bbs/list/${board}`);
  url.searchParams.set("v", String(Date.now()));
  url.searchParams.set("curPage", String(curPage));
  url.searchParams.set("startPage", String(curPage));
  if (startId) url.searchParams.set("startId", startId);
  const res = await fetch(url, { headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.includes("errorWrapper")) throw new Error(`게시판 API 404(구조 변경?): ${board}`);
  return JSON.parse(text);
}

console.log(`▶ 신한투자증권 투자전략/경제분석 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지 × ${BOARDS.length}개 게시판`);

const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));
const collected = [];

for (const board of BOARDS) {
  let startId;
  let stop = false;
  for (let page = 1; page <= MAX_PAGES && !stop; page++) {
    const data = await fetchPage(board, page, startId);
    const list = data.list ?? [];
    if (list.length === 0) break;
    for (const it of list) {
      const date = isoDate(it.f0);
      if (!date) continue;
      if (new Date(date) < cutoff) {
        stop = true;
        break;
      }
      const rawTitle = decodeEntities(String(it.f1 ?? "")).trim();
      const { label, rest } = splitLabel(rawTitle);
      const market = classifyMarket(label, rawTitle);
      if (!market) continue; // 미국 외 특정국가 — 스킵

      collected.push({
        id: String(it.fn),
        date,
        title: rest,
        stockName: label,
        market,
        analyst: it.f4 ?? "",
        summary: excerpt(it.f7),
        pdfUrl: it.f3 || null,
        views: Number(it.f5) || null,
      });
    }
    const pages = data.pageInfo?.pages ?? [];
    startId = pages.length > 1 ? pages[1] : undefined;
    if (!startId) break;
    await sleep(400);
  }
}

if (collected.length === 0) {
  console.log("○ 최근 기간 내 항목 없음.");
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
    pdfUrl: it.pdfUrl,
    views: it.views,
    category: "산업",
  }));
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items: payload, source: "신한투자증권", market }),
  });
  const upBody = await up.text();
  if (!up.ok) {
    console.error(`✗ 앱 전송 실패(market=${market}) HTTP ${up.status}: ${upBody.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`\n✔ 앱 전송 완료(market=${market}, ${payload.length}건): ${upBody}`);
}
