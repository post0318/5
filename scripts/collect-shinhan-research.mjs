/**
 * 신한투자증권 "기업분석" 리포트 — 로컬 수집기.
 *
 * bbs2.shinhansec.com 의 게시판 JSON API(로그인 불필요, 실제 브라우저 XHR을
 * 그대로 재현 — 페이지 소스에는 없고 클라이언트 JS가 호출)에서 최신 리포트를
 * 가져와 앱(Vercel)의 DB 적재 라우트로 전송한다.
 *
 * ⚠️ bbs2.shinhansec.com/robots.txt 는 `Disallow: /` 다. 다른 예외들과 동일하게
 *    프로젝트 오너가 "개인용·로컬 실행·저빈도" 조건으로 예외 승인(CLAUDE.md 참조).
 *    앱 배포본(Vercel)에는 이 수집 코드가 없다 — DB 적재 라우트는 결과를 받기만 함.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-shinhan-research.mjs             # 최근 14일, 최대 5페이지
 *   node scripts/collect-shinhan-research.mjs --days=30 --pages=10
 *   node scripts/collect-shinhan-research.mjs --dry-run   # 전송 안 하고 파싱 결과만
 *
 * ── 설정 (.env.local, 선택) ─────────────────────────────────────────
 *   SHINHAN_RESEARCH_IMPORT_URL="https://5-topaz-five.vercel.app/api/cron/shinhan-research"
 *   CRON_SECRET="앱에 설정한 값이 있으면"
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

const BASE = "https://bbs2.shinhansec.com/bbs/list/gicompanyanalyst";

const isoDate = (s) => {
  const m = String(s).trim().match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

// 반복되는 "신한생각: ..." 헤더가 본문에 여러 번 겹쳐 나오는 원본 특성상,
// 앞부분만 발췌(요약 카드에 이미 노출되는 분량 정도)하고 개행은 공백으로 접는다.
const EXCERPT_LEN = 300;
function excerpt(text) {
  const flat = String(text ?? "")
    .replace(/&middot;/g, "·")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return flat.length > EXCERPT_LEN ? `${flat.slice(0, EXCERPT_LEN)}…` : flat;
}

async function fetchPage(curPage, startId) {
  const url = new URL(BASE);
  url.searchParams.set("v", String(Date.now()));
  url.searchParams.set("curPage", String(curPage));
  url.searchParams.set("startPage", String(curPage));
  if (startId) url.searchParams.set("startId", startId);
  const res = await fetch(url, { headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.includes("errorWrapper")) throw new Error("게시판 API 404(구조 변경?)");
  return JSON.parse(text);
}

console.log(`▶ 신한투자증권 기업분석 리포트 수집: 최근 ${DAYS}일, 최대 ${MAX_PAGES}페이지`);

const cutoff = new Date(Date.now() - DAYS * 86_400_000);
const items = [];
let startId = undefined;
let stop = false;

for (let page = 1; page <= MAX_PAGES && !stop; page++) {
  const data = await fetchPage(page, startId);
  const list = data.list ?? [];
  if (list.length === 0) break;
  for (const it of list) {
    const date = isoDate(it.f0);
    if (!date) continue;
    if (new Date(date) < cutoff) {
      stop = true;
      break;
    }
    items.push({
      id: String(it.fn),
      date,
      title: it.f1,
      stockName: it.f2,
      analyst: it.f4,
      opinion: it.f6,
      summary: excerpt(it.f7),
      pdfUrl: it.f3 || null,
      views: Number(it.f5) || null,
    });
  }
  const pages = data.pageInfo?.pages ?? [];
  startId = pages.length > 1 ? pages[1] : undefined;
  if (!startId) break;
  await sleep(400); // 예의상 간격
}

if (items.length === 0) {
  console.error("✗ 파싱 결과 0건. 게시판 구조가 바뀌었을 수 있음.");
  process.exit(1);
}

console.log(`✔ 파싱 완료: ${items.length}건`);
console.log("  최근 3건:", items.slice(0, 3).map((i) => `${i.date} ${i.stockName} — ${i.title}`));

if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = `Bearer ${CRON_SECRET}`;
const up = await fetch(IMPORT_URL, { method: "POST", headers, body: JSON.stringify({ items }) });
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
