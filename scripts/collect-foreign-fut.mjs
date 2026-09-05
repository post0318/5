/**
 * 외국인 코스피200 선물 순매수 — 로컬 수집기.
 *
 * KRX 정보데이터시스템 [MDCSTAT13102] "투자자별 거래실적(선물)" 화면은
 *  (1) 로그인 필수  (2) Vercel(데이터센터 IP)에서는 LOGOUT 으로 차단
 * 이라 서버 배치로는 못 가져온다. 한국 IP 의 로컬 PC 에서 이 스크립트를
 * 주 1회 정도 돌려 앱의 import 엔드포인트로 밀어넣는다. (앱 배포본에는
 * 크롤링 코드가 없음 — 이 파일은 로컬 전용 도구.)
 *
 * ── 준비 ────────────────────────────────────────────────────────────
 *  1) 브라우저에서 https://data.krx.co.kr 로그인
 *  2) 그 상태로 "코스피200 선물 투자자별 거래실적" 화면을 한 번 조회
 *  3) F12 → Network → 아무 getJsonData.cmd 요청 → Request Headers 의
 *     "Cookie:" 줄 전체를 복사
 *  4) 프로젝트 루트 .env.local 에 아래 줄 추가 (.env* 는 git 무시됨):
 *       KRX_COOKIE="여기에 복사한 쿠키 문자열 전체"
 *     (선택) KR_FG_IMPORT_URL="https://5-topaz-five.vercel.app/api/cron/kr-fg"
 *     (선택) CRON_SECRET="앱에 설정한 값이 있으면"
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-foreign-fut.mjs              # 최근 40일 수집 → 앱 전송
 *   node scripts/collect-foreign-fut.mjs --days=120   # 기간 지정
 *   node scripts/collect-foreign-fut.mjs --dry-run    # 전송 안 하고 파싱 결과만
 *
 * 세션이 만료되면 "KRX 세션 만료" 로 죽는다 → 다시 로그인해서 KRX_COOKIE 갱신.
 *
 * ── Windows 작업 스케줄러 등록 (주 1회) ─────────────────────────────
 *   프로그램: node
 *   인수:     C:\Users\post0\5\scripts\collect-foreign-fut.mjs
 *   시작 위치: C:\Users\post0\5
 */

import { readFileSync, writeFileSync } from "node:fs";

// ── 응답 컬럼 매핑 ──────────────────────────────────────────────────
// 1차 실행 후 실제 응답 구조를 보고 필요하면 여기만 고치면 된다.
// null 이면 자동 탐지 시도.
const MAPPING = {
  /** 날짜 필드명. MDCSTAT13102 wide 응답 = "TRD_DD" */
  dateKey: "TRD_DD",
  /**
   * 외국인 순매수 필드명. MDCSTAT13102 응답 컬럼:
   *   A07 = 기관 합계, A08 = 기타법인, A09 = 개인, A12 = 외국인 합계
   * (2026-09-04 수동 다운로드 xlsx 와 값이 정확히 일치해 확정)
   * A07+A08+A09+A12 = 0 (zero-sum) 으로 검증.
   */
  foreignKey: "A12",
  /** zero-sum 검증용 나머지 투자자 컬럼 */
  wideAllInvestorKeys: ["A07", "A08", "A09", "A12"],
  /**
   * long 포맷(한 행 = 하루×투자자)일 때, 외국인 행을 고르는 이름 조각과
   * 순매수 값 필드명.
   */
  longInvestorNameKey: "INVST_TP_NM",
  longForeignNameMatch: "외국인", // "기타외국인"도 합산
  longNetKey: null, // 예: "NETBUY_TRDVOL". null = 자동 탐지
};

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
const DRY_RUN = ARGS.includes("--dry-run");
const DAYS = Number(ARGS.find((a) => a.startsWith("--days="))?.split("=")[1]) || 40;

const COOKIE = (ENV.KRX_COOKIE || "").trim();
const IMPORT_URL = (ENV.KR_FG_IMPORT_URL || "https://5-topaz-five.vercel.app/api/cron/kr-fg").trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();

if (!COOKIE) {
  console.error("✗ .env.local 에 KRX_COOKIE 를 설정하세요. (브라우저에서 KRX 로그인 후 쿠키 복사 — 파일 상단 주석 참고)");
  process.exit(1);
}

// ── 날짜 범위 ──────────────────────────────────────────────────────
const ymd = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
const today = new Date();
const from = new Date(today.getTime() - DAYS * 86_400_000);
const strtDd = ymd(from);
const endDd = ymd(today);

// ── KRX 조회 ───────────────────────────────────────────────────────
const KRX_URL = "https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd";
const params = new URLSearchParams({
  bld: "dbms/MDC/STAT/standard/MDCSTAT13102",
  locale: "ko_KR",
  prodId: "",
  strtDd,
  endDd,
  inqTpCd: "2",
  prtType: "QTY", // 계약수
  prtCheck: "SUN", // 순매수
  isuCd: "KR___FUK2I", // 코스피200 선물
  aggBasTpCd: "",
  strtDdBox1: strtDd,
  endDdBox1: endDd,
  share: "1",
  csvxls_isNo: "false",
});

console.log(`▶ KRX 조회: ${strtDd} ~ ${endDd} (코스피200 선물 투자자별 순매수)`);

const res = await fetch(KRX_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    Referer: "https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd",
    "X-Requested-With": "XMLHttpRequest",
    Cookie: COOKIE,
  },
  body: params.toString(),
});

const text = await res.text();
if (!res.ok) {
  console.error(`✗ KRX HTTP ${res.status}\n${text.slice(0, 300)}`);
  process.exit(1);
}
if (text.trim() === "LOGOUT" || (text.length < 80 && /login|logout/i.test(text))) {
  console.error("✗ KRX 세션 만료. 브라우저에서 다시 로그인한 뒤 .env.local 의 KRX_COOKIE 를 갱신하세요.");
  process.exit(1);
}

let json;
try {
  json = JSON.parse(text);
} catch {
  console.error("✗ JSON 파싱 실패. 응답 앞부분:\n" + text.slice(0, 500));
  process.exit(1);
}

const rows = json.output ?? json.block1 ?? json.OutBlock_1 ?? json.OutBlock1 ?? [];
if (!Array.isArray(rows) || rows.length === 0) {
  console.error("✗ 데이터 행이 없음. 최상위 키:", Object.keys(json));
  writeFileSync(new URL("./.krx-last-response.json", import.meta.url), text);
  console.error("  전체 응답을 scripts/.krx-last-response.json 에 저장했습니다.");
  process.exit(1);
}

// ── 파싱 ───────────────────────────────────────────────────────────
const num = (v) => {
  if (v == null) return null;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
};
const toIso = (v) => {
  const s = String(v).trim();
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(s)) return s.replace(/\//g, "-");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return null;
};

const sample = rows[0];
console.log("\n첫 행 원본:");
console.log(JSON.stringify(sample, null, 1));

const keys = Object.keys(sample);
const isLong = keys.includes(MAPPING.longInvestorNameKey);

let series = [];

if (isLong) {
  // long: 한 행 = 하루 × 투자자유형
  const dateKey =
    MAPPING.dateKey || keys.find((k) => toIso(sample[k]) != null);
  const netKey =
    MAPPING.longNetKey ||
    keys.find((k) => /net|순매수|SUN/i.test(k)) ||
    keys.find((k) => /TRDVOL|TRDVAL/i.test(k) && num(sample[k]) != null);
  if (!dateKey || !netKey) {
    console.error("✗ long 포맷인데 날짜/순매수 필드 자동탐지 실패. 필드명 후보:", keys);
    process.exit(1);
  }
  console.log(`\n포맷=long  dateKey=${dateKey}  netKey=${netKey}  investorNameKey=${MAPPING.longInvestorNameKey}`);
  const byDate = new Map();
  for (const r of rows) {
    const name = String(r[MAPPING.longInvestorNameKey] ?? "");
    if (!name.includes(MAPPING.longForeignNameMatch)) continue; // "외국인" + "기타외국인"
    const iso = toIso(r[dateKey]);
    const v = num(r[netKey]);
    if (iso == null || v == null) continue;
    byDate.set(iso, (byDate.get(iso) ?? 0) + v);
  }
  series = [...byDate.entries()].map(([date, value]) => ({ date, value }));
} else {
  // wide: 한 행 = 하루, 투자자별 컬럼
  const dateKey = MAPPING.dateKey || keys.find((k) => toIso(sample[k]) != null);
  if (!dateKey) {
    console.error("✗ wide 포맷인데 날짜 필드 자동탐지 실패. 필드명 후보:", keys);
    process.exit(1);
  }
  let foreignKey = MAPPING.foreignKey;
  if (!foreignKey) {
    // 후보: 이름에 외국인/FORN 이 들어가거나, 값 라벨이 그런 것
    foreignKey = keys.find((k) => /forn|frgn|외국인/i.test(k)) || null;
  }
  if (!foreignKey) {
    console.error(
      "✗ wide 포맷인데 외국인 컬럼 자동탐지 실패. MAPPING.foreignKey 를 지정하세요.\n   숫자형 필드 후보(첫 행 값):",
    );
    for (const k of keys) if (num(sample[k]) != null) console.error(`     ${k} = ${sample[k]}`);
    writeFileSync(new URL("./.krx-last-response.json", import.meta.url), text);
    console.error("   전체 응답을 scripts/.krx-last-response.json 에 저장했습니다 — 첫 2~3행을 보내주면 매핑을 확정하겠습니다.");
    process.exit(1);
  }
  console.log(`\n포맷=wide  dateKey=${dateKey}  foreignKey=${foreignKey}`);
  let zeroSumFail = 0;
  for (const r of rows) {
    const iso = toIso(r[dateKey]);
    const v = num(r[foreignKey]);
    if (iso == null || v == null) continue;
    // zero-sum 검증 (모든 투자자 컬럼이 있을 때)
    const allKeys = MAPPING.wideAllInvestorKeys?.filter((k) => k in r) ?? [];
    if (allKeys.length >= 2) {
      const s = allKeys.reduce((acc, k) => acc + (num(r[k]) ?? 0), 0);
      if (Math.abs(s) > 0.5) zeroSumFail++;
    }
    series.push({ date: iso, value: v });
  }
  if (zeroSumFail > 0) {
    console.error(`✗ zero-sum 검증 실패 ${zeroSumFail}건 — 컬럼 매핑이 바뀌었을 수 있음. 중단.`);
    writeFileSync(new URL("./.krx-last-response.json", import.meta.url), text);
    process.exit(1);
  }
}

series.sort((a, b) => a.date.localeCompare(b.date));
series = series.filter((r, i, arr) => i === 0 || arr[i - 1].date !== r.date); // 중복 제거

if (series.length === 0) {
  console.error("✗ 파싱 결과 0건. 응답을 scripts/.krx-last-response.json 에 저장.");
  writeFileSync(new URL("./.krx-last-response.json", import.meta.url), text);
  process.exit(1);
}

console.log(`\n✔ 파싱 완료: ${series.length}건  (${series[0].date} ~ ${series.at(-1).date})`);
console.log("  최근 5건:", series.slice(-5));

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
  body: JSON.stringify({ foreignFutNet: series }),
});
const upBody = await up.text();
if (!up.ok) {
  console.error(`✗ 앱 전송 실패 HTTP ${up.status}: ${upBody.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\n✔ 앱 전송 완료: ${upBody}`);
