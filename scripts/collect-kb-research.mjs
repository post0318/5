/**
 * KB증권 "산업/기업" + "KB데일리" 리포트 — 로컬 수집기.
 *
 * www.kbsec.com 리서치보고서 메뉴("산업/기업" 탭, tab=5)는 화면이 호출하는
 * 내부 TR API `/go.able?linkcd=s040203010001` (POST, `document.forms[0]`
 * 직렬화 — `tab=5`, `searchMonth=3` 등)를 역추적해 직접 호출한다. 로그인
 * 불필요, 응답은 UTF-8 JSON(`{list:[...]}`) — 한 번의 요청으로 최근 3개월치
 * (`searchMonth=3`)를 통째로 받아오므로 페이지네이션이 불필요하다.
 *
 * 응답에 종목명+코드가 합쳐진 제목("종목명 (코드)")과 부제(실제 헤드라인),
 * 투자의견(`recomm`, 영문 Buy/Hold/Sell 등), **목표주가(`tp`, 예: "600000.0000")**,
 * PDF 직링크(`urlLink`)가 모두 들어있다 — `tp`는 PDF 본문에 그날 다시
 * 언급 안 해도(속보성 노트라 흔함) 항상 채워져 있어 PDF 정규식 추측보다
 * 정확하다(오너 지적으로 확인, 2026-09). **PDF는 실측 결과 로그인 없이
 * 그대로 다운로드된다**(오너가 "kb는 pdf는 로그인해야하나 본문은
 * 가능하다"고 전달했던 것과 달리, 최소 "산업/기업" 게시판은 로그인 불필요로
 * 확인됨 — 필요시 재확인). 종목코드 없이 업종명·전략 노트만 있는 리포트
 * ("반도체"·"유틸리티" 같은 업종명 자체가 docTitle 인 경우, "대형주 추천종목"·
 * "KB 리서치 모델 포트폴리오" 같은 정기 전략 노트)는 제목이 "종목명 (코드)"
 * 패턴이 아니라서 갈린다 — 2026-09부터는 이런 항목도 버리지 않고
 * category:"산업"으로 별도 수집한다(오너 지시, "산업분석/투자전략" 탭 준비 —
 * 수집기부터 구축). docTitle 을 업종/전략 이름(stockName 자리), docTitleSub
 * 를 실제 헤드라인(title 자리)으로 저장하고 symbol 은 항상 null(라우트가
 * category:"산업"이면 이름 검색을 아예 건너뛰므로 임의 종목에 잘못 붙을
 * 위험 없음).
 *
 * ⚠️ www.kbsec.com, rdata.kbsec.com 모두 robots.txt 자체가 없음(404/302) —
 *    지금까지 중 가장 깨끗한 케이스. 그래도 다른 예외들과 동일하게
 *    "개인용·로컬 실행·저빈도" 조건으로 오너 승인(CLAUDE.md 참조, 오너가
 *    "kb는 pdf는 로그인해야하나 본문은 가능하다" 직접 확인).
 *
 * 본문 발췌(2026-09 추가): PDF를 내려받아 `pdf-parse`(무료 오픈소스, 로컬
 * 처리)로 텍스트를 뽑는다. KB 리포트는 템플릿이 제각각이라(플래시노트/
 * 정식 커버리지 등) 고정 앵커 문구 대신, PDF 본문에 그대로 박혀 있는
 * "종목명 (코드)" 제목 줄을 찾아 그 다음 줄(부제)까지 건너뛰고, 이메일·
 * 애널리스트 소속·날짜 같은 상단 메타 정보 줄을 걸러낸 뒤 남는 문장만
 * 150자 내외로 짧게 저장한다. PDF 원문·전체 본문은 저장하지 않음.
 *
 * ⚠️ 서버가 보낸 항목을 통째로 replace하므로, --days 기본값을 30 → 3으로
 *    좁혀 PDF를 매일 다시 받는 범위를 최소화했다(유안타증권과 동일 이유).
 *    백필은 --days=30 등으로 수동 실행.
 *
 * ── 게시판 구조 정리(오너 지시 2026-09-24 — "kb증권도 키움처럼 게시판별로
 * 정리해서 보여줘") ──────────────────────────────────────────────────
 * `tab`(1~6)은 상위 대분류일 뿐이고, 응답 항목마다 실린 `categoryid`/
 * `pCategoryid` 필드가 키움의 `rMenuGb`에 해당하는 진짜 게시판 코드다 —
 * `tab=6`(통합 피드)으로 전수 조회해 `foldertemplate`(실제 사이트 내비)와
 * 함께 확인했다(실측, `searchMonth=3` 기준):
 *
 *   | categoryid | 실제 사이트 내비                          | market | category | 비고 |
 *   |------------|--------------------------------------------|--------|----------|------|
 *   | 79         | 자산배분/매크로 > KB데일리                  | kr     | 산업     | ✅ 이 스크립트(`tab=1`) — 시황 고정(오너 지시 2026-09-24 "kb데일리는 산업분석>시황에 해당한다") |
 *   | 69/65/63   | 자산배분/매크로 > 매크로                    | kr     | 산업     | ❌ 미수집 — 투자전략(주식) 라벨 후보 |
 *   | 77         | 자산배분/매크로 > 자산배분("이그전")        | kr     | 산업     | ❌ 미수집 — 투자전략(주식) 후보 |
 *   | 193/75/76  | 자산배분/매크로 > 대체투자(가상자산/원자재/부동산리츠) | kr | 산업 | ❌ 미수집 — 다른 증권사의 "대체투자 제외" 전례 있음(CLAUDE.md) |
 *   | 174        | 자산배분/매크로 > 자산배분기타 > 기타발간   | kr     | 산업     | ❌ 미수집 |
 *   | 84         | 한국 투자 > 시황코멘트                      | kr     | 산업     | ❌ 수집 제외(오너 결정, 2026-09-24) |
 *   | 81("KB 전략") | 한국 투자 > 주식전략                     | kr     | 산업     | ✅ 이 스크립트(`tab=3`, docTitle="KB 전략"만) — 투자전략(주식) 고정(오너 지시 — "kb전략은 투자전략(주식)에 해당된다") |
 *   | 81("이그전")/83("KB Quant") | 한국 투자 > 주식전략        | kr     | 산업     | ❌ 수집 제외(오너 결정 — "나머지는 수집에서 제외한다") |
 *   | 70("KB Bond"/"KB Fed Watch") | 한국 투자 > 채권/크레딧    | kr     | -        | ✅ `collect-kb-macro-issues.mjs`(docTitle 정확 일치) — `kr_research`가 아니라 거시경제 > 이슈분석(`macro_issues`, topic:"이슈분석")으로 별도 전송(오너 지시 — "kb bond는 거시경제>이슈분석에 해당된다" + "KB Fed Watch는 이슈분석에 포함한다") |
 *   | 71("KB Credit Weekly") | 한국 투자 > 채권/크레딧          | kr     | -        | ❌ 수집 제외(오너 결정) |
 *   | 192        | 한국 투자 > 종목컨설팅("KB 이슈 플러스")    | kr     | 산업     | ❌ 수집 제외(오너 결정) |
 *   | 177        | 한국투자 > 한국투자기타 > 기타발간           | kr     | 산업     | ❌ 수집 제외(오너 결정) |
 *   | 156        | 해외 투자 > 미국 > 산업/기업                | us     | 기업/산업| ✅ `collect-kb-global-research.mjs`("미국" foldertemplate 필터) |
 *   | 85         | 해외 투자 > 미국 > 전략("US Market Pulse") | us     | 산업     | ✅ 위와 동일 |
 *   | 158        | 해외 투자 > 중국 > 산업/기업                | **ch** | 기업/산업| ✅ `collect-kb-global-research.mjs`(오너 지시 2026-09-24 — "kb 중국과 일본도 수집기는 만들어두고") — 티커 매칭 시 기업, 시리즈 라벨은 산업 |
 *   | 86         | 해외 투자 > 중국 > 전략("KB Asia Market Headline") | **ch** | 산업 | ✅ 위와 동일 — 시황 고정 라벨(`MARKET_CONDITION_STOCKNAMES`) |
 *   | 160        | 해외 투자 > 일본 > 산업/기업("글로벌기업+") | jp     | 산업     | ✅ 위와 동일 — 표본이 적어(6개월 2건) 티커 추출 없이 라벨 고정만 |
 *   | 180        | 해외투자 > 해외투자기타 > 기타발간(아시아/미국주식 추천종목 등) | us/ch 혼재 | 산업 | ❌ 미수집 — 제목에 지역이 섞여 미래에셋식 키워드 분류 필요 |
 *   | 103~195(다수) | 산업/기업 > 섹터별(반도체/화학/제약 등)  | kr     | 기업/산업| ✅ 이 스크립트(`tab=5`) |
 *   | 131        | 산업/기업 > 스몰캡("KB IPO Brief")          | kr     | 기업     | ✅ 이 스크립트(`tab=5`에 포함) |
 *   | 132        | 산업/기업 > 기타발간("KB 리서치 모델 포트폴리오") | kr | 산업 | ✅ 이 스크립트(`tab=5`에 포함) |
 *   | **188**    | 산업/기업 > **비상장기업**("비상장 Tracker+", "케이비 비상장 플러스") | kr | 산업 | ❌ 미수집 — `tab=5` 기본 조회에 안 잡히고 `pCatfolderid=186`을 따로 줘야 나옴(실측 17건/3개월). **키움 CI 비상장과 같은 성격 — "비상장 리서치" 탭 후보** |
 *
 * **"한국 투자"(tab=3) 최종 결정(오너 지시, 2026-09-24)**: 시황코멘트(84)·
 * KB Quant/이그전(81 일부·83)·KB Fed Watch/KB Credit Weekly(70 일부·71)·
 * 종목컨설팅(192)·기타발간(177)은 전부 수집 제외 — "KB 전략"(81 중
 * docTitle 일치분)과 "KB Bond"(70 중 docTitle 일치분) **딱 두 시리즈만**
 * 수집한다.
 *
 * **처리 완료 이력**: 158/86(중국)·160(일본)은 `collect-kb-global-
 * research.mjs`로, 자산배분/매크로 그룹(69/65/63·77·193/75/76·174)은
 * `collect-kb-macro-issues.mjs`(tab=2 전체, Weekly/주간 제외·FX/환율은
 * 환율분석)로, 188(비상장기업)은 이 스크립트의 "비상장 리서치" 라우팅으로
 * 각각 확장 완료(2026-09-24). 위 표의 다른 ✅ 항목들과 함께 참고.
 *
 * **미결(오너 확인 필요, 착수 안 함)**: 180(해외투자기타 — "아시아주식
 * 추천종목"/"미국주식 추천종목" 등 지역이 제목에 섞여 있음)만 남음 — 미래에셋
 * 수집기처럼 키워드 추측으로 region을 나눠야 할 것으로 보이나 착수 전.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-kb-research.mjs
 *   node scripts/collect-kb-research.mjs --days=30 --dry-run
 */

import { readFileSync } from "node:fs";
import { PDFParse } from "pdf-parse";
import { isEsgContent } from "./lib/exclude-filters.mjs";

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
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim(); // 로컬 수동 실행 시 CRON_SECRET 없어도 인증 가능(라우트가 x-app-token도 허용)
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AJAX_URL = "https://www.kbsec.com/go.able?linkcd=s040203010001";
const TITLE_RE = /^(.+?)\s*\((\d{6})\)$/;
// 오너 지시(2026-09-24 — "산업/기업 중 코드나 종목명인 경우 종목분석에
// 해당되고 그 외는 산업분석에 해당한다. 다만, 포트폴리오, 추천종목, ESG등은
// 대상에서 제외한다. 또한 IPO나 비상장인 경우는 종목분석>인사이트에
// 해당한다."): 정기 전략 노트 중 포트폴리오·추천종목 라벨은 이 프로젝트의
// 산업분석/투자전략 범위 밖이라 아예 수집하지 않는다. ESG는 이후 "esg는
// 공통으로 제외처리" 지시로 소스 불문 공용 필터(`isEsgContent`)로 승격돼
// 여기선 KB 전용 목록에서 빠졌다(아래 EXCLUDE_LABEL_RE 판정과 별도로 검사).
const EXCLUDE_LABEL_RE = /포트폴리오|추천종목/i;
// IPO·비상장 라벨("KB IPO Brief"·"비상장 Tracker+"·"케이비 비상장 플러스")은
// 일반 산업분석 풀이 아니라 "비상장 리서치"(해외 IB 인사이트 탭의 국내
// 대응, INSIGHT_SOURCES)로 별도 전송한다.
const INSIGHT_LABEL_RE = /\bIPO\b|비상장/i;

const EXCERPT_LEN = 150;
function isMetaLine(l) {
  return (
    l === "www.kbsec.com" ||
    /@/.test(l) ||
    /Analyst|연구원|리서치본부장/.test(l) ||
    /^\d{4}년\s*\d{1,2}월\s*\d{1,2}일/.test(l) ||
    /^[A-Z\s]{3,}$/.test(l) // "F I R S T", "T O", "T H E" 등 스페이싱된 배너 문구
  );
}

function excerptFromPdfText(text, stockName, symbol) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const titleLine = `${stockName} (${symbol})`;
  const anchor = lines.findIndex((l) => l === titleLine);
  const rest = anchor >= 0 ? lines.slice(anchor + 2) : lines;
  const flat = rest
    .filter((l) => !isMetaLine(l) && l.length >= 10)
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!flat) return "";
  if (flat.length <= EXCERPT_LEN) return flat;
  const cut = flat.slice(0, EXCERPT_LEN);
  const boundary = Math.max(cut.lastIndexOf("다."), cut.lastIndexOf("요."), cut.lastIndexOf("함."));
  return (boundary > EXCERPT_LEN * 0.5 ? cut.slice(0, boundary + 1) : cut) + "…";
}

// API의 tp(목표주가)·recomm(투자의견)은 "F I R S T TO THE MARKET" 같은
// 뉴스 속보 노트에도 항상 채워져 있는 KB의 현재 유지값이라, 본문에 실제
// 재언급된 경우만 쓰기로 함(오너 확인, 2026-09 — 목표주가·투자의견 둘 다
// 동일 문제 지적). "목표주가"/"투자의견"이란 말이 PDF에 있는지만 검증.
function mentionsTargetPrice(text) {
  return /목표주가/.test(text);
}
function mentionsOpinion(text) {
  return /투자의견/.test(text);
}

async function extractPdfExcerpt(pdfUrl, stockName, symbol) {
  if (!pdfUrl) return { summary: "", hasTargetMention: false, hasOpinionMention: false };
  try {
    const res = await fetch(pdfUrl, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const parser = new PDFParse({ data: buf });
    const { text } = await parser.getText();
    await parser.destroy();
    return {
      summary: excerptFromPdfText(text, stockName, symbol),
      hasTargetMention: mentionsTargetPrice(text),
      hasOpinionMention: mentionsOpinion(text),
    };
  } catch (err) {
    console.warn(`  ⚠ PDF 본문 추출 실패 (${pdfUrl}): ${err.message}`);
    return { summary: "", hasTargetMention: false, hasOpinionMention: false };
  }
}

function parseTargetPrice(tp) {
  const n = Number(tp);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

async function fetchList(tab) {
  const body = new URLSearchParams({
    pCatfolderid: "",
    templateid: "",
    lowTempId: "",
    searchMonth: "3", // 최근 3개월(사이트가 지원하는 값: 1/3/6/36) — 한 번의 요청으로 충분
    searchFlag: "",
    sDocumentid: "",
    sUrlLink: "",
    wInfo: "",
    tab,
  });
  const res = await fetch(AJAX_URL, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json.list ?? [];
}

console.log(`▶ KB증권 산업/기업 + KB데일리 리포트 수집: 최근 ${DAYS}일`);
// 항목 날짜가 'YYYY-MM-DD'(=UTC 자정)라 컷오프도 자정으로 맞춘다.
// Date.now() 기준 그대로 두면 '정확히 DAYS일 전' 리포트가 시:분 차이로
// 매번 잘려나간다(실측 2026-09: 미래에셋 최신 리포트가 3시간 차이로 탈락).
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));
const rows = await fetchList("5"); // 산업/기업

const collected = [];
for (const r of rows) {
  const date = r.publicDate;
  if (!date || new Date(date) < cutoff) continue;
  const docTitle = String(r.docTitle ?? "").trim();
  const tm = docTitle.match(TITLE_RE);
  if (tm) {
    collected.push({
      id: r.documentid,
      date,
      title: (r.docTitleSub || tm[1]).trim(),
      stockName: tm[1].trim(),
      symbol: tm[2],
      analyst: r.analystNm ?? "",
      opinion: r.recomm ?? "",
      targetPrice: parseTargetPrice(r.tp),
      summary: "",
      pdfUrl: r.urlLink || null,
      views: null,
      category: "기업",
    });
  } else if (docTitle && !EXCLUDE_LABEL_RE.test(docTitle) && !isEsgContent(docTitle)) {
    // 업종명("반도체" 등)·정기 전략 노트 — 종목코드 없음. 포트폴리오/
    // 추천종목/ESG 라벨은 위에서 걸러졌고, IPO/비상장 라벨은 일반 산업분석이
    // 아니라 "비상장 리서치"(unlisted) 대상.
    collected.push({
      id: r.documentid,
      date,
      title: (r.docTitleSub || docTitle).trim(),
      stockName: docTitle,
      symbol: null,
      analyst: r.analystNm ?? "",
      opinion: "",
      targetPrice: null,
      summary: "",
      pdfUrl: r.urlLink || null,
      views: null,
      category: "산업",
      unlisted: INSIGHT_LABEL_RE.test(docTitle),
    });
  }
}

// 비상장기업(categoryid 188, "비상장 Tracker+"/"케이비 비상장 플러스") —
// tab=5 기본 조회엔 안 잡히고 `pCatfolderid=186`을 따로 줘야 나온다(실측).
// "IPO나 비상장인 경우는 종목분석>인사이트에 해당한다"(오너 지시)에 따라
// 처음부터 unlisted:true로 표시한다.
async function fetchUnlistedBoard() {
  const body = new URLSearchParams({
    pCatfolderid: "186",
    templateid: "",
    lowTempId: "",
    searchMonth: "3",
    searchFlag: "",
    sDocumentid: "",
    sUrlLink: "",
    wInfo: "",
    tab: "5",
  });
  const res = await fetch(AJAX_URL, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json.list ?? [];
}
const unlistedRows = await fetchUnlistedBoard();
for (const r of unlistedRows) {
  const date = r.publicDate;
  if (!date || new Date(date) < cutoff) continue;
  const docTitle = String(r.docTitle ?? "").trim();
  if (!docTitle) continue;
  collected.push({
    id: r.documentid,
    date,
    title: (r.docTitleSub || docTitle).trim(),
    stockName: docTitle,
    symbol: null,
    analyst: r.analystNm ?? "",
    opinion: "",
    targetPrice: null,
    summary: "",
    pdfUrl: r.urlLink || null,
    views: null,
    category: "산업",
    unlisted: true,
  });
}

// KB데일리(tab=1, categoryid 79) — 오너 지시(2026-09-24 — "kb데일리는
// 산업분석>시황에 해당한다")로 추가. 게시판 전체가 하나의 일간 시황
// 코멘트 시리즈라(예: "2026년 9월 23일 (수): KB 데일리") 키움 EM/IM
// 게시판과 같은 방식으로 stockName을 고정 라벨 "KB데일리"로 둔다 —
// `shinhan-research.ts`의 `MARKET_CONDITION_STOCKNAMES`에 등록해
// classifyResearchTopic()이 항상 시황으로 분류하게 함.
const dailyRows = await fetchList("1");
for (const r of dailyRows) {
  const date = r.publicDate;
  if (!date || new Date(date) < cutoff) continue;
  collected.push({
    id: r.documentid,
    date,
    title: (r.docTitleSub || r.docTitle || "").trim(),
    stockName: "KB데일리",
    symbol: null,
    analyst: r.analystNm ?? "",
    opinion: "",
    targetPrice: null,
    summary: "",
    pdfUrl: r.urlLink || null,
    views: null,
    category: "산업",
  });
}

// KB전략(tab=3, docTitle "KB 전략") — 오너 지시(2026-09-24 — "한국투자에서
// kb전략은 투자전략(주식)에 해당되고 kb bond는 거시경제>이슈분석에 해당된다.
// 나머지는 수집에서 제외한다"). tab=3("한국 투자")는 시황코멘트·주식전략·
// 채권/크레딧·종목컨설팅·기타발간이 섞여 있고, 응답의 `categoryid` 필드로
// 걸러도 같은 categoryid 안에 "이그전"(자산배분 계열) 같은 다른 시리즈가
// 섞여 나오는 게 실측 확인돼(categoryid만으론 부정확) **docTitle 정확히
// 일치**로만 골랐다. "KB 전략"만 수집하고 그 옆의 "KB Quant"·"이그전" 등은
// 명시적으로 제외(오너 지시의 "나머지는 제외"). stockName을 고정 라벨로 둬
// `shinhan-research.ts`의 `STRATEGY_STOCKNAMES`에 등록, 투자전략(주식)으로
// 확정 분류한다.
const tab3Rows = await fetchList("3");
for (const r of tab3Rows) {
  const date = r.publicDate;
  if (!date || new Date(date) < cutoff) continue;
  if (String(r.docTitle ?? "").trim() !== "KB 전략") continue;
  collected.push({
    id: r.documentid,
    date,
    title: (r.docTitleSub || r.docTitle || "").trim(),
    stockName: "KB 전략",
    symbol: null,
    analyst: r.analystNm ?? "",
    opinion: "",
    targetPrice: null,
    summary: "",
    pdfUrl: r.urlLink || null,
    views: null,
    category: "산업",
  });
}

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. API 구조가 바뀌었을 수 있음.");
  process.exit(1);
}
console.log(`✔ 파싱 완료: ${collected.length}건`);
console.log(
  "  최근 5건:",
  collected.slice(0, 5).map((i) => `${i.date} ${i.stockName}(${i.symbol}) — ${i.title}`),
);

console.log(`▶ PDF 본문 발췌 중 (${collected.length}건)...`);
let excerptFailCount = 0;
for (const it of collected) {
  const { summary, hasTargetMention, hasOpinionMention } = await extractPdfExcerpt(it.pdfUrl, it.stockName, it.symbol);
  it.summary = summary;
  if (!hasTargetMention) it.targetPrice = null; // 본문에 언급 없으면 tp 메타데이터도 버림
  if (!hasOpinionMention) it.opinion = ""; // 마찬가지로 recomm 메타데이터도 버림
  if (it.pdfUrl && !it.summary) excerptFailCount++;
  await sleep(400);
}
console.log(`✔ 발췌 완료 (실패 ${excerptFailCount}건)`);
console.log("  예시:", collected[0]?.summary || "(없음)");

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

// 비상장(unlisted) 항목은 일반 산업분석 풀과 섞이지 않도록 별도 source로
// 나눠 전송한다(오너 지시 — "IPO나 비상장인 경우는 종목분석>인사이트에
// 해당한다" — 키움 CI 비상장 처리와 같은 패턴, INSIGHT_SOURCES 재사용).
const UNLISTED_SOURCE = "KB증권 비상장리서치";
// 라우트(RawItem)가 알려진 필드만 읽으므로 `unlisted` 플래그는 그대로 실려가도
// 무해하다 — 굳이 벗겨내지 않는다.
const normalItems = collected.filter((it) => !it.unlisted);
const unlistedItems = collected.filter((it) => it.unlisted);

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

for (const [source, items] of [
  ["KB증권", normalItems],
  [UNLISTED_SOURCE, unlistedItems],
]) {
  if (items.length === 0) continue;
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items, source }),
  });
  const upBody = await up.text();
  if (!up.ok) {
    console.error(`✗ [${source}] 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`\n✔ [${source}] 앱 전송 완료 (${items.length}건): ${upBody}`);
}
