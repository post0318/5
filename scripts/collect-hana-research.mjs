/**
 * 하나증권 "기업분석" 리포트 — 로컬 수집기.
 *
 * www.hanaw.com 의 리서치센터 목록은 로그인 없이 그대로 서버렌더링된 HTML로
 * 나온다(신한과 달리 별도 JSON API 역추적이 필요 없음 — 페이지네이션도 평범한
 * GET 쿼리스트링). 제목이 "종목명(종목코드.거래소/투자의견): 제목" 형식으로
 * 고정돼 있어 종목코드를 별도 매핑 없이 제목에서 바로 뽑는다.
 *
 * ⚠️ www.hanaw.com/robots.txt 는 `Disallow: /` (Googlebot·Yeti 제외)다. 신한과
 *    동일하게 "개인용·로컬 실행·저빈도" 조건으로 오너 승인(CLAUDE.md 참조).
 *    앱 배포본(Vercel)에는 이 수집 코드가 없다 — DB 적재 라우트는 결과만 받는다.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-hana-research.mjs             # 최근 14일, 최대 5페이지
 *   node scripts/collect-hana-research.mjs --days=30 --pages=10
 *   node scripts/collect-hana-research.mjs --dry-run   # 전송 안 하고 파싱 결과만
 *
 * ── 설정 (.env.local, 선택) ─────────────────────────────────────────
 *   SHINHAN_RESEARCH_IMPORT_URL="https://5-topaz-five.vercel.app/api/cron/shinhan-research"
 *   CRON_SECRET="앱에 설정한 값이 있으면"
 * (신한 수집기와 같은 수신 라우트를 재사용 — source 로 구분됨)
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
const DAYS = Number(ARGS.find((a) => a.startsWith("--days="))?.split("=")[1]) || 14;
const MAX_PAGES = Number(ARGS.find((a) => a.startsWith("--pages="))?.split("=")[1]) || 5;

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim(); // 로컬 수동 실행 시 CRON_SECRET 없어도 인증 가능(라우트가 x-app-token도 허용)

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST_URL = "https://www.hanaw.com/main/research/research/list.cmd";
// pid=3&cid=2 = 산업/기업 > 기업분석 게시판.
const BASE_PARAMS = { pid: "3", cid: "2", srchTitle: "", srchWord: "", startDate: "1900-01-01", endDate: "9999-12-31" };

const isoDate = (s) => {
  const m = String(s).trim().match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

const EXCERPT_LEN = 300;
function excerpt(text) {
  const flat = String(text ?? "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return flat.length > EXCERPT_LEN ? `${flat.slice(0, EXCERPT_LEN)}…` : flat;
}

function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .trim();
}

// 제목 형식: "종목명(코드.거래소/투자의견): 나머지 제목" — 코드는 숫자 6자리
// (뒤에 영문 붙는 스팩/우선주 등은 그대로 두되 앞 6자리만 씀).
const TITLE_RE = /^(.+?)\((\d{6}[A-Z0-9]*)\.[A-Z]+\s*\/\s*([^)]+)\)\s*:\s*(.+)$/;

async function fetchPage(page) {
  const url = new URL(LIST_URL);
  for (const [k, v] of Object.entries(BASE_PARAMS)) url.searchParams.set(k, v);
  url.searchParams.set("curPage", String(page));
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// 각 리포트 항목의 제목 앵커를 앵커로 삼아 뒤따르는 날짜·본문·PDF 링크를 뽑는다.
const ITEM_RE =
  /<a href="#" class="more_btn title" title="더보기" id="(\d+)_(\d+)">([^<]+)<\/a>[\s\S]{0,80}?<li class="mb7 m-info info">[\s\S]*?<span class="txtbasic">([\d.]+)<\/span>[\s\S]{0,400}?<li class="mb7 j_bbsContn[^"]*">([\s\S]*?)<\/li>[\s\S]{0,600}?class="j_fileLink"[^>]*>([^<]*)<\/a>/g;

function parseItems(html) {
  const items = [];
  for (const m of html.matchAll(ITEM_RE)) {
    const [, bbsCd, bbsSeq, rawTitle, rawDate, rawBody] = m;
    const title = stripHtml(rawTitle);
    const date = isoDate(rawDate);
    if (!date) continue;
    const tm = title.match(TITLE_RE);
    items.push({
      id: `${bbsCd}_${bbsSeq}`,
      date,
      title,
      stockName: tm ? tm[1].trim() : title,
      symbolHint: tm ? tm[2].slice(0, 6) : null,
      opinion: tm ? tm[3].trim() : "",
      summary: excerpt(stripHtml(rawBody)),
      pdfUrl: `https://www.hanaw.com/main/research/research/download.cmd?bbsSeq=${bbsSeq}&attachFileSeq=1&bbsId=&dbType=&bbsCd=${bbsCd}`,
    });
  }
  return items;
}

console.log(`▶ 하나증권 기업분석 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);

const cutoff = new Date(Date.now() - DAYS * 86_400_000);
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
  await sleep(400); // 예의상 간격
}

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. 페이지 구조가 바뀌었을 수 있음(정규식 재확인 필요).");
  process.exit(1);
}

console.log(`✔ 파싱 완료: ${collected.length}건`);
console.log(
  "  최근 3건:",
  collected.slice(0, 3).map((i) => `${i.date} ${i.stockName}(${i.symbolHint}) — ${i.title}`),
);

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

// analyst 필드는 이 정규식에서 안정적으로 못 뽑아 빈 값으로 보냄(제목·요약·PDF가
// 핵심이라 우선순위 낮음) — /api/cron/shinhan-research 는 analyst 없어도 저장됨.
// symbol 은 제목에서 이미 뽑은 6자리 코드를 그대로 넘겨 서버의 이름 검색을 건너뛴다.
const items = collected.map((it) => ({
  id: it.id,
  date: it.date,
  title: it.title,
  stockName: it.stockName,
  symbol: it.symbolHint,
  analyst: "",
  opinion: it.opinion,
  summary: it.summary,
  pdfUrl: it.pdfUrl,
  views: null,
}));

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;
const up = await fetch(IMPORT_URL, {
  method: "POST",
  headers,
  body: JSON.stringify({ items, source: "하나증권" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
