/**
 * 한화투자증권 "기업분석" 리포트 — 로컬 수집기.
 *
 * www.hanwhawm.com 리서치센터(기업분석, depth3_id=anls1)는 로그인 없이 서버
 * 렌더링 HTML로 나온다. 페이지네이션도 평범한 GET(`&p=N`). 제목이 "[업종]
 * 종목명[코드/의견] 제목" 형식이라 이름 검색 없이 제목에서 종목코드를 뽑는다.
 * 목록에 직접 PDF 링크가 없어 상세보기 URL(view.cmd)을 대신 연결한다.
 *
 * ⚠️ www.hanwhawm.com/robots.txt 는 `Disallow: /` (Googlebot·Yeti 제외)다.
 *    다른 예외들과 동일하게 "개인용·로컬 실행·저빈도" 조건으로 오너 승인
 *    (CLAUDE.md 참조). 앱 배포본(Vercel)에는 이 수집 코드가 없다.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-hanwha-research.mjs
 *   node scripts/collect-hanwha-research.mjs --days=30 --pages=10 --dry-run
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

const LIST_URL = "https://www.hanwhawm.com/main/research/main/list.cmd";

const isoDate = (s) => {
  const m = String(s).trim().match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const EXCERPT_LEN = 300;
function excerpt(text) {
  const flat = String(text ?? "").replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  return flat.length > EXCERPT_LEN ? `${flat.slice(0, EXCERPT_LEN)}…` : flat;
}
function stripHtml(s) {
  return s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();
}

// 제목 형식: "[업종] 종목명[코드/의견] 나머지" — 업종 태그는 매칭 전에 먼저 떼어낸다.
const SECTOR_TAG_RE = /^\[[^\]]+\]\s*/;
const TITLE_RE = /^(.+?)\[(\d{6}[A-Z0-9]*)\/([^\]]+)\]\s*(.+)$/;

async function fetchPage(page) {
  const url = new URL(LIST_URL);
  url.searchParams.set("depth3_id", "anls1");
  url.searchParams.set("mode", "");
  url.searchParams.set("viewclass", "");
  url.searchParams.set("p", String(page));
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// 항목 하나 = view('seq','depth3_id','제목') 앵커 + 요약(cont_txt) + 카테고리/작성자/날짜.
const ITEM_RE =
  /<a href="javascript:view\('(\d+)', '(\w+)', '[^']*'\);"\s*>\s*([^<]+?)\s*<\/a>\s*<p class="cont_txt">([\s\S]*?)<\/p>[\s\S]{0,200}?<span class="gubun">([^<]*)<\/span>\s*([^<]*?)\s*<span class="date">([\d.]+)<\/span>/g;

function parseItems(html) {
  const items = [];
  for (const m of html.matchAll(ITEM_RE)) {
    const [, seq, depth3, rawTitle, rawSummary, , analyst, rawDate] = m;
    const date = isoDate(rawDate);
    if (!date) continue;
    const title = stripHtml(rawTitle);
    const tm = title.replace(SECTOR_TAG_RE, "").match(TITLE_RE);
    items.push({
      id: seq,
      date,
      title,
      stockName: tm ? tm[1].trim() : title,
      symbolHint: tm ? tm[2].slice(0, 6) : null,
      opinion: tm ? tm[3].trim() : "",
      analyst: analyst.trim(),
      summary: excerpt(stripHtml(rawSummary)),
      pdfUrl: `https://www.hanwhawm.com/main/research/main/view.cmd?depth3_id=${depth3}&mode=&seq=${seq}&p=`,
    });
  }
  return items;
}

console.log(`▶ 한화투자증권 기업분석 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
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
  analyst: it.analyst,
  opinion: it.opinion,
  summary: it.summary,
  pdfUrl: it.pdfUrl,
  views: null,
}));

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = `Bearer ${CRON_SECRET}`;
const up = await fetch(IMPORT_URL, {
  method: "POST",
  headers,
  body: JSON.stringify({ items, source: "한화투자증권" }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
