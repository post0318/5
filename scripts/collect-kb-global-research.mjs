/**
 * KB증권 "해외주식" 리서치 수집기 — 미국/중국/일본 3개 시장.
 *
 * 국내 수집기(collect-kb-research.mjs)와 같은 내부 TR 을 쓰고 탭만 다르다
 * (tab=5 산업/기업 -> tab=4 해외주식). 오너가 화면 URL(go.able?linkcd=m04010004)
 * 을 제시해 추가(2026-09) — 그 페이지가 같은 TR(s040203010001)을 참조하고
 * name="tab" value="4" 를 쓰는 것을 확인했다.
 *
 * 응답 특징(실측 614건):
 *  - 종목코드 필드(stockcode/stkCd)가 티커가 아니라 ISIN 이다(US00724F1012).
 *    대신 제목에 "(ADBE US)" 형태로 티커가 들어있어 그쪽에서 뽑는다.
 *  - foldertemplate 로 시장이 구분된다("해외 투자>해외투자>미국/중국/일본/...").
 *  - recomm/tp 가 비어있는 경우가 많아 공용 추출기로 본문/PDF 를 보강한다
 *    (미국만 — USD 표기 기준 추출기라 중국/일본은 대상 아님).
 *
 * 산업분석/투자전략(2026-09 추가, 오너 지시 — "미국도 산업분석을 하려면
 * 역시 해외를 읽어라"): "미국" 폴더 안에서도 티커가 없는 항목("KB Global
 * Tracker+", "Global Insights", "US Market Pulse" 등, docTitle=시리즈명·
 * docTitleSub=실제 헤드라인)은 지금까지 통째로 버려지고 있었다(실측: 미국
 * 폴더 89건 중 63건). `category:"산업"`으로 별도 수집(symbol 항상 null,
 * 목표주가·투자의견 추출은 건너뜀).
 *
 * **중국·일본 추가(오너 지시, 2026-09-24 — "kb 중국과 일본도 수집기는
 * 만들어두고")**: 같은 tab=4 응답에 이미 섞여 있던 걸(처음엔 "미국"
 * 폴더만 골라 나머지를 버렸음) `categoryid`로 정확히 갈라 market:"ch"/"jp"
 * 로 추가했다(키움 CH 게시판과 동일하게 별도 `ResearchMarketId` 태깅,
 * "us"로 합치지 않음).
 *   - **158("해외 투자 > 중국 > 산업/기업")**: 개별 종목 리포트(제목
 *     "SMIC (688981 CH, 00981 HK)"·"텐센트 (00700 HK)" 형식 — 복수 상장
 *     시 콤마로 여러 거래소 병기, 첫 번째 코드만 씀)와 "KB China Theme |
 *     {테마}"·"KB Asia Monitor" 같은 시리즈 라벨이 섞여 있다(실측). 티커
 *     패턴이 잡히면 `category:"기업"`, 아니면(시리즈 라벨) `category:"산업"`
 *     (stockName=docTitle 그대로 — 부제(docTitleSub)에 종목명이 섞여 있는
 *     경우도 있지만(예: "KB Asia Monitor" | "POP MART (09992 HK): ...")
 *     신뢰도가 낮아 개별기업으로 승격하지 않는다).
 *   - **86("해외 투자 > 중국 > 전략", "KB Asia Market Headline")**: 거의
 *     매일 올라오는 아시아 시장 헤드라인 코멘트라 고정 라벨로 두고
 *     `MARKET_CONDITION_STOCKNAMES`에 등록해 시황으로 확정 분류(KB데일리와
 *     같은 패턴).
 *   - **160("해외 투자 > 일본 > 산업/기업")**: 실측 6개월간 2건뿐으로
 *     표본이 너무 적고 제목("글로벌기업+"·"글로벌기업 | Thematic+")도
 *     종목코드 패턴이 일정치 않아(티커가 부제에만 간헐적으로 등장) 티커
 *     추출을 시도하지 않고 전부 `category:"산업"`(시리즈 라벨 고정)으로만
 *     수집한다 — 표본이 늘면 재검토.
 *
 * PDF 는 로그인 없이 받아진다(국내 수집기와 동일, rdata.kbsec.com).
 *
 * -- 실행 --
 *   node scripts/collect-kb-global-research.mjs
 *   node scripts/collect-kb-global-research.mjs --days=90 --dry-run
 */

import { readFileSync } from "node:fs";
import { enrichUsResearch } from "./lib/us-research-extract.mjs";
import { PDFParse } from "pdf-parse";

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

async function fetchList() {
  const body = new URLSearchParams({
    pCatfolderid: "",
    templateid: "",
    lowTempId: "",
    searchMonth: "3", // 최근 3개월(사이트가 지원하는 값: 1/3/6/36) — 한 번의 요청으로 충분
    searchFlag: "",
    sDocumentid: "",
    sUrlLink: "",
    wInfo: "",
    tab: "4", // 해외주식
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

// 미국: "AI 실적속보: 어도비 (ADBE US)" 형식. 국가 코드가 "US"가 아닌
// 경우도 있음(예: "ASML 홀딩 (ASML NL)" — 나스닥 ADR로도 거래되는 개별기업
// 리포트인데 "US"만 받던 정규식이 이걸 놓쳐 "산업"으로 잘못 편입되던 문제,
// 오너 지적 2026-09) — foldertemplate로 이미 "미국" 폴더만 걸러낸 뒤라 국가
// 코드 종류와 무관하게 "(TICKER XX)" 형식이면 개별기업 리포트로 본다.
const US_TICKER_RE = /\(([A-Z][A-Z.]{0,5})\s+[A-Z]{2,3}\)/;
// 중국(158): "SMIC (688981 CH, 00981 HK)"·"텐센트 (00700 HK)" — 코드+공백+
// 거래소, 복수 상장 시 콤마로 이어짐(첫 번째만 사용).
const CN_TICKER_RE = /^(.+?)\s*\(([A-Za-z0-9]{2,10})\s+([A-Za-z]{2,3})[,)]/;

function classifyRow(r) {
  const folder = String(r.foldertemplate ?? "");
  const categoryid = String(r.categoryid ?? "");
  const docTitle = String(r.docTitle ?? "").trim();
  const docTitleSub = String(r.docTitleSub ?? "").trim();
  const title = (docTitleSub || docTitle).trim();

  if (/미국/.test(folder)) {
    const tm = docTitle.match(US_TICKER_RE);
    if (tm) {
      return {
        market: "us",
        category: "기업",
        stockName: docTitle.split("(")[0].replace(/^[^:]*:\s*/, "").trim(),
        symbol: tm[1],
        title,
        enrichable: true,
      };
    }
    return { market: "us", category: "산업", stockName: docTitle || "산업", symbol: null, title, enrichable: false };
  }
  if (categoryid === "158") {
    const tm = docTitle.match(CN_TICKER_RE);
    if (tm) {
      return {
        market: "ch",
        category: "기업",
        stockName: tm[1].trim(),
        symbol: `${tm[2].toUpperCase()}.${tm[3].toUpperCase()}`,
        title,
        enrichable: false,
      };
    }
    return { market: "ch", category: "산업", stockName: docTitle || "산업", symbol: null, title, enrichable: false };
  }
  if (categoryid === "86") {
    // "KB Asia Market Headline" — 거의 매일 올라오는 시황 코멘트라 고정
    // 라벨로 둔다(MARKET_CONDITION_STOCKNAMES 등록, KB데일리와 동일 패턴).
    return { market: "ch", category: "산업", stockName: "KB Asia Market Headline", symbol: null, title, enrichable: false };
  }
  if (categoryid === "160") {
    // 일본 — 표본이 적고(6개월 2건) 제목 형식도 일정치 않아 티커 추출 없이
    // 시리즈 라벨로만 수집.
    return { market: "jp", category: "산업", stockName: docTitle || "산업", symbol: null, title, enrichable: false };
  }
  return null; // 인디아 등 그 외 지역은 대상 아님
}

console.log(`▶ KB증권 해외주식(미국/중국/일본) 리포트 수집: 최근 ${DAYS}일`);
// 항목 날짜가 'YYYY-MM-DD'(=UTC 자정)라 컷오프도 자정으로 맞춘다.
// Date.now() 기준 그대로 두면 '정확히 DAYS일 전' 리포트가 시:분 차이로
// 매번 잘려나간다(실측 2026-09: 미래에셋 최신 리포트가 3시간 차이로 탈락).
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));
const rows = await fetchList();

const collected = [];
for (const r of rows) {
  const date = r.publicDate;
  if (!date || new Date(date) < cutoff) continue;
  const parsed = classifyRow(r);
  if (!parsed) continue;
  collected.push({
    id: r.documentid,
    date,
    title: parsed.title,
    stockName: parsed.stockName,
    symbol: parsed.symbol,
    market: parsed.market,
    analyst: r.analystNm ?? "",
    opinion: parsed.enrichable ? (r.recomm ?? "") : "",
    targetPrice: parsed.enrichable ? parseTargetPrice(r.tp) : null,
    summary: "",
    pdfUrl: r.urlLink || null,
    views: null,
    category: parsed.category,
  });
}

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. API 구조가 바뀌었을 수 있음.");
  process.exit(1);
}
console.log(`✔ 파싱 완료: ${collected.length}건`);
// 목표주가·투자의견 PDF 보강은 미국 개별기업만(USD 표기 기준 추출기 —
// 중국/일본은 대상 아님, 산업분석/투자전략도 특정 종목 얘기가 아니므로 제외).
await enrichUsResearch(collected.filter((it) => it.market === "us" && it.category === "기업"));
console.log(
  "  최근 5건:",
  collected.slice(0, 5).map((i) => `[${i.market}] ${i.date} ${i.stockName}(${i.symbol}) — ${i.title}`),
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

// 시장별로 나눠 전송(라우트가 body당 market 하나만 받음).
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
    body: JSON.stringify({ items, source: "KB증권", market }),
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
