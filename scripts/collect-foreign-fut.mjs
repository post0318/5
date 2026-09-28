/**
 * 외국인 코스피200 선물 순매수 — 로컬 수집기.
 *
 * 투자자별 선물 거래실적은 공식 무료 API(KRX OPEN API / KIS) 어디에도 없고,
 * KRX 정보데이터시스템 화면은 로그인 필수 + Vercel(데이터센터 IP) 차단이라
 * 서버 배치로는 못 가져온다.
 *
 * 소스 교체(2026-09-28, 오너 지시 — "finance.daum.net 에는 있다, 가능한가?"):
 * 네이버페이 증권 "투자자별 매매동향(선물)" 페이지가 2026-09-18 부터 HTTP 410
 * 으로 폐지돼(사이트 개편) 9월 17일 이후 데이터가 끊겼다. **다음 금융의
 * 투자주체별 동향(선물) JSON API** 로 바꾼다 — 브라우저 네트워크 로그로
 * 역추적한 엔드포인트(`/api/investor/future/days?terms=days`)이고, referer
 * 헤더가 없으면 403, 있으면 로그인 없이 200(실측). 값은 옛 네이버 수집분과
 * 2026-09-09~16 전 구간 정확히 일치(9/17 만 네이버가 장중 부분값 113 을
 * 잡았고 다음은 마감값 802 — 다음 쪽이 맞다).
 *
 * ⚠️ finance.daum.net 은 robots.txt 자체가 없다(404). 다른 예외들과 같은
 *    "개인용, 하루 1회, 단일 소형 요청" 조건으로 오너 승인(CLAUDE.md 참조).
 *    빈번한 폴링 금지 — 하루 1회로 고정.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-foreign-fut.mjs             # 최근 40일 수집 → 앱 전송
 *   node scripts/collect-foreign-fut.mjs --days=120  # 기간 지정
 *   node scripts/collect-foreign-fut.mjs --dry-run   # 전송 안 하고 파싱 결과만
 *   node scripts/collect-foreign-fut.mjs --status    # 앱 반영 현황 + 소스 확인만
 *
 * ── 설정 (.env.local, 선택) ─────────────────────────────────────────
 *   KR_FG_IMPORT_URL="https://macroresearch.vercel.app/api/cron/kr-fg"
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

const IMPORT_URL = (ENV.KR_FG_IMPORT_URL || "https://macroresearch.vercel.app/api/cron/kr-fg").trim();
const MACRO_URL = (ENV.KR_FG_MACRO_URL || "https://macroresearch.vercel.app/api/macro/kr-fg").trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
// Vercel 배포 보호(Vercel Authentication)가 프로덕션에 켜져 있으면 앱에 닿기
// 전에 401 이 난다 — 자동화 우회 비밀값이 있으면 헤더로 같이 보낸다(없으면 생략).
const VERCEL_BYPASS = (ENV.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();

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

// ── 다음 금융 조회 ──────────────────────────────────────────────────
// finance.daum.net/api/investor/future/days?page=N&perPage=50&terms=days&pagination=true
//  sosok=03 = 선물(코스피200), 한 페이지 10거래일, 최신순. EUC-KR.
// 다음 금융 투자주체별 동향(선물) — 일자별 JSON. 필드: date("YYYY-MM-DD 00:00:00"),
// privateSettlement(개인)·foreignSettlement(외국인)·institutionalSettlement(기관계)·
// etcCorporationSettlement(기타법인) … 단위는 계약수. 페이지당 최대 50건, 최신순.
const DAUM = "https://finance.daum.net/api/investor/future/days";
const REFERER = "https://finance.daum.net/domestic/investors/DERIVATIVES";
const PER_PAGE = 50;

// 항목 날짜가 'YYYY-MM-DD'(=UTC 자정)라 컷오프도 자정으로 맞춘다.
// Date.now() 기준 그대로 두면 '정확히 DAYS일 전' 리포트가 시:분 차이로
// 매번 잘려나간다(실측 2026-09: 미래에셋 최신 리포트가 3시간 차이로 탈락).
const cutoff = new Date(new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10));

async function fetchPage(page) {
  const res = await fetch(`${DAUM}?page=${page}&perPage=${PER_PAGE}&terms=days&pagination=true`, {
    headers: { "User-Agent": UA, Referer: REFERER, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`다음 HTTP ${res.status}`);
  const j = await res.json();
  return Array.isArray(j?.data) ? j.data : [];
}

function toRows(data) {
  const out = [];
  for (const r of data) {
    const date = String(r?.date ?? "").slice(0, 10);
    const foreign = Number(r?.foreignSettlement);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(foreign)) continue;
    // zero-sum: 개인 + 외국인 + 기관계 + 기타법인 = 0 — 필드 의미가 바뀌면 여기서 걸린다
    const parts = [r.privateSettlement, r.foreignSettlement, r.institutionalSettlement, r.etcCorporationSettlement].map(Number);
    const zeroSum = parts.every(Number.isFinite) ? parts.reduce((a, b) => a + b, 0) : null;
    out.push({ date, value: foreign, zeroSum });
  }
  return out;
}

console.log(`▶ 다음 금융 조회: 선물(코스피200) 투자자별 순매수, 최근 ${DAYS}일`);

const kstNow = new Date(Date.now() + 9 * 3600_000);
const todayKst = kstNow.toISOString().slice(0, 10);
const nowKstMinutes = kstNow.getUTCHours() * 60 + kstNow.getUTCMinutes();
const series = [];
let zsFail = 0;
for (let page = 1; page <= 20; page++) {
  const rows = toRows(await fetchPage(page));
  if (rows.length === 0) break;
  for (const r of rows) {
    if (r.zeroSum != null && Math.abs(r.zeroSum) > 0.5) zsFail++;
    // 당일 행은 장 마감(선물 15:45 KST) 전이면 장중 부분값이라 건너뛴다 — 옛 네이버
    // 수집분의 9/17 값(113)이 오전 실행 때 잡힌 부분값이었고 마감값은 802 였다.
    // 워크플로가 10:00 KST 에 돌므로 당일 값은 다음 날 실행에서 확정값으로 들어온다.
    if (r.date === todayKst && nowKstMinutes < 16 * 60) continue;
    series.push({ date: r.date, value: r.value });
  }
  if (rows.at(-1) && new Date(rows.at(-1).date) < cutoff) break;
  await sleep(400); // 예의상 간격
}

if (series.length === 0) {
  console.error("✗ 파싱 결과 0건. 다음 API 응답 구조가 바뀌었을 수 있음.");
  // 0건은 실패가 아니다 — 주말·휴일이나 새 글이 없는 날에도 워크플로가 "실패"로
  // 찍혀 진짜 장애를 가리고 로컬 재실행 도구가 헛돌았다(감사 2026-09-28: 일요일
  // 8개 수집기 전부 거짓 실패). 경고만 남기고 정상 종료한다. 파서가 진짜 깨진
  // 경우는 DB 최신 날짜가 며칠째 안 움직이는 것으로 드러난다.
  console.log("::warning::파싱 결과 0건 — 새 글이 없거나 구조가 바뀌었을 수 있음");
  process.exit(0);
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
  console.log(`\n✔ 소스 정상. 다음 최신 거래일: ${clean.at(-1).date}`);
  process.exit(0);
}
if (DRY_RUN) {
  console.log("\n--dry-run: 전송 생략");
  process.exit(0);
}

// ── 앱으로 전송 ────────────────────────────────────────────────────
const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = `Bearer ${CRON_SECRET}`;
  if (VERCEL_BYPASS) headers["x-vercel-protection-bypass"] = VERCEL_BYPASS;
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
