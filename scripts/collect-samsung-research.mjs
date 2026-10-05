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
 *   | economy   | 경제                   | 거시경제 > 이슈분석/환율분석(kr_research, 이관됨)|
 *   | bond      | 채권                   | 거시경제 > 이슈분석/환율분석(kr_research, 이관됨)|
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
import { enrichResearch } from "./lib/research-extract.mjs";
import { isEtfOrEtpContent, isEsgContent, isCommonExcludedContent, isCommodityContent, isFxContent, isDigitalAssetContent, isUnlistedCompanyTag } from "./lib/exclude-filters.mjs";
import { industryLabelAndHeadline } from "./lib/label-extract.mjs";
import { refineSectorLabels } from "./lib/sector-label.mjs";
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

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || `${appUrl(ENV)}/api/cron/total-research`
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST_URL = "https://www.samsungpop.com/mbw/search/search.do";
const PDF_BASE = "https://www.samsungpop.com/common.do";
const SOURCE = "삼성증권";
const US_DAILY_LABEL = "삼성증권 미국 시황"; // Daily시황 게시판의 "미국 마감시황" 전용 라벨(market:"us").
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
  { gubun: "economy", label: "경제", market: "kr", kind: "macro" },
  { gubun: "bond", label: "채권", market: "kr", kind: "macro" },
];

const TITLE_RE = /^(.+?)\s*\(([A-Za-z0-9.-]{1,10})\s+US\)\s*:\s*(.+)$/;
// 국내기업: "삼성SDI(006400/BUY): 헤드라인", "한미약품 (128940/BUY): …"
const KR_TITLE_RE = /^(.+?)\s*\((\d{6})\s*\/\s*([^)]+)\)\s*[:：]\s*(.+)$/;
// 국내 비상장: "BPMG (비상장): 헤드라인"
const KR_UNLISTED_RE = /^(.+?)\s*\(비상장\)\s*[:：]\s*(.+)$/;
// 국내산업 라벨 뒤 업종 투자의견: "Tech(OVERWEIGHT)" → "Tech"
const SECTOR_OPINION_RE = /\s*\((?:OVERWEIGHT|NEUTRAL|UNDERWEIGHT)\)\s*$/i;

const UNLISTED_LABEL_RE = /비상장/;
// "화장품 수출 데이터북"(정동희, 10일 단위 반복 통계집) — 분석이 아니라 정기
// 데이터 집계라 위클리와 같은 취지로 제외(오너 지시 2026-09-25).
const EXPORT_DATABOOK_RE = /수출\s*데이터북/;
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

// 시리즈 라벨이 실제 다루는 시장이 게시판 기본 market과 다른 경우 재분류(오너
// 지시 2026-09-25) — "Now Japan 시리즈"는 us 게시판(industry2)에 실려도 일본
// 얘기라 JP로, "중국 전기차"는 중국 얘기라 CH로 보낸다.
const JP_SERIES_RE = /^Now\s*Japan/i;
const CH_SERIES_RE = /^중국\s*전기차/;
// "Tech Talk 시즌2"는 국내기업(industry1) 게시판에 실려도 애플 iPhone Duo 등
// 해외 빅테크 얘기라 미국으로 보낸다(오너 확인 2026-09-25 — PDF 내용 대조,
// "이건 미국 산업분석 이야기인데").
const TECH_TALK_RE = /^Tech\s*Talk/i;
// 국내 디지털자산/조각투자/STO 산업 리포트는 제외한다(오너 지시 2026-09-25 —
// "kr 산업분석 — 한국 STO 한국은 조각투자 STO, 디지털자산을 제외하고 미국은
// 유지한다"). us 쪽(예: 미국 스테이블코인 얘기)은 그대로 수집.

// 티커/코드 없는 글 → 산업(라벨 추출). 국내에서 라벨에 "비상장"이면 인사이트로.
function industryItem(base, title, board) {
  const { label: rawLabel, headline } = industryLabelAndHeadline(title);
  const label = rawLabel.replace(SECTOR_OPINION_RE, "").trim() || "산업";
  let market = board.market;
  if (market === "us") {
    if (JP_SERIES_RE.test(label)) market = "jp";
    else if (CH_SERIES_RE.test(label)) market = "ch";
  } else if (market === "kr" && TECH_TALK_RE.test(label)) {
    market = "us";
  }
  if (market === "kr" && isDigitalAssetContent(`${label} ${title}`)) return null;
  // 비상장은 시장과 무관(오너 지시 2026-09-27 — "미국과 중국도 비상장을 추가한다"): 미국 "오픈AI(OpenAI, 미국 비상장)"·"앤스로픽(…비상장)"도 비상장 리서치.
  const unlisted = market === "kr" ? UNLISTED_LABEL_RE.test(label) : isUnlistedCompanyTag(label);
  return {
    ...base,
    // "[Tech Talk 시즌2]: 애플 …"처럼 대괄호 뒤에 콜론이 또 붙는 경우 정리.
    title: headline.replace(/^[:：;]\s*/, ""),
    stockName: label,
    symbol: null,
    category: "산업",
    source: unlisted ? UNLISTED_SOURCE : SOURCE,
    marketOverride: market !== board.market ? market : undefined,
  };
}

function parseTitle(base, title, board) {
  // 공용 FX 판정(오너 지적 2026-09-25 — "거시경제 fx 수집기준은 공통에서 반영하고
  // 있지?"): 경제·채권 게시판이 여태 FX 분기 없이 전부 이슈분석으로만 갔다.
  // 리서치 분류 체계 전면 개편(2026-09-26)으로 macro_issues 컬렉션은 폐지 —
  // 경제/채권 게시판도 kr_research로 합류시키되 게시판별 고정 stockName
  // (shinhan-research.ts FORCED_ISSUE_STOCKNAMES/FORCED_FX_STOCKNAMES 등록)으로
  // classifyResearchTopic()이 이슈분석/환율분석으로 확정 분류하게 한다.
  if (board.kind === "macro") {
    const isFx = isFxContent(title);
    const label = board.gubun === "bond" ? "삼성증권 채권" : "삼성증권 경제";
    return { ...base, title, stockName: isFx ? `${label} FX` : label, symbol: null, category: "산업", source: SOURCE };
  }
  // 종목 리포트는 아래 공통 규칙 대상이 아니다.
  const isStockReport =
    (board.kind === "us" && TITLE_RE.test(title)) || (board.kind === "krCompany" && KR_TITLE_RE.test(title));
  // 원자재 글은 어느 게시판이든 거시경제 이슈분석으로(대체투자는 공통 필터가
  // 원자재만 남긴다).
  if (!isStockReport && isCommodityContent(title)) {
    const isFx = isFxContent(title);
    return {
      ...base,
      title,
      stockName: isFx ? "삼성증권 원자재 FX" : "삼성증권 원자재",
      symbol: null,
      category: "산업",
      source: SOURCE,
    };
  }
  if (board.kind === "fixed") {
    // Daily시황은 "국내 마감시황"·"미국 마감시황" 둘을 함께 다룬다 — 미국 쪽은
    // 국내 시황과 market이 달라야 하므로 별도 라벨·market으로 분리한다(오너 지시
    // 2026-09-25 — "삼성 daily 시황에서 미국은 미국 시황으로 분류").
    const isUsDaily = board.gubun === "daily" && /^미국\s*마감\s*시황/.test(title);
    // "국내 마감시황" — 거의 매일 올라오는 국내 종가 요약. 수집 제외(오너 지시
    // 2026-10-01, "삼성증권국내마감시황 수집제외"). "미국 마감시황"(US_DAILY_LABEL)
    // 은 이 지시에 해당하지 않아 그대로 둔다.
    if (board.gubun === "daily" && /^국내\s*마감\s*시황/.test(title)) return null;
    // 투자전략(market) 게시판의 "차이나 전기차 투자 전략: …"(글로벌투자전략팀 전종규, 중국 전기차 업종 분석)은 시황·전략이 아니라
    // 중국 업종 리포트 — 중국(ch) 산업분석으로(오너 지시 2026-09-27, "1번으로 처리"). 범위는 이 글(중국·차이나 전기차)만.
    // "美 중간선거 스냅샷 D-N"(글로벌투자전략팀 유승민, 지정학) 시리즈는 주식 얘기가 아니라 선거·정치 경제 — 이슈분석(경제)으로
    // (오너 지시 2026-09-27 — 미국 "1번": 이 시리즈만). 기존 고정 라벨 "삼성증권 경제"를 재사용해 앱 분류가 그대로 이슈분석(경제).
    if (board.gubun === "market" && /중간선거\s*스냅샷/.test(title)) {
      return { ...base, title, stockName: "삼성증권 경제", symbol: null, category: "산업", source: SOURCE };
    }
    if (board.gubun === "market" && /(중국|차이나)\s*전기차/.test(title)) {
      return { ...base, title, stockName: "중국 전기차", symbol: null, category: "산업", source: SOURCE, marketOverride: "ch" };
    }
    return {
      ...base,
      title,
      stockName: isUsDaily ? US_DAILY_LABEL : board.fixedLabel,
      symbol: null,
      category: "산업",
      source: SOURCE,
      marketOverride: isUsDaily ? "us" : undefined,
    };
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
        opinionFrom: "title",
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
    if (EXPORT_DATABOOK_RE.test(title)) continue;
    const it = parseTitle(baseItem(fileName, date, author.trim() || prefixAuthor), title, board);
    if (it) items.push({ ...it, market: it.marketOverride ?? board.market ?? null, board: `삼성증권 > ${board.label}(${board.gubun})` });
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

if (collected.length === 0) exitNoItems({ market: "kr", label: "samsung" });
const research = collected;
console.log(`✔ 파싱 완료: ${research.length}건`);
// 묶음 라벨("2차전지/정유/화학")은 PDF 본문에서 실제로 다루는 업종 하나로 좁힌다(오너 지시 2026-09-27 — 삼성 "유럽 NDR 및 마케팅 후기"는
// LG화학 NDR·정유화학 이야기인데 라벨 첫 업종(2차전지)로 분류됐다). 애매하면 라벨을 그대로 두고 앱이 기타로 둔다.
console.log(`▶ 업종 라벨 보정: ${await refineSectorLabels(research)}건`);
for (const i of collected) {
  console.log(
    `  [${i.board}→${i.market}/${i.category}/${i.source}] ${i.date} ${i.symbol ?? i.stockName ?? ""}${i.opinion ? `(${i.opinion})` : ""} — ${i.title} [${i.analyst}]`,
  );
}

// 투자의견·목표주가 — 국내·해외 공용 추출기(시장별 통화). 국내 의견은 제목에서 읽은 값.
const stockItems = research.filter((it) => it.category === "기업");
console.log(`▶ 투자의견/목표주가 조회 중 (PDF 포함, 로그인 불필요) — ${stockItems.length}건...`);
await enrichResearch(stockItems, { sleepMs: 400, usePdf: true });

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
    board: it.board,
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
  if (appSendFailed(up, upBody)) {
    console.error(`✗ [${source}/${market}] 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`✔ [${source}/${market}] 앱 전송 완료 (${items.length}건): ${upBody}`);
}
