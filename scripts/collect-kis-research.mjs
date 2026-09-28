/**
 * 한국투자증권 "기업/산업분석" 리포트 — 로컬 수집기.
 *
 * securities.koreainvestment.com 은 모던 사이트라 목록
 * (`/main/research/research/Strategy.jsp?jkGubun=10&category1=05&category2=01
 * &rowsPerPages=50&currentPage=N`)이 평범한 서버렌더링 HTML(UTF-8)로 바로
 * 나온다(GNB "리서치" 메뉴 → "기업/산업" 서브메뉴 링크를 그대로 사용).
 * 로그인 불필요. 상세 페이지(`StrategyDetail.jsp?id=N`)도 로그인 없이 전체
 * 본문이 그대로 보이지만(실측 확인), 이 프로젝트 방침상 전체 본문은 저장하지
 * 않고 목록에 이미 노출되는 요약 발췌만 저장한다. 화면의 `prePdfFileView()`는
 * 비로그인 시 `login.jsp`로 보내지만, 공용 JS 의 옛 다운로드 서블릿은 로그인 없이
 * PDF 를 준다(2026-09-25 재점검) — 링크는 그 PDF 직링크로 건다(공통 규칙 — PDF
 * 우선, 없는 건만 상세 페이지 폴백). 아래 `kisPdfUrl()` 참고.
 *
 * 목록 제목이 "종목명 (코드):제목"(일부는 앞에 "AIR 스몰캡" 같은 태그가 더
 * 붙음) 형식이라 코드를 바로 뽑되, 종목명은 태그가 섞여 지저분할 수 있어
 * 코드로 `corpcodes.json`(DART_API_KEY 불필요, 이 프로젝트가 이미 쓰는 정적
 * 상장사 목록) 역조회해 깔끔한 이름을 쓴다. 코드가 6자리 숫자가 아닌 항목
 * (드물게 존재, 우선주 등)과 종목 코드 자체가 없는 산업/섹터 리포트는 건너뜀.
 *
 * 투자의견/목표주가(2026-09 추가): 목록 요약은 잘려 있어 안 보이지만, 상세
 * 페이지 본문(`v_info_body`) 안에 "매수 의견과 목표주가 1,000,000원을
 * 유지한다"처럼 문장으로 들어있다(오너 확인). 본문 저장 정책은 그대로 두고
 * (summary는 계속 목록 발췌만), 상세 페이지를 한 번 더 받아 이 두 값만
 * 뽑아 저장한다 — 항목당 요청이 하나 늘어 --days 기본값을 14 → 3으로 좁힘.
 *
 * ⚠️ securities.koreainvestment.com/robots.txt 는 `Disallow: /`(Googlebot 등
 *    예외)다. 다른 예외들과 동일하게 "개인용·로컬 실행·저빈도" 조건으로
 *    오너 승인(CLAUDE.md 참조, 오너가 "한국투자증권도 로그인없이 가능하다"
 *    직접 확인). 앱 배포본(Vercel)에는 이 수집 코드가 없다.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-kis-research.mjs
 *   node scripts/collect-kis-research.mjs --days=30 --pages=5 --dry-run
 */

import { readFileSync } from "node:fs";
import { enrichResearch, readPdfText } from "./lib/research-extract.mjs";
import { isCommonExcludedContent } from "./lib/exclude-filters.mjs";

// 한국투자증권 해외 리포트는 자체 작성이 아니라 해외 증권사 리서치를 국문으로 재작성한 것 — PDF 상단에
// "본 보고서는 {국가} {증권사}의 리서치 자료를 기초로 한국투자증권이 국문으로 재작성하여 발간하는
// 리포트입니다"라는 고정 문구로 원 저작 증권사 국적이 밝혀져 있다(오너 지적 2026-09-27 — "2020~2024년
// 리튬이온배터리 산업 심층 리뷰"가 中 国泰海通증권 리포트인데 미국으로 잘못 분류됨, "중국 증권사가 있으면
// 중국관련 자료다"). 제목·요약 키워드 추측보다 이게 훨씬 정확해 산업분석 글은 이걸 우선 신뢰한다.
const ORIGIN_ATTRIBUTION_RE = /본\s*보고서는\s*(중국|미국|일본|유럽|영국|홍콩)?\s*[^\s,.]{1,20}증권/;
const ORIGIN_COUNTRY_MARKET = { 중국: "ch", 홍콩: "ch", 일본: "jp", 유럽: "eu", 영국: "eu", 미국: "us" };
async function originMarketFromPdf(pdfUrl) {
  if (!pdfUrl) return null;
  const text = await readPdfText(pdfUrl);
  const m = text.match(ORIGIN_ATTRIBUTION_RE);
  if (!m) return null;
  return ORIGIN_COUNTRY_MARKET[m[1]] ?? null;
}

// 해외 기업분석(jkGubun=7) 산업분석 글의 market 판별(오너 지적 2026-09-27, 연속 4건 — "유럽 산업재인데?"·
// "중국 이차전지인데"·"중국제일자동차...중국자동차이다"·"중국 에너지/화학이다"): 이 게시판 자체가 이미
// "해외" 전용이라(국내 종목이 섞일 일이 없음) marketFromTitleLead 같은 일반 공용 함수의 "미국·일본은
// 오탐 위험 커서 보류" 제약이 적용 안 된다 — 라벨(업종명)만으론 국가를 알 수 없어 market: "us" 로
// 통째로 고정돼 있던 것을 제목+목록 요약(둘 다 PDF 없이 이미 확보되는 값) 전체에서 국가 신호를 찾아 override한다.
// 신호가 없으면 그대로 미국(기존 기본값) — 완전하지 않음(본문 PDF까지 봐야 알 수 있는 경우는 못 잡음).
//
// 라벨이 국가 아닌 "산업 버티컬"(반도체·차세대 운송 등)인 글은 본문에 협력사·행사 개최지·경쟁사 국적으로
// 중국/유럽이 언급돼도 실제 주인공은 미국 기업인 경우가 많아 오탐이 실측됐다(오너 지적 2026-09-27 — ECOC
// 2026(반도체, 스페인 개최)은 미국, "포드-중국기업 간 관계"(차세대 운송)도 미국 자동차라고 확인). 이런
// 라벨은 국가 판별 없이 미국으로 고정한다.
const US_VERTICAL_LABELS = new Set(["반도체", "차세대 운송"]);
// 업종 리포트인데 헤드라인이 특정 기업 하나만 다루는 경우("프리미엄 카드의 왕좌를 지키는 아멕스") 종목분석으로
// 승격(오너 지적 2026-09-27). 네트워크 조회 없이 자주 나오는 회사명만 소규모로 대응 — 완전하지 않음.
const KNOWN_HEADLINE_COMPANIES = [{ re: /아멕스|American\s*Express/i, name: "아메리칸 익스프레스", symbol: "AXP" }];
// jkGubun=10(기업/산업분석) 라벨 중 사실상 항상 미국 얘기인 것 — 오너 확인 2026-09-27("우주는 미국
// 산업분석이다", 스타십·SpaceX 확인). 실측 라벨은 "우주산업"(null 종목코드)으로 나온다. PDF 저작권
// 문구가 있으면 그게 우선(originMarketFromPdf 가 나중에 덮어씀).
const US_VERTICAL_LABEL_10_RE = /^우주(?:산업)?$/;
// "매크로 & 포트폴리오 전략"(Running Hot 시리즈) — 오너 지시 2026-09-27 "수집제외다".
const EXCLUDED_INDUSTRY_LABELS = new Set(["매크로 & 포트폴리오 전략"]);
function globalIndustryMarket(label, text) {
  if (US_VERTICAL_LABELS.has(label)) return "us";
  if (/중국|차이나|China\b/i.test(text)) return "ch";
  if (/유럽|유로존|Europe\b|\bEU\d*\b/.test(text)) return "eu";
  if (/일본|Japan\b/i.test(text)) return "jp";
  return "us";
}

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
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://macroresearch.vercel.app/api/cron/total-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
// Vercel 배포 보호(Vercel Authentication)가 프로덕션에 켜져 있으면 앱에 닿기
// 전에 401 이 난다 — 자동화 우회 비밀값이 있으면 헤더로 같이 보낸다(없으면 생략).
const VERCEL_BYPASS = (ENV.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim(); // 로컬 수동 실행 시 CRON_SECRET 없어도 인증 가능(라우트가 x-app-token도 허용)
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST_URL = "https://securities.koreainvestment.com/main/research/research/Strategy.jsp";
const PAGE_SIZE = 50;

const corpcodes = JSON.parse(
  readFileSync(new URL("../src/lib/markets/kr/data/corpcodes.json", import.meta.url), "utf8"),
);
const nameByCode = new Map(corpcodes.map((c) => [c.s, c.n]));

const TITLE_RE = /\((\d{6})\):\s*(.*)$/;
// 산업분석/투자전략(2026-09 추가, 오너 지시 — "한국과 미국 모두 동일하게
// 수집 기반 구축"): 같은 게시판(category2 값과 무관하게 서버가 동일 피드를
// 반환 — 실측 확인, 별도 게시판이 아님)에 종목코드 없는 "업종명:헤드라인"
// 형식(예: "화장품:예견된 조정, 조정 후 반등을 대비하자")이 섞여 있는데
// TITLE_RE 에 안 걸려 지금까지 버려졌다. 콜론 앞부분을 업종 라벨로 쓴다.
const INDUSTRY_TITLE_RE = /^([^:()]+):\s*(.*)$/;

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

// 상세 페이지 본문 텍스트 — 투자의견·목표주가는 공용 추출기가 이 텍스트에서 찾는다.
async function fetchDetailText(detailUrl) {
  try {
    const res = await fetch(detailUrl, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return [...html.matchAll(/<div class='v_info_(?:head|body)'>([\s\S]*?)<\/div>/g)]
      .map((m) => stripHtml(m[1]))
      .join(" ");
  } catch (err) {
    console.warn(`  ⚠ 상세 본문 조회 실패 (${detailUrl}): ${err.message}`);
    return "";
  }
}

async function fetchPage(page) {
  const url = new URL(LIST_URL);
  url.searchParams.set("jkGubun", "10");
  url.searchParams.set("category1", "05");
  url.searchParams.set("category2", "01");
  url.searchParams.set("rowsPerPages", String(PAGE_SIZE));
  url.searchParams.set("currentPage", String(page));
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// PDF 직링크(공통 규칙 — PDF 우선, 2026-09-25): 화면의 prePdfFileView() 는 비로그인 시
// 로그인 페이지로 보내지만, 사이트 공용 JS(common_2021.js doFiledownload)가 만드는 옛
// 다운로드 서블릿은 로그인 없이 PDF 를 준다(실측 — 국내 research05·해외 research17·전략
// research02 모두 %PDF). 경로는 category1 번호 그대로 "research/research{번호}".
const KIS_PDF_RE = /prePdfFileView\('\?category1=(\d+)&category2=\d+','([^']+\.pdf)'/i;
function kisPdfUrl(chunk) {
  const m = chunk.match(KIS_PDF_RE);
  if (!m) return null;
  return `https://file.koreainvestment.com/servlet/Download?file_path=research/research${m[1]}/&file_name=${encodeURIComponent(m[2])}`;
}

// 해외 기업분석(구 collect-kis-global-research.mjs, jkGubun=7) — "종목명
// (TICKER USA):제목" 형식만 매칭, USA 외 시장은 건너뜀.
const GLOBAL_TITLE_RE = /\(([A-Z][A-Z.]{0,5})\s+USA\)\s*:\s*(.*)$/;
async function fetchGlobalPage(page) {
  const url = new URL(LIST_URL);
  url.searchParams.set("jkGubun", "7");
  url.searchParams.set("rowsPerPages", String(PAGE_SIZE));
  url.searchParams.set("currentPage", String(page));
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
function parseGlobalItems(html) {
  const items = [];
  for (const chunk of html.split("<li>").slice(1)) {
    const idM = chunk.match(/doDetail\('(\d+)'\)/);
    const titleM = chunk.match(/<span class="body_tit">\s*([^<]+?)\s*<\/span>/);
    const summaryM = chunk.match(/<span class="body_sub">\s*([\s\S]*?)\s*<\/span>/);
    const analystM = chunk.match(/<em>([^<]*)<\/em>\s*<em>([\d.]+)<\/em>/);
    const headM = chunk.match(/<div class="head[^"]*">\s*([^<]+?)\s*<\/div>/);
    if (!idM || !titleM || !analystM) continue;
    const date = isoDate(analystM[2]);
    if (!date) continue;
    if (headM && /산업분석/.test(headM[1])) {
      const sm = titleM[1].match(/^([^:：]+)[:：]\s*(.+)$/);
      if (isCommonExcludedContent(titleM[1], "산업")) continue;
      const rawSummary = summaryM ? excerpt(stripHtml(summaryM[1])) : "";
      const headline = sm ? sm[2].trim() : titleM[1].trim();
      const label = sm ? sm[1].trim() : titleM[1].trim();
      if (EXCLUDED_INDUSTRY_LABELS.has(label)) continue;
      // 업종 라벨이지만 헤드라인이 특정 기업 하나만 다루는 경우("프리미엄 카드의 왕좌를 지키는 아멕스")는
      // 산업분석이 아니라 종목분석이다(오너 지적 2026-09-27 — "아멕스 종목분석인데"). 흔한 사명만 소규모로
      // 대응(네트워크 호출 없이) — 놓치는 사명은 산업분석에 남는다.
      const singleCompany = KNOWN_HEADLINE_COMPANIES.find((c) => c.re.test(headline));
      const rawSummary2 = rawSummary;
      items.push(singleCompany
        ? {
            id: idM[1],
            date,
            title: headline,
            stockName: singleCompany.name,
            symbol: singleCompany.symbol,
            analyst: analystM[1].trim(),
            summary: rawSummary2,
            market: "us",
            detailUrl: `https://securities.koreainvestment.com/main/research/research/StrategyDetail.jsp?jkGubun=7&id=${idM[1]}`,
            pdfUrl: kisPdfUrl(chunk),
            category: "기업",
            board: "한국투자증권 > 리서치 > 해외 기업분석(Strategy.jsp, jkGubun=7)",
          }
        : {
            id: idM[1],
            date,
            title: headline,
            stockNameOverride: label,
            symbolHint: null,
            analyst: analystM[1].trim(),
            summary: rawSummary2,
            market: globalIndustryMarket(label, `${titleM[1]} ${rawSummary}`),
            detailUrl: `https://securities.koreainvestment.com/main/research/research/StrategyDetail.jsp?jkGubun=7&id=${idM[1]}`,
            pdfUrl: kisPdfUrl(chunk),
            category: "산업",
            board: "한국투자증권 > 리서치 > 해외 기업분석(Strategy.jsp, jkGubun=7)",
          });
      continue;
    }
    const tm = titleM[1].match(GLOBAL_TITLE_RE);
    if (!tm) continue;
    const [, code, headline] = tm;
    if (isCommonExcludedContent(headline.trim(), "기업")) continue;
    items.push({
      id: idM[1],
      date,
      title: headline.trim(),
      stockNameOverride: titleM[1].split("(")[0].trim(),
      symbolHint: code,
      analyst: analystM[1].trim(),
      summary: summaryM ? excerpt(stripHtml(summaryM[1])) : "",
      detailUrl: `https://securities.koreainvestment.com/main/research/research/StrategyDetail.jsp?jkGubun=7&id=${idM[1]}`,
      pdfUrl: kisPdfUrl(chunk),
      category: "기업",
      board: "한국투자증권 > 리서치 > 해외 기업분석(Strategy.jsp, jkGubun=7)",
      market: "us",
    });
  }
  return items;
}

// 전략/이슈 리포트(구 collect-kis-strategy-research.mjs, jkGubun=6) — 종목
// 무관, category:"산업" 고정.
const NON_US_RE =
  /중국|차이나|China|일본|엔화|엔캐리|Japan|유럽|Europe|베트남|Vietnam|인도(?!네시아)|India\b|신흥국|이머징|Emerging|브라질|Brazil|대만|Taiwan/i;
const US_HINT_RE = /미국|\bUS\b|나스닥|Nasdaq|S&P|다우|연준|\bFed\b|FOMC|월가|Wall Street/i;
function classifyMarket(text) {
  if (NON_US_RE.test(text)) return null;
  if (US_HINT_RE.test(text)) return "us";
  return "kr";
}
async function fetchStrategyPage(page) {
  const url = new URL(LIST_URL);
  url.searchParams.set("jkGubun", "6");
  url.searchParams.set("rowsPerPages", String(PAGE_SIZE));
  url.searchParams.set("currentPage", String(page));
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
function parseStrategyItems(html) {
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
    if (label === "대체투자 Note" && !/원자재|commodit/i.test(titleM[1])) continue;
    let title = titleM[1].trim();
    const labelNorm = label.replace(/\s|Note/gi, "");
    const pm = title.match(/^([^:：]+)[:：]\s*(.+)$/);
    if (pm && pm[1].replace(/\s/g, "") === labelNorm) title = pm[2].trim();
    const summary = summaryM ? excerpt(stripHtml(summaryM[1])) : "";
    const market = classifyMarket(`${label} ${title} ${summary}`);
    if (!market || isCommonExcludedContent(`${label} ${title}`, "산업")) continue;
    items.push({
      id: idM[1],
      date,
      title,
      stockNameOverride: label,
      symbolHint: null,
      analyst: analystM[1].trim(),
      opinion: "",
      targetPrice: null,
      summary,
      market,
      detailUrl: `https://securities.koreainvestment.com/main/research/research/StrategyDetail.jsp?jkGubun=6&id=${idM[1]}`,
      pdfUrl: kisPdfUrl(chunk),
      category: "산업",
      board: "한국투자증권 > 리서치 > 전략/이슈 리포트(Strategy.jsp, jkGubun=6)",
    });
  }
  return items;
}

function parseItems(html) {
  const items = [];
  for (const chunk of html.split("<li>").slice(1)) {
    const idM = chunk.match(/doDetail\('(\d+)'\)/);
    const titleM = chunk.match(/<span class="body_tit">\s*([^<]+?)\s*<\/span>/);
    const summaryM = chunk.match(/<span class="body_sub">\s*([\s\S]*?)\s*<\/span>/);
    const analystM = chunk.match(/<em>([^<]*)<\/em>\s*<em>([\d.]+)<\/em>/);
    if (!idM || !titleM || !analystM) continue;
    const date = isoDate(analystM[2]);
    if (!date) continue;
    const tm = titleM[1].match(TITLE_RE);
    if (tm) {
      const [, code, headline] = tm;
      if (isCommonExcludedContent(headline.trim(), "기업")) { continue; }
      items.push({
        id: idM[1],
        date,
        title: headline.trim(),
        symbolHint: code,
        analyst: analystM[1].trim(),
        summary: summaryM ? excerpt(stripHtml(summaryM[1])) : "",
        detailUrl: `https://securities.koreainvestment.com/main/research/research/StrategyDetail.jsp?jkGubun=10&id=${idM[1]}`,
        pdfUrl: kisPdfUrl(chunk),
        category: "기업",
        board: "한국투자증권 > 리서치 > 기업/산업분석(Strategy.jsp, jkGubun=10)",
      });
      continue;
    }
    const im = titleM[1].match(INDUSTRY_TITLE_RE);
    if (!im) continue; // 콜론 형식도 아닌 예외적 제목 — 건너뜀
    if (isCommonExcludedContent(`${im[1].trim()} ${im[2].trim()}`, "산업")) continue;
    // "해외주식 369"(정정영) 정기 시리즈 — 오너 결정 2026-09-27 "수집제외다".
    if (/^해외주식\s*369$/.test(im[1].trim())) continue;
    const label10 = im[1].trim();
    items.push({
      id: idM[1],
      date,
      title: im[2].trim() || titleM[1].trim(),
      stockNameOverride: label10,
      symbolHint: null,
      analyst: analystM[1].trim(),
      summary: summaryM ? excerpt(stripHtml(summaryM[1])) : "",
      // "우주"(SpaceX·Starship 등, 오너 확인 2026-09-27 — "미국 산업분석이다") 라벨은 PDF 저작권 문구가
      // 없는 자체 작성 코너라도 사실상 전부 미국 우주산업 얘기라 고정한다. "방산"(UAE·사우디 수출 등)은
      // 국내 방산 수출 얘기일 수 있어 그대로 두고(기본 kr) PDF 저작권 확인에 맡긴다.
      market: US_VERTICAL_LABEL_10_RE.test(label10) ? "us" : undefined,
      pdfUrl: kisPdfUrl(chunk),
      category: "산업",
      board: "한국투자증권 > 리서치 > 기업/산업분석(Strategy.jsp, jkGubun=10)",
    });
  }
  return items;
}

console.log(`▶ 한국투자증권 기업/산업분석 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
// 항목 날짜가 'YYYY-MM-DD'(=UTC 자정)라 컷오프도 자정으로 맞춘다.
// Date.now() 기준 그대로 두면 '정확히 DAYS일 전' 리포트가 시:분 차이로
// 매번 잘려나간다(실측 2026-09: 미래에셋 최신 리포트가 3시간 차이로 탈락).
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));
const collected = [];
let stop = false;
for (let page = 1; page <= MAX_PAGES && !stop; page++) {
  const html = await fetchPage(page);
  const items = parseItems(html);
  if (items.length === 0) break;
  for (const it of items) {
    if (new Date(it.date) < cutoff) {
      stop = true;
      break;
    }
    collected.push(it);
  }
  await sleep(400);
}

// 해외 기업분석(jkGubun=7, market:"us").
console.log(`▶ 한국투자증권 해외 기업분석 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
let gStop = false;
for (let page = 1; page <= MAX_PAGES && !gStop; page++) {
  const html = await fetchGlobalPage(page);
  const items = parseGlobalItems(html);
  if (items.length === 0) break;
  for (const it of items) {
    if (new Date(it.date) < cutoff) {
      gStop = true;
      break;
    }
    collected.push(it);
  }
  await sleep(400);
}

// 전략/이슈 리포트(jkGubun=6, category:"산업" 고정).
console.log(`▶ 한국투자증권 전략/이슈 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
let sStop = false;
for (let page = 1; page <= MAX_PAGES && !sStop; page++) {
  const html = await fetchStrategyPage(page);
  // classifyMarket 필터 때문에 items.length===0 이 페이지 끝을 뜻하지
  // 않을 수 있어(그 페이지 항목이 전부 필터에 걸렸을 수 있음) 원본(필터 전)
  // 항목 존재 여부로 페이지 끝을 판정한다.
  const rawCount = (html.match(/doDetail\('\d+'\)/g) ?? []).length;
  if (rawCount === 0) break;
  const items = parseStrategyItems(html);
  for (const it of items) {
    if (new Date(it.date) < cutoff) continue;
    collected.push(it);
  }
  const rawDates = [...html.matchAll(/<em>[^<]*<\/em>\s*<em>([\d.]+)<\/em>/g)].map((m) => isoDate(m[1])).filter(Boolean);
  if (rawDates.length && new Date(Math.min(...rawDates.map((d) => new Date(d).getTime()))) < cutoff) {
    sStop = true;
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
  collected
    .slice(0, 5)
    .map(
      (i) =>
        `${i.date} ${i.stockNameOverride ?? nameByCode.get(i.symbolHint) ?? i.symbolHint}(${i.symbolHint}) — ${i.title}`,
    ),
);
// 산업분석 글은 PDF 상단 저작권 문구로 원 저작 증권사 국적을 확인해 market을 정확히 잡는다(오너 지시
// 2026-09-27) — jkGubun=10(국내 게시판 fallback "kr")·jkGubun=7(키워드 추측 fallback) 둘 다 적용.
// 국내 자체 리포트는 이 문구가 없어 기존 기본값(kr/키워드 추측) 그대로 유지된다.
const industryItems = collected.filter((it) => it.category === "산업" && it.pdfUrl);
console.log(`▶ 산업분석 원 저작 국가 확인 중 (PDF, ${industryItems.length}건)...`);
for (const it of industryItems) {
  const origin = await originMarketFromPdf(it.pdfUrl);
  if (origin) it.market = origin;
  await sleep(300);
}
console.log(`▶ 투자의견/목표주가 조회 중 (${collected.length}건)...`);
for (const it of collected) {
  // 산업분석은 특정 종목 얘기가 아니므로 투자의견·목표주가 개념이 없음.
  if (it.category === "산업") continue;
  it.bodyText = await fetchDetailText(it.detailUrl);
  await sleep(400);
}
// 상세 본문 → PDF(옛 다운로드 서블릿, 로그인 불필요) 순으로 공용 추출기가 찾는다.
await enrichResearch(collected, { market: "kr" });
console.log("  예시:", collected[0] && `${collected[0].opinion || "(없음)"} / ${collected[0].targetPrice ?? "(없음)"}`);

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

// 해외/전략 병합으로 market이 kr/us 섞이므로 market별로 나눠 전송.
const byMarket = new Map();
for (const it of collected) {
  const market = it.market ?? "kr";
  if (!byMarket.has(market)) byMarket.set(market, []);
  byMarket.get(market).push({
    id: it.id,
    date: it.date,
    title: it.title,
    stockName: it.stockNameOverride ?? nameByCode.get(it.symbolHint) ?? it.symbolHint,
    symbol: it.symbolHint,
    analyst: it.analyst,
    opinion: it.opinion,
    targetPrice: it.targetPrice,
    summary: it.summary,
    pdfUrl: it.pdfUrl ?? it.detailUrl, // PDF 우선, 없으면 상세 페이지
    views: null,
    category: it.category,
    board: it.board,
  });
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
  if (VERCEL_BYPASS) headers["x-vercel-protection-bypass"] = VERCEL_BYPASS;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

for (const [market, items] of byMarket) {
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items, source: "한국투자증권", market }),
  });
  const upBody = await up.text();
  if (!up.ok) {
    console.error(`✗ 앱 전송 실패(market=${market}) HTTP ${up.status}: ${upBody.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`\n✔ 앱 전송 완료(market=${market}, ${items.length}건): ${upBody}`);
}
