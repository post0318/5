/**
 * DS투자증권 리서치 수집기 (국내 + 미국).
 *
 * www.ds-sec.co.kr 은 그누보드 게시판이라 로그인 없이 서버렌더 HTML 이 나온다
 * (오너가 URL 제시, 2026-09).
 *   - sub03_02 기업분석        → 국내 종목
 *   - sub03_03 투자전략/경제분석 → 미국 종목이 여기 섞여 있다(오너 확인)
 *
 * 종목 식별이 이 소스의 까다로운 점이다 — 제목에 종목코드도 티커도 없다.
 *   국내: "[섹터] 종목명 - 부제" / "[섹터] 종목명 부제" 처럼 형식이 일정치 않아
 *         corpcodes.json(3,930개) 에서 "제목이 그 이름으로 시작하는 것 중 가장
 *         긴 이름"을 찾는다. 못 찾으면 종목 리포트가 아닌 것으로 보고 건너뛴다
 *         (Defense Daily·Macro Issue 등이 같은 게시판에 섞여 있음).
 *   미국: "[DS 미국주식] 엔비디아: 제목" 처럼 한글 종목명만 있어 네이버 해외종목
 *         자동완성으로 티커를 해석한다(뉴스 쪽에서 이미 쓰는 엔드포인트).
 *
 * ⚠️ 다른 예외들과 동일 조건: 개인용·하루 1회·저빈도(CLAUDE.md 참고).
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-ds-research.mjs
 *   node scripts/collect-ds-research.mjs --days=90 --dry-run
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
const arg = (n) => ARGS.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const DRY_RUN = ARGS.includes("--dry-run");
const DAYS = Number(arg("days")) || 14;
const MAX_PAGES = Number(arg("pages")) || 5;

const BOARD_URL = "https://www.ds-sec.co.kr/bbs/board.php";
const IMPORT_URL = (
  ENV.SHINHAN_RESEARCH_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/shinhan-research"
).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 국내 종목명 → 코드. 긴 이름부터 봐야 "한국전력"이 "한국전력기술"을 가리지 않는다.
const CORPS = JSON.parse(
  readFileSync(new URL("../src/lib/markets/kr/data/corpcodes.json", import.meta.url), "utf8"),
)
  .filter((c) => c.s && c.n)
  .sort((a, b) => b.n.length - a.n.length);

function resolveKrStock(text) {
  const t = text.trim();
  for (const c of CORPS) {
    if (t.startsWith(c.n)) return { symbol: c.s, stockName: c.n };
  }
  return null;
}

/** 한글 종목명 → 미국 티커(네이버 해외종목 자동완성). 실패하면 null. */
const usCache = new Map();
async function resolveUsTicker(name) {
  const key = name.trim();
  if (usCache.has(key)) return usCache.get(key);
  let hit = null;
  try {
    const res = await fetch(
      `https://ac.stock.naver.com/ac?q=${encodeURIComponent(key)}&target=stock`,
      { headers: { "User-Agent": UA, accept: "application/json" } },
    );
    if (res.ok) {
      const items = (await res.json()).items ?? [];
      const m = items.find((i) => i.nationCode === "USA" && i.name?.trim() === key) ??
        items.find((i) => i.nationCode === "USA");
      if (m?.code) hit = { symbol: String(m.code).toUpperCase(), stockName: m.name ?? key };
    }
  } catch {
    /* 무시 */
  }
  usCache.set(key, hit);
  await sleep(300);
  return hit;
}

async function fetchBoard(table, page) {
  const url = new URL(BOARD_URL);
  url.searchParams.set("bo_table", table);
  if (page > 1) url.searchParams.set("page", String(page));
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const stripHtml = (s) =>
  String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

function parseRows(html) {
  const rows = [];
  for (const chunk of html.split(/<tr[^>]*>/).slice(1)) {
    const idM = chunk.match(/wr_id=(\d+)/);
    const titM = chunk.match(/<div class="bo_tit">\s*<a[^>]*>([\s\S]*?)<\/a>/);
    const dateM = chunk.match(/<td class="td_datetime">\s*(\d{4}-\d{2}-\d{2})\s*<\/td>/);
    if (!idM || !titM || !dateM) continue;
    rows.push({ id: idM[1], title: stripHtml(titM[1]), date: dateM[1] });
  }
  return rows;
}

/** "[섹터] 나머지" 에서 대괄호 머리말을 떼고 본문만 남긴다. */
function stripBracket(title) {
  const m = title.match(/^\[[^\]]*\]\s*(.+)$/);
  return m ? m[1].trim() : title.trim();
}

console.log(`▶ DS투자증권 리서치 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));

async function collectBoard(table) {
  const out = [];
  let stop = false;
  for (let page = 1; page <= MAX_PAGES && !stop; page++) {
    const rows = parseRows(await fetchBoard(table, page));
    if (rows.length === 0) break;
    for (const r of rows) {
      if (new Date(r.date) < cutoff) {
        stop = true;
        break;
      }
      out.push(r);
    }
    await sleep(400);
  }
  return out;
}

const krRows = await collectBoard("sub03_02");
const usRows = await collectBoard("sub03_03");
console.log(`  목록 — 기업분석 ${krRows.length}건 · 투자전략/경제분석 ${usRows.length}건`);

const krItems = [];
for (const r of krRows) {
  const body = stripBracket(r.title);
  const hit = resolveKrStock(body);
  if (!hit) continue; // Defense Daily·Macro 등 종목 리포트가 아닌 것
  krItems.push({
    id: r.id,
    date: r.date,
    title: body.slice(hit.stockName.length).replace(/^[\s\-–—:,]+/, "").trim() || body,
    stockName: hit.stockName,
    symbol: hit.symbol,
    analyst: "",
    opinion: "",
    targetPrice: null,
    summary: "",
    pdfUrl: `https://www.ds-sec.co.kr/bbs/board.php?bo_table=sub03_02&wr_id=${r.id}`,
    views: null,
  });
}

const usItems = [];
for (const r of usRows) {
  // "[DS 미국주식] 엔비디아: 제목" / "[DS 미국주식 이규원] GPT-6 ..." 형태
  if (!/미국주식|글로벌주식/.test(r.title)) continue;
  const body = stripBracket(r.title);
  const nameM = body.match(/^([^:：]{2,20})\s*[:：]\s*(.+)$/);
  if (!nameM) continue; // 종목명 없이 주제만 있는 글
  const hit = await resolveUsTicker(nameM[1]);
  if (!hit) continue;
  usItems.push({
    id: r.id,
    date: r.date,
    title: nameM[2].trim(),
    stockName: hit.stockName,
    symbol: hit.symbol,
    analyst: "",
    opinion: "",
    targetPrice: null,
    summary: "",
    pdfUrl: `https://www.ds-sec.co.kr/bbs/board.php?bo_table=sub03_03&wr_id=${r.id}`,
    views: null,
  });
}

console.log(`✔ 종목 매핑 — 국내 ${krItems.length}건 · 미국 ${usItems.length}건`);
if (krItems.length + usItems.length === 0) {
  console.error("✗ 파싱 결과 0건. 게시판 구조가 바뀌었을 수 있음.");
  process.exit(1);
}
console.log("  국내 예시:", krItems.slice(0, 3).map((i) => `${i.date} ${i.stockName}(${i.symbol})`));
console.log("  미국 예시:", usItems.slice(0, 3).map((i) => `${i.date} ${i.stockName}(${i.symbol})`));

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

for (const [market, items] of [["kr", krItems], ["us", usItems]]) {
  if (items.length === 0) continue;
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ items, source: "DS투자증권", market }),
  });
  const body = await up.text();
  if (!up.ok) {
    console.error(`✗ [${market}] 전송 실패 HTTP ${up.status}: ${body.slice(0, 200)}`);
    continue;
  }
  console.log(`✔ [${market}] ${items.length}건 전송: ${body}`);
}
