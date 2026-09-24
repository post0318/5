/**
 * 키움증권 리서치 수집기 — 국내·해외 여러 게시판을 한 번에 돈다.
 *
 * 오너가 목록 URL(`https://www3.kiwoom.com/h/invest/research/VAnalCCView`)과
 * 상세 URL(`https://www.kiwoom.com/h/invest/research/VAnalCCDetailView?sqno=`)을
 * 제시해 확인(2026-09) — 실제 콘텐츠는 `www.kiwoom.com`이 아니라 서브도메인
 * `bbn.kiwoom.com`에서 내려오고, 그 안의 JS(`fn_list`/`fn_detail`)가 부르는
 * 내부 AJAX를 역추적해 직접 호출한다. **로그인 불필요**, 응답은 UTF-8 JSON.
 *
 *  - 목록: POST /research/SResearch{rMenuGb}ListAjax
 *          { pageNo, stdate, eddate, f_keyField:"", f_key:"" }
 *          → { researchList: [...] }. 서버가 페이지당 15건 고정.
 *  - PDF:  GET /research/SPdfFileView?rMenuGb={rMenuGb}&attaFile={attaFile}&makeDt={makeDt}
 *          — 로그인 없이 바로 `application/pdf` 로 받아짐(실측 확인, 다른
 *          증권사 대부분이 로그인을 요구하는 것과 대조적).
 *
 * `rMenuGb` 2글자 게시판 코드는 사이트에 노출된 코드가 아니라 실측으로
 * 하나씩 찔러 `rMenuGbNm`(응답 필드)을 확인해 찾았다. 오너 지시(2026-09-24
 * — "기업분석 산업분석 스팟노트", "이슈분석은 제외한다", "키움 해외 ai보고서는
 * 종목분석에 해당된다", "키움 해외 글로벌테마/이슈는 투자전략(이슈)로 분류하고
 * 키차트는 연결대상에서 제외한다", "채권시장이슈는 수집대상에서 제외한다")에
 * 따라 이번에 수집하는 게시판은:
 *
 *   | rMenuGb | rMenuGbNm(실측)      | market | category | 비고 |
 *   |---------|----------------------|--------|----------|------|
 *   | CC      | 미국 산업/기업분석   | us     | 기업/산업| 기존(2026-09-24 최초 추가) |
 *   | AI      | AI 보고서            | us     | 기업     | "[AI 실적 리뷰] ... 종목명 (TICKER.US)" — 콜론 없이 끝에 티커 |
 *   | CA      | 글로벌 테마/이슈분석 | us     | 산업     | 라벨 고정 "투자전략(이슈)", "키차트" 포함 항목은 제외 |
 *   | CR      | 기업리포트(국내)     | kr     | 기업     | "종목명(6자리코드): 제목" |
 *   | SN      | 스팟노트(국내)       | kr     | 기업     | CR과 같은 제목 형식, 더 짧은 코멘트성 리포트 |
 *   | CI      | 산업분석(국내)       | kr     | 산업     | 대괄호/콜론 라벨 추출(공용 lib/label-extract.mjs) |
 *
 *   **의도적으로 뺀 게시판**(화이트리스트 방식이라 아래는 그냥 안 부른다 —
 *   블랙리스트 유지가 필요 없음): CS(이슈분석, 국내), QE(퀀트전략), SW(주간
 *   증시전망), SE(경제분석), BM(월간채권전망)/BW(주간채권전망, "채권시장이슈"
 *   제외 지시에 해당), CH(중화권), CJ(일본), TP(글로벌 ETF — 있었어도 ETF
 *   필터에 걸림), EM(월간증시전망), BC(디지털자산리서치).
 *
 * ETF/ETP 리포트는 게시판·시장 불문 공용 필터(`lib/exclude-filters.mjs`)로
 * 제외한다.
 *
 * `summary`는 대부분 `titl`과 동일하거나 더 짧아 별도 요약으로 쓸 가치가
 * 없다(실측 확인) — summary는 비워 두고, 미국(market:"us") 항목만 공용
 * 추출기(lib/us-research-extract.mjs)가 **PDF 본문**에서 투자의견·목표주가를
 * 채운다(usePdf:true — 로그인 없이 PDF를 받을 수 있는 몇 안 되는 소스).
 * 국내(market:"kr") 항목은 이 추출기가 달러 표기 기준이라 안 맞아 PDF
 * 보강을 하지 않는다(다른 국내 수집기들과 동일하게 opinion/targetPrice 공란).
 *
 * www3.kiwoom.com·bbn.kiwoom.com 모두 robots.txt 가 `Allow: /`(제한 없음) —
 * 지금까지 중 가장 깨끗한 케이스. 그래도 다른 예외들과 동일 조건(개인용·
 * 로컬 실행·저빈도)으로 진행.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-kiwoom-research.mjs
 *   node scripts/collect-kiwoom-research.mjs --days=30 --dry-run
 */

import { readFileSync } from "node:fs";
import { enrichUsResearch } from "./lib/us-research-extract.mjs";
import { isEtfOrEtpContent } from "./lib/exclude-filters.mjs";
import { industryLabelAndHeadline } from "./lib/label-extract.mjs";

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

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST_BASE = "https://bbn.kiwoom.com/research/SResearch";
const PDF_BASE = "https://bbn.kiwoom.com/research/SPdfFileView";
const PAGE_SIZE = 15; // 서버 고정값(실측 확인)

function isoDate(dotted) {
  const m = String(dotted).trim().match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// CC: "종목명 (TICKER.US): 헤드라인" — 기업. 안 걸리면 산업분석/투자전략
// 성격이라 대괄호/콜론 라벨로 수집(예: "[미국은 지금] ...").
const US_TICKER_RE = /^(.+?)\s*\(([A-Za-z0-9.-]{1,10})\.US\)\s*:\s*(.+)$/;
function parseUsTickerBoard(title) {
  const tm = title.match(US_TICKER_RE);
  if (tm) {
    const [, stockName, ticker, headline] = tm;
    return { title: headline.trim(), stockName: stockName.trim(), symbol: ticker.toUpperCase(), category: "기업" };
  }
  const { label, headline } = industryLabelAndHeadline(title);
  return { title: headline, stockName: label, symbol: null, category: "산업" };
}

// AI: "[AI 실적 리뷰] {분기라벨} 종목명 (TICKER.US)" — 콜론 없이 끝에 티커.
const AI_TICKER_RE = /^(.*?)\s*\(([A-Za-z0-9.-]{1,10})\.US\)\s*$/;
function parseAiBoard(title) {
  const cleaned = title.replace(/^\[AI\s*실적\s*리뷰\]\s*/, "").trim();
  const m = cleaned.match(AI_TICKER_RE);
  if (!m) return null; // 형식이 다른 예외 항목은 보수적으로 건너뜀
  const [, stockName, ticker] = m;
  return { title: "AI 실적 리뷰", stockName: stockName.trim(), symbol: ticker.toUpperCase(), category: "기업" };
}

// CA: 글로벌 테마/이슈분석 — "키차트"(단순 차트, 실측 확인)는 제외, 나머지는
// 라벨을 "투자전략(이슈)"로 고정(오너 지시 2026-09-24).
function parseGlobalThemeBoard(title) {
  if (/키차트/.test(title)) return null;
  return { title, stockName: "투자전략(이슈)", symbol: null, category: "산업" };
}

// CR/SN(국내): "종목명(6자리코드): 제목" — 콜론 대신 세미콜론을 쓰는 오타성
// 항목도 실측으로 확인돼 `[:;：]` 로 허용.
const KR_CODE_RE = /^(.+?)\s*\((\d{6})\)\s*[:;：]\s*(.+)$/;
function parseKrCompanyBoard(title) {
  const m = title.match(KR_CODE_RE);
  if (!m) return null; // 코드 없는 예외 항목은 보수적으로 건너뜀
  const [, stockName, code, headline] = m;
  return { title: headline.trim(), stockName: stockName.trim(), symbol: code, category: "기업" };
}

// CI(국내): 산업분석 — 대괄호/콜론 라벨 추출(공용 헬퍼, 삼성증권 수집기와 동일).
function parseKrIndustryBoard(title) {
  const { label, headline } = industryLabelAndHeadline(title);
  return { title: headline, stockName: label, symbol: null, category: "산업" };
}

// EM(국내 월간증시전망) 등 게시판 전체가 하나의 시리즈라 stockName을 고정
// 라벨로 둔다 — shinhan-research.ts의 STRATEGY_STOCKNAMES에 "키움
// 월간증시전망"/"키움 중장기증시전망"을, MARKET_CONDITION_STOCKNAMES에
// "키움 일간증시전망"을 등록해 각각 투자전략(주식)/시황으로 강제 분류한다
// (오너 지시 2026-09-24).
function fixedLabelBoardParser(label) {
  return (title) => ({ title, stockName: label, symbol: null, category: "산업" });
}

const BOARDS = [
  { rMenuGb: "CC", market: "us", parse: parseUsTickerBoard },
  { rMenuGb: "AI", market: "us", parse: parseAiBoard },
  { rMenuGb: "CA", market: "us", parse: parseGlobalThemeBoard },
  { rMenuGb: "CR", market: "kr", parse: parseKrCompanyBoard },
  { rMenuGb: "SN", market: "kr", parse: parseKrCompanyBoard },
  { rMenuGb: "CI", market: "kr", parse: parseKrIndustryBoard },
  { rMenuGb: "EM", market: "kr", parse: fixedLabelBoardParser("키움 월간증시전망") },
  { rMenuGb: "IM", market: "kr", parse: fixedLabelBoardParser("키움 중장기증시전망") },
  { rMenuGb: "SD", market: "kr", parse: fixedLabelBoardParser("키움 일간증시전망") },
];

async function fetchPage(rMenuGb, page) {
  const res = await fetch(`${LIST_BASE}${rMenuGb}ListAjax`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `https://bbn.kiwoom.com/research/VAnal${rMenuGb}View`,
      "User-Agent": UA,
    },
    body: new URLSearchParams({ pageNo: String(page), stdate: "", eddate: "", f_keyField: "", f_key: "" }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function collectBoard(board, cutoff) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await fetchPage(board.rMenuGb, page);
    const rows = data?.researchList ?? [];
    if (rows.length === 0) break;
    let stop = false;
    for (const r of rows) {
      const date = isoDate(r.makeDt);
      if (!date) continue;
      if (new Date(date) < cutoff) {
        stop = true;
        break;
      }
      const rawTitle = String(r.titl ?? "").trim();
      if (isEtfOrEtpContent(rawTitle)) continue; // ETF/ETP 공용 제외(오너 지시 2026-09-24)
      const parsed = board.parse(rawTitle);
      if (!parsed) continue;
      out.push({
        id: `${board.rMenuGb}:${r.sqno}`,
        date,
        title: parsed.title,
        stockName: parsed.stockName,
        symbol: parsed.symbol,
        market: board.market,
        category: parsed.category,
        analyst: r.workId ?? "",
        opinion: "",
        targetPrice: null,
        summary: "",
        pdfUrl: r.attaFile
          ? `${PDF_BASE}?rMenuGb=${board.rMenuGb}&attaFile=${encodeURIComponent(r.attaFile)}&makeDt=${encodeURIComponent(r.makeDt)}`
          : null,
        views: typeof r.readCnt === "number" ? r.readCnt : null,
      });
    }
    if (stop || rows.length < PAGE_SIZE) break;
    await sleep(300);
  }
  return out;
}

console.log(`▶ 키움증권 리서치 수집(${BOARDS.map((b) => b.rMenuGb).join("/")}): 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));
const collected = [];
for (const board of BOARDS) {
  const items = await collectBoard(board, cutoff);
  console.log(`  ${board.rMenuGb}(${board.market}): ${items.length}건`);
  collected.push(...items);
  await sleep(300);
}

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. 페이지 구조가 바뀌었을 수 있음.");
  process.exit(1);
}
console.log(`✔ 파싱 완료: 총 ${collected.length}건`);
console.log(
  "  샘플:",
  collected.slice(0, 8).map((i) => `[${i.market}/${i.category}] ${i.date} ${i.symbol ?? i.stockName} — ${i.title}`),
);

const usItems = collected.filter((it) => it.market === "us" && it.category !== "산업");
console.log(`▶ 투자의견/목표주가 조회 중 (PDF 포함, 로그인 불필요, 미국 종목만) — ${usItems.length}건...`);
await enrichUsResearch(usItems, { sleepMs: 400, usePdf: true });

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

// 시장별로 나눠 전송(라우트가 body당 market 하나만 받음 — GM/한경 스크립트의
// "source별로 나눠 전송"과 같은 패턴).
const byMarket = new Map();
for (const it of collected) {
  if (!byMarket.has(it.market)) byMarket.set(it.market, []);
  byMarket.get(it.market).push({
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
    category: it.category,
  });
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

let totalSent = 0;
for (const [market, items] of byMarket) {
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items, source: "키움증권", market }),
  });
  const upBody = await up.text();
  if (!up.ok) {
    console.error(`✗ [${market}] 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`✔ [${market}] 앱 전송 완료 (${items.length}건): ${upBody}`);
  totalSent += items.length;
}
console.log(`\n✔ 총 ${totalSent}건 전송 완료`);
