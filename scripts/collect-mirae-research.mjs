/**
 * 미래에셋증권 "기업분석" 리포트 — 로컬 수집기.
 *
 * securities.miraeasset.com 도 레거시 frameset 사이트(실제 콘텐츠는
 * contentframe → main.do)지만, 목록 자체는 평범한 서버렌더링 HTML이라
 * 직접 GET으로 받아온다: `/bbs/board/message/list.do?categoryId=1800&curPage=N`
 * (categoryId=1800 은 "투자정보 > 리서치 리포트 > 기업분석" 메뉴의
 * `javascript:openHp('/bbs/board/message/list.do?categoryId=1800')` 링크를
 * 역추적해 확인). 로그인 불필요. `robots.txt` 에 `User-agent: Yeti\nAllow: /`
 * 만 있고 다른 UA에 대한 Disallow 규칙 자체가 없음(가장 깨끗한 케이스).
 *
 * 목록에 종목명·코드(또는 해외 티커)·투자의견·PDF 직링크가 모두 들어있다.
 * 제목 형식: "종목명 (코드/의견)" + <br/> + 부제. 미래에셋은 국내(6자리 코드)와
 * 해외(예: "IONQ US", "TTAN IN") 리포트가 같은 목록에 섞여 있어 6자리 숫자
 * 코드가 아닌 항목(해외종목)은 건너뛴다. PDF는 `downConfirm(...)` 첫 인자
 * URL을 로그인 없이 그대로 GET 가능(실측: `Content-Type: application/pdf`).
 *
 * 본문 발췌(2026-09 추가): 국내 리포트 PDF는 텍스트가 커브(윤곽선)로 변환돼
 * 있어 `pdf-parse`로 뽑히지 않는다(실측 — 차트 축 숫자 몇 개만 나오고 본문은
 * 전혀 없음). 대신 목록의 `view('messageId','messageNumber')` 두 값으로
 * 상세 페이지(`/bbs/board/message/view.do?messageId=..&messageNumber=..&
 * categoryId=1800`)를 받으면 `#messageContentsDiv`에 리포트 요약 본문이
 * 이미 HTML로 들어있다(오너 확인, 2026-09 — PDF보다 오히려 나은 소스).
 * 여기서 태그를 벗기고 150자 내외만 짧게 저장 — 전체 본문은 저장하지 않음.
 *
 * ⚠️ 서버가 보낸 항목을 통째로 replace하므로, --days 기본값을 14 → 3으로
 *    좁혀 상세 페이지를 매일 다시 받는 범위를 최소화했다(유안타증권과 동일
 *    이유). 백필은 --days=30 등으로 수동 실행.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-mirae-research.mjs
 *   node scripts/collect-mirae-research.mjs --days=30 --pages=10 --dry-run
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
const MAX_PAGES = Number(ARGS.find((a) => a.startsWith("--pages="))?.split("=")[1]) || 10;

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim(); // 로컬 수동 실행 시 CRON_SECRET 없어도 인증 가능(라우트가 x-app-token도 허용)
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST_URL = "https://securities.miraeasset.com/bbs/board/message/list.do";
const CATEGORY_ID = "1800"; // 기업분석
// 산업분석/투자전략(2026-09 추가, 오너 지시 — "한국과 미국 모두 동일하게
// 수집 기반 구축"). 기업분석(1800)과 형제 메뉴 — 검색엔진에 색인된 사이트
// 자체 메뉴명(제목 태그)으로 확인: categoryId=1525 "산업분석", 1527
// "투자전략". 목록 항목이 이미 "<b>주제명</b><br/>헤드라인" 구조라 종목
// 리포트처럼 제목에서 코드/티커를 뽑을 필요가 없음 — 굵은 글씨 부분을
// 그대로 업종/전략 라벨(stockName)로 쓴다.
const INDUSTRY_CATEGORY_IDS = ["1525", "1527"];

// "종목명 (코드/의견)" — 국내는 6자리 숫자 코드.
const TITLE_RE = /^(.+?)\s*\((\d{6})\/([^)]+)\)$/;
// 해외는 "종목명 (TICKER US/의견)" 형식. US 만 받는다(IN·HK 등 다른 시장 제외).
// 제목에 투자의견이 같이 있어 다른 미국 소스와 달리 등급을 공짜로 얻는다.
const TITLE_US_RE = /^(.+?)\s*\(([A-Z][A-Z.]{0,5})\s+US\/([^)]+)\)$/;

async function fetchPage(page, categoryId = CATEGORY_ID) {
  const url = new URL(LIST_URL);
  url.searchParams.set("categoryId", categoryId);
  url.searchParams.set("curPage", String(page));
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new TextDecoder("euc-kr").decode(await res.arrayBuffer());
}

function parseItems(html) {
  const items = [];
  for (const rowHtml of html.split(/<tr[^>]*>/).slice(1)) {
    const dateM = rowHtml.match(/<td\s*>\s*(\d{4}-\d{2}-\d{2})\s*<\/td>/);
    const subjectM = rowHtml.match(
      /<a href="javascript:view\('(\d+)','(\d+)'\)"[^>]*><b>([^<]+)<\/b><br\/>([^<]*)<\/a>/,
    );
    if (!dateM || !subjectM) continue;
    const [, id, messageNumber, rawTitle, rawSummary] = subjectM;
    const title = rawTitle.trim();
    const tm = title.match(TITLE_RE);
    const um = tm ? null : title.match(TITLE_US_RE);
    if (!tm && !um) continue; // 종목 없는 리포트 또는 US 외 해외시장
    const pdfM = rowHtml.match(/downConfirm\('(https:\/\/[^']+\.pdf\?attachmentId=\d+)'/);
    const analystM = rowHtml.match(/<\/p>\s*<\/td>\s*<td\s*>\s*([^<]+?)\s*<\/td>/);
    items.push({
      id,
      messageNumber,
      date: dateM[1],
      title: rawSummary.trim() || rawTitle.trim(),
      market: tm ? "kr" : "us",
      stockName: (tm ?? um)[1].trim(),
      symbolHint: tm ? tm[2] : um[2].toUpperCase(),
      opinion: (tm ?? um)[3].trim(),
      analyst: analystM ? analystM[1].trim() : "",
      pdfUrl: pdfM ? pdfM[1] : null,
      category: "기업",
    });
  }
  return items;
}

// 산업분석(1525)·투자전략(1527) 게시판 — "산업분석(국내/해외)"란 이름대로
// 국내·해외 콘텐츠가 섞여 있는데, 목록 응답에 국가를 구분할 구조적 필드가
// 전혀 없다(KB의 foldertemplate 같은 게 없음 — 실측 확인). GM(GlobalMonitor)
// 에도 미래에셋 데이터가 아예 없어(실측 확인, auth 목록에 없음) 대체도 안
// 되므로, 오너 지시(2026-09)에 따라 제목·헤드라인 키워드로 추측 분류한다:
//  - 중국/인도/일본 등 미국·한국이 아닌 특정 국가가 명시되면 이 프로젝트가
//    다루는 시장이 아니므로 건너뜀.
//  - "글로벌"/"Global"/"해외"/"미국"/"US"/"나스닥"/"Nasdaq" 등 신호가 있으면
//    market:"us".
//  - 그 외(업종명+비중확대/축소 등 국내 브로커 관행, 국가 신호 없음)는
//    기존처럼 market:"kr" 기본값.
// 완벽한 분류는 아니었다(예: "AI Infra Signal"처럼 영문명이어도 신호
// 키워드가 없으면 kr로 남음, 오너 지적 2026-09로 확인·수정) — 전수
// 정확도보다 "타국 콘텐츠가 국내로 잘못 들어가지 않는 것"과 "명백한 해외
// 콘텐츠는 us로 건너가는 것" 두 가지를 우선한다.
const EXCLUDE_COUNTRY_RE = /중국|인도|인디아|일본|홍콩|대만|베트남|동남아/;
const US_HINT_RE = /글로벌|Global|해외|미국|\bUS\b|나스닥|Nasdaq|S&P|다우존스|연준|\bFed\b/i;
// 시리즈명만으로 해외(미국)로 강제 분류 — 신호 키워드 없이도 매회 미국 AI
// 인프라/전력/자본시장 주제인 것을 실측 확인(2026-09, 오너 지적).
const US_SERIES_PREFIXES = ["AI Infra Signal"];
function classifyMarket(label, headline) {
  const hay = `${label} ${headline}`;
  if (US_SERIES_PREFIXES.some((p) => label.trim().startsWith(p))) return "us";
  if (EXCLUDE_COUNTRY_RE.test(hay)) return null; // 이 프로젝트 대상 시장 아님
  if (US_HINT_RE.test(hay)) return "us";
  return "kr";
}

// 목록 항목이 이미 "<b>주제명</b><br/>헤드라인" 구조라 종목코드/티커
// 매칭이 필요 없음(코드가 아예 없음).
function parseIndustryItems(html, categoryId) {
  const items = [];
  for (const rowHtml of html.split(/<tr[^>]*>/).slice(1)) {
    const dateM = rowHtml.match(/<td\s*>\s*(\d{4}-\d{2}-\d{2})\s*<\/td>/);
    const subjectM = rowHtml.match(
      /<a href="javascript:view\('(\d+)','(\d+)'\)"[^>]*><b>([^<]+)<\/b><br\/>([^<]*)<\/a>/,
    );
    if (!dateM || !subjectM) continue;
    const [, id, messageNumber, rawTitle, rawSummary] = subjectM;
    const title = rawSummary.trim() || rawTitle.trim();
    const market = classifyMarket(rawTitle.trim(), title);
    if (!market) continue; // 중국/인도 등 이 프로젝트가 다루지 않는 시장
    const pdfM = rowHtml.match(/downConfirm\('(https:\/\/[^']+\.pdf\?attachmentId=\d+)'/);
    const analystM = rowHtml.match(/<\/p>\s*<\/td>\s*<td\s*>\s*([^<]+?)\s*<\/td>/);
    items.push({
      id,
      messageNumber,
      srcCategoryId: categoryId,
      date: dateM[1],
      title,
      market,
      stockName: rawTitle.trim(),
      symbolHint: null,
      opinion: "",
      analyst: analystM ? analystM[1].trim() : "",
      pdfUrl: pdfM ? pdfM[1] : null,
      category: "산업",
    });
  }
  return items;
}

const DETAIL_URL = "https://securities.miraeasset.com/bbs/board/message/view.do";
const EXCERPT_LEN = 150;

function stripHtml(s) {
  return s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();
}

function excerptFromFlat(flat) {
  if (!flat) return "";
  if (flat.length <= EXCERPT_LEN) return flat;
  const cut = flat.slice(0, EXCERPT_LEN);
  const boundary = Math.max(cut.lastIndexOf("다."), cut.lastIndexOf("요."), cut.lastIndexOf("함."));
  return (boundary > EXCERPT_LEN * 0.5 ? cut.slice(0, boundary + 1) : cut) + "…";
}

// 본문에 "목표주가를 310만원(기존 280만원)으로" 처럼 만원 단위로도 등장한다.
function extractTargetPrice(flatText) {
  const m = flatText.match(/목표주가(?:를|는|가)?\s*([\d,]+)\s*(만)?원/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, "")) * (m[2] ? 10000 : 1);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function extractDetail(id, messageNumber, categoryId = CATEGORY_ID) {
  try {
    const url = new URL(DETAIL_URL);
    url.searchParams.set("messageId", id);
    url.searchParams.set("messageNumber", messageNumber);
    url.searchParams.set("categoryId", categoryId);
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = new TextDecoder("euc-kr").decode(await res.arrayBuffer());
    const m = html.match(/id="messageContentsDiv"[^>]*>([\s\S]*?)<\/div>\s*<\/td>/);
    const flat = m ? stripHtml(m[1]).replace(/\s{2,}/g, " ").trim() : "";
    return { summary: excerptFromFlat(flat), targetPrice: extractTargetPrice(flat) };
  } catch (err) {
    console.warn(`  ⚠ 본문 발췌 실패 (id=${id}): ${err.message}`);
    return { summary: "", targetPrice: null };
  }
}

console.log(`▶ 미래에셋증권 기업분석 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
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

for (const categoryId of INDUSTRY_CATEGORY_IDS) {
  stop = false;
  for (let page = 1; page <= MAX_PAGES && !stop; page++) {
    const html = await fetchPage(page, categoryId);
    const items = parseIndustryItems(html, categoryId);
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
}

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. 페이지 구조가 바뀌었을 수 있음.");
  process.exit(1);
}
console.log(`✔ 파싱 완료: ${collected.length}건`);
console.log(
  "  최근 5건:",
  collected.slice(0, 5).map((i) => `${i.date} ${i.stockName}(${i.symbolHint}) — ${i.title}`),
);

console.log(`▶ 본문 발췌 중 (${collected.length}건)...`);
let excerptFailCount = 0;
for (const it of collected) {
  const { summary, targetPrice } = await extractDetail(it.id, it.messageNumber, it.srcCategoryId);
  it.summary = summary;
  // 산업분석/투자전략은 특정 종목 얘기가 아니므로 목표주가 개념이 없음.
  it.targetPrice = it.category === "산업" ? null : targetPrice;
  if (!it.summary) excerptFailCount++;
  await sleep(400);
}
console.log(`✔ 발췌 완료 (실패 ${excerptFailCount}건)`);
console.log("  예시:", collected[0]?.summary || "(없음)");

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const items = collected.map((it) => ({
  market: it.market ?? "kr",
  id: it.id,
  date: it.date,
  title: it.title,
  stockName: it.stockName,
  symbol: it.symbolHint,
  analyst: it.analyst,
  opinion: it.opinion,
  targetPrice: it.targetPrice,
  summary: it.summary,
  pdfUrl: it.pdfUrl,
  views: null,
  category: it.category,
}));

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;
// 국내·해외를 시장별로 나눠 보낸다 — 라우트가 호출당 market 하나만 받는다.
for (const market of ["kr", "us"]) {
  const bucket = items.filter((it) => (it.market ?? "kr") === market);
  if (bucket.length === 0) continue;
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items: bucket, source: "미래에셋증권", market }),
  });
  const upBody = await up.text();
  if (!up.ok) {
    console.error(`✗ [${market}] 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 200)}`);
    continue;
  }
  console.log(`✔ [${market}] ${bucket.length}건 전송: ${upBody}`);
}
