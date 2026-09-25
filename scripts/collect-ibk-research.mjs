/**
 * IBK투자증권 리서치 수집기 — 기업분석·산업분석·전략/시황(국내) + 해외기업(미국)
 * + 경제/채권(거시경제 이슈분석).
 *
 * 조사 근거(오너 결정 2026-09-25 — 삼성증권과 같은 기준으로 분류):
 *  - www.ibks.com/robots.txt 는 `User-Agent: * / Allow: /`(제한 없음). 로그인·쿠키·
 *    리퍼러 없이 목록·상세·PDF 가 모두 열린다(실측). 그래도 다른 예외들과 같은
 *    조건(개인용·저빈도·요청 간격 ≥300ms)으로 진행.
 *  - 응답은 **EUC-KR** — `TextDecoder("euc-kr")` 로 디코딩.
 *  - 목록은 서버렌더 HTML, 페이지당 10건 고정(`current_page=N`). 기간 필터는
 *    `start_reg_date=YYYYMMDD&end_reg_date=YYYYMMDD` 형식만 동작한다.
 *  - 게시판 URL 이름이 실제 메뉴와 뒤바뀌어 있다: `businessAnalysis_list.do` 가
 *    기업분석, `enterpriseAnalysis_list.do` 가 산업분석.
 *
 *   | 게시판(목록 .do)     | 사이트 메뉴   | 상세 함수(onclick)            | PDF 폴더        | 앱 목적지                             |
 *   |----------------------|---------------|-------------------------------|-----------------|---------------------------------------|
 *   | businessAnalysis     | 기업분석      | businessAnalysisView(seq)     | busreport       | 국내 종목분석(category 기업)          |
 *   | enterpriseAnalysis   | 산업분석      | enterpriseAnalysisView(seq)   | indreport       | 국내 산업분석(대괄호 라벨)            |
 *   | strategy (STRATEGY)  | 전략/시황     | strategyView(seq, gubun)      | invreport       | 국내 산업분석 "IBK 투자전략"          |
 *   | strategy (DAIL)      | 전략/시황     | strategyView(seq, 'DAIL')     | invrespect      | 국내 산업분석 "IBKS Daily"(시황)      |
 *   | morning              | 경제/채권     | morningView(seq)              | comment         | 거시경제 이슈분석/환율분석(kr_research)|
 *   | overseasBus          | 해외기업      | DetailView(seq)               | overseasreport  | 미국 종목분석(티커를 뽑을 수 있을 때만) |
 *
 *  - 목록 제목은 산업·전략·경제 게시판에서 "..."으로 잘린다 → 상세 페이지
 *    (`{게시판}_view.do?seq=N&popup=null`, 전략은 `&gubun=` 필요)를 열어 전체 제목·
 *    요약 본문·첨부 PDF 를 읽는다. strategy 게시판은 DAIL 과 STRATEGY 의 seq 가
 *    서로 다른 번호 체계라 id 에 구분값을 넣는다.
 *  - PDF 는 첨부 링크(`download.jsp?filepath=/files/tradeinfo/{폴더}&filename=...`)와
 *    같은 파일이 정적 경로 `/files/tradeinfo/{폴더}/{파일명}` 으로 로그인 없이 열린다
 *    (실측 200, application/pdf). pdfUrl 은 PDF 직링크 우선(오너 공통 규칙) — PDF 가
 *    없는 글만 상세 URL 로 폴백.
 *  - 종목코드가 목록·상세 어디에도 없다. 기업분석 제목 "[씨엠티엑스] …" 의 대괄호
 *    종목명을 corpcodes.json 에서 **이름 정확 일치**로 찾아 symbol 을 채우고, 못
 *    찾으면 null(서버 라우트가 이름 검색).
 *  - 해외기업 제목은 "[TSMC] …" 처럼 회사명만 있어 티커가 없다. 제목에 명시적
 *    티커 표기("(TSM US)"·"(TSM.US)"·"(NYSE:TSM)")가 있을 때만 수집하고 나머지는
 *    건너뛴다(회사명→티커 추측 안 함). "[IBKS Global S&P500 Daily] PEER TABLE" 도
 *    같은 게시판이지만 종목 리포트가 아니라 건너뜀. 2026-07-20 이후 새 글이 없어
 *    0건이 정상.
 *  - 투자의견·목표주가는 상세 요약 문장("투자의견 매수, 목표주가 115,000원을
 *    제시한다")에 있어 요약 전체를 bodyText 로 공용 추출기에 넘긴다(본문에 없을
 *    때만 PDF 확인). 저장하는 summary 는 300자 내외 발췌뿐.
 *  - 공통 제외: ETF/ETP·ESG·주간물·일정표·추천종목·대체투자(원자재 제외). 원자재
 *    글은 기업 리포트가 아니면 거시경제 이슈분석으로 보낸다.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-ibk-research.mjs
 *   node scripts/collect-ibk-research.mjs --days=14 --dry-run
 */

import { readFileSync } from "node:fs";
import { enrichResearch } from "./lib/research-extract.mjs";
import { isEtfOrEtpContent, isEsgContent, isCommonExcludedContent, isCommodityContent, isFxContent } from "./lib/exclude-filters.mjs";
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
const MAX_PAGES = Number(ARGS.find((a) => a.startsWith("--pages="))?.split("=")[1]) || 20;

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://macroresearch.vercel.app/api/cron/total-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const REQUEST_GAP_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = "https://www.ibks.com";
const RESEARCH = `${BASE}/investment/research`;
const SOURCE = "IBK투자증권";
const DAILY_LABEL = "IBKS Daily";
const STRATEGY_LABEL = "IBK 투자전략";
const SUMMARY_CHARS = 300;

// key: id 네임스페이스, list: 목록 .do 이름, fn: 목록 onclick 상세 함수명.
const BOARDS = [
  { key: "business", list: "businessAnalysis", fn: "businessAnalysisView", label: "기업분석", kind: "krCompany" },
  { key: "enterprise", list: "enterpriseAnalysis", fn: "enterpriseAnalysisView", label: "산업분석", kind: "krIndustry" },
  { key: "strategy", list: "strategy", fn: "strategyView", label: "전략/시황", kind: "strategy" },
  { key: "morning", list: "morning", fn: "morningView", label: "경제/채권", kind: "macro" },
  { key: "overseas", list: "overseasBus", fn: "DetailView", label: "해외기업", kind: "us" },
];

// 대괄호 종목명 → 코드(이름 정확 일치).
const CORP_BY_NAME = new Map();
for (const c of JSON.parse(
  readFileSync(new URL("../src/lib/markets/kr/data/corpcodes.json", import.meta.url), "utf8"),
)) {
  if (c.s && c.n && !CORP_BY_NAME.has(c.n)) CORP_BY_NAME.set(c.n, c.s);
}

// 해외 제목의 명시적 티커 표기만: "(TSM US)", "(TSM.US)", "(NYSE:TSM)", "(NASDAQ: NVDA)".
const US_TICKER_RE =
  /\(\s*(?:([A-Z][A-Z0-9.-]{0,9})[\s.]US|(?:NYSE|NASDAQ|AMEX|NYSEARCA)\s*[:：]\s*([A-Z][A-Z0-9.-]{0,9}))\s*\)/;

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return new TextDecoder("euc-kr").decode(await res.arrayBuffer());
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", bull: "•", plusmn: "±", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”" };
function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
function htmlToText(html) {
  return decodeEntities(
    String(html ?? "")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:div|p|b|li|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** 목록 한 페이지 → [{seq, gubun, date, analyst, listTitle}] */
function parseList(html, board) {
  const rows = [];
  for (const tr of html.matchAll(/<tr class="tr_[a-z]+">([\s\S]*?)<\/tr>/g)) {
    const row = tr[1];
    const on = row.match(new RegExp(`${board.fn}\\('(\\d+)'(?:\\s*,\\s*'([A-Z]+)')?\\)`, "i"));
    if (!on) continue;
    const date = row.match(/td_type_day">\s*(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!date) continue;
    const tds = [...row.matchAll(/<td class="td_type_wrt">([\s\S]*?)<\/td>/g)].map((m) => htmlToText(m[1]));
    const listTitle = htmlToText(row.match(/<a [^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "");
    rows.push({ seq: on[1], gubun: on[2] ?? null, date, analyst: tds[tds.length - 1] ?? "", listTitle });
  }
  return rows;
}

function detailUrl(board, row) {
  const g = row.gubun ? `&gubun=${row.gubun}` : "";
  return `${RESEARCH}/${board.list}_view.do?seq=${row.seq}${g}&popup=null`;
}

/** 상세 → {title, analyst, pdfUrl, body} */
function parseDetail(html) {
  const title = htmlToText(html.match(/<span class="tt_txt1">([\s\S]*?)<\/span>/)?.[1] ?? "");
  const analyst = htmlToText(
    html.match(/<span class="tt">작성자<\/span>\s*<span class="tt_txt">([\s\S]*?)<\/span>/)?.[1] ?? "",
  );
  const fm = html.match(/filepath=(\/files\/tradeinfo\/[A-Za-z0-9_]+)&(?:amp;)?filename=([^"&]+\.pdf)/i);
  const pdfUrl = fm ? `${BASE}${fm[1]}/${fm[2]}` : null;
  const bodyHtml = html.match(/<div class="view_box_txt2">([\s\S]*?)<div class="view_btn_group">/)?.[1] ?? "";
  return { title, analyst, pdfUrl, body: htmlToText(bodyHtml) };
}

function excerpt(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= SUMMARY_CHARS) return t;
  const cut = t.slice(0, SUMMARY_CHARS);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("다. "));
  return (end > SUMMARY_CHARS * 0.6 ? cut.slice(0, end + 1) : cut).trim() + "…";
}

/** 게시판·제목 → 앱 목적지. null 이면 건너뜀. */
function classify(board, row, title) {
  // 공용 FX 판정(오너 지적 2026-09-25) — 경제/채권 게시판이 FX 분기 없이 전부
  // 이슈분석으로만 갔다. 리서치 분류 체계 전면 개편(2026-09-26)으로
  // macro_issues 컬렉션 폐지 — 고정 stockName(shinhan-research.ts
  // FORCED_ISSUE_STOCKNAMES/FORCED_FX_STOCKNAMES 등록)으로 kr_research에 합류
  // (이 게시판은 경제·채권을 함께 다뤄 별도 board 구분이 없다).
  if (board.kind === "macro") {
    const isFx = isFxContent(title);
    return { category: "산업", market: "kr", stockName: isFx ? "IBK 경제 FX" : "IBK 경제", symbol: null, title };
  }
  const { label, headline } = industryLabelAndHeadline(title);
  if (board.kind === "krCompany") {
    const bm = title.match(/^\[([^\]]+)\]\s*(.+)$/);
    if (bm && !/IBKS/i.test(bm[1])) {
      const name = bm[1].trim();
      return { category: "기업", market: "kr", stockName: name, symbol: CORP_BY_NAME.get(name) ?? null, title: bm[2].trim() };
    }
    // 대괄호 종목명이 아닌 글(시리즈물 등)은 산업분석으로.
  }
  if (board.kind === "us") {
    const tm = title.match(US_TICKER_RE);
    if (!tm) return null;
    const bm = title.match(/^\[([^\]]+)\]\s*(.+)$/);
    return {
      category: "기업",
      market: "us",
      stockName: (bm?.[1] ?? title.slice(0, tm.index)).trim(),
      symbol: (tm[1] ?? tm[2]).toUpperCase(),
      title: (bm?.[2] ?? title).replace(US_TICKER_RE, "").trim(),
    };
  }
  // 원자재 글은 기업 리포트가 아니면 거시경제 이슈분석.
  if (isCommodityContent(title)) {
    const isFx = isFxContent(title);
    return { category: "산업", market: "kr", stockName: isFx ? "IBK 원자재 FX" : "IBK 원자재", symbol: null, title };
  }
  if (board.kind === "strategy") {
    const fixed = row.gubun === "DAIL" ? DAILY_LABEL : STRATEGY_LABEL;
    return { category: "산업", market: "kr", stockName: fixed, symbol: null, title: headline || title };
  }
  // krIndustry(및 기업분석 게시판의 비종목 글)
  if (/IBKS\s*Daily/i.test(label)) {
    // "[IBKS Daily] 인터넷/게임" 은 업종 정기 커버리지 — 기존 분류 규칙
    // (shinhan-research.ts classifyResearchTopic 주석: IBK "IBKS Daily"(stockName
    // "인터넷/게임")는 시황이 아님)에 맞춰 업종명을 stockName 으로 둔다. 날짜·
    // Morning Brief 처럼 업종명이 아닌 헤드라인만 "IBKS Daily"(시황).
    const sector = /^[가-힣A-Za-z0-9&·/\s]{1,20}$/.test(headline) && !/brief|morning|\d{6}/i.test(headline);
    return sector
      ? { category: "산업", market: "kr", stockName: headline.trim(), symbol: null, title: `IBKS Daily ${headline.trim()}` }
      : { category: "산업", market: "kr", stockName: DAILY_LABEL, symbol: null, title: headline || title };
  }
  return { category: "산업", market: "kr", stockName: label || "산업", symbol: null, title: headline || title };
}

console.log(`▶ IBK투자증권 리서치 수집(${BOARDS.map((b) => b.label).join("·")}): 최근 ${DAYS}일`);
const now = new Date();
const startDate = new Date(now.getTime() - DAYS * 86_400_000);
const cutoffStr = startDate.toISOString().slice(0, 10);

const collected = [];
const skipped = { excluded: 0, noTicker: 0, detailFail: 0 };
for (const board of BOARDS) {
  const rows = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url =
      `${RESEARCH}/${board.list}_list.do?popup=null&current_page=${page}` +
      `&start_reg_date=${ymd(startDate)}&end_reg_date=${ymd(now)}`;
    const html = await fetchText(url);
    await sleep(REQUEST_GAP_MS);
    const got = parseList(html, board);
    // 기간 필터를 건 상태에서 마지막 페이지를 넘기면 서버가 1페이지를 다시 돌려준다
    // (실측) — 이미 본 seq 만 나오면 끝으로 본다.
    const fresh = got.filter((r) => r.date >= cutoffStr && !seen.has(`${r.gubun}:${r.seq}`));
    for (const r of fresh) seen.add(`${r.gubun}:${r.seq}`);
    rows.push(...fresh);
    if (got.length < 10 || fresh.length < got.length) break;
  }
  let kept = 0;
  for (const row of rows) {
    let detail;
    try {
      detail = parseDetail(await fetchText(detailUrl(board, row)));
    } catch (e) {
      console.warn(`  ⚠ 상세 실패 ${board.key}:${row.seq} — ${e.message}`);
      skipped.detailFail++;
      continue;
    } finally {
      await sleep(REQUEST_GAP_MS);
    }
    const title = detail.title || row.listTitle.replace(/\.\.\.$/, "");
    if (isEtfOrEtpContent(title) || isEsgContent(title)) {
      skipped.excluded++;
      continue;
    }
    const dest = classify(board, row, title);
    if (!dest) {
      skipped.noTicker++;
      continue;
    }
    if (isCommonExcludedContent(title, dest.category)) {
      skipped.excluded++;
      continue;
    }
    const idKey = row.gubun ? `${board.key}-${row.gubun}` : board.key;
    collected.push({
      id: `${idKey}:${row.seq}`,
      date: row.date,
      analyst: detail.analyst || row.analyst,
      opinion: "",
      targetPrice: null,
      summary: excerpt(detail.body),
      bodyText: detail.body,
      // PDF 직링크 우선, 없으면 전송 직전 상세 URL 로 폴백(오너 공통 규칙).
      pdfUrl: detail.pdfUrl,
      detailUrl: detailUrl(board, row),
      views: null,
      source: SOURCE,
      board: idKey,
      title,
      ...dest,
    });
    kept++;
  }
  console.log(`  ${board.label}(${board.list}): 목록 ${rows.length}건 → 수집 ${kept}건`);
}
console.log(
  `  건너뜀: 공통 제외 ${skipped.excluded} · 해외 티커 없음 ${skipped.noTicker} · 상세 실패 ${skipped.detailFail}`,
);

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. 페이지 구조가 바뀌었을 수 있음.");
  process.exit(1);
}
const research = collected;
console.log(`✔ 파싱 완료: ${research.length}건`);

// 투자의견·목표주가 — 상세 요약(bodyText) → PDF(직링크일 때만) 순.
const stockItems = research.filter((it) => it.category === "기업");
console.log(`▶ 투자의견/목표주가 추출 — ${stockItems.length}건...`);
await enrichResearch(stockItems, { market: "kr", sleepMs: REQUEST_GAP_MS, usePdf: true });
for (const it of collected) {
  delete it.bodyText;
  it.pdfUrl ??= it.detailUrl;
  delete it.detailUrl;
}

for (const i of collected) {
  console.log(
    `  [${i.board}→${i.topic ?? `${i.market}/${i.category}`}] ${i.date} ${i.symbol ?? "-"} ${i.stockName ?? ""}` +
      `${i.opinion ? ` (${i.opinion})` : ""}${i.targetPrice != null ? ` TP ${i.targetPrice}` : ""} — ${i.title} [${i.analyst}]`,
  );
}
if (stockItems.length) {
  const krStocks = stockItems.filter((it) => it.market === "kr");
  const pct = (n, d) => (d ? `${n}/${d} (${Math.round((n / d) * 100)}%)` : "0/0");
  console.log(
    `  기업 채움 비율 — 종목코드 ${pct(krStocks.filter((i) => i.symbol).length, krStocks.length)}` +
      ` · 의견 ${pct(stockItems.filter((i) => i.opinion).length, stockItems.length)}` +
      ` · 목표가 ${pct(stockItems.filter((i) => i.targetPrice != null).length, stockItems.length)}`,
  );
}

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

// 라우트가 POST 1회당 source·market 하나만 받으므로 market 별로 나눠 전송.
const groups = new Map();
for (const it of research) {
  if (!groups.has(it.market)) groups.set(it.market, []);
  groups.get(it.market).push({
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
for (const [market, items] of groups) {
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items, source: SOURCE, market }),
  });
  const upBody = await up.text();
  if (!up.ok) {
    console.error(`✗ [${SOURCE}/${market}] 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`✔ [${SOURCE}/${market}] 앱 전송 완료 (${items.length}건): ${upBody}`);
}
