/**
 * 유안타증권 리서치 — 로컬 수집기(기업분석·산업분석·투자전략·경제분석).
 *
 * www.myasset.com 리서치 목록은 로그인 없이 서버렌더링 HTML로 나온다
 * (robots.txt 자체가 없음 — 명시적 Disallow는 없지만 다른 예외들과 동일하게
 * "개인용·로컬 실행·저빈도" 조건으로 오너 승인, CLAUDE.md 참조). 페이지네이션도
 * 평범한 GET(`&page=N&pgCnt=30`). 게시판은 `cd007`(+`cd008`) 값으로 나뉜다.
 *
 *   | cd007 / cd008 | 게시판          | 앱 목적지                                       |
 *   |---------------|-----------------|-------------------------------------------------|
 *   | RE01          | 기업분석        | 국내 종목분석(`data-jongcode` 종목코드)          |
 *   | RE02          | 산업분석        | 국내 산업분석(디지털 자산 Daily 제외)            |
 *   | RB30 / RB30B  | 글로벌 투자전략 | 거시경제 이슈분석(FX·엔화 등은 환율분석) —        |
 *   |               |                 | "미국 주식시장 마감 시황"(데일리)은 미수집        |
 *   | RB30 / RB30C  | 경제분석        | 거시경제 이슈분석(FX·환율 글은 환율분석)          |
 *
 * **RB30A(한국 투자전략) 제외(오너 결정, 2026-09-25 — "쓸만한게 없다")**: 처음엔
 * 고정 라벨 "유안타 투자전략"으로 투자전략(주식) 수집했으나, 실제로는 "환율,
 * 금리" 같은 배경 설명이 실린 거시 코멘트가 대부분이라 쓸 만한 종목·업종 얘기가
 * 없어 게시판 자체를 뺐다.
 *
 * **2026-09-25 직접 수집 재개(오너 결정)**: 2026-09-13 에 "발췌·목표주가·투자의견
 * 추출이 계속 실패"한다며 중단하고 한경 컨센서스 경유로 바꿨었다. 재점검에서 이
 * 수집기가 그대로 정상 작동했고(7일치 12건 — 의견 12/12, BUY 목표가 10/10) 과거
 * 실패는 재현되지 않았다(초기 버전이 빈 발췌·목표가로 넣은 문서가 남았던 것 + 한때의
 * 다운로드 경로 정규식 결함으로 추정). 오히려 한경 쪽 목표가 오류(IPARK현대산업개발
 * 34,000원이 340,000원으로 실림)가 확인돼 직접 수집으로 되돌리고, 한경 수집기에서
 * 유안타를 제외했다. 게시판도 기업분석 → 위 5개로 넓혔다(삼성증권과 같은 분류 기준).
 *
 * PDF 원문 링크: 목록 행의 `cmd-type='download' data-seq='2026/0910/172546/
 * ..._ko.pdf'` 값이 그대로 `https://file.myasset.com/sitemanager/upload/`
 * 뒤에 붙는 경로다(로그인 불필요). 링크는 이 PDF 로 건다(공통 규칙 — PDF 우선).
 *
 * 본문 발췌: 기업분석은 목록에 요약이 없어 PDF 에서 "주가수익률 (%) ..." 통계
 * 블록 다음부터 150자 내외를 발췌한다. 산업·전략·경제 게시판은 목록 제목 아래
 * 부제(<p>)가 곧 요약이라 그걸 쓴다(PDF 를 받지 않음). PDF 원문·전체 본문은
 * 저장하지 않는다.
 *
 * ⚠️ 서버(/api/cron/total-research)는 보낸 항목을 통째로 replace한다 —
 *    그래서 --days 기본값을 3으로 좁혀 "매일 최근 며칠만 다시 훑는" 방식이다.
 *    백필은 --days=30 등으로 수동 실행.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-yuanta-research.mjs
 *   node scripts/collect-yuanta-research.mjs --days=30 --pages=10 --dry-run
 */

import { readFileSync } from "node:fs";
import { enrichResearch, readPdfText } from "./lib/research-extract.mjs";
import {
  isEtfOrEtpContent,
  isEsgContent,
  isFxContent,
  isCommonExcludedContent,
  isCommodityContent,
} from "./lib/exclude-filters.mjs";
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
const MAX_PAGES = Number(ARGS.find((a) => a.startsWith("--pages="))?.split("=")[1]) || 5;

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://macroresearch.vercel.app/api/cron/total-research"
).trim();
const MACRO_IMPORT_URL = (
  ENV.MACRO_ISSUES_IMPORT_URL || "https://macroresearch.vercel.app/api/cron/macro-issues"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim(); // 로컬 수동 실행 시 CRON_SECRET 없어도 인증 가능(라우트가 x-app-token도 허용)
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST_URL = "https://www.myasset.com/myasset/research/rs_list/rs_list.cmd";
const SOURCE = "유안타증권";

// kind: company(종목) / industry(업종 라벨) / global(해외 전략 — 거시 이슈로) / macro(이슈분석)
const BOARDS = [
  { cd007: "RE01", cd008: "", label: "기업분석", kind: "company" },
  { cd007: "RE02", cd008: "", label: "산업분석", kind: "industry" },
  { cd007: "RB30", cd008: "RB30B", label: "글로벌 투자전략", kind: "global" },
  { cd007: "RB30", cd008: "RB30C", label: "경제분석", kind: "macro" },
];
// 다른 증권사도 디지털자산 게시판은 수집하지 않는다(키움 BC·iM 디지털자산 등과 동일).
const DIGITAL_ASSET_RE = /디지털\s*자산|\bBTC\b|스테이블\s*코인|\bstable\s*coin\b|가상자산|암호화폐/i;
// "리서치 Top-Picks Follow up" — 월간 추천종목 목록(추천종목 공통 제외와 같은 취지).
const TOP_PICKS_RE = /top\s*-?\s*picks/i;
// 글로벌 전략 게시판의 데일리 미국 마감 시황(AI 생성) — 시황으로 확정 분류.
const US_MARKET_CONDITION_RE = /미국\s*주식시장\s*(?:마감\s*)?시황/;

const isoDate = (s) => {
  const m = String(s).trim().match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
function stripHtml(s) {
  return s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();
}

const FILE_BASE = "https://file.myasset.com/sitemanager/upload/";
const EXCERPT_LEN = 150;

// 리포트 PDF 상단은 항상 "목표주가/시가총액/... /주가수익률 (%) 1개월 3개월
// 12개월" 통계 블록 + 그 아래 절대/상대/절대(달러환산) 3줄로 끝난다. 이 헤더
// 라인 다음부터가 실제 본문이라, 그 뒤 텍스트만 골라 짧게 자른다.
function excerptFromPdfText(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const anchor = lines.findIndex((l) => l.startsWith("주가수익률"));
  const bodyLines = anchor >= 0 ? lines.slice(anchor + 4) : lines.slice(17);
  const flat = bodyLines
    .filter((l) => l.length >= 10) // 짧은 소제목 줄은 건너뛰고 실제 문장부터
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!flat) return "";
  if (flat.length <= EXCERPT_LEN) return flat;
  const cut = flat.slice(0, EXCERPT_LEN);
  const boundary = Math.max(cut.lastIndexOf("다."), cut.lastIndexOf("요."), cut.lastIndexOf("함."));
  return (boundary > EXCERPT_LEN * 0.5 ? cut.slice(0, boundary + 1) : cut) + "…";
}

async function fetchPage(board, page) {
  const url = new URL(LIST_URL);
  url.searchParams.set("cd006", "");
  url.searchParams.set("cd007", board.cd007);
  url.searchParams.set("cd008", board.cd008);
  url.searchParams.set("page", String(page));
  url.searchParams.set("pgCnt", "30");
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// 행(<tr>) 단위로 잘라서 필드별로 따로 매칭한다 — 느슨한 구간([\s\S]{0,N}?)
// 뒤에 선택 그룹(?:...)?을 바로 붙이면 정규식이 아무것도 건너뛰지 않고 "그룹
// 없음"으로 즉시 매칭을 끝내버려 다운로드 경로를 절대 못 찾는 문제가 있었다.
const ROW_SPLIT_RE = /<tr class="js-moveRS">([\s\S]*?)<\/tr>/g;
const DATE_RE = /<td>(\d{4}\/\d{2}\/\d{2})<\/td>/;
const JONG_RE = /data-jongcode="\(?(\d{6})\)?">([^<]+)<\/a>/;
const OPINION_RE = /class="js-ivstComment">([^<]*)<\/td>/;
const TITLE_RE = /cmd-type="view" data-seq="(\d+)"[^>]*>([^<]+)/;
// 제목 아래 부제 — 산업·전략·경제 게시판의 요약으로 쓴다.
const SUBTITLE_RE = /<p class="[^"]*ellipsis[^"]*">([\s\S]*?)<\/p>/;
const DOWNLOAD_RE = /cmd-type='download' data-seq='([^']+)'/;

function parseRows(html, board) {
  const rows = [];
  for (const rowMatch of html.matchAll(ROW_SPLIT_RE)) {
    const row = rowMatch[1];
    const dateM = row.match(DATE_RE);
    const titleM = row.match(TITLE_RE);
    if (!dateM || !titleM) continue;
    const date = isoDate(dateM[1]);
    if (!date) continue;
    const jongM = row.match(JONG_RE);
    if (board.kind === "company" && !jongM) continue; // 기업분석은 종목코드가 있는 행만
    const downloadM = row.match(DOWNLOAD_RE);
    rows.push({
      id: titleM[1],
      date,
      title: stripHtml(titleM[2]),
      subtitle: stripHtml(row.match(SUBTITLE_RE)?.[1] ?? ""),
      stockName: jongM ? jongM[2].trim() : "",
      symbolHint: jongM ? jongM[1] : null,
      opinion: (row.match(OPINION_RE)?.[1] ?? "").trim(),
      pdfUrl: downloadM ? FILE_BASE + downloadM[1] : null,
    });
  }
  return rows;
}

// 게시판별 목적지로 변환. null 이면 수집 제외.
function toItem(r, board) {
  const text = `${r.title} ${r.subtitle}`;
  if (isEtfOrEtpContent(text) || isEsgContent(text)) return null;
  // 공통 제외 — 주간물·일정표·추천종목·원자재 외 대체투자(오너 지시 2026-09-25).
  if (isCommonExcludedContent(r.title, board.kind === "company" ? "기업" : "산업")) return null;
  const base = {
    id: r.id,
    date: r.date,
    analyst: "",
    opinion: "",
    targetPrice: null,
    summary: r.subtitle,
    pdfUrl: r.pdfUrl,
    views: null,
  };
  if (board.kind === "company") {
    return {
      ...base,
      title: r.title,
      stockName: r.stockName,
      symbol: r.symbolHint,
      opinion: r.opinion, // 목록 칸 — 공용 추출기가 본문 언급 확인 후 사용
      summary: "",
      category: "기업",
      market: "kr",
    };
  }
  if (board.kind === "industry") {
    if (DIGITAL_ASSET_RE.test(r.title) || TOP_PICKS_RE.test(r.title)) return null;
    const { label, headline } = industryLabelAndHeadline(r.title);
    return { ...base, title: headline, stockName: label, symbol: null, category: "산업", market: "kr" };
  }
  // macro(경제분석 RB30C) / global(글로벌 투자전략 RB30B, 2026-09-25 이슈분석으로
  // 전환) / 원자재 글(어느 게시판이든) 전부 거시경제 이슈분석으로.
  if (board.kind === "macro" || board.kind === "global" || isCommodityContent(r.title)) {
    // global 게시판의 미국 시황(마감 코멘트)만 수집하지 않는다(오너 지시
    // 2026-09-25 — "유안타 미국 시황은 수집하지 않는다").
    if (board.kind === "global" && US_MARKET_CONDITION_RE.test(r.title)) return null;
    return { ...base, title: r.title, topic: isFxContent(r.title) ? "환율분석" : "이슈분석" };
  }
  return null; // 정의되지 않은 게시판 kind — 안전하게 건너뜀
}

console.log(`▶ 유안타증권 리서치 수집(${BOARDS.map((b) => b.label).join("·")}): 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
// 항목 날짜가 'YYYY-MM-DD'(=UTC 자정)라 컷오프도 자정으로 맞춘다.
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));
const collected = [];
for (const board of BOARDS) {
  let stop = false;
  let count = 0;
  for (let page = 1; page <= MAX_PAGES && !stop; page++) {
    const rows = parseRows(await fetchPage(board, page), board);
    if (rows.length === 0) break;
    for (const r of rows) {
      if (new Date(r.date) < cutoff) {
        stop = true;
        break;
      }
      const it = toItem(r, board);
      if (it) {
        collected.push({ ...it, board: board.label });
        count++;
      }
    }
    await sleep(400);
  }
  console.log(`  ${board.label}: ${count}건`);
}

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. 페이지 구조가 바뀌었을 수 있음.");
  process.exit(1);
}
const research = collected.filter((it) => !it.topic);
const macro = collected.filter((it) => it.topic);
console.log(`✔ 파싱 완료: 리서치 ${research.length}건 · 거시경제 ${macro.length}건`);

// 기업분석만 PDF 에서 발췌(목록에 요약이 없음). 텍스트는 공용 추출기가 다시 쓴다(캐시).
const companyItems = research.filter((it) => it.category === "기업");
console.log(`▶ 기업분석 PDF 본문 발췌 중 (${companyItems.length}건)...`);
let excerptFailCount = 0;
for (const it of companyItems) {
  const pdfText = await readPdfText(it.pdfUrl);
  it.summary = pdfText ? excerptFromPdfText(pdfText) : "";
  it.pdfText = pdfText;
  if (it.pdfUrl && !it.summary) excerptFailCount++;
  await sleep(500);
}
console.log(`✔ 발췌 완료 (실패 ${excerptFailCount}건)`);
// 투자의견(목록 칸 → 본문 언급 확인)·목표주가 — 공용 추출기. PDF 는 위에서 이미 읽었다.
await enrichResearch(research, { market: "kr", usePdf: false });
for (const it of collected) {
  console.log(
    `  [${it.board}→${it.topic ?? `${it.market}/${it.category}`}] ${it.date} ${it.symbol ?? it.stockName ?? ""}` +
      `${it.opinion ? ` 의견=${it.opinion}` : ""}${it.targetPrice != null ? ` 목표가=${it.targetPrice}` : ""} — ${it.title}`,
  );
}

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

// 라우트가 POST 1회당 market 하나만 받으므로 시장별로 나눠 전송.
const byMarket = new Map();
for (const it of research) {
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
for (const [market, items] of byMarket) {
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items, source: SOURCE, market }),
  });
  const upBody = await up.text();
  if (!up.ok) {
    console.error(`✗ [${market}] 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`✔ [${market}] 앱 전송 완료 (${items.length}건): ${upBody}`);
}

// 거시경제 이슈분석/환율분석 — topic 별로 나눠 전송.
const byTopic = new Map();
for (const it of macro) {
  if (!byTopic.has(it.topic)) byTopic.set(it.topic, []);
  byTopic.get(it.topic).push({
    id: it.id,
    date: it.date,
    title: it.title,
    analyst: it.analyst,
    summary: it.summary,
    pdfUrl: it.pdfUrl,
  });
}
for (const [topic, items] of byTopic) {
  const up = await fetch(MACRO_IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items, source: SOURCE, topic }),
  });
  const upBody = await up.text();
  if (!up.ok) {
    console.error(`✗ [${topic}] 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`✔ [${topic}] 앱 전송 완료 (${items.length}건): ${upBody}`);
}
