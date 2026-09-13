/**
 * 한국투자증권 "해외 기업분석" 수집기 (미국 종목).
 *
 * 국내 수집기(collect-kis-research.mjs)와 같은 목록 페이지인데 분류만 다르다
 * (jkGubun=10 -> 7). 오너가 URL을 직접 제시해 추가(2026-09).
 *
 * 이 게시판은 한투 자체 리포트가 아니라 해외 증권사 리포트를 번역/중계한
 * 것이다 - 목록의 머리 라벨이 원 작성사(스티펠, 국태해통 등)를 가리킨다.
 * source 는 "한국투자증권"으로 두되 제목/요약은 원문 그대로 쓴다.
 *
 * 제목이 "종목명(TICKER USA):제목" 형식이고 홍콩(HKG) 등이 섞여 있어 USA 만
 * 고른다. 요약에 "매수 의견과 목표주가 92달러"처럼 등급/목표가가 문장으로
 * 들어있는 경우가 많아 공용 추출기(lib/us-research-extract.mjs)로 뽑는다.
 *
 * 산업분석/투자전략(2026-09 추가, 오너 지시 — "미국도 산업분석을 하려면
 * 역시 해외를 읽어라"): 목록 항목의 "head" 라벨이 "스티펠 산업분석"·
 * "국태해통증권 산업분석"처럼 "산업분석"으로 끝나는 행은 종목이 아니라
 * 업종 리포트("업종명:헤드라인" 형식, 예: "에너지 & 전력:E&P/미드스트림
 * 분석 개시...")인데 지금까지 통째로 버려지고 있었다. `category:"산업"`
 * 으로 별도 수집(symbol 항상 null, 목표주가·투자의견 추출은 건너뜀).
 *
 * PDF 는 로그인이 필요해(국내 수집기와 동일) 상세 페이지 URL 을 대신 연결한다.
 *
 * -- 실행 --
 *   node scripts/collect-kis-global-research.mjs
 *   node scripts/collect-kis-global-research.mjs --days=90 --dry-run
 */

import { readFileSync } from "node:fs";
import {
  enrichUsResearch,
  extractOpinion,
  extractTargetPrice,
} from "./lib/us-research-extract.mjs";

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
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
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

const TITLE_RE = /\(([A-Z][A-Z.]{0,5})\s+USA\)\s*:\s*(.*)$/;

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

// "투자의견 매수"(라벨이 먼저)와 "매수 의견"(단어가 먼저) 둘 다 나온다.
async function fetchOpinionAndTarget(detailUrl) {
  try {
    const res = await fetch(detailUrl, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const bodyText = [...html.matchAll(/<div class='v_info_(?:head|body)'>([\s\S]*?)<\/div>/g)]
      .map((m) => stripHtml(m[1]))
      .join(" ");
    return { opinion: extractOpinion(bodyText), targetPrice: extractTargetPrice(bodyText) };
  } catch (err) {
    console.warn(`  ⚠ 상세 본문 조회 실패 (${detailUrl}): ${err.message}`);
    return { opinion: "", targetPrice: null };
  }
}

async function fetchPage(page) {
  const url = new URL(LIST_URL);
  url.searchParams.set("jkGubun", "7");
  url.searchParams.set("rowsPerPages", String(PAGE_SIZE));
  url.searchParams.set("currentPage", String(page));
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function parseItems(html) {
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
      // 종목 없는 업종 리포트 — "업종명:헤드라인" 형식.
      const sm = titleM[1].match(/^([^:：]+)[:：]\s*(.+)$/);
      items.push({
        id: idM[1],
        date,
        title: sm ? sm[2].trim() : titleM[1].trim(),
        stockName: sm ? sm[1].trim() : titleM[1].trim(),
        symbolHint: null,
        analyst: analystM[1].trim(),
        opinion: "",
        targetPrice: null,
        summary: summaryM ? excerpt(stripHtml(summaryM[1])) : "",
        detailUrl: `https://securities.koreainvestment.com/main/research/research/StrategyDetail.jsp?jkGubun=7&id=${idM[1]}`,
        category: "산업",
      });
      continue;
    }
    const tm = titleM[1].match(TITLE_RE);
    if (!tm) continue; // 종목코드 없는 리포트(USA 외 시장 등) — 건너뜀
    const [, code, headline] = tm;
    items.push({
      id: idM[1],
      date,
      title: headline.trim(),
      stockName: titleM[1].split("(")[0].trim(),
      symbolHint: code,
      analyst: analystM[1].trim(),
      summary: summaryM ? excerpt(stripHtml(summaryM[1])) : "",
      detailUrl: `https://securities.koreainvestment.com/main/research/research/StrategyDetail.jsp?jkGubun=7&id=${idM[1]}`,
      category: "기업",
    });
  }
  return items;
}

console.log(`▶ 한국투자증권 해외 기업분석 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
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

if (collected.length === 0) {
  console.error("✗ 파싱 결과 0건. 페이지 구조가 바뀌었을 수 있음.");
  process.exit(1);
}
console.log(`✔ 파싱 완료: ${collected.length}건`);
console.log(
  "  최근 5건:",
  collected
    .slice(0, 5)
    .map((i) => `${i.date} ${nameByCode.get(i.symbolHint) ?? i.symbolHint}(${i.symbolHint}) — ${i.title}`),
);
console.log(`▶ 투자의견/목표주가 조회 중 (${collected.length}건)...`);
for (const it of collected) {
  // 산업분석은 특정 종목 얘기가 아니므로 투자의견·목표주가 개념이 없음.
  if (it.category === "산업") continue;
  const { opinion, targetPrice } = await fetchOpinionAndTarget(it.detailUrl);
  it.opinion = opinion;
  it.targetPrice = targetPrice;
  await sleep(400);
}
// 한투 PDF 는 로그인이 필요해 pdfUrl 이 상세 페이지 URL 이다 — PDF 단계는 끈다.
await enrichUsResearch(collected.filter((it) => it.category !== "산업"), { sleepMs: 0, usePdf: false });
console.log("  예시:", collected[0] && `${collected[0].opinion || "(없음)"} / ${collected[0].targetPrice ?? "(없음)"}`);

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const items = collected.map((it) => ({
  id: it.id,
  date: it.date,
  title: it.title,
  stockName: it.symbolHint ? (nameByCode.get(it.symbolHint) ?? it.symbolHint) : it.stockName,
  symbol: it.symbolHint,
  analyst: it.analyst,
  opinion: it.opinion,
  targetPrice: it.targetPrice,
  summary: it.summary,
  pdfUrl: it.detailUrl,
  views: null,
  category: it.category,
}));

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;
const up = await fetch(IMPORT_URL, {
  method: "POST",
  headers,
  body: JSON.stringify({ items, source: "한국투자증권", market: "us" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
