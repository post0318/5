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
 * 따라 이번에 수집하는 게시판은(실제 사이트 내비, 오너 확인 2026-09-24):
 *
 *   | rMenuGb | 실제 사이트 내비           | market | category | 비고 |
 *   |---------|----------------------------|--------|----------|------|
 *   | CC      | 해외증시 > 미국/선진국     | us     | 기업/산업| 기존(2026-09-24 최초 추가) |
 *   | AI      | 해외증시 > AI보고서        | us     | 기업     | "[AI 실적 리뷰] ... 종목명 (TICKER.US)" — 콜론 없이 끝에 티커 |
 *   | CA      | 해외증시 > 글로벌테마/이슈 | us     | 산업     | 라벨 고정 "투자전략(이슈)", "키차트" 포함 항목은 제외 |
 *   | CH      | 해외증시 > 중국/신흥국     | ch     | 기업/산업| "종목명(TICKER.HK)"은 기업, 대괄호/콜론 라벨은 산업(오너 지시 2026-09-24 — market은 us에 합치지 않고 별도 "ch") |
 *   | CR      | 기업/산업분석 > 기업분석   | kr     | 기업     | "종목명(6자리코드): 제목" |
 *   | SN      | 기업/산업분석 > 스팟노트   | kr     | 기업     | CR과 같은 제목 형식, 더 짧은 코멘트성 리포트 |
 *   | CI      | 기업/산업분석 > 산업분석   | kr     | 산업     | 대괄호/콜론 라벨 추출(공용 lib/label-extract.mjs). "회사명(비상장-IPO예정)" 항목은 비상장 리서치로 별도 분리(아래 참고) |
 *   | EM      | 경제/전략 > 월간증시전망   | kr     | 산업(라벨 고정)| "키움 월간증시전망" 고정 라벨. "N월 키움 증시 캘린더" 항목은 제외(오너 지시 2026-09-24) |
 *   | IM      | 경제/전략 > 중장기증시전망 | kr     | 산업(라벨 고정)| "키움 중장기증시전망" 고정 라벨 |
 *
 *   **의도적으로 뺀 게시판**(화이트리스트 방식이라 아래는 그냥 안 부른다 —
 *   블랙리스트 유지가 필요 없음): CS(이슈분석, 국내 — 실제로는 "기업/
 *   산업분석" 메뉴 아래 반복 시리즈, macro-issues 대상 아님), QE(퀀트전략),
 *   SW(주간증시전망), SE(경제분석), BM(월간채권전망)/BW(주간채권전망, "채권
 *   시장이슈" 제외 지시에 해당), CJ(일본), TP(글로벌 ETF — 있었어도 ETF
 *   필터에 걸림), BC(디지털자산리서치), **SD(일간증시전망, 오너 지시
 *   2026-09-24 — "sd코드는 삭제한다. 수집하지 않겠다": 한때 "키움 일간증시전망"
 *   고정 라벨로 수집했으나 중단. 기존 문서는 시황 14일 보존기간에 따라
 *   자연 소멸).
 *
 * **비상장 리서치(오너 지시 2026-09-24 — "국내는 인사이트가 없다. 따라서
 * 미국은 유지하나 한국은 인사이트를 비상장 리서치로 대체한다")**: 해외 IB
 * 인사이트 탭(`INSIGHT_SOURCES`, 미국 시장 전용)과 짝을 맞춰 국내 시장에는
 * CI 게시판의 "회사명(비상장-IPO예정) : 헤드라인" 형식 리포트를
 * `source: "키움증권 비상장리서치"`로 별도 전송한다 — 같은
 * `category:"산업"` 인프라(`getInsightResearch`/`getIndustryResearch`의
 * `INSIGHT_SOURCES` 제외 로직)를 그대로 재사용하되, market이 "kr"이라 미국
 * 인사이트 조회(market:"us")와는 자연히 분리된다. 일반 산업분석 항목(`source:
 * "키움증권"`)과 섞이지 않도록 전송 단계에서 그룹을 나눈다.
 *
 * ETF/ETP 리포트는 게시판·시장 불문 공용 필터(`lib/exclude-filters.mjs`)로
 * 제외한다.
 *
 * `summary`는 대부분 `titl`과 동일하거나 더 짧아 별도 요약으로 쓸 가치가
 * 없다(실측 확인) — summary는 비워 두고, 종목 리포트는 국내·해외 공용
 * 추출기(lib/research-extract.mjs)가 **PDF 본문**에서 투자의견·목표주가를
 * 채운다(usePdf:true — 로그인 없이 PDF를 받을 수 있는 몇 안 되는 소스).
 * 통화는 시장별(kr 원·us 달러·ch 홍콩달러/위안 — 2026-09-25 공용화 전엔
 * 미국만 했다).
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
import { enrichResearch } from "./lib/research-extract.mjs";
import { isCommonExcludedContent, isUnlistedCompanyTag } from "./lib/exclude-filters.mjs";
import { industryLabelAndHeadline } from "./lib/label-extract.mjs";
import { sectorFromTitleOrCover, looksLikeSectorLabel, isIpoCover } from "./lib/sector-label.mjs";
import { readPdfText } from "./lib/research-extract.mjs";
import { resolveUsTickerByName } from "./lib/overseas-market.mjs";
import { appUrl } from "./lib/app-url.mjs";

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
  ENV.SHINHAN_RESEARCH_IMPORT_URL || `${appUrl(ENV)}/api/cron/total-research`
).trim();
// 거시경제(이슈분석/환율분석) 전용 — 오너 지시 2026-09-26 "kb 키움은 개별수집기에
// 통합되어야 맞아보인다. 따로 있을 이유가 없다"로 collect-kiwoom-macro-issues.mjs를
// 이 파일에 흡수. 이후 리서치 분류 체계 전면 개편(2026-09-26)으로 macro_issues
// 컬렉션·라우트 자체가 폐지돼 kr_research(IMPORT_URL)로 완전히 합류했다.
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
// "회사명(비상장-IPO예정) : 헤드라인" 형식은 상장 종목이 아니라 키움이 다루는
// 비상장(프리IPO) 기업 리포트라 일반 업종 라벨과 다르게 취급한다(오너 지시
// 2026-09-24 — "먼저 키움증권 CI 중 비상장 종목은 인사이트로 별도 분류한다").
// `unlisted: true` 로 표시해 전송 단계에서 별도 source로 분리한다.
const UNLISTED_RE = /^(.+?)\s*\(\s*비상장[^)]*\)\s*[:：;]\s*(.+)$/;
function parseKrIndustryBoard(title) {
  const um = title.match(UNLISTED_RE);
  if (um) {
    const [, companyName, headline] = um;
    return { title: headline.trim(), stockName: companyName.trim(), symbol: null, category: "산업", unlisted: true };
  }
  const { label, headline } = industryLabelAndHeadline(title);
  return { title: headline, stockName: label, symbol: null, category: "산업" };
}

// CH(해외증시 > 중국/신흥국): market은 "ch"로 별도 태깅한다(오너 지시
// 2026-09-24 — "ch는 마켓은 ch다 us분류하면 안된다") — 처음엔 이 앱에 중국
// MarketId가 없어 "us"로 합치거나 개별 종목은 건너뛰는 방식을 검토했으나,
// 오너가 명시적으로 정정: 종목분석(EDGAR 등 어댑터)이 아직 중국을 지원하지
// 않는 것과 별개로 리서치 데이터는 market:"ch"로 정확히 태깅해야 한다
// (`src/lib/db/shinhan-research.ts`의 `ResearchMarketId` 참고). 카테고리도
// "산업(거시)만"이 아니라 **기업/산업 둘 다** 수집한다(오너 지시 — "카테고리는
// 기업/산업이다") — "종목명(TICKER.HK)" 형식이면 기업, 대괄호/콜론 라벨
// ("[중국은 지금] ...")이면 산업.
const CH_TICKER_RE = /^(.+?)\s*\(([A-Za-z0-9.]{1,10})\.(HK|CN|SZ|SS|SH)\)\s*[:：]\s*(.+)$/i;
function parseChBoard(title) {
  const tm = title.match(CH_TICKER_RE);
  if (tm) {
    const [, stockName, ticker, exch, headline] = tm;
    return {
      title: headline.trim(),
      stockName: stockName.trim(),
      symbol: `${ticker.toUpperCase()}.${exch.toUpperCase()}`,
      category: "기업",
    };
  }
  const { label, headline } = industryLabelAndHeadline(title);
  // "[중국은 지금] …" 중국 거시 시리즈(실물지표·정책 등)는 산업분석이 아니라 거시경제 이슈분석(경제) — 고정 라벨로 보내 앱이 분류
  // (오너 지시 2026-09-27, 삼성증권 경제와 같은 기준).
  if (/^중국은\s*지금$/.test(label)) return { title: headline, stockName: "키움 중국 경제", symbol: null, category: "산업" };
  return { title: headline, stockName: label, symbol: null, category: "산업" };
}

// EM(국내 월간증시전망) 등 게시판 전체가 하나의 시리즈라 stockName을 고정
// 라벨로 둔다 — shinhan-research.ts의 STRATEGY_STOCKNAMES에 "키움
// 월간증시전망"/"키움 중장기증시전망"을 등록해 투자전략(주식)으로 강제
// 분류한다(오너 지시 2026-09-24).
function fixedLabelBoardParser(label) {
  return (title) => ({ title, stockName: label, symbol: null, category: "산업" });
}

// EM(월간증시전망) 안에 섞여 나오는 "YYYY년 M월 키움 증시 캘린더"는 월간
// 시장 전망 리포트가 아니라 일정표라 이 프로젝트의 산업분석/투자전략 범위
// 밖이다(오너 지시 2026-09-24 — "월간증시전망에서 증시 캘린더는 수집대상에서
// 제외한다").
const CALENDAR_RE = /증시\s*캘린더/;

// 실제 사이트 내비 경로(상단 표, 오너 확인 2026-09-24) — 리포트가 원래 어느 메뉴에 있었는지
// 각 item 의 board 필드로 싣는다(분류 대조용).
const MENU_LABEL = {
  CC: "해외증시 > 미국/선진국",
  AI: "해외증시 > AI보고서",
  CA: "해외증시 > 글로벌테마/이슈",
  CH: "해외증시 > 중국/신흥국",
  CR: "기업/산업분석 > 기업분석",
  SN: "기업/산업분석 > 스팟노트",
  CI: "기업/산업분석 > 산업분석",
  EM: "경제/전략 > 월간증시전망",
  IM: "경제/전략 > 중장기증시전망",
  SI: "경제/전략 > 이슈분석",
  FE: "경제/전략 > 환율전망",
};
const boardLabel = (rMenuGb) => `키움증권 > ${MENU_LABEL[rMenuGb] ?? rMenuGb}(${rMenuGb})`;

const BOARDS = [
  { rMenuGb: "CC", market: "us", parse: parseUsTickerBoard },
  { rMenuGb: "AI", market: "us", parse: parseAiBoard },
  { rMenuGb: "CA", market: "us", parse: parseGlobalThemeBoard },
  { rMenuGb: "CH", market: "ch", parse: parseChBoard },
  { rMenuGb: "CR", market: "kr", parse: parseKrCompanyBoard },
  { rMenuGb: "SN", market: "kr", parse: parseKrCompanyBoard },
  { rMenuGb: "CI", market: "kr", parse: parseKrIndustryBoard },
  { rMenuGb: "EM", market: "kr", parse: fixedLabelBoardParser("키움 월간증시전망"), exclude: (title) => CALENDAR_RE.test(title) },
  { rMenuGb: "IM", market: "kr", parse: fixedLabelBoardParser("키움 중장기증시전망") },
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
      if (board.exclude && board.exclude(rawTitle)) continue; // 게시판별 개별 제외(예: EM 증시 캘린더)
      const parsed = board.parse(rawTitle);
      if (!parsed) continue;
      // 공통 배제가 기본(오너 지시 2026-09-26 — "통합함수가 기본이고 예외가
      // 필요할 때 개별함수 쓴다"). category가 parse() 이후에야 정해지므로
      // 여기로 옮겨 ETF/ESG/Weekly뿐 아니라 리츠·캘린더·추천종목·대체투자까지
      // 한 번에 적용한다(이전엔 개별 함수 3개만 써서 이 4개는 서버 안전망에만
      // 의존했음).
      if (isCommonExcludedContent(rawTitle, parsed.category)) continue;
      out.push({
        id: `${board.rMenuGb}:${r.sqno}`,
        board: boardLabel(board.rMenuGb),
        date,
        title: parsed.title,
        stockName: parsed.stockName,
        symbol: parsed.symbol,
        unlisted: parsed.unlisted === true,
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

// 거시경제(이슈분석/환율분석) — 원 collect-kiwoom-macro-issues.mjs 로직 그대로.
// SI(rMenuGbNm "이슈분석", 실제 사이트 내비 확인됨)·FE(rMenuGbNm "일간환율전망")
// 게시판 코드 자체가 topic을 확정하므로 FX 판정이 불필요(다른 증권사와 다른 점).
// 리서치 분류 체계 전면 개편(2026-09-26)으로 macro_issues 컬렉션 폐지 — 고정
// stockName("키움 이슈분석"/"키움 환율분석", shinhan-research.ts
// FORCED_ISSUE_STOCKNAMES/FORCED_FX_STOCKNAMES 등록)으로 kr_research에 합류시킨다.
const MACRO_BOARDS = [
  { rMenuGb: "SI", stockName: "키움 이슈분석" },
  { rMenuGb: "FE", stockName: "키움 환율분석" },
];

async function collectMacroBoard(board, cutoff) {
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
      const title = String(r.titl ?? "").trim();
      if (isCommonExcludedContent(title)) continue;
      out.push({
        id: `${board.rMenuGb}:${r.sqno}`,
        board: boardLabel(board.rMenuGb),
        date,
        title,
        stockName: board.stockName,
        symbol: null,
        analyst: r.workId ?? "",
        opinion: "",
        targetPrice: null,
        summary: "",
        pdfUrl: r.attaFile
          ? `${PDF_BASE}?rMenuGb=${board.rMenuGb}&attaFile=${encodeURIComponent(r.attaFile)}&makeDt=${encodeURIComponent(r.makeDt)}`
          : null,
        views: null,
        category: "산업",
        market: "kr",
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

console.log(`▶ 키움증권 거시경제(이슈분석/환율분석) 수집: 최근 ${DAYS}일`);
let macroCount = 0;
for (const board of MACRO_BOARDS) {
  const items = await collectMacroBoard(board, cutoff);
  console.log(`  ${board.rMenuGb}(${board.stockName}): ${items.length}건`);
  collected.push(...items);
  macroCount += items.length;
  await sleep(300);
}

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. 페이지 구조가 바뀌었을 수 있음.");
  // 0건은 실패가 아니다 — 주말·휴일이나 새 글이 없는 날에도 워크플로가 "실패"로
  // 찍혀 진짜 장애를 가리고 로컬 재실행 도구가 헛돌았다(감사 2026-09-28: 일요일
  // 8개 수집기 전부 거짓 실패). 경고만 남기고 정상 종료한다. 파서가 진짜 깨진
  // 경우는 DB 최신 날짜가 며칠째 안 움직이는 것으로 드러난다.
  console.log("::warning::파싱 결과 0건 — 새 글이 없거나 구조가 바뀌었을 수 있음");
  process.exit(0);
}
console.log(`✔ 파싱 완료: 총 ${collected.length}건 (거시경제 ${macroCount}건)`);
console.log(
  "  샘플:",
  collected.slice(0, 8).map((i) => `[${i.market}/${i.category}] ${i.date} ${i.symbol ?? i.stockName} — ${i.title}`),
);

// 국내 산업분석(CI) 게시판 항목의 PDF 표지를 읽어 두 가지를 보정한다(오너 지시 2026-09-27):
//  ① 표지가 "IPO Report"(공모 리포트)면 비상장 리서치로 — 예: "덕산넵코어스(266690) 항법과 항재밍으로…".
//  ② 라벨이 업종명이 아니면(제목 조각이 라벨로 들어온 경우 — 예: "소듐이온 전지(SIB) 기대감 확산") 표지의 업종명으로 —
//     안 그러면 산업분석 업종 필터에서 어느 업종에도 안 잡힌다.
let ipoMoved = 0, sectorFixed = 0;
for (const it of collected) {
  if (it.category !== "산업" || it.market !== "kr" || it.unlisted || !/\(CI\)/.test(it.board ?? "") || !it.pdfUrl) continue;
  const text = await readPdfText(it.pdfUrl).catch(() => "");
  if (isIpoCover(text)) {
    it.unlisted = true;
    it.stockName = String(it.stockName).replace(/\s*\(\d{6}\)\s*$/, "").trim();
    ipoMoved++;
    continue;
  }
  if (!looksLikeSectorLabel(it.stockName)) {
    const label = sectorFromTitleOrCover(it.title, text);
    if (label) { it.stockName = label; sectorFixed++; }
  }
}
console.log(`▶ 산업분석(CI) 표지 보정: IPO→비상장 ${ipoMoved}건 · 업종 라벨 보정 ${sectorFixed}건`);

// 미국(CC) 게시판에서 제목에 "(TICKER.US)" 표기 없이 "Bank of New York Mellon Corp: 지속적 수익증가…"처럼 영문 회사명만 온 글은
// 종목 리포트인데 산업분석으로 새고 있었다(오너 지적 2026-09-27 — "종목같은데"). 영문 회사명 라벨이면 이름→티커 조회로 종목으로 올린다.
let usPromoted = 0;
for (const it of collected) {
  if (it.market !== "us" || it.category !== "산업" || !/\(CC\)/.test(it.board ?? "")) continue;
  if (!/^[A-Za-z][A-Za-z0-9 .,&'-]{3,60}$/.test(String(it.stockName ?? ""))) continue;
  const hit = await resolveUsTickerByName(it.stockName);
  if (hit) {
    it.category = "기업";
    it.stockName = hit.stockName;
    it.symbol = hit.symbol;
    usPromoted++;
  }
}
console.log(`▶ 미국(CC) 티커 없는 영문 회사명 → 종목 ${usPromoted}건`);

// 미국·중국도 비상장 리서치(오너 지시 2026-09-27 — "미국과 중국도 비상장을 추가한다"): 종목 없는 해외 산업 글 중 "비상장" 표기이거나
// 제목이 상장 전 기업의 IPO 이야기("Anthropic IPO - 프론티어 AI의 첫 단독 상장")면 비상장으로 분리해 보낸다.
let overseasUnlisted = 0;
for (const it of collected) {
  if (it.market === "kr" || it.category !== "산업" || it.symbol || it.unlisted) continue;
  if (isUnlistedCompanyTag(`${it.stockName} ${it.title}`) || /\bIPO\b/.test(String(it.title))) {
    it.unlisted = true;
    overseasUnlisted++;
  }
}
console.log(`▶ 해외 비상장(IPO 포함) 분리: ${overseasUnlisted}건`);

const stockItems = collected.filter((it) => it.category !== "산업");
console.log(`▶ 투자의견/목표주가 조회 중 (PDF 포함, 로그인 불필요) — ${stockItems.length}건...`);
await enrichResearch(stockItems, { sleepMs: 400, usePdf: true });

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

// 시장×source별로 나눠 전송(라우트가 body당 market/source 하나만 받음 —
// GM/한경 스크립트의 "source별로 나눠 전송"과 같은 패턴). CI의 비상장
// 리포트는 일반 산업분석(source:"키움증권")과 섞이지 않도록 별도 source
// ("키움증권 비상장리서치")로 그룹을 나눈다(오너 지시 2026-09-24).
const UNLISTED_SOURCE = "키움증권 비상장리서치";
const byGroup = new Map(); // key: `${market}::${source}`
for (const it of collected) {
  const source = it.unlisted ? UNLISTED_SOURCE : "키움증권";
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
    board: it.board,
  });
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

let totalSent = 0;
for (const [, group] of byGroup) {
  const { market, source, items } = group;
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items, source, market }),
  });
  const upBody = await up.text();
  if (!up.ok) {
    console.error(`✗ [${market}/${source}] 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`✔ [${market}/${source}] 앱 전송 완료 (${items.length}건): ${upBody}`);
  totalSent += items.length;
}

console.log(`\n✔ 총 ${totalSent}건 전송 완료`);
