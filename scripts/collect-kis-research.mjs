/**
 * 한국투자증권 "기업/산업분석" 리포트 — 로컬 수집기.
 *
 * securities.koreainvestment.com 은 모던 사이트라 목록
 * (`/main/research/research/Strategy.jsp?jkGubun=10&category1=05&category2=01
 * &rowsPerPages=50&currentPage=N`)이 평범한 서버렌더링 HTML(UTF-8)로 바로
 * 나온다(GNB "리서치" 메뉴 → "기업/산업" 서브메뉴 링크를 그대로 사용).
 * 로그인 불필요. 상세 페이지(`StrategyDetail.jsp?id=N`)도 로그인 없이 전체
 * 본문이 그대로 보이지만(실측 확인), 이 프로젝트 방침상 전체 본문은 저장하지
 * 않고 목록에 이미 노출되는 요약 발췌만 저장한다. **PDF 원문은 로그인
 * 필요**(`prePdfFileView()`가 비로그인 시 `login.jsp`로 리다이렉트, 실측
 * 확인) — 교보증권과 동일한 패턴으로, 로그인 없이 열리는 상세 페이지 URL을
 * 대신 연결한다.
 *
 * 목록 제목이 "종목명 (코드):제목"(일부는 앞에 "AIR 스몰캡" 같은 태그가 더
 * 붙음) 형식이라 코드를 바로 뽑되, 종목명은 태그가 섞여 지저분할 수 있어
 * 코드로 `corpcodes.json`(DART_API_KEY 불필요, 이 프로젝트가 이미 쓰는 정적
 * 상장사 목록) 역조회해 깔끔한 이름을 쓴다. 코드가 6자리 숫자가 아닌 항목
 * (드물게 존재, 우선주 등)과 종목 코드 자체가 없는 산업/섹터 리포트는 건너뜀.
 *
 * ⚠️ securities.koreainvestment.com/robots.txt 는 `Disallow: /`(Googlebot 등
 *    예외)다. 다른 예외들과 동일하게 "개인용·로컬 실행·저빈도" 조건으로
 *    오너 승인(CLAUDE.md 참조, 오너가 "한국투자증권도 로그인없이 가능하다"
 *    직접 확인). 앱 배포본(Vercel)에는 이 수집 코드가 없다.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-kis-research.mjs
 *   node scripts/collect-kis-research.mjs --days=14 --pages=5 --dry-run
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
const MAX_PAGES = Number(ARGS.find((a) => a.startsWith("--pages="))?.split("=")[1]) || 6;

const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
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

function parseItems(html) {
  const items = [];
  for (const chunk of html.split("<li>").slice(1)) {
    const idM = chunk.match(/doDetail\('(\d+)'\)/);
    const titleM = chunk.match(/<span class="body_tit">\s*([^<]+?)\s*<\/span>/);
    const summaryM = chunk.match(/<span class="body_sub">\s*([\s\S]*?)\s*<\/span>/);
    const analystM = chunk.match(/<em>([^<]*)<\/em>\s*<em>([\d.]+)<\/em>/);
    if (!idM || !titleM || !analystM) continue;
    const tm = titleM[1].match(TITLE_RE);
    if (!tm) continue; // 종목코드 없는 산업/섹터 리포트 — 건너뜀
    const [, code, headline] = tm;
    const date = isoDate(analystM[2]);
    if (!date) continue;
    items.push({
      id: idM[1],
      date,
      title: headline.trim(),
      symbolHint: code,
      analyst: analystM[1].trim(),
      summary: summaryM ? excerpt(stripHtml(summaryM[1])) : "",
      detailUrl: `https://securities.koreainvestment.com/main/research/research/StrategyDetail.jsp?jkGubun=10&id=${idM[1]}`,
    });
  }
  return items;
}

console.log(`▶ 한국투자증권 기업/산업분석 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
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
if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const items = collected.map((it) => ({
  id: it.id,
  date: it.date,
  title: it.title,
  stockName: nameByCode.get(it.symbolHint) ?? it.symbolHint,
  symbol: it.symbolHint,
  analyst: it.analyst,
  opinion: "",
  summary: it.summary,
  pdfUrl: it.detailUrl,
  views: null,
}));

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = `Bearer ${CRON_SECRET}`;
const up = await fetch(IMPORT_URL, {
  method: "POST",
  headers,
  body: JSON.stringify({ items, source: "한국투자증권" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
