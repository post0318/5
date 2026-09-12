/**
 * 유안타증권 "기업분석" 리포트 — 로컬 수집기.
 *
 * www.myasset.com 기업분석 목록은 로그인 없이 서버렌더링 HTML로 나온다
 * (robots.txt 자체가 없음 — 명시적 Disallow는 없지만 다른 예외들과 동일하게
 * "개인용·로컬 실행·저빈도" 조건으로 오너 승인, CLAUDE.md 참조). 페이지네이션도
 * 평범한 GET(`&page=N&pgCnt=30`). 종목코드가 `data-jongcode="(코드)"` 속성에
 * 그대로 있어 이름 검색 없이 바로 뽑는다.
 *
 * ⚠️ 목록에 개별 리포트 상세/PDF 링크의 정확한 URL을 아직 못 찾아 pdfUrl은
 *    비워둔다(제목·종목·의견·애널리스트·날짜는 정상 수집). 다음에 실제
 *    브라우저 네트워크 요청을 봐서 마저 채울 것.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-yuanta-research.mjs
 *   node scripts/collect-yuanta-research.mjs --days=30 --pages=10 --dry-run
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
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST_URL = "https://www.myasset.com/myasset/research/rs_list/rs_list.cmd";

const isoDate = (s) => {
  const m = String(s).trim().match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
function stripHtml(s) {
  return s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();
}

async function fetchPage(page) {
  const url = new URL(LIST_URL);
  url.searchParams.set("cd006", "");
  url.searchParams.set("cd007", "RE01"); // 기업분석
  url.searchParams.set("cd008", "");
  url.searchParams.set("page", String(page));
  url.searchParams.set("pgCnt", "30");
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// 한 행 = 작성일, 종목명+코드, 투자의견, 제목, ... (주석 <!--...--> 가 섞여 있어
// 요소 사이는 [\s\S]{0,N}? 로 느슨하게 건너뛴다).
const ROW_RE =
  /<tr class="js-moveRS">[\s\S]{0,100}?<td>(\d{4}\/\d{2}\/\d{2})<\/td>[\s\S]{0,300}?data-jongcode="\(?(\d{6})\)?">([^<]+)<\/a>[\s\S]{0,200}?class="js-ivstComment">([^<]*)<\/td>[\s\S]{0,200}?cmd-type="view" data-seq="(\d+)"[^>]*>([^<]+)/g;

function parseItems(html) {
  const items = [];
  for (const m of html.matchAll(ROW_RE)) {
    const [, rawDate, code, stockName, opinion, seq, rawTitle] = m;
    const date = isoDate(rawDate);
    if (!date) continue;
    items.push({
      id: seq,
      date,
      title: stripHtml(rawTitle),
      stockName: stockName.trim(),
      symbolHint: code,
      opinion: opinion.trim(),
    });
  }
  return items;
}

console.log(`▶ 유안타증권 기업분석 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
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
  "  최근 3건:",
  collected.slice(0, 3).map((i) => `${i.date} ${i.stockName}(${i.symbolHint}) — ${i.title}`),
);
if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const items = collected.map((it) => ({
  id: it.id,
  date: it.date,
  title: it.title,
  stockName: it.stockName,
  symbol: it.symbolHint,
  analyst: "",
  opinion: it.opinion,
  summary: "",
  pdfUrl: null,
  views: null,
}));

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = `Bearer ${CRON_SECRET}`;
const up = await fetch(IMPORT_URL, {
  method: "POST",
  headers,
  body: JSON.stringify({ items, source: "유안타증권" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
