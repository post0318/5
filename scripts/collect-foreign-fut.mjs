/**
 * 외국인 코스피200 선물 순매수 — 로컬 수집기.
 *
 * 투자자별 선물 거래실적은 공식 무료 API(KRX OPEN API / KIS) 어디에도 없고,
 * KRX 정보데이터시스템 화면은 로그인 필수 + Vercel(데이터센터 IP) 차단이라
 * 서버 배치로는 못 가져온다. 네이버페이 증권의 "투자자별 매매동향(선물)"
 * 페이지에서 로그인 없이 같은 데이터를 얻는다(값이 KRX 원자료와 정확히 일치).
 *
 * ⚠️ finance.naver.com/robots.txt 는 일반 UA 에 Disallow: / 이다.
 *    프로젝트 오너가 "개인용, 하루 1회, 단일 소형 페이지" 조건으로 예외 승인
 *    (CLAUDE.md 참조). 빈번한 폴링 금지 — 하루 1회로 고정.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-foreign-fut.mjs             # 최근 40일 수집 → 앱 전송
 *   node scripts/collect-foreign-fut.mjs --days=120  # 기간 지정
 *   node scripts/collect-foreign-fut.mjs --dry-run   # 전송 안 하고 파싱 결과만
 *   node scripts/collect-foreign-fut.mjs --status    # 앱 반영 현황 + 소스 확인만
 *
 * ── 설정 (.env.local, 선택) ─────────────────────────────────────────
 *   KR_FG_IMPORT_URL="https://5-topaz-five.vercel.app/api/cron/kr-fg"
 *   CRON_SECRET="앱에 설정한 값이 있으면"
 *
 * ── Windows 작업 스케줄러 (일 1회) ─────────────────────────────────
 *   등록됨: KRX-ForeignFut-Daily (매일 08:00)
 *   프로그램: cmd /c ""C:\Program Files\nodejs\node.exe" scripts\collect-foreign-fut.mjs >> scripts\.krx-collect.log 2>&1"
 *   시작 위치: C:\Users\post0\5
 */

import { readFileSync } from "node:fs";

// ── config ─────────────────────────────────────────────────────────
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
const STATUS = ARGS.includes("--status");
const DRY_RUN = ARGS.includes("--dry-run") || STATUS;
const DAYS = Number(ARGS.find((a) => a.startsWith("--days="))?.split("=")[1]) || (STATUS ? 15 : 40);

const IMPORT_URL = (ENV.KR_FG_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/kr-fg").trim();
const MACRO_URL = (ENV.KR_FG_MACRO_URL || "https://5-topaz-five.vercel.app/api/macro/kr-fg").trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 앱 현황 (--status) ─────────────────────────────────────────────
if (STATUS) {
  try {
    const j = await (await fetch(MACRO_URL)).json();
    const ff = j?.krFearGreed?.components?.find((c) => c.key === "kr_foreign_fut");
    console.log(`앱 kr_foreign_fut: 점수 ${ff?.score}, 마지막 반영일 ${ff?.history?.at(-1)?.date ?? "?"}`);
  } catch {
    console.log("앱 현황 조회 실패 (네트워크?)");
  }
}

// ── 네이버 조회 ────────────────────────────────────────────────────
// finance.naver.com/sise/investorDealTrendDay.naver?bizdate=YYYYMMDD&sosok=03&page=N
//  sosok=03 = 선물(코스피200), 한 페이지 10거래일, 최신순. EUC-KR.
//  행 셀: [0]날짜(YY.MM.DD) [1]개인 [2]외국인 [3]기관계 [4]금융투자 ... [10]기타법인
const NAVER = "https://finance.naver.com/sise/investorDealTrendDay.naver";
const REFERER = "https://finance.naver.com/sise/sise_trans_style.naver?sosok=03";
const FOREIGN_CELL = 2;

const ymd = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
const bizdate = ymd(new Date());
const cutoff = new Date(Date.now() - DAYS * 86_400_000);

const num = (s) => {
  const n = Number(String(s).replace(/,/g, "").replace(/[^\d.-]/g, "").trim());
  return Number.isFinite(n) ? n : null;
};
const isoFromNaver = (s) => {
  const m = String(s).trim().match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : null;
};

async function fetchPage(page) {
  const res = await fetch(`${NAVER}?bizdate=${bizdate}&sosok=03&page=${page}`, {
    headers: { "User-Agent": UA, Referer: REFERER },
  });
  if (!res.ok) throw new Error(`네이버 HTTP ${res.status}`);
  // EUC-KR 이지만 숫자·날짜·구분자는 전부 ASCII 라 latin1(바이트 1:1)로 읽으면 충분
  return Buffer.from(await res.arrayBuffer()).toString("latin1");
}

function parseRows(html) {
  const table = html.match(/<table[^>]*class="type_1"[\s\S]*?<\/table>/i)?.[0] || html.match(/<table[\s\S]*?<\/table>/i)?.[0];
  if (!table) return [];
  const out = [];
  for (const tr of table.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = (tr.match(/<td[\s\S]*?<\/td>/gi) || []).map((td) =>
      td.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim(),
    );
    const date = isoFromNaver(cells[0]);
    if (!date) continue;
    const foreign = num(cells[FOREIGN_CELL]);
    if (foreign == null) continue;
    // zero-sum: 개인 + 외국인 + 기관계 + 기타법인 = 0
    const parts = [num(cells[1]), foreign, num(cells[3]), num(cells[cells.length - 1])];
    const zeroSum = parts.every((v) => v != null) ? parts.reduce((a, b) => a + b, 0) : null;
    out.push({ date, value: foreign, zeroSum });
  }
  return out;
}

console.log(`▶ 네이버 조회: 선물(코스피200) 투자자별 순매수, 최근 ${DAYS}일`);

const series = [];
let zsFail = 0;
for (let page = 1; page <= 20; page++) {
  const rows = parseRows(await fetchPage(page));
  if (rows.length === 0) break;
  for (const r of rows) {
    if (r.zeroSum != null && Math.abs(r.zeroSum) > 0.5) zsFail++;
    series.push({ date: r.date, value: r.value });
  }
  if (rows.at(-1) && new Date(rows.at(-1).date) < cutoff) break;
  await sleep(400); // 예의상 간격
}

if (series.length === 0) {
  console.error("✗ 파싱 결과 0건. 네이버 페이지 구조가 바뀌었을 수 있음.");
  process.exit(1);
}
if (zsFail > 0) {
  console.error(`✗ zero-sum 검증 실패 ${zsFail}건 — 컬럼 위치가 바뀌었을 수 있음. 중단.`);
  process.exit(1);
}

// 정렬·중복제거·기간 필터
const seen = new Set();
const clean = series
  .filter((r) => new Date(r.date) >= cutoff)
  .sort((a, b) => a.date.localeCompare(b.date))
  .filter((r) => (seen.has(r.date) ? false : seen.add(r.date)));

console.log(`✔ 파싱 완료: ${clean.length}건  (${clean[0].date} ~ ${clean.at(-1).date})`);
console.log("  최근 5건:", clean.slice(-5));

if (STATUS) {
  console.log(`\n✔ 소스 정상. 네이버 최신 거래일: ${clean.at(-1).date}`);
  process.exit(0);
}
if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

// ── 앱으로 전송 ────────────────────────────────────────────────────
const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = `Bearer ${CRON_SECRET}`;
const up = await fetch(IMPORT_URL, {
  method: "POST",
  headers,
  body: JSON.stringify({ foreignFutNet: clean }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
