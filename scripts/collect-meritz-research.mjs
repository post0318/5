/**
 * 메리츠증권 리서치 수집기 — 국내 기업분석·산업분석·투자전략 + 경제·채권
 * (거시경제 이슈분석). 오너 결정 2026-09-25.
 *
 * ── 조사 근거(실측 2026-09-25) ─────────────────────────────────────────
 * - PC 홈페이지 메뉴(*.do)는 로그인이 필요하지만, 그 화면들이 쓰는 **게시판
 *   엔진은 로그인 없이 열린다**:
 *     GET https://home.imeritz.com/bbs/BbsList.go?bbsGrpId=bascGrp&bbsId={게시판}
 *         &listCnt=100&pageNum=P
 *   서버렌더 HTML(UTF-8), 쿠키·리퍼러 불필요. pageNum 이 실제로 동작하고
 *   listCnt=100 이면 한 번에 약 7주치가 나온다.
 * - 게시판(`*main` 은 첫 화면 미리보기라 쓰지 않는다):
 *     | bbsId    | 사이트 분류 | 제목 형식                      | 앱 목적지                         |
 *     |----------|-------------|--------------------------------|-----------------------------------|
 *     | invest02 | 기업분석    | "종목명(6자리코드):헤드라인"   | 국내 종목분석(category "기업")    |
 *     |          |  (미국 종목 혼재) | "Apple (AAPL.US):…"·"GM(GM US):…" | 미국 종목분석(market "us", 2026-09-27 추가) |
 *     | invest03 | 산업분석    | "업종명 :헤드라인"             | 국내 산업분석(stockName=업종명)   |
 *     | sih02    | 투자전략    | "시리즈명 :헤드라인"           | 국내 산업분석 > 투자전략/시황     |
 *     | sih02anl | 경제분석    | "시리즈명 :헤드라인"           | 거시경제 > 이슈분석/환율분석(kr_research) |
 *     | sih02bon | 채권분석    | "시리즈명 :헤드라인"           | 거시경제 > 이슈분석/환율분석(kr_research) |
 *   게시판마다 열 순서가 달라(작성자·작성일 위치, 날짜 표기 YYYY/MM/DD 와
 *   YYYY.MM.DD 혼재) 표 머리글(th)로 열 위치를 찾는다.
 * - sih02(투자전략) 목록에는 경제·채권 게시판 글이 같은 글번호로 섞여 나온다
 *   (Policy Watcher·The Bond Weekly·데이터 경제脈 등, 실측 100건 중 27건 중복).
 *   경제·채권 게시판을 먼저 읽고 그 글번호는 투자전략에서 뺀다.
 * - 투자전략 분류(오너 결정 — 삼성증권과 같은 기준): stockName 을 고정 라벨
 *   "메리츠 투자전략"으로 두고, 데일리 시황 시리즈("Meritz Strategy Daily")만
 *   "메리츠 Strategy Daily"(시황)로 둔다. 두 라벨은
 *   `src/lib/db/shinhan-research.ts` 의 STRATEGY_/MARKET_CONDITION_STOCKNAMES
 *   에 등록돼 있어야 확정 분류된다.
 * - 상세: GET /bbs/BbsRead.go?bbsGrpId=bascGrp&bbsId=…&bbsCnttTurnNo=N
 *   &listCnt=10&pageNum=1&searchDiv=&searchText= (listCnt·pageNum 등이 빠지면
 *   오류 페이지). 상세 HTML 에 PDF 직링크
 *   `home.imeritz.com/include/resource/research/WorkFlow/{타임스탬프}K_02.pdf`
 *   가 있고 쿠키 없이 받아진다(%PDF 확인). 목록에는 PDF 링크가 없어 항목마다
 *   상세를 한 번 연다(400ms 간격). pdfUrl 은 PDF 직링크(https)가 1순위, PDF 가
 *   없는 글만 상세 URL 로 폴백(오너 결정 2026-09-25).
 * - 투자의견·목표주가·요약은 목록/상세에 구조화 필드가 없다 → 공용 추출기
 *   (`lib/research-extract.mjs`)가 PDF 에서 읽는다("투자의견 Buy를 유지",
 *   "적정주가 (12개월) 2,200,000원" 형식, 실측 확인).
 * - robots.txt 파일 자체가 없다(요청하면 오류 페이지로 302). 다른 예외들과
 *   같은 조건(개인용·저빈도)으로 진행. 로그인은 하지 않는다.
 *
 * ── 공통 제외(오너 지시) ────────────────────────────────────────────────
 * ETF/ETP("Q-ETF Weekly")·ESG("ESG Focus"·"The ESGVerse")·주간물("The Bond
 * Weekly"·"조선 Weekly")·일정표·추천종목·원자재 외 대체투자는 버리고, 원자재
 * 글은 기업 리포트가 아니면 거시경제 이슈분석으로 보낸다.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-meritz-research.mjs
 *   node scripts/collect-meritz-research.mjs --days=14 --dry-run
 */

import { readFileSync } from "node:fs";
import { enrichResearch, readPdfText } from "./lib/research-extract.mjs";
import { isEtfOrEtpContent, isEsgContent, isCommonExcludedContent, isCommodityContent, isFxContent } from "./lib/exclude-filters.mjs";
import { promoteKrIndustryToStock } from "./lib/company-match.mjs";
import { parseOverseasTitle, parseOverseasPdfHeader, resolveUsTickerByName } from "./lib/overseas-market.mjs";
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
// --no-enrich: 목표주가·투자의견 PDF 추출을 건너뜀(분류만 빠르게 확인할 때 — PDF 파싱이 메모리를 많이 씀).
const NO_ENRICH = ARGS.includes("--no-enrich");
const DAYS = Number(ARGS.find((a) => a.startsWith("--days="))?.split("=")[1]) || 3;
const MAX_PAGES = 5;

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://macroresearch.vercel.app/api/cron/total-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GAP_MS = 400;

const BASE = "https://home.imeritz.com";
const SOURCE = "메리츠증권";
const STRATEGY_LABEL = "메리츠 투자전략";
// 경제·채권을 먼저 읽는다 — 투자전략 목록에 섞인 같은 글번호를 거르기 위해.
const BOARDS = [
  { bbsId: "sih02anl", label: "경제분석", kind: "macro" },
  { bbsId: "sih02bon", label: "채권분석", kind: "macro" },
  { bbsId: "invest02", label: "기업분석", kind: "company" },
  { bbsId: "invest03", label: "산업분석", kind: "industry" },
  { bbsId: "sih02", label: "투자전략", kind: "strategy" },
];

// "삼성전기(009150):헤드라인", "피엠티(147760):탐방노트: …"
const COMPANY_TITLE_RE = /^(.+?)\s*\((\d{6})\)\s*[:：]\s*(.+)$/;
// 해외 종목: "Apple (AAPL.US):…"·"General Motors(GM US):…"·"TSMC (TSM.NY):…"(미국) · "(7203.JP)"(일본) · "(2330.TT)"(대만→중국) ·
// "(OR FP)"·"(ICOS IM)"(유럽) — 시장 판별은 공통 lib(scripts/lib/overseas-market.mjs). 티커가 제목에 없는 영문 종목명
// ("Albemarle:…"·"First Solar:…"·"Valero Energy:…")은 이름→티커 조회(미국만 인정, 오너 지시 2026-09-27)로 잡는다.
// 데일리 시황 시리즈 — 시황으로 확정 분류.
const DAILY_SERIES_RE = /^Meritz\s+Strategy\s+Daily\b/i;
// 공용 ESG 필터(\bESG\b)가 못 잡는 붙여쓰기 시리즈명("The ESGVerse").
const ESG_SERIES_RE = /ESG/i;

function decode(s) {
  return String(s ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normDate(s) {
  const m = String(s).match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
}

function listUrl(bbsId, page) {
  return `${BASE}/bbs/BbsList.go?bbsGrpId=bascGrp&bbsId=${bbsId}&listCnt=100&pageNum=${page}`;
}
function readUrl(bbsId, no) {
  return `${BASE}/bbs/BbsRead.go?bbsGrpId=bascGrp&bbsId=${bbsId}&bbsCnttTurnNo=${no}&listCnt=10&pageNum=1&searchDiv=&searchText=`;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

/** 목록 HTML → 행 배열. 머리글(th)로 열 위치를 찾는다(게시판마다 순서가 다름). */
function parseRows(html, bbsId) {
  const head = html.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] ?? "";
  const cols = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => decode(m[1]));
  const idx = (re) => cols.findIndex((c) => re.test(c));
  const iAuthor = idx(/^작성자/);
  const iDate = idx(/^작성일/);
  const iViews = idx(/^조회/);
  const iStock = idx(/^종목명/);
  const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  const rows = [];
  for (const tr of body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    const link = tr[1].match(new RegExp(`bbsId=${bbsId}&amp;bbsCnttTurnNo=(\\d+)[^"]*">([\\s\\S]*?)</a>`));
    if (!link) continue;
    rows.push({
      no: link[1],
      title: decode(link[2]),
      analyst: iAuthor >= 0 ? decode(tds[iAuthor]) : "",
      date: iDate >= 0 ? normDate(decode(tds[iDate])) : null,
      views: iViews >= 0 ? Number(decode(tds[iViews]).replace(/,/g, "")) || null : null,
      stockCol: iStock >= 0 ? decode(tds[iStock]) : "",
    });
  }
  return rows;
}

/** 기간 안의 행을 모을 때까지 페이지를 넘긴다(listCnt=100 이면 보통 1페이지). */
async function fetchBoardRows(board, cutoffYmd) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows = parseRows(await fetchText(listUrl(board.bbsId, page)), board.bbsId);
    await sleep(GAP_MS);
    if (rows.length === 0) break;
    out.push(...rows.filter((r) => r.date && r.date >= cutoffYmd));
    const oldest = rows.map((r) => r.date).filter(Boolean).sort()[0];
    if (!oldest || oldest < cutoffYmd) break;
  }
  return out;
}

/** 상세 페이지에서 PDF 직링크(https). 없으면 null. */
async function fetchPdfUrl(bbsId, no) {
  try {
    const html = await fetchText(readUrl(bbsId, no));
    const m = html.match(/https?:\/\/home\.imeritz\.com\/include\/resource\/research\/WorkFlow\/[^'"\s<>]+\.pdf/i);
    return m ? m[0].replace(/^http:/i, "https:") : null;
  } catch {
    return null;
  }
}

function isExcluded(title) {
  if (isEtfOrEtpContent(title)) return true;
  if (isEsgContent(title)) return true;
  if (ESG_SERIES_RE.test(industryLabelAndHeadline(title).label)) return true;
  return false;
}

// 원자재 글은 어느 게시판이든 거시경제 이슈분석으로(리서치 분류 체계 전면
// 개편 2026-09-26 — 고정 stockName으로 kr_research 합류).
function commodityItem(base, title) {
  const isFx = isFxContent(title);
  return {
    ...base,
    title,
    stockName: isFx ? "메리츠 원자재 FX" : "메리츠 원자재",
    symbol: null,
    category: "산업",
  };
}

/** 행 → 항목(리서치는 category, 이슈분석은 topic). null 이면 버림. */
async function classify(row, board) {
  const { title } = row;
  const base = {
    id: `${board.bbsId}:${row.no}`,
    no: row.no,
    bbsId: board.bbsId,
    date: row.date,
    analyst: row.analyst,
    opinion: "",
    targetPrice: null,
    summary: "",
    pdfUrl: null,
    views: row.views,
    market: "kr",
    board: board.bbsId,
  };
  if (isExcluded(title)) return null;
  // "9월 하반월 LCD 패널가" 같은 정기 패널가 업데이트 — 오너 지시 2026-09-27 "LCD패널가 수집제외".
  // 목록 제목은 "디스플레이:9월 하반월 LCD 패널가"처럼 업종 라벨이 앞에 붙어 나와 헤드라인만 비교한다.
  if (/^\d{1,2}월\s*(?:상|하)반월\s*LCD\s*패널가$/.test(industryLabelAndHeadline(title).headline.trim())) return null;
  // "Meritz Overnight Tech" 정기 데일리(반도체/디스플레이, 김선우) — 오너 지시 2026-09-27 "수집제외".
  if (/^Meritz\s*Overnight\s*Tech\b/i.test(industryLabelAndHeadline(title).headline.trim())) return null;
  // "Mobility at a glance" 정기 데일리(모빌리티, 김준성) — 오너 지시 2026-09-27 "수집제외".
  if (/^Mobility\s*at\s*a\s*glance\b/i.test(industryLabelAndHeadline(title).headline.trim())) return null;
  // "Morning Talk" 정기 데일리(음식료, 김정욱) — 오너 지시 2026-09-27 "수집제외".
  if (/^Morning\s*Talk\b/i.test(industryLabelAndHeadline(title).headline.trim())) return null;
  // "Daily (날짜)" 정기 데일리(금융·조선/기계 등 업종 불문, 오너 지시 2026-09-27 "수집제외" — 반복 확인).
  if (/^Daily\s*\(\d{4}[.\s]*\d{1,2}[.\s]*\d{1,2}\)$/i.test(industryLabelAndHeadline(title).headline.trim())) return null;
  // "Try Everything 2026" 시리즈 — 스타트업 얘기라 국내 비상장(오너 지적 2026-09-27 — "AI 스타트업의
  // 확산 국내 비상장이다"). 종목분석>인사이트와 같은 인프라(INSIGHT_SOURCES 재사용)로 별도 source 전송.
  if (/^Try\s*Everything\b/i.test(title)) {
    const { headline } = industryLabelAndHeadline(title);
    return { ...base, title: headline, stockName: headline, symbol: null, category: "산업", unlisted: true };
  }
  // "AI 속도 조절 제안에 대한 생각"(황수욱, 메리츠 투자전략) — 오너 확인 2026-09-27 "us 산업이다".
  // 목록 제목은 "메리츠 투자전략:AI 속도 조절 제안에 대한 생각"처럼 시리즈명이 앞에 붙어 나와 헤드라인만 비교한다.
  if (industryLabelAndHeadline(title).headline.trim() === "AI 속도 조절 제안에 대한 생각") {
    return { ...base, title: "AI 속도 조절 제안에 대한 생각", stockName: "글로벌 AI", symbol: null, category: "산업", market: "us" };
  }

  if (board.kind === "company") {
    const ov = parseOverseasTitle(title);
    if (ov) {
      if (isCommonExcludedContent(title, "기업")) return null;
      return { ...base, title: ov.headline, stockName: ov.name, symbol: ov.symbol, category: "기업", market: ov.market };
    }
    const m = title.match(COMPANY_TITLE_RE);
    if (m) {
      // 종목 리포트엔 대체투자 규칙을 걸지 않는다(category "기업").
      if (isCommonExcludedContent(title, "기업")) return null;
      return { ...base, title: m[3].trim(), stockName: m[1].trim(), symbol: m[2], category: "기업" };
    }
    // 티커 없는 영문 종목명("Albemarle: …") — 종목명 칸이 비어 있고 콜론 앞이 영문 회사명일 때만 이름→티커 조회.
    const nm = !row.stockCol && title.match(/^([A-Za-z][A-Za-z0-9 .&'-]{3,40}?)\s*[:：]\s*(.+)$/);
    if (nm) {
      const hit = await resolveUsTickerByName(nm[1]);
      if (hit && !isCommonExcludedContent(title, "기업")) {
        return { ...base, title: nm[2].trim(), stockName: hit.stockName, symbol: hit.symbol, category: "기업", market: "us" };
      }
    }
    // 코드 없는 글은 산업으로(종목명 열 값이 있으면 라벨로).
    if (isCommonExcludedContent(title)) return null;
    if (isCommodityContent(title)) return commodityItem(base, title);
    const { label, headline } = industryLabelAndHeadline(title);
    return { ...base, title: headline, stockName: row.stockCol || label, symbol: null, category: "산업" };
  }

  if (isCommonExcludedContent(title)) return null;
  // 공용 FX 판정(오너 지적 2026-09-25) — 경제·채권 게시판이 FX 분기 없이 전부
  // 이슈분석으로만 갔다. 리서치 분류 체계 전면 개편(2026-09-26)으로
  // macro_issues 컬렉션 폐지 — 고정 stockName(shinhan-research.ts
  // FORCED_ISSUE_STOCKNAMES/FORCED_FX_STOCKNAMES 등록)으로 kr_research에 합류.
  if (board.kind === "macro") {
    const isFx = isFxContent(title);
    const label = board.bbsId === "sih02bon" ? "메리츠 채권분석" : "메리츠 경제분석";
    return { ...base, title, stockName: isFx ? `${label} FX` : label, symbol: null, category: "산업" };
  }
  if (isCommodityContent(title)) return commodityItem(base, title);

  if (board.kind === "industry") {
    const { label, headline } = industryLabelAndHeadline(title);
    return { ...base, title: headline, stockName: label || "산업", symbol: null, category: "산업" };
  }
  // "Meritz Strategy Daily" 는 같은 날 "Strategy Idea" 글에 "[전략공감 2.0]" 을 붙여 다시
  // 올리는 중복 게시라 수집하지 않는다(오너 결정 2026-09-25 — "메리츠는 제외").
  if (DAILY_SERIES_RE.test(title)) return null;
  // strategy — 시리즈명을 떼고 헤드라인만 제목으로(시리즈는 고정 라벨로 대체).
  const { headline } = industryLabelAndHeadline(title);
  return {
    ...base,
    title: headline,
    stockName: STRATEGY_LABEL,
    symbol: null,
    category: "산업",
  };
}

console.log(`▶ 메리츠증권 리서치 수집(${BOARDS.map((b) => b.label).join("·")}): 최근 ${DAYS}일`);
const cutoffYmd = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);

const collected = [];
const macroNos = new Set();
const seen = new Set();
for (const board of BOARDS) {
  const rows = await fetchBoardRows(board, cutoffYmd);
  let kept = 0;
  let dupSkipped = 0;
  let excluded = 0;
  for (const row of rows) {
    if (board.kind === "macro") macroNos.add(row.no);
    else if (board.kind === "strategy" && macroNos.has(row.no)) {
      dupSkipped++;
      continue;
    }
    const it = await classify(row, board);
    if (!it) {
      excluded++;
      continue;
    }
    // 같은 리포트를 두 번 올린 경우(실측: KT&G 2026-09-18 글번호 14505·14506,
    // 제목 콜론 앞 공백만 다름) — 목록이 최신순이라 먼저 나온(나중에 올린) 글만 둔다.
    const key = `${board.bbsId}|${it.date}|${it.symbol ?? it.stockName ?? ""}|${it.title}`;
    if (seen.has(key)) {
      dupSkipped++;
      continue;
    }
    seen.add(key);
    collected.push(it);
    kept++;
  }
  console.log(
    `  ${board.label}(${board.bbsId}): 목록 ${rows.length}건 → 수집 ${kept}건 (제외 ${excluded}` +
      (dupSkipped ? `, 중복 ${dupSkipped}` : "") +
      ")",
  );
}

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. 페이지 구조가 바뀌었을 수 있음.");
  process.exit(1);
}

// PDF 직링크 — 상세 페이지 1회씩(목록엔 PDF 링크가 없다).
console.log(`▶ 상세 페이지에서 PDF 링크 조회 — ${collected.length}건...`);
let noPdf = 0;
for (const it of collected) {
  const pdf = await fetchPdfUrl(it.bbsId, it.no);
  if (pdf) it.pdfUrl = pdf;
  else {
    it.pdfUrl = readUrl(it.bbsId, it.no); // PDF 없는 글만 상세 URL 폴백
    noPdf++;
  }
  await sleep(GAP_MS);
}
console.log(`✔ PDF 링크 ${collected.length - noPdf}/${collected.length}건 (없음 ${noPdf}건 → 상세 URL)`);

// 산업 게시판에 섞인 종목 리포트를 종목분석으로 승격(공통 lib — 목표주가 추출 전에).
for (let i = 0; i < collected.length; i++) collected[i] = promoteKrIndustryToStock(collected[i]);
// 기업분석 게시판인데 제목에 티커가 없어 산업으로 떨어진 글("2Q26 Review", 라벨만 "CATL") — PDF 첫머리의 "이름 (3750 HK)" 로 종목을
// 확정한다(오너 지적 2026-09-27). 시장을 아는 거래소만 승격, 모르는 거래소(사우디 "2222 AB")는 산업에 두고 로그로 남긴다.
if (!NO_ENRICH) {
  for (let i = 0; i < collected.length; i++) {
    const it = collected[i];
    if (it.category !== "산업" || it.symbol || it.market !== "kr" || it.board !== "invest02") continue;
    if (!/\.pdf(\?|$)/i.test(it.pdfUrl ?? "")) continue;
    const hdr = parseOverseasPdfHeader(await readPdfText(it.pdfUrl));
    if (!hdr) continue;
    if (!hdr.market) {
      console.log(`  ⚠ 거래소 미상(${hdr.name} ${hdr.ticker} ${hdr.suffix}) — 산업 유지: ${it.title}`);
      continue;
    }
    if (isCommonExcludedContent(it.title, "기업")) continue;
    collected[i] = { ...it, category: "기업", market: hdr.market, stockName: hdr.name, symbol: hdr.symbol };
  }
}
const research = collected;
console.log(`✔ 파싱 완료: ${research.length}건`);

// 투자의견·목표주가 — 공용 추출기가 PDF 에서 읽는다(목록·상세에 구조화 필드 없음).
const stockItems = research.filter((it) => it.category === "기업" && it.market === "kr");
const usStockItems = research.filter((it) => it.category === "기업" && it.market === "us");
console.log(`▶ 투자의견/목표주가 조회 중 (PDF, 로그인 불필요) — 국내 ${stockItems.length}건 · 미국 ${usStockItems.length}건...`);
if (!NO_ENRICH) await enrichResearch(stockItems, { market: "kr", sleepMs: GAP_MS, usePdf: true });
if (usStockItems.length && !NO_ENRICH) await enrichResearch(usStockItems, { market: "us", sleepMs: GAP_MS, usePdf: true });

for (const i of collected) {
  console.log(
    `  [${i.board}→${i.topic ?? `${i.market}/${i.category}`}] ${i.date} ${i.symbol ?? i.stockName ?? ""}` +
      `${i.opinion ? `(${i.opinion})` : ""}${i.targetPrice != null ? ` TP ${i.targetPrice}` : ""} — ${i.title} [${i.analyst}]`,
  );
}

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

// 라우트가 POST 1회당 source·market 하나만 받는다. "Try Everything" 비상장 시리즈는
// 일반 산업분석 풀과 안 섞이도록 "메리츠증권 비상장리서치"로 따로 보낸다(오너 지시 2026-09-27).
const UNLISTED_SOURCE = "메리츠증권 비상장리서치";
const byGroup = new Map();
for (const it of research) {
  const source = it.unlisted ? UNLISTED_SOURCE : SOURCE;
  const key = `${it.market}::${source}`;
  if (!byGroup.has(key)) byGroup.set(key, { market: it.market, source, items: [] });
  byGroup.get(key).items.push({
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
    // 원 게시판(사이트 메뉴) — 대조·검수용. it.board 는 게시판 코드(bbsId).
    board: `메리츠증권 > ${BOARDS.find((b) => b.bbsId === it.board)?.label ?? it.board}(${it.board})`,
  });
}
for (const { market, source, items } of byGroup.values()) {
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items, source, market }),
  });
  const upBody = await up.text();
  if (!up.ok) {
    console.error(`✗ [${source}/${market}] 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`✔ [${source}/${market}] 앱 전송 완료 (${items.length}건): ${upBody}`);
}
