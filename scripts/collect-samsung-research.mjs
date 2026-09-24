/**
 * 삼성증권 리서치 수집기 — 해외기업/해외산업(미국) + 국내기업/국내산업/
 * 투자전략/시황 + 경제·채권(거시경제 이슈분석).
 *
 * 오너가 POP(www.samsungpop.com) "투자정보 > 해외주식 > 해외주식투자정보"
 * 화면을 제시해 확인(2026-09-24). 이 화면 자체는 레거시 frameset + XCMS
 * 메뉴 시스템(코드 → URL 매핑이 서버 세션에서 동적으로 채워지는 구조,
 * NH/미래에셋과 유사)이라 메뉴코드로는 콘텐츠 URL을 못 찾았지만, **모바일
 * 리포트 검색 화면**(`/mbw/invest/investInfo.do?cmd=report_search`)이 훨씬
 * 단순한 서버렌더 HTML이라 그 검색 폼을 그대로 GET 으로 호출한다:
 *
 *   GET /mbw/search/search.do?cmd=report_search&GUBUN={구분}&startDate=...
 *       &endDate=...&searchField=TITLE&range=A&periodType=1&moreCheck=N
 *
 * 응답에 최근 리포트가 구분별 최대 30건(실측) 서버렌더 HTML로 그대로
 * 들어있다 — 로그인 불필요.
 *
 * **GUBUN(화면 "리포트 구분" 드롭다운) 전체와 앱 목적지** — 국내·전략·시황·
 * 매크로 게시판은 오너 지시(2026-09-25)로 추가:
 *
 *   | GUBUN     | 사이트 분류            | 앱 목적지                                   |
 *   |-----------|------------------------|---------------------------------------------|
 *   | company2  | 해외기업               | 미국 종목분석(티커) / 그 외 미국 산업분석    |
 *   | industry2 | 해외산업               | 미국 산업분석                               |
 *   | chief     | 해외주식 Chief's Note  | 미국 종목분석(모바일 검색엔 현재 0건)        |
 *   | company1  | 국내기업               | 국내 종목분석("종목명(코드/의견): 제목")     |
 *   | spot2     | SPOT코멘트(기업)       | 국내 종목분석(현재 0건)                      |
 *   | industry1 | 국내산업               | 국내 산업분석                               |
 *   | market    | 투자전략               | 국내 산업분석 > 투자전략(주식)              |
 *   | issue     | 이슈리포트             | 국내 산업분석 > 투자전략(주식)              |
 *   | spot1     | SPOT코멘트(전략)       | 국내 산업분석 > 투자전략(주식)(현재 0건)     |
 *   | daily     | Daily시황              | 국내 산업분석 > 시황                         |
 *   | economy   | 경제                   | 거시경제 > 이슈분석(macro_issues)            |
 *   | bond      | 채권                   | 거시경제 > 이슈분석(macro_issues)            |
 *   | premium   | 프리미엄               | 국내 산업분석(최근 글 2022-12 — 사실상 휴면) |
 *   | invest·futures | 주간투자정보·선물옵션 | 미수집                                     |
 *
 * chief·spot1·spot2 는 모바일 검색이 기간을 넓혀도 0건이다(실측
 * 2026-09-25) — 등록만 해 두고, 결과가 나오기 시작하면 그대로 수집된다.
 *
 * **전 게시판 공통 제외·전환(오너 지시, 2026-09-25)** — "추천종목과 주간물은
 * 수집대상에서 제외", "캘린더 등 일정표는 수집 제외", "대체투자에서 원자재만
 * 거시경제>이슈분석으로 수집": 추천종목(퀀트 모델 추천 종목 등)·주간물
 * (Weekly/주간/Week Ahead/"9월 4주 차" 등)·일정표(캘박·캘린더)·대체투자
 * (리츠 PF·캠코 펀드 등)는 버리고, 원자재 글(Commodity Issues·원자재 시장
 * 전망 등)은 어느 게시판에서 나왔든 거시경제 이슈분석으로 보낸다. 종목
 * 리포트("종목명(코드/의견)"·"(TICKER US)")에는 이 규칙을 걸지 않는다.
 *
 * 투자전략·시황은 게시판 단위로 확정 분류하려고 stockName 을 고정 라벨
 * ("삼성증권 투자전략"/"삼성증권 SPOT코멘트(전략)"/"삼성증권 이슈리포트"/
 * "삼성증권 Daily시황")로
 * 두고 `src/lib/db/shinhan-research.ts` 의 STRATEGY_/MARKET_CONDITION_
 * STOCKNAMES 에 등록했다(키움 월간증시전망·KB데일리와 같은 방식). 국내
 * 비상장 기업("BPMG (비상장): …")은 다른 증권사와 같이
 * `source:"삼성증권 비상장리서치"`(국내 인사이트)로 보낸다.
 *
 * **PDF는 로그인 없이 받아진다(실측 확인)** — 모바일 화면의
 * `downloadPdf()` 함수 자체는 "로그인 후 이용 가능합니다" 확인창을 띄우는
 * 로그인 게이트 UI지만, 그 함수가 넘겨받는 `fileName` 값을 레거시 다운로드
 * 엔드포인트에 직접 넣으면(`common.do?cmd=down&saveKey=research.pdf&
 * fileName=...`) 오늘 날짜 파일도 그대로 200으로 받아진다 — UI만 로그인을
 * 요구할 뿐 엔드포인트 자체는 열려 있는 경우(다른 소스에서도 나온 패턴).
 *
 * 해외 제목은 "(작성자) 종목명 (TICKER US): 헤드라인" 형식(작성자 접두어는
 * dd의 세 번째 span과 중복이라 제거, 종목-티커 구분은 "TICKER.US"가 아니라
 * "TICKER US"로 공백 — 다른 증권사와 다름)이라 그 패턴에서 티커를 뽑는다.
 * 안 걸리는 항목(예: "글로벌 포트폴리오 전략(9월 4주 차)...", "글로벌 AI/SW:
 * ...")은 종목 얘기가 아닌 산업분석/투자전략 성격이라 `category:"산업"`으로
 * 수집(symbol 항상 null).
 *
 * www.samsungpop.com/robots.txt 는 `Allow: /`(제한 없음) — 가장 깨끗한
 * 케이스. 그래도 다른 예외들과 동일 조건(개인용·로컬 실행·저빈도)으로 진행.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-samsung-research.mjs
 *   node scripts/collect-samsung-research.mjs --days=30 --dry-run
 */

import { readFileSync } from "node:fs";
import { enrichUsResearch } from "./lib/us-research-extract.mjs";
import { isEtfOrEtpContent, isEsgContent, isCommonExcludedContent, isCommodityContent } from "./lib/exclude-filters.mjs";
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

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://macroresearch.vercel.app/api/cron/shinhan-research"
).trim();
const MACRO_IMPORT_URL = (
  ENV.MACRO_ISSUES_IMPORT_URL || "https://macroresearch.vercel.app/api/cron/macro-issues"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST_URL = "https://www.samsungpop.com/mbw/search/search.do";
const PDF_BASE = "https://www.samsungpop.com/common.do";
const SOURCE = "삼성증권";
const UNLISTED_SOURCE = "삼성증권 비상장리서치";
// kind 별 파서는 parseTitle() 참고. fixedLabel 은 게시판 단위 확정 분류용
// stockName — shinhan-research.ts 에 같은 문자열로 등록돼 있어야 한다.
const BOARDS = [
  { gubun: "company2", label: "해외기업", market: "us", kind: "us" },
  { gubun: "industry2", label: "해외산업", market: "us", kind: "us" },
  { gubun: "chief", label: "해외주식 Chief's Note", market: "us", kind: "us" },
  { gubun: "company1", label: "국내기업", market: "kr", kind: "krCompany" },
  { gubun: "spot2", label: "SPOT코멘트(기업)", market: "kr", kind: "krCompany" },
  { gubun: "industry1", label: "국내산업", market: "kr", kind: "krIndustry" },
  { gubun: "market", label: "투자전략", market: "kr", kind: "fixed", fixedLabel: "삼성증권 투자전략" },
  { gubun: "spot1", label: "SPOT코멘트(전략)", market: "kr", kind: "fixed", fixedLabel: "삼성증권 SPOT코멘트(전략)" },
  { gubun: "issue", label: "이슈리포트", market: "kr", kind: "fixed", fixedLabel: "삼성증권 이슈리포트" },
  { gubun: "premium", label: "프리미엄", market: "kr", kind: "krIndustry" },
  { gubun: "daily", label: "Daily시황", market: "kr", kind: "fixed", fixedLabel: "삼성증권 Daily시황" },
  { gubun: "economy", label: "경제", kind: "macro" },
  { gubun: "bond", label: "채권", kind: "macro" },
];

const TITLE_RE = /^(.+?)\s*\(([A-Za-z0-9.-]{1,10})\s+US\)\s*:\s*(.+)$/;
// 국내기업: "삼성SDI(006400/BUY): 헤드라인", "한미약품 (128940/BUY): …"
const KR_TITLE_RE = /^(.+?)\s*\((\d{6})\s*\/\s*([^)]+)\)\s*[:：]\s*(.+)$/;
// 국내 비상장: "BPMG (비상장): 헤드라인"
const KR_UNLISTED_RE = /^(.+?)\s*\(비상장\)\s*[:：]\s*(.+)$/;
// 국내산업 라벨 뒤 업종 투자의견: "Tech(OVERWEIGHT)" → "Tech"
const SECTOR_OPINION_RE = /\s*\((?:OVERWEIGHT|NEUTRAL|UNDERWEIGHT)\)\s*$/i;

const UNLISTED_LABEL_RE = /비상장/;
const ITEM_RE =
  /downloadPdf\('([^']+)','(\d+)','(\d+)'\)[\s\S]*?<dt><strong>([^<]+)<\/strong><\/dt>[\s\S]*?<span>([\d-]+)&nbsp;[\d:]+<\/span>\s*<span>([^<]*)<\/span>\s*<span>([^<]*)<\/span>/g;

function ymdDot(d) {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

async function fetchBoard(gubun, startDate, endDate) {
  const url = new URL(LIST_URL);
  const params = {
    cmd: "report_search",
    startCount: "0",
    range: "A",
    startDate,
    endDate,
    writer: "",
    moreCheck: "N",
    GUBUN: gubun,
    searchField: "TITLE",
    periodType: "1",
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function baseItem(fileName, date, author) {
  return {
    id: fileName,
    date,
    analyst: author.trim(),
    opinion: "",
    targetPrice: null,
    summary: "",
    pdfUrl: `${PDF_BASE}?cmd=down&saveKey=research.pdf&fileName=${encodeURIComponent(fileName)}&contentType=application/pdf`,
    views: null,
  };
}

// 티커/코드 없는 글 → 산업(라벨 추출). 국내에서 라벨에 "비상장"이면 인사이트로.
function industryItem(base, title, board) {
  const { label: rawLabel, headline } = industryLabelAndHeadline(title);
  const label = rawLabel.replace(SECTOR_OPINION_RE, "").trim() || "산업";
  const unlisted = board.market === "kr" && UNLISTED_LABEL_RE.test(label);
  return {
    ...base,
    // "[Tech Talk 시즌2]: 애플 …"처럼 대괄호 뒤에 콜론이 또 붙는 경우 정리.
    title: headline.replace(/^[:：;]\s*/, ""),
    stockName: label,
    symbol: null,
    category: "산업",
    source: unlisted ? UNLISTED_SOURCE : SOURCE,
  };
}

function parseTitle(base, title, board) {
  if (board.kind === "macro") return { ...base, title, topic: "이슈분석" };
  // 종목 리포트는 아래 공통 규칙 대상이 아니다.
  const isStockReport =
    (board.kind === "us" && TITLE_RE.test(title)) || (board.kind === "krCompany" && KR_TITLE_RE.test(title));
  // 원자재 글은 어느 게시판이든 거시경제 이슈분석으로(대체투자는 공통 필터가
  // 원자재만 남긴다).
  if (!isStockReport && isCommodityContent(title)) return { ...base, title, topic: "이슈분석" };
  if (board.kind === "fixed") {
    return { ...base, title, stockName: board.fixedLabel, symbol: null, category: "산업", source: SOURCE };
  }
  if (board.kind === "us") {
    const tm = title.match(TITLE_RE);
    if (!tm) return industryItem(base, title, board);
    const [, stockName, ticker, headline] = tm;
    return {
      ...base,
      title: headline.trim(),
      stockName: stockName.trim(),
      symbol: ticker.toUpperCase(),
      category: "기업",
      source: SOURCE,
    };
  }
  if (board.kind === "krCompany") {
    const km = title.match(KR_TITLE_RE);
    if (km) {
      const [, stockName, code, opinion, headline] = km;
      return {
        ...base,
        title: headline.trim(),
        stockName: stockName.trim(),
        symbol: code,
        opinion: opinion.trim(),
        category: "기업",
        source: SOURCE,
      };
    }
    const um = title.match(KR_UNLISTED_RE);
    if (um) {
      return { ...base, title: um[2].trim(), stockName: um[1].trim(), symbol: null, category: "산업", source: UNLISTED_SOURCE };
    }
    return industryItem(base, title, board);
  }
  // krIndustry
  return industryItem(base, title, board);
}

function parseItems(html, board) {
  const items = [];
  for (const m of html.matchAll(ITEM_RE)) {
    const [, fileName, , , rawTitle, date, , author] = m;
    // 제목 앞의 "(작성자)" 접두어는 dd의 세 번째 span(작성자)과 중복이라 제거.
    // "(수정)(작성자)"처럼 여러 개 붙는 경우도 있어 반복 제거.
    const prefix = rawTitle.match(/^(?:\([^)]*\)\s*)+/)?.[0] ?? "";
    const title = rawTitle.slice(prefix.length).trim();
    // 작성자 span 이 비어 오는 경우가 많아 접두어의 "(작성자)"로 채운다("(수정)" 제외).
    const prefixAuthor = [...prefix.matchAll(/\(([^)]*)\)/g)]
      .map((x) => x[1].trim())
      .filter((x) => x && x !== "수정")
      .join(", ");
    // ETF/ETP 리포트 제외(오너 지시 2026-09-24, 공용 필터) — "ETP Weekly
    // Insight"·"모두의 ETP Biweekly"·"오토콜러블 ETF" 등이 여기서 걸러진다.
    if (isEtfOrEtpContent(title)) continue;
    // ESG 공용 제외(오너 지시 2026-09-24 — "esg는 공통으로 제외처리").
    if (isEsgContent(title)) continue;
    // 공통 제외 — 주간물·일정표·추천종목·원자재 외 대체투자(오너 지시 2026-09-25).
    if (isCommonExcludedContent(title)) continue;
    const it = parseTitle(baseItem(fileName, date, author.trim() || prefixAuthor), title, board);
    if (it) items.push({ ...it, market: board.market ?? null, board: board.gubun });
  }
  return items;
}

console.log(`▶ 삼성증권 리서치 수집(${BOARDS.map((b) => b.label).join("·")}): 최근 ${DAYS}일`);
const now = new Date();
const startDate = ymdDot(new Date(now.getTime() - DAYS * 86_400_000));
const endDate = ymdDot(now);
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));

const collected = [];
for (const board of BOARDS) {
  const html = await fetchBoard(board.gubun, startDate, endDate);
  const items = parseItems(html, board).filter((it) => new Date(it.date) >= cutoff);
  console.log(`  ${board.label}(${board.gubun}): ${items.length}건`);
  collected.push(...items);
  await sleep(400);
}

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. 페이지 구조가 바뀌었을 수 있음.");
  process.exit(1);
}
const research = collected.filter((it) => it.topic == null);
const macro = collected.filter((it) => it.topic != null);
console.log(`✔ 파싱 완료: 리서치 ${research.length}건 · 이슈분석 ${macro.length}건`);
for (const i of collected) {
  console.log(
    `  [${i.board}→${i.topic ?? `${i.market}/${i.category}/${i.source}`}] ${i.date} ${i.symbol ?? i.stockName ?? ""}${i.opinion ? `(${i.opinion})` : ""} — ${i.title} [${i.analyst}]`,
  );
}

// 목표주가 PDF 보강은 미국 종목만(공용 추출기가 USD 표기 기준).
const usCompany = research.filter((it) => it.market === "us" && it.category === "기업");
console.log(`▶ 투자의견/목표주가 조회 중 (PDF 포함, 로그인 불필요) — ${usCompany.length}건...`);
await enrichUsResearch(usCompany, { sleepMs: 400, usePdf: true });

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

// 라우트가 POST 1회당 source·market 하나만 받으므로 묶어서 나눠 전송.
const groups = new Map();
for (const it of research) {
  const key = `${it.source}|${it.market}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push({
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
for (const [key, items] of groups) {
  const [source, market] = key.split("|");
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

if (macro.length > 0) {
  const items = macro.map((it) => ({
    id: it.id,
    date: it.date,
    title: it.title,
    analyst: it.analyst,
    summary: it.summary,
    pdfUrl: it.pdfUrl,
  }));
  const up = await fetch(MACRO_IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items, source: SOURCE, topic: "이슈분석" }),
  });
  const upBody = await up.text();
  if (!up.ok) {
    console.error(`✗ [이슈분석] 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`✔ [이슈분석] 앱 전송 완료 (${items.length}건): ${upBody}`);
}
