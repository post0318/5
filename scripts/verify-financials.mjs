/**
 * 재무 숫자 검증 (오너 지시 2026-09-23 "검증체계는 구축해라", 2026-09-24 재구축).
 *
 * 1층(단일 계산 모듈 강제)은 eslint.config.mjs 의 no-restricted-syntax 규칙이다.
 * 이 스크립트는 **실행 중인 앱의 API** 를 호출해 사용자가 보는 숫자를 검사한다.
 *
 * ── 2026-09-24 재구축 이유 (독립 감사에서 재현된 결함) ──────────────────
 *  - 양쪽 화면이 모두 빈칸이면 "통과"로 쳤다 → TSM·ASML 은 연도 열이 통째로 없는데 통과.
 *  - 검사가 앱 대 앱 비교뿐이라 모든 화면에 같이 퍼진 오류(순이익 ×1.1)를 못 잡았다.
 *  - 연도를 앱과 같은 방식(결산일 연도)으로 맞춰 52/53주 결산 회사(WEN)의 연도 누락을 놓쳤다.
 *  - 조회 실패·검사 0건·건너뜀이 "실패 0"으로 끝났다(조용히 사라지는 검사).
 *  - 기준값이 없으면 정의가 다른 값으로 조용히 대체했다(AVGO — 우선주배당 포함 순이익).
 *  - 개요 검사는 화면 값을 읽지 않고 식을 다시 짜서 계산했다.
 *
 * ── 원칙 ───────────────────────────────────────────────────────────────
 *  1. 통과는 **양쪽 값이 있고 같을 때만**. 양쪽 빈칸은 "검증불가(양쪽 빈칸)".
 *  2. 있어야 할 값이 빈칸이면 **실패**(기대치 검사). 기대치는 앱이 아니라 SEC 원자료로 정한다.
 *  3. 기준값은 대체하지 않는다. 정의상 같은 값으로 바꿀 때만 쓰고 결과에 사유를 남긴다.
 *  4. 조회 실패·검사 누락은 모두 기록하고 종료코드 1 로 끝난다.
 *  5. 앱 계산을 재현하지 않는다 — 앱이 실제로 낸 값(API·verify-row)만 비교한다.
 *
 * ── 층 ────────────────────────────────────────────────────────────────
 *  A. SEC 원자료 대조(미국) — 앱 순이익·EPS 를 SEC companyfacts(+XBRL 인스턴스)와 직접.
 *     EPS 분할 보정 계수는 Yahoo 분할 이력으로 따로 구한다(앱 로직과 독립).
 *  B. 결산 기간 대조 — SEC 10-K 결산일 목록과 앱 연도 열(날짜 ±7일).
 *  C. 화면 간 동일성 — 하이라이트↔재무분석↔손익·대차대조표↔컨센서스↔개요·유니버스(verify-row).
 *  D. 항등식·부호 규칙 — EV 브릿지, EV/EBITDA, 분모 0 이하면 배수 빈칸, 자산=부채+자본.
 *  E. 공시 내부 정합성 — 공시 EPS × 가중평균 주식수 ≈ 보통주 귀속 순이익(회사 공시 자체).
 *  F. 외부 대조(검토 목록, 판정 아님) — Yahoo EBITDA·차입금(기준일 일치할 때만), 인포맥스 주식수.
 *
 * 2차 감사 반영(2026-09-24): 영업이익 합성 판정은 SEC 본표 근거로만 · 모기지 리츠 건너뜀은 SEC 원자료로 확인될 때만 ·
 * LTM EBITDA·PBR 기대치 · 외부·SEC 조회 실패 전부 종료코드 1 · 감가상각비 = SEC 현금흐름표 본표 줄 합(A층, 운용리스 상각
 * 원인 확인의 전제) · EBITDA = 영업이익 + 감가상각비(D층, 미국·한국) · 연도 라벨 = SEC fy(B층) · 국내 FnGuide 순이익(지배)
 * 정의 일치·EV(비지배지분)·EPS(자사주 포함 주식수) 원인 확인.
 * 2026-09-24 감가상각비: A층 현금흐름표 줄 합에서 손상(손상 포함 줄 — TSLA·XOM)·중단사업 감가상각(중단사업 포함 현금흐름표 —
 * WDC·MMM·JNJ)을 10-K 원본 태그로 따로 빼서 대조(예전 줄 합 대조는 앱과 같이 틀렸다 — 공통모드) · StockAnalysis 원인
 * ⑦ 앱 = depAmorEbitda + 현금흐름표 기타상각.
 * 2026-09-25: A층 EPS — 총 희석 EPS 태그가 없으면 같은 10-K 의 계속영업 + 중단영업 희석 EPS 합(DELL FY2022) · A층 결산일
 * 주식수(앱 시총 ÷ 결산일 실제 종가 = SEC 본표 주식수) · 인포맥스 원인 ⑨ EPS = SEC 순이익 ÷ 희석주식수 자체 계산,
 * ⑩ 결산일 시가총액 = 전년도 주식수 사용, 앱=SEC 본표=StockAnalysis 인데 인포맥스만 다르면 "외부 단독 이탈"(원인 확인 아님).
 * 2026-09-25 매출 닫기(docs/metrics/revenue.md §6): A층 매출 기대값 = 손익계산서 본표(_pre 표시 순서·_cal 계산 관계)의 첫 총매출 줄
 * (태그 순서 아님, 최신 판본) — 연간·분기(3개월, Q4 = 사업연도 − 9개월)·LTM. C층 매출 소비처 전부(총괄·컨센서스·개요·유니버스)와
 * 성장률·마진·PSR 재계산, D층 분기 4개 합 = 연간·LTM = 최근 4분기 합(R4 반올림 차 명시), F층 매출 ①/②/외부 단독 이탈/③ 분류.
 * 2026-09-26 F층 허용 오차 폐지(오너 지시 "허용오차는 허락한 적이 없다"): ① = 완전 일치(extEq)만. 외부 표기 단위 반올림은 ②
 * "외부 표기 단위 반올림"(roundHalfAway 식 성립 시), 원인 규칙도 모두 식 완전 성립만. 소스·지표별 표기 단위 표는 F층 첫머리.
 *
 * 실행:
 *   node scripts/verify-financials.mjs --symbols=AAPL,WMT
 *   node scripts/verify-financials.mjs --universe | --sp500 [--limit=50]
 *   node scripts/verify-financials.mjs --market=kr --symbols=005930
 *   옵션: --base=http://localhost:3000 · --concurrency=2 · --no-external
 *         --metric=revenue (매출 닫기 모드 — 종료코드 = 매출 검사 실패·매출 ③ 오류·조회 실패. 기본 실행은 종전 기준)
 *         --metric=cogs (매출원가·매출총이익 모드 — 이 모드에서만 A층 본표 대조·분기 항등식·F층 분류를 돈다. 지표 미종결)
 *         --metric=opinc (영업이익 모드 — 매출원가 모드 전부 + 영업이익 A층 본표 대조(연간·분기·LTM, 소계 없는 본표는 FASB 택사노미 분류로
 *           세전이익 − 영업외 항목을 따로 계산)·F층 분류. 종료코드 = 매출원가·매출총이익·영업이익 검사 실패·③ 오류·조회 실패. 지표 미종결)
 *         --metric=da (감가상각비 모드 — 영업이익 모드 전부 + 감가상각비 A층(현금흐름표 영업활동 조정 항목의 감가상각·상각 줄 합 — 연간·분기(누적 차)·
 *           LTM, 앱 연도 열을 담은 과거 10-K 까지)·F층 분류. 종료코드 = 위 지표 + 감가상각비 검사 실패·③ 오류·조회 실패. 지표 미종결)
 *         --metric=sga (판관비·연구개발비 모드 — 감가상각비 모드 전부 + 판관비·연구개발비 A층(공시마다 손익계산서 본표 계산 구조의 영업이익 식(없으면
 *           세전이익 식 — IBM·XOM)을 내려가며 판관비·연구개발비 성격 줄을 모은 합: 표준 개념은 개념 이름, 회사 고유 개념은 그 공시 자체 라벨, 원가 줄·
 *           매출총이익 식은 들어가지 않음, 뿌리와 끊긴 줄은 표시 순서로 보충. 회사별 예외(AMZN·NFLX·KO 줄 지정, DAL 판관비 제외)는 검증기 안에 따로
 *           적었고 그 열은 공통모드. 연간·분기(Q4 = 사업연도 − 9개월)·LTM, 줄 값은 공시 원본 decimals 판본. 파생 열 구성 공시 간 줄 구성이 다르면
 *           합 동일(개념 이름만 바뀜)이면 공시별 합, 아니면 앱 빈칸 + "기준 혼합". 줄 없음 = 빈칸 + "본표에 줄 없음", 금융사 = 해당 없음.
 *           하위 줄(여러 줄 합) = SEC 줄 값 · 하위 줄 합 = 판관비 행)·F층 분류(Yahoo·StockAnalysis 판관비·연구개발비, 인포맥스(FactSet
 *           판관비 = 연구개발비 포함)는 "판관비·연구개발비" 합 항목 — ② 는 SEC 본표 줄로 만든 식이 모든 연간 열에서 정확 성립할 때만).
 *           종료코드 = 위 지표 + 판관비·연구개발비 검사 실패·③ 오류·조회 실패. 지표 미종결)
 *         --cogs-rules=파일.json (D형 — 본표에 매출원가 줄이 없는 회사 — 의 회사별 구성 규칙. 앱 src 에서 가져오지 않고 데이터로 받는다:
 *           { "MCD": { "lines": [{ "concept": "mcd_X" | ["mcd_X", "us-gaap_Y"](공시마다 태깅이 다를 때 대안), "w": 1, "member": "ProductOrServiceAxis=ZMember"?,
 *                                  "optional": true?(그 공시 본표에 없으면 0 — CEG 계열사 줄·DAL 조종사 합의금처럼 일부 공시에만 있는 줄) }],
 *                      "linesByForm": { "10-Q": [...] }?(양식마다 본표 줄 구성이 다를 때), "gp": "synth"|"blank", "note": "근거" } }
 *           규칙이 있으면 그 줄들이 그 공시 본표(손익 역할)에 있는지 확인하고 줄 값 합과 앱 매출원가를 정확 대조한다)
 * 결과: reports/verify/verify-{market}-{YYYYMMDD-HHmm KST}.json. 실패·오류·누락이 있으면 종료코드 1.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join as pathJoin, resolve as pathResolve } from "node:path";
import { createRequire } from "node:module";
import { loadBbg } from "./reference/bbg.mjs";
import { makeDiskCache } from "./verify-kr/cache.mjs";
import { configureDart, dartFnltt, dartStats, dartQuota } from "./verify-kr/dart.mjs";
import { configureKrx, krxStats } from "./verify-kr/krx.mjs";
import { configureCalendar } from "./verify-kr/calendar.mjs";
import { krOriginalLayers, closeKrLayers } from "./verify-kr/layers.mjs";
import { buildAudit, COGS_RULE_COMMON, commonModeOf, decimalsVintage, extItemOf, isDecimalsRounding } from "./metrics/audit.mjs";

// ── 인자 ─────────────────────────────────────────────────────────────
const args = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z0-9-]+)(?:=(.*))?$/i.exec(a);
  if (!m) die(`알 수 없는 인자: ${a}`);
  args[m[1]] = m[2] ?? true;
}
function die(msg) {
  console.error(`오류: ${msg}`);
  process.exit(2);
}
const KNOWN = new Set(["symbols", "universe", "sp500", "limit", "market", "base", "concurrency", "no-external", "post", "missing", "metric", "cogs-rules", "use-snapshots"]);
// 매출 닫기 모드(revenue.md §8) — 종료코드를 매출 검사 실패·매출 ③ 오류·조회 실패 기준으로. 기본 실행은 종전 그대로
const METRIC = args.metric == null ? null : String(args.metric).toLowerCase();
if (METRIC != null && !["revenue", "cogs", "opinc", "da", "sga", "bscf"].includes(METRIC)) die(`--metric 은 revenue·cogs·opinc·da·sga·bscf 중 하나 (받은 값: ${args.metric})`);
// 판관비·연구개발비 모드(2026-09-28) — 감가상각비 모드를 포함한다(누적 닫힘) + 판관비·연구개발비 A층(본표 영업이익 식의 성격 줄 합)·F층 분류
// 재무상태표·현금흐름표 모드(2026-09-30) — 판관비 모드를 포함한다(누적 닫힘) + 재무상태표·현금흐름표 A층·D층
const BSCF_MODE = METRIC === "bscf";
const SGA_MODE = METRIC === "sga" || BSCF_MODE;
// 영업이익 모드(2026-09-27) — 매출원가 모드를 포함한다(누적 닫힘: 매출원가·매출총이익 검사가 계속 돈다) + 영업이익 A층·F층 분류
const OPINC_MODE = METRIC === "opinc" || METRIC === "da" || SGA_MODE;
// 감가상각비 모드(2026-09-27) — 영업이익 모드를 포함한다(누적 닫힘) + 감가상각비 A층(현금흐름표 줄 합 — 연간·분기·LTM, 과거 10-K 까지)·F층 분류
const DA_MODE = METRIC === "da" || SGA_MODE;
// 매출원가·매출총이익 모드 — 지표가 닫히기 전이라 기본 실행(야간 검증)에는 새 검사를 넣지 않는다
const COGS_MODE = METRIC === "cogs" || OPINC_MODE;
/** D형 구성 규칙(--cogs-rules) — 종목 → { lines: [{ concept, w?, member?, label?, optional? }], linesByForm?, gp: "synth"(기본)|"blank", note } */
let COGS_RULES = {};
if (args["cogs-rules"] != null) {
  if (args["cogs-rules"] === true) die("--cogs-rules 에 규칙 파일 경로를 지정하세요");
  try { COGS_RULES = JSON.parse(readFileSync(String(args["cogs-rules"]), "utf8")); }
  catch (e) { die(`--cogs-rules 파일을 읽지 못함: ${String(e).slice(0, 120)}`); }
  for (const [s, r] of Object.entries(COGS_RULES)) {
    const okId = (c) => typeof c === "string" && /^[a-z0-9-]+_[A-Za-z0-9_]+$/.test(c);
    const okLines = (ls) => Array.isArray(ls) && ls.length && ls.every((l) => okId(l?.concept) || (Array.isArray(l?.concept) && l.concept.length && l.concept.every(okId)));
    if (!okLines(r?.lines) || Object.values(r.linesByForm ?? {}).some((ls) => !okLines(ls)))
      die(`--cogs-rules ${s}: lines(·linesByForm 값)는 { concept: "접두어_개념명" | ["대안1", "대안2"] } 배열이어야 함`);
    if (r.gp != null && r.gp !== "synth" && r.gp !== "blank") die(`--cogs-rules ${s}: gp 는 "synth" 또는 "blank"`);
  }
}
for (const k of Object.keys(args)) if (!KNOWN.has(k)) die(`알 수 없는 옵션 --${k}`);
if (args.symbols === true) die("--symbols 에 종목을 지정하세요 (예: --symbols=AAPL,WMT)");
const MARKET = String(args.market ?? "us").toLowerCase();
if (MARKET !== "us" && MARKET !== "kr") die(`--market 은 us 또는 kr (받은 값: ${args.market})`);
const CONCURRENCY = Number(args.concurrency ?? 2);
if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1) die(`--concurrency 는 1 이상의 정수 (받은 값: ${args.concurrency})`);
if (args.limit != null && !(Number.isInteger(Number(args.limit)) && Number(args.limit) > 0)) die(`--limit 은 양의 정수`);
const BASE = String(args.base ?? "http://localhost:3000").replace(/\/$/, "");
const EXTERNAL = !args["no-external"];
/** 검증이 닫힌 지표(관리자 화면 감사표의 closed) — 정답 데이터셋(골든셋)의 GOLDEN_CHECKS 와 같은 목록이어야 한다.
 *  지표를 닫을 때 scripts/metrics/golden.mjs 의 GOLDEN_CHECKS 와 함께 갱신할 것(revenue ↔ "매출") */
const CLOSED_METRICS = ["매출"];

function loadEnvLocal() {
  const env = { ...process.env };
  try {
    const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*?)"?\s*$/);
      if (m && (env[m[1]] === undefined || env[m[1]] === "")) env[m[1]] = m[2];
    }
  } catch { // silent-ok: .env.local 은 선택 파일(없으면 환경변수만)
    /* .env.local 없어도 됨 */
  }
  return env;
}
const env = loadEnvLocal();
const AUTH = env.CRON_SECRET ? { authorization: `Bearer ${env.CRON_SECRET}` } : { "x-app-token": env.APP_PASSWORD ?? "" };

// 앱 저장본(api_snap·ttm_snap) 우회(재감사 12차 ⑤) — 검증 기준값이 24시간 묵은 저장본이나 다른 PC·브랜치가 쓴 "local" 저장본이 되지 않게
// 모든 요청에 인증 + x-verify-no-snapshot 을 붙인다(앱 db/snap-bypass.ts — 인증된 요청만 읽기·쓰기 모두 건너뜀). --use-snapshots 로 끔
const NO_SNAP = args["use-snapshots"] ? {} : { ...AUTH, "x-verify-no-snapshot": "1" };
if (args["use-snapshots"]) console.warn("⚠ --use-snapshots: 앱 저장본(api_snap·ttm_snap·fin_sym·us_class_facts)을 우회하지 않음 — 결과가 브랜치 코드 기준이 아닐 수 있음(저장본 영향 확인용)");
async function getJson(path, timeoutMs = 240_000, headers = {}) {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store", headers: { ...NO_SNAP, ...headers } });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

async function symbolList() {
  if (args.symbols) return String(args.symbols).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  // 유니버스 중 아직 검증 결과가 없는 종목만(새로 담긴 종목) — 관리자 화면 "미검증"과 같은 목록
  if (args.missing) {
    const r = await fetch(`${BASE}/api/cron/verify-results?market=${MARKET}`, { headers: AUTH });
    if (!r.ok) throw new Error(`미검증 목록 조회 실패 HTTP ${r.status} ${(await r.text()).slice(0, 80)}`);
    const items = (await r.json()).items.map((i) => i.symbol);
    if (!items.length) {
      console.log("미검증 종목 없음");
      process.exit(0);
    }
    return items;
  }
  if (args.universe) {
    const r = await fetch(`${BASE}/api/cron/universe-symbols?market=${MARKET}`, { headers: AUTH });
    if (!r.ok) throw new Error(`유니버스 목록 조회 실패 HTTP ${r.status} ${(await r.text()).slice(0, 80)}`);
    return (await r.json()).items.map((i) => i.symbol);
  }
  if (args.sp500) {
    if (MARKET !== "us") die("--sp500 은 미국 전용");
    const res = await fetch("https://en.wikipedia.org/w/index.php?title=List_of_S%26P_500_companies&action=raw", {
      headers: { "user-agent": "financial-verify-script" },
    });
    if (!res.ok) throw new Error(`S&P 500 목록 조회 실패 HTTP ${res.status}`);
    const raw = await res.text();
    const tbl = raw.slice(raw.indexOf("{|"), raw.indexOf("|}", raw.indexOf("{|")));
    const out = [];
    // 금융업(은행 레이아웃)도 포함한다 — 예전엔 빼서 은행 경로가 검증되지 않았다
    for (const row of tbl.split("\n|-").slice(1)) {
      const m = row.match(/\{\{(?:NyseSymbol|NasdaqSymbol|[A-Za-z]+Symbol)\|([A-Z.\-]+)/i);
      if (m) out.push(m[1].replace(".", "-"));
    }
    if (out.length < 400) throw new Error(`S&P 500 목록 파싱 이상 (${out.length}개)`);
    return args.limit ? out.slice(0, Number(args.limit)) : out;
  }
  die("--symbols=… | --universe | --sp500 중 하나를 지정하세요");
}

// ── SEC ──────────────────────────────────────────────────────────────
// 외부 소스 줄 단위 구성 대조 결과(scripts/metrics/recon-lines.mjs, 오너 지시 2026-09-27) — 이름만 붙이던 '외부 정의 분해 불가'·'외부 단독 이탈'
// 칸을 구성 분해 결과로 바꾼다: 분해되면 ②(구성 설명), 아니면 외부 단독 이탈(오너 결정 2026-09-30 — 옛 "구성미분해")
const RECON = (() => {
  const m = new Map();
  try {
    const dir = pathResolve("reports/recon");
    const f = args.recon ? String(args.recon) : existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".json")).sort().at(-1) : null;
    if (!f) return m;
    for (const r of JSON.parse(readFileSync(f.includes("/") || f.includes("\\") ? f : pathJoin(dir, f), "utf8")).results ?? []) {
      if (!r.verdict || !r.years) continue;
      const how = r.partition?.join(" · ") ?? Object.entries(r.explain ?? {}).filter(([, e]) => e.ok && !/외부 = SEC/.test(e.how ?? "")).map(([l, e]) => `${l}: ${e.how}`).join(" ; ");
      const ltmHow = r.ltm?.partition?.join(" · ") ?? how;
      for (const y of r.years) m.set(`${r.sym}|${r.src}|${r.metric}|${y}`, { ok: r.yearOk ? !!r.yearOk[y] : r.verdict !== "미결", how: y === "LTM" ? ltmHow : how, ext: r.vals?.[y]?.ext ?? null, app: r.vals?.[y]?.app ?? null });
    }
  } catch (e) { die(`recon 결과 파일 판독 실패 — ${String(e).slice(0, 120)}(파일이 있는데 못 읽으면 분류가 조용히 바뀐다)`); }
  return m;
})();
const SEC_UA = env.SEC_USER_AGENT || "global-market-research (personal use) contact@example.com";
// SEC 요청 공통 — 초당 3건 이하(앱 개발 서버 초당 5건과 합쳐 8건 — SEC 한도 10건/초 안), 429 면 65초 기다렸다 최대 3회 재시도(2026-09-26 — 판본 decimals
// 판정 도입 뒤 인스턴스 요청이 늘어 429 가 났다). 공시 원본(www.sec.gov/Archives)은 제출 후 바뀌지 않으므로 디스크에 영구 캐시
// (reports/.sec-cache — gitignore). companyfacts·submissions(data.sec.gov)는 매일 바뀌어 캐시하지 않는다.
// companyfacts·submissions·company_tickers(갱신형)도 디스크에 두고(2026-09-28 오너 지시) SEC_API_CACHE_TTL_H(기본 12시간) 안이면
// 그걸 쓴다. 새로 받기가 실패하면(429 차단 재시도 소진·시간 초과) 오래된 사본으로 대신하고 콘솔에 사본 나이를 남긴다. 위치는
// SEC_CACHE_DIR(앱과 같은 루트 — 집·회사 PC 동기화 폴더 가능) 아래 verify-archives·verify-api, 없으면 reports/.sec-cache.
const SEC_ROOT = env.SEC_CACHE_DIR ? pathResolve(env.SEC_CACHE_DIR) : null;
const SEC_DISK = SEC_ROOT ? pathJoin(SEC_ROOT, "verify-archives") : pathResolve("reports/.sec-cache");
const SEC_API_DISK = SEC_ROOT ? pathJoin(SEC_ROOT, "verify-api") : pathResolve("reports/.sec-cache/api");
const SEC_API_TTL_MS = Number(env.SEC_API_CACHE_TTL_H ?? 12) * 3_600_000;
const SEC_API_RE = /^https:\/\/(data\.sec\.gov\/(api\/xbrl\/companyfacts|submissions)\/|www\.sec\.gov\/files\/company_tickers)/;
let secChain = Promise.resolve(), secLast = 0;
async function secFetchRaw(url, timeoutMs) {
  const ARCH = "https://www.sec.gov/Archives/edgar/data/";
  const safe = (u) => u.replace(/^https:\/\//, "").replace(/[^A-Za-z0-9._-]/g, "_");
  const disk = url.startsWith(ARCH) ? pathJoin(SEC_DISK, url.slice(ARCH.length).replace(/[^A-Za-z0-9._-]/g, "_")) : null;
  // 오류 문구는 원인(HTTP 코드·시간 초과)을 앞에, 주소는 짧게 — 호출부가 오류를 60~80자로 잘라 남기므로 긴 주소가 앞에 오면 원인이 잘린다
  // (2026-10-07 AMAT·TER "본표 조회 실패: Error: SEC https://www.sec.gov/Archives/edgar/data/6951/0000" — 코드가 안 남음)
  const short = url.startsWith(ARCH) ? url.slice(ARCH.length) : url.replace(/^https:\/\/(www\.)?/, "");
  if (disk && existsSync(disk)) return readFileSync(disk, "utf8");
  const apiDisk = SEC_API_RE.test(url) ? pathJoin(SEC_API_DISK, safe(url)) : null;
  const apiAge = apiDisk && existsSync(apiDisk) ? Date.now() - statSync(apiDisk).mtimeMs : null;
  if (apiAge != null && apiAge <= SEC_API_TTL_MS) return readFileSync(apiDisk, "utf8");
  try {
    for (let attempt = 0; ; attempt++) {
      await (secChain = secChain.then(async () => { const w = secLast + 334 - Date.now(); if (w > 0) await new Promise((r) => setTimeout(r, w)); secLast = Date.now(); }));
      const r = await fetch(url, { headers: { "user-agent": SEC_UA }, signal: AbortSignal.timeout(timeoutMs) });
      if (r.status === 429 && attempt < 3) { await new Promise((res) => setTimeout(res, 65_000)); continue; }
      if (!r.ok) throw Object.assign(new Error(`SEC HTTP ${r.status} ${short}`), { secHttp: true });
      const t = await r.text();
      if (disk) { mkdirSync(SEC_DISK, { recursive: true }); writeFileSync(disk, t); }
      if (apiDisk) { mkdirSync(SEC_API_DISK, { recursive: true }); writeFileSync(apiDisk, t); }
      return t;
    }
  } catch (e) {
    if (apiAge == null) throw e?.secHttp ? e : new Error(`SEC ${e?.name === "TimeoutError" ? "시간 초과" : String(e)} ${short}`, { cause: e });
    console.warn(`  [SEC 사본 사용] ${url} — 새로 받기 실패(${String(e).slice(0, 80)}), 디스크 사본 ${(apiAge / 3_600_000).toFixed(1)}시간 전`);
    return readFileSync(apiDisk, "utf8");
  }
}
async function secJson(url) {
  return JSON.parse(await secFetchRaw(url, 60_000));
}
async function secText(url) {
  return secFetchRaw(url, 60_000);
}
/** 공시 원본(인스턴스) — 한 종목 안에서 같은 원본을 여러 대조가 다시 받지 않게 최근 12건만 캐시(SEC 요청 절약) */
const instCache = new Map();
function secInstance(url) {
  if (!instCache.has(url)) {
    instCache.set(url, secText(url).catch((e) => { instCache.delete(url); throw e; }));
    if (instCache.size > 12) instCache.delete(instCache.keys().next().value);
  }
  return instCache.get(url);
}
let cikMap = null;
// 앱(edgar.ts CIK_OVERRIDE)과 같은 보정 — 목록이 어긋나면 SEC 대조 결과에 드러난다
const CIK_OVERRIDE = { XOM: "0000034088" };
async function cikOf(sym) {
  if (!cikMap) {
    const j = await secJson("https://www.sec.gov/files/company_tickers.json");
    cikMap = new Map(Object.values(j).map((r) => [r.ticker.toUpperCase().replace(".", "-"), String(r.cik_str).padStart(10, "0")]));
  }
  return CIK_OVERRIDE[sym.toUpperCase()] ?? cikMap.get(sym.toUpperCase().replace(".", "-")) ?? null;
}

// ── 판정 도우미 ───────────────────────────────────────────────────────
const PASS = "pass", FAIL = "fail", NA = "unverifiable";
/** 공통모드(오너 결정 2026-09-26) — 앱과 같은 규칙·데이터로 판정해 앱이 틀려도 같이 통과하는 검사. 통과(PASS)·①·② 어디에도 세지 않는다 */
const COMMON = "common";
const COMMON_LABEL = "공통모드 — 독립 검증 아님";
/** 외부 표기 단위 반올림(round(앱, 단위) = 외부)만으로 설명되는 차이 — 증거로 쓰지 않는다(오너 결정 2026-09-26) */
const NA_PRECISION = "검증불가(외부 정밀도 부족)";
const NA_FX = "검증불가(외부 환율 비공개)";
/**
 * 공통모드 PASS → COMMON. 앱과 같은 규칙·데이터로 낸 통과는 외부 소스가 앱 값과 **정확히** 같을 때(extExact = 그 소스 이름)만
 * 독립 확인으로 PASS 를 유지한다. 통과가 아닌 결과(FAIL·NA)는 그대로
 */
function independentOr(res, extExact, reason) {
  if (res.status !== PASS) return res;
  if (extExact) return { ...res, note: [res.note, `공통모드 규칙(${reason})이지만 외부 ${extExact} 정확 일치 — 독립 확인`].filter(Boolean).join(" · ") };
  return { ...res, status: COMMON, note: [res.note, `${COMMON_LABEL}: ${reason}`].filter(Boolean).join(" · ") };
}
// 20-F IFRS 대응표 검증기 사본(재감사 8차) — [받는 us-gaap 개념, 원천 묶음, 부호]
const IFRS_GROUPS_SNAPSHOT = JSON.parse(readFileSync(new URL("./lib/ifrs-groups-snapshot.json", import.meta.url), "utf8"));
// 사본 묶음 중 IFRS_MAP(단순 대응) 출신 — 사본 앞부분에 같은 순서로 놓인다(ifrsDstGroups: MAP → SUM → NEG). SUM 의 원소 1개 묶음(배열 원소 하나 — LongTermDebtCurrent)은 원소가 배열이라 구분된다
const IFRS_MAP_LIKE = (g) => g.sign > 0 && g.sum.length === 1 && typeof g.sum[0] === "string";
/**
 * 20-F LTM 야후 대응 검증기 고정 사본(재감사 12차 ② — 야후 필드·부호를 앱이 보낸 출처 기록(s0.y·s0.sign)에서 가져와, 앱이 필드를 바꿔도
 * (이익잉여금 → 유형순자산) 같은 필드로 다시 계산해 통과했다). 앱 edgar-yahoo-quarters.ts FLOWS·INSTANTS·총차입금 규칙을 2026-10-04 에 떠 둔 것 —
 * 개념 → [야후 필드(문자열 "a|b" = a 없으면 b, 배열 = 합), SEC 부호(SEC = 부호 × 야후)]. 앱 기록이 이 사본과 다르면 실패.
 * 앱 대응을 고치면 이 사본도 같이 고친다
 */
/** YAHOO_LTM_FIXED 중 흐름 개념(FLOWS) */
const YAHOO_LTM_FLOW = new Set();
const YAHOO_LTM_FIXED = (() => {
  const m = new Map();
  const put = (cs, y, sign = 1) => { for (const c of cs) m.set(c, { y, sign }); };
  // 흐름
  put(["OperatingIncomeLoss", "OperatingIncomeLossUnified"], "totalOperatingIncomeAsReported");
  put(["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt", "InterestAndDebtExpense"], "interestExpense");
  put([
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesAndExtraordinaryItemsNoncontrollingInterest",
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndEquityMethodInvestments",
  ], "pretaxIncome");
  put(["IncomeTaxExpenseBenefit"], "taxProvision");
  put(["NetIncomeLoss"], "netIncome");
  put(["NetIncomeLossAvailableToCommonStockholdersBasic"], "netIncomeCommonStockholders");
  put(["ProfitLoss"], "netIncomeIncludingNoncontrollingInterests");
  put(["DepreciationAmortizationCashFlowDerived", "DAIncludingContentAmortizationDerived", "DepreciationDepletionAndAmortization", "DepreciationAmortizationAndAccretionNet",
    "DepreciationAndAmortization", "DepreciationAmortizationAndOther", "CostDepreciationAmortizationAndDepletion"], "reconciledDepreciation|depreciationAndAmortization");
  put(["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"], "operatingCashFlow");
  put(["NetCashProvidedByUsedInInvestingActivities", "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations"], "investingCashFlow");
  put(["NetCashProvidedByUsedInFinancingActivities", "NetCashProvidedByUsedInFinancingActivitiesContinuingOperations"], "financingCashFlow");
  put(["PaymentsToAcquirePropertyPlantAndEquipment"], "purchaseOfPPE", -1);
  put(["PaymentsOfDividends", "PaymentsOfDividendsCommonStock", "PaymentsOfOrdinaryDividends"], "cashDividendsPaid", -1);
  put(["PaymentsForRepurchaseOfCommonStock"], "repurchaseOfCapitalStock", -1);
  put(["ShareBasedCompensation"], "stockBasedCompensation");
  put(["IncreaseDecreaseInAccountsReceivable"], "changeInReceivables", -1);
  put(["IncreaseDecreaseInInventories"], "changeInInventory", -1);
  put(["IncreaseDecreaseInAccountsPayable"], "changeInAccountPayable");
  put(["PaymentsToAcquireIntangibleAssets"], "purchaseOfIntangibles", -1);
  put(["PaymentsToAcquireMarketableSecurities", "PaymentsToAcquireInvestments"], "purchaseOfInvestment", -1);
  put(["ProceedsFromSaleAndMaturityOfMarketableSecurities"], "saleOfInvestment");
  put(["ProceedsFromIssuanceOfLongTermDebt"], "longTermDebtIssuance");
  put(["RepaymentsOfLongTermDebt"], "longTermDebtPayments", -1);
  put(["EffectOfExchangeRateOnCashAndCashEquivalents"], "effectOfExchangeRateChanges");
  put(["CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect"], ["changesInCash", "effectOfExchangeRateChanges"]);
  put(["InterestPaidNet"], "interestPaidCFF", -1);
  put(["IncomeTaxesPaidNet", "IncomeTaxesPaid"], "taxesRefundPaid", -1);
  for (const c of m.keys()) YAHOO_LTM_FLOW.add(c);
  // 잔액(부호 없음)
  put(["Assets", "LiabilitiesAndStockholdersEquity"], "totalAssets");
  put(["Liabilities"], "totalLiabilitiesNetMinorityInterest");
  put(["StockholdersEquity"], "stockholdersEquity");
  put(["StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"], "totalEquityGrossMinorityInterest");
  put(["MinorityInterest"], "minorityInterest");
  put(["AssetsCurrent"], "currentAssets");
  put(["LiabilitiesCurrent"], "currentLiabilities");
  put(["CashAndCashEquivalentsAtCarryingValue"], "cashAndCashEquivalents");
  put(["MarketableSecuritiesCurrent", "ShortTermInvestments", "AvailableForSaleSecuritiesDebtSecuritiesCurrent", "DebtSecuritiesCurrent"], "otherShortTermInvestments");
  put(["AccountsReceivableNetCurrent"], "accountsReceivable");
  put(["InventoryNet"], "inventory");
  put(["AccountsPayableCurrent"], "accountsPayable");
  put(["PropertyPlantAndEquipmentNet"], "netPPE");
  put(["LongTermInvestments"], "investmentsAndAdvances");
  put(["CommonStocksIncludingAdditionalPaidInCapital"], ["capitalStock", "additionalPaidInCapital"]);
  put(["RetainedEarningsAccumulatedDeficit"], "retainedEarnings");
  put(["AccumulatedOtherComprehensiveIncomeLossNetOfTax"], "gainsLossesNotAffectingRetainedEarnings");
  put(["LongTermDebtCurrent"], "currentDebt");
  put(["LongTermDebtNoncurrent"], "longTermDebt");
  // 총차입금(본표 합성) — 야후 정확 일치 경로
  put(["DebtFaceDerived"], "totalDebt");
  put(["DebtFaceNoncurrentDerived"], "longTermDebtAndCapitalLeaseObligation");
  return m;
})();
/**
 * SEC 20-F 연말 값(원통화) — 앱 개념 dst 를 만드는 원천(같은 이름 us-gaap → 대응표 사본 순서의 첫 묶음). 보고 통화 = 인스턴스에서 가장 많이 쓴
 * 비 USD 통화(USD 편의 환산 값 제외). fl = filingAtDate 결과. → { v, how } | null
 */
function secBalanceOf(fl, dst) {
  const curCode = (u) => /^(?:u_)?(?:iso4217[_:]?)?([a-z]{3})$/i.exec(u ?? "")?.[1]?.toUpperCase() ?? null;
  const cnt = new Map();
  for (const x of fl.facts) { const c0 = curCode(x.unit); if (c0) cnt.set(c0, (cnt.get(c0) ?? 0) + 1); }
  const rep = [...cnt].filter(([c0]) => c0 !== "USD").sort((a, b) => b[1] - a[1])[0]?.[0] ?? (cnt.has("USD") ? "USD" : null);
  const val = (id) => fl.facts.find((x) => x.id === id && !x.dims.length && curCode(x.unit) === rep)?.v ?? null;
  const us = val(`us-gaap_${dst}`);
  if (us != null) return { v: us, how: `us-gaap_${dst}` };
  for (const [d0, sum, sign] of IFRS_GROUPS_SNAPSHOT) {
    if (d0 !== dst) continue;
    let t = 0;
    const ps = [];
    for (const e of sum) { const nm = (Array.isArray(e) ? e : [e]).find((x) => val(`ifrs-full_${x}`) != null); if (nm) { t += val(`ifrs-full_${nm}`); ps.push(nm); } }
    if (ps.length) return { v: sign * t, how: `${sign < 0 ? "−" : ""}ifrs-full ${ps.join(" + ")}` };
  }
  return null;
}
/** 감가상각 합계 개념(앱 edgar-ev DA_TOTAL + 현금흐름 본표 합성) — 6-K 원 개념 대조에서 형제 개념의 원 개념을 같이 인정 */
const DA_SIBLINGS = ["DepreciationAmortizationCashFlowDerived", "DAIncludingContentAmortizationDerived", "DepreciationDepletionAndAmortization", "DepreciationAmortizationAndAccretionNet",
  "DepreciationAndAmortization", "DepreciationAmortizationAndOther", "CostDepreciationAmortizationAndDepletion"];
/** 손익 흐름 개념(현금흐름 개념 아님) — 앱 edgar-yahoo-quarters FLOWS 앞 7개 항목의 개념(검증기 고정 사본) */
const IS_FLOW_FIXED = new Set(["OperatingIncomeLoss", "OperatingIncomeLossUnified", "InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt", "InterestAndDebtExpense",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesAndExtraordinaryItemsNoncontrollingInterest", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndEquityMethodInvestments",
  "IncomeTaxExpenseBenefit", "NetIncomeLoss", "NetIncomeLossAvailableToCommonStockholdersBasic", "ProfitLoss"]);
/** 현금흐름표 개념 이름 규칙(앱 edgar-yahoo-quarters CF_CONCEPT 의 검증기 사본) */
const CF_CONCEPT_FIXED = /^(PaymentsTo|PaymentsFor|PaymentsOf|Proceeds|Repayments|IncreaseDecrease|NetCash|EffectOfExchangeRate|CashCashEquivalents.*PeriodIncreaseDecrease|InterestPaid|IncomeTaxesPaid|DividendsReceived|InterestReceived|ShareBasedCompensation|OtherNoncashIncomeExpense|PaymentsForProceedsFrom)/;
/** 현금흐름 개념인가 — 검증기 규칙(앱 isCfConcept 의 사본) */
const isCfFixed = (c) => !IS_FLOW_FIXED.has(c) && (CF_CONCEPT_FIXED.test(c) || YAHOO_LTM_FLOW.has(c));
const EXACT = 1e-9; // 화면 간 동일성 — 같은 모듈을 거치므로 부동소수 오차만
function same(a, b, tol = EXACT) {
  if (a == null && b == null) return { status: NA, note: "양쪽 빈칸" };
  if (a == null || b == null) return { status: FAIL, note: `한쪽만 빈칸 (${a} vs ${b})` };
  const d = Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
  return d <= tol ? { status: PASS } : { status: FAIL, note: `${a} vs ${b} (차 ${(d * 100).toFixed(4)}%)` };
}
/** 앱 값 vs 원자료 기준값 — 기준값이 있으면 앱 값도 있어야 한다.
 *  결과에 app·src 값을 함께 남긴다 — 정답 데이터셋(골든셋, scripts/metrics/golden-build.mjs)이 통과 행의 값을 읽는다 */
function vsSource(app, src, tol, srcNote = "") {
  const vals = { app: app ?? null, src: src ?? null };
  if (src == null) return { status: NA, note: `원자료 없음${srcNote ? ` (${srcNote})` : ""}`, ...vals };
  if (app == null) return { status: FAIL, note: `원자료 ${src} 있는데 앱 빈칸${srcNote ? ` · ${srcNote}` : ""}`, ...vals };
  // 정확 일치(오너 원칙) — 둘 다 정수(달러·주 단위 원자료와 그 합·차)면 상대 오차 없이 완전히 같아야 한다. 상대 1e-9 는
  // 4천억 달러에서 약 400달러를 통과시켰다(골든셋 주입 시험 2026-09-26). 환율 곱·주당값 등 소수 계산값만 tol(부동소수 오차) 적용
  if (tol <= EXACT && Number.isInteger(app) && Number.isInteger(src)) {
    return app === src
      ? { status: PASS, ...(srcNote ? { note: srcNote } : {}), ...vals }
      : { status: FAIL, note: `앱 ${app} vs 원자료 ${src} (차 ${app - src})${srcNote ? ` · ${srcNote}` : ""}`, ...vals };
  }
  const d = Math.abs(app - src) / Math.max(Math.abs(src), 1e-12);
  return d <= tol
    ? { status: PASS, ...(srcNote ? { note: srcNote } : {}), ...vals }
    : { status: FAIL, note: `앱 ${app} vs 원자료 ${src} (차 ${(d * 100).toFixed(3)}%)${srcNote ? ` · ${srcNote}` : ""}`, ...vals };
}
const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;
/**
 * LTM = 최근 4개 분기 합(오너 결정 2026-09-28 — 앱 edgar-series.ts quarterSumLtm·fin/read ltmCol 과 같은 정의, 검증기가 SEC 원자료로 따로
 * 판독). 분기 = 3개월 공시값(최신 판본), 없으면 누적 차(누적_j − 누적_{j−1}), 4분기 = 사업연도 − 9개월 누적. 본표 판독 모듈마다 find·dd·
 * annualAt·quarterAt·comb 를 넘긴다. 분기 하나라도 못 만들면 null(호출부가 종전 식 "사업연도 + 당기 누적 − 전년 동기"로 — 메모에 표기)
 */
function faceQuarterSum(L, m) {
  const fy = m.find((e) => m.dd(e) >= 300 && m.dd(e) <= 400 && e.end < L && (Date.parse(L) - Date.parse(e.end)) / 864e5 < 370);
  if (!fy || fy.err || fy.blank || !fy.start) return null;
  const s0 = new Date(Date.parse(fy.end) + 864e5).toISOString().slice(0, 10);
  const cur = m.find((e) => dayDiff(e.start, s0) <= 5 && dayDiff(e.end, L) <= 3);
  if (!cur) return null;
  const k = Math.round(m.dd(cur) / 91.3);
  if (k < 1 || k > 3) return null;
  const ytd = (S, j) => m.find((e) => dayDiff(e.start, S) <= 5 && Math.abs(m.dd(e) - j * 91.3) <= 20);
  const qv = (S, j) => {
    const c = ytd(S, j);
    if (!c) return null;
    // 1분기 = quarterAt(3개월 값 + 회사 재분류 규칙 recastQ1V — 앱 분기 합 LTM 과 같게)
    if (j === 1) return m.quarterAt(c.end, false) ?? c;
    const d = m.quarterAt(c.end, false);
    if (d) return d;
    const pv = ytd(S, j - 1);
    return pv ? m.comb([[c, 1], [pv, -1]], "분기 = 누적 차") : null;
  };
  const list = [];
  for (let j = k + 1; j <= 3; j++) list.push(qv(fy.start, j));
  list.push(m.quarterAt(fy.end, true));
  for (let j = 1; j <= k; j++) list.push(qv(s0, j));
  if (list.length !== 4 || list.some((q) => !q || q.err || q.blank)) return null;
  const r = m.comb(list.map((q) => [q, 1]), "분기 4개 합(앱 LTM 과 같은 정의)");
  return r ? { ...r, end: L } : null;
}
/**
 * **회사 재분류 — 1분기(오너 결정 2026-09-29)** — 앱(markets/us/edgar-series.ts recastFirstQuarter · fin/read recastQ1)과 같은 규칙, 검증기 독립 구현(코드
 * 공유 없음). q = 1분기 3개월 값(최신 공시 판본). 같은 공시에 실린 "6개월 누적 − 2분기 3개월"(가장 나중 공시의 쌍, 역산 시점 = 그 값 쌍이 처음 실린 공시)이
 * 원공시(가장 이른 공시의 1분기 3개월)와 다르면(허용치 = 비교 값들 중 가장 굵은 표기 단위(백만 상한)의 2배) 재분류 —
 *  (b) 역산 시점 이후 1분기 3개월을 직접 다시 실은 공시가 있거나 그 재게시 값 = 역산값이면 그 값(= q, 최신 판본) — 근거 "최신공시변경 — 1분기 {form} 공시값 {원래 값}"
 *  (a) 아니면 역산값 — 근거 "역산추정 — 1분기 {form} 공시값 {원래 값}". 재게시 값 = 원공시면(2분기 쪽이 바뀜) 그대로.
 * M = { dd, facesOf(pred) → [{ accn, filed, form, r }](공시마다 그 공시가 실은 기간 값), derive(y, d, label), keys: [{ name, get(r), put(out, dr) }] }
 */
function recastQ1V(M, q) {
  if (!q || q.err || q.blank || !q.start || !q.end) return q;
  const q3 = (e) => M.dd(e) >= 55 && M.dd(e) <= 100;
  const q1s = M.facesOf((e) => dayDiff(e.start, q.start) <= 6 && dayDiff(e.end, q.end) <= 6 && q3(e)).sort((a, b) => (a.filed ?? "").localeCompare(b.filed ?? ""));
  if (!q1s.length) return q;
  const orig = q1s[0], latest = q1s.at(-1);
  const pairs = [];
  for (const y of M.facesOf((e) => dayDiff(e.start, q.start) <= 12 && Math.abs(M.dd(e) - 182.6) <= 20)) {
    const d = M.facesOf((e) => dayDiff(e.end, y.r.end) <= 6 && q3(e)).find((x) => x.accn === y.accn);
    if (d) pairs.push({ y, d });
  }
  if (!pairs.length) return q;
  const best = pairs.reduce((b, x) => (!b || (x.y.filed ?? "") > (b.y.filed ?? "") ? x : b), null);
  const unit = (v) => { let u = 1; while (u < 1e6 && v % (u * 10) === 0) u *= 10; return u; };
  const same = (a, b, ...vs) => Math.abs(a - b) <= 2 * Math.max(...vs.map((v) => unit(Math.abs(v))));
  const mm = (v) => (v / 1e6).toLocaleString("en-US", { maximumFractionDigits: 3 });
  let out = null;
  const notes = [];
  for (const k of M.keys) {
    const o = k.get(orig.r), l = k.get(latest.r), yv = k.get(best.y.r), dv = k.get(best.d.r);
    if ([o, l, yv, dv].some((v) => v == null)) continue;
    const info = pairs.filter((x) => k.get(x.y.r) === yv && k.get(x.d.r) === dv).reduce((mn, x) => ((x.y.filed ?? "") < mn ? x.y.filed ?? "" : mn), best.y.filed ?? "");
    if (info <= (orig.filed ?? "")) continue;
    const der = yv - dv;
    if (same(der, o, o, yv, dv)) continue;
    const tag = k.name ? `${k.name} ` : "";
    if (latest !== orig && ((latest.filed ?? "") >= info || same(l, der, l, yv, dv))) {
      if (same(l, o, l, o)) continue;
      notes.push(`${tag}최신공시변경 — 1분기 ${orig.form} 공시값 ${mm(o)} → ${latest.form} ${latest.filed} 직접 재게시 ${l}(역산 ${best.y.form} ${best.y.filed} 6개월 ${yv} − 2분기 ${dv} = ${der})`);
      continue;
    }
    const dr = M.derive(best.y.r, best.d.r, `${tag}역산추정 — 1분기 ${orig.form} 공시값 ${mm(o)}: ${best.y.form} ${best.y.filed} 6개월 − 2분기 3개월`);
    if (!dr) continue;
    out ??= { ...q };
    k.put(out, dr);
    notes.push(`${tag}역산추정 — 1분기 ${orig.form} 공시값 ${mm(o)} → ${der}(${best.y.form} ${best.y.filed} 6개월 ${yv} − 2분기 ${dv}, 역산 시점 ${info})`);
  }
  if (!notes.length) return q;
  const res = out ?? { ...q };
  return { ...res, recast: notes, how: `${res.how ?? q.how ?? ""} · ${notes.join(" · ")}` };
}
/** 영업이익 F층 원인 후보 — 주석에만 있는 일회성 비용 표준 태그(양수 = 비용). 오너 결정 2026-09-28 */
const NOTE_ONEOFF = ["RestructuringCharges", "RestructuringCosts", "RestructuringCostsAndAssetImpairmentCharges", "RestructuringSettlementAndImpairmentProvisions",
  "AssetImpairmentCharges", "GoodwillImpairmentLoss", "LitigationSettlementExpense", "LossContingencyLossInPeriod", "BusinessCombinationAcquisitionRelatedCosts"];
/** SEC 세전이익 개념 — 앱 edgar-ev.ts 와 같은 두 개념(지분법 포함/제외) */
const PRETAX_TAGS = [
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
];

// ── 반올림 재태깅 판정(검증기 독립 구현 — 앱 코드 import 안 함) ─────────────────────────────
// 나중 공시가 같은 기간 값을 먼저 공시된 정밀값의 100만·1억·10억·100억 단위 반올림값으로 다시 태깅하면(MCD 2022 자산총계:
// 50,435,600,000 → 2025 10-K 에서 백만 단위 50,436,000,000, AXP 2021 "$189 billion") 그 값은 기준값에서 뺀다
// (오너 승인 2026-09-25 — 1e6 추가). 같은 기간(start·end 동일)끼리만. 규칙은 앱(edgar-series.ts dropRoundedRetags)과 같게 —
// 나중 값 |값| ≥ 1억(작은 값은 판정 안 함), 먼저 값이 그 단위의 배수가 아닐 때만(이미 둥근 값끼리는 재태깅 아님).
const RETAG_UNITS = [1e6, 1e8, 1e9, 1e10];
// 1e3·1e4·1e5 단위 추가(2026-09-26, 앱과 같게) — MRVL FY2022 매출 4,462,383,000 → 4,462,400,000(10만 달러 반올림)을 놓쳤다.
// 추가 단위는 나중 값이 그 단위의 100배 이상일 때만(작은 값 판정 안 함 — 앱 규칙과 동일). 1e7 은 뺐다(AXP FY2017 충당금 2,759 → 2,760 은
// 실제 재작성). 통화 기간 값은 아래 열 단위 판본(prepareColumnVintage)이 먼저 — 이 줄 단위 규칙은 판정이 없는 값에만.
const RETAG_UNITS_SMALL = [1e3, 1e4, 1e5];
function roundedRetagUnit(e, list) {
  if (!e.val) return null;
  for (const o of list) {
    if ((o.filed ?? "") >= (e.filed ?? "") || o.start !== e.start || o.end !== e.end || o.val === e.val) continue;
    const u = (Math.abs(e.val) >= 1e8 ? RETAG_UNITS.find((k) => o.val % k !== 0 && Math.round(o.val / k) * k === e.val) : null)
      ?? RETAG_UNITS_SMALL.find((k) => Math.abs(e.val) >= 100 * k && o.val % k !== 0 && Math.round(o.val / k) * k === e.val);
    if (u) return u;
  }
  return null;
}
// ── 열 단위 판본(검증기 독립 구현 — 앱 src/lib/fin/read/vintage.ts columnFiling 과 같은 규칙, 코드 공유 안 함) ─────────────
// 한 기간(열)의 값은 한 공시에서만. 최신 판본이 앞선 공시 값을 정밀도만 낮춰 다시 실은 것이면(공유 통화 줄이 전부 같거나, 나중 공시 표시
// 단위 u 의 배수이면서 먼저 값을 u 로 반올림한 값에서 한 단위 이내 — 소계 재계산·합계 맞춤 포함 — 또는 본문 문장 재태깅) 열 전체를 앞선 정밀
// 공시로 옮기고, 진짜 재작성이면 최신 공시 그대로(줄마다 섞지 않음). 재작성·혼재는 지금 공시의 손익계산서 본표 줄로만 다시 판정(현금흐름표
// 재분류·주석 표 태그 재사용 제외). MRVL 2023 10-K 의 FY2021: 매출총이익 1,488.3 = 2,968.9 − 1,480.6(반올림 항목으로 재계산) —
// 줄 단위 판정만으론 매출원가만 정밀값으로 바뀌어 항등식이 깨졌다(2026-09-26).
const colCtx = new WeakMap(); // companyfacts 사실 객체 → { pick(fromAccn) → 열 공시 accn | null }
const PRES_UNITS_V = [1e6, 1e5, 1e4, 1e3];
const sentenceRetag = (x, y) => Math.abs(x) >= 1e8 && x !== y && RETAG_UNITS.some((k) => y % k !== 0 && Math.round(y / k) * k === x);
function presUnitOf(lines) {
  const vs = [...lines.values()].filter((v) => v !== 0);
  return vs.length ? PRES_UNITS_V.find((k) => vs.every((v) => v % k === 0)) ?? null : null;
}
function precisionRel(later, earlier, scope) {
  const u = presUnitOf(later.lines);
  let r = 0, x = 0;
  for (const [key, lv] of later.lines) {
    if (scope && !scope.has(key.slice(0, key.lastIndexOf("|")))) continue;
    const ev = earlier.lines.get(key);
    if (ev === undefined || ev === lv) continue;
    const la = Math.abs(lv), ea = Math.abs(ev);
    if (la === ea) continue; // 부호 관례만 바꾼 재태깅(MCD 9개월 영업외손익 163 → −163) — 판정에 넣지 않음
    // 부호 관례를 바꾸며 반올림한 줄(MCD 2023Q1 기타영업손익 −128.6 → 129)도 크기로
    if (sentenceRetag(lv, ev) || (u != null && la % u === 0 && ea % u !== 0 && Math.abs(la - Math.round(ea / u) * u) <= u)) r++;
    else x++;
  }
  return r && x ? "mixed" : r ? "rounded" : x ? "restated" : "same";
}
/** 공시의 손익계산서 본표 개념(`ns:이름`) — faceCogsLine 의 표시 순서 줄. 본표가 없으면 null, 조회 실패는 throw */
async function statementConcepts(cik, accn) {
  const face = await faceCogsLine(cik, accn);
  return face?.ids ? new Set(face.ids.map((id) => id.replace(/^([a-z0-9-]+)_/i, "$1:"))) : null;
}
/**
 * companyfacts 전체로 기간별 열 판본 판정기를 만들어 각 통화 기간 사실에 붙인다(colCtx). 판정은 지금 공시의 손익계산서 본표 줄로 —
 * 자기보다 이른 공시에 반올림 재게시 줄이 있는 공시만 본표를 미리 읽는다(나머지는 판정에 본표가 필요 없다). 옮겨 갈 공시는 조회하는
 * 개념을 실은 공시만(본문 문장 숫자 하나만 다시 태깅한 공시는 건너뜀). 본표가 없으면 전체 줄 판정이 "rounded" 일 때만 옮긴다.
 * latestPrecise 가 이 판정을 먼저 쓴다.
 */
async function prepareColumnVintage(facts, cik, hardErrors) {
  const periods = new Map(); // start|end → Map(accn → { accn, filed, lines, raw: Map(key → [val]) })
  const entriesOf = new Map(); // start|end → 사실 객체들
  for (const [ns, node] of Object.entries(facts ?? {}))
    for (const [c, o] of Object.entries(node ?? {}))
      for (const [unit, es] of Object.entries(o?.units ?? {})) {
        if (!/^[A-Z]{3}$/.test(unit)) continue;
        for (const e of es) {
          if (!e.start || !e.accn || !/^(10-K|10-Q|20-F|40-F)/.test(e.form ?? "")) continue;
          const pk = `${e.start}|${e.end}`;
          let m = periods.get(pk);
          if (!m) { periods.set(pk, (m = new Map())); entriesOf.set(pk, []); }
          let fl = m.get(e.accn);
          if (!fl) m.set(e.accn, (fl = { accn: e.accn, filed: e.filed ?? "", lines: new Map(), raw: new Map() }));
          const key = `${ns}:${c}|${unit}`;
          fl.raw.set(key, [...(fl.raw.get(key) ?? []), e.val]);
          entriesOf.get(pk).push([e, key]);
        }
      }
  for (const m of periods.values())
    for (const fl of m.values())
      for (const [key, vs] of fl.raw) fl.lines.set(key, vs.find((v) => !vs.some((w) => w !== v && sentenceRetag(v, w))) ?? vs[0]);
  // 본표로 좁혀야 할 수 있는 공시
  const need = new Set();
  const ordered = new Map();
  for (const [pk, m] of periods) {
    const order = [...m.values()].sort((a, b) => (a.filed !== b.filed ? (a.filed < b.filed ? 1 : -1) : a.accn < b.accn ? 1 : -1));
    ordered.set(pk, order);
    for (let i = 0; i < order.length; i++) {
      const rels = order.slice(i + 1).map((x) => precisionRel(order[i], x));
      if (rels.some((r) => r === "mixed" || r === "rounded")) need.add(order[i].accn);
    }
  }
  const scopes = new Map();
  for (const accn of need) {
    try { scopes.set(accn, await statementConcepts(cik, accn)); }
    catch (e) { scopes.set(accn, null); hardErrors.push(`열 판본 판정용 손익계산서 본표 조회 실패(${accn}): ${String(e).slice(0, 60)}`); }
  }
  for (const [pk, all] of ordered) {
    if (all.length < 2) continue;
    const memo = new Map();
    const pick = (from, key) => {
      const mk = `${from}|${key}`;
      if (memo.has(mk)) return memo.get(mk);
      const order = all.filter((x) => x.accn === from || x.lines.has(key));
      const i = order.findIndex((x) => x.accn === from);
      let cur = i < 0 ? null : order[i];
      for (let j = i + 1; cur && j < order.length; j++) {
        const r0 = precisionRel(cur, order[j]);
        if (r0 === "same") continue;
        if (!order.slice(j).some((x) => ["rounded", "mixed"].includes(precisionRel(cur, x)))) break;
        const sc = scopes.get(cur.accn);
        const r = sc ? precisionRel(cur, order[j], sc) : r0 === "rounded" ? "rounded" : "restated";
        if (r === "rounded") cur = order[j];
        else if (r !== "same") break;
      }
      const out = cur ? { accn: cur.accn, unit: presUnitOf(order[i].lines) } : null;
      memo.set(mk, out);
      return out;
    };
    for (const [e, key] of entriesOf.get(pk)) colCtx.set(e, (from) => pick(from, key));
  }
}
/**
 * 최신 공시값. 열 판본 판정(prepareColumnVintage)이 붙은 통화 기간 사실이면 그 열 공시의 값(정밀도만 낮춘 재게시면 앞선 정밀 공시 —
 * { ...선택값, retag: { val, filed, unit } }, 진짜 재작성이면 최신 공시 그대로). 열 공시에 이 개념이 없거나 판정이 없으면 줄 단위 반올림
 * 재태깅 제외(roundedRetagUnit).
 */
function latestPrecise(list) {
  return withVintage(list, latestPreciseRule(list));
}
/** 옛 규칙(열 판본·줄 단위 반올림 재태깅) 선택 — 앱 vintage.ts 와 같은 성격의 규칙이라 공통모드. decimals 교차 확인은 withVintage */
function latestPreciseRule(list) {
  const sorted = [...list].sort((a, b) => (a.filed ?? "").localeCompare(b.filed ?? ""));
  const top = sorted.at(-1);
  const pick = top ? colCtx.get(top) : null;
  const col = pick && top.accn ? pick(top.accn) : null;
  const inCol = col ? sorted.filter((x) => x.accn === col.accn) : [];
  if (inCol.length) {
    const vs = inCol.map((x) => x.val);
    const e = inCol.find((x) => !vs.some((w) => w !== x.val && sentenceRetag(x.val, w))) ?? inCol.at(-1);
    return col.accn !== top.accn && e.val !== top.val ? { ...e, retag: { val: top.val, filed: top.filed, unit: col.unit ?? "열 판본" } } : e;
  }
  const flags = sorted.map((e) => roundedRetagUnit(e, sorted));
  const keep = sorted.filter((_, i) => !flags[i]);
  const e = keep.at(-1) ?? null;
  const di = flags.map((u, i) => (u ? i : -1)).filter((i) => i >= 0).at(-1);
  return e && di != null && di >= 0 ? { ...e, retag: { val: sorted[di].val, filed: sorted[di].filed, unit: flags[di] } } : e;
}
/** 기준값 메모 — 먼저 공시된 정밀값과 나중 반올림값이 갈리면 둘 다 남긴다 */
const retagNote = (e) => [
  e?.retag ? `반올림 재태깅 제외 — 먼저 공시된 정밀값 ${e.val}(${e.filed}) 채택, 나중 공시 ${e.retag.val}(${e.retag.filed})는 ${e.retag.unit} 단위 반올림`
    : e?.vint != null ? `판본 — 최신 공시값 ${e.val}(${e.filed}) 채택(앞선 공시와 값이 다름 — 재작성으로 판정)` : "",
  e?.vint != null ? `[판본 #${e.vint}]` : "",
].filter(Boolean).join(" ");

// ── 판본 판정 교차 확인 — XBRL decimals 기반 독립 판정(오너 승인 2단계, 2026-09-26, docs/metrics/architecture.md) ───────────────────
// 위 옛 규칙(열 판본·반올림 재태깅)은 앱 src/lib/fin/read/vintage.ts(columnFiling·precisionRelation·usdRounds)의 줄 단위 재구현이라
// 앱과 같이 틀린다(MRVL 1e5 재태깅을 둘 다 놓침). 한 기간에 값이 다른 판본이 둘 이상이면 그 선택을 등록해 두고(메모에 [판본 #N]),
// 나중에 각 공시 원본 인스턴스의 decimals 속성만으로 따로 판정한다(scripts/metrics/audit.mjs decimalsVintage — 값 모양·RETAG_UNITS 안 씀).
//   · 두 판정이 같고 decimals 근거가 모두 있음 → 판본 선택은 독립 확인(공통모드 사유에서 빠진다 — commonModeOf)
//   · 다름 → FAIL(앱은 옛 규칙과 같은 규칙이다 — 두 값을 메모에)
//   · decimals 없음(인스턴스 없는 옛 공시·decimals 없는 사실·조회 실패) → 종전 그대로(반올림 재태깅 선택이면 공통모드)
// companyfacts 에는 decimals 가 없어 인스턴스를 읽는다(공시당 1회, 차원 없는 사실만 색인해 캐시).
const factConcept = new WeakMap(); // companyfacts 사실 객체 → 개념 이름(ns 없이 — 인스턴스 접두어가 공시마다 다를 수 있음)
function indexFactConcepts(facts) {
  for (const node of Object.values(facts ?? {}))
    for (const [c, o] of Object.entries(node ?? {}))
      for (const es of Object.values(o?.units ?? {})) for (const e of es) factConcept.set(e, c);
}
const vintReg = new Map(), vintSig = new Map(); // id → { concept, start, end, cands: [{ accn, filed, form, val }], rule }
/** 옛 규칙의 선택 r 에 판본 등록 번호(vint)를 붙인다 — 목록에 값이 다른 사실이 둘 이상이고 전부 같은 companyfacts 개념일 때만 */
function withVintage(list, r) {
  if (!r || new Set(list.map((x) => x.val)).size < 2) return r;
  const cs = new Set(list.map((x) => factConcept.get(x)));
  if (cs.size !== 1 || cs.has(undefined) || list.some((x) => !x.accn)) return r;
  const cands = [...new Map(list.map((x) => [`${x.accn}|${x.val}`, { accn: x.accn, filed: x.filed ?? "", form: x.form ?? "", val: x.val }])).values()];
  const d = { concept: [...cs][0], start: list[0].start ?? "", end: list[0].end, cands, rule: r.val };
  const sig = `${d.concept}|${d.start}|${d.end}|${d.rule}|${cands.map((x) => `${x.accn}:${x.val}`).sort().join(",")}`;
  let id = vintSig.get(sig);
  if (id == null) { id = vintReg.size + 1; vintReg.set(id, d); vintSig.set(sig, id); }
  return { ...r, vint: id };
}
// SEC Archives 요청 — 이 판정은 공시 원본을 여러 건 더 받으므로 초당 2건 이하, 429 면 65초 기다렸다 최대 3회 재시도
async function secArchiveText(url) {
  // 공통 SEC 요청(속도 제한·429 대기·원본 디스크 캐시)으로 통일
  return secFetchRaw(url, 120_000);
}
const decIdxCache = new Map(); // accn → Promise<Map(개념|start|end → [{ v, dec }]) | null>
/** 공시 원본 인스턴스의 차원 없는 수치 사실 decimals 색인. 인스턴스가 없는 공시(XBRL 이전)는 null, 조회 실패는 throw */
function instanceDecimals(cik, accn) {
  if (!decIdxCache.has(accn)) {
    const p = (async () => {
      const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn.replace(/-/g, "")}`;
      const names = JSON.parse(await secArchiveText(`${base}/index.json`)).directory.item.map((x) => x.name);
      const instN = names.find((x) => /_htm\.xml$/i.test(x)) ?? names.find((x) => /\.xml$/i.test(x) && !/_(pre|cal|def|lab)\.xml$|FilingSummary|^R\d+\.xml$/i.test(x));
      if (!instN) return null;
      const url = `${base}/${instN}`;
      const xml = instCache.has(url) ? await instCache.get(url) : await secArchiveText(url);
      const ctx = parseContexts(xml), out = new Map();
      for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*?)contextRef="([^"]+)"([^>]*)>\s*(-?[\d.]+(?:[eE][-+]?\d+)?)\s*</g)) {
        const c = ctx.get(m[4]);
        // 차원 사실은 축 하나짜리만 "|축=멤버" 를 붙인 별도 키로(매출원가 기준 혼합 판정 — MAR 원가 멤버 줄). 차원 없는 키는 종전 그대로
        if (!c || c.dims.length > 1) continue;
        const d = /decimals="([^"]+)"/.exec(`${m[3]} ${m[5]}`)?.[1];
        const k = `${m[2]}|${c.start ?? ""}|${c.end ?? c.instant ?? ""}${c.dims.length ? `|${c.dims[0][0]}=${c.dims[0][1]}` : ""}`;
        out.set(k, [...(out.get(k) ?? []), { v: Number(m[6]), dec: d == null ? null : d === "INF" ? Infinity : Number(d) }]);
      }
      return out;
    })();
    decIdxCache.set(accn, p.catch((e) => { decIdxCache.delete(accn); throw e; }));
    if (decIdxCache.size > 80) decIdxCache.delete(decIdxCache.keys().next().value);
  }
  return decIdxCache.get(accn);
}
const vintRes = new Map(); // id → decimalsVintage 결과
async function resolveVintage(ids, cik, hardErrors) {
  for (const id of ids) {
    if (vintRes.has(id)) continue;
    const d = vintReg.get(id);
    const facts = [];
    let why = null;
    for (const x of d.cands) {
      let idx;
      try { idx = await instanceDecimals(cik, x.accn); }
      catch (e) { hardErrors.push(`판본 decimals 판정용 공시 원본 조회 실패(${x.accn}): ${String(e).slice(0, 60)}`); why = `공시 원본 조회 실패 ${x.accn}`; break; }
      // 같은 값의 사실이 여럿이면(본표 + 문장) 가장 정밀한 선언
      const hit = (idx?.get(`${d.concept}|${d.start}|${d.end}`) ?? []).filter((f) => f.v === x.val && f.dec != null);
      facts.push({ ...x, dec: hit.length ? Math.max(...hit.map((f) => f.dec)) : null });
    }
    vintRes.set(id, why ? { ok: false, why } : decimalsVintage(facts));
  }
}
/** 한 등록의 옛 규칙 선택·decimals 선택 요약 */
const vintTxt = (id) => {
  const d = vintReg.get(id), r = vintRes.get(id);
  return `${d.concept} ${d.start ? `${d.start}~` : ""}${d.end} 옛 규칙 ${d.rule}${r?.ok ? ` · decimals ${r.val}(${r.txt})` : ` · decimals 판정 불가(${r?.why ?? "미판정"})`}`;
};
/**
 * A층 검사 메모의 [판본 #N] 을 decimals 판정과 대조해 상태를 정한다(검사마다 한 번 — vintage 필드). 모두 같고 근거 있음 → "independent"
 * (메모 "판본 decimals 독립 확인" — commonModeOf 가 판본 사유를 빼는 표시) · 하나라도 다름 → FAIL "disagree" · 근거 없음 → "no-evidence"(종전 그대로)
 */
async function applyVintage(checks, cik, hardErrors) {
  const tokens = (k) => [...new Set([...(k.note ?? "").matchAll(/\[판본 #(\d+)\]/g)].map((m) => Number(m[1])))];
  const todo = new Set(checks.filter((k) => k.layer === "A" && !k.vintage && tokens(k).length));
  await resolveVintage(new Set([...todo].flatMap(tokens)), cik, hardErrors);
  for (let i = 0; i < checks.length; i++) {
    const k = checks[i];
    if (!todo.has(k)) continue;
    const ts = tokens(k);
    const dis = ts.filter((id) => vintRes.get(id)?.ok && vintRes.get(id).val !== vintReg.get(id).rule);
    const noEv = ts.filter((id) => !vintRes.get(id)?.ok);
    checks[i] = dis.length
      ? { ...k, status: FAIL, vintage: "disagree", vintageVals: [k.src, ...dis.map((id) => vintRes.get(id).val)], note: [k.note, `판본 판정 불일치 — decimals 독립 판정 ≠ 옛 규칙(앱과 같은 규칙): ${dis.map(vintTxt).join("; ")}`].join(" · ") }
      : noEv.length
        ? { ...k, vintage: "no-evidence", note: [k.note, `판본 decimals 근거 없음: ${noEv.map(vintTxt).join("; ")}`].join(" · ") }
        : { ...k, vintage: "independent", note: [k.note, `판본 decimals 독립 확인: ${ts.map(vintTxt).join("; ")}`].join(" · ") };
  }
}

// ── SEC 연간 사실 (결산 기간 = (start, end) 단위, 연도 키 아님) ────────────
function annualPeriods(facts, ns, concept, unit) {
  // end → 가장 최근 공시 사실 (10-K·10-K/A·20-F, 300~400일 기간) — 반올림 재태깅 제외
  const g = new Map();
  for (const e of facts?.[ns]?.[concept]?.units?.[unit] ?? []) {
    if (!e.start || !/^(10-K|20-F)/.test(e.form)) continue;
    const d = (Date.parse(e.end) - Date.parse(e.start)) / 864e5;
    if (d < 300 || d > 400) continue;
    g.set(e.end, [...(g.get(e.end) ?? []), e]);
  }
  return new Map([...g].map(([end, list]) => [end, latestPrecise(list)]));
}
/** 결산일(±7일)로 찾기 */
function atEnd(map, date) {
  let best = null;
  for (const [end, e] of map) if (dayDiff(end, date) <= 7 && (!best || dayDiff(end, date) < dayDiff(best.end, date))) best = e;
  return best;
}

// ── 클래스별 공시(Visa·Alphabet) — 10-K XBRL 인스턴스를 앱과 별개로 직접 읽는다 ──
async function classFactsFromInstances(cik, maxFilings = 3) {
  const sub = await secJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const r = sub.filings.recent;
  const out = new Map(); // 결산일 → { eps, shares, basis, basic }
  let n = 0;
  for (let i = 0; i < r.form.length && n < maxFilings; i++) {
    if (r.form[i] !== "10-K") continue;
    n++;
    const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${r.accessionNumber[i].replace(/-/g, "")}`;
    const idx = await secJson(`${base}/index.json`);
    const name = idx.directory.item.map((x) => x.name).find((x) => /_htm\.xml$/i.test(x));
    if (!name) continue;
    const xml = await secText(`${base}/${name}`);
    const ctx = new Map();
    for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
      const b = m[2];
      const start = /<(?:xbrli:)?startDate>([^<]+)</.exec(b)?.[1];
      const end = /<(?:xbrli:)?endDate>([^<]+)</.exec(b)?.[1];
      // explicitMember 만 해석 — typedMember 가 있으면 차원 개수에만 반영해 "차원 없음"으로 오인하지 않는다
      const dims = [...b.matchAll(/dimension="([^"]+)"[^>]*>([^<]*)</g)].map((d) => [d[1].split(":").pop(), d[2].trim().split(":").pop()]);
      ctx.set(m[1], { start, end, dims });
    }
    const facts = (tag) => {
      const res = [];
      for (const m of xml.matchAll(new RegExp(`<us-gaap:${tag}(?=[\\s>])([^>]*)>([^<]+)</us-gaap:${tag}>`, "g"))) {
        const c = ctx.get(/contextRef="([^"]+)"/.exec(m[1])?.[1]);
        if (!c?.start || !c.end) continue;
        const d = (Date.parse(c.end) - Date.parse(c.start)) / 864e5;
        if (d < 300 || d > 400) continue;
        const cls = c.dims.length === 1 && c.dims[0][0] === "StatementClassOfStockAxis" ? c.dims[0][1] : null;
        if (c.dims.length && !cls) continue;
        res.push({ end: c.end, val: Number(m[2]), cls });
      }
      return res;
    };
    const isA = (m) => /classa(member)?$/i.test(m ?? "");
    const eps = facts("EarningsPerShareDiluted"), sh = facts("WeightedAverageNumberOfDilutedSharesOutstanding");
    const epsB = facts("EarningsPerShareBasic"), shB = facts("WeightedAverageNumberOfSharesOutstandingBasic");
    for (const end of new Set([...eps, ...sh, ...epsB].map((e) => e.end))) {
      if (out.has(end)) continue;
      const at = (arr, pred) => arr.find((e) => e.end === end && pred(e));
      const e0 = at(eps, (e) => !e.cls), eA = at(eps, (e) => isA(e.cls)), s0 = at(sh, (e) => !e.cls), sA = at(sh, (e) => isA(e.cls));
      const eB = at(epsB, (e) => !e.cls);
      // 같은 클래스 값이 문맥 ID 만 달리 반복되는 경우 — 클래스당 하나(값이 다르면 판정 보류)
      const byCls = new Map();
      let conflict = false;
      for (const e of shB.filter((x) => x.end === end && x.cls)) {
        if (byCls.has(e.cls) && byCls.get(e.cls) !== e.val) conflict = true;
        byCls.set(e.cls, e.val);
      }
      const filed = r.filingDate[i];
      if (e0 && s0) out.set(end, { eps: e0.val, shares: s0.val, filed, basis: "인스턴스(차원 없음)" });
      // Class A as-converted 는 회사 전체 EPS 가 아예 없는 Visa 형에서만 성립(Alphabet 은 C 가 남는다)
      else if (!e0 && eA && sA) out.set(end, { eps: eA.val, shares: sA.val, filed, asConverted: true, basis: "인스턴스 — Class A EPS × Class A 희석주식수(as-converted)" });
      // 희석 주식수는 클래스끼리 더하면 이중 계산(Class A 희석분에 B 전환분 포함) → 기본 EPS × 기본 주식수 합
      else if (eB && byCls.size && !conflict)
        out.set(end, { eps: eB.val, shares: [...byCls.values()].reduce((t, v) => t + v, 0), filed, basic: true, basis: `인스턴스 — 기본 EPS × 기본 주식수 클래스 합(${[...byCls.keys()].map((k) => k.replace(/Member$/, "")).join("+")})` });
    }
  }
  return out;
}

// ── 외부 정의 차이 원인(R1~R3·R5·R6)용 공시 원본 판독 — 앱 모듈과 별개로 검증기가 직접 읽는다 ───────────────
function parseContexts(xml) {
  const ctx = new Map();
  for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
    const b = m[2];
    ctx.set(m[1], {
      start: /<(?:xbrli:)?startDate>\s*([^<\s]+)/.exec(b)?.[1], end: /<(?:xbrli:)?endDate>\s*([^<\s]+)/.exec(b)?.[1],
      instant: /<(?:xbrli:)?instant>\s*([^<\s]+)/.exec(b)?.[1],
      // 명시 멤버는 멤버명, 유형 멤버(typedMember)는 안쪽 값 — 2026 택사노미의 손익 위치 축(StatementOfIncomeLocationBalanceAxis)은
      // 유형 멤버에 QName(us-gaap:Revenues)을 담는다(GOOG 2026-06 10-Q)
      dims: [...b.matchAll(/dimension="([^"]+)"[^>]*>\s*(?:<[^>/]+>\s*([^<]*?)\s*<\/[^>]+>|([^<]*?))\s*</g)].map((d) => [d[1].split(":").pop(), (d[2] ?? d[3] ?? "").split(":").pop() || "(typed)"]),
    });
  }
  return ctx;
}
/**
 * 기준일(±7일)의 정기공시(10-Q/10-K) 한 건 — 그 날짜 시점값 전부(차원 포함)·라벨·재무상태표 본표 계산 구조.
 * → { form, filed, date, facts: [{ id, dims, v }], labels: Map, kids: Map(부모 → 자식[]), faceIds: Set, roots }
 */
/**
 * 6-K 분기 현금흐름표의 당기·전기 누적 값(원통화) — 앱(edgar-6k.ts, 표 칸 단위 판독)과 다른 방식으로 따로 읽는다(검증 독립성, 2026-10-02):
 * 문서를 글자로 풀어 20-F 라벨(SEC 라벨 파일) 뒤에 붙은 숫자 묶음을 찾는다. 같은 라벨이 여러 번 나오면 pick(숫자 묶음 → bool)으로 하나만
 * (CapEx = 지출이라 음수인 묶음). 열: 숫자 2개 = 당기·전기(머리 연도 순서), 3개 = 주석 번호 + 2개, 4개 = 3개월 2열 + 누적 2열(슬라이드)
 */
async function sixKCfYtd(cik, sub, periodEnd, priorEnd, labels, pick) {
  const rc = sub.filings?.recent ?? {};
  const hi = new Date(Date.parse(periodEnd) + 120 * 864e5).toISOString().slice(0, 10);
  const yC = periodEnd.slice(0, 4), yP = priorEnd.slice(0, 4);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const labRe = labels.filter((l) => l.length > 3).sort((a, b) => b.length - a.length).map((l) => new RegExp(`(?:^|[^a-z])${l.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(esc).join("[^a-z0-9(]*(?:\\([^)]{0,30}\\)[^a-z0-9(]*)?")}[^a-z0-9(—\\-]*((?:[\\s‖]*(?:\\(?[\\d,]+(?:\\.\\d+)?\\)?|—|-)(?![\\d,]))+)`, "g"));
  // 조회 실패는 기록해 두고, 값을 못 찾고 끝나면 던진다(재감사 12차 ⑦ — 실패를 빈 문서로 삼키면 "양쪽 빈칸 — 검증불가"가 됐다)
  const errs = [];
  for (let i = 0; i < (rc.form ?? []).length; i++) {
    if (rc.form[i] !== "6-K" || !(rc.filingDate[i] > periodEnd && rc.filingDate[i] <= hi)) continue;
    const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${rc.accessionNumber[i].replace(/-/g, "")}`;
    const items = (await secJson(base + "/index.json").catch((e) => { errs.push(`${rc.accessionNumber[i]} index: ${String(e).slice(0, 60)}`); return null; }))?.directory.item ?? [];
    for (const d of items.filter((x) => /\.htm$/i.test(x.name) && !/-index/i.test(x.name) && Number(x.size) > 15_000)) {
      const html = await secText(`${base}/${d.name}`).catch((e) => { errs.push(`${rc.accessionNumber[i]} ${d.name}: ${String(e).slice(0, 60)}`); return ""; });
      const text = html.replace(/<\/t[dh]>/gi, " ‖ ").replace(/<\/tr>/gi, "\n").replace(/<[^>]+>/g, " ")
        .replace(/&#8212;|&mdash;/g, "—").replace(/&#160;|&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#8217;|&rsquo;/g, "'").replace(/&#?[a-z0-9]+;/gi, " ").toLowerCase();
      if (!/operating activities/.test(text) || !/cash flows?/.test(text)) continue;
      const unit = /in (?:\S+ )?thousands/.test(text) ? 1e3 : /in (?:\S+ )?millions/.test(text) ? 1e6 : null;
      if (!unit) continue;
      // 현금흐름표 구간만 — 제목("statement(s) of cash flows") 뒤 4천 자 안에 "operating activities" 가 있는 첫 제목 ~ 주석 시작(목차·주석 표의 같은 이름 줄 제외)
      let cs = -1;
      for (const h0 of text.matchAll(/statements? of cash flows?/g)) if (text.slice(h0.index, h0.index + 4_000).includes("operating activities")) { cs = h0.index; break; }
      if (cs < 0) continue;
      const ce0 = text.slice(cs + 200).search(/notes to (?:the )?(?:interim )?(?:condensed )?(?:consolidated|summary)/);
      const cfText = text.slice(cs, ce0 < 0 ? undefined : cs + 200 + ce0);
      for (const re of labRe) {
        const found = [];
        for (const m of cfText.matchAll(re)) {
          let nums = [...m[1].matchAll(/\(?[\d,]+(?:\.\d+)?\)?|—|-/g)].map((x) => (x[0] === "—" || x[0] === "-" ? 0 : (x[0].startsWith("(") ? -1 : 1) * Number(x[0].replace(/[(),]/g, ""))));
          if (nums.length === 3 && Number.isInteger(nums[0]) && nums[0] > 0 && nums[0] < 100 && !/,/.test(m[1].trim().split(/[\s‖]+/)[0])) nums = nums.slice(1);
          if (nums.length !== 2 && nums.length !== 4) continue;
          // 열 순서 — "… months ended <날짜들> … 연도 연도" 머리 중 라벨에 가장 가까운 것(앞뒤 2만 자 — ASML 슬라이드는 머리가 표 중간에 있다)
          const lo0 = Math.max(0, m.index - 20_000), win = cfText.slice(lo0, m.index + 20_000);
          const ys = [...win.matchAll(/months ended[^0-9]{0,200}?(?:[a-z]{3,9}\.? \d{1,2},?[\s‖]*)+[^0-9]{0,80}?(20\d\d)[\s‖]+(20\d\d)/g)]
            .sort((a, b) => Math.abs(lo0 + a.index - m.index) - Math.abs(lo0 + b.index - m.index))[0];
          if (!ys || ![yC, yP].includes(ys[1]) || ![yC, yP].includes(ys[2]) || ys[1] === ys[2]) continue;
          const pair = nums.length === 4 ? nums.slice(2) : nums;
          const cur = ys[1] === yC ? pair[0] : pair[1], prior = ys[1] === yC ? pair[1] : pair[0];
          found.push({ cur: cur * unit, prior: prior * unit, src: `${rc.accessionNumber[i]} ${d.name}` });
        }
        const uniq = [...new Map(found.map((f) => [`${f.cur}|${f.prior}`, f])).values()].filter((f) => !pick || pick(f));
        if (uniq.length === 1) return uniq[0];
        if (uniq.length > 1) return { ambiguous: uniq.length, src: `${rc.accessionNumber[i]} ${d.name}` };
      }
    }
  }
  if (errs.length) throw new Error(`6-K 조회 실패 — ${errs.join(" · ")}`);
  return null;
}

const sixKDocCache = new Map();
/** 6-K 문서(앱 기록의 report = "6-K 접수번호 문서") → 소문자 글자(표 칸 ‖, 줄 바꿈 \n) */
async function sixKDocText(cik, report) {
  const m = /^6-K (\S+) (\S+)$/.exec(report ?? "");
  if (!m) return null;
  const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${m[1].replace(/-/g, "")}/${m[2]}`;
  if (!sixKDocCache.has(url)) {
    // 조회 실패는 던진다(캐시하지 않음 — 재감사 12차 ④: 빈 문서로 삼키면 "줄 없음"과 구분되지 않았다)
    const html = await secText(url);
    // 슬라이드 그림(<img>)마다 구분표(§§) — 슬라이드 형식 문서는 슬라이드 단위로 재무제표 종류를 가른다
    sixKDocCache.set(url, html.replace(/<img\b/gi, " §§ <img").replace(/<\/t[dh]>/gi, " ‖ ").replace(/<\/tr>/gi, "\n").replace(/<[^>]+>/g, " ")
      .replace(/&#8212;|&mdash;/g, "—").replace(/&#160;|&nbsp;|\u00a0/g, " ").replace(/&amp;/g, "&").replace(/&#8217;|&rsquo;/g, "'").replace(/&#?[a-z0-9]+;/gi, " ").toLowerCase());
  }
  return sixKDocCache.get(url) || null;
}
const SIXK_MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** 분기말 표기(6월 28일 등)를 달 말로 — 24일 이후 그달 말, 7일 이전 전달 말 */
const sixKSnap = (y, mo, d) => (d >= 24 ? new Date(Date.UTC(y, mo + 1, 0)) : d <= 7 ? new Date(Date.UTC(y, mo, 0)) : new Date(Date.UTC(y, mo, d))).toISOString().slice(0, 10);
/** 재무상태표 열 머리(날짜 여럿) 위치·날짜 — "june 30, 2026 ‖ december 31, 2025" 형 / "jun 29, dec 31, (…) 2025 2025" 형(슬라이드) */
function sixKBsHeaders(text) {
  const out = [];
  // 날짜 사이 공백이 여러 칸일 수 있다("june 30,    2026" — TSM 주석 표)
  for (const m of text.matchAll(/((?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}[\s‖]*){2,})/g)) {
    const ds = [...m[1].matchAll(/([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/g)].map((x) => sixKSnap(Number(x[3]), SIXK_MON.indexOf(x[1]), Number(x[2])));
    if (ds.length >= 2 && !ds.some((d) => d.includes("NaN"))) out.push({ i: m.index, dates: ds });
  }
  for (const m of text.matchAll(/((?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},\s*){2,})\s*\([^)]*\)\s*((?:(?:19|20)\d{2}\s+){2,})/g)) {
    const md = [...m[1].matchAll(/([a-z]{3})[a-z]*\.?\s+(\d{1,2}),/g)], ys = m[2].trim().split(/\s+/).map(Number);
    if (md.length === ys.length) out.push({ i: m.index, dates: md.map((x, k) => sixKSnap(ys[k], SIXK_MON.indexOf(x[1]), Number(x[2]))) });
  }
  return out.sort((a, b) => a.i - b.i);
}
/** 라벨 뒤 숫자 묶음 — 같은 라벨의 모든 출현. 단어 사이 괄호 삽입구 하나 허용("provided by (used in)") */
function sixKRows(text, labels) {
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out = [];
  // 현금흐름 합계 줄 표현 차이 — 20-F "Net cash used in investing activities" ↔ 분기 "Net cash provided by (used in) investing activities"(앱 normLabel 과 같은 동치)
  const variants = (l) => {
    const m = /^net cash (?:provided by |used in |\(used in\) |provided by \(used in\) |\(used in\) provided by |used in \(provided by\) )+(.+)$/i.exec(l);
    return m ? [l, `net cash provided by (used in) ${m[1]}`, `net cash used in ${m[1]}`, `net cash provided by ${m[1]}`, `net cash (used in) provided by ${m[1]}`] : [l];
  };
  for (const l of [...new Set(labels.map((x) => x.replace(/&amp;/g, "&").trim()).flatMap(variants))].filter((x) => x.length > 3).sort((a, b) => b.length - a.length)) {
    const words = l.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (!words.length) continue;
    // 단어 사이: 구두점·괄호(괄호 안 단어도 라벨 단어면 그대로 대응 — "(decrease)"), 또는 라벨에 없는 괄호 삽입구 하나("(used in)").
    // 라벨 뒤: 주석 표기("(note 6)")·통화 기호 건너뜀. 숫자 사이: 공백·칸·$
    const re = new RegExp(`(?:^|[^a-z])${words.map(esc).join("[^a-z0-9]*(?:\\([^)]{0,30}\\)[^a-z0-9]*)?")}(?:[^a-z0-9(—\\-]*\\(notes?[^)]{0,20}\\))?[^a-z0-9(—\\-]*((?:[\\s‖$]*(?:\\(?[\\d,]+(?:\\.\\d+)?\\)?|—|-)(?![\\d,]))+)`, "g");
    for (const m of text.matchAll(re)) {
      if (out.some((o) => Math.abs(o.i - m.index) < 5)) continue;
      // 주석 번호 묶음("15, 19" · "7, 8")은 값이 아니다 — 맨 앞에 있으면 뺀다
      const body = m[1].replace(/^([\s‖$]*)\d{1,2}(?:,\s?\d{1,2})+(?=[\s‖])/, "$1");
      const toks = [...body.matchAll(/\(?[\d,]+(?:\.\d+)?\)?|—|-/g)].map((x) => x[0]).filter((t) => /\d/.test(t) || t === "—" || t === "-");
      if (!toks.length) continue;
      out.push({ i: m.index, label: l, toks, nums: toks.map((t) => (t === "—" || t === "-" ? 0 : (t.startsWith("(") ? -1 : 1) * Number(t.replace(/[(),]/g, "")))) });
    }
  }
  return out;
}
/** 문서 단위(천·백만) — 그 위치 앞에서 가장 가까운 "in thousands/millions" */
function sixKUnitAt(text, i) {
  const head = text.slice(Math.max(0, i - 60_000), i);
  const t = head.lastIndexOf("thousands"), mn = head.lastIndexOf("millions");
  if (t < 0 && mn < 0) { const any = /in (?:\S+ )?(thousands|millions)/.exec(text); return any ? (any[1] === "thousands" ? 1e3 : 1e6) : null; }
  return t > mn ? 1e3 : 1e6;
}
/** 재무상태표 행 → 열 값(머리 날짜 순). 값 개수 = 열 수(그대로) / 2배(금액·비율 쌍 — 짝수 자리) / 열 수 + 1(주석 번호 열 — 첫 값 뺌) */
function sixKBsCols(row, hd) {
  const n = hd.dates.length, v = row.nums;
  if (v.length === n) return v;
  if (v.length === 2 * n) return v.filter((_, k) => k % 2 === 0);
  if (v.length === n + 1 && Number.isInteger(v[0]) && v[0] > 0 && v[0] < 100 && !/,/.test(row.toks[0])) return v.slice(1);
  return null;
}

async function filingAtDate(cik, sub, date) {
  const rc = sub.filings?.recent ?? {};
  const k = (rc.form ?? []).findIndex((fm, i) => /^(10-[QK]|20-F|40-F)$/.test(fm) && rc.reportDate?.[i] && dayDiff(rc.reportDate[i], date) <= 7);
  if (k < 0) return null;
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${rc.accessionNumber[k].replace(/-/g, "")}`;
  const names = (await secJson(base + "/index.json")).directory.item.map((x) => x.name);
  const xsd = names.find((x) => /\.xsd$/i.test(x));
  const calName = names.find((x) => /_cal\.xml$/i.test(x)) ?? xsd, labName = names.find((x) => /_lab\.xml$/i.test(x)) ?? xsd;
  const instName = names.find((x) => /_htm\.xml$/i.test(x));
  if (!instName || !calName) return null;
  const xml = await secText(`${base}/${instName}`);
  const ctx = parseContexts(xml);
  const facts = [], durFacts = [];
  for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*?)contextRef="([^"]+)"([^>]*)>\s*(-?[\d.]+)\s*</g)) {
    const c = ctx.get(m[4]);
    const unit = /unitRef="([^"]+)"/.exec(`${m[3]} ${m[5]}`)?.[1] ?? "";
    if (c?.start && c.end && dayDiff(c.end, rc.reportDate[k]) <= 1) { durFacts.push({ id: `${m[1]}_${m[2]}`, dims: c.dims, start: c.start, end: c.end, v: Number(m[6]), unit }); continue; }
    if (!c?.instant || dayDiff(c.instant, rc.reportDate[k]) > 1) continue;
    facts.push({ id: `${m[1]}_${m[2]}`, dims: c.dims, v: Number(m[6]), unit });
  }
  const cal = await secText(`${base}/${calName}`);
  const lab = labName === calName ? cal : await secText(`${base}/${labName}`);
  const locMap = (x) => { const r = new Map(); for (const l of x.matchAll(/<link:loc\b([^>]*)\/?>/g)) { const id = /xlink:label="([^"]+)"/.exec(l[1])?.[1], h = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1]; if (id && h) r.set(id, h); } return r; };
  const labels = new Map(), negLabels = new Map();
  { const loc = locMap(lab), text = new Map(), negText = new Map();
    for (const m of lab.matchAll(/<link:label\b([^>]*)>([^<]*)<\/link:label>/g)) {
      const id = /xlink:label="([^"]+)"/.exec(m[1])?.[1];
      if (!id || /documentation/i.test(m[1])) continue;
      text.set(id, [...(text.get(id) ?? []), m[2].trim()]);
      // 부호 반전 역할(negatedLabel 계열) — 보고서 표시값 = −XBRL 값(6-K 대조의 부호 판정, 2026-10-02)
      if (/role="[^"]*\/negated/i.test(m[1])) negText.set(id, [...(negText.get(id) ?? []), m[2].trim()]);
    }
    for (const a of lab.matchAll(/<link:labelArc\b([^>]*)\/?>/g)) {
      const f = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? ""), to = /xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "", t = text.get(to);
      if (f && t) labels.set(f, [...(labels.get(f) ?? []), ...t]);
      if (f && negText.get(to)) negLabels.set(f, [...(negLabels.get(f) ?? []), ...negText.get(to)]);
    } }
  const kids = new Map(), faceIds = new Set(), hasParent = new Set();
  for (const m of cal.matchAll(/<link:calculationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/link:calculationLink>/g)) {
    const role = m[1].split("/").pop() ?? "";
    if (!/BALANCESHEET|FINANCIALPOSITION|FINANCIALCONDITION/i.test(role) || /Parenth|Detail|Table|Polic/i.test(role)) continue;
    const loc = locMap(m[2]);
    for (const a of m[2].matchAll(/<link:calculationArc\b([^>]*)\/?>/g)) {
      const fr = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? ""), to = loc.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
      if (!fr || !to) continue;
      kids.set(fr, [...(kids.get(fr) ?? []), to]); faceIds.add(fr); faceIds.add(to); hasParent.add(to);
    }
  }
  return { form: rc.form[k], filed: rc.filingDate[k], date: rc.reportDate[k], facts, durFacts, labels, negLabels, kids, faceIds, roots: [...faceIds].filter((x) => !hasParent.has(x)) };
}
/**
 * 재무상태표 본표 차입금·리스 줄 — 검증기 독립 판정(개념명·라벨 규칙, 앱과 같은 성격의 규칙이라 공통모드). 차입금 성격 노드를 만나면
 * 그 아래로 내려가지 않는다(소계·하위 줄 이중 합산 방지). IFRS(ifrs-full·회사 고유)는 리스부채를 차입금에 포함(CLAUDE.md 한국·IFRS 규칙).
 * → { faceVals: [{ id, v }], faceSum, val0, nm, lab }
 */
function faceDebtLines(fl, unitRe = /usd/i) {
  const lab = (id) => (fl.labels.get(id) ?? []).join(" | ");
  const nm = (id) => id.replace(/^[a-z0-9-]+_/, "");
  // 단위 지정 — 20-F 는 원통화와 USD 편의 환산값이 같은 개념에 나란히 있다(TSM)
  const val0 = (id) => fl.facts.find((x) => x.id === id && !x.dims.length && unitRe.test(x.unit ?? ""))?.v ?? null;
  const STD = /Debt|Borrowing|Bonds?Issued|BondsPayable|NotesPayable|CommercialPaper|LinesOfCredit|LineOfCredit|FinanceLease|CapitalLease|OperatingLeaseLiabilit|LeaseLiabilit|ConvertibleNotes|SeniorNotes|LoansPayable|NotesAndLoans|ShortTermNonBankLoans|FinancingObligation/;
  const CUS = /debt|borrowing|bonds payable|notes payable|commercial paper|lease liabilit|lease obligation|finance lease|capital lease|financing obligation/i;
  const EXC = /Interest|Accrued|Derivative|Asset|Receivable|Securit|Investment|Tax|Unamortized|Issuance|Discount|Premium/i;
  const isDebt = (id) => { const std = id.startsWith("us-gaap_"); return std ? STD.test(nm(id)) && !EXC.test(nm(id)) : (CUS.test(lab(id)) || STD.test(nm(id))) && !EXC.test(`${nm(id)} ${lab(id)}`); };
  const lines = [], seen = new Set();
  const walk = (id, d) => { if (d > 8 || seen.has(id)) return; seen.add(id); if (isDebt(id)) { lines.push(id); return; } for (const k of fl.kids.get(id) ?? []) walk(k, d + 1); };
  for (const r0 of fl.roots) walk(r0, 0);
  const faceVals = lines.map((id) => ({ id, v: val0(id) })).filter((x) => x.v != null);
  return { faceVals, faceSum: faceVals.reduce((t, x) => t + x.v, 0), val0, nm, lab };
}
/**
 * 20-F 총차입금 기대값(오너 결정 "원칙 유지" 2026-09-25 — 앱 규칙의 재구현, 공통모드):
 *  본표 차입금 줄 + 리스. IFRS 는 리스 전액 — 본표에 유동·비유동 리스 중 한쪽만 있으면 없는 쪽을 주석값으로 더하고, 본표에 리스 줄이
 *  없으면 주석 리스 전액을 더한다. 단 본표 차입금 줄 라벨이 리스를 포함한다고 밝히면(NVO) 더하지 않는다. US-GAAP 20-F(ASML)는 미국
 *  규칙 ③과 같이 본표에 금융리스 줄이 없으면 주석 금융리스만 더한다(운용리스 제외). 본표에 차입금 줄이 아예 없으면(SAP — 금융부채
 *  합산 줄) 태그 폴백: ifrs Borrowings + LeaseLiabilities.
 * → { sum, parts: [{ what, id, v, kind }], face } | null   kind: face | curLease | nonLease | lease | finLease | fallback
 */
function expectedForeignDebt(fl, unitRe) {
  const fd = faceDebtLines(fl, unitRe);
  const v0 = (id) => fl.facts.find((x) => x.id === id && !x.dims.length && unitRe.test(x.unit ?? ""))?.v ?? null;
  const ifrs = fl.facts.some((x) => x.id.startsWith("ifrs-full_"));
  const parts = fd.faceVals.map((x) => ({ what: "본표", id: x.id, v: x.v, kind: "face" }));
  const has = (re) => fd.faceVals.some((x) => re.test(fd.nm(x.id)));
  if (!fd.faceVals.length) {
    if (!ifrs) return null;
    const b = v0("ifrs-full_Borrowings"), l = v0("ifrs-full_LeaseLiabilities");
    if (b == null) return null;
    parts.push({ what: "태그 폴백(본표 차입금 줄 없음)", id: "ifrs-full_Borrowings", v: b, kind: "fallback" });
    if (l != null) parts.push({ what: "태그 폴백 리스", id: "ifrs-full_LeaseLiabilities", v: l, kind: "lease" });
  } else if (ifrs) {
    // 리스가 차입금 줄 안에 표시되는지 — 본표 차입금 줄 라벨이 리스를 밝히거나, 회사가 리스·차입금을 한 개념으로 공시(NVO
    // nvo:LeaseAndBorrowingUndiscountedCashFlow — 차입금 만기표에 리스를 합쳐 공시)
    const combo = fl.facts.find((x) => !x.dims.length && /LeaseAndBorrowing|BorrowingsAndLease|BorrowingsIncludingLease|LeaseLiabilitiesAndBorrowings/i.test(x.id));
    const leaseInDebt = fd.faceVals.some((x) => /lease/i.test(fd.lab(x.id)) && !/LeaseLiabilit/.test(fd.nm(x.id))) || !!combo;
    if (leaseInDebt) parts.push({ what: `리스는 차입금 줄 안에 포함(${combo ? combo.id.replace(/^[a-z0-9-]+_/, "") : "본표 라벨"}) — 가산 안 함`, id: "-", v: 0, kind: "note" });
    const cur = has(/^CurrentLeaseLiabilities$/), non = has(/^NoncurrentLeaseLiabilities$/), tot = has(/^LeaseLiabilities$/);
    if (!leaseInDebt && !tot) {
      if (cur && !non) { const x = v0("ifrs-full_NoncurrentLeaseLiabilities"); if (x != null) parts.push({ what: "주석 비유동 리스", id: "ifrs-full_NoncurrentLeaseLiabilities", v: x, kind: "nonLease" }); }
      else if (non && !cur) { const x = v0("ifrs-full_CurrentLeaseLiabilities"); if (x != null) parts.push({ what: "주석 유동 리스", id: "ifrs-full_CurrentLeaseLiabilities", v: x, kind: "curLease" }); }
      else if (!cur && !non) { const x = v0("ifrs-full_LeaseLiabilities"); if (x != null) parts.push({ what: "주석 리스 전액", id: "ifrs-full_LeaseLiabilities", v: x, kind: "lease" }); }
    }
  } else if (!has(/FinanceLease|CapitalLease/)) {
    const c = v0("us-gaap_FinanceLeaseLiabilityCurrent"), n = v0("us-gaap_FinanceLeaseLiabilityNoncurrent"), t = v0("us-gaap_FinanceLeaseLiability");
    if (c != null || n != null) { if (c != null) parts.push({ what: "주석 금융리스(유동)", id: "us-gaap_FinanceLeaseLiabilityCurrent", v: c, kind: "finLease" }); if (n != null) parts.push({ what: "주석 금융리스(비유동)", id: "us-gaap_FinanceLeaseLiabilityNoncurrent", v: n, kind: "finLease" }); }
    else if (t != null) parts.push({ what: "주석 금융리스", id: "us-gaap_FinanceLeaseLiability", v: t, kind: "finLease" });
  }
  return { sum: parts.reduce((t, x) => t + x.v, 0), parts, face: fd, v0 };
}
/**
 * 최근 10-K 인스턴스들의 연간(300일 초과) 매출 사실(차원 포함) — 먼저 읽은(최신) 공시 우선. [{ id, start, end, dims, v }]
 * 매출 줄에 인식된 파생상품 손익(현금흐름위험회피 재분류·비지정 파생상품 — 손익계산서 위치 차원)도 함께 읽는다(R8 확장).
 * 파생상품 표는 2~3개 연도만 싣고 옛 연도는 그 해 10-K 에만 있다(LRCX FY2022·CAT 2021) → `ends` 결산일의 10-K 는 최근 3건 밖이어도 읽는다.
 */
const REV_HEDGE_TAGS = "OtherComprehensiveIncomeLossCashFlowHedgeGainLossReclassificationBeforeTax|DerivativeInstrumentsGainLossReclassifiedFromAccumulatedOCIIntoIncomeEffectivePortionNet|DerivativeGainLossOnDerivativeNet|GainLossOnDerivativeInstrumentsNetPretax";
// 매출 줄에 인식된 파생상품 손익 성분(R8 확장) — 손익 위치 축(명시 멤버 또는 2026 택사노미 유형 멤버 QName)이 매출·판매인 사실만
const LOC_AXES = ["IncomeStatementLocationAxis", "StatementOfIncomeLocationBalanceAxis"];
const HEDGE_REL = "DerivativeInstrumentsGainLossByHedgingRelationshipAxis", HEDGE_DES = "HedgingDesignationAxis";
const revLoc = (ds) => ds.some((d) => LOC_AXES.includes(d[0]) && /Revenue|Sales/i.test(d[1]) && !/Cost|Expense/i.test(d[1]));
const DERIV_FAM = {
  cf: { ids: ["OtherComprehensiveIncomeLossCashFlowHedgeGainLossReclassificationBeforeTax", "DerivativeInstrumentsGainLossReclassifiedFromAccumulatedOCIIntoIncomeEffectivePortionNet"], pred: () => true },
  nd: { ids: ["DerivativeGainLossOnDerivativeNet", "GainLossOnDerivativeInstrumentsNetPretax"], pred: (ds) => !ds.some((d) => d[0] === HEDGE_REL) && !ds.some((d) => d[0] === HEDGE_DES && /^Designated/i.test(d[1])) },
};
/** 같은 기간 사실 중 분해 차원(위치·관계·지정 제외)이 같은 것은 하나만 — 차원 없는 합계가 있으면 그것, 없으면 멤버 합 */
function aggDeriv(facts) {
  const byKey = new Map();
  for (const x of facts) { const k = x.dims.filter((d) => ![...LOC_AXES, HEDGE_REL, HEDGE_DES].includes(d[0])).map((d) => d.join("=")).sort().join("|"); if (!byKey.has(k)) byKey.set(k, x.v); }
  return byKey.has("") ? byKey.get("") : [...byKey.values()].reduce((t, y) => t + y, 0);
}
/**
 * 한 기간의 사실들(facts, 공시 순번 fi 포함) → 성분 선택지 [{ id, v }]. 성분마다 공시 한 건의 사실만 합친다(공시마다 차원 구성이 달라
 * 섞으면 두 번 더해진다). 공시별 값은 각각 선택지 — 나중 10-K 가 같은 기간을 0.1B 단위로 다시 공시하는 경우(XOM 2024 −661 → −700)
 * 정밀값 공시로도 대조(반올림값 허용이 아니라 정밀값 공시를 찾아 쓰는 것)
 */
function revDerivFamily(facts, kind) {
  const { ids, pred } = DERIV_FAM[kind];
  for (const id of ids) {
    const fs = facts.filter((x) => x.id === id && revLoc(x.dims) && pred(x.dims));
    if (!fs.length) continue;
    return [...new Set(fs.map((x) => x.fi))].map((fi) => ({ id, v: aggDeriv(fs.filter((x) => x.fi === fi)) })).filter((o, i, a) => o.v !== 0 && a.findIndex((p) => p.v === o.v) === i);
  }
  return [];
}
async function annualRevenueDimFacts(cik, sub, maxFilings = 3, ends = []) {
  const rc = sub.filings?.recent ?? {};
  const out = [], seen = new Set();
  let n = 0;
  for (let i = 0; i < (rc.form ?? []).length; i++) {
    if (rc.form[i] !== "10-K") continue;
    n++;
    if (n > maxFilings && !ends.some((e) => rc.reportDate?.[i] && dayDiff(rc.reportDate[i], e) <= 7)) continue;
    const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${rc.accessionNumber[i].replace(/-/g, "")}`;
    const name = (await secJson(base + "/index.json")).directory.item.map((x) => x.name).find((x) => /_htm\.xml$/i.test(x));
    if (!name) continue;
    const xml = await secInstance(`${base}/${name}`);
    const ctx = parseContexts(xml);
    for (const m of xml.matchAll(new RegExp(String.raw`<us-gaap:(Revenues|RevenueFromContractWithCustomerExcludingAssessedTax|${REV_HEDGE_TAGS})\b([^>]*?)contextRef="([^"]+)"([^>]*)>\s*(-?[\d.]+)\s*<`, "g"))) {
      const c = ctx.get(m[3]);
      if (!c?.start || !c.end || (Date.parse(c.end) - Date.parse(c.start)) / 864e5 < 300) continue;
      // 파생상품 사실은 공시별로 남긴다 — 나중 10-K 가 같은 기간을 0.1B 단위로 다시 공시하기도 해서(XOM 2023: 986 → 1,000) 공시마다 따로 대조
      const key = `${m[1]}|${c.start}|${c.end}|${c.dims.flat().join(",")}${/^(Revenues|RevenueFromContract)/.test(m[1]) ? "" : `|${n}`}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: m[1], start: c.start, end: c.end, dims: c.dims, v: Number(m[5]), fi: n });
    }
  }
  return out;
}

// ── 매출 A층 — 손익계산서 본표 구조(_pre 표시 순서 + _cal 계산 관계)에서 매출 줄을 검증기가 직접 판독(revenue.md §6, 2026-09-25) ──
// 태그 우선순위로 고르지 않는다. 공시마다: 손익계산서 역할의 표시 순서에서 매출 성격 줄 중 계산 구조상 다른 매출 줄의 하위가 아닌
// **첫 줄**(= 총매출 줄)을 고른다. 값은 그 줄을 공시한 가장 최근 정기공시 기준(최신 판본 — companyfacts 전 판본 중 최신, 반올림 재태깅 제외).
// 영업이익 태그가 없는 회사(XOM 형)는 총매출 줄의 비영업 성분(지분법·기타수익 — 제품·서비스 차원 멤버 또는 계산 하위 줄)을 뺀다
// (앱 규칙 재구현 — 공통모드 표기). 앱 모듈(src/lib/fin/**)은 import 하지 않는다(설계 §8 S3).
const REV_STD_RE = /^us-gaap_(Revenues?(?:[A-Z]\w*)?|SalesRevenue\w*|RegulatedAndUnregulatedOperatingRevenue)$/;
const REV_EXCL_RE = /Abstract$|Member$|Axis$|Domain$|Table$|LineItems$|Remaining|Deferred|Unbilled|Receivable|Percent|PerformanceObligation|Cost|Backlog|IncreaseDecrease|GainLoss|NotYet/;
const REV_LABEL_RE = /\b(revenues?|net sales|sales)\b/i;
const REV_LABEL_EXCL = /cost|expense|provision|after|deferred|unearned|per share|receivable|percent/i;
const NONOP_KID_RE = /EquityMethod|EquityAffiliat|EquityInEarnings|IncomeFromEquity|NonoperatingIncome|OtherNonoperating|OtherIncome|InvestmentIncome/i;
const NONOP_MEMBER_RE = /EquityAffiliate|EquityMethod|EquityCompan|^(OtherRevenueMember|OtherIncomeMember)$/i;
function xbrlLinks(xml, kind) {
  const out = [];
  // 빈 링크(자기 닫힘 — Workiva `<link:calculationLink … />`)를 지운다 — 남기면 다음 역할의 호가 빈 역할 이름으로 읽힌다(재감사 2026-09-25)
  xml = xml.replace(new RegExp(`<(?:link:)?${kind}Link\\b[^>]*\\/>`, "g"), "");
  // 접두어 없는 링크베이스(2019 이전 Donnelley ActiveDisclosure — 기본 네임스페이스 <presentationLink>)도 읽는다(재감사 2026-09-25 — TSLA 2017~2019 10-K)
  for (const m of xml.matchAll(new RegExp(`<(?:link:)?${kind}Link\\b[^>]*xlink:role="([^"]+)"[^>]*>([\\s\\S]*?)<\\/(?:link:)?${kind}Link>`, "g"))) {
    const loc = new Map();
    for (const l of m[2].matchAll(/<(?:link:)?loc\b([^>]*)\/?>/g)) { const id = /xlink:label="([^"]+)"/.exec(l[1])?.[1], h = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1]; if (id && h) loc.set(id, h); }
    const arcs = [];
    for (const a of m[2].matchAll(new RegExp(`<(?:link:)?${kind}Arc\\b([^>]*)\\/?>`, "g"))) {
      const fr = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? ""), to = loc.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
      // pl = 표시 구조 preferredLabel(판관비 판독 — 그 공시가 본표에 쓴 라벨 역할)
      if (fr && to) arcs.push({ fr, to, order: Number(/\border="([^"]+)"/.exec(a[1])?.[1] ?? 0), w: Number(/\bweight="([^"]+)"/.exec(a[1])?.[1] ?? 1), pl: /\bpreferredLabel="([^"]+)"/.exec(a[1])?.[1] ?? null });
    }
    out.push({ role: m[1].split("/").pop() ?? "", arcs });
  }
  return out;
}
function xbrlLabels(lab) {
  const loc = new Map(), text = new Map(), labels = new Map();
  for (const l of lab.matchAll(/<(?:link:)?loc\b([^>]*)\/?>/g)) { const id = /xlink:label="([^"]+)"/.exec(l[1])?.[1], h = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1]; if (id && h) loc.set(id, h); }
  for (const m of lab.matchAll(/<(?:link:)?label\b([^>]*)>([^<]*)<\/(?:link:)?label>/g)) { const id = /xlink:label="([^"]+)"/.exec(m[1])?.[1]; if (id && !/documentation/i.test(m[1])) text.set(id, [...(text.get(id) ?? []), m[2].trim()]); }
  for (const a of lab.matchAll(/<(?:link:)?labelArc\b([^>]*)\/?>/g)) { const f = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? ""), t = text.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? ""); if (f && t) labels.set(f, [...(labels.get(f) ?? []), ...t]); }
  return labels;
}
/** 공시 한 건의 손익계산서 총매출 줄 → { role, concept, label, nonopKids, nonopMembers, instUrl } | null */
async function faceRevenueLine(cik, accn) {
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn.replace(/-/g, "")}`;
  // 목록·링크베이스는 매출원가 판독(faceCogsLine)과 같은 파일이라 공용 캐시(secTextC)로 받는다
  const names = await filingNames(base);
  const xsd = names.find((x) => /\.xsd$/i.test(x));
  const preN = names.find((x) => /_pre\.xml$/i.test(x)) ?? xsd, calN = names.find((x) => /_cal\.xml$/i.test(x)) ?? xsd, labN = names.find((x) => /_lab\.xml$/i.test(x)) ?? xsd;
  // 인스턴스 — 인라인 XBRL 추출본(_htm.xml), 없으면(2019 이전 비인라인 공시) 링크베이스·요약이 아닌 .xml
  const instN = names.find((x) => /_htm\.xml$/i.test(x)) ?? names.find((x) => /\.xml$/i.test(x) && !/_(pre|cal|def|lab)\.xml$|FilingSummary|^R\d+\.xml$/i.test(x));
  if (!preN || !calN) return null;
  const get = (n) => secTextC(`${base}/${n}`);
  const pres = xbrlLinks(await get(preN), "presentation"), cals = xbrlLinks(await get(calN), "calculation");
  let labels = null;
  const labelOf = async (id) => { labels ??= labN ? xbrlLabels(await get(labN)) : new Map(); return (labels.get(id) ?? []).join(" | "); };
  const isRev = async (id) => {
    if (REV_EXCL_RE.test(id)) return false;
    if (id.startsWith("us-gaap_")) return REV_STD_RE.test(id);
    if (/^(dei|srt|country|currency|ecd)_/.test(id)) return false;
    const l = await labelOf(id);
    return REV_LABEL_RE.test(l) && !REV_LABEL_EXCL.test(l);
  };
  const isRole = (r) => /INCOME|OPERATIONS|EARNINGS/i.test(r) && !/Parenth|Detail|Table|Polic|Tax|Segment|PerShare|Narrative|Schedule/i.test(r);
  // 포괄손익 단독 역할은 뒤로(손익·포괄손익 결합 보고서만 있는 회사는 그 역할을 쓴다)
  const roles = pres.filter((p) => isRole(p.role)).sort((a, b) => Number(/Comprehensive/i.test(a.role)) - Number(/Comprehensive/i.test(b.role)));
  for (const p of roles) {
    const kids = new Map(), hasP = new Set();
    for (const a of p.arcs) { kids.set(a.fr, [...(kids.get(a.fr) ?? []), a]); hasP.add(a.to); }
    const order = [], members = [];
    const walk = (id, d, axis) => {
      if (d > 14) return;
      order.push(id);
      if (axis && /Member$/.test(id)) members.push({ axis, id });
      for (const a of (kids.get(id) ?? []).sort((x, y) => x.order - y.order)) walk(a.to, d + 1, /Axis$/.test(id) ? id : axis);
    };
    for (const r of [...new Set(p.arcs.map((a) => a.fr))].filter((x) => !hasP.has(x))) walk(r, 0, null);
    const cands = [];
    for (const id of order) if (!cands.includes(id) && (await isRev(id))) cands.push(id);
    if (!cands.length) continue;
    const calArcs = cals.find((c) => c.role === p.role)?.arcs ?? cals.filter((c) => isRole(c.role)).flatMap((c) => c.arcs);
    const up = new Map();
    for (const a of calArcs) up.set(a.to, [...(up.get(a.to) ?? []), a.fr]);
    const underRev = (id) => { const seen = new Set(), st = [...(up.get(id) ?? [])]; while (st.length) { const x = st.pop(); if (seen.has(x)) continue; seen.add(x); if (cands.includes(x)) return true; st.push(...(up.get(x) ?? [])); } return false; };
    const top = cands.find((id) => !underRev(id));
    if (!top) continue;
    return {
      role: p.role, concept: top, label: top.startsWith("us-gaap_") ? top.slice(8) : `${top}("${(await labelOf(top)).split(" | ")[0]}")`,
      nonopKids: calArcs.filter((a) => a.fr === top && NONOP_KID_RE.test(a.to.replace(/^[a-z0-9-]+_/, ""))).map((a) => ({ id: a.to, w: a.w })),
      nonopMembers: members.filter((m) => /ProductOrServiceAxis$/.test(m.axis) && NONOP_MEMBER_RE.test(m.id.replace(/^[a-z0-9-]+_/, ""))).map((m) => m.id.replace(/^[a-z0-9-]+_/, "")),
      // 본표 매출 하위 줄 — 계산 구조의 직접 하위(가중치 포함)와 표시 구조의 제품·서비스 차원 멤버(R9 하위 줄 합 대조용)
      kids: calArcs.filter((a) => a.fr === top).map((a) => ({ id: a.to, w: a.w })),
      psMembers: [...new Set(members.filter((m) => /ProductOrServiceAxis$/.test(m.axis)).map((m) => m.id.replace(/^[a-z0-9-]+_/, "")))],
      instUrl: instN ? `${base}/${instN}` : null,
    };
  }
  return null;
}
/** 공시 원본(인스턴스)의 총매출 줄 값 — 비영업 분리면 총액 − 비영업 성분(기간별). [{ start, end, val, nonop }] */
async function faceInstanceRevenue(face, split) {
  const xml = await secInstance(face.instUrl);
  const ctx = parseContexts(xml);
  const want = new Set([face.concept, ...face.nonopKids.map((k) => k.id)]);
  const tot = new Map(), parts = new Map();
  // 비영업 분리 회사가 영업 매출 줄을 제품·서비스 차원 멤버로 직접 태깅한 값(XOM SalesAndOtherOperatingRevenueMember) — 분리값의 독립 확인용
  const tagged = new Map();
  for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*?)contextRef="([^"]+)"([^>]*)>\s*(-?[\d.]+)\s*</g)) {
    const id = `${m[1]}_${m[2]}`;
    if (!want.has(id) || !/unitRef="[^"]*usd/i.test(`${m[3]} ${m[5]}`)) continue;
    const c = ctx.get(m[4]);
    if (!c?.start || !c.end) continue;
    const k = `${c.start}|${c.end}`, v = Number(m[6]);
    if (id === face.concept && !c.dims.length) { if (!tot.has(k)) tot.set(k, v); continue; }
    if (!split) continue;
    if (id === face.concept && c.dims.length === 1 && /ProductOrServiceAxis$/.test(c.dims[0][0]) && !face.nonopMembers.includes(c.dims[0][1]))
      tagged.set(k, [...(tagged.get(k) ?? []), { member: c.dims[0][1], v }]);
    let pk = null, pv = v;
    if (id === face.concept && c.dims.length === 1 && /ProductOrServiceAxis$/.test(c.dims[0][0]) && face.nonopMembers.includes(c.dims[0][1])) pk = c.dims[0][1];
    else if (id !== face.concept && !c.dims.length) { pk = id; pv = v * (face.nonopKids.find((x) => x.id === id)?.w ?? 1); }
    if (pk) { const mp = parts.get(k) ?? new Map(); if (!mp.has(pk)) mp.set(pk, pv); parts.set(k, mp); }
  }
  const out = [];
  for (const [k, t] of tot) {
    const [start, end] = k.split("|");
    const mp = parts.get(k);
    if (split && !mp?.size) continue; // 비영업 성분을 못 찾은 기간은 기대값을 만들지 않는다(총액을 그대로 쓰지 않음)
    const nonop = split ? [...mp.values()].reduce((a, b) => a + b, 0) : 0;
    out.push({ start, end, val: t - nonop, nonop: split ? [...mp].map(([id, v]) => `${id.replace(/^[a-z0-9-]+_/, "")} ${v}`).join(" + ") : "", tagged: tagged.get(k) ?? [] });
  }
  return out;
}
/** 인스턴스의 USD 수치 사실 [{ id, start, end, dims, v }] — want(개념 id 집합)만 */
function usdFacts(xml, want) {
  const ctx = parseContexts(xml), out = [];
  for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*?)contextRef="([^"]+)"([^>]*)>\s*(-?[\d.]+)\s*</g)) {
    const id = `${m[1]}_${m[2]}`;
    if (!want(id) || !/unitRef="[^"]*usd/i.test(`${m[3]} ${m[5]}`)) continue;
    const c = ctx.get(m[4]);
    // dec = XBRL decimals(−8 = 1억 단위 반올림 공시 — 문장 속 반올림값)
    if (c?.start && c.end) out.push({ id, start: c.start, end: c.end, dims: c.dims, v: Number(m[6]), dec: /decimals="([^"]+)"/.exec(`${m[3]} ${m[5]}`)?.[1] ?? null });
  }
  return out;
}
/**
 * R9 본표 매출 하위 줄 합 — 10-K(최신부터)마다 연간 기간별 합계 줄과 하위 줄 합: 계산 구조의 직접 하위(가중치) 합, 표시 구조의
 * 제품·서비스 차원 멤버 합. 기간마다 그 기간을 담은 가장 최근 10-K 한 건만. 하위 합이 합계 줄과 반올림 차(줄 수 × 백만/2) 안일 때만
 * (하위 줄이 합계를 이루는 구조임을 확인). → Map(결산일 → { src, total, sums: [[설명, 값]] })
 */
async function faceRevenueParts(faces) {
  const out = new Map();
  for (const f of faces.filter((x) => x.form === "10-K" && !x.any && x.instUrl)) {
    const kidIds = new Set((f.kids ?? []).map((k) => k.id));
    const facts = usdFacts(await secInstance(f.instUrl), (id) => id === f.concept || kidIds.has(id));
    const dd = (x) => (Date.parse(x.end) - Date.parse(x.start)) / 864e5;
    for (const t of facts.filter((x) => x.id === f.concept && !x.dims.length && dd(x) >= 300 && dd(x) <= 400)) {
      if ([...out.keys()].some((e) => dayDiff(e, t.end) <= 7)) continue;
      const same = (x) => x.start === t.start && x.end === t.end;
      const sums = [];
      const kv = (f.kids ?? []).map((k) => ({ ...k, x: facts.find((x) => x.id === k.id && !x.dims.length && same(x)) }));
      if (kv.length >= 2 && kv.every((k) => k.x)) sums.push([`계산 하위 줄 ${kv.map((k) => `${k.id.replace(/^[a-z0-9-]+_/, "")} ${k.w * k.x.v}`).join(" + ")}`, kv.reduce((s, k) => s + k.w * k.x.v, 0), kv.length]);
      const mv = new Map();
      for (const x of facts) if (x.id === f.concept && same(x) && x.dims.length === 1 && /ProductOrServiceAxis$/.test(x.dims[0][0]) && (f.psMembers ?? []).includes(x.dims[0][1]) && !mv.has(x.dims[0][1])) mv.set(x.dims[0][1], x.v);
      if (mv.size >= 2) sums.push([`제품·서비스 멤버 ${[...mv].map(([k, v]) => `${k} ${v}`).join(" + ")}`, [...mv.values()].reduce((s, v) => s + v, 0), mv.size]);
      // 하위 합 = 합계 줄이면 R9 가 아니다(그 경우 외부 = 합계 줄 자체 — 다른 규칙 몫). 반올림 차만 남는 경우만
      const ok = sums.filter(([, s, k]) => s !== t.v && Math.abs(s - t.v) <= k * 0.5e6).map(([h, s]) => [h, s]);
      if (ok.length) out.set(t.end, { src: `${f.form} ${f.report}`, total: t.v, sums: ok });
    }
  }
  return out;
}
/**
 * 10-Q 본표 매출 하위 줄의 3개월 합(원인 R4 분기별 — 외부 분기값이 합계 줄 대신 하위 줄 합인 경우. MCD 2025-09-30: 2,563 + 4,363 + 151
 * = 7,077, 합계 줄 7,078). 그 10-Q 의 자기 분기(보고일 ±7일, 80~100일)만. → Map(결산일 → { src, total, sums: [[설명, 합]] })
 */
/**
 * 분기별 "매출 − 비용 환급 매출"(ProductOrServiceAxis …Reimburs…, "제외" 멤버 아님) — 10-Q 3개월값, 4분기 = 10-K 연간 − 같은 사업연도 9개월.
 * StockAnalysis 가 호텔(HLT)의 분기 매출을 환급 제외로 싣는 경우의 LTM 대조용(연간은 기존 R 규칙). → Map(분기말 → { v, how })
 */
async function reimbExQuarterValues(faces) {
  const per = new Map(); // "start|end" → { tot, re }
  for (const f of faces.filter((x) => x.instUrl && /^10-[QK]/.test(x.form ?? ""))) {
    const facts = usdFacts(await secInstance(f.instUrl), (id) => /_(Revenues|RevenueFromContractWithCustomerExcludingAssessedTax)$/.test(id));
    for (const x of facts) {
      const k = `${x.start}|${x.end}`;
      const o = per.get(k) ?? {}; per.set(k, o);
      const c = x.id.replace(/^[a-z0-9-]+_/, "");
      if (!x.dims.length) { o[c] ??= x.v; continue; }
      if (x.dims.length === 1 && /ProductOrServiceAxis$/.test(x.dims[0][0]) && /Reimburs/i.test(x.dims[0][1]) && !/Exclud/i.test(x.dims[0][1])) o[`re:${c}`] ??= x.v;
    }
  }
  const exOf = (o) => { for (const c of ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax"]) if (o?.[c] != null && o[`re:${c}`] != null) return o[c] - o[`re:${c}`]; return null; };
  const dd = (k) => { const [a, b] = k.split("|"); return (Date.parse(b) - Date.parse(a)) / 864e5; };
  const out = new Map();
  for (const [k, o] of per) {
    const [st, en] = k.split("|"); const d = dd(k);
    if (d >= 80 && d <= 100) { const v = exOf(o); if (v != null) out.set(en, { v, how: "3개월" }); }
    else if (d > 350 && d < 380 && !out.has(en)) {
      const nine = [...per].find(([k2]) => k2.startsWith(`${st}|`) && dd(k2) > 260 && dd(k2) < 290);
      const a = exOf(o), b = nine ? exOf(nine[1]) : null;
      if (a != null && b != null) out.set(en, { v: a - b, how: "사업연도 − 9개월" });
    }
  }
  return out;
}
async function faceRevenueQuarterParts(faces) {
  const out = new Map();
  for (const f of faces.filter((x) => x.form === "10-Q" && !x.any && x.instUrl)) {
    const kidIds = new Set((f.kids ?? []).map((k) => k.id));
    const facts = usdFacts(await secInstance(f.instUrl), (id) => id === f.concept || kidIds.has(id));
    const dd = (x) => (Date.parse(x.end) - Date.parse(x.start)) / 864e5;
    for (const t of facts.filter((x) => x.id === f.concept && !x.dims.length && dd(x) >= 80 && dd(x) <= 100 && dayDiff(x.end, f.report) <= 7)) {
      if ([...out.keys()].some((e) => dayDiff(e, t.end) <= 7)) continue;
      const same = (x) => x.start === t.start && x.end === t.end;
      const sums = [];
      const kv = (f.kids ?? []).map((k) => ({ ...k, x: facts.find((x) => x.id === k.id && !x.dims.length && same(x)) }));
      if (kv.length >= 2 && kv.every((k) => k.x)) sums.push([`계산 하위 줄 ${kv.map((k) => `${k.id.replace(/^[a-z0-9-]+_/, "")} ${k.w * k.x.v}`).join(" + ")}`, kv.reduce((s, k) => s + k.w * k.x.v, 0)]);
      const mv = new Map();
      for (const x of facts) if (x.id === f.concept && same(x) && x.dims.length === 1 && /ProductOrServiceAxis$/.test(x.dims[0][0]) && (f.psMembers ?? []).includes(x.dims[0][1]) && !mv.has(x.dims[0][1])) mv.set(x.dims[0][1], x.v);
      if (mv.size >= 2) sums.push([`제품·서비스 멤버 ${[...mv].map(([k, v]) => `${k} ${v}`).join(" + ")}`, [...mv.values()].reduce((s, v) => s + v, 0)]);
      if (sums.length) out.set(t.end, { src: `${f.form} ${f.report}`, total: t.v, sums });
    }
  }
  return out;
}
/**
 * 정기공시들(faces, 최신부터)의 매출 위치 파생상품 사실 — 모든 기간(3개월·9개월·연간). fi = 공시 순번(작을수록 최신), accn = 접수번호.
 * 매출 개념에 헤지 지정 축(HedgingDesignationAxis)을 단 사실(XOM 10-Q: Revenues[NotDesignated…] = 매출 줄 파생상품 손익)도 함께 읽는다.
 */
async function derivFactsOf(faces) {
  const want = new Set(Object.values(DERIV_FAM).flatMap((f) => f.ids.map((i) => `us-gaap_${i}`)));
  const out = [];
  for (const [fi, f] of faces.entries())
    for (const x of usdFacts(await secInstance(f.instUrl), (id) => want.has(id) || id === "us-gaap_Revenues"))
      if (x.id !== "us-gaap_Revenues" || x.dims.some((d) => d[0] === HEDGE_DES)) out.push({ ...x, id: x.id.slice(8), fi, accn: f.accn });
  return out;
}
/**
 * 매출 SEC 기대값 모델 — 최근 10-K 3건·10-Q 4건의 본표 매출 줄. 기간 P 의 기대값 = P 를 공시한 가장 최근(읽은) 공시의 본표 매출 줄
 * 개념으로, 그 개념의 P 값 중 최신 판본. 은행 레이아웃(bank)이고 본표에서 매출 줄을 못 찾으면 순수익을 검증기가 따로 합성한다
 * (RevenuesNetOfInterestExpense → Revenues → 순이자이익 + 비이자이익 — 앱과 같은 순서라 공통모드 표기).
 * → { annualAt(E), quarterAt(E, isQ4), ltmAt(L), split, faces } | { why }
 */
async function secFaceRevenue(cik, sub, G, bank) {
  const rc = sub.filings?.recent ?? {};
  const picks = [];
  let nK = 0, nQ = 0;
  for (let i = 0; i < (rc.form ?? []).length && (nK < 3 || nQ < 4); i++) {
    const fm = rc.form[i];
    if (fm === "10-K" && nK < 3) nK++; else if (fm === "10-Q" && nQ < 4) nQ++; else continue;
    picks.push({ accn: rc.accessionNumber[i], form: fm, filed: rc.filingDate[i], report: rc.reportDate[i] });
  }
  const splitGate = !(G.OperatingIncomeLoss?.units?.USD ?? []).some((e) => e.end >= "2020-01-01");
  const PERIODIC = /^(10-K|10-Q|20-F|40-F)/;
  const pools = new Map(); // key → [{ start, end, val, filed, form, accn, nonop }]
  const faces = [];
  const read = new Set();
  const addFiling = async (p) => {
    if (read.has(p.accn)) return;
    read.add(p.accn);
    const fc = await faceRevenueLine(cik, p.accn);
    if (!fc) return;
    const split = splitGate && (fc.nonopKids.length > 0 || fc.nonopMembers.length > 0);
    const custom = !fc.concept.startsWith("us-gaap_");
    const key = `${fc.concept}${split ? "|split" : ""}`;
    if (custom || split) {
      if (!fc.instUrl) return;
      const rows = await faceInstanceRevenue(fc, split);
      pools.set(key, [...(pools.get(key) ?? []), ...rows.map((r) => ({ ...r, filed: p.filed, form: p.form, accn: p.accn }))]);
    } else if (!pools.has(key)) {
      pools.set(key, (G[fc.concept.slice(8)]?.units?.USD ?? []).filter((e) => e.start && PERIODIC.test(e.form ?? "")));
    }
    faces.push({ ...p, ...fc, key, split });
  };
  for (const p of picks) await addFiling(p);
  /**
   * 읽은 범위(최근 10-K 3건·10-Q 4건) 밖 기간 — 항등식 미검증 열(앱 fin unv)은 SEC 직접 대조가 필수라(재감사 2026-09-25) 그 기간을
   * 공시한 정기공시(원공시 + 비교 기간으로 다시 실은 후속 공시)를 더 읽는다. 제출 목록 recent 밖이면 과거 목록 파일까지.
   * kind: FY·LTM(결산일 E 의 10-K 와 이후 2년 10-K) · Q(분기말 E 의 10-Q 와 1년 뒤 10-Q) · Q4(연간 + 9개월 누적 10-Q)
   */
  const pages = [rc];
  const olderLoaded = new Set(); // 읽은 과거 목록 파일명
  const extend = async (E, kind) => {
    const t = Date.parse(E), day = 864e5;
    const want = (form, rep) => {
      const d = (Date.parse(rep) - t) / day;
      if (kind === "FY" || kind === "LTM") return form === "10-K" && d >= -7 && d <= 800;
      if (kind === "Q") return form === "10-Q" && d >= -3 && d <= 400;
      return (form === "10-K" && d >= -7 && d <= 800) || (form === "10-Q" && d >= -100 && d <= 300);
    };
    // 과거 목록 파일 — 기간 E 이후 제출분이 든 목록(filingTo ≥ E)을 아직 안 읽었으면 전부 더 읽는다. E 가 덮이거나 목록이 다할 때까지
    // (재감사 2026-09-25: 한 번만 읽던 것 — 첫 호출보다 더 옛 기간의 두 번째 호출이 과거 목록을 못 읽었다)
    const oldest = (rc.filingDate ?? []).at(-1) ?? "";
    for (const f of oldest > E ? sub.filings?.files ?? [] : []) {
      if (olderLoaded.has(f.name) || (f.filingTo ?? "") < E) continue;
      olderLoaded.add(f.name);
      // silent-ok: 과거 목록 조회 실패 — 그 10-K 를 못 찾아 대응값 없음(FAIL)으로 드러난다
      try { pages.push(await secJson(`https://data.sec.gov/submissions/${f.name}`)); } catch { /* 과거 목록 조회 실패 — 대응값 없음(FAIL)으로 드러난다 */ }
    }
    const more = [];
    for (const pg of pages)
      for (let i = 0; i < (pg.form ?? []).length; i++)
        if (!read.has(pg.accessionNumber[i]) && pg.reportDate[i] && want(pg.form[i], pg.reportDate[i]))
          more.push({ accn: pg.accessionNumber[i], form: pg.form[i], filed: pg.filingDate[i], report: pg.reportDate[i] });
    for (const p of more) await addFiling(p);
    faces.sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? "")); // find() 는 최신 공시부터
  };
  if (!faces.length && bank) {
    const tagPool = (t) => (G[t]?.units?.USD ?? []).filter((e) => e.start && PERIODIC.test(e.form ?? ""));
    for (const t of ["RevenuesNetOfInterestExpense", "Revenues"]) if (tagPool(t).length) { pools.set(t, tagPool(t)); faces.push({ key: t, any: true, label: `${t}(본표 매출 줄 판독 실패 — 은행 순수익 합성, 공통모드)` }); }
    const nonint = tagPool("NoninterestIncome");
    const syn = tagPool("InterestIncomeExpenseNet").map((e) => { const n = nonint.find((x) => x.start === e.start && x.end === e.end && x.accn === e.accn); return n ? { ...e, val: e.val + n.val } : null; }).filter(Boolean);
    if (syn.length) { pools.set("NII+NONINT", syn); faces.push({ key: "NII+NONINT", any: true, label: "순이자이익 + 비이자이익(은행 순수익 합성, 공통모드)" }); }
  }
  if (!faces.length) return { why: `최근 정기공시 ${picks.length}건의 손익계산서 본표에서 매출 줄을 찾지 못함` };
  const dd = (e) => (Date.parse(e.end) - Date.parse(e.start)) / 864e5;
  /** 조건에 맞는 기간 — 그 기간을 공시한 가장 최근 공시의 본표 개념으로, 최신 판본 */
  const find = (pred) => {
    for (const f of faces) {
      const ms = (pools.get(f.key) ?? []).filter(pred);
      const own = f.any ? ms[0] : ms.find((e) => e.accn === f.accn);
      if (!own) continue;
      const e = f.split || !f.concept?.startsWith("us-gaap_") && !f.any
        ? ms.filter((x) => x.start === own.start && x.end === own.end).sort((a, b) => (a.filed ?? "").localeCompare(b.filed ?? "")).at(-1)
        : latestPrecise(ms.filter((x) => x.start === own.start && x.end === own.end));
      const how = f.any ? f.label : `${f.form} ${f.report} 본표 매출 줄 ${f.label}${f.split ? ` − 비영업(${e.nonop}) · 공통모드(비영업 분리는 앱 규칙 재구현)` : ""}`;
      return { v: e.val, start: e.start, end: e.end, split: !!f.split, retag: e.retag ?? null, tagged: e.tagged ?? [], how: [how, `판본 ${e.form ?? ""} ${e.filed ?? ""}`.trim(), retagNote(e)].filter(Boolean).join(" · ") };
    }
    return null;
  };
  const annualAt = (E) => find((e) => dayDiff(e.end, E) <= 7 && dd(e) >= 300 && dd(e) <= 400);
  const ytdAt = (start, E) => find((e) => dayDiff(e.start, start) <= 5 && dayDiff(e.end, E) <= 3);
  const quarterAt = (E, isQ4) => {
    if (isQ4) {
      const fy = annualAt(E);
      if (!fy) return null;
      const nine = find((e) => dayDiff(e.start, fy.start) <= 5 && dd(e) >= 250 && dd(e) <= 290 && e.end < fy.end);
      return nine ? { v: fy.v - nine.v, split: fy.split, how: `사업연도 ${fy.v}(${fy.how}) − 9개월 ${nine.v}(${nine.how})` } : null;
    }
    const q = find((e) => dayDiff(e.end, E) <= 3 && dd(e) >= 80 && dd(e) <= 100);
    if (q) return recastQ1V(REV_M, { v: q.v, split: q.split, start: q.start, end: q.end, how: `3개월 ${q.how}` });
    return null;
  };
  // 회사 재분류 1분기(recastQ1V) — 공시마다 그 공시가 실은 본표 매출 줄 값
  const REV_M = {
    dd,
    facesOf: (pred) => faces.filter((f) => !f.any).flatMap((f) => {
      const e = (pools.get(f.key) ?? []).find((x) => x.accn === f.accn && pred(x));
      return e ? [{ accn: f.accn, filed: e.filed ?? f.filed, form: e.form ?? f.form, r: { v: e.val, split: !!f.split, start: e.start, end: e.end, how: `${f.form} ${f.report} 본표 매출 줄 ${f.label}` } }] : [];
    }),
    derive: (y, d, label) => ({ v: y.v - d.v, split: y.split, start: y.start, end: d.end, how: `${label} — [${y.v}: ${y.how}] − [${d.v}: ${d.how}]` }),
    keys: [{ name: "", get: (r) => r.v, put: (o, dr) => Object.assign(o, { v: dr.v }) }],
  };
  const ltmAt = (L, old = false) => {
    const fy0 = annualAt(L);
    if (fy0) return { ...fy0, how: `최근 사업연도 ${fy0.how}` };
    const qsum = old ? null : faceQuarterSum(L, { find, dd, annualAt, quarterAt, comb: (xs, label) => ({ v: xs.reduce((t, [r, k]) => t + k * r.v, 0), split: xs[0][0].split, start: xs[0][0].start, how: `${label} — ${xs.map(([r, k]) => `${k < 0 ? "− " : ""}[${r.v}: ${r.how}]`).join(" ")}` }) });
    if (qsum) return qsum;
    const fy = find((e) => dd(e) >= 300 && dd(e) <= 400 && e.end < L && (Date.parse(L) - Date.parse(e.end)) / 864e5 < 370);
    if (!fy) return null;
    const s = new Date(Date.parse(fy.end) + 864e5).toISOString().slice(0, 10);
    const cur = ytdAt(s, L);
    if (!cur) return null;
    const ys = (d) => new Date(Date.parse(d) - 365 * 864e5).toISOString().slice(0, 10);
    const prior = find((e) => dayDiff(e.start, ys(cur.start)) <= 7 && dayDiff(e.end, ys(L)) <= 7 && Math.abs(dd(e) - dd(cur)) <= 10);
    if (!prior) return null;
    return { v: fy.v + cur.v - prior.v, split: fy.split, how: `분기 4개 구성 불가 — 종전 식: 사업연도 ${fy.v} + 당기 누적 ${cur.v} − 전년 동기 ${prior.v} (${fy.how})` };
  };
  return { annualAt, quarterAt, ltmAt, extend, split: faces.some((f) => f.split), faces };
}

// ▼ 매출원가·매출총이익 판독 구획(2026-09-26 착수, --metric=cogs — 지표 미종결). 단위 시험이 이 두 표시 사이를 잘라 쓴다 ─────────
// 오너 결정: 매출원가 = 손익계산서 본표의 매출원가 소계 그대로(A·B형) · 본표에 매출총이익 소계가 없으면(C형) 매출총이익 = 매출 − 매출원가
// (합성, 표기) · 본표에 매출원가 줄 자체가 없으면(D형) 회사별 구성 규칙(연구 중 — 표로 받아 --cogs-rules 로 주입, 없으면 앱 빈칸 +
// 사유 "구성 규칙 대기") · CAT = 본표. 앱 모듈(src/lib/fin/**)은 import 하지 않는다 — 판독은 검증기가 따로 한다.
// 판독 규칙(태그 우선순위 아님): 매출원가 = 본표 매출총이익 식(_cal)에서 빼는 항(한 줄이 소계면 그 소계, 여러 항이면 합). 매출총이익 식이
// 없으면 손익 역할 안에서 원가 개념이면서 **라벨이 원가**(cost of sales/revenue/goods …)인 줄 — MCD 10-Q 는 가맹점 임차비용을
// us-gaap:CostOfGoodsAndServicesSold 로 태깅해 개념명만으로는 잘못 고른다(조사 2026-09-26). CAT·BE 의 주석 조각 값은 본표 줄이 아니라
// 판독 대상이 아니다.
const COGS_STD_RE = /^(us-gaap_(CostOfRevenue|CostOfGoodsAndServicesSold|CostOfGoodsSold|CostOfServices|CostOfGoodsAndServiceExcludingDepreciationDepletionAndAmortization)|ifrs-full_CostOfSales)$/;
const GP_RE = /^(us-gaap|ifrs-full)_GrossProfit$/;
const COGS_LABEL_RE = /\bcosts? of (net )?(sales|revenues?|goods|products|equipment|services)\b/i;
const COGS_LABEL_EXCL = /interest|financ|occupancy|per share|percent/i;
const COGS_EXCL_ID = /Abstract$|Member$|Axis$|Domain$|Table$|LineItems$|Percent/;
/** StockAnalysis 가 매출원가에서 빼 별도 줄로 옮기는 원가 소계 안 성분 — 인수 무형상각·구조조정·손상 */
const COGS_ADJ_RE = /Amortiz|Restructur|Impair/i;
/** 인포맥스(FactSet)가 원가에 더하는 감가상각·상각 줄 후보 */
const DA_RE = /Depreciation|Amortiz|Depletion/i;
/** 줄(개념명 + 라벨)이 성분 re 에 해당하는가 — "감가상각 제외 원가"(…ExcludingDepreciation…·exclusive of …) 줄은 원가 본체라 제외(AMD) */
const lineIs = (re, id, label) => !/Exclu/i.test(`${id} ${label ?? ""}`) && re.test(`${id} ${label ?? ""}`);
/** CAT 형 본표 금융 부문 이자비용 줄("Interest expense of Financial Products") — Yahoo 매출원가 = 본표 원가 + 이 줄(F층 원인 규칙) */
const FP_INT_LABEL_RE = /interest expense of financial products/i;
/** D형 빈칸의 앱 사유 문구 — 구성 규칙이 없는 동안 앱은 매출원가를 비우고 이 사유를 단다 */
const COGS_WAIT = "구성 규칙 대기";
/** 파생 열 구성 공시 간 기준 혼합 빈칸의 앱 사유 문구(앱 COGS_NOTE.mix — 문구만 맞춘다, import 안 함) */
const COGS_MIX = "기준 혼합";

/** 공시 링크베이스(_pre·_cal·_lab·.xsd)·목록(index.json) — 매출·매출원가 판독이 같은 공시 파일을 다시 받지 않게 최근 40건 캐시 */
const linkCache = new Map();
function secTextC(url) {
  if (!linkCache.has(url)) {
    linkCache.set(url, secText(url).catch((e) => { linkCache.delete(url); throw e; }));
    if (linkCache.size > 40) linkCache.delete(linkCache.keys().next().value);
  }
  return linkCache.get(url);
}
async function filingNames(base) {
  return JSON.parse(await secTextC(`${base}/index.json`)).directory.item.map((x) => x.name);
}

/**
 * 공시 한 건의 손익계산서 본표 매출원가·매출총이익 구조 →
 * { role, type: "A"|"B"|"C"|"D"|"G", gp, how, terms: [{id,w,label}], parts: [...], da: [...], ids, instUrl } | null
 *  - A: 매출총이익 소계 + 원가 한 줄 · B: 매출총이익 소계 + 원가가 여러 줄(소계의 하위 또는 식의 여러 차감 항) · C: 매출총이익 소계 없음 +
 *    원가 줄 · D: 원가 줄 없음 · G: 매출총이익 줄만 있고 원가 줄을 못 읽음(10-Q 요약표 등 — 다음 공시로 넘긴다)
 *  - terms: 매출총이익에서 빼는 항(w 는 원가 합에 곱할 부호), parts: 원가 소계의 하위 줄(B형 — 외부 정의 분해용), da: 원가·매출총이익 밖
 *    본표의 감가상각·상각 줄(인포맥스 분해 후보), ids: 역할 안 표시 순서 개념(구성 규칙 줄 확인용)
 */
async function faceCogsLine(cik, accn) {
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn.replace(/-/g, "")}`;
  const names = await filingNames(base);
  const xsd = names.find((x) => /\.xsd$/i.test(x));
  const preN = names.find((x) => /_pre\.xml$/i.test(x)) ?? xsd, calN = names.find((x) => /_cal\.xml$/i.test(x)) ?? xsd, labN = names.find((x) => /_lab\.xml$/i.test(x)) ?? xsd;
  const instN = names.find((x) => /_htm\.xml$/i.test(x)) ?? names.find((x) => /\.xml$/i.test(x) && !/_(pre|cal|def|lab)\.xml$|FilingSummary|^R\d+\.xml$/i.test(x));
  if (!preN || !calN) return null;
  const pres = xbrlLinks(await secTextC(`${base}/${preN}`), "presentation"), cals = xbrlLinks(await secTextC(`${base}/${calN}`), "calculation");
  let labels = null;
  const labelOf = async (id) => { labels ??= labN ? xbrlLabels(await secTextC(`${base}/${labN}`)) : new Map(); return (labels.get(id) ?? []).join(" | "); };
  const short = (id) => id.replace(/^[a-z0-9-]+_/i, "");
  const nameOf = async (id) => (await labelOf(id)).split(" | ")[0] || short(id);
  const costLike = async (id) => {
    if (/^(us-gaap|ifrs-full)_/.test(id) && !COGS_STD_RE.test(id)) return false;
    const l = await labelOf(id);
    return COGS_LABEL_RE.test(l) && !COGS_LABEL_EXCL.test(l);
  };
  // 역할 판정·순서는 매출 판독(faceRevenueLine)과 같다 — 포괄손익 단독 역할은 뒤로
  const isRole = (r) => /INCOME|OPERATIONS|EARNINGS/i.test(r) && !/Parenth|Detail|Table|Polic|Tax|Segment|PerShare|Narrative|Schedule/i.test(r);
  const roles = pres.filter((p) => isRole(p.role)).sort((a, b) => Number(/Comprehensive/i.test(a.role)) - Number(/Comprehensive/i.test(b.role)));
  const instUrl = instN ? `${base}/${instN}` : null;
  const desc = async (list) => Promise.all((list ?? []).map(async (t) => ({ ...t, label: await nameOf(t.id) })));
  // 현금흐름표·재무상태표·자본변동표에도 실린 개념(NetIncomeLoss 등) — "이 공시 본표가 그 기간을 싣는가"(D형 covers) 판정에서 뺀다.
  // AMZN 10-Q 현금흐름표는 최근 12개월 열을, 자본변동표는 분기별 순이익을 실어 손익계산서에 없는 기간이 잡혔다(2026-09-26)
  const otherStmt = (r) => /CASHFLOW|BALANCESHEET|FINANCIALPOSITION|FINANCIALCONDITION|EQUITY|STOCKHOLDERS|SHAREHOLDERS/i.test(r) && !/Parenth|Detail|Table|Polic/i.test(r);
  const faceIdsOf = (role, ids) => {
    const other = new Set(pres.filter((p) => p.role !== role && otherStmt(p.role)).flatMap((p) => p.arcs.flatMap((a) => [a.fr, a.to])));
    const own = ids.filter((id) => !other.has(id));
    return own.length ? own : ids;
  };
  let first = null;
  for (const p of roles) {
    const kidsP = new Map(), hasP = new Set();
    for (const a of p.arcs) { kidsP.set(a.fr, [...(kidsP.get(a.fr) ?? []), a]); hasP.add(a.to); }
    const order = [];
    const walk = (id, d) => {
      if (d > 14 || order.includes(id)) return;
      order.push(id);
      for (const a of (kidsP.get(id) ?? []).sort((x, y) => x.order - y.order)) walk(a.to, d + 1);
    };
    for (const r of [...new Set(p.arcs.map((a) => a.fr))].filter((x) => !hasP.has(x))) walk(r, 0);
    const ids = order.filter((id) => !COGS_EXCL_ID.test(id) && !/^(dei|srt|country|currency|ecd)_/.test(id));
    if (!ids.length) continue;
    first ??= { role: p.role, ids };
    const calArcs = cals.find((c) => c.role === p.role)?.arcs ?? cals.filter((c) => isRole(c.role)).flatMap((c) => c.arcs);
    const kids = (id) => calArcs.filter((a) => a.fr === id).map((a) => ({ id: a.to, w: a.w }));
    const gp = ids.find((id) => GP_RE.test(id)) ?? null;
    let terms = null, how = "";
    if (gp) {
      // 매출총이익 식의 차감 항. 차감 항에 원가 줄이 없고 더하는 항이 하위 식을 가지면(옛 IFRS 양식 — 매출총이익 = 조정 전 매출총이익 +
      // 관계기업 미실현이익 조정, TSM 2016~2018) 그 하위 식으로 내려간다
      const seen = new Set();
      const dig = async (id, d) => {
        if (d > 4 || seen.has(id)) return null;
        seen.add(id);
        const k = kids(id), neg = k.filter((x) => x.w < 0);
        for (const x of neg) if (await costLike(x.id)) return neg.map((y) => ({ id: y.id, w: -y.w }));
        for (const x of k.filter((y) => y.w > 0)) { const r = await dig(x.id, d + 1); if (r) return r; }
        // 원가 성격 줄이 없어도 최상위 식에 차감 항이 있으면 그 항(회사 고유 개념 원가 줄 — 라벨이 원가 표현이 아닌 경우)
        return d === 0 && neg.length ? neg.map((y) => ({ id: y.id, w: -y.w })) : null;
      };
      terms = await dig(gp, 0);
      if (terms) how = `본표 매출총이익 식(${short(gp)})의 차감 항`;
    }
    if (!terms) {
      const cands = [];
      for (const id of ids) if (await costLike(id)) cands.push(id);
      const up = new Map();
      for (const a of calArcs) up.set(a.to, [...(up.get(a.to) ?? []), a.fr]);
      const under = (id) => { const seen = new Set(), st = [...(up.get(id) ?? [])]; while (st.length) { const x = st.pop(); if (seen.has(x)) continue; seen.add(x); if (cands.includes(x)) return true; st.push(...(up.get(x) ?? [])); } return false; };
      const top = cands.find((id) => !under(id));
      if (top) { terms = [{ id: top, w: 1 }]; how = gp ? "본표 원가 줄(매출총이익 식 판독 불가 — 원가 개념·원가 라벨)" : "본표 원가 줄(매출총이익 소계 없음 — 원가 개념·원가 라벨)"; }
    }
    if (!terms && !gp) continue; // 이 역할엔 원가·매출총이익이 없다 — 다음 역할, 끝까지 없으면 D형
    let parts = terms ?? [];
    if (terms?.length === 1) { const k = kids(terms[0].id); if (k.length >= 2) parts = k; }
    const type = !terms ? "G" : !gp ? "C" : parts.length >= 2 ? "B" : "A";
    const inside = new Set([...(terms ?? []), ...parts].map((t) => t.id));
    if (gp) inside.add(gp);
    const da = [];
    for (const id of ids) {
      if (inside.has(id) || /Total|^us-gaap_(OperatingExpenses|CostsAndExpenses|OperatingCostsAndExpenses|BenefitsLossesAndExpenses)$/.test(id)) continue;
      if (lineIs(DA_RE, id, await labelOf(id))) da.push({ id, w: 1 });
    }
    // 금융 부문 이자비용 본표 줄(CAT — us-gaap:FinancingInterestExpense 를 ProductOrServiceAxis=FinancialProductsMember 로 태깅). 판독만 —
    // 원가 합에는 넣지 않는다(F층 Yahoo 원인 규칙용). 멤버는 이 역할 표시 구조에서 그 멤버의 상위 축으로 찾는다
    let fpInt = null;
    for (const id of ids) {
      if (!FP_INT_LABEL_RE.test(await labelOf(id))) continue;
      const up = new Map(p.arcs.map((a) => [a.to, a.fr]));
      const mem = order.find((x) => /FinancialProducts\w*Member$/.test(x));
      let ax = mem ? up.get(mem) : null;
      for (let i = 0; ax && !/Axis$/.test(ax) && i < 6; i++) ax = up.get(ax);
      fpInt = { id, w: 1, member: mem && ax && /Axis$/.test(ax) ? `${short(ax)}=${short(mem)}` : null, label: await nameOf(id) };
      break;
    }
    return { role: p.role, type, gp, gpLabel: gp ? await nameOf(gp) : null, how, terms: await desc(terms ?? []), parts: await desc(terms ? parts : []), da: await desc(da), fpInt, ids, faceIds: faceIdsOf(p.role, ids), instUrl };
  }
  if (!first) return null;
  // D형도 본표의 감가상각·상각 줄을 판독해 둔다(F층 외부 = 원가 + 본표 감가상각 줄 규칙 — 전 열 성립만, causeOf daAddAll). 원가 합에는 넣지 않는다
  const daD = [];
  for (const id of first.ids) { // 손익 역할 표시 순서 개념(현금흐름표에도 실리는 감가상각 개념이 faceIds 에선 빠지므로 ids 를 쓴다)
    if (/Total|^us-gaap_(OperatingExpenses|CostsAndExpenses|OperatingCostsAndExpenses|BenefitsLossesAndExpenses)$/.test(id)) continue;
    if (lineIs(DA_RE, id, await labelOf(id))) daD.push({ id, w: 1 });
  }
  return { role: first.role, type: "D", gp: null, gpLabel: null, how: "본표에 매출원가 줄 없음", terms: [], parts: [], da: await desc(daD), ids: first.ids, faceIds: faceIdsOf(first.role, first.ids), instUrl };
}

/**
 * 매출원가·매출총이익 SEC 기대값 모델 — 최근 연차보고서 3건(20-F 제출사는 20-F, 분기 없음)·10-Q 4건의 본표.
 * 기간 P 의 기대값 = P 를 공시한 가장 최근 공시의 본표 구조로, 각 줄 값은 그 기간의 최신 판본(반올림 재태깅 제외 — 매출과 같은 규칙).
 * 표준 개념은 companyfacts, 회사 고유 개념·차원 지정 줄·companyfacts 가 빠뜨린 공시(TSM 2025 20-F 등)는 그 공시 원본(인스턴스).
 * → { annualAt(E), quarterAt(E, isQ4), ltmAt(L), faces } | { why }. 각 결과:
 *   { type, rule, offFace, cogs, gp(본표 소계 — 없으면 null = 합성 대상), parts, da, start, end, how }
 */
async function secFaceCogs({ cik, sub, facts, unit, foreign, rule }) {
  const rc = sub.filings?.recent ?? {};
  const annForm = foreign ? /^(20-F|40-F)$/ : /^10-K$/;
  const picks = [];
  let nK = 0, nQ = 0;
  for (let i = 0; i < (rc.form ?? []).length && (nK < 3 || (!foreign && nQ < 4)); i++) {
    const fm = rc.form[i];
    if (annForm.test(fm) && nK < 3) nK++; else if (!foreign && fm === "10-Q" && nQ < 4) nQ++; else continue;
    picks.push({ accn: rc.accessionNumber[i], form: fm, filed: rc.filingDate[i], report: rc.reportDate[i] });
  }
  const PERIODIC = /^(10-K|10-Q|20-F|40-F)/;
  const cfRows = (id) => { const m = /^(us-gaap|ifrs-full)_(.+)$/.exec(id); return m ? (facts?.[m[1]]?.[m[2]]?.units?.[unit] ?? []).filter((e) => e.start && PERIODIC.test(e.form ?? "")) : []; };
  const keyOf = (t) => (t.member ? `${t.id}[${t.member}]` : t.id);
  const inst = new Map(); // 개념 키 → 인스턴스에서 읽은 기간 값 [{ start, end, val, filed, form, accn }]
  const uRe = new RegExp(`unitRef="[^"]*${unit}`, "i");
  const faces = [], read = new Set();
  const addFiling = async (p) => {
    if (read.has(p.accn)) return;
    read.add(p.accn);
    const fc = await faceCogsLine(cik, p.accn);
    if (!fc) return;
    const f = { ...p, ...fc };
    // 규칙 줄의 concept 는 대안 목록일 수 있다(MCD: 10-K 는 mcd:FoodAndPaperCosts, 10-Q 는 다른 개념으로 같은 줄을 태깅) — 이 공시 본표에 있는 첫 개념
    // 양식마다 본표 줄 구성이 다르면(MCD 10-Q 는 직영점 비용 세 줄을 한 줄로) linesByForm["10-Q"] 로 따로 준다
    // 구성 규칙은 매출총이익 식이 없는 본표(D·C)에 적용 — MAR 은 원가 줄(CostOfRevenue "Operating costs")이 차원 멤버로만 공시돼 라벨 판독상 C 로
    // 잡히지만 무차원 값이 없어 규칙(멤버 합)이 정의다. 규칙이 있으면 D 로 본다(규칙 파일은 D형 종목만 — scripts/metrics/cogs-rules.json)
    if (rule && fc.type === "C") f.type = "D";
    if (f.type === "D" && rule) f.ruleTerms = (rule.linesByForm?.[p.form] ?? rule.lines).map((l) => {
      const alts = [].concat(l.concept), id = alts.find((c) => fc.ids.includes(c)) ?? alts[0];
      return { id, w: l.w ?? 1, member: l.member ?? null, label: l.label ?? id.replace(/^[a-z0-9-]+_/i, ""), onFace: fc.ids.includes(id), optional: !!l.optional };
    });
    const ts = [...fc.terms, ...fc.parts, ...fc.da, ...(f.ruleTerms ?? []), ...(fc.gp ? [{ id: fc.gp }] : []), ...(fc.fpInt ? [fc.fpInt] : [])];
    const need = ts.filter((t) => t.member || !cfRows(t.id).some((e) => e.accn === p.accn));
    // companyfacts 가 이 공시를 통째로 빠뜨렸으면(XOM 2026-07 CIK 변경 뒤 10-Q 등) 본표의 어떤 줄로도 "이 공시가 그 기간을 싣는다"를 알 수
    // 없다 — D형 판정(covers)용으로 원본의 차원 없는 기간 목록을 따로 남긴다
    const cfHas = fc.ids.some((id) => cfRows(id).some((e) => e.accn === p.accn));
    if ((need.length || !cfHas) && fc.instUrl) {
      const xml = await secInstance(fc.instUrl);
      const ctx = parseContexts(xml);
      // 기간 목록은 본표 전용 개념(faceIds)의 차원 없는 사실에서만 — 문맥 전체를 쓰면 현금흐름표 최근 12개월 열 등 손익계산서에 없는
      // 기간이 섞인다
      const pIds = cfHas ? null : new Set(fc.faceIds), pSeen = new Set();
      if (!cfHas) f.periods = [];
      const want = new Set(need.map((t) => t.id)), seen = new Set();
      for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*?)contextRef="([^"]+)"([^>]*)>\s*(-?[\d.]+)\s*</g)) {
        const id = `${m[1]}_${m[2]}`;
        if (!want.has(id) && !pIds?.has(id)) continue;
        const c = ctx.get(m[4]);
        if (!c?.start || !c.end) continue;
        if (pIds?.has(id) && !c.dims.length && !pSeen.has(`${c.start}|${c.end}`)) { pSeen.add(`${c.start}|${c.end}`); f.periods.push({ start: c.start, end: c.end }); }
        if (!want.has(id) || !uRe.test(`${m[3]} ${m[5]}`)) continue;
        for (const t of need.filter((x) => x.id === id)) {
          if (t.member ? !(c.dims.length === 1 && `${c.dims[0][0]}=${c.dims[0][1]}` === t.member) : c.dims.length) continue;
          const k = `${keyOf(t)}|${c.start}|${c.end}`;
          if (seen.has(k)) continue;
          seen.add(k);
          inst.set(keyOf(t), [...(inst.get(keyOf(t)) ?? []), { start: c.start, end: c.end, val: Number(m[6]), filed: p.filed, form: p.form, accn: p.accn }]);
        }
      }
    }
    faces.push(f);
    faces.sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? "")); // 최신 공시부터
  };
  for (const p of picks) await addFiling(p);
  if (!faces.length) return { why: `최근 정기공시 ${picks.length}건의 손익계산서 본표를 읽지 못함` };
  const rows = (t) => [...(t.member ? [] : cfRows(t.id)), ...(inst.get(keyOf(t)) ?? [])];
  const dd = (e) => (Date.parse(e.end) - Date.parse(e.start)) / 864e5;
  const tag = (t) => t.label ?? t.id;
  /** 공시 f 가 싣는 기간(pred) 중 줄 t 의 값 — 그 기간의 최신 판본(반올림 재태깅 제외) × 부호 */
  const lineAt = (f, t, pred, orig = false) => {
    const rs = rows(t);
    const own = rs.find((e) => e.accn === f.accn && pred(e));
    if (!own) return null;
    const pool = rs.filter((x) => x.start === own.start && x.end === own.end);
    // orig = 그 공시 자체의 값(원 공시 대조용 — 최신 판본으로 바꾸지 않음). 같은 공시 안 문장용 반올림 사실은 정밀값 쪽
    const mine = pool.filter((x) => x.accn === f.accn);
    const e = orig ? (mine.find((x) => !mine.some((w) => w.val !== x.val && sentenceRetag(x.val, w.val))) ?? mine.at(-1)) : latestPrecise(pool);
    return { v: e.val * (t.w ?? 1), val: e.val, accn: e.accn, start: e.start, end: e.end, filed: e.filed, form: e.form, retag: orig ? null : e.retag ?? null };
  };
  /** 공시 f 가 그 기간을 싣는가(D형 판정용 — 원가 줄이 없으니 본표의 다른 줄로). 현금흐름표·자본변동표에도 실린 개념은 빼고(faceIds) 본다 */
  const covers = (f, pred) => (f.faceIds ?? f.ids).some((id) => cfRows(id).some((e) => e.accn === f.accn && pred(e))) || (f.periods ?? []).some(pred);
  const one = (f, pred, orig = false) => {
    const terms = f.type === "D" ? f.ruleTerms ?? [] : f.terms;
    let anchor = null;
    for (const t of terms) { anchor = lineAt(f, t, pred, orig); if (anchor) break; }
    if (!anchor) {
      if (f.type === "G") return null; // 매출총이익만 — 다음 공시로
      // 원가(규칙) 줄 값이 이 공시에서 하나라도 읽혔으면 본표가 그 기간 열을 싣지 않는 것 — 다음 공시로. 본표의 다른 줄로 판정하면
      // 현금흐름표 최근 12개월·자본변동표 분기 열이 잡혀 원가 줄이 있는 공시를 D형으로 오판했다(AMZN·KO LTM, AVGO·GLW 분기 — 2026-09-26)
      if (terms.some((t) => rows(t).some((e) => e.accn === f.accn))) return null;
      // 원가 줄이 본표에 있는데 이 공시에서 값을 하나도 못 읽음 = 판독 실패 — D형으로 넘기지 않고 오류(판정 호출부가 FAIL·조회 오류로 기록)
      // 단, 원가 줄이 어느 공시에서도 차원 없는 값 없이 차원(부문 멤버)으로만 태깅된 회사(MAR "Operating costs" — 조사 cogs.md §3)는
      // 판독 실패가 아니라 D형(본표 합계 원가 줄 없음) — 다른 공시엔 값이 있는데 이 공시만 못 읽은 경우만 오류
      const dimOnly = !terms.some((t) => rows(t).length);
      if (f.type !== "D" && !dimOnly) return { err: `${f.form} ${f.report}(${f.accn}) 본표 원가 줄 ${terms.map(tag).join("·")} 이 있는데 companyfacts·공시 원본 어디서도 차원 없는 값을 읽지 못함 — 판독 실패` };
      if (!covers(f, pred)) return null; // 이 공시는 그 기간을 싣지 않음 — 다음 공시로
      const why = f.ruleTerms ? "구성 규칙 줄 값 없음" : f.how;
      return { type: "D", rule: !!f.ruleTerms, offFace: (f.ruleTerms ?? []).filter((t) => !t.onFace && !t.optional).map(tag), cogs: null, gp: null, parts: [], da: [], how: `${f.form} ${f.report} ${why}` };
    }
    const same = (e) => e.start === anchor.start && e.end === anchor.end;
    const vals = terms.map((t) => ({ t, x: lineAt(f, t, same, orig) }));
    const miss = vals.filter((y) => !y.x).map((y) => tag(y.t));
    const g = f.gp ? lineAt(f, { id: f.gp, w: 1 }, same, orig) : null;
    const newest = [...vals.map((y) => y.x), g].filter(Boolean).sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? ""))[0];
    const retag = [...vals.map((y) => y.x && y.x.retag && `${tag(y.t)}`), g?.retag && "매출총이익"].filter(Boolean);
    return {
      type: f.type, rule: !!f.ruleTerms, offFace: (f.ruleTerms ?? []).filter((t) => !t.onFace && !t.optional).map(tag), faceAccn: f.accn,
      start: anchor.start, end: anchor.end,
      cogs: vals.reduce((s, y) => s + (y.x?.v ?? 0), 0), gp: g?.v ?? null,
      parts: f.parts.length >= 2 ? f.parts.map((t) => ({ id: t.id, label: t.label, v: lineAt(f, t, same)?.v ?? null })) : [],
      // 원가 항(구성 규칙 줄 포함)별 값 — F층 "외부 = 원가 항 부분집합" 규칙용(값 없는 항은 0 — 원가 합과 같은 처리)
      terms: vals.map((y) => ({ id: keyOf(y.t), label: tag(y.t), v: y.x?.v ?? 0 })),
      // 반올림 재게시를 그대로 쓴 원가(항마다 나중 공시의 반올림 값 — 앱·A층은 먼저 공시된 정밀값). F층 "외부 = 최신 공시 판본 값" 규칙용
      cogsLatest: vals.reduce((s, y) => s + (y.x ? (y.x.retag ? y.x.retag.val * (y.t.w ?? 1) : y.x.v) : 0), 0),
      latestEv: vals.filter((y) => y.x?.retag).map((y) => `${tag(y.t)} ${y.x.v} → ${y.x.retag.val * (y.t.w ?? 1)}(${y.x.retag.filed})`),
      da: f.da.map((t) => ({ id: t.id, label: t.label, v: lineAt(f, t, same)?.v ?? null })).filter((x) => x.v != null),
      fpInt: f.fpInt ? lineAt(f, f.fpInt, same)?.v ?? null : null, fpIntLabel: f.fpInt?.label ?? null,
      how: [
        `${f.form} ${f.report} ${f.ruleTerms ? `구성 규칙(${rule?.note ?? "--cogs-rules"})` : f.how}: ${vals.map((y) => `${tag(y.t)} ${y.x?.v ?? "값 없음(0)"}`).join(" + ")}`,
        g ? `매출총이익 줄 ${f.gpLabel ?? f.gp} ${g.v}` : "",
        miss.length ? `값 없는 항 0 처리: ${miss.join("·")}` : "",
        retag.length ? `반올림 재태깅 제외: ${retag.join("·")}` : "",
        `판본 ${newest.form} ${newest.filed}`,
      ].filter(Boolean).join(" · "),
    };
  };
  const find = (pred) => { for (const f of faces) { const r = one(f, pred); if (r) return r; } return null; };
  /** 부호 붙은 조합(Q4 = 사업연도 − 9개월, LTM = 사업연도 + 당기 − 전년 동기). 한 성분이라도 D형이면 D형 */
  const comb = (xs, label) => {
    if (xs.some(([r]) => !r)) return null;
    const bad = xs.find(([r]) => r.err);
    if (bad) return bad[0];
    const d = xs.find(([r]) => r.cogs == null);
    if (d) return { ...d[0], how: `${label}: ${d[0].how}` };
    const sum = (get) => (xs.every(([r]) => get(r) != null) ? xs.reduce((s, [r, k]) => s + k * get(r), 0) : null);
    const byId = (key) => xs[0][0][key].filter((p) => xs.every(([r]) => r[key].some((y) => y.id === p.id && y.v != null)))
      .map((p) => ({ id: p.id, label: p.label, v: xs.reduce((s, [r, k]) => s + k * r[key].find((y) => y.id === p.id).v, 0) }));
    const types = [...new Set(xs.map(([r]) => r.type))];
    return {
      type: types.join("/"), rule: xs.some(([r]) => r.rule), offFace: [...new Set(xs.flatMap(([r]) => r.offFace))],
      cogs: sum((r) => r.cogs), gp: sum((r) => r.gp), parts: byId("parts"), da: byId("da"),
      cogsLatest: sum((r) => r.cogsLatest), latestEv: xs.flatMap(([r]) => r.latestEv ?? []),
      // 원가 항은 이름(구성 규칙 라벨)으로 맞춘다 — 구성 규칙 줄은 공시마다 대안 개념(HLT 10-K 개념 변경)으로 태깅될 수 있다
      terms: (xs[0][0].terms ?? []).filter((p) => xs.every(([r]) => (r.terms ?? []).some((y) => y.label === p.label)))
        .map((p) => ({ id: p.id, label: p.label, v: xs.reduce((s, [r, k]) => s + k * r.terms.find((y) => y.label === p.label).v, 0) })), start: xs[0][0].start, end: xs[0][0].end,
      fpInt: sum((r) => r.fpInt), fpIntLabel: xs[0][0].fpIntLabel ?? null,
      how: `${label} — ${xs.map(([r, k]) => `${k < 0 ? "− " : ""}[${r.how}]`).join(" ")}`,
      comps: xs.flatMap(([r, k]) => (r.comps ? r.comps.map((c) => ({ ...c, k: c.k * k })) : [{ start: r.start, end: r.end, k, v: r.cogs, faceAccn: r.faceAccn }])),
    };
  };
  /**
   * 구성 공시 간 기준 혼합(리드 결정 2026-09-27 — 앱 is.ts readCogsTerms 와 다른 경로의 독립 판정): 파생 열의 구성분(사업연도·9개월·당기
   * 누적·전년 동기)마다 **그 기간을 처음 공시한 원 공시**의 본표 원가(그 공시 자체 값 — 그 공시 본표의 원가 줄·구성 규칙 줄)와 파생에 쓴
   * 최신 판본 값을 비교한다. 다르면(재작성·재분류) 혼합 — 한 열 = 한 기준이라 앱은 빈칸 + "기준 혼합"이어야 한다. 원 공시는
   * 제출 목록에서 찾아(origFiling) addOriginals 가 미리 읽어 둔다(못 찾거나 못 읽으면 판정 불가 — mixUnknown, 다른 공시로 대신하지 않음).
   * 합이 같은 개념 대체(MCD 10-K 3줄 ↔ 10-Q 1줄)는 값이 같아 혼합이 아니다. 차이는 허용 오차 없이 decimals 로 가른다(judgeComp).
   */
  /**
   * 원 공시 — 그 기간을 처음 공시한 정기공시를 **제출 목록**(submissions recent · 과거 목록 파일)에서 정확히 찾는다: 보고 기준일 = 기간 끝(±3일),
   * 양식 = 기간 길이에 맞는 원본(사업연도 10-K, 그 외 10-Q — 정정 공시 제외) 중 가장 이른 제출. 못 찾으면 null(판정 불가 — 다른 공시로 대신하지
   * 않는다, 리드 결정 2026-09-27). 과거 목록 조회 실패는 throw(호출부가 조회 실패로 기록)
   */
  const subPages = [sub.filings?.recent ?? {}], oldPages = new Set();
  const origOf = new Map(); // "start|end" → { accn, form, filed, report } | null
  const origFiling = async (c) => {
    const k = `${c.start}|${c.end}`;
    if (origOf.has(k)) return origOf.get(k);
    const form = (Date.parse(c.end) - Date.parse(c.start)) / 864e5 >= 300 ? "10-K" : "10-Q";
    const oldest = () => subPages.map((pg) => (pg.filingDate ?? []).at(-1) ?? "").sort()[0] ?? "";
    for (const f of oldest() > c.end ? sub.filings?.files ?? [] : []) {
      if (oldPages.has(f.name) || (f.filingTo ?? "") < c.end) continue;
      oldPages.add(f.name);
      subPages.push(await secJson(`https://data.sec.gov/submissions/${f.name}`));
    }
    let best = null;
    for (const pg of subPages)
      for (let i = 0; i < (pg.form ?? []).length; i++)
        if (pg.form[i] === form && pg.reportDate?.[i] && dayDiff(pg.reportDate[i], c.end) <= 3 && (!best || pg.filingDate[i] < best.filed))
          best = { accn: pg.accessionNumber[i], form, filed: pg.filingDate[i], report: pg.reportDate[i] };
    origOf.set(k, best);
    return best;
  };
  /** 구성분 판정 결과 "start|end" → { mix } | { unk } | {} — addOriginals 가 채운다(원 공시·decimals 판독은 비동기) */
  const mixVerdict = new Map();
  const withMix = (res) => {
    if (!res || res.cogs == null || !res.comps) return res;
    const vs = res.comps.map((c) => mixVerdict.get(`${c.start}|${c.end}`));
    if (vs.some((v) => !v)) return res; // 판정 전(addOriginals 를 거치지 않은 호출 — D층 항등식 등)
    const bad = vs.filter((v) => v.mix).map((v) => v.mix), unk = vs.filter((v) => v.unk).map((v) => v.unk), rp = vs.filter((v) => v.rep).map((v) => v.rep);
    if (bad.length) return { ...res, mix: bad.join("; ") };
    if (unk.length) return { ...res, mixUnknown: unk.join("; ") };
    // 반올림 재게시만 있으면 혼합 아님 — 근거를 메모에 남긴다(decimals 판정)
    return rp.length ? { ...res, how: `${res.how} · 기준 혼합 아님(decimals: ${rp.join("; ")})` } : res;
  };
  const localOf = (id) => id.replace(/^[a-z0-9-]+_/i, "");
  /** 공시 accn 의 그 줄 사실 decimals(같은 값 사실 중 가장 정밀한 선언) — 없으면 null */
  const decOf = async (accn, t, x) => {
    const idx = await instanceDecimals(cik, accn);
    const hit = (idx?.get(`${localOf(t.id)}|${x.start}|${x.end}${t.member ? `|${t.member}` : ""}`) ?? []).filter((q) => q.v === x.val && q.dec != null);
    return hit.length ? Math.max(...hit.map((q) => q.dec)) : null;
  };
  const lineVals = (f, pred, orig) => (f.type === "D" ? f.ruleTerms ?? [] : f.terms).map((t) => ({ t, key: keyOf(t), x: lineAt(f, t, pred, orig) }));
  /**
   * 구성분 하나의 판정 — 원 공시(그 기간을 처음 공시한 공시) 자체 값 vs 파생에 쓴 판본 값. 리드 결정(2026-09-27): 허용 오차 없이 decimals 로 가른다.
   *  · 줄 구성이 같으면 줄마다: 같음 → 통과 · 나중 판본 decimals 가 낮고 원 값의 그 단위 반올림과 정확히 같음(audit.mjs isDecimalsRounding)
   *    → 재게시(혼합 아님) · decimals 근거 없음 → 판정 불가 · 그 외 → 혼합(재작성·재분류)
   *  · 줄 구성이 다르면(MCD 10-K 3줄 ↔ 10-Q 1줄, DAL 부대사업 분할) 합으로 같은 판정(합의 decimals = 줄 decimals 최솟값)
   */
  const judgeComp = async (c) => {
    const pred = (e) => dayDiff(e.start, c.start) <= 3 && dayDiff(e.end, c.end) <= 3;
    const tagc = `${c.start}~${c.end}`;
    const of = origOf.get(`${c.start}|${c.end}`);
    if (!of) return { unk: `${tagc} 원 공시 없음(제출 목록에 보고 기준일 ${c.end} 원본 공시 없음)` };
    const f = faces.find((x) => x.accn === of.accn);
    if (!f) return { unk: `${tagc} 원 공시 없음(${of.form} ${of.accn} 본표 판독 실패)` };
    const u = faces.find((x) => x.accn === c.faceAccn);
    if (!u) return { unk: `${tagc} 판본 공시 ${c.faceAccn} 판독 없음` };
    const o = one(f, pred, true);
    if (!o || o.err || o.cogs == null) return { unk: `${tagc} 원 공시 ${f.accn} 원가 판독 없음` };
    if (o.cogs === c.v) return {};
    const lo = lineVals(f, pred, true), lu = lineVals(u, pred, false);
    const judgeVals = (ov, oDec, uv, uDec, what) => {
      if (oDec == null || uDec == null) return { unk: `${tagc} ${what} 원 ${ov} → 판본 ${uv} — decimals 없음` };
      if (isDecimalsRounding({ val: ov, dec: oDec }, { val: uv, dec: uDec })) return { rep: `${tagc} ${what} ${ov}(d${oDec}) → ${uv}(d${uDec}) 반올림 재게시` };
      return { mix: `${tagc} ${what} 원 공시 ${f.form} ${f.accn} ${ov}(d${oDec}) ≠ 파생 판본 ${uv}(d${uDec})` };
    };
    if (lo.length === lu.length && lo.every((y, i) => y.key === lu[i].key)) {
      const out = [];
      for (let i = 0; i < lo.length; i++) {
        const y = lo[i], z = lu[i];
        if ((y.x?.v ?? null) === (z.x?.v ?? null)) continue;
        if (!y.x || !z.x) { out.push({ unk: `${tagc} ${tag(y.t)} 한쪽 값 없음` }); continue; }
        out.push(judgeVals(y.x.val, await decOf(f.accn, y.t, y.x), z.x.val, await decOf(z.x.accn, z.t, z.x), tag(y.t)));
      }
      const m = out.filter((r) => r.mix), k = out.filter((r) => r.unk), rp = out.filter((r) => r.rep);
      return m.length ? { mix: m.map((r) => r.mix).join("; ") } : k.length ? { unk: k.map((r) => r.unk).join("; ") } : rp.length ? { rep: rp.map((r) => r.rep).join("; ") } : {};
    }
    const decMin = async (ls, accnOf) => {
      let d = Infinity;
      for (const y of ls) { if (!y.x) continue; const v = await decOf(accnOf(y), y.t, y.x); if (v == null) return null; d = Math.min(d, v); }
      return d;
    };
    const sum = (ls) => ls.reduce((acc, y) => acc + (y.x?.val ?? 0) * (y.t.w ?? 1), 0);
    return judgeVals(sum(lo), await decMin(lo, () => f.accn), sum(lu), await decMin(lu, (y) => y.x.accn),
      `원가 합(줄 구성 다름: ${lo.map((y) => y.key).join("+")} ↔ ${lu.map((y) => y.key).join("+")})`);
  };
  /** 파생 열 구성분의 원 공시를 읽어 두고(이미 읽은 공시는 건너뜀) 구성분마다 판정해 둔다. cols = [{ kind: "Q4"|"LTM", E }] */
  const addOriginals = async (cols) => {
    for (const { kind, E } of cols) {
      const r = kind === "LTM" ? ltmRaw(E) : q4Raw(E);
      for (const c of r?.comps ?? []) {
        const of = await origFiling(c);
        if (of && !read.has(of.accn)) await addFiling(of);
      }
    }
    for (const { kind, E } of cols) {
      const r = kind === "LTM" ? ltmRaw(E) : q4Raw(E);
      for (const c of r?.comps ?? []) {
        const k = `${c.start}|${c.end}`;
        if (!mixVerdict.has(k)) mixVerdict.set(k, await judgeComp(c));
      }
    }
  };
  const annualAt = (E) => find((e) => dayDiff(e.end, E) <= 7 && dd(e) >= 300 && dd(e) <= 400);
  const quarterAt = (E, isQ4) => (isQ4 ? withMix(q4Raw(E)) : recastQ1V({
    dd,
    facesOf: (pred) => faces.map((f) => ({ accn: f.accn, filed: f.filed ?? "", form: f.form, r: one(f, pred) })).filter((x) => x.r && !x.r.err && x.r.start && x.r.type !== "D"),
    derive: (y, d, label) => comb([[y, 1], [d, -1]], label),
    keys: [{ name: "매출원가", get: (r) => r.cogs, put: (o, dr) => { o.cogs = dr.cogs; } }, { name: "매출총이익", get: (r) => r.gp, put: (o, dr) => { o.gp = dr.gp; } }],
  }, find((e) => dayDiff(e.end, E) <= 3 && dd(e) >= 80 && dd(e) <= 100)));
  const q4Raw = (E) => {
    const fy = annualAt(E);
    if (!fy || fy.cogs == null) return fy;
    const nine = find((e) => dayDiff(e.start, fy.start) <= 5 && dd(e) >= 250 && dd(e) <= 290 && e.end < fy.end);
    return comb([[fy, 1], [nine, -1]], "사업연도 − 9개월");
  };
  const ltmAt = (L, old = false) => withMix(ltmRaw(L, old));
  const ltmRaw = (L, old = false) => {
    const fy0 = annualAt(L);
    if (fy0) return fy0;
    const qsum = old ? null : faceQuarterSum(L, { find, dd, annualAt, quarterAt, comb });
    if (qsum) return qsum;
    const fy = find((e) => dd(e) >= 300 && dd(e) <= 400 && e.end < L && (Date.parse(L) - Date.parse(e.end)) / 864e5 < 370);
    if (!fy || fy.cogs == null) return fy;
    const s = new Date(Date.parse(fy.end) + 864e5).toISOString().slice(0, 10);
    const cur = find((e) => dayDiff(e.start, s) <= 5 && dayDiff(e.end, L) <= 3);
    if (!cur) return null;
    const ys = (d) => new Date(Date.parse(d) - 365 * 864e5).toISOString().slice(0, 10);
    const prior = find((e) => dayDiff(e.start, ys(cur.start)) <= 7 && dayDiff(e.end, ys(L)) <= 7 && Math.abs(dd(e) - dd(cur)) <= 10);
    return comb([[fy, 1], [cur, 1], [prior, -1]], "분기 4개 구성 불가 — 종전 식: 사업연도 + 당기 누적 − 전년 동기");
  };
  /** 기간 s~e 의 최초 공시 원가 — 그 기간을 실은 공시 중 가장 먼저 제출된 공시 자기 값(원 판본) → { cogs, filed, form } | null */
  const origAt = (s, e) => {
    const pred = (x) => dayDiff(x.start, s) <= 3 && dayDiff(x.end, e) <= 3;
    for (const f of [...faces].sort((a, b) => (a.filed ?? "").localeCompare(b.filed ?? ""))) {
      const r = one(f, pred, true);
      if (r && !r.err && r.cogs != null && r.start) return { cogs: r.cogs, filed: f.filed, form: f.form };
    }
    return null;
  };
  /** 읽은 공시 전체의 기간 목록 [start, end] */
  const periodsAll = () => [...new Set(faces.flatMap((g) => [...(g.periods ?? [])]))].map((k) => k.split("|"));
  return { annualAt, quarterAt, ltmAt, faces, addOriginals, origAt, periodsAll };
}

/** 외부 값(백만 단위 부동소수 환산 포함)을 달러 정수로 — 표현 오차만 없앤다(허용치 아님) */
/**
 * F층 매출원가 분해 후보 [[설명, 기대값]] — 소스별 정의(조사 2026-09-26 §4). 전제: 앱 매출원가 = SEC 본표(A층 정확 일치).
 *  - StockAnalysis: 본표 원가 소계 − 소계 안 인수 무형상각·구조조정·손상 줄(AMD 17,487 − 1,031 = 16,456, AVGO 20,593 − 6,031 − 76)
 *  - 인포맥스(FactSet): 본표 원가 + 본표의 감가상각·상각 줄(부분집합 — 어느 줄을 넣는지 회사마다 다름), 또는 원가 위치 현금흐름위험회피
 *    재분류를 뺀 값(NFLX 23,275,329 − 1,437 천 달러 — 매출 R8 과 같은 성격)
 * e = 그 열의 본표 판독(secFaceCogs 결과), hedge = { v, ev } | null
 */
function cogsCauseCands(n, ours, e, hedge) {
  const out = [];
  if (!e || ours == null) return out;
  if (n === "StockAnalysis") {
    const adj = (e.parts ?? []).filter((p) => p.v != null && p.v !== 0 && lineIs(COGS_ADJ_RE, p.id, p.label));
    if (adj.length) out.push([`StockAnalysis 매출원가 = 본표 원가 소계 ${ours} − 소계 안 ${adj.map((p) => `${p.label} ${p.v}`).join(" − ")}(인수 무형상각·구조조정·손상 — SA 는 별도 줄로 옮김)`, ours - adj.reduce((s, p) => s + p.v, 0)]);
  }
  if (n === "인포맥스") {
    // D형(구성 규칙) 본표 감가상각 줄은 열마다가 아니라 전 열 성립 규칙(causeOf daAddAll)으로만 — 여기선 제외
    const da = /D/.test(e.type ?? "") ? [] : (e.da ?? []).filter((x) => x.v).slice(0, 6);
    for (let mask = 1; mask < 1 << da.length; mask++) {
      const use = da.filter((_, i) => mask & (1 << i));
      out.push([`인포맥스 매출원가 = 본표 원가 ${ours} + 본표 감가상각·상각 줄 ${use.map((x) => `${x.label} ${x.v}`).join(" + ")}(FactSet 은 감가상각·상각을 원가에 넣음)`, ours + use.reduce((s, x) => s + x.v, 0)]);
    }
    if (hedge?.v) out.push([`인포맥스 매출원가 = 본표 원가 ${ours} − 원가 위치 현금흐름위험회피 재분류 ${hedge.v}(${hedge.ev}) — 매출 R8 과 같은 성격`, ours - hedge.v]);
  }
  return out;
}
/** 분해 후보 중 외부 값과 완전히 같은 첫 식(또는 외부 표기 단위 unit 반올림 식 roundHalfAway(식, unit) = 외부) — 허용 오차 없음 */
function exactCause(v, cands, unit = 1) {
  return cands.find(([, exp]) => extEq(v, exp) || (unit != null && unit !== 1 && extEq(v, roundHalfAway(exp, unit)))) ?? null;
}
/**
 * F층 매출총이익 원인 — ① 회사 반올림(IBM): 외부 = 앱 매출 − 앱 매출원가, 본표 매출총이익은 회사가 따로 반올림(세 값 모두 A층 정확 일치)
 * ② 구성요소: 외부 매출총이익 = 그 소스의 매출 − 매출원가이고 두 성분이 모두 ① 또는 ②(EBITDA 구성요소 규칙과 같은 방식)
 */
function gpCause(n, v, { ours, rev, cogs, revPassed, cogsPassed, srcRev, srcCogs, srcRevOk, srcCogsOk }) {
  if (revPassed && cogsPassed && rev != null && cogs != null && ours !== rev - cogs && extEq(v, rev - cogs))
    return { ok: `회사 반올림 — ${n} 매출총이익 = 앱 매출 ${rev} − 앱 매출원가 ${cogs} = ${rev - cogs}, 본표 매출총이익 ${ours} 은 회사가 따로 반올림(차 ${ours - (rev - cogs)}) · 매출·매출원가·매출총이익 모두 A층 정확 일치` };
  if (srcRev != null && srcCogs != null && srcRevOk && srcCogsOk && extEq(v, srcRev - srcCogs))
    return { ok: `구성요소 모두 ① 또는 ② — ${n} 매출총이익 = ${n} 매출 ${srcRev} − ${n} 매출원가 ${srcCogs}` };
  return null;
}
/** 10-K 차원 사실(annualRevenueDimFacts)에서 결산일 E 의 원가 위치 현금흐름위험회피 재분류 — 최신 10-K 한 건, 첫 개념만(두 개념 중복 합산 금지) */
function cogsHedgeAt(facts, E) {
  const costLoc = (ds) => ds.some((d) => LOC_AXES.includes(d[0]) && /Cost/i.test(d[1]));
  for (const id of DERIV_FAM.cf.ids) {
    const fs = facts.filter((x) => x.id === id && costLoc(x.dims) && dayDiff(x.end, E) <= 7);
    if (!fs.length) continue;
    const fi = Math.min(...fs.map((x) => x.fi));
    const own = fs.filter((x) => x.fi === fi);
    return { v: aggDeriv(own), ev: own.map((x) => `${x.id}[${x.dims.map((d) => d[1]).join(",")}] ${x.v}`).join("; ") };
  }
  return null;
}
/** 인포맥스 연간 ≠ 자기 분기 4개 합이고 그 합 = 앱 = SEC 본표면 외부 자기 모순(외부 단독 이탈). get = 분기 행 → 값 */
function imSelfGap(imAnnual, E, v, ours, get) {
  const qs = (imAnnual?.quarters ?? []).filter((q) => (Date.parse(E) - Date.parse(q.end)) / 864e5 > -8 && (Date.parse(E) - Date.parse(q.end)) / 864e5 < 330);
  if (qs.length !== 4 || qs.some((q) => get(q) == null)) return null;
  const s = qs.reduce((t, q) => t + get(q), 0);
  return extEq(s, ours) && !extEq(v, ours) ? { outlier: `외부 단독 이탈(인포맥스 자체 집계 불일치) — 인포맥스 연간 ${v} ≠ 자기 분기 4개 합 ${s}(${qs.map((q) => `${q.end} ${get(q)}`).join(" + ")}) = 앱 = SEC 본표(A층 정확 일치)` } : null;
}
// ▲ 매출원가·매출총이익 판독 구획 ────────────────────────────────────────────────────────────────────────────

// ▼ 영업이익 판독 구획(2026-09-27, --metric=opinc — 지표 미종결) ────────────────────────────────────────────────────────
// 앱(src/lib/fin/metrics/opinc.ts)은 본표 영업이익 소계 그대로, 소계가 없으면 "세전이익 − 영업외 항목(공시 계산 구조)" 합성이다. 앱의 영업외
// 개념 목록(NONOP)을 복사하지 않는다 — 영업외 판정은 **FASB 표준 택사노미의 손익계산서 계산 구조**(xbrl.fasb.org us-gaap-stm-soi-cal, 그 공시가
// 참조한 택사노미 연도)로 따로 한다: 세전이익 아래이면서 OperatingIncomeLoss 하위가 아닌 개념 = 영업외. 그 연도 계산 구조에 없는 개념은
// 그 개념이 실린 가장 최근 연도(2024 택사노미에서 계산 구조 밖으로 빠진 InterestExpense 등), 어느 연도에도 없으면 영업(기본값 — 메모에 남김).
// 회사 고유(확장) 개념은 FASB 분류가 없어 라벨로만 가른다 — 앱과 같은 성격의 가정이라 그 줄이 영업외로 잡힌 열은 공통모드로 적는다.
const OPINC_ID_RE = /^(us-gaap_OperatingIncomeLoss|ifrs-full_ProfitLossFromOperatingActivities)$/;
const PRETAX_ID_RE = /^(us-gaap_IncomeLossFromContinuingOperationsBeforeIncomeTaxes\w*|ifrs-full_ProfitLossBeforeTax)$/;
/** 회사 고유 말단 줄의 영업외 라벨 — "Other (income) and expense"·"Nonoperating …"(검증기 자체 판정, 공통모드 표기) */
const EXT_NONOP_RE = /\bnon-?operating\b|^\s*other\s*(\(\s*)?(income|expense|gains?|losses?)\b/i;
/** 외부 영업이익 차이 후보 — 영업이익 계산식 안의 일회성 비용 줄(구조조정·손상·소송·인수합병 등)과 인수 무형자산 상각 줄 */
// 일반 비용·합계 줄 — 개념명에 일회성 단어가 있어도 줄 자체는 아니다(LRCX CostOfGoodsSold…ExcludingRestructuring). 하위 줄은 계속 본다
const GENERAL_COST_ID = /_(SellingGeneralAndAdministrative|CostOf|OperatingExpenses$|CostsAndExpenses|GeneralAndAdministrativeExpense$|ResearchAndDevelopmentExpense)/;
const OTHER_OP_ID = /_(OtherOperatingIncomeExpenseNet|OtherCostAndExpenseOperating|OtherOperatingCostAndExpense|OtherOperatingIncome|OtherExpenses)$/;
const OP_CHARGE_RE = /Restructur|Impair|Severance|Litigation|Settlement|AcquisitionRelated|BusinessCombination|Merger|Integration|Separation|Divestiture|GainLossOnDisposition|GainLossOnSale|Terminat|other operating charges/i; // other operating charges: KO 본표 줄(구조조정·손상 등 — 앱 일회성비용 규칙과 같은 판정, 2026-09-29)
const OP_AMORT_RE = /AmortizationOfIntangible|AmortizationOfAcquired|IntangibleAssets?\w*Amortiz|amortization of (acquired |purchased |acquisition-related )?intangible/i;
/** 금융 부문 표지 — 본표 매출 줄(금융서비스 수익)·제품·서비스 멤버(금융) */
const FIN_REV_ID_RE = /FinancialServicesRevenue|FinancingRevenue|FinanceAndInterestIncome|FinancialProductsRevenue/i;
const FIN_MEMBER_RE = /Financ\w*Member$/i;

/** FASB 택사노미 파일(xbrl.fasb.org — SEC 아님) — 발행 후 바뀌지 않으므로 SEC 원본과 같은 디스크 캐시 */
async function fasbText(url) {
  const disk = pathJoin(SEC_DISK, `fasb_${url.replace(/^https?:\/\/xbrl\.fasb\.org\//, "").replace(/[^A-Za-z0-9._-]/g, "_")}`);
  if (existsSync(disk)) return readFileSync(disk, "utf8");
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`FASB HTTP ${r.status} ${url.replace(/^https:\/\/(www\.)?/, "")}`);
  const t = await r.text();
  mkdirSync(SEC_DISK, { recursive: true });
  writeFileSync(disk, t);
  return t;
}
/** 택사노미 연도 → 손익계산서 계산 구조 파일 URL(2022 이후 "YYYY", 이전 "YYYY-01-31") */
const soiCalUrl = (y) => `https://xbrl.fasb.org/us-gaap/${y}/stm/us-gaap-stm-soi-cal-${y >= 2022 ? y : `${y}-01-31`}.xml`;
const soiMemo = new Map(); // 연도 → Promise<Map(개념 → "op"|"nonop"|"both")>
/** FASB SOI 계산 구조 분류 — 세전이익(두 이름) 하위 중 OperatingIncomeLoss 하위 = op, 그 밖 = nonop. 두 곳에 다 걸리면 both */
function soiClass(y) {
  if (!soiMemo.has(y)) soiMemo.set(y, (async () => {
    const x = await fasbText(soiCalUrl(y));
    const out = new Map();
    for (const m of x.matchAll(/<link:calculationLink\b[^>]*>([\s\S]*?)<\/link:calculationLink>/g)) {
      const loc = new Map(), kids = new Map();
      for (const l of m[1].matchAll(/<link:loc\b([^>]*)\/?>/g)) { const lb = /xlink:label=['"]([^'"]+)['"]/.exec(l[1])?.[1], h = /xlink:href=['"][^'"#]*#us-gaap_([^'"]+)['"]/.exec(l[1])?.[1]; if (lb && h) loc.set(lb, h); }
      for (const a of m[1].matchAll(/<link:calculationArc\b([^>]*)\/?>/g)) {
        const fr = loc.get(/xlink:from=['"]([^'"]+)['"]/.exec(a[1])?.[1] ?? ""), to = loc.get(/xlink:to=['"]([^'"]+)['"]/.exec(a[1])?.[1] ?? "");
        if (fr && to) kids.set(fr, [...(kids.get(fr) ?? []), to]);
      }
      const desc = (id, s = new Set()) => { for (const k of kids.get(id) ?? []) if (!s.has(k)) { s.add(k); desc(k, s); } return s; };
      const op = desc("OperatingIncomeLoss");
      const pre = new Set([...desc("IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest"), ...desc("IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments")]);
      const put = (c, v) => out.set(c, out.has(c) && out.get(c) !== v ? "both" : v);
      for (const c of op) put(c, "op");
      for (const c of pre) if (!op.has(c) && c !== "OperatingIncomeLoss") put(c, "nonop");
    }
    if (!out.size) throw new Error(`FASB ${y} SOI 계산 구조 판독 실패`);
    return out;
  })().catch((e) => { soiMemo.delete(y); throw e; }));
  return soiMemo.get(y);
}
/** 표준 개념의 FASB 분류 — 공시 택사노미 연도, 없으면 그 개념이 실린 가장 최근 연도(2018까지). → { c: "op"|"nonop"|"both"|null, year } */
async function fasbClassOf(local, year) {
  for (let y = year; y >= 2018; y--) {
    const m = await soiClass(y);
    if (m.has(local)) return { c: m.get(local), year: y };
  }
  return { c: null, year: null };
}

/**
 * 공시 한 건의 손익계산서 본표 영업이익 구조 → null | { role, type: "F"|"S", opinc, pretax, ... }
 *  - F: 본표(표시 구조)에 영업이익 소계 줄이 있음 — charges(영업이익 식 안 일회성·인수 무형상각 줄, 외부 원인 후보)
 *  - S: 소계 없음 — 세전이익 계산식을 내려가며 FASB 분류로 영업외 줄(items)을 모은다. ifrs: 세전이익이 IFRS 개념(합성 대상 아님),
 *    noCalc: 세전이익 계산식 없음, extNonop: 라벨로 영업외 판정한 회사 고유 줄, dflt: FASB 에 없어 영업(기본값)으로 둔 표준 개념, revLeaf: 총매출 줄
 *  - finRev·finCostSplit: 금융 자회사 표지(본표 금융 수익 줄·금융 멤버) · 금융 원가 본표 분리(금융 멤버가 원가 줄에도 걸림 — IBM)
 */
async function faceOpincLine(cik, accn, revConcept) {
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn.replace(/-/g, "")}`;
  const names = await filingNames(base);
  const xsd = names.find((x) => /\.xsd$/i.test(x));
  const preN = names.find((x) => /_pre\.xml$/i.test(x)) ?? xsd, calN = names.find((x) => /_cal\.xml$/i.test(x)) ?? xsd, labN = names.find((x) => /_lab\.xml$/i.test(x)) ?? xsd;
  const instN = names.find((x) => /_htm\.xml$/i.test(x)) ?? names.find((x) => /\.xml$/i.test(x) && !/_(pre|cal|def|lab)\.xml$|FilingSummary|^R\d+\.xml$/i.test(x));
  if (!preN || !calN) return null;
  const calTxt = await secTextC(`${base}/${calN}`);
  const pres = xbrlLinks(await secTextC(`${base}/${preN}`), "presentation"), cals = xbrlLinks(calTxt, "calculation");
  // 공시가 참조한 us-gaap 택사노미 연도 — 링크베이스 loc 의 href(https://xbrl.fasb.org/us-gaap/2025/elts/us-gaap-2025.xsd#…)
  const taxYear = Number(/xbrl\.fasb\.org\/us-gaap\/(\d{4})\/elts\//.exec(calTxt)?.[1] ?? (await secTextC(`${base}/${preN}`)).match(/xbrl\.fasb\.org\/us-gaap\/(\d{4})\/elts\//)?.[1] ?? 0) || null;
  let labels = null;
  const labelOf = async (id) => { labels ??= labN ? xbrlLabels(await secTextC(`${base}/${labN}`)) : new Map(); return (labels.get(id) ?? []).join(" | "); };
  const nameOf = async (id) => (await labelOf(id)).split(" | ")[0] || id.replace(/^[a-z0-9-]+_/i, "");
  const isRole = (r) => /INCOME|OPERATIONS|EARNINGS/i.test(r) && !/Parenth|Detail|Table|Polic|Tax|Segment|PerShare|Narrative|Schedule/i.test(r);
  const roles = pres.filter((p) => isRole(p.role)).sort((a, b) => Number(/Comprehensive/i.test(a.role)) - Number(/Comprehensive/i.test(b.role)));
  const instUrl = instN ? `${base}/${instN}` : null;
  for (const p of roles) {
    const kidsP = new Map(), hasP = new Set();
    for (const a of p.arcs) { kidsP.set(a.fr, [...(kidsP.get(a.fr) ?? []), a]); hasP.add(a.to); }
    const order = [];
    const walkP = (id, d) => {
      if (d > 14 || order.includes(id)) return;
      order.push(id);
      for (const a of (kidsP.get(id) ?? []).sort((x, y) => x.order - y.order)) walkP(a.to, d + 1);
    };
    for (const r of [...new Set(p.arcs.map((a) => a.fr))].filter((x) => !hasP.has(x))) walkP(r, 0);
    const ids = order.filter((id) => !COGS_EXCL_ID.test(id) && !/^(dei|srt|country|currency|ecd)_/.test(id));
    const opinc = ids.find((id) => OPINC_ID_RE.test(id)) ?? null, pretax = ids.find((id) => PRETAX_ID_RE.test(id)) ?? null;
    if (!opinc && !pretax) continue;
    const finMem = order.some((id) => FIN_MEMBER_RE.test(id));
    const finRev = finMem || ids.some((id) => FIN_REV_ID_RE.test(id));
    const finCostSplit = (finMem && ids.some((id) => /^(us-gaap_(CostOfRevenue|CostOfGoodsAndServicesSold|CostOfServices)|ifrs-full_CostOfSales)$/.test(id))) || ids.some((id) => /CostOfFinanc|FinancingCost/i.test(id));
    const calArcs = cals.find((c) => c.role === p.role)?.arcs ?? cals.filter((c) => isRole(c.role)).flatMap((c) => c.arcs);
    const kids = (id) => calArcs.filter((a) => a.fr === id);
    const common = { role: p.role, opinc, pretax, finRev, finCostSplit, instUrl, taxYear, ids };
    if (opinc) {
      // 영업이익 식 안 일회성·인수 무형상각 줄 — 매칭된 조상이 있으면 그 조상만(이중 합산 방지). w = 영업이익에 대한 부호
      const charges = [];
      const seen = new Set();
      const walk = async (id, w, d) => {
        if (d > 8) return;
        for (const a of kids(id)) {
          if (seen.has(a.to)) continue;
          seen.add(a.to);
          const lab = await nameOf(a.to);
          const kind = OP_AMORT_RE.test(`${a.to} ${lab}`) ? "amort" : OP_CHARGE_RE.test(`${a.to} ${lab}`) && !/\bexclu/i.test(lab) && !GENERAL_COST_ID.test(a.to) /* 라벨의 "~제외" 문구만 — 개념명 ImpairmentOfIntangibleAssetsExcludingGoodwill(PEP)은 손상 줄 */ ? "charge" : null;
          if (kind) { charges.push({ id: a.to, w: w * a.w, label: lab, kind }); continue; }
          // "기타 영업손익" 합산 줄(오너 결정 2026-09-28 — 앱 edgar-oneoff 와 같은 원칙, 검증기 독립 판독): 주석 계산 구조(Details 역할)에
          // 하위 내역이 있으면 그중 일회성 줄을 charges 로(MCD "Impairment and other charges (gains), net" · CL · MU). 줄 자체는 넘어간다
          if (OTHER_OP_ID.test(a.to)) {
            const det = cals.filter((c) => /Detail/i.test(c.role)).flatMap((c) => c.arcs).filter((x) => x.fr === a.to);
            let found = false;
            for (const x of det) {
              if (seen.has(x.to)) continue;
              const l2 = await nameOf(x.to);
              if (!OP_AMORT_RE.test(`${x.to} ${l2}`) && OP_CHARGE_RE.test(`${x.to} ${l2}`) && !/\bexclu/i.test(l2)) { seen.add(x.to); charges.push({ id: x.to, w: w * a.w * x.w, label: `${l2}(주석 — ${lab} 내역)`, kind: "charge" }); found = true; }
            }
            if (found) continue;
          }
          await walk(a.to, w * a.w, d + 1);
        }
      };
      await walk(opinc, 1, 0);
      return { ...common, type: "F", charges };
    }
    if (!/^us-gaap_/.test(pretax)) return { ...common, type: "S", ifrs: true, items: [], extNonop: [], dflt: [], revLeaf: null };
    if (kids(pretax).length < 2) return { ...common, type: "S", noCalc: true, items: [], extNonop: [], dflt: [], revLeaf: null };
    const items = [], extNonop = [], dflt = [];
    let revLeaf = null;
    const seen = new Set();
    const walk = async (id, w, d) => {
      if (d > 8) return;
      for (const a of kids(id)) {
        if (seen.has(a.to)) continue;
        seen.add(a.to);
        const ww = w * a.w, to = a.to, std = /^us-gaap_/.test(to), leaf = !kids(to).length;
        const cls = std && taxYear ? await fasbClassOf(to.slice(8), taxYear) : { c: null, year: null };
        if (!leaf) {
          // 영업외 소계(NonoperatingIncomeExpense·InterestAndDebtExpense 등)는 통째로 — 하위로 내려가지 않는다
          if (cls.c === "nonop") { items.push({ id: to, w: ww, label: await nameOf(to), how: `FASB ${cls.year} 영업외(소계)` }); continue; }
          await walk(to, ww, d + 1);
          continue;
        }
        if (revConcept && to === revConcept) { revLeaf = { id: to, w: ww, label: await nameOf(to) }; continue; }
        if (std) {
          if (cls.c === "nonop") items.push({ id: to, w: ww, label: await nameOf(to), how: `FASB ${cls.year}${cls.year !== taxYear ? `(공시 택사노미 ${taxYear} 계산 구조에 없음 — 실린 최근 연도)` : ""} 영업외` });
          else if (cls.c == null) dflt.push(to.slice(8));
          else if (cls.c === "both") dflt.push(`${to.slice(8)}(FASB 양쪽)`);
          continue;
        }
        const lab = await nameOf(to);
        if (EXT_NONOP_RE.test(lab)) { items.push({ id: to, w: ww, label: lab, how: "회사 고유 줄 — 라벨로 영업외 판정(공통모드)", ext: true }); extNonop.push(`${to}("${lab}")`); }
      }
    };
    await walk(pretax, 1, 0);
    return { ...common, type: "S", items, extNonop, dflt, revLeaf };
  }
  return null;
}

/**
 * 영업이익 SEC 기대값 모델 — 최근 연차보고서 3건(20-F 제출사는 20-F, 분기 없음)·10-Q 4건의 본표. 기간 P 의 기대값 = P 를 공시한 가장 최근
 * 공시의 본표 구조로, 줄 값은 그 기간의 최신 판본(반올림 재태깅 제외 — latestPrecise). 표준 개념은 companyfacts, 회사 고유 개념은 원본(인스턴스).
 *  F: 본표 영업이익 소계 값 · S: 세전이익 − Σ(부호 × 영업외 줄) − (총수익 분리 회사면 총매출 줄 — 호출부가 영업 매출을 더한다)
 * → { annualAt(E), quarterAt(E, isQ4), ltmAt(L), faces } | { why }. 결과: { type, v, vLatest, start, end, faceAccn, charges, items, split, … }
 */
async function secFaceOpinc({ cik, sub, facts, unit, foreign, revFace }) {
  const rc = sub.filings?.recent ?? {};
  const annForm = foreign ? /^(20-F|40-F)$/ : /^10-K$/;
  const picks = [];
  let nK = 0, nQ = 0;
  for (let i = 0; i < (rc.form ?? []).length && (nK < 3 || (!foreign && nQ < 4)); i++) {
    const fm = rc.form[i];
    if (annForm.test(fm) && nK < 3) nK++; else if (!foreign && fm === "10-Q" && nQ < 4) nQ++; else continue;
    picks.push({ accn: rc.accessionNumber[i], form: fm, filed: rc.filingDate[i], report: rc.reportDate[i] });
  }
  const PERIODIC = /^(10-K|10-Q|20-F|40-F)/;
  const cfRows = (id) => { const m = /^(us-gaap|ifrs-full)_(.+)$/.exec(id); return m ? (facts?.[m[1]]?.[m[2]]?.units?.[unit] ?? []).filter((e) => e.start && PERIODIC.test(e.form ?? "")) : []; };
  const inst = new Map(); // 개념 → 원본에서 읽은 기간 값
  const uRe = new RegExp(`unitRef="[^"]*${unit}`, "i");
  const faces = [];
  const split = !!revFace?.split;
  for (const p of picks) {
    const revConcept = revFace?.faces?.find((f) => f.accn === p.accn)?.concept ?? null;
    const fo = await faceOpincLine(cik, p.accn, revConcept);
    if (!fo) continue;
    const f = { ...p, ...fo };
    const ids = fo.type === "F" ? [fo.opinc, ...fo.charges.map((t) => t.id)] : [fo.pretax, ...fo.items.map((t) => t.id), ...(split && fo.revLeaf ? [fo.revLeaf.id] : [])];
    const need = ids.filter((id) => !cfRows(id).some((e) => e.accn === p.accn));
    if (need.length && fo.instUrl) {
      const xml = await secInstance(fo.instUrl);
      const ctx = parseContexts(xml);
      const want = new Set(need), seen = new Set();
      for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*?)contextRef="([^"]+)"([^>]*)>\s*(-?[\d.]+)\s*</g)) {
        const id = `${m[1]}_${m[2]}`;
        if (!want.has(id) || !uRe.test(`${m[3]} ${m[5]}`)) continue;
        const c = ctx.get(m[4]);
        if (!c?.start || !c.end || c.dims.length) continue;
        const k = `${id}|${c.start}|${c.end}|${p.accn}`;
        if (seen.has(k)) continue;
        seen.add(k);
        inst.set(id, [...(inst.get(id) ?? []), { start: c.start, end: c.end, val: Number(m[6]), filed: p.filed, form: p.form, accn: p.accn }]);
      }
    }
    faces.push(f);
  }
  faces.sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? ""));
  if (!faces.length) return { why: `최근 정기공시 ${picks.length}건의 손익계산서 본표에서 영업이익·세전이익 줄을 찾지 못함` };
  const rows = (id) => [...cfRows(id), ...(inst.get(id) ?? [])];
  const dd = (e) => (Date.parse(e.end) - Date.parse(e.start)) / 864e5;
  const lineAt = (f, id, pred) => {
    const rs = rows(id);
    const own = rs.find((e) => e.accn === f.accn && pred(e));
    if (!own) return null;
    const e = latestPrecise(rs.filter((x) => x.start === own.start && x.end === own.end));
    return { val: e.val, start: e.start, end: e.end, filed: e.filed, form: e.form, retag: e.retag ?? null, note: retagNote(e) };
  };
  const one = (f, pred) => {
    const anchorId = f.type === "F" ? f.opinc : f.pretax;
    const a = lineAt(f, anchorId, pred);
    if (!a) return null;
    const same = (e) => e.start === a.start && e.end === a.end;
    const base = { type: f.type, start: a.start, end: a.end, faceAccn: f.accn, finRev: f.finRev, finCostSplit: f.finCostSplit, form: f.form, report: f.report };
    const notes = [a.note].filter(Boolean);
    if (f.type === "F") {
      const charges = f.charges.map((t) => { const x = lineAt(f, t.id, same); if (x?.note) notes.push(x.note); return { id: t.id, label: t.label, kind: t.kind, w: t.w, v: x?.val ?? null }; });
      return { ...base, v: a.val, vLatest: a.retag ? a.retag.val : a.val, charges, how: [`${f.form} ${f.report} 본표 영업이익 소계 ${f.opinc.replace(/^[a-z0-9-]+_/i, "")} ${a.val}`, ...notes, `판본 ${a.form} ${a.filed}`].join(" · ") };
    }
    if (f.ifrs || f.noCalc) return { ...base, v: null, blank: f.ifrs ? `세전이익 줄이 IFRS 개념(${f.pretax}) — 합성 대상 아님` : "세전이익 계산식 없음(계산 구조 하위 줄 1개 이하)", items: [], how: `${f.form} ${f.report}` };
    const items = f.items.map((t) => { const x = lineAt(f, t.id, same); if (x?.note) notes.push(x.note); return { id: t.id, label: t.label, w: t.w, v: x?.val ?? null, how: t.how, ext: !!t.ext }; });
    const zero = items.filter((t) => t.v == null).map((t) => t.label);
    let revTot = null;
    if (split) {
      if (!f.revLeaf) return { err: `${f.form} ${f.report}(${f.accn}) 총수익 분리 회사인데 세전이익 계산식에서 총매출 줄을 못 찾음` };
      const x = lineAt(f, f.revLeaf.id, same);
      if (!x) return { err: `${f.form} ${f.report}(${f.accn}) 총매출 줄 ${f.revLeaf.id} 값 없음` };
      revTot = x.val * f.revLeaf.w;
    }
    const v = a.val - items.reduce((s, t) => s + t.w * (t.v ?? 0), 0) - (revTot ?? 0);
    return {
      ...base, v, pretaxV: a.val, items, revTot, extNonop: f.extNonop, dflt: f.dflt,
      how: [
        `${f.form} ${f.report} 세전이익 ${f.pretax.replace(/^us-gaap_/, "")} ${a.val}`,
        // 영업이익 = 세전이익 − Σ(w × 줄) — 줄마다 식 부호(−w)로 적는다(이자비용처럼 세전이익에서 빠진 줄은 +)
        items.length ? `영업외 되돌림 ${items.map((t) => `${t.w < 0 ? "+" : "−"} ${t.label} ${t.v ?? "값 없음(0)"}[${t.how}]`).join(" ")}` : "영업외 줄 없음",
        revTot != null ? `− 총매출 줄 ${revTot}(영업 매출은 호출부가 더함)` : "",
        zero.length ? `값 없는 줄 0 처리: ${zero.join("·")}` : "",
        f.dflt.length ? `FASB 미등재 표준 개념 영업(기본값): ${f.dflt.join("·")}` : "",
        ...notes, `판본 ${a.form} ${a.filed}`,
      ].filter(Boolean).join(" · "),
    };
  };
  const find = (pred) => { for (const f of faces) { const r = one(f, pred); if (r) return r; } return null; };
  const comb = (xs, label) => {
    if (xs.some(([r]) => !r)) return null;
    const bad = xs.find(([r]) => r.err || r.blank);
    if (bad) return bad[0];
    const types = [...new Set(xs.map(([r]) => r.type))];
    const byId = (key) => (xs[0][0][key] ?? []).filter((p) => xs.every(([r]) => (r[key] ?? []).some((y) => y.id === p.id && y.v != null)))
      .map((p) => ({ ...p, v: xs.reduce((s, [r, k]) => s + k * r[key].find((y) => y.id === p.id).v, 0) }));
    return {
      type: types.join("/"), start: xs[0][0].start, end: xs[0][0].end, finRev: xs.some(([r]) => r.finRev), finCostSplit: xs.every(([r]) => r.finCostSplit),
      v: xs.reduce((s, [r, k]) => s + k * r.v, 0),
      vLatest: xs.every(([r]) => r.vLatest != null) ? xs.reduce((s, [r, k]) => s + k * r.vLatest, 0) : null,
      pretaxV: xs.every(([r]) => r.pretaxV != null) ? xs.reduce((s, [r, k]) => s + k * r.pretaxV, 0) : null,
      revTot: xs.every(([r]) => r.revTot != null) ? xs.reduce((s, [r, k]) => s + k * r.revTot, 0) : null,
      charges: byId("charges"), items: byId("items"), extNonop: [...new Set(xs.flatMap(([r]) => r.extNonop ?? []))], dflt: [...new Set(xs.flatMap(([r]) => r.dflt ?? []))],
      how: `${label} — ${xs.map(([r, k]) => `${k < 0 ? "− " : ""}[${r.how}]`).join(" ")}`,
    };
  };
  const annualAt = (E) => find((e) => dayDiff(e.end, E) <= 7 && dd(e) >= 300 && dd(e) <= 400);
  const quarterAt = (E, isQ4) => {
    if (!isQ4) return recastQ1V({
      dd,
      facesOf: (pred) => faces.map((f) => ({ accn: f.accn, filed: f.filed ?? "", form: f.form, r: one(f, pred) })).filter((x) => x.r && !x.r.err && !x.r.blank && x.r.start),
      derive: (y, d, label) => comb([[y, 1], [d, -1]], label),
      keys: [{ name: "", get: (r) => r.v, put: (o, dr) => Object.assign(o, dr) }],
    }, find((e) => dayDiff(e.end, E) <= 3 && dd(e) >= 80 && dd(e) <= 100));
    const fy = annualAt(E);
    if (!fy || fy.err || fy.blank) return fy;
    const nine = find((e) => dayDiff(e.start, fy.start) <= 5 && dd(e) >= 250 && dd(e) <= 290 && e.end < fy.end);
    return comb([[fy, 1], [nine, -1]], "사업연도 − 9개월");
  };
  const ltmAt = (L, old = false) => {
    const fy0 = annualAt(L);
    if (fy0) return fy0;
    const qsum = old ? null : faceQuarterSum(L, { find, dd, annualAt, quarterAt, comb });
    if (qsum) return qsum;
    const fy = find((e) => dd(e) >= 300 && dd(e) <= 400 && e.end < L && (Date.parse(L) - Date.parse(e.end)) / 864e5 < 370);
    if (!fy || fy.err || fy.blank) return fy;
    const s = new Date(Date.parse(fy.end) + 864e5).toISOString().slice(0, 10);
    const cur = find((e) => dayDiff(e.start, s) <= 5 && dayDiff(e.end, L) <= 3);
    if (!cur) return null;
    const ys = (d) => new Date(Date.parse(d) - 365 * 864e5).toISOString().slice(0, 10);
    const prior = find((e) => dayDiff(e.start, ys(cur.start)) <= 7 && dayDiff(e.end, ys(L)) <= 7 && Math.abs(dd(e) - dd(cur)) <= 10);
    return comb([[fy, 1], [cur, 1], [prior, -1]], "분기 4개 구성 불가 — 종전 식: 사업연도 + 당기 누적 − 전년 동기");
  };
  // 그 사업연도 자기 10-K 의 본표로 판독(일회성 줄 대조용 — 최신 10-K 는 과거 연도 줄 구성을 바꿀 수 있다: PEP 2022 무형자산 손상 줄, WDC FY2024 소송 손실 줄)
  const ownAnnualAt = (E) => { const pred = (e) => dayDiff(e.end, E) <= 7 && dd(e) >= 300 && dd(e) <= 400; for (const f of faces) if (f.report && dayDiff(f.report, E) <= 7 && /^10-K/.test(f.form ?? "")) { const r = one(f, pred); if (r) return r; } return null; };
  return { annualAt, ownAnnualAt, quarterAt, ltmAt, faces, split };
}
// ▲ 영업이익 판독 구획 ────────────────────────────────────────────────────────────────────────────────────

// ▼ 감가상각비 판독 구획(2026-09-27, --metric=da — 지표 미종결) ────────────────────────────────────────────────────────
// 앱(src/lib/markets/us/edgar-cf-structure.ts)은 공시마다 현금흐름표 계산 구조(영업활동 조정 항목)의 감가상각·상각 줄 합을 쓴다(손상 포함 줄은
// 손상, 중단사업 포함 현금흐름표는 중단사업 감가상각을 원본 태그로 뺀다 · NFLX 는 콘텐츠 상각 줄 포함 — 오너 결정). 검증기는 앱 모듈을 import
// 하지 않고 공시 원본을 따로 읽는다 — 최근 10-K 3건·10-Q 4건 + 앱 열이 그 밖이면 그 기간을 실은 공시를 과거 목록 파일까지 더 읽는다.
// 기간 P 의 기대값 = P 를 실은 가장 최근 공시의 본표 줄 구성, 줄 값은 P 를 실은 공시들의 decimals 판정(decimalsVintage — 정밀도만 낮춘 재게시는
// 앞선 정밀값). 현금흐름표는 누적이라 분기 = 누적 차(Q1 은 3개월 그대로, Q4 = 사업연도 − 9개월), LTM = 최근 4개 분기 합(분기 못 채우면 종전 식 — 사업연도 + 당기 누적 − 전년 동기, 오너 결정 2026-09-28).
// 줄 선택 정규식은 앱과 같은 성격이라 이 A층은 공통모드 사유가 붙는다(외부 정확 일치 시만 독립 — commonModeOf).
const CF_DA_RE = /deprecia|amorti[sz]/i;
const CF_DA_EXCL = /debt|discount|premium|issuance|financing\s*costs?|deferred\s*(financing|charges)|stock|share-?based|compensation|operating[\s-]*lease|lease\s*expense|content|contract\s*(cost|acquisition)|capitalized\s*software|investment|securities|bond|inventory|incentive|acquisition\s*costs|defined\s*benefit|pension|postretirement/i;
// 20-F IFRS(TSM·SPOT) 영업활동 루트 = ifrs-full_CashFlowsFromUsedInOperatingActivities(오너 결정 2026-09-27 — 20-F 현금흐름표 대조 추가)
const CF_OP_ROOT = /^(us-gaap_NetCashProvidedByUsedInOperatingActivities(ContinuingOperations)?|ifrs-full_CashFlowsFromUsedInOperatingActivities)$/;
const CF_STD = /^(us-gaap|ifrs-full)_/;
/** 콘텐츠 상각 줄(NFLX — 오너 결정: 감가상각비에 포함). 콘텐츠 자산 취득·부채 증감 줄은 제외 */
const CF_CONTENT_RE = /content/i, CF_CONTENT_EXCL = /addition|payment|change|increase|decrease|liabilit/i;
/** 감가상각비에 넣지 않는 현금흐름표 줄 중 외부 소스가 넣을 수 있는 후보(외부 정의 분해 — 주식보상) */
const CF_SBC_RE = /^us-gaap_ShareBasedCompensation$/;
const DA_NM = (id) => id.replace(/^[a-z0-9-]+_/i, "");
/**
 * 현금흐름표 계산 구조 → { role, lines, excl: [{id,label}], impairLines, separateImpair, continuing, labelOf } | null(영업활동 루트 없음).
 * lines = 감가상각·상각 줄(표준 개념은 개념명, 회사 고유 개념은 라벨로 판정 · 주 라벨이 "Depreciation…"/"Amortization of intangible…" 이면
 * 제외어가 있어도 포함), content = true 면 콘텐츠 상각 줄도 lines 에. excl = 제외된 감가상각·상각 성격 줄 + 주식보상 줄(F층 분해 후보)
 */
function cfDaStruct(cal, labels, content) {
  for (const c of xbrlLinks(cal, "calculation")) {
    if (!/CASHFLOW/i.test(c.role) || /Detail|Table|Parenth|Supplement/i.test(c.role)) continue;
    const root = c.arcs.find((a) => CF_OP_ROOT.test(a.fr))?.fr;
    if (!root) continue;
    const lines = [], excl = [], impairLines = [], separateImpair = [], parentOf = new Map(), seen = new Set();
    const walk = (id, depth) => {
      if (depth > 3) return;
      for (const a of c.arcs) {
        if (a.fr !== id || seen.has(a.to)) continue;
        seen.add(a.to);
        const std = CF_STD.test(a.to);
        const labs = labels.get(a.to) ?? [];
        const text = std ? a.to.replace(CF_STD, "") : labs.join(" | ") || a.to;
        const leads = !std && labs.some((l) => /^(depreciation|amorti[sz]ation of (acquired |acquisition-related )?intangible)/i.test(l));
        const isContent = content && CF_DA_RE.test(text) && CF_CONTENT_RE.test(text) && !CF_CONTENT_EXCL.test(text);
        const isDa = isContent || (CF_DA_RE.test(text) && (!CF_DA_EXCL.test(text) || leads));
        if (/impair/i.test(`${a.to} ${labs.join(" ")}`)) (isDa ? impairLines : separateImpair).push(a.to);
        if (isDa) { lines.push(a.to); parentOf.set(a.to, id); continue; }
        if (CF_DA_RE.test(text) || CF_SBC_RE.test(a.to)) excl.push({ id: a.to, label: labs[0] ?? DA_NM(a.to) });
        walk(a.to, depth + 1);
      }
    };
    walk(root, 0);
    const up = new Map(c.arcs.map((a) => [a.to, a.fr]));
    const contOf = (id) => {
      for (let p = parentOf.get(id), k = 0; p && k < 6; p = up.get(p), k++) {
        if (/ContinuingOperations$/.test(p)) return true;
        if (c.arcs.some((a) => a.fr === p && /^us-gaap_(IncomeLossFromContinuingOperations|IncomeLossFromDiscontinuedOperations|DiscontinuedOperationIncomeLossFromDiscontinuedOperation)/.test(a.to))) return true;
      }
      return false;
    };
    return {
      role: c.role, lines, excl, impairLines,
      separateImpair: separateImpair.filter((x) => !/inventor/i.test(`${x} ${(labels.get(x) ?? []).join(" ")}`)),
      continuing: lines.length > 0 && lines.every(contOf),
      labelOf: (id) => (labels.get(id) ?? [])[0] ?? DA_NM(id),
    };
  }
  return null;
}
/** 공시 한 건의 현금흐름표 감가상각 판독 — 구조 + 원본 인스턴스의 줄 값(차원 없음, decimals 포함)·손상·중단사업 사실 */
/** 제외 항목 개념 — 포함 개념으로 태깅된 현금흐름표 줄의 짝(같은 공시·모든 기간 값이 같으면 제외 항목, HLT) */
const CF_EXCL_TWINS = ["AmortizationOfAcquisitionCosts", "CapitalizedContractCostAmortization"];
async function cfDaFace(cik, p, content, unitRe = /usd/i) {
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${p.accn.replace(/-/g, "")}`;
  const names = await filingNames(base);
  const xsd = names.find((x) => /\.xsd$/i.test(x));
  const calN = names.find((x) => /_cal\.xml$/i.test(x)) ?? xsd, labN = names.find((x) => /_lab\.xml$/i.test(x)) ?? xsd;
  const instN = names.find((x) => /_htm\.xml$/i.test(x)) ?? names.find((x) => /\.xml$/i.test(x) && !/_(pre|cal|def|lab)\.xml$|FilingSummary|^R\d+\.xml$/i.test(x));
  if (!calN || !instN) return { ...p, why: `공시 파일 없음(계산 ${!!calN}·인스턴스 ${!!instN})` };
  const labels = labN ? xbrlLabels(await secTextC(`${base}/${labN}`)) : new Map();
  const st = cfDaStruct(await secTextC(`${base}/${calN}`), labels, content);
  if (!st) return { ...p, why: "현금흐름표 계산 구조(영업활동 루트) 없음" };
  if (!st.lines.length) return { ...p, why: "현금흐름표 영업활동 조정 항목에 감가상각·상각 줄 없음" };
  const xml = await secInstance(`${base}/${instN}`);
  const ctx = parseContexts(xml);
  const want = new Set([...st.lines, ...st.excl.map((t) => t.id), ...CF_EXCL_TWINS.map((t) => `us-gaap_${t}`)]);
  const vals = new Map(), periods = new Set(), adj = [], dupA = new Set(), cfPeriods = new Set();
  for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*?)contextRef="([^"]+)"([^>]*)>\s*(-?[\d.]+)\s*</g)) {
    const id = `${m[1]}_${m[2]}`, attrs = `${m[3]} ${m[5]}`;
    if (!unitRe.test(/unitRef="([^"]*)"/.exec(attrs)?.[1] ?? "")) continue;
    const c = ctx.get(m[4]);
    if (!c?.start || !c.end) continue;
    const v = Number(m[6]);
    if (want.has(id) && !c.dims.length) {
      const k = `${id}|${c.start}|${c.end}`;
      if (!vals.has(k)) {
        const d = /decimals="([^"]+)"/.exec(attrs)?.[1];
        vals.set(k, { val: v, dec: d == null ? null : /^INF$/i.test(d) ? Infinity : Number(d) });
        if (st.lines.includes(id)) periods.add(`${c.start}|${c.end}`);
      }
    }
    if (/Impair|WriteDown|Writeoff|WriteOff|Discontinued|DisposalGroup/i.test(m[2])) {
      const k = `${id}|${c.start}|${c.end}|${c.dims.flat().join(",")}`;
      if (!dupA.has(k)) { dupA.add(k); adj.push({ id, start: c.start, end: c.end, dims: c.dims, v }); }
    }
    if (CF_OP_ROOT.test(id) && !c.dims.length) cfPeriods.add(`${c.start}|${c.end}`);
  }
  // 현금흐름표 기간만(이 공시 원본에서 영업활동 현금흐름이 실린 기간) — 감가상각 줄 개념이 주석에만 실은 기간(ISRG 10-Q 무형상각 3개월
  // 3.2M, HLT 10-Q 감가상각 3개월 값)은 현금흐름표 줄 값이 아니다(2026-09-27, 앱 import 없이 원본에서 독립 판정)
  for (const k of [...vals.keys()]) if (!cfPeriods.has(k.slice(k.indexOf("|") + 1))) vals.delete(k);
  for (const k of [...periods]) if (!cfPeriods.has(k)) periods.delete(k);
  // 태그만 다른 제외 항목(2026-09-29, 앱 edgar-cf-structure 와 같은 원칙 — 원본에서 독립 판정): 포함 개념 줄이 같은 공시의 제외 항목 개념
  // (계약획득원가 상각)과 이 공시 현금흐름표의 모든 기간에서 값이 정확히 같으면 그 제외 항목이다(HLT 10-Q AmortizationOfIntangibleAssets = AmortizationOfAcquisitionCosts)
  for (const id of [...st.lines]) {
    if (!id.startsWith("us-gaap_") || st.lines.length < 2 || !periods.size) continue;
    const twin = CF_EXCL_TWINS.map((t) => `us-gaap_${t}`).find((t) => t !== id && [...periods].every((pp) => vals.get(`${id}|${pp}`) && vals.get(`${t}|${pp}`)?.val === vals.get(`${id}|${pp}`).val)
      && [...periods].some((pp) => vals.get(`${id}|${pp}`).val !== 0));
    if (!twin) continue;
    st.lines = st.lines.filter((x) => x !== id);
    st.excl = [...st.excl, { id, label: (st.labelOf?.(id) ?? DA_NM(id)) }];
    st.proof = [st.proof, `${DA_NM(id)} = 같은 공시 ${DA_NM(twin)} (현금흐름표 모든 기간 ${[...periods].map((pp) => vals.get(`${id}|${pp}`).val).join("·")}) — 제외 항목`].filter(Boolean).join(" · ");
  }
  return { ...p, ...st, vals, periods, adj };
}
/** 한 기간 조정 — 손상 포함 줄이면 손상 금액, 중단사업 포함 현금흐름표면 중단사업 감가상각(10-K·10-Q 원본 태그). 규칙은 앱과 같은 성격(공통모드) */
/** 그 기간에 중단사업 영업이 있었는가(2026-10-01 IBM — Kyndryl 2021 분리): 기간 시작 직전(전년 말)·기간 안 어느 시점이든 재무상태표 중단사업 자산(모든 공시 판본)이
 *  0 보다 크면 영업 있음. 시작일을 모르면(start null) 종료일 1년 전부터. 종목마다 verifyUs 가 CUR_G(SEC companyfacts us-gaap)를 채운다 */
let CUR_G = null;
function discOpsDuring(start, end) {
  if (!CUR_G) return true; // 모르면 보수적으로 영업 있음(종전 판정 유지)
  const s0 = Date.parse(start ?? end) - (start ? 7 : 372) * 864e5, e0 = Date.parse(end) + 7 * 864e5;
  return Object.entries(CUR_G).some(([c, o]) => /^(AssetsOfDisposalGroupIncludingDiscontinuedOperation\w*|DisposalGroupIncludingDiscontinuedOperationAssets\w*)$/.test(c)
    && (o.units?.USD ?? []).some((x) => !x.start && x.val > 0 && Date.parse(x.end) >= s0 && Date.parse(x.end) <= e0));
}
function cfDaAdjust(f, s, e, sum) {
  const at = f.adj.filter((x) => x.start === s && x.end === e);
  let amt = 0, unres = null;
  const notes = [];
  const isDiscDa = (id) => /Discontinued|DisposalGroup/.test(DA_NM(id)) && /Depreciation\w*Amortization/.test(DA_NM(id)) && !/Accumulated|PerShare/.test(DA_NM(id));
  const isDiscNi = (id) => /^us-gaap_(IncomeLossFromDiscontinuedOperations|DiscontinuedOperationIncomeLossFromDiscontinuedOperation)/.test(id) && !/Share/.test(id);
  // 손상 포함 줄은 줄 값 그대로 — 손상을 빼지 않는다(오너 결정 2026-09-28: 손상이 영업이익 안에 있으면 감가상각비에 넣는다, 미국은 ASC 360 으로 영업이익 안)
  if (!f.continuing) {
    let disc = null;
    for (const id of new Set(at.filter((x) => isDiscDa(x.id)).map((x) => x.id))) {
      const fs = at.filter((x) => x.id === id);
      let v = fs.find((x) => !x.dims.length)?.v;
      if (v == null) {
        const g = new Map();
        for (const x of fs) { const d = x.dims.find((y) => /DisposalGroups?Including|ByDisposalGroup/i.test(y[0])) ?? x.dims[0]; if (d && !g.has(d[1])) g.set(d[1], x.v); }
        if (g.size) v = [...g.values()].reduce((p, q) => p + q, 0);
      }
      if (v != null) disc = Math.max(disc ?? 0, v);
    }
    const discNi = at.some((x) => isDiscNi(x.id) && !x.dims.length && x.v !== 0);
    if (disc != null && disc > 0 && disc < sum - amt) { amt += disc; notes.push(`중단사업 감가상각 ${disc} 차감(현금흐름표가 중단사업 포함 · 공통모드(규칙 재구현 — 중단사업 태그·차원 판정이 앱과 같은 규칙))`); }
    // 중단사업에 영업이 없는 기간(매출·원가·영업/투자현금흐름 공시가 없거나 0 — 분리 뒤 세금·정산 잔여 손익만, IBM 2022~ Kyndryl) = 중단사업 감가상각 0(2026-10-01)
    else if (discNi && !(disc > 0) && !discOpsDuring(s, e)) notes.push("중단사업 손익은 있으나 영업 없음(기초·기중 재무상태표에 중단사업 자산 없음 — 분리 뒤 정산 잔여) — 중단사업 감가상각 0");
    else if (discNi && !(disc > 0)) unres = unres ?? "중단사업 손익이 있는데 중단사업 감가상각 태그 없음 — 계속사업 감가상각 확인 불가";
  }
  return { amt, unres, note: notes.join(" · ") };
}
/**
 * 감가상각비 SEC 기대값 모델 → { annualAt(E), quarterAt(E, isQ4), ltmAt(L), extend(E, kind), faces } | { why }.
 * 결과: { v(조정 후 · decimals 판본), vLatest(최신 공시 값 그대로), lineSum, adj, unres?, start, end, lines, excl, comps, how }
 */
/** 앱 edgar-ev.ts DA_LTM_FALLBACK 과 같은 문구 — LTM 감가상각비 분기 합이 기준 혼합이라 종전 식으로 낸 칸의 주석 */
const DA_LTM_FALLBACK = "분기 기준 혼합 — 사업연도 + 당기 누적 − 전년 동기 식";
async function secFaceDa({ cik, sub, content, natCur = null }) {
  // 20-F: 원통화 단위·연차보고서만(분기 현금흐름표 없음 — LTM 은 "20-F LTM = Yahoo 분기" 검사가 따로 본다)
  const unitRe = natCur ? new RegExp(natCur, "i") : /usd/i;
  const annualForm = natCur ? /^20-F$/ : /^10-K$/;
  const rc = sub.filings?.recent ?? {};
  const picks = [];
  let nK = 0, nQ = 0;
  for (let i = 0; i < (rc.form ?? []).length && (nK < 3 || nQ < 4); i++) {
    const fm = rc.form[i];
    if (annualForm.test(fm) && nK < 3) nK++; else if (!natCur && fm === "10-Q" && nQ < 4) nQ++; else continue;
    picks.push({ accn: rc.accessionNumber[i], form: fm, filed: rc.filingDate[i], report: rc.reportDate[i] });
  }
  const faces = [], skipped = [], read = new Set();
  const addFiling = async (p) => {
    if (read.has(p.accn)) return;
    read.add(p.accn);
    const f = await cfDaFace(cik, p, content, unitRe);
    if (f.why) skipped.push({ form: p.form, report: p.report, why: f.why, txt: `${p.form} ${p.report}: ${f.why}` }); else faces.push(f);
    faces.sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? ""));
  };
  for (const p of picks) await addFiling(p);
  // 읽은 범위 밖 기간 — 그 기간을 실은 정기공시(원공시 + 비교 기간으로 다시 실은 후속 공시)를 더 읽는다. recent 밖이면 과거 목록 파일까지
  const pages = [rc], olderLoaded = new Set();
  const extend = async (E, kind) => {
    const t = Date.parse(E), day = 864e5;
    const want = (form, rep) => {
      const d = (Date.parse(rep) - t) / day;
      if (kind === "FY") return annualForm.test(form) && d >= -7 && d <= 800;
      return (form === "10-Q" && d >= -100 && d <= 400) || (form === "10-K" && d >= -100 && d <= 400);
    };
    const oldest = (rc.filingDate ?? []).at(-1) ?? "";
    for (const f of oldest > E ? sub.filings?.files ?? [] : []) {
      if (olderLoaded.has(f.name) || (f.filingTo ?? "") < E) continue;
      olderLoaded.add(f.name);
      pages.push(await secJson(`https://data.sec.gov/submissions/${f.name}`));
    }
    const more = [];
    for (const pg of pages)
      for (let i = 0; i < (pg.form ?? []).length; i++)
        if (!read.has(pg.accessionNumber[i]) && pg.reportDate[i] && want(pg.form[i], pg.reportDate[i]))
          more.push({ accn: pg.accessionNumber[i], form: pg.form[i], filed: pg.filingDate[i], report: pg.reportDate[i] });
    // 기간에 가까운 공시부터(원공시 → 후속 공시)
    more.sort((a, b) => Math.abs(Date.parse(a.report) - t) - Math.abs(Date.parse(b.report) - t));
    for (const p of more.slice(0, kind === "FY" ? 3 : 4)) await addFiling(p);
    proveBasis(); // 새로 읽은 공시까지 기준 증명 다시
  };
  if (!faces.length) return { why: `최근 정기공시 ${picks.length}건 현금흐름표 판독 실패 — ${skipped.map((x) => x.txt).join(" · ")}` };
  const dd = (e) => (Date.parse(e.end) - Date.parse(e.start)) / 864e5;
  /** 줄 id 의 기간 값 — 그 기간을 실은 공시들의 decimals 판정(정밀도만 낮춘 재게시는 앞선 정밀값) */
  const lineVal = (id, s, e) => {
    const fs = [];
    for (const g of faces) { const x = g.vals.get(`${id}|${s}|${e}`); if (x) fs.push({ accn: g.accn, filed: g.filed, val: x.val, dec: x.dec }); }
    if (!fs.length) return null;
    const latest = [...fs].sort((a, b) => b.filed.localeCompare(a.filed))[0];
    const dv = decimalsVintage(fs);
    if (dv.ok) return { val: dv.val, latest: latest.val, note: dv.represented.length || dv.restated.length ? `${DA_NM(id)} 판본 decimals: ${dv.txt}` : "" };
    return { val: latest.val, latest: latest.val, note: `${DA_NM(id)} 판본 decimals 판정 불가(${dv.why}) — 최신 공시 값` };
  };
  const one = (f, pred) => {
    let p = null;
    for (const k of f.periods) { const [s, e] = k.split("|"); if (pred({ start: s, end: e })) { p = { start: s, end: e }; break; } }
    if (!p) return null;
    let sum = 0, sumL = 0;
    const lines = [], zero = [], notes = [];
    for (const id of f.lines) {
      const x = lineVal(id, p.start, p.end);
      if (!x) { zero.push(DA_NM(id)); continue; }
      sum += x.val; sumL += x.latest;
      lines.push({ id, label: f.labelOf(id), v: x.val });
      if (x.note) notes.push(x.note);
    }
    const excl = f.excl.map((t) => ({ ...t, v: lineVal(t.id, p.start, p.end)?.val ?? null }));
    const a = cfDaAdjust(f, p.start, p.end, sum);
    return {
      v: sum - a.amt, vLatest: sumL - a.amt, lineSum: sum, adj: a.amt, adjNote: a.note, unres: a.unres, start: p.start, end: p.end, faceAccn: f.accn,
      lines, excl, comps: [{ start: p.start, end: p.end, k: 1, faceAccn: f.accn }],
      how: [`${f.form} ${f.report} 현금흐름표 줄 ${lines.map((t) => `${DA_NM(t.id)} ${t.v}`).join(" + ")}${content ? "(콘텐츠 상각 줄 포함 — 오너 결정)" : ""}`,
        zero.length ? `그 기간 값 없는 줄 0: ${zero.join("·")}` : "", a.note, f.proof ?? "", ...notes].filter(Boolean).join(" · "),
    };
  };
  const find = (pred) => { for (const f of faces) { const r = one(f, pred); if (r) return r; } return null; };
  // ── 구성 공시 간 감가상각 줄 기준 혼합(2026-09-27 — 매출원가 기준 혼합과 같은 원칙, 앱 import 없이 원본에서 독립 판정) ──
  // 파생 열(누적 차·Q4·LTM)의 구성분이 서로 다른 공시의 현금흐름표 줄 구성으로 계산됐으면, 두 줄 구성의 합을 두 구성의 줄이 모두
  // **현금흐름표에 실린** 같은 기간에서 비교한다(줄 값은 그 줄을 현금흐름표에 실은 공시의 값만 — 주석 전용 값 제외). 합이 다르면
  // (decimals 반올림 범위 밖) 한 열 = 한 기준이 깨진다 — 정답은 "앱 빈칸 + 기준 혼합". 합이 같은 개명(ISRG 회사 고유 개념 ↔ 표준 개념이
  // 같은 금액)은 혼합 아님. 예: HLT 10-Q 는 계약획득원가 상각을 감가상각 줄(AmortizationOfIntangibleAssets)로, 10-K 는 제외 줄
  // (AmortizationOfAcquisitionCosts)로 실어 2025 9개월 합이 10-K 구성 130 · 10-Q 구성 172
  const cfLineAt = (id, p) => {
    for (const g of faces) {
      if (!g.lines.includes(id) || !g.periods.has(p)) continue;
      const x = g.vals.get(`${id}|${p}`);
      if (x) return x;
    }
    return null;
  };
  const mixCache = new Map();
  // ── 기준 증명(오너 결정 2026-09-29 — 앱 edgar-cf-structure.ts 와 같은 규칙, 독립 구현) ── 나중 공시가 줄을 합쳐 과거 기간을 다시 실었고(ISRG FY2025 10-K~
  // isrg:AmortizationOfIntangibleAssetsContractAcquisitionAndOtherAssets) 그 값이 옛 공시의 줄 합(제외했던 상각 줄 포함 — 2025 10-Q AmortizationOfIntangibleAssets +
  // CapitalizedContractCostAmortization)과 정확히 같으면 같은 기준 — 옛 공시(와 같은 줄 구성의 공시)에 그 제외 줄을 더한다(모든 기간에 값이 있을 때만)
  const lines0 = new Map();
  const proveBasis = () => {
    for (const f of faces) if (!lines0.has(f.accn)) lines0.set(f.accn, f.lines);
    for (const f of faces) { f.lines = lines0.get(f.accn); f.proof = null; }
    const keyOf = (f) => [...lines0.get(f.accn)].sort().join("+");
    const proven = new Map();
    for (const A of faces) {
      if (proven.has(keyOf(A))) continue;
      const cand = A.excl.map((t) => t.id).filter((id) => CF_DA_RE.test(DA_NM(id)));
      if (!cand.length) continue;
      search: for (const B of faces) {
        if ((B.filed ?? "") <= (A.filed ?? "")) continue;
        const LA = lines0.get(A.accn), LB = lines0.get(B.accn);
        const onlyB = LB.filter((l) => !LA.includes(l)), onlyA = LA.filter((l) => !LB.includes(l));
        if (!onlyB.length) continue;
        for (const per of A.periods) {
          if (!B.periods.has(per)) continue;
          const vb = onlyB.map((id) => B.vals.get(`${id}|${per}`)?.val), va = onlyA.map((id) => A.vals.get(`${id}|${per}`)?.val);
          if (vb.some((v) => v == null) || va.some((v) => v == null)) continue;
          const sb = vb.reduce((t, v) => t + v, 0), sa = va.reduce((t, v) => t + v, 0);
          const ex = cand.filter((id) => A.vals.has(`${id}|${per}`));
          for (let m = 1; m < 1 << Math.min(ex.length, 4); m++) {
            const sub = ex.filter((_, i) => m & (1 << i));
            const sx = sa + sub.reduce((t, id) => t + A.vals.get(`${id}|${per}`).val, 0);
            if (Math.abs(sx - sb) < 0.5) {
              proven.set(keyOf(A), { sub, ev: `${B.form} ${B.report} ${onlyB.map(DA_NM).join("+")} ${sb} = ${A.form} ${A.report} ${[...onlyA, ...sub].map(DA_NM).join("+")} ${sx}(${per.replace("|", "~")})` });
              break search;
            }
          }
        }
      }
    }
    for (const f of faces) {
      const pr = proven.get(keyOf(f));
      if (!pr || ![...f.periods].every((per) => pr.sub.every((id) => f.vals.has(`${id}|${per}`)))) continue;
      f.lines = [...lines0.get(f.accn), ...pr.sub];
      f.proof = `기준 증명(합친 줄 = 옛 줄 합, 제외 줄 ${pr.sub.map(DA_NM).join("·")} 포함): ${pr.ev}`;
    }
    mixCache.clear();
  };
  proveBasis();
  const mixOf = (fa, fb) => {
    if (fa.accn === fb.accn) return null;
    const key = [fa.accn, fb.accn].sort().join("|");
    if (mixCache.has(key)) return mixCache.get(key);
    let res = null;
    if (!(fa.lines.length === fb.lines.length && fa.lines.every((l) => fb.lines.includes(l)))) {
      const all = [...new Set(faces.flatMap((g) => [...g.periods]))].sort();
      for (const p of all) {
        const va = fa.lines.map((id) => cfLineAt(id, p)), vb = fb.lines.map((id) => cfLineAt(id, p));
        if (va.some((x) => !x) || vb.some((x) => !x)) continue;
        const sa = va.reduce((t, x) => t + x.val, 0), sb = vb.reduce((t, x) => t + x.val, 0);
        // decimals 반올림 재게시 허용 — 두 구성의 줄 값 각자의 반올림 반폭 합(decimals 없음·INF 는 0)
        const tol = [...va, ...vb].reduce((t, x) => t + (x.dec == null || !Number.isFinite(x.dec) ? 0 : 0.5 * 10 ** -x.dec), 0);
        if (Math.abs(sa - sb) > tol + 0.5) {
          const [s0, e0] = p.split("|");
          res = `${fa.form} ${fa.report} 줄 구성(${fa.lines.map(DA_NM).join("+")}) 합 ${sa} ≠ ${fb.form} ${fb.report} 줄 구성(${fb.lines.map(DA_NM).join("+")}) 합 ${sb} (${s0}~${e0}, 현금흐름표 실린 값)`;
          break;
        }
      }
    }
    mixCache.set(key, res);
    return res;
  };
  const comb = (xs, label) => {
    if (xs.some(([r]) => !r)) return null;
    const u = xs.find(([r]) => r.unres);
    const byId = (key) => (xs[0][0][key] ?? []).filter((t) => xs.every(([r]) => (r[key] ?? []).some((y) => y.id === t.id && y.v != null)))
      .map((t) => ({ ...t, v: xs.reduce((s, [r, k]) => s + k * r[key].find((y) => y.id === t.id).v, 0) }));
    const sum = (key) => xs.reduce((s, [r, k]) => s + k * r[key], 0);
    return {
      v: sum("v"), vLatest: sum("vLatest"), lineSum: sum("lineSum"), adj: sum("adj"), unres: u ? u[0].unres : null, start: xs[0][0].start, end: xs[0][0].end,
      lines: byId("lines"), excl: byId("excl"), comps: xs.flatMap(([r, k]) => r.comps.map((c) => ({ ...c, k: c.k * k }))),
      mix: (() => {
        const fs = [...new Set(xs.flatMap(([r]) => r.comps.map((c) => c.faceAccn)))].map((a) => faces.find((g) => g.accn === a)).filter(Boolean);
        for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) { const m = mixOf(fs[i], fs[j]); if (m) return m; }
        return null;
      })(),
      how: `${label} — ${xs.map(([r, k]) => `${k < 0 ? "− " : ""}[${r.start}~${r.end} ${r.v}: ${r.how}]`).join(" ")}`,
    };
  };
  const annualAt = (E) => find((e) => dayDiff(e.end, E) <= 7 && dd(e) >= 300 && dd(e) <= 400);
  const quarterAt = (E, isQ4) => {
    if (isQ4) {
      const fy = annualAt(E);
      if (!fy) return null;
      const nine = find((e) => dayDiff(e.start, fy.start) <= 5 && dd(e) >= 250 && dd(e) <= 290 && e.end < fy.end);
      return comb([[fy, 1], [nine, -1]], "사업연도 − 9개월");
    }
    const q = find((e) => dayDiff(e.end, E) <= 3 && dd(e) >= 80 && dd(e) <= 100);
    if (q) return recastQ1V({
      dd,
      facesOf: (pred) => faces.map((f) => ({ accn: f.accn, filed: f.filed ?? "", form: f.form, r: one(f, pred) })).filter((x) => x.r && x.r.start),
      derive: (y, d, label) => comb([[y, 1], [d, -1]], label),
      keys: [{ name: "", get: (r) => r.v, put: (o, dr) => Object.assign(o, dr) }],
    }, { ...q, how: `3개월 ${q.how}` });
    const cum = find((e) => dayDiff(e.end, E) <= 3 && dd(e) > 100 && dd(e) <= 290);
    if (!cum) return null;
    const prev = find((e) => dayDiff(e.start, cum.start) <= 5 && e.end < cum.end && dd(e) >= dd(cum) - 100 && dd(e) <= dd(cum) - 80);
    return comb([[cum, 1], [prev, -1]], "분기 = 누적 차(현금흐름표 누적)");
  };
  const ltmAt = (L, old = false) => {
    const fy0 = annualAt(L);
    if (fy0) return fy0;
    const qsum = old ? null : faceQuarterSum(L, { find, dd, annualAt, quarterAt, comb });
    // 분기 합 구성 공시끼리 기준 혼합(기준 증명 못 함)이면 종전 식 — 그 구성 공시가 한 기준일 때만, 앱 칸 주석 DA_LTM_FALLBACK(오너 결정 2026-09-29)
    if (qsum?.mix) {
      const o = ltmAt(L, true);
      if (o && !o.mix) return { ...o, fallback: DA_LTM_FALLBACK, how: `${DA_LTM_FALLBACK} — 분기 합은 기준 혼합(${qsum.mix}) · ${o.how}` };
    }
    if (qsum) return qsum;
    const fy = find((e) => dd(e) >= 300 && dd(e) <= 400 && e.end < L && (Date.parse(L) - Date.parse(e.end)) / 864e5 < 370);
    if (!fy) return null;
    const s = new Date(Date.parse(fy.end) + 864e5).toISOString().slice(0, 10);
    const cur = find((e) => dayDiff(e.start, s) <= 5 && dayDiff(e.end, L) <= 3);
    if (!cur) return null;
    const ys = (d) => new Date(Date.parse(d) - 365 * 864e5).toISOString().slice(0, 10);
    const prior = find((e) => dayDiff(e.start, ys(cur.start)) <= 7 && dayDiff(e.end, ys(L)) <= 7 && Math.abs(dd(e) - dd(cur)) <= 10);
    return comb([[fy, 1], [cur, 1], [prior, -1]], "분기 4개 구성 불가 — 종전 식: 사업연도 + 당기 누적 − 전년 동기");
  };
  /** 기간 s~e 의 최초 공시 값 — 그 기간을 실은 공시 중 가장 먼저 제출된 공시의 자기 현금흐름표 감가상각 줄 합(조정 없음) → { v, accn, filed, form } | null */
  const origAt = (s, e) => {
    const f = [...faces].filter((g) => g.periods.has(`${s}|${e}`)).sort((a, b) => (a.filed ?? "").localeCompare(b.filed ?? ""))[0];
    if (!f) return null;
    const xs = (lines0.get(f.accn) ?? f.lines).map((id) => f.vals.get(`${id}|${s}|${e}`)?.val);
    if (xs.every((x) => x == null)) return null;
    return { v: xs.reduce((t, x) => t + (x ?? 0), 0), accn: f.accn, filed: f.filed, form: f.form };
  };
  /** 사업연도 [s, e] 안 기간 목록(읽은 공시 전체) — 누적·3개월 분기(현금흐름표에 3개월 열을 싣는 회사 — MSFT) */
  const periodsIn = (s, e) => [...new Set(faces.flatMap((g) => [...g.periods]))].map((k) => k.split("|")).filter(([a, b]) => a >= new Date(Date.parse(s) - 5 * 864e5).toISOString().slice(0, 10) && b <= e);
  return { annualAt, quarterAt, ltmAt, extend, faces, skipped, origAt, periodsIn };
}
// ▲ 감가상각비 판독 구획 ────────────────────────────────────────────────────────────────────────────────────

// ▼ 판관비·연구개발비 판독 구획(2026-09-28, --metric=sga — 지표 미종결) ────────────────────────────────────────────────────────
// 오너 정의(docs/metrics/sga.md §1): 판관비·연구개발비 = 손익계산서 본표 계산 구조의 영업이익 식(없으면 세전이익 식 — IBM·XOM)을 뿌리에서 내려가며
// 모은 판관비·연구개발비 성격 줄의 합(그 줄 아래로는 내려가지 않음 — 소계면 소계). 매출·매출총이익 식·원가 줄(검증기 faceCogsLine 판독 +
// D형 구성 규칙 줄)은 들어가지 않는다. 성격 판정: 표준 네임스페이스는 개념 이름, 회사 고유 개념은 그 공시 자체 라벨(표시 구조 preferredLabel →
// terse → 표준 라벨). 뿌리와 계산 구조가 끊긴 줄(PLTR 옛 10-Q)은 표시 순서상 영업이익 줄 앞에서 보충. 앱(src/lib/fin/assemble/is.ts identifySgaRnd)은
// import 하지 않는다 — 공시 원본(_pre·_cal·_lab·인스턴스)을 따로 읽는다. 회사별 예외는 오너 결정을 여기 따로 적는다(앱 표와 코드 공유 없음 —
// 그 줄이 쓰인 열은 공통모드). 줄 값 = 그 기간을 실은 공시들의 decimals 판정(decimalsVintage — 정밀도만 낮춘 재게시는 앞선 정밀값).
const SGA_STD = new Set([
  "SellingGeneralAndAdministrativeExpense", "GeneralAndAdministrativeExpense", "SellingAndMarketingExpense", "SellingExpense", "MarketingExpense",
  "MarketingAndAdvertisingExpense", "AdvertisingExpense", "OtherSellingGeneralAndAdministrativeExpense",
  "SalesAndMarketingExpense", "DistributionCosts", "AdministrativeExpense", // IFRS
]);
const RND_STD = new Set(["ResearchAndDevelopmentExpense", "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost", "ResearchAndDevelopmentExpenseSoftwareExcludingAcquiredInProcessCost"]);
/** 회사 고유 줄 라벨 — 판관비(판매·일반관리 계열 이름으로 시작), 연구개발비("research" 포함, 취득 IPR&D 제외) */
const SGA_OWN_RE = /^(total\s+)?((selling|sales),?\s+general,?\s+(and|&)\s+administrative|general\s+(and|&)\s+administrative|(selling|sales|marketing)\s+(and|&)\s+(marketing|selling|sales))\b/i;
const RND_OWN_RE = /research/i, RND_OWN_EXCL = /in[- ]?process|acquired/i;
/** 회사별 예외(오너 결정 2026-09-28 — docs/metrics/sga.md §1-6). 개념 id 는 인스턴스 접두어_이름 */
const SGA_HINTS = {
  AMZN: { sga: ["amzn_FulfillmentExpense"], rnd: ["amzn_TechnologyAndInfrastructureExpense"], why: "AMZN Fulfillment = 판관비·Technology and infrastructure = 연구개발비(오너 결정)" },
  NFLX: { rnd: ["nflx_TechnologyandDevelopmentExpense"], why: "NFLX FY2019 이전 Technology and development 회사 고유 줄 = 연구개발비(오너 결정)" },
  KO: { sga: ["us-gaap_OtherCostAndExpenseOperating"], why: "KO Other operating charges(10-Q·옛 10-K 태그 OtherCostAndExpenseOperating) = 판관비(오너 결정)" },
};
/** 판관비 제외(빈칸 + 사유) — 앱 사유 문구 안에 이 말이 있어야 한다 */
const SGA_EXCLUDE = { DAL: "성격별 비용 본표" };
const SGA_NOLINE = "본표에 줄 없음";
const SGA_SAME = "합 동일";
const STD_LABEL_ROLE = "http://www.xbrl.org/2003/role/label";
/** 라벨 링크베이스 → Map(개념 → Map(라벨 역할 → 글)) */
function xbrlLabelsRole(lab) {
  const loc = new Map(), text = new Map(), out = new Map();
  for (const l of lab.matchAll(/<(?:link:)?loc\b([^>]*)\/?>/g)) { const id = /xlink:label="([^"]+)"/.exec(l[1])?.[1], h = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1]; if (id && h) loc.set(id, h); }
  for (const m of lab.matchAll(/<(?:link:)?label\b([^>]*)>([^<]*)<\/(?:link:)?label>/g)) {
    const id = /xlink:label="([^"]+)"/.exec(m[1])?.[1], role = /xlink:role="([^"]+)"/.exec(m[1])?.[1] ?? STD_LABEL_ROLE;
    if (id) text.set(id, [...(text.get(id) ?? []), [role, m[2].trim()]]);
  }
  for (const a of lab.matchAll(/<(?:link:)?labelArc\b([^>]*)\/?>/g)) {
    const f = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? ""), t = text.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
    if (!f || !t) continue;
    const m = out.get(f) ?? new Map();
    for (const [r, x] of t) if (!m.has(r)) m.set(r, x);
    out.set(f, m);
  }
  return out;
}
/**
 * 공시 한 건의 판관비·연구개발비 줄 → null(손익 역할 없음) | { noRoot } | { role, root, sga, rnd, tot, others, ids, instUrl }
 *  sga·rnd: [{ id, sign(뿌리 식에서 빼는 비용 = +1), how: "std"|"own"|"hint", label, loose?(뿌리와 끊긴 줄 보충) }]
 *  tot: 여러 줄을 정확히 합하는 본표 소계(있으면 값은 소계) · others: 뿌리 식의 그 밖 말단 비용 줄(F층 외부 정의 분해 후보)
 */
async function faceSgaLine(cik, accn, sym) {
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn.replace(/-/g, "")}`;
  const names = await filingNames(base);
  const xsd = names.find((x) => /\.xsd$/i.test(x));
  const preN = names.find((x) => /_pre\.xml$/i.test(x)) ?? xsd, calN = names.find((x) => /_cal\.xml$/i.test(x)) ?? xsd, labN = names.find((x) => /_lab\.xml$/i.test(x)) ?? xsd;
  const instN = names.find((x) => /_htm\.xml$/i.test(x)) ?? names.find((x) => /\.xml$/i.test(x) && !/_(pre|cal|def|lab)\.xml$|FilingSummary|^R\d+\.xml$/i.test(x));
  if (!preN || !calN) return null;
  const pres = xbrlLinks(await secTextC(`${base}/${preN}`), "presentation"), cals = xbrlLinks(await secTextC(`${base}/${calN}`), "calculation");
  let labs = null;
  const L = async () => (labs ??= labN ? xbrlLabelsRole(await secTextC(`${base}/${labN}`)) : new Map());
  // 원가 줄 — 검증기 매출원가 판독(faceCogsLine)의 매출총이익 식 차감 항·원가 소계 하위 줄 + D형 구성 규칙 줄(--cogs-rules)
  // 조회 실패는 던진다(호출자가 기록) — null 로 삼키면 원가 줄이 빠진 채 판관비 구성을 판정했다
  const fc = await faceCogsLine(cik, accn);
  const cogsIds = new Set([...(fc?.terms ?? []), ...(fc?.parts ?? [])].map((t) => t.id.split("[")[0]));
  const rule = COGS_RULES[sym];
  for (const l of [...(rule?.lines ?? []), ...Object.values(rule?.linesByForm ?? {}).flat()]) for (const c of [].concat(l.concept)) cogsIds.add(c);
  const hint = SGA_HINTS[sym] ?? {};
  const isRole = (r) => /INCOME|OPERATIONS|EARNINGS/i.test(r) && !/Parenth|Detail|Table|Polic|Tax|Segment|PerShare|Narrative|Schedule/i.test(r);
  const roles = pres.filter((p) => isRole(p.role)).sort((a, b) => Number(/Comprehensive/i.test(a.role)) - Number(/Comprehensive/i.test(b.role)));
  const short = (id) => id.replace(/^[a-z0-9-]+_/i, "");
  let noRoot = null;
  for (const p of roles) {
    const kidsP = new Map(), hasP = new Set(), plOf = new Map();
    for (const a of p.arcs) { kidsP.set(a.fr, [...(kidsP.get(a.fr) ?? []), a]); hasP.add(a.to); if (a.pl) plOf.set(a.to, a.pl); }
    const order = [];
    const walkP = (id, d) => {
      if (d > 14 || order.includes(id)) return;
      order.push(id);
      for (const a of (kidsP.get(id) ?? []).sort((x, y) => x.order - y.order)) walkP(a.to, d + 1);
    };
    for (const r of [...new Set(p.arcs.map((a) => a.fr))].filter((x) => !hasP.has(x))) walkP(r, 0);
    const ids = order.filter((id) => !COGS_EXCL_ID.test(id) && !/^(dei|srt|country|currency|ecd)_/.test(id));
    const calArcs = cals.find((c) => c.role === p.role)?.arcs ?? cals.filter((c) => isRole(c.role)).flatMap((c) => c.arcs);
    const kidsC = (id) => calArcs.filter((a) => a.fr === id);
    const root = ids.find((id) => OPINC_ID_RE.test(id) && kidsC(id).length) ?? ids.find((id) => PRETAX_ID_RE.test(id) && kidsC(id).length) ?? null;
    if (!root) { if (ids.some((id) => OPINC_ID_RE.test(id) || PRETAX_ID_RE.test(id))) noRoot ??= { noRoot: `${p.role} 본표에 영업이익·세전이익 계산식 없음` }; continue; }
    const lm = await L();
    const labelOf = (id) => { const m = lm.get(id); if (!m) return ""; const pl = plOf.get(id); return (pl && m.get(pl)) || [...m].find(([r]) => /terseLabel$/i.test(r))?.[1] || m.get(STD_LABEL_ROLE) || [...m.values()][0] || ""; };
    const natureOf = (id) => {
      if (hint.sga?.includes(id)) return { k: "sga", how: "hint" };
      if (hint.rnd?.includes(id)) return { k: "rnd", how: "hint" };
      const m = /^(us-gaap|ifrs-full)_(.+)$/.exec(id);
      if (m) return SGA_STD.has(m[2]) ? { k: "sga", how: "std" } : RND_STD.has(m[2]) ? { k: "rnd", how: "std" } : null;
      const lab = labelOf(id).trim();
      if (SGA_OWN_RE.test(lab)) return { k: "sga", how: "own" };
      if (RND_OWN_RE.test(lab) && !RND_OWN_EXCL.test(lab)) return { k: "rnd", how: "own" };
      return null;
    };
    const present = new Set(ids);
    const blocked = (id) => GP_RE.test(id) || COGS_STD_RE.test(id) || REV_STD_RE.test(id) || /^ifrs-full_Revenue/.test(id) || cogsIds.has(id);
    const picks = { sga: [], rnd: [] }, others = [], reached = new Set();
    const walk = (id, w, d) => {
      if (d > 8) return;
      for (const a of kidsC(id)) {
        if (!present.has(a.to) || reached.has(a.to)) continue;
        reached.add(a.to);
        const ww = w * (a.w < 0 ? -1 : 1), sign = ww < 0 ? 1 : -1;
        if (blocked(a.to)) continue;
        const n = natureOf(a.to);
        if (n) { picks[n.k].push({ id: a.to, sign, how: n.how, label: labelOf(a.to) || short(a.to) }); continue; }
        if (kidsC(a.to).length) walk(a.to, ww, d + 1);
        else others.push({ id: a.to, sign, label: labelOf(a.to) || short(a.to) });
      }
    };
    walk(root, 1, 0);
    // 뿌리와 끊긴 성격 줄 — 표시 순서상 영업이익 줄(없으면 뿌리) 앞. 부호 = 그 줄이 속한 식 꼭대기(비용 합계)까지의 가중치 곱
    const parentOf = new Map();
    for (const a of calArcs) if (!parentOf.has(a.to)) parentOf.set(a.to, a);
    const opIdx = ids.findIndex((id) => OPINC_ID_RE.test(id)), end = opIdx >= 0 ? opIdx : ids.indexOf(root);
    const taken = new Set([...picks.sga, ...picks.rnd].map((x) => x.id));
    for (const id of ids.slice(0, end < 0 ? ids.length : end)) {
      if (reached.has(id) || taken.has(id) || blocked(id)) continue;
      const n = natureOf(id);
      if (!n) continue;
      let w = 1, cur = id, ok = true;
      for (let d = 0; d < 8; d++) {
        const pa = parentOf.get(cur);
        if (!pa) break;
        if (taken.has(pa.fr) || blocked(pa.fr) || natureOf(pa.fr)) { ok = false; break; }
        w *= pa.w < 0 ? -1 : 1;
        cur = pa.fr;
      }
      if (ok) { picks[n.k].push({ id, sign: w > 0 ? 1 : -1, how: n.how, label: labelOf(id) || short(id), loose: true }); taken.add(id); }
    }
    // 여러 줄을 정확히 합하는 본표 소계(가중치 전부 +) — 있으면 값은 소계
    const tot = {};
    for (const k of ["sga", "rnd"]) {
      const ps = picks[k];
      if (ps.length < 2 || !ps.every((x) => x.sign === ps[0].sign)) continue;
      const want = ps.map((x) => x.id).sort().join("|");
      const st = ids.find((id) => { const f = kidsC(id); return f.length && f.every((t) => t.w > 0) && f.map((t) => t.to).sort().join("|") === want; });
      if (st) tot[k] = { id: st, sign: ps[0].sign, label: labelOf(st) || short(st) };
    }
    return { role: p.role, root, sga: picks.sga, rnd: picks.rnd, tot, others, ids, instUrl: instN ? `${base}/${instN}` : null };
  }
  return noRoot;
}
/**
 * 판관비·연구개발비 SEC 기대값 모델 → { annualAt(E), quarterAt(E, isQ4), ltmAt(L), extend(E, kind), faces, skipped } | { why }.
 * 결과: { start, end, sga, rnd, others, comps, how } — sga·rnd 는 { v, key, lines: [{id,label,v}], tot, hows, missing, empty?, mix?, same?, how }
 */
async function secFaceSga({ cik, sub, sym, natCur = null }) {
  const unitRe = natCur ? new RegExp(natCur, "i") : /usd/i;
  const annualForm = natCur ? /^(20-F|40-F)$/ : /^10-K$/;
  const rc = sub.filings?.recent ?? {};
  const picks = [];
  let nK = 0, nQ = 0;
  for (let i = 0; i < (rc.form ?? []).length && (nK < 3 || (!natCur && nQ < 4)); i++) {
    const fm = rc.form[i];
    if (annualForm.test(fm) && nK < 3) nK++; else if (!natCur && fm === "10-Q" && nQ < 4) nQ++; else continue;
    picks.push({ accn: rc.accessionNumber[i], form: fm, filed: rc.filingDate[i], report: rc.reportDate[i] });
  }
  const faces = [], skipped = [], read = new Set();
  const addFiling = async (p) => {
    if (read.has(p.accn)) return;
    read.add(p.accn);
    const f = await faceSgaLine(cik, p.accn, sym);
    if (!f || f.noRoot || !f.instUrl) { skipped.push({ ...p, txt: `${p.form} ${p.report}: ${!f ? "손익계산서 역할 없음" : f.noRoot ?? "인스턴스 없음"}` }); return; }
    const want = new Set([f.root, ...f.sga.map((t) => t.id), ...f.rnd.map((t) => t.id), ...Object.values(f.tot).map((t) => t.id), ...f.others.map((t) => t.id)]);
    const xml = await secInstance(f.instUrl);
    const ctx = parseContexts(xml);
    const vals = new Map(), periods = new Set();
    for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*?)contextRef="([^"]+)"([^>]*)>\s*(-?[\d.]+)\s*</g)) {
      const id = `${m[1]}_${m[2]}`, attrs = `${m[3]} ${m[5]}`;
      if (!want.has(id) || !unitRe.test(/unitRef="([^"]*)"/.exec(attrs)?.[1] ?? "")) continue;
      const c = ctx.get(m[4]);
      if (!c?.start || !c.end || c.dims.length) continue;
      const k = `${id}|${c.start}|${c.end}`;
      if (vals.has(k)) continue;
      const d = /decimals="([^"]+)"/.exec(attrs)?.[1];
      vals.set(k, { val: Number(m[6]), dec: d == null ? null : /^INF$/i.test(d) ? Infinity : Number(d) });
      if (id === f.root) periods.add(`${c.start}|${c.end}`);
    }
    faces.push({ ...p, ...f, vals, periods });
    faces.sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? ""));
  };
  for (const p of picks) await addFiling(p);
  // 읽은 범위 밖 기간 — 그 기간을 실은 정기공시를 과거 목록 파일까지 더 읽는다(감가상각비 secFaceDa.extend 와 같은 방식)
  const pages = [rc], olderLoaded = new Set();
  const extend = async (E, kind) => {
    const t = Date.parse(E), day = 864e5;
    const wantF = (form, rep) => {
      const d = (Date.parse(rep) - t) / day;
      if (kind === "FY") return annualForm.test(form) && d >= -7 && d <= 800;
      return (form === "10-Q" && d >= -100 && d <= 400) || (form === "10-K" && d >= -100 && d <= 400);
    };
    const oldest = (rc.filingDate ?? []).at(-1) ?? "";
    for (const f of oldest > E ? sub.filings?.files ?? [] : []) {
      if (olderLoaded.has(f.name) || (f.filingTo ?? "") < E) continue;
      olderLoaded.add(f.name);
      pages.push(await secJson(`https://data.sec.gov/submissions/${f.name}`));
    }
    const more = [];
    for (const pg of pages)
      for (let i = 0; i < (pg.form ?? []).length; i++)
        if (!read.has(pg.accessionNumber[i]) && pg.reportDate[i] && wantF(pg.form[i], pg.reportDate[i]))
          more.push({ accn: pg.accessionNumber[i], form: pg.form[i], filed: pg.filingDate[i], report: pg.reportDate[i] });
    more.sort((a, b) => Math.abs(Date.parse(a.report) - t) - Math.abs(Date.parse(b.report) - t));
    for (const p of more.slice(0, kind === "FY" ? 3 : 4)) await addFiling(p);
  };
  if (!faces.length) return { why: `최근 정기공시 ${picks.length}건 손익계산서 판관비 판독 실패 — ${skipped.map((x) => x.txt).join(" · ")}` };
  const dd = (e) => (Date.parse(e.end) - Date.parse(e.start)) / 864e5;
  const nm = (id) => id.replace(/^[a-z0-9-]+_/i, "");
  /** 줄 id 의 기간 값 — 그 기간을 손익계산서에 실은 공시들의 decimals 판정 */
  // kind: 이 줄이 그 성격(sga·rnd)의 유일한 줄일 때 — 그 기간을 실은 옛 공시가 같은 자리 줄을 다른 개념으로 태깅했으면(MRVL 판관비:
  // 2022·2023 10-K SellingAndMarketingExpense → 2024 10-K SellingGeneralAndAdministrativeExpense, 라벨 동일) 그 줄도 같은 줄의 판본으로 본다
  const lineVal = (id, s, e, kind = null) => {
    const fs = [];
    for (const g of faces) {
      if (!g.periods.has(`${s}|${e}`)) continue;
      let x = g.vals.get(`${id}|${s}|${e}`);
      if (!x && kind) { const ls = g.tot[kind] ? [g.tot[kind]] : g[kind]; if (ls.length === 1) x = g.vals.get(`${ls[0].id}|${s}|${e}`); }
      if (x) fs.push({ accn: g.accn, filed: g.filed, val: x.val, dec: x.dec });
    }
    if (!fs.length) return null;
    const latest = [...fs].sort((a, b) => b.filed.localeCompare(a.filed))[0];
    const dv = decimalsVintage(fs);
    if (dv.ok) return { val: dv.val, latest: latest.val, dec: fs.find((x) => x.accn === dv.accn)?.dec ?? null, note: dv.represented.length || dv.restated.length ? `${nm(id)} 판본 decimals: ${dv.txt}` : "" };
    return { val: latest.val, latest: latest.val, dec: latest.dec, note: `${nm(id)} 판본 decimals 판정 불가(${dv.why}) — 최신 공시 값` };
  };
  const kindOf = (f, k, s, e) => {
    const lines = f[k];
    const base = { key: lines.map((t) => t.id).sort().join("|"), faceAccn: f.accn, form: f.form, report: f.report, hows: [...new Set(lines.map((t) => t.how))], loose: lines.some((t) => t.loose) };
    if (!lines.length) return { ...base, v: null, empty: true, lines: [], how: `${f.form} ${f.report} 본표(${nm(f.root)} 식)에 ${k === "sga" ? "판관비" : "연구개발비"} 성격 줄 없음` };
    const main = f.tot[k] ? [f.tot[k]] : lines;
    const notes = [], missing = [];
    let v = 0, vLatest = 0;
    for (const t of main) { const x = lineVal(t.id, s, e, main.length === 1 ? k : null); if (!x) { missing.push(nm(t.id)); continue; } v += t.sign * x.val; vLatest += t.sign * x.latest; if (x.note) notes.push(x.note); }
    const ls = lines.map((t) => { const x = lineVal(t.id, s, e); return { id: t.id, label: t.label, v: x ? t.sign * x.val : null }; });
    return {
      ...base, v: missing.length ? null : v, vLatest: missing.length ? null : vLatest, missing, lines: ls, tot: f.tot[k]?.id ?? null,
      how: [`${f.form} ${f.report} 본표(${nm(f.root)} 식) ${f.tot[k] ? `소계 ${nm(f.tot[k].id)}("${f.tot[k].label}") = ` : ""}${ls.map((t) => `${nm(t.id)}("${t.label}") ${t.v ?? "값 없음"}`).join(" + ")}`,
        missing.length ? `값 없는 줄: ${missing.join("·")}` : "", ...notes].filter(Boolean).join(" · "),
    };
  };
  const one = (f, pred) => {
    let p = null;
    for (const k of f.periods) { const [s, e] = k.split("|"); if (pred({ start: s, end: e })) { p = { start: s, end: e }; break; } }
    if (!p) return null;
    const others = f.others.map((t) => { const x = lineVal(t.id, p.start, p.end); return { id: t.id, label: t.label, v: x ? t.sign * x.val : null }; });
    return { start: p.start, end: p.end, sga: kindOf(f, "sga", p.start, p.end), rnd: kindOf(f, "rnd", p.start, p.end), others, comps: [{ start: p.start, end: p.end, k: 1, faceAccn: f.accn }] };
  };
  const find = (pred) => { for (const f of faces) { const r = one(f, pred); if (r) return r; } return null; };
  // ── 파생 열 구성 공시 간 줄 구성 — 같으면 줄 값 그대로, 다르면 합 동일성(두 구성이 함께 손익계산서에 실린 같은 기간의 합이 decimals 반올림 안에서
  // 같으면 — 개념 이름만 바뀜) 구성 공시마다 그 공시 자체 줄의 합, 다르거나 비교 기간이 없거나 한쪽에 줄이 없으면 기준 혼합(앱 빈칸 + 사유)
  const sumAt = (lines, per) => {
    for (const g of faces) {
      if (!g.periods.has(per)) continue;
      const xs = lines.map((t) => ({ t, x: g.vals.get(`${t.id}|${per}`) }));
      if (xs.every((y) => y.x)) return { v: xs.reduce((s, y) => s + y.t.sign * y.x.val, 0), tol: xs.reduce((s, y) => s + (y.x.dec == null || !Number.isFinite(y.x.dec) ? 0 : 0.5 * 10 ** -y.x.dec), 0), accn: g.accn };
    }
    return null;
  };
  const sameTotal = (fa, fb, k) => {
    const A = fa.tot[k] ? [fa.tot[k]] : fa[k], B = fb.tot[k] ? [fb.tot[k]] : fb[k];
    let n = 0;
    for (const per of [...new Set(faces.flatMap((g) => [...g.periods]))].sort()) {
      const a = sumAt(A, per), b = sumAt(B, per);
      if (!a || !b) continue;
      n++;
      if (Math.abs(a.v - b.v) > a.tol + b.tol + 0.5) return `합 다름(${per.replace("|", "~")} ${fa.form} ${fa.report} 구성 ${a.v} ≠ ${fb.form} ${fb.report} 구성 ${b.v})`;
    }
    return n ? true : "두 구성이 함께 실린 기간 없음 — 합 동일성 확인 불가";
  };
  const comb = (xs, label) => {
    if (xs.some(([r]) => !r)) return null;
    const out = { start: xs[0][0].start, end: xs[0][0].end, comps: xs.flatMap(([r, k]) => r.comps.map((c) => ({ ...c, k: c.k * k }))) };
    for (const k of ["sga", "rnd"]) {
      const rs = xs.map(([r, w]) => [r[k], w]);
      const keys = [...new Set(rs.map(([r]) => r.key))];
      const hows = [...new Set(rs.flatMap(([r]) => r.hows))], loose = rs.some(([r]) => r.loose);
      const how = `${label} — ${rs.map(([r, w]) => `${w < 0 ? "− " : ""}[${r.how}]`).join(" ")}`;
      if (keys.length === 1) {
        if (rs[0][0].empty) { out[k] = { ...rs[0][0], how }; continue; }
        const missing = [...new Set(rs.flatMap(([r]) => r.missing))];
        const lines = rs[0][0].lines.map((t) => ({ ...t, v: rs.every(([r]) => r.lines.find((y) => y.id === t.id)?.v != null) ? rs.reduce((s, [r, w]) => s + w * r.lines.find((y) => y.id === t.id).v, 0) : null }));
        out[k] = { key: keys[0], hows, loose, missing, lines, tot: rs[0][0].tot, v: missing.length ? null : rs.reduce((s, [r, w]) => s + w * r.v, 0), vLatest: missing.length ? null : rs.reduce((s, [r, w]) => s + w * r.vLatest, 0), how };
        continue;
      }
      // 파생 성분(분기 = 누적 차·Q4, LTM 분기 합 — 2026-09-28)은 faceAccn 이 없다 — 구성분(comps)의 공시로 펼친다
      const fs = [...new Set(xs.flatMap(([r], i) => rs[i][0].faceAccn ? [rs[i][0].faceAccn] : r.comps.map((c) => c.faceAccn)))].map((a) => faces.find((g) => g.accn === a)).filter(Boolean);
      let mix = null;
      if (rs.some(([r]) => r.empty)) mix = rs.map(([r]) => `${r.form} ${r.report} ${r.key ? r.key.split("|").map(nm).join("+") : "줄 없음"}`).join(" ≠ ");
      else for (let i = 0; i < fs.length && !mix; i++) for (let j = i + 1; j < fs.length && !mix; j++) {
        if (fs[i][k].map((t) => t.id).sort().join("|") === fs[j][k].map((t) => t.id).sort().join("|")) continue;
        const eq = sameTotal(fs[i], fs[j], k);
        if (eq !== true) mix = `${fs[i][k].map((t) => nm(t.id)).join("+")} ↔ ${fs[j][k].map((t) => nm(t.id)).join("+")} — ${eq}`;
      }
      if (mix) { out[k] = { key: keys.join(" / "), hows, loose, mix, v: null, lines: [], missing: [], how }; continue; }
      const missing = [...new Set(rs.flatMap(([r]) => r.missing))];
      // 라벨로 짝지은 줄(F층 원인 규칙 전용 — A층 하위 줄 대조에는 쓰지 않는다): 구성분마다 같은 라벨 집합이면 첫 구성분의 줄 id 로 값 합
      // (KO LTM: 10-K OtherSellingGeneralAndAdministrativeExpense ↔ 10-Q OtherCostAndExpenseOperating, 둘 다 "Other operating charges")
      const lk = (t) => String(t.label ?? "").trim().toLowerCase();
      const labSet = (r) => r.lines?.map(lk).sort().join("|");
      const aligned = rs.every(([r]) => r.lines?.length && labSet(r) === labSet(rs[0][0]) && new Set(r.lines.map(lk)).size === r.lines.length)
        ? rs[0][0].lines.map((t) => ({ ...t, v: rs.every(([r]) => r.lines.find((y) => lk(y) === lk(t))?.v != null) ? rs.reduce((s, [r, w]) => s + w * r.lines.find((y) => lk(y) === lk(t)).v, 0) : null }))
        : [];
      out[k] = { key: keys.join(" / "), hows, loose, missing, lines: [], aligned, same: `구성 공시마다 줄 개념 다름 — ${SGA_SAME}(${keys.map((x) => x.split("|").map(nm).join("+")).join(" ↔ ")})`, v: missing.length ? null : rs.reduce((s, [r, w]) => s + w * r.v, 0), vLatest: missing.length ? null : rs.reduce((s, [r, w]) => s + w * r.vLatest, 0), how };
    }
    // 그 밖 줄 — 구성분 전체의 합집합(첫 구성분에 없는 줄도 — KO LTM: 첫 분기 성분에 Other operating charges 가 없어 LTM 규칙이 계산 불가였다)
    const othIds = new Map();
    for (const [r] of xs) for (const t of r?.others ?? []) if (!othIds.has(t.id)) othIds.set(t.id, t);
    out.others = [...othIds.values()].map((t) => ({ ...t, v: xs.every(([r]) => r?.others?.find((y) => y.id === t.id)?.v != null) ? xs.reduce((s, [r, w]) => s + w * r.others.find((y) => y.id === t.id).v, 0) : null }));
    return out;
  };
  const annualAt = (E) => find((e) => dayDiff(e.end, E) <= 7 && dd(e) >= 300 && dd(e) <= 400);
  const quarterAt = (E, isQ4) => {
    if (!isQ4) return recastQ1V({
      dd,
      facesOf: (pred) => faces.map((f) => ({ accn: f.accn, filed: f.filed ?? "", form: f.form, r: one(f, pred) })).filter((x) => x.r && x.r.start),
      derive: (y, d, label) => comb([[y, 1], [d, -1]], label),
      keys: [{ name: "판관비", get: (r) => r.sga?.v ?? null, put: (o, dr) => { o.sga = dr.sga; } }, { name: "연구개발비", get: (r) => r.rnd?.v ?? null, put: (o, dr) => { o.rnd = dr.rnd; } }],
    }, find((e) => dayDiff(e.end, E) <= 3 && dd(e) >= 80 && dd(e) <= 100));
    const fy = annualAt(E);
    if (!fy) return null;
    const nine = find((e) => dayDiff(e.start, fy.start) <= 5 && dd(e) >= 250 && dd(e) <= 290 && e.end < fy.end);
    return comb([[fy, 1], [nine, -1]], "사업연도 − 9개월");
  };
  const ltmAt = (L, old = false) => {
    const fy0 = annualAt(L);
    if (fy0) return fy0;
    const qsum = old ? null : faceQuarterSum(L, { find, dd, annualAt, quarterAt, comb });
    if (qsum) return qsum;
    const fy = find((e) => dd(e) >= 300 && dd(e) <= 400 && e.end < L && (Date.parse(L) - Date.parse(e.end)) / 864e5 < 370);
    if (!fy) return null;
    const s = new Date(Date.parse(fy.end) + 864e5).toISOString().slice(0, 10);
    const cur = find((e) => dayDiff(e.start, s) <= 5 && dayDiff(e.end, L) <= 3);
    if (!cur) return null;
    const ys = (d) => new Date(Date.parse(d) - 365 * 864e5).toISOString().slice(0, 10);
    const prior = find((e) => dayDiff(e.start, ys(cur.start)) <= 7 && dayDiff(e.end, ys(L)) <= 7 && Math.abs(dd(e) - dd(cur)) <= 10);
    return comb([[fy, 1], [cur, 1], [prior, -1]], "분기 4개 구성 불가 — 종전 식: 사업연도 + 당기 누적 − 전년 동기");
  };
  return { annualAt, quarterAt, ltmAt, extend, faces, skipped };
}
/** 인포맥스(FactSet) 손익계산서 판관비(연구개발비 포함) — 연간·분기(recon-lines.mjs 와 같은 /facset/getStatementData, 백만 달러 소수 → 달러 정수) */
async function infomaxSga(sym) {
  const post = (p, b) => fetch(IM + p, { method: "POST", headers: { "content-type": "application/json", referer: IM + "/sss.html" }, body: JSON.stringify(b), signal: AbortSignal.timeout(20_000) }).then((r) => (r.ok ? r.json() : Promise.reject(new Error("인포맥스 HTTP " + r.status))));
  const t = await post("/facset/tickerlist/usa", { ticker: sym });
  const code = t?._source?.["인포맥스코드"];
  if (!code || t._source["티커"]?.toUpperCase() !== sym) return null;
  const F = { frequency: "A", frequency2: "0", infocode: code, pagetype: "", type: "", curr: "" };
  const pre = await post("/facset/getPreStatementData", { param: F });
  const stmt = async (freq) => {
    const d = await post("/facset/getStatementData", { param: { ...F, frequency: freq, frequency2: freq === "A" ? "0" : "", type: pre.step1["업종"], curr: "USD", pagetype: "손익계산서" }, type: { key: "IO", name: "손익계산서" } });
    return Array.isArray(d) ? d : d?.data ?? [];
  };
  const M = (v) => (v != null ? Math.round(v * 1e6) : null);
  const rows = (await stmt("A")).map((r) => ({ end: String(r["결산년월"]).slice(0, 10), sga: M(r["판매비와관리비"]) }));
  const quarters = (await stmt("Q")).map((r) => ({ end: String(r["결산년월"]).slice(0, 10), sga: M(r["판매비와관리비"]) })).sort((a, b) => a.end.localeCompare(b.end));
  return { rows, quarters, unit: unitOfAll([...rows, ...quarters].map((r) => r.sga)) };
}
// ▲ 판관비·연구개발비 판독 구획 ────────────────────────────────────────────────────────────────────────────────────

// ── Yahoo (분할 이력·외부 대조) ───────────────────────────────────────
let yf = null;
async function yahoo() {
  if (!yf) {
    const req = createRequire(new URL("../package.json", import.meta.url));
    const mod = await import(new URL(`file:///${req.resolve("yahoo-finance2").replace(/\\/g, "/")}`).href);
    const YF = mod.default?.default ?? mod.default ?? mod;
    yf = new YF({ suppressNotices: ["yahooSurvey", "ripHistorical"], validation: { logErrors: false } });
  }
  return yf;
}
/** 분할 이력 [{date, ratio}] — EPS 분할 보정 계수를 앱과 독립으로 구한다 */
async function splitsOf(sym) {
  const c = await (await yahoo()).chart(sym, { period1: "2000-01-01", interval: "1mo", events: "split" });
  const all = (c.events?.splits ?? []).map((s) => ({ date: new Date(s.date).toISOString().slice(0, 10), num: s.numerator, den: s.denominator, ratio: s.numerator / s.denominator }));
  // Yahoo 는 분사(spin-off) 가격 조정도 "분할"로 준다(WDC→SNDK 1323:1000, GE→GEV 1253:1000).
  // 주식수가 바뀌는 진짜 분할·병합만 EPS 보정에 쓰고(분자·분모가 작은 정수), 분사는 따로 돌려준다.
  const isSplit = (s) => Number.isInteger(s.num) && Number.isInteger(s.den) && s.num <= 100 && s.den <= 100 && (s.num <= 20 || s.den === 1) && (s.den <= 20 || s.num === 1);
  return { splits: all.filter(isSplit), spinoffs: all.filter((s) => !isSplit(s)) };
}
const IM = "https://globalmonitor.einfomax.co.kr";
/** 인포맥스(FactSet) 연간 재무 — USD 환산값(백만). 외화 공시 기업의 독립 대조 기준 */
async function infomaxAnnual(sym) {
  const post = (p, b) => fetch(IM + p, { method: "POST", headers: { "content-type": "application/json", referer: IM + "/sss.html" }, body: JSON.stringify(b), signal: AbortSignal.timeout(15_000) }).then((r) => (r.ok ? r.json() : Promise.reject(new Error("인포맥스 HTTP " + r.status))));
  const t = await post("/facset/tickerlist/usa", { ticker: sym });
  const code = t?._source?.["인포맥스코드"];
  if (!code || t._source["티커"]?.toUpperCase() !== sym) return null;
  const k = await post("/facset/getKeyData", { param: code });
  // 인포맥스 = FactSet(오너 지시 2026-09-24 — "잘 활용"). 응답은 백만 달러 단위 소수(예 23275.329 = 23,275,329천 달러), EPS 는 달러.
  // 금액은 달러 정수로 되돌린다(v × 1e6 의 부동소수 꼬리 61608000.00000003 을 없애는 표기 복원 — 반올림 허용이 아니다: 응답 소수가
  // 여섯째 자리 이하라 × 1e6 은 정수여야 한다). 시가총액은 센트까지 있다(3869.77672551 백만) — 센트 정수로 복원
  const M = (v) => (v != null ? Math.round(v * 1e6) : null);
  const MC = (v) => (v != null ? Math.round(v * 1e8) / 100 : null);
  const row = (r) => ({
    end: String(r["결산년월"]).slice(0, 10), rev: M(r["매출"]), ni: M(r["당기순익"]), ebitda: M(r["ebitda"]),
    op: M(r["영업이익"]), assets: M(r["자산총계"]), mc: MC(r["시가총액"]), ev: M(r["ev희석화수량"]), eps: r["eps"] ?? null,
    da: r["ebitda"] != null && r["영업이익"] != null ? M(r["ebitda"]) - M(r["영업이익"]) : null,
    gp: M(r["매출총이익"]),
  });
  const out = (k?.y_report ?? []).map(row);
  out.quarters = (k?.q_report ?? []).map(row).sort((a, b) => a.end.localeCompare(b.end));
  // 금액 표기 단위 — 이 종목 응답 전체(연간·분기, 시가총액·EPS 제외)에서 정한다. 2026-09-26 실측 47종목 1,400여 값이 모두 천 달러 배수
  out.unit = unitOfAll([...out, ...out.quarters].flatMap((r) => [r.rev, r.ni, r.ebitda, r.op, r.assets, r.gp]));
  return out;
}
/**
 * StockAnalysis.com 재무(검증 대조 전용 — 오너 결정 2026-09-24 "검증 스크립트에만", 앱·DB 에는 넣지 않는다).
 * SvelteKit 데이터 엔드포인트(devalue 평탄화 배열). 브라우저 UA 가 없으면 Cloudflare 확인 페이지가 온다.
 */
const SA_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
function saUnflatten(arr) {
  const memo = new Map();
  const h = (i) => {
    if (i === -1) return undefined;
    if (memo.has(i)) return memo.get(i);
    const v = arr[i];
    if (v === null || typeof v !== "object") { memo.set(i, v); return v; }
    if (Array.isArray(v)) { const o = []; memo.set(i, o); for (const x of v) o.push(h(x)); return o; }
    const o = {}; memo.set(i, o);
    for (const [k, x] of Object.entries(v)) o[k] = h(x);
    return o;
  };
  return h(0);
}
async function saStatement(sym, path, quarterly = false) {
  const url = `https://stockanalysis.com/stocks/${sym.toLowerCase()}/financials/${path}/__data.json?${quarterly ? "p=quarterly&" : ""}x-sveltekit-invalidated=001`;
  const r = await fetch(url, { headers: { "user-agent": SA_UA, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  const t = await r.text();
  if (!r.ok || t.startsWith("<")) throw new Error(`StockAnalysis ${path} HTTP ${r.status}${t.startsWith("<") ? " (확인 페이지)" : ""}`);
  const node = JSON.parse(t).nodes.find((n) => n?.type === "data" && JSON.stringify(n.data).includes("financialData"));
  const f = node ? saUnflatten(node.data).financialData : null;
  if (!f?.datekey) throw new Error(`StockAnalysis ${path} 재무 데이터 없음`);
  return f;
}
/**
 * FnGuide 투자지표(국내 — 검증 스크립트 전용, 오너 결정 2026-09-24). 신버전 `wcomp.fnguide.com` 은 서버렌더 페이지
 * 안에 `invValueIndex` JSON 을 싣는다(옛 `comp.fnguide.com/SVO2` 는 폐지). 금액은 억원, EPS 는 원.
 * 열: 연도(YYYY/12) + 최근 분기(직전 4분기 기준 행은 TTM, 그 외 행은 누적).
 */
async function fnguideInvest(code) {
  // 종목은 cmp_cd 로 지정한다 — gicode 는 무시되고 기본 종목(삼성전자)이 온다(실측). 응답 종목 코드를 반드시 확인
  const r = await fetch(`https://wcomp.fnguide.com/CompanyInfo/Invest?cmp_cd=${code}`, { headers: { "user-agent": SA_UA }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`FnGuide HTTP ${r.status}`);
  const html = await r.text();
  const got = /cmp_cd:\s*'(\d{6})'/.exec(html)?.[1];
  if (got !== code) throw new Error(`FnGuide 응답 종목 ${got} ≠ 요청 ${code}`);
  const m = /invValueIndex:\s*(\{[^\n]*)\n/.exec(html);
  if (!m) throw new Error("FnGuide invValueIndex 없음");
  const j = JSON.parse(m[1].trim().replace(/,\s*$/, ""));
  const cols = j.header.map((x) => ({ ym: x.YYMM, cd: x.CD }));
  const num = (s) => (s == null || s === "" ? null : Number(String(s).replace(/,/g, "")));
  const rows = j.data.map((d) => ({ grp: d.GRP_CD, nm: String(d.NM).trim(), vals: Object.fromEntries(cols.map((c) => [c.ym, num(d[c.cd])])) }));
  const pick = (grp, nm) => rows.find((x) => x.grp === grp && x.nm === nm)?.vals ?? {};
  return {
    cols: cols.map((c) => c.ym),
    ebitda: pick(3, "EBITDA"), // EV/EBITDA 블록 — 연도는 연간, 최근 분기 열은 직전 4분기
    ev: pick(3, "EV"),
    rev: pick(3, "매출액"),
    epsTtm: pick(3, "EPS"), // 연도는 연간 EPS, 최근 분기 열은 직전 4분기
    niParent: pick(1, "당기순이익(지배)"), // 최근 분기 열은 누적(반기 등) — 연도만 대조
    eqParent: pick(1, "자본총계(지배)"),
  };
}

/**
 * FnGuide 재무제표(국내, 검증 스크립트 전용). 같은 서버렌더 페이지의 `finBalance`·`finIncome` JSON — 금액은 억원(소수 둘째
 * 자리 = 백만원). 연도 열은 최근 3개 연도(YYYY/12)뿐, 최근 분기 열은 버린다. 비지배지분(EV 원인 판정 전제)과 지배·비지배
 * 당기순이익(연결 순이익 대조)을 준다.
 */
async function fnguideFinance(code) {
  const r = await fetch(`https://wcomp.fnguide.com/CompanyInfo/Finance?cmp_cd=${code}`, { headers: { "user-agent": SA_UA }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`FnGuide 재무제표 HTTP ${r.status}`);
  const html = await r.text();
  const got = /cmp_cd:\s*'(\d{6})'/.exec(html)?.[1];
  if (got !== code) throw new Error(`FnGuide 재무제표 응답 종목 ${got} ≠ 요청 ${code}`);
  const block = (key) => {
    const i = html.indexOf(`${key}:`);
    if (i < 0) throw new Error(`FnGuide ${key} 없음`);
    const s = html.indexOf("{", i), e = html.indexOf("\n", s);
    return JSON.parse(html.slice(s, e).trim().replace(/,\s*$/, ""));
  };
  const num = (s) => (s == null || s === "" ? null : Number(String(s).replace(/,/g, "")));
  const series = (j, name) => {
    const d = j.data.find((x) => String(x.NAME).trim() === name);
    if (!d) return {};
    return Object.fromEntries(j.header.filter((h) => /^\d{4}\/\d{2}$/.test(h.YYMM)).map((h) => [h.YYMM, num(d[h.CD])]));
  };
  const bal = block("finBalance"), inc = block("finIncome");
  return {
    nci: series(bal, "비지배주주지분"),
    niParent: series(inc, "(지배주주지분)당기순이익"),
    niNci: series(inc, "(비지배주주지분)당기순이익"),
  };
}

/** 값 비교 — 소스의 보고 단위 안에서 같은가. 한국(verifyKr) 전용으로 남긴다(미국 F층은 아래 extEq — 허용 오차 없음) */
/** 값을 나누는 가장 큰 10의 거듭제곱(최대 100만) — 공시 보고 단위 추정 */
const secUnitAny = (v) => { let u = 1; const a = Math.abs(Math.round(v)); while (u < 1e6 && a % (u * 10) === 0) u *= 10; return u; };
const sameAt = (a, b, unit) => a != null && b != null && Math.abs(a - b) <= Math.max(unit / 2, Math.abs(b) * 1e-12);
/**
 * 외부 대조(미국 F층) 동일성 — 허용 오차 없음(오너 지시 2026-09-26 "허용오차는 허락한 적이 없다"). 두 값이 완전히 같을 때만 참.
 * 부동소수 표현 차(환율 곱·주당값처럼 소수 계산값의 마지막 비트)만 같다고 본다 — 크기 × 8ε(≈1.8e-15 배)로, 달러·주 단위 정수 값에는
 * 1 미만이라 정수끼리는 사실상 === 이다. 외부 표기 단위 반올림은 여기서 같다고 보지 않는다 — ② "외부 표기 단위 반올림"(roundHalfAway
 * 식이 성립할 때만)으로 따로 분류한다.
 */
const extEq = (a, b) => a != null && b != null && (a === b || Math.abs(a - b) <= 8 * Number.EPSILON * Math.max(Math.abs(a), Math.abs(b)));
/** 반올림(0.5 는 0 에서 먼 쪽 — round half away from zero) — 외부 표기 단위 반올림 식에 쓰는 유일한 방식. u 는 10 의 거듭제곱(1e-4 ~ 1e6) */
const roundHalfAway = (x, u) => {
  if (u >= 1) return Math.sign(x) * Math.round(Math.abs(x) / u) * u;
  const k = Math.round(1 / u); // 소수 단위(EPS 1e-4)는 정수 배율로 계산해 0.1 같은 표현 오차를 피한다
  return (Math.sign(x) * Math.round(Math.abs(x) * k)) / k;
};
/** 짝수 반올림(0.5 는 가까운 짝수 — 은행가 반올림). 블룸버그 표기가 이 방식(2026-09-29 실측 — PLTR 순이익 373.705 → 373.70, 209.825 → 209.82,
 *  TER 매출원가 1,496.225 → 1,496.22; 버림이 아닌 근거 PLTR 매출총이익 2,299.517 → 2,299.52). u ≥ 1 만(금액) */
const roundHalfEven = (x, u) => {
  const q = Math.abs(x) / u, f = Math.floor(q), d = q - f;
  const r = Math.abs(d - 0.5) < 1e-9 ? (f % 2 === 0 ? f : f + 1) : Math.round(q);
  return Math.sign(x) * r * u;
};
/** 외부 값 = 표기 단위 반올림(앱 식) — 블룸버그만 짝수 반올림도 인정 */
const extRound = (n, v, e, u) => extEq(v, roundHalfAway(e, u)) || (n === "블룸버그" && u >= 1 && extEq(v, roundHalfEven(e, u)));
/** 값들의 표기 단위 — 모두 1e6 배수면 1e6, 모두 1e3 배수면 1e3, 아니면 1(달러). 소스 한 곳·한 종목의 실제 데이터로 정한다(값 하나로 추정하지 않는다) */
// 표기 단위 — 모든 값이 나누어떨어지는 가장 큰 단위. 10만·1만 단위 추가(2026-09-29 — StockAnalysis 는 MRVL 을 0.1백만 달러로 표기하는데 1,000 달러로 판정해 반올림 식이 안 맞았다)
const unitOfAll = (vals) => {
  const xs = vals.filter((v) => v != null && Number.isFinite(v));
  if (!xs.length) return 1;
  for (const u of [1e6, 1e5, 1e4, 1e3]) if (xs.every((v) => Math.round(v) % u === 0)) return u;
  return 1;
};

// ── 외화 환산 환율 — 연준 H.10 공식 일별 환율(FRED, 오너 결정 2026-09-27, docs/metrics/architecture.md §1.3) ─────────────────────
// 앱(src/lib/markets/quote/fred-fx.ts)도 같은 공적 고시를 쓴다. 검증기는 앱 코드를 import 하지 않고 FRED 에서 **따로** 받아 같은 정의로
// 다시 계산한다 — 원천이 공식 고시라 SEC 원자료처럼 독립 대조(정확 일치, 부동소수 표현 차만)가 된다(공통모드 아님, commonModeOf).
//   환율 = 통화 1단위당 USD. 계열이 "USD 1단위당 통화"면 1 / Number(CSV 문자열)(배정밀도, 반올림 없음).
//   기간 평균 = [시작, 끝] 고시값의 산술평균(날짜 오름차순 합 ÷ 개수, 휴일 없음). 기말 = 그날 또는 이전 마지막 고시값.
//   끝이 최신 고시일보다 뒤면 미고시(null) — 앱은 그 값을 비우고 사유 "H.10 공식 환율 미고시(최신 {날짜})" 를 단다.
// 원문은 reports/.fx-cache/H10-{계열}-{KST 날짜}.txt 에 하루 1회만 받는다(같은 날 재실행·심은 오류 시험은 디스크). 이전 날짜 파일은 지운다.
// (2026-09-27 이전의 Yahoo 일별 봉 ∋ 독립 고시(ECB·H.10·대만 중앙은행) 포함 검사 fxEvidence 는 앱이 H.10 으로 바뀌며 폐기 — 월별 "환율 원천
//  교차" 행도 없다. 고시 시각이 다른 원천끼리의 교차는 판정 근거가 될 수 없어 정보용으로도 남기지 않았다.)
const FX_DISK = pathResolve("reports/.fx-cache");
/** 통화 → [H.10 계열, 역수 여부] — 앱 fred-fx.ts H10_SERIES 와 같은 대응(따로 적는다) */
const H10 = { EUR: ["DEXUSEU", false], GBP: ["DEXUSUK", false], TWD: ["DEXTAUS", true], JPY: ["DEXJPUS", true], CNY: ["DEXCHUS", true], CHF: ["DEXSZUS", true], CAD: ["DEXCAUS", true], DKK: ["DEXDNUS", true] };
const H10_FROM = "2010-01-01";
async function h10Text(series) {
  const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
  const tag = `H10-${series}-`;
  const file = pathJoin(FX_DISK, `${tag}${day}.txt`);
  if (existsSync(file)) return readFileSync(file, "utf8");
  let t = null, err = null;
  for (let attempt = 0; attempt < 2 && t == null; attempt++) {
    try {
      const r = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}&cosd=${H10_FROM}`, { headers: { "user-agent": SEC_UA, accept: "text/csv,*/*" }, signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      t = await r.text();
    } catch (e) { err = e; if (attempt === 0) await new Promise((res) => setTimeout(res, 3000)); }
  }
  if (t == null) throw new Error(`FRED ${series} ${String(err).slice(0, 60)}`);
  mkdirSync(FX_DISK, { recursive: true });
  for (const old of readdirSync(FX_DISK)) if ((old.startsWith(tag) && old !== `${tag}${day}.txt`) || /^(EUR|TWD)-(ECB|CBC|FRED)-/.test(old)) rmSync(pathJoin(FX_DISK, old), { force: true });
  writeFileSync(file, t);
  return t;
}
/** 통화의 H.10 일별 환율 — [{ d, r }] 오름차순(통화 1단위당 USD), .series·.latest(최신 고시일) */
const fxCacheV = new Map();
async function fxDaily(cur) {
  if (fxCacheV.has(cur)) return fxCacheV.get(cur);
  const spec = H10[cur];
  if (!spec) throw new Error(`H.10 계열 없음(${cur}) — 지원: ${Object.keys(H10).join("·")}`);
  const L = (await h10Text(spec[0])).trim().split(/\r?\n/);
  if (!/^observation_date,/.test(L[0])) throw new Error(`FRED ${spec[0]} CSV 머리글 이상`);
  const rows = L.slice(1).map((l) => l.split(",")).filter((x) => x[1] && x[1] !== ".")
    .map((x) => { const v = Number(x[1]); return { d: x[0], r: spec[1] ? 1 / v : v }; })
    .filter((q) => Number.isFinite(q.r) && q.r > 0).sort((a, b) => a.d.localeCompare(b.d));
  if (rows.length < 100) throw new Error(`FRED ${spec[0]} 관측치 ${rows.length}건`);
  rows.series = spec[0];
  rows.latest = rows.at(-1).d;
  fxCacheV.set(cur, rows);
  return rows;
}
/** 기간 평균(미고시·계열 이전이면 null) */
const fxAvg = (rows, start, end) => {
  if (end > rows.latest || start < rows[0].d) return null;
  const x = rows.filter((q) => q.d >= start && q.d <= end);
  return x.length ? x.reduce((s, q) => s + q.r, 0) / x.length : null;
};
/** 기말(미고시면 null) */
const fxEndRate = (rows, date) => (date > rows.latest ? null : rows.filter((q) => q.d <= date).at(-1)?.r ?? null);
/** 미고시 사유(앱 사유와 같은 문구) — 창 끝이 최신 고시일 뒤면 */
const fxPendingWhy = (rows, end) => (rows && end > rows.latest ? `H.10 공식 환율 미고시(최신 ${rows.latest})` : null);
/** 메모 표식 — 환산 환율이 검증기가 따로 받은 H.10 으로 확인됨(commonModeOf 가 "환율 공통" 사유를 빼는 근거) */
const FX_IND_MARK = "환율 H.10 독립 조회";
/** 외부 USD 환산값(인포맥스 등)이 H.10 환산과 다를 때 — 공시 원천 환율로 정확 분해할 수 없으면 ③ 로 남기는 메모 */
const FX_DEF_NOTE = "③ 미해명 — 환율 출처 정의 차이 추정(외부 소스 환산 환율 미공개 — 공시 환율로 정확 분해 불가, 앱 = 원통화 공시 × 연준 H.10)";
async function infomaxShares(sym) {
  const post = (p, b) => fetch(IM + p, { method: "POST", headers: { "content-type": "application/json", referer: `${IM}/sss.html` }, body: JSON.stringify(b), signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`인포맥스 HTTP ${r.status}`))));
  const t = await post("/facset/tickerlist/usa", { ticker: sym });
  const code = t?._source?.["인포맥스코드"];
  if (!code || t._source["티커"]?.toUpperCase() !== sym) return null;
  const p = (await post("/facset/getPriceData", { param: code }))?.[0];
  return p?.["주식수"] ? { shares: p["주식수"] * 1000, date: p["주식수일"] } : null;
}

/**
 * 모기지 리츠 판정 — 앱 /support 응답과 별개로 SEC 원자료(submissions SIC + companyfacts)에서 직접 확인한다.
 * 기준은 오너 결정(CLAUDE.md "모기지 리츠는 종목분석 대상에서 제외")의 판정 요건: SIC 6798 + 순이자손익 공시 +
 * (최근 결산 자산 대비 레포 차입 또는 모기지·채권성 금융자산 10% 이상, 또는 최근 연간 이자수익이 매출의 50% 이상).
 * 앱 함수를 import 하지 않고 검증기가 따로 계산한다. → { ok, note }
 */
async function secMortgageReit(sym) {
  const cik = await cikOf(sym);
  if (!cik) return { ok: false, note: "SEC CIK 없음" };
  const sub = await secJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
  if (String(sub.sic ?? "") !== "6798") return { ok: false, note: `SIC ${sub.sic ?? "없음"} ≠ 6798(리츠)` };
  const f = await secJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
  const G = f?.facts?.["us-gaap"] ?? {};
  const usd = (t) => G[t]?.units?.USD ?? [];
  if (!usd("InterestIncomeExpenseNet").length) return { ok: false, note: "SIC 6798 이나 순이자손익(InterestIncomeExpenseNet) 공시 없음" };
  const assetsLatest = usd("Assets").filter((e) => !e.start).reduce((b, e) => (!b || e.end > b.end || (e.end === b.end && (e.filed ?? "") > (b.filed ?? "")) ? e : b), null);
  if (!assetsLatest?.val) return { ok: false, note: "자산총계 없음" };
  const d = assetsLatest.end, a = assetsLatest.val;
  const at = (t) => usd(t).filter((e) => !e.start && dayDiff(e.end, d) <= 6).reduce((m, e) => Math.max(m, e.val ?? 0), 0);
  const repo = Math.max(0, ...["SecuritiesSoldUnderAgreementsToRepurchase", "SecuritiesSoldUnderAgreementsToRepurchaseCarryingAmount"].map(at));
  const finTags = ["AvailableForSaleSecuritiesDebtSecurities", "AvailableForSaleSecurities", "MarketableSecurities", "DebtSecuritiesAvailableForSaleExcludingAccruedInterest", "LoansAndLeasesReceivableNetReportedAmount", "LoansReceivableHeldForInvestmentNet", "FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLoss", "MortgageLoansOnRealEstateCommercialAndConsumerNet", "TradingSecurities", "HeldToMaturitySecurities", "MortgageLoansOnRealEstate", "LoansAndLeasesReceivableNetOfDeferredIncome"];
  const fin = Math.max(0, ...finTags.map(at));
  if (repo / a >= 0.1) return { ok: true, note: `SIC 6798 · 레포 차입 ${(repo / a * 100).toFixed(1)}% of 자산(${d})` };
  if (fin / a >= 0.1) return { ok: true, note: `SIC 6798 · 모기지·채권성 금융자산 ${(fin / a * 100).toFixed(1)}% of 자산(${d})` };
  const latestAnnual = (t) => usd(t).filter((e) => e.start && e.fp === "FY" && /^10-K/.test(e.form) && (Date.parse(e.end) - Date.parse(e.start)) / 864e5 > 300)
    .reduce((b, e) => (!b || e.end > b.end || (e.end === b.end && (e.filed ?? "") > (b.filed ?? "")) ? e : b), null)?.val ?? 0;
  const interest = Math.max(0, ...["InterestAndDividendIncomeOperating", "InterestIncomeOperating", "InterestAndFeeIncomeLoansAndLeases", "InterestIncome"].map(latestAnnual));
  const revenue = Math.max(0, ...["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "OperatingLeaseLeaseIncome"].map(latestAnnual));
  const den = Math.max(revenue, interest);
  if (den > 0 && interest / den >= 0.5) return { ok: true, note: `SIC 6798 · 이자수익 비중 ${(interest / den * 100).toFixed(1)}%` };
  return { ok: false, note: `SIC 6798 이나 레포 ${(repo / a * 100).toFixed(1)}%·금융자산 ${(fin / a * 100).toFixed(1)}%·이자수익 비중 ${den ? (interest / den * 100).toFixed(1) : "-"}% — 모기지 리츠 요건 미충족` };
}

/**
 * 감가상각비 독립 대조 기준 — 최신 10-K 의 현금흐름표 계산 구조(_cal.xml, 없으면 .xsd 내장)에서 영업활동 조정 항목 중
 * 감가상각·상각 줄을 골라 그 10-K 원본(XBRL 인스턴스)의 연간 값을 더한다(CLAUDE.md "감가상각비 = 현금흐름표 영업활동
 * 조정 항목의 감가상각·상각 줄 합"). 앱 모듈(edgar-cf-structure.ts)을 import 하지 않고 검증기가 따로 읽는다.
 * 제외: 사채할인·발행비, 주식보상, 운용리스(사용권자산 상각·리스비용), 콘텐츠, 계약획득원가·인센티브, 투자·증권, 재고,
 * 연금. 표준 개념은 개념명으로만, 회사 고유 개념은 라벨로 판정하고, 고유 줄의 주 라벨이 "Depreciation…"/"Amortization
 * of intangible…" 로 시작하면 제외어가 있어도 포함한다(AMZN·ISRG). → { byEnd: Map(결산일 → 합), lines } | { why }
 */
async function secCashFlowDa(cik, sub, G = null) {
  const rk = sub.filings?.recent ?? {};
  const ik = (rk.form ?? []).findIndex((fm) => fm === "10-K");
  if (ik < 0) return { why: "10-K 없음" };
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${rk.accessionNumber[ik].replace(/-/g, "")}`;
  const names = (await secJson(base + "/index.json")).directory.item.map((x) => x.name);
  const xsd = names.find((x) => /\.xsd$/i.test(x));
  const calName = names.find((x) => /_cal\.xml$/i.test(x)) ?? xsd;
  const labName = names.find((x) => /_lab\.xml$/i.test(x)) ?? xsd;
  const instName = names.find((x) => /_htm\.xml$/i.test(x));
  if (!calName || !labName || !instName) return { why: `10-K 파일 없음(계산 ${!!calName}·라벨 ${!!labName}·인스턴스 ${!!instName})` };
  const cal = await secText(`${base}/${calName}`);
  const lab = labName === calName ? cal : await secText(`${base}/${labName}`);
  const locMap = (x) => {
    const m = new Map();
    for (const l of x.matchAll(/<link:loc\b([^>]*)\/?>/g)) {
      const id = /xlink:label="([^"]+)"/.exec(l[1])?.[1], href = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1];
      if (id && href) m.set(id, href);
    }
    return m;
  };
  // 개념 → 표시 라벨(정의문 제외)
  const labels = new Map();
  {
    const loc = locMap(lab), text = new Map();
    for (const m of lab.matchAll(/<link:label\b([^>]*)>([^<]*)<\/link:label>/g)) {
      const id = /xlink:label="([^"]+)"/.exec(m[1])?.[1];
      if (id && !/documentation/i.test(/xlink:role="([^"]*)"/.exec(m[1])?.[1] ?? "")) text.set(id, [...(text.get(id) ?? []), m[2].trim()]);
    }
    for (const a of lab.matchAll(/<link:labelArc\b([^>]*)\/?>/g)) {
      const from = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? ""), t = text.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
      if (from && t) labels.set(from, [...(labels.get(from) ?? []), ...t]);
    }
  }
  const DA = /deprecia|amortiz/i;
  const EXCL = /debt|discount|premium|issuance|financing\s*costs?|deferred\s*(financing|charges)|stock|share-?based|compensation|operating[\s-]*lease|lease\s*expense|content|contract\s*(cost|acquisition)|capitalized\s*software|investment|securities|bond|inventory|incentive|acquisition\s*costs|defined\s*benefit|pension|postretirement/i;
  let lines = null;
  let cfMeta = { impairLines: [], separateImpair: [], continuing: false };
  for (const m of cal.matchAll(/<link:calculationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/link:calculationLink>/g)) {
    const role = m[1].split("/").pop() ?? "";
    if (!/CASHFLOW/i.test(role) || /Detail|Table|Parenth|Supplement/i.test(role)) continue;
    const loc = locMap(m[2]);
    const arcs = [];
    for (const a of m[2].matchAll(/<link:calculationArc\b([^>]*)\/?>/g)) {
      const from = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? ""), to = loc.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
      if (from && to) arcs.push([from, to]);
    }
    const root = arcs.find(([fr]) => /^us-gaap_NetCashProvidedByUsedInOperatingActivities(ContinuingOperations)?$/.test(fr))?.[0];
    if (!root) continue;
    lines = [];
    const seen = new Set();
    const impairLines = [], separateImpair = [];
    // 감가상각 줄의 부모 노드 — 계속사업 판정용
    const parentOf = new Map();
    const walk = (id, depth) => {
      if (depth > 3) return;
      for (const [fr, to] of arcs) {
        if (fr !== id || seen.has(to)) continue;
        seen.add(to);
        const std = to.startsWith("us-gaap_");
        const labs = labels.get(to) ?? [];
        const text = std ? to.slice(8) : labs.join(" | ") || to;
        const leads = !std && labs.some((l) => /^(depreciation|amortization of (acquired |acquisition-related )?intangible)/i.test(l));
        const isDa = DA.test(text) && (!EXCL.test(text) || leads);
        // 손상 포함 여부는 개념명·라벨 둘 다(XOM 표준 개념 + 라벨 "(includes impairments)")
        if (/impair/i.test(`${to} ${labs.join(" ")}`)) (isDa ? impairLines : separateImpair).push(to);
        if (isDa) { lines.push(to); parentOf.set(to, id); }
        else walk(to, depth + 1);
      }
    };
    walk(root, 0);
    // 계속사업 기준: 조상이 계속사업 소계이거나, 조상의 자식에 계속사업 이익 출발·중단사업 전체 손익 차감 줄이 있다
    // (GE·EMR 계속사업 소계, DD·BAX·HON 계속사업 이익 출발). 중단사업 "처분이익"만 빼는 줄(JNJ)은 해당 없음
    const up = new Map(arcs.map(([fr, to]) => [to, fr]));
    const contOf = (id) => {
      for (let p = parentOf.get(id), k = 0; p && k < 6; p = up.get(p), k++) {
        if (/ContinuingOperations$/.test(p)) return true;
        if (arcs.some(([fr, to]) => fr === p && /^us-gaap_(IncomeLossFromContinuingOperations|IncomeLossFromDiscontinuedOperations|DiscontinuedOperationIncomeLossFromDiscontinuedOperation)/.test(to))) return true;
      }
      return false;
    };
    cfMeta = {
      impairLines,
      separateImpair: separateImpair.filter((x) => !/inventor/i.test(`${x} ${(labels.get(x) ?? []).join(" ")}`)),
      continuing: lines.length > 0 && lines.every(contOf),
    };
    break;
  }
  if (!lines) return { why: "최신 10-K 에 현금흐름표 계산 구조(영업활동 루트) 없음" };
  if (!lines.length) return { why: "현금흐름표 영업활동 조정 항목에 감가상각·상각 줄 없음" };
  const xml = await secText(`${base}/${instName}`);
  const ctx = new Map();
  for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
    if (/dimension="/.test(m[2])) continue;
    const s = /<(?:xbrli:)?startDate>\s*([^<\s]+)/.exec(m[2])?.[1], e = /<(?:xbrli:)?endDate>\s*([^<\s]+)/.exec(m[2])?.[1];
    if (s && e && (Date.parse(e) - Date.parse(s)) / 864e5 > 300) ctx.set(m[1], `${s}|${e}`);
  }
  const want = new Set(lines);
  const vals = new Map(); // "선|기간" → 값(첫 값)
  for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*)>\s*(-?[\d.]+)\s*<\/\1:\2>/g)) {
    const id = `${m[1]}_${m[2]}`;
    if (!want.has(id) || !/unitRef="[^"]*usd/i.test(m[3])) continue;
    const p = ctx.get(/contextRef="([^"]+)"/.exec(m[3])?.[1] ?? "");
    if (p && !vals.has(`${id}|${p}`)) vals.set(`${id}|${p}`, Number(m[4]));
  }
  // 줄 값 판본 — 최신 10-K 가 과거 연도를 더 거친 단위로 다시 실은 경우(MCD 2023 감가상각비 1,978,200,000(d−5) → 2026 10-K
  // 1,978,000,000) 그 기간을 실은 공시들의 decimals 로 판정한다(decimalsVintage — 다른 A층 검사와 같은 판정, 값 모양 안 씀)
  const vintNotes = new Map();
  for (const [k, v] of [...vals]) {
    const [id, s, e] = k.split("|");
    if (!G || !id.startsWith("us-gaap_")) continue;
    const es = (G[id.slice(8)]?.units?.USD ?? []).filter((x) => x.start === s && x.end === e && x.accn);
    if (new Set(es.map((x) => x.val)).size < 2) continue;
    const fs = [];
    try {
      for (const x of new Map(es.map((x) => [`${x.accn}|${x.val}`, x])).values()) {
        const hit = ((await instanceDecimals(cik, x.accn))?.get(`${id.slice(8)}|${s}|${e}`) ?? []).filter((f) => f.v === x.val && f.dec != null);
        fs.push({ accn: x.accn, filed: x.filed ?? "", val: x.val, dec: hit.length ? Math.max(...hit.map((f) => f.dec)) : null });
      }
    } catch { continue; }
    const dv = decimalsVintage(fs);
    if (dv.ok && dv.val !== v) { vals.set(k, dv.val); vintNotes.set(e, `${id.slice(8)} 판본 decimals: ${dv.txt} — 최신 10-K 값 ${v} 대신 ${dv.val}`); }
  }
  const byEnd = new Map();
  for (const [k, v] of vals) { const end = k.split("|").at(-1); byEnd.set(end, (byEnd.get(end) ?? 0) + v); }
  // ── 감가상각 줄에 섞인 손상차손·중단사업 감가상각(오너 결정 2026-09-24 — EBITDA = 영업이익 + 감가상각비는 같은 범위,
  // 감가상각비에 손상차손 불포함). 앱 모듈을 쓰지 않고 이 10-K 원본에서 직접 읽는다(예전 A층은 줄 합만 봐서 손상·중단사업이
  // 섞인 앱 값을 통과시켰다 — 공통모드). 기간별 조정 내역은 notes, 원본에서 금액을 확인할 수 없는 기간은 unresolved(미결).
  const facts = []; // { id, end, dims: [[축, 멤버]], v } — 1년 기간만
  {
    const ctxAll = new Map();
    for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
      const s = /<(?:xbrli:)?startDate>\s*([^<\s]+)/.exec(m[2])?.[1], e = /<(?:xbrli:)?endDate>\s*([^<\s]+)/.exec(m[2])?.[1];
      if (!s || !e || (Date.parse(e) - Date.parse(s)) / 864e5 <= 300) continue;
      ctxAll.set(m[1], { end: e, dims: [...m[2].matchAll(/dimension="([^"]+)"[^>]*>\s*([^<\s]+)\s*</g)].map((d) => [d[1], d[2]]) });
    }
    const dup = new Set();
    for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*)>\s*(-?[\d.]+)\s*<\/\1:\2>/g)) {
      if (!/Impair|WriteDown|Writeoff|WriteOff|Discontinued|DisposalGroup/i.test(m[2]) || !/unitRef="[^"]*usd/i.test(m[3])) continue;
      const c = ctxAll.get(/contextRef="([^"]+)"/.exec(m[3])?.[1] ?? "");
      if (!c) continue;
      const id = `${m[1]}_${m[2]}`, key = `${id}|${c.end}|${c.dims.flat().join(",")}`;
      if (dup.has(key)) continue;
      dup.add(key);
      facts.push({ id, end: c.end, dims: c.dims, v: Number(m[4]) });
    }
  }
  const nm = (id) => id.replace(/^[a-z-]+_/, "");
  const isDiscDa = (id) => /Discontinued|DisposalGroup/.test(nm(id)) && /Depreciation\w*Amortization/.test(nm(id)) && !/Accumulated|PerShare/.test(nm(id));
  const isDiscNi = (id) => /^us-gaap_(IncomeLossFromDiscontinuedOperations|DiscontinuedOperationIncomeLossFromDiscontinuedOperation)/.test(id) && !/Share/.test(id);
  const notes = new Map(vintNotes), unresolved = new Map();
  const lineByEnd = new Map(byEnd); // 조정 전 줄 합(외부 소스 원인 판정 ⑧)
  let anyDisc = false;
  for (const [end, sum0] of byEnd) {
    let sum = sum0;
    const at = facts.filter((f) => f.end === end);
    if (!cfMeta.continuing) {
      let disc = null;
      for (const id of new Set(at.filter((f) => isDiscDa(f.id)).map((f) => f.id))) {
        const fs = at.filter((f) => f.id === id);
        let v = fs.find((f) => !f.dims.length)?.v;
        if (v == null) {
          const g = new Map();
          for (const f of fs) { const d = f.dims.find((x) => /DisposalGroups?Including|ByDisposalGroup/i.test(x[0])) ?? f.dims[0]; if (d && !g.has(d[1])) g.set(d[1], f.v); }
          if (g.size) v = [...g.values()].reduce((x, y) => x + y, 0);
        }
        if (v != null) disc = Math.max(disc ?? 0, v);
      }
      const discNi = at.some((f) => isDiscNi(f.id) && !f.dims.length && f.v !== 0);
      if (discNi || disc != null) anyDisc = true;
      if (disc != null && disc > 0 && disc < sum) { sum -= disc; notes.set(end, [notes.get(end), `중단사업 감가상각 ${disc} 차감(현금흐름표가 중단사업 포함 · 공통모드(규칙 재구현 — 중단사업 태그·차원 판정이 앱과 같은 규칙))`].filter(Boolean).join(" · ")); }
      else if (discNi && !(disc > 0) && !discOpsDuring(null, end)) notes.set(end, [notes.get(end), "중단사업 손익은 있으나 영업 없음(기초·기중 재무상태표에 중단사업 자산 없음 — 분리 뒤 정산 잔여) — 중단사업 감가상각 0"].filter(Boolean).join(" · "));
      else if (discNi && !(disc > 0)) unresolved.set(end, "중단사업 손익이 있는데 중단사업 감가상각 태그 없음 — 계속사업 감가상각 확인 불가");
    }
    byEnd.set(end, sum);
  }
  const tags = `${cfMeta.impairLines.length ? " (손상 포함 줄)" : ""}${!cfMeta.continuing && anyDisc ? " (중단사업 포함 현금흐름표)" : ""}`;
  return { byEnd, lineByEnd, notes, unresolved, lines: `${rk.reportDate?.[ik] ?? ""} 10-K 줄: ${lines.map((l) => l.replace(/^[a-z-]+_/, "")).join("+")}${tags}` };
}

/**
 * 앱이 응답에 실은 조회 실패 경고(감사 2026-09-25) — 앱은 원본 조회 실패를 값 대신 문구로 알린다. src 에서 확인한 문구:
 *  - 하이라이트 notes·재무제표 source·컨센서스 notes: "⚠ 일부 공시 조회 실패(…)" (fetchWarnings — SEC 429 등, "외화 환산 환율
 *    조회 실패", "인포맥스 분기 조회 실패(LTM 최신 분기)" 포함)
 *  - 컨센서스 notes: "추정치(yahoo) 조회 실패 — 실적만 표시", "연간 재무제표 조회 실패"
 *  - 한국 하이라이트 notes: "일부 연도 시가총액: KRX 조회 실패 → …", 개요 warnings: "시세 조회 실패"
 * 문구를 하나씩 나열하지 않고 응답 전체에서 "조회 실패" 를 찾는다(새 문구도 잡히게). 있으면 hardErrors → 종료코드 1.
 */
function appFetchWarnings(obj) {
  const s = JSON.stringify(obj ?? "");
  return [...new Set([...s.matchAll(/[^"\\]{0,60}조회 실패[^"\\]{0,80}/g)].map((m) => m[0].trim()))];
}

// ── 미국 종목 1개 ─────────────────────────────────────────────────────
async function verifyUs(sym) {
  const u = `/api/markets/us/${encodeURIComponent(sym)}`;
  const checks = [];
  const add = (layer, name, col, r) => checks.push({ layer, name, col, ...r });
  const review = [];
  // 조회 실패(SEC·외부 소스) — 결과를 바꾸지 않아도 전부 기록하고 종료코드 1(감사: 선언 전 사용·누락 경로)
  const hardErrors = [];
  // 공통모드 판정(resolveCommon)용 — 분기 열 라벨 → 결산일, 외부 대조에서 받은 Yahoo 분기 재무
  const qEndOf = new Map();
  let extYq = [];

  const support = await getJson(`${u}/support`);
  // 앱의 "지원 제외" 응답만 믿지 않는다(감사) — SEC 원자료로 모기지 리츠임을 따로 확인할 때만 허용된 건너뜀
  if (support && support.supported === false) {
    const mr = await secMortgageReit(sym).catch((e) => ({ ok: false, note: `SEC 조회 실패: ${String(e).slice(0, 60)}` }));
    return mr.ok
      ? { sym, skipped: `모기지 리츠(지원 제외) — SEC 확인(규칙 재구현·${COMMON_LABEL}): ${mr.note}`, allowedSkip: true, commonSkip: true, checks, review, hardErrors }
      : { sym, skipped: `앱이 지원 제외했으나 SEC 원자료로 모기지 리츠 확인 못함 — ${mr.note}`, allowedSkip: false, checks, review, hardErrors };
  }

  // 조회 실패는 전부 기록한다(예전엔 컨센서스 실패가 조용히 검사 16건을 지웠다)
  const fetched = {};
  for (const [k, p] of Object.entries({
    hl: `${u}/highlights`, an: `${u}/financials?view=analysis`, ov: `${u}/overview`, tt: `${u}/ttm`,
    cs: `${u}/consensus`, is: `${u}/financials?view=is&period=annual`, bs: `${u}/financials?view=bs&period=annual`,
    ...(BSCF_MODE ? { cf: `${u}/financials?view=cf&period=annual`, cfq: `${u}/financials?view=cf&period=quarter`, bsq: `${u}/financials?view=bs&period=quarter` } : {}),
    // 매출 소비처(revenue.md §3) — 총괄(연간·분기)·손익계산서 분기
    sm: `${u}/financials?view=summary&period=annual`, smq: `${u}/financials?view=summary&period=quarter`, isq: `${u}/financials?view=is&period=quarter`,
  })) {
    try { fetched[k] = await getJson(p); } catch (e) { fetched[k] = null; add("응답", `API 응답 ${k}`, "-", { status: FAIL, note: String(e).slice(0, 120) }); }
  }
  let row = null;
  try { row = await getJson(`/api/cron/verify-row?market=us&symbol=${encodeURIComponent(sym)}`, 240_000, AUTH); }
  catch (e) { add("응답", "API 응답 verify-row", "-", { status: FAIL, note: String(e).slice(0, 120) }); }
  for (const [k, v] of Object.entries({ ...fetched, "verify-row": row })) for (const w of appFetchWarnings(v)) hardErrors.push(`앱 조회 실패 경고(${k}): ${w}`);
  const { hl, an, ov, cs, is, bs, sm, smq, isq } = fetched;
  const revErrors = []; // 매출 외부 대조 ③ 오류(revenue.md §0)
  const cogsErrors = []; // 매출원가·매출총이익 외부 대조 ③ 오류(--metric=cogs)
  const opincErrors = []; // 영업이익 외부 대조 ③ 오류(--metric=opinc)
  const daErrors = []; // 감가상각비 외부 대조 ③ 오류(--metric=da)
  const sgaErrors = []; // 판관비·연구개발비 외부 대조 ③ 오류(--metric=sga)
  const h = hl?.highlights;
  if (!h) return { sym, error: "하이라이트 없음", checks, review };

  // ── SEC 원자료
  const cik = await cikOf(sym);
  if (!cik) return { sym, error: "SEC CIK 없음", checks, review };
  const f = await secJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
  if (!f?.facts) return { sym, error: "SEC companyfacts 형식 이상", checks, review };
  const sub = await secJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const sic = Number(sub.sic ?? 0);
  const G = f.facts["us-gaap"] ?? {};
  CUR_G = G; // 중단사업 영업 판정(discOpsDuring)용
  // companyfacts 가 앱 LTM 기준일의 공시(10-Q/10-K)를 아직 반영하지 않은 경우(KO·MDLZ·V — 앱은 공시 원본으로 채운다)
  // 그 공시 원본에서 차원 없는 USD 기간 값을 읽어 채운다. 검증기가 따로 구현한 것이고, 이미 있는 기간은 건드리지 않는다.
  // 이게 없으면 LTM 은 "기준일 다름"으로 SEC 대조가 빠졌다.
  {
    const ltmDate = h.columns.find((c) => c.kind === "ltm")?.date;
    const durEnds = ["NetIncomeLoss", "ProfitLoss", "Revenues"].flatMap((t) => (G[t]?.units?.USD ?? []).filter((e) => e.start).map((e) => e.end));
    const latest = durEnds.sort().at(-1);
    const rc = sub.filings?.recent ?? {};
    const k = ltmDate && (!latest || (latest < ltmDate && dayDiff(latest, ltmDate) > 7))
      ? (rc.form ?? []).findIndex((fm, i) => /^10-[QK]$/.test(fm) && rc.reportDate?.[i] && dayDiff(rc.reportDate[i], ltmDate) <= 7)
      : -1;
    if (k >= 0) {
      try {
        const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${rc.accessionNumber[k].replace(/-/g, "")}`;
        const idx = await secJson(base + "/index.json");
        const name = idx.directory.item.map((x) => x.name).find((x) => /_htm\.xml$/i.test(x));
        const xml = name ? await secText(base + "/" + name) : "";
        const ctx = new Map();
        for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
          if (/dimension="/.test(m[2])) continue;
          const s = /<(?:xbrli:)?startDate>\s*([^<\s]+)/.exec(m[2])?.[1], e = /<(?:xbrli:)?endDate>\s*([^<\s]+)/.exec(m[2])?.[1];
          if (s && e) ctx.set(m[1], { start: s, end: e });
        }
        let added = 0;
        for (const m of xml.matchAll(/<us-gaap:([A-Za-z0-9_]+)\b([^>]*)>\s*(-?[\d.]+)\s*<\/us-gaap:\1>/g)) {
          const c = ctx.get(/contextRef="([^"]+)"/.exec(m[2])?.[1] ?? "");
          if (!c || !/unitRef="[^"]*usd"/i.test(m[2])) continue;
          const arr = ((G[m[1]] ??= { units: {} }).units.USD ??= []);
          if (arr.some((e) => e.start === c.start && e.end === c.end)) continue;
          const days = (Date.parse(c.end) - Date.parse(c.start)) / 864e5;
          arr.push({ start: c.start, end: c.end, val: Number(m[3]), form: rc.form[k], filed: rc.filingDate[k], accn: rc.accessionNumber[k], fp: days > 300 ? "FY" : "Q", fy: 0 });
          added++;
        }
        review.push({ item: "SEC 최신 공시 보강", note: `companyfacts 미반영 ${rc.form[k]} ${rc.reportDate[k]} 원본에서 ${added}개 값 보강` });
      } catch (e) {
        hardErrors.push(`최신 공시 원본 조회 실패: ${String(e).slice(0, 60)}`);
      }
    }
  }
  // 열 단위 판본 판정 — 최신 공시 보강(위) 뒤, 기준값을 고르기(latestPrecise) 전에
  try { await prepareColumnVintage(f.facts, cik, hardErrors); }
  catch (e) { hardErrors.push(`열 판본 판정 준비 실패: ${String(e).slice(0, 60)}`); }
  indexFactConcepts(f.facts); // 판본 decimals 교차 확인(withVintage)용 — 사실 → 개념
  const ann = (c, unit = "USD") => annualPeriods(f.facts, "us-gaap", c, unit);
  /** 결산일(±7일)의 연간 사실 전부(10-K·20-F, 300~400일) — 공시일 순. 최초·최신 공시를 구분할 때 */
  const annualAllAt = (concept, unit, date) => (G[concept]?.units?.[unit] ?? [])
    .filter((e) => { const d = (Date.parse(e.end) - Date.parse(e.start)) / 864e5; return e.start && /^(10-K|20-F)/.test(e.form ?? "") && d >= 300 && d <= 400 && dayDiff(e.end, date) <= 7; })
    .sort((a, b) => (a.filed ?? "").localeCompare(b.filed ?? ""));
  const has20F = Object.keys(f.facts).includes("ifrs-full") || (sub.filings?.recent?.form ?? []).some((x) => /^20-F/.test(x));
  // 보고 통화 = 매출·순이익·자산 태그의 단위(외화 차입금 태그 등 일부 항목의 외화 단위는 무관 — MCD 오판)
  const reportUnits = new Set(["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "NetIncomeLoss", "ProfitLoss", "Assets"].flatMap((t) => Object.keys(G[t]?.units ?? {})));
  const usdOnly = reportUnits.size === 0 || [...reportUnits].every((u) => u === "USD");
  // 외화·IFRS 공시(ASML·TSM·SPOT) — 앱은 USD 로 환산해 보여준다. 검증기는 환산을 재현하지 않고
  // 인포맥스(FactSet, 독립 USD 환산)와 대조한다.
  const foreign = !usdOnly || Object.keys(f.facts).includes("ifrs-full");
  let imAnnual = null, imErr = "";
  if (foreign || EXTERNAL) {
    imAnnual = await infomaxAnnual(sym).catch((e) => { imErr = String(e).slice(0, 60); return null; });
    if (!imAnnual) hardErrors.push(`인포맥스 연간 재무 조회 실패: ${imErr || "종목 없음(null)"}`);
  }
  // 외화 공시 원통화 값(결산일별) — us-gaap 외화 단위(ASML) 또는 ifrs-full(TSM·SPOT)
  const natCur = foreign ? ([...reportUnits].find((u) => u !== "USD") ?? Object.keys(f.facts["ifrs-full"]?.Revenue?.units ?? f.facts["ifrs-full"]?.RevenueFromContractsWithCustomers?.units ?? {}).find((u) => u !== "USD")) : null;
  const natAnnual = (pairs, unit) => {
    const m = new Map();
    for (const [ns, t] of pairs) for (const e of f.facts[ns]?.[t]?.units?.[unit] ?? []) {
      if (!e.start || !/^(10-K|20-F)/.test(e.form) || (Date.parse(e.end) - Date.parse(e.start)) / 864e5 < 300) continue;
      const p = m.get(e.end); if (!p || (e.filed ?? "") > (p.filed ?? "")) m.set(e.end, e);
    }
    return m;
  };
  const natRev = natCur ? natAnnual([["us-gaap", "Revenues"], ["us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax"], ["ifrs-full", "Revenue"], ["ifrs-full", "RevenueFromContractsWithCustomers"]], natCur) : new Map();
  const natNi = natCur ? natAnnual([["us-gaap", "NetIncomeLoss"], ["ifrs-full", "ProfitLossAttributableToOwnersOfParent"]], natCur) : new Map();
  const natEps = natCur ? natAnnual([["us-gaap", "EarningsPerShareDiluted"], ["ifrs-full", "DilutedEarningsLossPerShare"]], natCur + "/shares") : new Map();
  // E층 원통화 정합성용(희석 우선, 없으면 기본) — ASML us-gaap EUR, SPOT·TSM ifrs-full. SPOT 은 희석 분자를 따로 공시(희석 효과 포함 지배주주 순이익)
  const natEpsB = natCur ? natAnnual([["us-gaap", "EarningsPerShareBasic"], ["ifrs-full", "BasicEarningsLossPerShare"]], natCur + "/shares") : new Map();
  const natWDil = natCur ? natAnnual([["us-gaap", "WeightedAverageNumberOfDilutedSharesOutstanding"], ["ifrs-full", "AdjustedWeightedAverageShares"]], "shares") : new Map();
  const natWBas = natCur ? natAnnual([["us-gaap", "WeightedAverageNumberOfSharesOutstandingBasic"], ["ifrs-full", "WeightedAverageShares"]], "shares") : new Map();
  const natNiDil = natCur ? natAnnual([["ifrs-full", "ProfitLossAttributableToOrdinaryEquityHoldersOfParentEntityIncludingDilutiveEffects"]], natCur) : new Map();
  // 손익 줄 연도 열 대조(재감사 N1, 2026-10-02 — 앱 데이터에서 사업연도 항목이 빠져도 화면 연도·LTM 이 빈칸이 되는 것을 잡는다)
  const PT_TAGS = [["us-gaap", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest"], ["us-gaap", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"], ["ifrs-full", "ProfitLossBeforeTax"]];
  const natPt = natCur ? natAnnual(PT_TAGS, natCur) : new Map();
  const natTax = natCur ? natAnnual([["us-gaap", "IncomeTaxExpenseBenefit"], ["ifrs-full", "IncomeTaxExpenseContinuingOperations"]], natCur) : new Map();
  const natRd = natCur ? natAnnual([["us-gaap", "ResearchAndDevelopmentExpense"], ["ifrs-full", "ResearchAndDevelopmentExpense"]], natCur) : new Map();
  // companyfacts 가 최신 20-F/10-K 를 빠뜨린 경우(TSM 2025) — 원본 XBRL 인스턴스에서 원통화 값을 직접 읽는다
  if (natCur) {
    const rc2 = sub.filings?.recent ?? {};
    for (let i = 0; i < (rc2.form ?? []).length; i++) {
      if (!/^(10-K|20-F)$/.test(rc2.form[i]) || !rc2.reportDate?.[i]) continue;
      const end = rc2.reportDate[i];
      if (atEnd(natRev, end) && atEnd(natNi, end) && atEnd(natEps, end) && atEnd(natPt, end) && atEnd(natTax, end) && atEnd(natRd, end)) continue;
      try {
        const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${rc2.accessionNumber[i].replace(/-/g, "")}`;
        const idx = await secJson(base + "/index.json");
        const name = idx.directory.item.map((x) => x.name).find((x) => /_htm\.xml$/i.test(x));
        if (!name) continue;
        const xml = await secText(base + "/" + name);
        const ctx = new Map();
        for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
          const b = m[2];
          ctx.set(m[1], { start: /<(?:xbrli:)?startDate>([^<]+)</.exec(b)?.[1], end: /<(?:xbrli:)?endDate>([^<]+)</.exec(b)?.[1], dimmed: /dimension="/.test(b) });
        }
        const read = (ns, tag, unitRe) => {
          for (const m of xml.matchAll(new RegExp(`<${ns}:${tag}(?=[\\s>])([^>]*)>([^<]+)</${ns}:${tag}>`, "g"))) {
            const c = ctx.get(/contextRef="([^"]+)"/.exec(m[1])?.[1]);
            const unit = /unitRef="([^"]+)"/.exec(m[1])?.[1] ?? "";
            if (!c || c.dimmed || !c.start || c.end !== end || !unitRe.test(unit)) continue;
            if ((Date.parse(c.end) - Date.parse(c.start)) / 864e5 < 300) continue;
            return { start: c.start, end: c.end, val: Number(m[2]), form: rc2.form[i], filed: rc2.filingDate[i] };
          }
          return null;
        };
        const cu = new RegExp(natCur, "i");
        const put = (map, e) => { if (e && !atEnd(map, end)) map.set(end, e); };
        put(natRev, read("ifrs-full", "Revenue", cu) ?? read("ifrs-full", "RevenueFromContractsWithCustomers", cu) ?? read("us-gaap", "Revenues", cu));
        put(natNi, read("ifrs-full", "ProfitLossAttributableToOwnersOfParent", cu) ?? read("us-gaap", "NetIncomeLoss", cu));
        put(natEps, read("ifrs-full", "DilutedEarningsLossPerShare", cu) ?? read("us-gaap", "EarningsPerShareDiluted", cu));
        put(natPt, read("ifrs-full", "ProfitLossBeforeTax", cu) ?? read("us-gaap", PT_TAGS[0][1], cu) ?? read("us-gaap", PT_TAGS[1][1], cu));
        put(natTax, read("ifrs-full", "IncomeTaxExpenseContinuingOperations", cu) ?? read("us-gaap", "IncomeTaxExpenseBenefit", cu));
        put(natRd, read("ifrs-full", "ResearchAndDevelopmentExpense", cu) ?? read("us-gaap", "ResearchAndDevelopmentExpense", cu));
        // E층 원통화 정합성(희석·기본 EPS × 가중평균 주식수 ≈ 순이익) — 주식수 단위는 통화가 붙지 않은 shares(EPS 단위 "TWD per share" 제외)
        const sh = new RegExp(`^(?!.*(${natCur}|per)).*shares?$`, "i");
        put(natEpsB, read("ifrs-full", "BasicEarningsLossPerShare", cu) ?? read("us-gaap", "EarningsPerShareBasic", cu));
        put(natWDil, read("ifrs-full", "AdjustedWeightedAverageShares", sh) ?? read("us-gaap", "WeightedAverageNumberOfDilutedSharesOutstanding", sh));
        put(natWBas, read("ifrs-full", "WeightedAverageShares", sh) ?? read("us-gaap", "WeightedAverageNumberOfSharesOutstandingBasic", sh));
        put(natNiDil, read("ifrs-full", "ProfitLossAttributableToOrdinaryEquityHoldersOfParentEntityIncludingDilutiveEffects", cu));
      } catch (e) {
        hardErrors.push(`원통화 인스턴스 판독 실패(${end}): ${String(e).slice(0, 50)}`);
      }
    }
  }
  const nativeAt = (date) => {
    const r = atEnd(natRev, date), n = atEnd(natNi, date), e = atEnd(natEps, date);
    const any = r ?? n ?? e; if (!any) return null;
    return { start: any.start, end: any.end, rev: r?.val ?? null, ni: n?.val ?? null, eps: e?.val ?? null, pt: atEnd(natPt, date)?.val ?? null, tax: atEnd(natTax, date)?.val ?? null, rd: atEnd(natRd, date)?.val ?? null };
  };
  let fxRows = null, fxErr = "", adrK = 1;
  /** 평균(흐름)·기말(잔액) 환율 출처 메모 — 검증기가 FRED 에서 따로 받은 H.10(FX_IND_MARK) 또는 미고시 사유 */
  const fxWin = (start, end) => {
    if (!fxRows) return "";
    const why = fxPendingWhy(fxRows, end);
    if (why) return ` · ${why}`;
    const n = fxRows.filter((q) => q.d >= start && q.d <= end).length;
    return ` · ${FX_IND_MARK}(연준 H.10 ${fxRows.series} ${start}~${end} 고시 ${n}일 산술평균 — 검증기가 FRED 에서 따로 받음)`;
  };
  const fxAt = (date) => {
    if (!fxRows) return "";
    const why = fxPendingWhy(fxRows, date);
    return why ? ` · ${why}` : ` · ${FX_IND_MARK}(연준 H.10 ${fxRows.series} ${fxRows.filter((q) => q.d <= date).at(-1)?.d} 고시 — ${date} 이전 마지막, 검증기가 FRED 에서 따로 받음)`;
  };
  if (natCur) {
    fxRows = await fxDaily(natCur).catch((e) => { fxErr = `H.10 환율 조회 실패: ${String(e).slice(0, 60)}`; hardErrors.push(fxErr); return null; });
    // ADR 비율 — SEC 표지 주식수(보통주) ÷ 인포맥스 주식수(ADR). 1.5배 안이면 1:1
    const dei = (f.facts.dei?.EntityCommonStockSharesOutstanding?.units?.shares ?? []).reduce((b, e) => (!b || e.end > b.end ? e : b), null);
    const ims = await infomaxShares(sym).catch((e) => { hardErrors.push(`인포맥스 주식수(ADR 비율) 조회 실패: ${String(e).slice(0, 60)}`); return null; });
    if (dei && ims?.shares) { const r = dei.val / ims.shares; adrK = r > 1.5 || r < 1 / 1.5 ? r : 1; }
  }

  const niP = ann("NetIncomeLoss"), plP = ann("ProfitLoss"), nciP = ann("NetIncomeLossAttributableToNoncontrollingInterest");
  const epsP = ann("EarningsPerShareDiluted", "USD/shares"), epsBP = ann("EarningsPerShareBasic", "USD/shares");
  const wDilP = ann("WeightedAverageNumberOfDilutedSharesOutstanding", "shares"), wBasP = ann("WeightedAverageNumberOfSharesOutstandingBasic", "shares");
  const niDilP = ann("NetIncomeLossAvailableToCommonStockholdersDiluted"), niBasP = ann("NetIncomeLossAvailableToCommonStockholdersBasic");
  const prefDivP = ann("PreferredStockDividendsIncomeStatementImpact");
  // 매출 후보 — 결산기 판정용(모든 후보의 결산일 합집합)과 매출 대조용(결산기별 첫 후보)
  // 오너 결정 2026-09-24: 총매출(Revenues) 우선 — 손익계산서 첫 줄
  const REV_TAGS = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet", "RevenuesNetOfInterestExpense"];
  const revByTag = REV_TAGS.map((t) => [t, ann(t)]);
  const revP = new Map(revByTag.flatMap(([, m]) => [...m]));
  // 매출 A층 기대값 — 손익계산서 본표 매출 줄(검증기 독립 판독, 태그 순서 아님). 외화 공시는 환율 대조로 따로(아래)
  let revFace = null, revFaceWhy = foreign ? "외화 공시 — 환산 환율 대조로 검증" : "";
  if (!foreign) {
    const bankLayout = !h.rows.some((r) => r.key === "ev");
    try { const r = await secFaceRevenue(cik, sub, G, bankLayout); if (r.why) revFaceWhy = r.why; else revFace = r; }
    catch (e) { revFaceWhy = `본표 매출 줄 판독 실패: ${String(e).slice(0, 60)}`; hardErrors.push(revFaceWhy); }
  }
  // 매출원가·매출총이익 A층 기대값(--metric=cogs 에서만). 외화 공시(20-F)는 원통화 본표를 읽어 기간 평균 환율로 환산해 대조(연간만)
  let cogsFace = null, cogsWhy = "";
  if (COGS_MODE) {
    if (foreign && !natCur) { cogsWhy = "외화 공시인데 보고 통화를 못 찾음"; hardErrors.push(cogsWhy); }
    else {
      try {
        const r = await secFaceCogs({ cik, sub, facts: f.facts, unit: foreign ? natCur : "USD", foreign, rule: COGS_RULES[sym] ?? null });
        if (r.why) { cogsWhy = r.why; hardErrors.push(`매출원가 본표 판독: ${r.why}`); } else cogsFace = r;
      } catch (e) { cogsWhy = `본표 매출원가 판독 실패: ${String(e).slice(0, 60)}`; hardErrors.push(cogsWhy); }
    }
  }
  // 영업이익 A층 기대값(--metric=opinc). 금융사(SIC 6000~6499 — 은행·증권·보험·카드)는 범위 밖(앱은 기존 금융사 경로) — 검사를 만들지 않는다
  let opincFace = null, opincWhy = "";
  const opFinCo = sic >= 6000 && sic <= 6499;
  if (OPINC_MODE && !opFinCo) {
    if (foreign && !natCur) { opincWhy = "외화 공시인데 보고 통화를 못 찾음"; hardErrors.push(opincWhy); }
    else {
      try {
        const r = await secFaceOpinc({ cik, sub, facts: f.facts, unit: foreign ? natCur : "USD", foreign, revFace });
        if (r.why) { opincWhy = r.why; hardErrors.push(`영업이익 본표 판독: ${r.why}`); } else opincFace = r;
      } catch (e) { opincWhy = `본표 영업이익 판독 실패: ${String(e).slice(0, 80)}`; hardErrors.push(opincWhy); }
    }
  }
  // Yahoo 연간 총매출 — 비영업 분리 회사만(독립 확인용)
  const yRev = new Map();
  if (revFace?.split) {
    try {
      const ys = await (await yahoo()).fundamentalsTimeSeries(sym, { period1: "2018-01-01", type: "annual", module: "financials" }, { validateResult: false });
      for (const r of ys) if (r.totalRevenue != null) yRev.set(new Date(r.date).toISOString().slice(0, 10), r.totalRevenue);
    } catch (e) { hardErrors.push(`Yahoo 연간 매출 조회 실패: ${String(e).slice(0, 60)}`); }
  }
  // 비지배지분·우선주 "흔적" — 결산일 기준. 흔적이 있는 해에는 순이익 정의 대체를 하지 않는다(검증불가)
  const traceEnds = (tags) => {
    const s = new Set();
    for (const t of tags) for (const arr of Object.values(G[t]?.units ?? {})) for (const e of arr) if (e.val && /^(10-K|20-F)/.test(e.form)) s.add(e.end);
    return s;
  };
  const nciTrace = traceEnds(["NetIncomeLossAttributableToNoncontrollingInterest", "MinorityInterest", "RedeemableNoncontrollingInterestEquityCarryingAmount", "NetIncomeLossAttributableToRedeemableNoncontrollingInterest", "TemporaryEquityCarryingAmountAttributableToParent"]);
  const prefTrace = traceEnds(["PreferredStockDividendsIncomeStatementImpact", "DividendsPreferredStock", "PreferredStockValue", "PreferredStockValueOutstanding", "PreferredStockDividendsAndOtherAdjustments", "TemporaryEquityCarryingAmountAttributableToParent", "UndistributedEarningsLossAllocatedToParticipatingSecuritiesBasic", "DistributedEarnings"]);
  const traceNear = (set, end) => [...set].some((e) => dayDiff(e, end) <= 7);

  /** 지배주주 순이익(기준값) — { v, note } | { v:null, why } */
  function parentNi(end) {
    const n = atEnd(niP, end);
    if (n) return { v: n.val, ...(retagNote(n) ? { note: retagNote(n) } : {}) };
    const pl = atEnd(plP, end), nci = atEnd(nciP, end);
    if (pl && nci) return { v: pl.val - nci.val, note: "ProfitLoss − 비지배지분" };
    if (pl && !traceNear(nciTrace, end)) return { v: pl.val, note: "ProfitLoss(그 해 비지배지분 흔적 없음)" };
    if (pl) return { v: null, why: "NetIncomeLoss 없음, ProfitLoss 에 비지배지분이 섞였는지 확정 불가" };
    return { v: null, why: "순이익 태그 없음" };
  }
  /**
   * SEC 원자료로 직접 계산한 TTM — 최근 4개 분기 합(secQuarterSum, 앱 LTM 정의 — 오너 결정 2026-09-28), 못 채우면 종전 식(최근 사업연도 + 당기 누적 − 전년 동기 누적). old = true 면 종전 식만 — { v, end } | null.
   * 앱 LTM 계산을 재현하려는 게 아니라 공시 숫자만으로 같은 기간의 합계를 따로 낸다.
   */
  function secTtm(tag, old = false) {
    const arr = (G[tag]?.units?.USD ?? []).filter((e) => e.start && /^(10-K|10-Q)/.test(e.form));
    if (!arr.length) return null;
    const dur = (e) => (Date.parse(e.end) - Date.parse(e.start)) / 864e5;
    const latestEnd = arr.reduce((m, e) => (e.end > m ? e.end : m), "");
    // 최신 공시값 — 같은 기간의 반올림 재태깅은 제외(가장 최근 기간 묶음 안에서)
    const pick = (pred) => {
      const c = arr.filter(pred).sort((a, b) => ((a.filed ?? "") < (b.filed ?? "") ? 1 : -1));
      return c.length ? latestPrecise(c.filter((e) => e.start === c[0].start && e.end === c[0].end)) : null;
    };
    const fyLatest = pick((e) => e.end === latestEnd && dur(e) > 300 && dur(e) < 400);
    if (fyLatest) return { v: fyLatest.val, end: latestEnd, how: ["최근 사업연도", retagNote(fyLatest)].filter(Boolean).join(" · ") };
    const cur = arr.filter((e) => e.end === latestEnd && dur(e) < 300).sort((a, b) => dur(b) - dur(a))[0];
    if (!cur) return null;
    const prior = pick((e) => Math.abs(dayDiff(e.end, cur.end) - 365) <= 10 && Math.abs(dur(e) - dur(cur)) <= 10);
    const fy = pick((e) => dur(e) > 300 && dur(e) < 400 && dayDiff(e.end, cur.start) <= 10);
    // 분기 4개 합(앱 LTM 정의 — 오너 결정 2026-09-28). 못 채우면 종전 식
    const qs = old ? null : secQuarterSum(tag, latestEnd);
    if (qs) return { v: qs.sum, end: latestEnd, how: `분기 4개 합(${qs.parts.map((p) => `${p.end} ${p.v}(${p.how})`).join(" + ")})` };
    if (!prior || !fy) return null;
    return { v: fy.val + cur.val - prior.val, end: latestEnd, how: ["분기 4개 구성 불가 — 종전 식: 사업연도 + 당기누적 − 전년동기", ...[fy, prior].map(retagNote)].filter(Boolean).join(" · ") };
  }
  /**
   * SEC 3개월값 4개 합(원인 R4 — Yahoo·인포맥스 LTM 은 분기 값 합이다). 기준일 ltmEnd 로 끝나는 최근 1년 안의 분기 종료일
   * 4개마다 10-Q 3개월값, 없으면(회계연도 4분기) 사업연도 − 9개월 누적. 각 값은 반올림 재태깅 제외 최신 공시.
   * → { sum, parts } | null (분기 4개를 못 채우면 null)
   */
  function secQuarterSum(tag, ltmEnd) {
    const arr = (G[tag]?.units?.USD ?? []).filter((e) => e.start && /^(10-K|10-Q)/.test(e.form ?? ""));
    const dur = (e) => (Date.parse(e.end) - Date.parse(e.start)) / 864e5;
    const ends = [];
    for (const e of arr) {
      const d = dur(e);
      if (!((d >= 80 && d <= 100) || (d >= 350 && d <= 380))) continue;
      const age = (Date.parse(ltmEnd) - Date.parse(e.end)) / 864e5;
      if (age < -7 || age > 340) continue;
      if (!ends.some((x) => dayDiff(x, e.end) <= 7)) ends.push(e.end);
    }
    if (ends.length !== 4) return null;
    const parts = [];
    for (const end of ends.sort()) {
      const q = arr.filter((e) => dayDiff(e.end, end) <= 3 && dur(e) >= 80 && dur(e) <= 100);
      if (q.length) { const p = latestPrecise(q.filter((e) => e.start === q.at(-1).start)); parts.push({ end, v: p.val, how: "3개월" }); continue; }
      const fy = arr.filter((e) => dayDiff(e.end, end) <= 3 && dur(e) >= 350 && dur(e) <= 380);
      if (!fy.length) return null;
      const fyE = latestPrecise(fy.filter((e) => e.start === fy.at(-1).start));
      const nine = arr.filter((e) => e.start === fyE.start && dur(e) >= 260 && dur(e) <= 285);
      if (!nine.length) return null;
      const n9 = latestPrecise(nine.filter((e) => e.end === nine.at(-1).end));
      parts.push({ end, v: fyE.val - n9.val, how: `사업연도 ${fyE.val} − 9개월 ${n9.val}` });
    }
    return { sum: parts.reduce((t, p) => t + p.v, 0), parts };
  }
  /** 보통주 귀속 순이익(기준값) */
  function commonNi(end) {
    const d = atEnd(niDilP, end) ?? atEnd(niBasP, end);
    if (d) return { v: d.val };
    const p = parentNi(end);
    if (p.v == null) return p;
    const pd = atEnd(prefDivP, end);
    if (pd) return { v: p.v - pd.val, note: [p.note, "− 우선주배당"].filter(Boolean).join(" ") };
    if (!traceNear(prefTrace, end)) return { v: p.v, note: [p.note, "우선주·참가증권 흔적 없음"].filter(Boolean).join(" · ") };
    return { v: null, why: "우선주·참가증권 흔적이 있는데 보통주 귀속 순이익 태그 없음" };
  }

  let splits = [], spinoffs = [], splitErr = "";
  // 분할 이력 조회 실패 시 계수 1로 대체하지 않는다 — EPS 대조를 검증불가로 두고 실행 전체를 실패 처리(재감사)
  try { const sp = await splitsOf(sym); splits = sp.splits; spinoffs = sp.spinoffs; for (const x of sp.spinoffs) review.push({ item: `분사 가격조정 ${x.date} (Yahoo 비율 ${x.num}:${x.den})`, note: "EPS 분할 보정에서 제외 — 앱 과거 주가가 이 조정을 받았다면 분사 이전 연도 시가총액·PER 이 낮게 나온다(점검 필요)" }); } catch (e) { splitErr = `분할 이력 조회 실패: ${String(e).slice(0, 60)}`; hardErrors.push(splitErr); }
  /** 공시 EPS 를 오늘 주식 기준으로 — 공시(filed) 이후에 일어난 분할만 나눈다 */
  const splitAdj = (e) => splits.filter((s) => s.date > (e.filed ?? e.end)).reduce((k, s) => k * s.ratio, 1);
  /** 계속영업·중단영업 희석 EPS — 같은 10-K(accn)에 둘 다 있는 가장 최근 공시 → { cont, disc, filed } | null */
  const contDiscEps = (date) => {
    const cont = annualAllAt("IncomeLossFromContinuingOperationsPerDilutedShare", "USD/shares", date);
    // 중단영업 희석 EPS 는 대체 태그도 본다(앱 fyEps 와 같은 두 개념)
    const disc = [...annualAllAt("IncomeLossFromDiscontinuedOperationsNetOfTaxPerDilutedShare", "USD/shares", date),
      ...annualAllAt("DiscontinuedOperationIncomeLossFromDiscontinuedOperationNetOfTaxPerDilutedShare", "USD/shares", date)];
    for (let i = cont.length - 1; i >= 0; i--) {
      const d = disc.filter((x) => x.accn && x.accn === cont[i].accn).at(-1);
      if (d) return { cont: cont[i].val, disc: d.val, filed: cont[i].filed };
    }
    return null;
  };

  let inst = new Map(), instErr = "";
  // 은행 레이아웃 = 은행 전용 줄(총예금·순수익) — 2026-10-01 부터 은행 하이라이트에도 EV 줄이 있다(오너 지시 "EV를 비워두면 안된다")
  const bank = h.rows.some((r) => r.key === "deposits" || r.key === "net_revenue");
  if (bank) {
    // 은행 EV 항등식 — EV = 시가총액 + 차입금 + 우선주·비지배지분 − 현금(같은 열 화면 값)
    const ix = (k0) => h.rows.find((r) => r.key === k0)?.values ?? [];
    const [mcB, dB, cB, pB, eB] = ["mktcap", "debt", "cash", "pref_nci", "ev"].map(ix);
    h.columns.forEach((col, i) => {
      if (col.kind === "estimate" || eB[i] == null) return;
      const exp = mcB[i] != null && dB[i] != null && cB[i] != null && pB[i] != null ? mcB[i] + dB[i] + cB[i] + pB[i] : null;
      add("D", "은행 EV = 시가총액 + 차입금 + 우선주·비지배지분 − 현금", col.kind === "ltm" ? "LTM" : col.label, same(eB[i], exp));
    });
  }
  const secBank = sic >= 6020 && sic <= 6199;
  add("B", "금융 레이아웃 = SEC 업종(SIC 6020~6199 은행·신용)", "-", bank === secBank || (bank && sic >= 6000 && sic < 6800)
    ? { status: PASS, note: `SIC ${sic}` } : { status: FAIL, note: `앱 ${bank ? "은행" : "일반"} 레이아웃 vs SIC ${sic}` });

  // ── B. 결산 기간 대조
  const fyCols = h.columns.filter((c) => c.kind === "fy");
  const ifrsEnds = [];
  for (const t of ["Revenue", "RevenueFromContractsWithCustomers", "ProfitLoss"]) for (const arr of Object.values(f.facts["ifrs-full"]?.[t]?.units ?? {})) for (const e of arr) if (e.start && /^20-F/.test(e.form) && (Date.parse(e.end) - Date.parse(e.start)) / 864e5 > 300) ifrsEnds.push(e.end);
  // 외화 us-gaap(ASML) 결산일 — 단위와 무관하게
  for (const t of ["Revenues", "NetIncomeLoss"]) for (const [u, arr] of Object.entries(G[t]?.units ?? {})) if (u !== "USD") for (const e of arr) if (e.start && /^(10-K|20-F)/.test(e.form) && (Date.parse(e.end) - Date.parse(e.start)) / 864e5 > 300) ifrsEnds.push(e.end);
  // SEC 공시 목록의 연간 보고 기준일 — companyfacts 가 공시를 통째로 빠뜨리는 경우(TSM 2025 20-F·BE)에도 결산기를 안다
  const rc = sub.filings?.recent ?? {};
  for (let i = 0; i < (rc.form ?? []).length; i++) if (/^(10-K|20-F)$/.test(rc.form[i]) && rc.reportDate?.[i]) ifrsEnds.push(rc.reportDate[i]);
  const secEnds = [...new Set([...niP.keys(), ...plP.keys(), ...revP.keys(), ...ifrsEnds])].sort();
  if (!secEnds.length) add("B", "SEC 연간 결산 존재", "-", { status: FAIL, note: has20F ? "20-F/IFRS 제출사 — us-gaap 연간 재무 없음(앱이 IFRS 를 안 읽음)" : "SEC 연간 순이익·매출 태그 없음" });
  if (foreign && !imAnnual) add("A", "외화 공시 대조 기준(인포맥스) 확보", "-", { status: FAIL, note: imErr || "인포맥스 종목 없음 — 외화 공시 원자료 대조 불가" });
  if (fyCols.length === 0) add("B", "연도 열 존재", "-", { status: FAIL, note: "하이라이트 연도 열 0개" });
  if (fyCols.length && secEnds.length) {
    // SEC 최근 5개 결산기가 모두 앱 열에 있어야 한다 — 앱 범위 안만 보면 최신 연도 누락을 놓친다(재감사)
    const today = new Date().toISOString().slice(0, 10);
    for (const end of secEnds.filter((e) => e <= today).slice(-5))
      if (!fyCols.some((c) => dayDiff(c.date, end) <= 7))
        add("B", "SEC 10-K 결산기 ↔ 앱 연도 열", end, { status: FAIL, note: `SEC 결산일 ${end} 에 해당하는 연도 열 없음` });
    for (const c of fyCols)
      add("B", "SEC 10-K 결산기 ↔ 앱 연도 열", c.label, secEnds.some((e) => dayDiff(e, c.date) <= 7)
        ? { status: PASS } : { status: FAIL, note: `앱 열 결산일 ${c.date} 이 SEC 결산일 목록에 없음` });
    const labs = fyCols.map((c) => c.label);
    if (new Set(labs).size !== labs.length) add("B", "연도 라벨 중복 없음", "-", { status: FAIL, note: labs.join(",") });
    // 연도 라벨의 연도 자체 — SEC 가 붙인 사업연도(fy = DocumentFiscalYearFocus)와 대조(감사: 결산일만 보고 연도는 안 봤다).
    // companyfacts 의 fy 는 "그 공시의" 사업연도라, 각 연간 공시(accn)에서 가장 늦은 결산일(=당기)에만 붙여 쓴다.
    // 52/53주 결산(1월 1~7일 결산)은 SEC fy 가 전년도라 CLAUDE.md fiscalYearOf 규칙과 같은 결과가 나와야 한다.
    const byAccn = new Map();
    for (const ns of ["us-gaap", "ifrs-full"]) for (const con of Object.values(f.facts[ns] ?? {})) for (const arr of Object.values(con.units ?? {})) for (const e of arr) {
      if (e.fp !== "FY" || !/^(10-K|20-F)$/.test(e.form) || !e.start || !e.fy || !e.accn) continue;
      const d = (Date.parse(e.end) - Date.parse(e.start)) / 864e5;
      if (d < 300 || d > 400) continue;
      const p = byAccn.get(e.accn);
      if (!p || e.end > p.end) byAccn.set(e.accn, { end: e.end, fy: e.fy, filed: e.filed ?? "" });
    }
    const fyByEnd = new Map(); // 당기 결산일 → { fy, filed } (같은 결산일이면 최신 제출분)
    for (const v of byAccn.values()) { const p = fyByEnd.get(v.end); if (!p || v.filed > p.filed) fyByEnd.set(v.end, v); }
    for (const c of fyCols) {
      const s = [...fyByEnd].filter(([end]) => dayDiff(end, c.date) <= 7).sort((a, b) => dayDiff(a[0], c.date) - dayDiff(b[0], c.date))[0]?.[1];
      const y = Number(/^(\d{4})/.exec(c.label)?.[1]);
      // 1~2월 결산을 "시작 연도"로 부르는 회사(HD·TGT — 2025-02-02 결산 = fiscal 2024)는 앱(결산일 연도)과 1년 어긋난다.
      // 어느 기준으로 라벨을 붙일지 오너 결정 보류(2026-09-24) — 그 관행에 정확히 해당할 때만 검증불가로 두고 나머지 불일치는 실패.
      // 1월 1~7일 결산(52/53주, WEN)은 앱 규칙상 전년도 라벨이어야 하므로 이 예외에서 뺀다(감사 3차 — 회귀를 가렸다).
      const endY = Number(s?.end.slice(0, 4)), endM = Number(s?.end.slice(5, 7)), endD = Number(s?.end.slice(8, 10));
      const startYearNaming = s && endM <= 2 && !(endM === 1 && endD <= 7) && y === endY && s.fy === endY - 1;
      add("B", "연도 라벨 = SEC 공시 사업연도(fy)", c.label, !s ? { status: NA, note: `결산일 ${c.date} 의 SEC 연간 공시 fy 없음` }
        : y === s.fy ? { status: PASS, note: `결산일 ${s.end} · SEC fy ${s.fy}` }
        : startYearNaming ? { status: NA, note: `보류(오너 결정 대기): 회사는 시작 연도로 부름 — 앱 ${c.label}(결산일 연도) vs SEC fy ${s.fy} (결산일 ${s.end})` }
        : { status: FAIL, note: `앱 라벨 ${c.label} vs SEC fy ${s.fy} (결산일 ${s.end})` });
    }
  }

  // ── 앱 값 표
  const H = {};
  const valRow = (k, i) => h.valuationRows.find((r) => r.key === k)?.values[i] ?? null;
  h.columns.forEach((c, i) => {
    if (c.kind === "estimate") return;
    const lab = c.kind === "ltm" ? "LTM" : c.label;
    const r = (k) => h.rows.find((x) => x.key === k)?.values[i] ?? null;
    H[lab] = {
      date: c.date, mc: r("mktcap"), op: r("opunits"), cash: r("cash"), debt: r("debt"), pn: r("pref_nci"),
      ev: r("ev"), ebitda: r("ebitda"), ni: r("ni"), eps: r("eps"), rev: r("revenue") ?? r("net_revenue"),
      per: valRow("per", i), pbr: valRow("pbr", i), psr: valRow("psr", i), evx: valRow("ev_ebitda", i),
      revYoy: r("revenue_yoy") ?? r("net_revenue_yoy"), ebitdaM: r("ebitda_m"), niM: r("ni_m"),
      evNote: h.rows.find((x) => x.key === "ev")?.cellNotes?.[i] ?? null,
    };
  });
  const evBlocked = (h.notes ?? []).find((n) => /EV.*(미표시|표시하지 않|계산하지 않)/.test(n));
  // 앱이 붙인 "EV 미표시" 사유를 그대로 믿지 않는다(재감사) — 원자료·결정 목록으로 따로 확인
  // 금융 자회사 보유사 = 오너 결정 목록(CLAUDE.md "EV 미표시: … F·GM·CAT·DE 등") + SEC 할부금융 채권 태그
  const CAPTIVE = new Set(["F", "GM", "CAT", "DE"]);
  const DEBT_TAGS = ["LongTermDebt", "LongTermDebtNoncurrent", "LongTermDebtCurrent", "DebtCurrent", "LongTermDebtAndCapitalLeaseObligations", "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities", "DebtLongtermAndShorttermCombinedAmount", "NotesPayable", "ShortTermBorrowings", "CommercialPaper", "ConvertibleNotesPayable", "ConvertibleNotesPayableCurrent", "SeniorNotes", "LineOfCredit", "LinesOfCreditCurrent", "OtherLongTermDebt", "OtherLongTermDebtNoncurrent", "DebtInstrumentCarryingAmount", "FinanceLeaseLiability", "FinanceLeaseLiabilityNoncurrent"];
  /** EV 가 빈 열의 사유를 **그 열 날짜 기준으로** 원자료에서 확인 — 사유 문구만 믿지 않는다(재감사).
   *  안내문은 종목 단위라, 예전엔 문구가 하나라도 있으면 EV 가 있는 연도까지 실패로 쳤다(SNDK 오판). */
  let ltmEvCheck = null; // 20-F LTM EV 미표시 사유의 독립 확인 결과(루프 전 비동기로 채운다)
  let fyDebtCheck = null; // 20-F 최근 FY 총차입금 기대값 대조(A층)
  // 금융 자회사 보유사 — 오너 결정 목록(CLAUDE.md) 이면서 SEC 최신 기말 금융채권(할부·리스 채권)이 자산의 10% 이상일 때
  let captiveSec = null;
  if (CAPTIVE.has(sym)) {
    const latest = (t) => (G[t]?.units?.USD ?? []).filter((e) => !e.start).reduce((b, e) => (!b || e.end > b.end || (e.end === b.end && (e.filed ?? "") > (b.filed ?? "")) ? e : b), null);
    const a = latest("Assets");
    const recv = ["FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLoss", "NotesAndLoansReceivableNetNoncurrent", "FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLossNoncurrent", "FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLossCurrent", "LoansAndLeasesReceivableNetReportedAmount", "SalesTypeAndDirectFinancingLeasesLeaseReceivable"]
      .map(latest).filter((e) => e && a && dayDiff(e.end, a.end) <= 7);
    const tot = recv.reduce((m, e) => Math.max(m, e.val), 0);
    captiveSec = a && tot / a.val >= 0.1 ? `금융 자회사 보유(오너 결정 목록 + SEC 금융채권 ${tot} = 자산의 ${(tot / a.val * 100).toFixed(1)}%, ${a.end})` : null;
    if (!captiveSec) review.push({ item: "금융 자회사 보유 판정", note: `오너 결정 목록 종목이나 SEC 금융채권 비중 10% 미만·태그 없음 — EV 미표시 강제 검사 생략` });
  }
  // 금융 부문 차입금(열 → { v, how }) — 그 열 기준일 정기공시 원본에서 부문 축(제품·사업부문·사업그룹) 금융 멤버(Financ·Credit, "Excluding" 제외) 한 차원 값.
  //    같은 부문을 두 멤버로 이중 태깅한 경우(CAT FinancialProductsMember·FinancialProductsSegmentMember)는 개념별 최댓값 하나만. 단기 = 단기차입금 + CP,
  //    유동성 장기 = 둘 중 큰 태그, 비유동 = 둘 중 큰 태그(검증기 독립 구현 — 앱 edgar-captive.ts 와 별개)
  const capFin = new Map();
  if (captiveSec) for (const [c0, x0] of Object.entries(H)) {
    if (!x0?.date) continue;
    try {
      const fa = await filingAtDate(cik, sub, x0.date);
      if (!fa) continue;
      const fin = fa.facts.filter((f) => f.dims.length === 1 && /^(ProductOrServiceAxis|StatementBusinessSegmentsAxis|SegmentsAxis|BusinessGroupAxis)$/.test(f.dims[0][0]) && /Financ|Credit/i.test(f.dims[0][1]) && !/Excluding/i.test(f.dims[0][1]));
      const mx = (ids) => Math.max(0, ...fin.filter((f) => ids.includes(f.id)).map((f) => f.v));
      const st = mx(["us-gaap_ShortTermBorrowings"]) + mx(["us-gaap_CommercialPaper"]);
      const cur = mx(["us-gaap_LongTermDebtAndCapitalLeaseObligationsCurrent", "us-gaap_LongTermDebtCurrent"]);
      const nc = mx(["us-gaap_LongTermDebtAndCapitalLeaseObligations", "us-gaap_LongTermDebtNoncurrent"]);
      if (st + cur + nc > 0) capFin.set(c0, { v: st + cur + nc, how: `${fa.form} ${fa.filed} 금융 부문 단기 ${st} + 유동성 장기 ${cur} + 장기 ${nc}` });
    } catch (e) { review.push({ item: "금융 부문 차입금 원본 판독 실패", note: `${c0}: ${String(e).slice(0, 60)}` }); }
  }
  const evBlockOkAt = (date) => {
    if (!evBlocked) return null;
    // 20-F LTM(Yahoo 분기)에서 앱이 EV 구성요소를 못 채워 LTM EV 를 비운 경우 — 사유("Yahoo FY말 총차입금 ≠ SEC")를 검증기가 따로
    // 확인했을 때만 인정(Yahoo 연간 총차입금 원통화 vs 앱 FY말 총차입금 ÷ 검증기 기말 환율). LTM 열에만.
    if (/LTM EV 미표시\(Yahoo 분기 LTM\)/.test(evBlocked)) return H.LTM && date === H.LTM.date && ltmEvCheck?.ok ? ltmEvCheck.ok : null;
    // 3차 감사: 할부금융 태그 하나로 인정하던 것(PEP·MRK 도 태그 1개)을 오너 결정 목록만으로 좁힘
    if (/금융 자회사|할부금융/.test(evBlocked)) return CAPTIVE.has(sym) ? "금융 자회사(오너 결정 목록)" : null;
    // 3차 감사: SIC 6000~6799 전체(리츠·보험 포함) → 앱 은행 레이아웃 + SIC 6020~6199 일치일 때만
    if (/은행|금융업|예수|보험/.test(evBlocked)) return bank && secBank ? `은행 레이아웃·SIC ${sic}` : null;
    if (/차입금 태그|태그 미공시|태그 없음|표준 태그/.test(evBlocked)) {
      // 그 날짜(±7일) 또는 1년 안쪽 이전 기말에 차입금 태그가 하나도 없어야 "미공시"가 맞다
      const tagged = DEBT_TAGS.some((t) => (G[t]?.units?.USD ?? []).some((e) => !e.start && e.end <= date && (Date.parse(date) - Date.parse(e.end)) / 864e5 <= 400 || (!e.start && dayDiff(e.end, date) <= 7)));
      return tagged ? null : "그 날짜 SEC 차입금 태그 없음 확인";
    }
    return null;
  };
  const rowOf = (stmt, name) => stmt?.sections?.flatMap((s) => s.items ?? []).find((x) => x.accountName === name)?.values ?? {};
  const lab = (k) => (k === "현재/LTM" ? "LTM" : k);
  const A = {}, IS = {}, BS = {};
  // "매출액" 첫 행 = 성장률(1년 YoY) 절 — 3년 CAGR 절의 같은 이름 행보다 앞에 있다
  for (const [name, key] of [["EV/EBITDA", "evx"], ["PER", "per"], ["PBR", "pbr"], ["PSR", "psr"], ["매출액", "revYoy"], ["순이익률 (%)", "niM"], ["영업이익률 (%)", "opM"]])
    for (const [k, v] of Object.entries(rowOf(an, name))) (A[lab(k)] ??= {})[key] = v;
  for (const [name, key] of [["EBITDA", "ebitda"], ["희석 EPS", "eps"], ["당기순이익", "ni"], ["매출액", "rev"], ["순수익", "rev"]])
    for (const [k, v] of Object.entries(rowOf(is, name))) if (v != null || (IS[lab(k)] ??= {})[key] == null) (IS[lab(k)] ??= {})[key] = v;
  // 영업이익 행은 합성 방식에 따라 이름 뒤에 설명이 붙는다("영업이익 (소계 없음 · …)")
  const rowStarts = (stmt, prefix) => stmt?.sections?.flatMap((s) => s.items ?? []).find((x) => x.accountName?.startsWith(prefix))?.values ?? {};
  for (const [prefix, key] of [["영업이익", "op"], ["세전이익", "pretax"]])
    for (const [k, v] of Object.entries(rowStarts(is, prefix))) (IS[lab(k)] ??= {})[key] = v;
  for (const [k, v] of Object.entries(rowOf(is, "감가상각비"))) (IS[lab(k)] ??= {}).da = v;

  // ── C층 화면 간 일치(2026-10-01, 오너 지시 "화면별로 수치가 다르게 나오는 것이 없는지") — 분기 화면 열(손익·재무상태표·현금흐름·총괄),
  //    총괄 = 각 재무제표(연간·분기), 하이라이트 영업현금흐름·자본지출 = 현금흐름표, 연간 LTM = 분기 최근 4개 합(손익·현금흐름), 재무상태표 LTM = 최근 분기
  // ── 현금흐름표 LTM 공란 정당성(2026-10-02 — 오너 지적 "현금흐름 감사가 제대로 이루어진거 맞음?": TSLA 투자자산·KO 운전자본 LTM 공란을
  //    놓쳤다). 앱 LTM 이 비었는데 야후 분기 현금흐름에 같은 항목이 앱의 최근 4개 분기(결산일 ±10일) 모두 있으면 실패 — 데이터가 있는데 앱이 못 이은 것
  if (BSCF_MODE && fetched.cf && fetched.cfq) {
    const CF_Y = {
      "cf:영업활동 현금흐름:운전자본 변동": ["changeInWorkingCapital"],
      "cf:영업활동 현금흐름:매출채권 증감": ["changesInAccountReceivables", "changeInReceivables"],
      "cf:영업활동 현금흐름:재고자산 증감": ["changeInInventory"],
      // changeInPayable 은 야후가 미지급 항목을 묶은 값이라 매입채무가 아니다(VST 분기 = 미지급법인세 변동 — 2026 Q1 −110 = 세금 −110, 10-Q 에 매입채무 줄 없음)
      "cf:영업활동 현금흐름:매입채무 증감": ["changeInAccountPayable"],
      "cf:투자활동 현금흐름:투자자산 취득": ["purchaseOfInvestment"],
      "cf:투자활동 현금흐름:투자자산 처분·만기": ["saleOfInvestment"],
      "cf:투자활동 현금흐름:사업 인수 (순현금)": ["purchaseOfBusiness"],
      "cf:재무활동 현금흐름:장기차입금 조달": ["longTermDebtIssuance", "issuanceOfDebt"],
      "cf:재무활동 현금흐름:장기차입금 상환": ["longTermDebtPayments", "repaymentOfDebt"],
      "cf:재무활동 현금흐름:배당금 지급": ["cashDividendsPaid", "commonStockDividendPaid"],
      "cf:재무활동 현금흐름:자기주식 취득": ["repurchaseOfCapitalStock", "commonStockPayments"],
      "cf:taxpaid": ["incomeTaxPaidSupplementalData"],
      "cf:intpaid": ["interestPaidSupplementalData"],
    };
    const items0 = (fetched.cf.sections ?? []).flatMap((x) => x.items ?? []);
    const qEnds = (fetched.cfq.periods ?? []).map((p0) => p0.endDate).slice(-4);
    const blanks = items0.filter((it) => CF_Y[it.accountId] && it.values?.["현재/LTM"] == null && Object.values(it.values ?? {}).some((v0) => v0 != null && v0 !== 0));
    if (blanks.length && qEnds.length === 4) {
      let yq = null;
      try {
        yq = await (await yahoo()).fundamentalsTimeSeries(sym, { period1: new Date(Date.parse(qEnds[0]) - 40 * 864e5), type: "quarterly", module: "cash-flow" }, { validateResult: false });
      } catch (e) {
        add("C", "현금흐름 LTM 공란 정당성(야후 분기)", "LTM", { status: NA, note: `야후 분기 조회 실패 ${String(e).slice(0, 60)}` });
      }
      for (const it of yq ? blanks : []) {
        const keys = CF_Y[it.accountId];
        const vals = qEnds.map((e0) => {
          const r = yq.find((x) => Math.abs(Date.parse(new Date(x.date).toISOString().slice(0, 10)) - Date.parse(e0)) <= 10 * 864e5);
          const k = r ? keys.find((k0) => r[k0] != null) : null;
          return k ? r[k] : null;
        });
        const note0 = it.cellNotes?.["현재/LTM"] ?? "";
        add("C", `현금흐름 LTM 공란 정당성 ${it.accountName}`, "LTM", vals.every((v0) => v0 != null)
          ? { status: FAIL, note: `앱 LTM 공란(${note0.slice(0, 50)})인데 야후 분기 4개 값 있음 — 합 ${vals.reduce((a0, b0) => a0 + b0, 0)}` }
          : { status: PASS, note: `야후 분기에도 없음(${vals.map((v0) => (v0 == null ? "-" : "값")).join("·")}) — 앱 공란 정당` });
      }
    }
  }
  if (BSCF_MODE && fetched.cfq && fetched.bsq && smq && isq && sm) {
    const rid = (st) => Object.fromEntries((st?.sections ?? []).flatMap((x) => x.items ?? []).map((it) => [it.accountId, it.values ?? {}]));
    const rnm = (st) => { const o = {}; for (const it of (st?.sections ?? []).flatMap((x) => x.items ?? [])) { const k0 = String(it.accountName ?? "").trim(); if (!(k0 in o)) o[k0] = it.values ?? {}; } return o; };
    const qcols = (st) => (st?.periods ?? []).map((p0) => `${p0.label}@${p0.endDate}`).join(",");
    const qI = qcols(isq);
    for (const [nm, st] of [["재무상태표", fetched.bsq], ["현금흐름표", fetched.cfq], ["총괄", smq]])
      add("C", `분기 화면 열 손익계산서 = ${nm}`, "-", qI === qcols(st) ? { status: PASS, note: qI } : { status: FAIL, note: `${qI} ≠ ${qcols(st)}` });
    const IAn = rnm(is), IQn = rnm(isq), BAi = rid(bs), BQi = rid(fetched.bsq), CAi = rid(fetched.cf), CQi = rid(fetched.cfq), SAi = rid(sm), SQi = rid(smq);
    const ivn = (I, re0, k0) => { const n0 = Object.keys(I).find((n) => re0.test(n)); return n0 ? I[n0][k0] ?? null : null; };
    const eqv = (nm, col, a, b0) => { if (a == null && b0 == null) return; add("C", nm, col, same(a, b0)); };
    for (const [S0, I0, B0, C0, per] of [[SAi, IAn, BAi, CAi, is?.periods], [SQi, IQn, BQi, CQi, isq?.periods]]) for (const p0 of per ?? []) {
      const k0 = p0.label, c0 = lab(k0);
      eqv("총괄 매출 = 손익계산서", c0, S0["sum:is:rev"]?.[k0], ivn(I0, /^매출액|^순수익/, k0));
      eqv("총괄 영업이익 = 손익계산서", c0, S0["sum:is:op"]?.[k0], ivn(I0, /^영업이익/, k0));
      eqv("총괄 순이익 = 손익계산서", c0, S0["sum:is:ni"]?.[k0], ivn(I0, /^당기순이익/, k0));
      eqv("총괄 자산 = 재무상태표", c0, S0["sum:bs:자산"]?.[k0], B0["bs:자산:자산 총계"]?.[k0]);
      eqv("총괄 부채 = 재무상태표", c0, S0["sum:bs:부채"]?.[k0], B0["bs:부채:부채 총계"]?.[k0]);
      eqv("총괄 자본 = 재무상태표", c0, S0["sum:bs:자본"]?.[k0], B0["bs:자본:자본 총계"]?.[k0]);
      eqv("총괄 영업현금흐름 = 현금흐름표", c0, S0["sum:cf:영업활동으로 인한 현금흐름"]?.[k0], C0["cf:total:영업활동 현금흐름"]?.[k0]);
      eqv("총괄 투자현금흐름 = 현금흐름표", c0, S0["sum:cf:투자활동으로 인한 현금흐름"]?.[k0], C0["cf:total:투자활동 현금흐름"]?.[k0]);
      eqv("총괄 재무현금흐름 = 현금흐름표", c0, S0["sum:cf:재무활동으로 인한 현금흐름"]?.[k0], C0["cf:total:재무활동 현금흐름"]?.[k0]);
    }
    const h0 = hl?.highlights;
    if (h0) for (const [i0, col] of h0.columns.entries()) {
      if (col.kind === "estimate") continue;
      const hr = (k1) => (h0.rows ?? []).find((r1) => r1.key === k1);
      if (hr("ocf")) eqv("하이라이트 영업현금흐름 = 현금흐름표", lab(col.label), hr("ocf").values[i0], CAi["cf:total:영업활동 현금흐름"]?.[col.label]);
      const cx = CAi["cf:투자활동 현금흐름:유형자산 취득"]?.[col.label];
      if (hr("capex")) eqv("하이라이트 자본지출 = 현금흐름표", lab(col.label), hr("capex").values[i0] == null ? null : Math.abs(hr("capex").values[i0]), cx == null ? null : Math.abs(cx));
    }
    const ql = (isq.periods ?? []).map((p0) => p0.label), l4 = ql.slice(-4), lq = ql.at(-1);
    const ltmEnd = (bs.periods ?? []).find((p0) => p0.label === "현재/LTM")?.endDate, qEnd = (isq.periods ?? []).at(-1)?.endDate;
    if (l4.length === 4 && ltmEnd && qEnd && dayDiff(ltmEnd, qEnd) <= 7) {
      const s4 = (I0, re0) => { const xs = l4.map((k0) => ivn(I0, re0, k0)); return xs.every((v0) => v0 != null) ? xs.reduce((a0, b1) => a0 + b1, 0) : null; };
      for (const [nm, re0] of [["매출", /^매출액|^순수익/], ["영업이익", /^영업이익/], ["당기순이익", /^당기순이익/], ["EBITDA", /^EBITDA/], ["감가상각비", /^감가상각비/]])
        eqv(`손익계산서 LTM = 분기 최근 4개 합 ${nm}`, "LTM", ivn(IAn, re0, "현재/LTM"), s4(IQn, re0));
      const cq = (fetched.cfq.periods ?? []).map((p0) => p0.label).slice(-4);
      for (const id of ["cf:total:영업활동 현금흐름", "cf:total:투자활동 현금흐름", "cf:total:재무활동 현금흐름", "cf:투자활동 현금흐름:유형자산 취득"]) {
        const xs = cq.map((k0) => CQi[id]?.[k0]);
        eqv(`현금흐름표 LTM = 분기 최근 4개 합 ${id.split(":").pop()}`, "LTM", CAi[id]?.["현재/LTM"], xs.length === 4 && xs.every((v0) => v0 != null) ? xs.reduce((a0, b1) => a0 + b1, 0) : null);
      }
      for (const id of ["bs:자산:자산 총계", "bs:부채:부채 총계", "bs:자본:자본 총계", "bs:자산:현금·현금성자산", "bs:note:총차입금"])
        eqv(`재무상태표 LTM = 최근 분기 ${id.split(":").pop()}`, "LTM", BAi[id]?.["현재/LTM"], BQi[id]?.[lq]);
    }
  }
  // ── C층 재무분석 지표 = 재무제표 화면 값으로 재계산(2026-10-01, 오너 지시 — "해결이 완료되는 부분들은 재무분석도"). 손익·재무상태표·현금흐름표 화면 값은
  //    A층(SEC)·외부 대조를 거친 값이므로, 재무분석이 같은 값을 쓰면 식대로 정확히 나와야 한다. 재무분석 모듈이 태그를 따로 읽어 생기던 차이를 잡는다
  //    (부채 파생에 비지배지분·임시자본 혼입 — KO·WMT·INTC·MRK·ORCL, 단기투자 정의 — CAT·INTC·KO·DELL, 포괄 배당 태그 — VRT). --metric=bscf 에서만(현금흐름표 필요)
  if (BSCF_MODE && fetched.cf && an && bs && is) {
    const byName = (st) => Object.fromEntries((st?.sections ?? []).flatMap((x) => x.items ?? []).map((it) => [String(it.accountName ?? "").trim(), it.values ?? {}]));
    const byId = (st) => Object.fromEntries((st?.sections ?? []).flatMap((x) => x.items ?? []).map((it) => [it.accountId, it.values ?? {}]));
    const AN = byName(an), IN = byName(is), BI = byId(bs), CI = byId(fetched.cf);
    // 섹션 구분(성장률 1년·3년 CAGR 에 같은 이름 행) — "섹션|행" 키
    const AS = {};
    { let sec = ""; for (const it of (an?.sections ?? []).flatMap((x) => x.items ?? [])) { const nm = String(it.accountName ?? "").trim(); if (String(it.accountId ?? "").startsWith("an:h:")) sec = nm; AS[`${sec}|${nm}`] = it.values ?? {}; } }
    const HLm = {};
    { const h0 = hl?.highlights; if (h0) { const cl = h0.columns.map((x) => x.label); for (const r0 of h0.rows ?? []) HLm[r0.key] = Object.fromEntries(cl.map((l, i) => [l, r0.values?.[i] ?? null])); } }
    const iv = (re, k) => { const n0 = Object.keys(IN).find((n) => re.test(n)); return n0 ? IN[n0][k] ?? null : null; };
    const keys = (an.periods ?? []).map((p0) => p0.label);
    const near = (a, e) => Math.abs(a - e) <= Math.max(1e-9, Math.abs(e) * 1e-9);
    for (const k of keys) {
      // 3년 CAGR(연간 열, 3년 전 열이 화면에 있을 때) — 매출액·EPS·주당배당금
      { const i0 = keys.indexOf(k), b3 = i0 >= 3 && k !== "현재/LTM" ? keys[i0 - 3] : null;
        if (b3) {
          const cg = (cur, base) => (cur != null && base != null && cur > 0 && base > 0 ? (Math.pow(cur / base, 1 / 3) - 1) * 100 : null);
          const hl3 = (key, kk) => { const h0 = hl?.highlights; if (!h0) return null; const ix = h0.columns.findIndex((x) => x.label === kk); const r0 = (h0.rows ?? []).find((x) => x.key === key); return ix >= 0 ? r0?.values?.[ix] ?? null : null; };
          const ivx = (re0, kk) => { const n0 = Object.keys(IN).find((n) => re0.test(n)); return n0 ? IN[n0][kk] ?? null : null; };
          for (const [nm, f0] of [["매출액", (kk) => ivx(/^매출액/, kk)], ["EPS", (kk) => ivx(/^희석 EPS/, kk)], ["주당배당금", (kk) => hl3("dps", kk)]]) {
            const exp = cg(f0(k), f0(b3)), a = AS[`성장률 (3년 CAGR)|${nm}`]?.[k];
            if (exp == null) continue;
            add("C", `재무분석 3년 CAGR ${nm} = 재무제표 화면 재계산`, lab(k), a == null ? { status: NA, note: `재무분석 빈칸(화면 재계산 ${exp})` } : Math.abs(a - exp) <= Math.max(1e-9, Math.abs(exp) * 1e-9) ? { status: PASS, note: `${nm} ${b3}→${k} 3년 CAGR` } : { status: FAIL, note: `재무분석 ${a} ≠ 화면 재계산 ${exp}` });
          }
        }
      }
      const c = lab(k), prev = keys[keys.indexOf(k) - 1], ann = k !== "현재/LTM" && prev && prev !== "현재/LTM";
      const rev = iv(/^매출액/, k), gp = iv(/^매출총이익/, k), ni = iv(/^당기순이익/, k), pre = iv(/^세전이익/, k), tax = iv(/법인세비용/, k);
      const ocf = CI["cf:total:영업활동 현금흐름"]?.[k] ?? null, capex = CI["cf:투자활동 현금흐름:유형자산 취득"]?.[k] ?? null;
      const div = CI["cf:재무활동 현금흐름:배당금 지급"]?.[k] ?? null, bb = CI["cf:재무활동 현금흐름:자기주식 취득"]?.[k] ?? null;
      const b = (id, kk = k) => BI[id]?.[kk] ?? null;
      const ca = b("bs:자산:유동자산 총계"), cl = b("bs:부채:유동부채 총계"), lt = b("bs:부채:부채 총계"), eq = b("bs:자본:자본 총계"), at = b("bs:자산:자산 총계");
      const cash = b("bs:자산:현금·현금성자산"), sti = b("bs:자산:단기 투자자산");
      const R = (name, row, exp, why) => {
        const a = (row.includes("|") ? AS[row] : AN[row])?.[k];
        if (exp == null || !Number.isFinite(exp)) return;
        if (a == null) { add("C", `재무분석 ${name} = 재무제표 화면 재계산`, c, { status: NA, note: `재무분석 빈칸(화면 재계산 ${exp})` }); return; }
        add("C", `재무분석 ${name} = 재무제표 화면 재계산`, c, near(a, exp) ? { status: PASS, note: why } : { status: FAIL, note: `재무분석 ${a} ≠ 화면 재계산 ${exp} · ${why}` });
      };
      R("매출총이익률", "매출총이익률 (%)", gp != null && rev ? (gp / rev) * 100 : null, "매출총이익 ÷ 매출액");
      R("유효세율", "유효세율 (%)", tax != null && pre ? (tax / pre) * 100 : null, "법인세비용 ÷ 세전이익");
      R("FCF 마진", "FCF 마진 (%)", ocf != null && capex != null && rev ? ((ocf - Math.abs(capex)) / rev) * 100 : null, "(영업현금흐름 − 유형자산 취득) ÷ 매출액");
      R("영업현금흐름/순이익", "영업현금흐름 / 순이익", ocf != null && ni ? ocf / ni : null, "영업현금흐름 ÷ 당기순이익");
      R("유동비율", "유동비율", ca != null && cl ? ca / cl : null, "유동자산 ÷ 유동부채");
      R("부채비율", "부채비율 (%)", lt != null && eq ? (lt / eq) * 100 : null, "부채 총계 ÷ 자본 총계");
      R("현금비율", "현금비율", cash != null && cl ? (cash + (sti ?? 0)) / cl : null, "(현금·현금성자산 + 단기 투자자산) ÷ 유동부채");
      // 현금흐름표 배당 줄이 "보통주 배당 아님"(BE — 파트너 분배)이면 보통주 배당 0 → 배당성향 0(오너 결정 2026-10-01)
      // 설명은 2026-10-02 부터 칸 주석에 있다(줄 이름엔 없음) — 이름·칸 주석 둘 다 본다
      const divRow = (fetched.cf?.sections ?? []).flatMap((x) => x.items ?? []).find((it) => it.accountId === "cf:재무활동 현금흐름:배당금 지급");
      const notCommon = [divRow?.accountName ?? "", ...Object.values(divRow?.cellNotes ?? {})].some((t) => /보통주 배당 아님/.test(String(t)));
      R("배당성향", "배당성향 (%)", notCommon ? (ni ? 0 : null) : div != null && ni ? (Math.abs(div) / ni) * 100 : null, notCommon ? "보통주 배당 없음(배당 줄은 파트너 분배) → 0" : "배당금 지급 ÷ 당기순이익");
      R("총주주환원율", "총주주환원율 (%)", (notCommon || div != null) && bb != null && ni ? (((notCommon ? 0 : Math.abs(div)) + Math.abs(bb)) / ni) * 100 : null, "(보통주 배당 + 자사주 취득) ÷ 당기순이익");
      // ── 전 지표(2026-10-01 오너 지시 "미국은 재무분석 전반내용까지") — 화면 값: 하이라이트(시가총액·EBITDA·FCF·DPS·영업현금흐름·자본지출), 재무상태표 주석
      //    (총차입금·순차입금·장기차입금(운용리스 제외)·운용리스 포함 총차입금), 본표 줄(매출채권·재고·매입채무·이익잉여금)
      const hv = (key) => HLm[key]?.[k] ?? null;
      const mc = hv("mktcap"), ebitda = hv("ebitda"), fcf = hv("fcf"), ocfH = hv("ocf");
      const debt = b("bs:note:총차입금"), nd = b("bs:note:순차입금"), ltd = b("bs:note:장기차입금 (운용리스 제외)"), debtL = b("bs:note:총차입금 (운용리스 포함)");
      const ar = b("bs:자산:매출채권"), inv = b("bs:자산:재고자산"), ap = b("bs:부채:매입채무"), re = b("bs:자본:이익잉여금(결손금)");
      const op = iv(/^영업이익/, k), cogs = iv(/^\(−\) 매출원가/, k);
      R("주가/FCF", "밸류에이션|주가 / FCF", mc != null && fcf ? mc / fcf : null, "시가총액 ÷ 잉여현금흐름(하이라이트)");
      R("FCF 수익률", "현금창출|FCF 수익률 (%)", mc && fcf != null ? (fcf / mc) * 100 : null, "잉여현금흐름 ÷ 시가총액");
      R("영업이익률", "수익성|영업이익률 (%)", op != null && rev ? (op / rev) * 100 : null, "영업이익 ÷ 매출액");
      R("총차입금/자기자본", "레버리지|총차입금 / 자기자본 (%)", debt != null && eq ? (debt / eq) * 100 : null, "총차입금(주석) ÷ 자본 총계");
      R("총차입금(운용리스 포함)/자기자본", "레버리지|총차입금(운용리스 포함) / 자기자본 (%)", debtL != null && eq ? (debtL / eq) * 100 : null, "운용리스 포함 총차입금(주석) ÷ 자본 총계");
      R("총차입금/총자산", "레버리지|총차입금 / 총자산 (%)", debt != null && at ? (debt / at) * 100 : null, "총차입금 ÷ 자산 총계");
      R("장기차입금/자기자본", "레버리지|장기차입금 / 자기자본 (%)", ltd != null && eq ? (ltd / eq) * 100 : null, "장기차입금(운용리스 제외, 주석) ÷ 자본 총계");
      R("장기차입금/총자산", "레버리지|장기차입금 / 총자산 (%)", ltd != null && at ? (ltd / at) * 100 : null, "장기차입금 ÷ 자산 총계");
      R("순차입금/자기자본", "레버리지|순차입금 / 자기자본 (%)", nd != null && eq ? (nd / eq) * 100 : null, "순차입금(주석) ÷ 자본 총계");
      R("총차입금/EBITDA", "재무건전성|총차입금 / EBITDA", debt != null && ebitda ? debt / ebitda : null, "총차입금 ÷ EBITDA(하이라이트)");
      R("순차입금/EBITDA", "재무건전성|순차입금 / EBITDA", nd != null && ebitda ? nd / ebitda : null, "순차입금 ÷ EBITDA");
      R("영업이익/총차입금", "재무건전성|영업이익 / 총차입금", op != null && debt ? op / debt : null, "영업이익 ÷ 총차입금");
      R("CFO/총차입금", "재무건전성|CFO / 총차입금", ocfH != null && debt ? ocfH / debt : null, "영업현금흐름 ÷ 총차입금");
      R("FCF/총차입금", "재무건전성|FCF / 총차입금", fcf != null && debt ? fcf / debt : null, "잉여현금흐름 ÷ 총차입금");
      R("당좌비율", "유동성|당좌비율", cash != null && cl ? (cash + (sti ?? 0) + (ar ?? 0)) / cl : null, "(현금 + 단기투자 + 매출채권) ÷ 유동부채");
      R("알트만 Z", "재무건전성|알트만 Z-스코어", at && ca != null && cl != null && re != null && op != null && mc != null && lt && rev != null
        ? 1.2 * ((ca - cl) / at) + 1.4 * (re / at) + 3.3 * (op / at) + 0.6 * (mc / lt) + 1.0 * (rev / at) : null, "1.2·운전자본/자산 + 1.4·이익잉여금/자산 + 3.3·영업이익/자산 + 0.6·시가총액/부채 + 1.0·매출/자산");
      if (ann) {
        const eqP = b("bs:자본:자본 총계", prev), atP = b("bs:자산:자산 총계", prev), clP = b("bs:부채:유동부채 총계", prev);
        const avg2 = (x, y) => (x != null && y != null ? (x + y) / 2 : null);
        const atA = avg2(at, atP), eqA = avg2(eq, eqP), clA = avg2(cl, clP);
        R("재무레버리지", "수익성|× 재무레버리지 (배)", atA != null && eqA ? atA / eqA : null, "평균 자산 ÷ 평균 자본");
        R("CFO/유동부채", "유동성|CFO / 유동부채", ocfH != null && clA ? ocfH / clA : null, "영업현금흐름 ÷ 평균 유동부채");
        const arP = b("bs:자산:매출채권", prev), invP = b("bs:자산:재고자산", prev), apP = b("bs:부채:매입채무", prev);
        R("DSO", "운전자본|매출채권 회전일수 (DSO)", ar != null && arP != null && rev ? (avg2(ar, arP) / rev) * 365 : null, "평균 매출채권 ÷ 매출 × 365");
        R("DIO", "운전자본|재고자산 회전일수 (DIO)", cogs && inv != null && invP != null ? (avg2(inv, invP) / Math.abs(cogs)) * 365 : null, "평균 재고 ÷ 매출원가 × 365");
        R("DPO", "운전자본|매입채무 회전일수 (DPO)", cogs && ap != null && apP != null ? (avg2(ap, apP) / Math.abs(cogs)) * 365 : null, "평균 매입채무 ÷ 매출원가 × 365");
        const pv = (key) => HLm[key]?.[prev] ?? null;
        const yo = (c0, p0, abs) => (c0 != null && p0 ? (((abs ? Math.abs(c0) : c0) - (abs ? Math.abs(p0) : p0)) / Math.abs(p0)) * 100 : null);
        const SG = "성장률 (1년 YoY)";
        R("성장률 매출액", `${SG}|매출액`, yo(rev, iv(/^매출액/, prev)), "매출액 전년 대비");
        R("성장률 EBITDA", `${SG}|EBITDA`, yo(ebitda, pv("ebitda")), "EBITDA(하이라이트) 전년 대비");
        R("성장률 영업이익", `${SG}|영업이익`, yo(op, iv(/^영업이익/, prev)), "영업이익 전년 대비");
        R("성장률 순이익", `${SG}|순이익`, yo(ni, iv(/^당기순이익/, prev)), "당기순이익 전년 대비");
        R("성장률 희석 EPS", `${SG}|희석 EPS`, yo(iv(/^희석 EPS/, k), iv(/^희석 EPS/, prev)), "희석 EPS 전년 대비");
        R("성장률 주당배당금", `${SG}|주당배당금`, yo(hv("dps"), pv("dps")), "주당배당금(하이라이트) 전년 대비");
        R("성장률 영업활동 현금흐름", `${SG}|영업활동 현금흐름`, yo(ocfH, pv("ocf")), "영업현금흐름 전년 대비");
        R("성장률 자본지출", `${SG}|자본지출`, yo(hv("capex"), pv("capex"), true), "자본지출(지출 크기) 전년 대비");
        R("성장률 잉여현금흐름", `${SG}|잉여현금흐름`, yo(fcf, pv("fcf")), "잉여현금흐름 전년 대비");
        R("ROE", "ROE (%)", ni != null && eq != null && eqP != null ? (ni / ((eq + eqP) / 2)) * 100 : null, "당기순이익 ÷ 평균 자본(기초·기말)");
        R("ROA", "ROA (%)", ni != null && at != null && atP != null ? (ni / ((at + atP) / 2)) * 100 : null, "당기순이익 ÷ 평균 자산");
        R("총자산회전율", "× 총자산회전율 (회)", rev != null && at != null && atP != null ? rev / ((at + atP) / 2) : null, "매출액 ÷ 평균 자산");
      }
    }
  }
  // 매출원가·매출총이익 행 — 이름 뒤에 설명이 붙을 수 있다("매출총이익 (합성 …)")
  const isItem = (stmt, re) => stmt?.sections?.flatMap((s) => s.items ?? []).find((x) => re.test(x.accountName ?? "")) ?? null;
  const COGS_ROW_RE = /^\(−\) 매출원가(\s|\(|$)/, GP_ROW_RE = /^매출총이익(\s|\(|$)/;
  for (const [k, v] of Object.entries(isItem(is, COGS_ROW_RE)?.values ?? {})) (IS[lab(k)] ??= {}).cogs = v;
  for (const [k, v] of Object.entries(isItem(is, GP_ROW_RE)?.values ?? {})) (IS[lab(k)] ??= {}).gp = v;
  // 앱 일회성비용 주석 행(edgar-oneoff.ts) — 외부 영업이익 차이의 원인 확인용
  for (const [k, v] of Object.entries(rowStarts(is, "일회성비용"))) (IS[lab(k)] ??= {}).oneOff = v;
  // 손익계산서 나머지 줄(2026-09-29 — 오너 지시 "안 한 항목도 다") — 법인세·기타·영업외손익·순이자비용·기타 영업비용·기본 EPS·판관비·연구개발비
  for (const [name, key] of [["(−) 법인세비용", "tax"], ["(−) 기타", "otherNi"], ["(−) 영업외손익", "nonop"], ["(순이자비용)", "netInt"], ["(−) 기타 영업비용", "otherOpex"], ["기본 EPS", "epsB"]])
    for (const [k, v] of Object.entries(rowOf(is, name))) (IS[lab(k)] ??= {})[key] = v;
  for (const [prefix, key] of [["(−) 판매관리비", "sga"], ["(−) 연구개발비", "rnd"]])
    for (const [k, v] of Object.entries(rowStarts(is, prefix))) (IS[lab(k)] ??= {})[key] = v;
  // 판관비·연구개발비 빈칸 사유 — "본표에 줄 없음"(= 0)이 아니면 기타 영업비용도 정할 수 없다(DAL 성격별 비용 본표 — 오너 결정 2026-09-28)
  for (const [re, key] of [[/^\(−\) 판매관리비/, "sgaWhy"], [/^\(−\) 연구개발비/, "rndWhy"]])
    for (const [k, v] of Object.entries(isItem(is, re)?.cellNotes ?? {})) (IS[lab(k)] ??= {})[key] = v;
  // 앱 영업이익 행 이름 — "영업이익" 그대로면 공시 태그, 뒤에 설명이 붙으면 합성(소계 없는 손익계산서 등)
  // 합성 영업이익 판정 — 예전엔 줄 이름 뒤 설명("영업이익 (소계 없음 · …)")으로 알았는데, 2026-10-02 부터 설명은 칸 주석에만 있다(오너 지시
  // "본문행과 주석에 같이 있는것은 주석만"). 칸 주석에 합성·근사 산식이 있으면 예전 이름 형식으로 되살려 아래 판정을 그대로 쓴다
  const opRowItem = is?.sections?.flatMap((s) => s.items ?? []).find((x) => x.accountName?.startsWith("영업이익")) ?? null;
  const opSynthNote = Object.values(opRowItem?.cellNotes ?? {}).find((t) => /^(영업이익 (소계|태그) 없음|소계 없음 · 세전이익)/.test(t ?? "")) ?? null;
  const opRowName = opRowItem ? (opRowItem.accountName === "영업이익" && opSynthNote ? `영업이익 (${opSynthNote})` : opRowItem.accountName) : null;
  for (const [name, key] of [["총차입금", "debt"], ["순차입금", "nd"], ["자산 총계", "assets"], ["부채와 자본 총계", "le"]])
    for (const [k, v] of Object.entries(rowOf(bs, name))) (BS[lab(k)] ??= {})[key] = v;
  const C = {};
  for (const r of cs?.rows ?? []) if (!r.isEstimate) C[`${r.fy}Y`] = r;
  // 컨센서스 화면은 최근 몇 개 연도만 보여준다 — 그 범위 안에서만 연도 존재를 요구
  const cActual = (cs?.rows ?? []).filter((r) => !r.isEstimate);
  if (cs && !cActual.length) add("C", "컨센서스 실적 행 존재", "-", { status: FAIL, note: "컨센서스 응답에 실적 연도 행이 0개" });
  const cMin = cActual.length ? Math.min(...cActual.map((r) => r.fy)) : Infinity;
  const eqP = new Map([...annualEnds("StockholdersEquity")]);
  function annualEnds(tag) {
    const m = new Map();
    for (const e of G[tag]?.units?.USD ?? []) if (!e.start && /^10-K/.test(e.form)) m.set(e.end, [...(m.get(e.end) ?? []), e]);
    return new Map([...m].map(([end, list]) => [end, latestPrecise(list)]));
  }
  const opP = new Map([...ann("OperatingIncomeLoss"), ...ann("IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest")]);

  // 영업이익 태그가 손익계산서 본표(계산 구조)에 실제로 있는가 — 앱이 구조 판독에 실패해 부문 주석 영업이익(DIS 형)으로
  // 조용히 돌아가도 같은 태그와 비교하면 통과해 버린다(재감사 HIGH). 최신 10-K 계산 구조(.xsd 내장 포함)로 따로 확인.
  let opOnFace = null, pretaxBeforeEq = false; // pretaxBeforeEq: 본표 세전이익 소계가 지분법 차감 전 태그(AMD 형)
  try {
    const rk = sub.filings?.recent ?? {};
    const ik = (rk.form ?? []).findIndex((fm) => fm === "10-K");
    if (ik >= 0) {
      const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${rk.accessionNumber[ik].replace(/-/g, "")}`;
      const names = (await secJson(base + "/index.json")).directory.item.map((x) => x.name);
      const calName = names.find((x) => /_cal\.xml$/i.test(x)) ?? names.find((x) => /\.xsd$/i.test(x));
      if (calName) {
        const cal = await secText(base + "/" + calName);
        opOnFace = false;
        for (const m of cal.matchAll(/<link:calculationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/link:calculationLink>/g)) {
          const role = m[1].split("/").pop() ?? "";
          if (!/INCOME|OPERATIONS|EARNINGS/i.test(role) || /Detail|Table|Parenth|Tax|Segment/i.test(role)) continue;
          const hb = /#us-gaap_IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"/.test(m[2]);
          const ha = /#us-gaap_IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest"/.test(m[2]);
          if (hb && !ha) pretaxBeforeEq = true;
          if (/#us-gaap_OperatingIncomeLoss"/.test(m[2])) { opOnFace = true; break; }
        }
      }
    }
  } catch (e) {
    hardErrors.push(`손익계산서 계산 구조 조회 실패: ${String(e).slice(0, 60)}`);
  }
  // 감가상각비 독립 대조 기준(최신 10-K 현금흐름표 본표 줄) — 은행·외화 공시 제외.
  // NFLX 는 콘텐츠 상각을 감가상각비에 넣는 오너 결정 종목이라(CLAUDE.md) 이 기준과 정의가 달라 대조하지 않는다.
  const CONTENT_DA = new Set(["NFLX"]);
  let cfDa = null, cfDaWhy = "";
  if (bank) cfDaWhy = "은행 레이아웃";
  else if (foreign) cfDaWhy = "외화 공시(USD 환산값)";
  else if (CONTENT_DA.has(sym)) cfDaWhy = "콘텐츠 상각 포함 종목(오너 결정) — 현금흐름표 기준과 정의 다름";
  else {
    try {
      const r = await secCashFlowDa(cik, sub, G);
      if (r.byEnd) cfDa = r; else cfDaWhy = r.why;
    } catch (e) {
      cfDaWhy = `현금흐름표 계산 구조 조회 실패: ${String(e).slice(0, 60)}`;
      hardErrors.push(cfDaWhy);
    }
  }
  // --metric=da: 감가상각비 A층 기대값 — 최근 10-K 3건·10-Q 4건 + 앱 열을 담은 과거 공시(secFaceDa). 은행 레이아웃·외화 공시는 범위 밖(검사 없음).
  // NFLX 는 콘텐츠 상각 줄을 포함한 정의로 대조한다(오너 결정 — 앱 감가상각비 = 현금흐름표 감가상각 줄 + 콘텐츠 상각 줄)
  let daFace = null, daWhy = "";
  if (DA_MODE && !bank && (!foreign || natCur)) {
    try {
      const r = await secFaceDa({ cik, sub, content: CONTENT_DA.has(sym), natCur: foreign ? natCur : null });
      if (r.why) daWhy = r.why; else daFace = r;
    } catch (e) { daWhy = `현금흐름표 감가상각 판독 실패: ${String(e).slice(0, 80)}`; hardErrors.push(daWhy); }
  }
  // --metric=sga: 판관비·연구개발비 A층 기대값 — 최근 연차 3건·10-Q 4건 + 앱 열을 담은 과거 공시(secFaceSga). 금융사(SIC 6000~6499)·은행 레이아웃은
  // 해당 없음(앱 빈칸 + "금융사" 사유 또는 행 없음), 20-F 는 원통화 본표 × H.10(연간만)
  let sgaFace = null, sgaWhy = "";
  const sgaFinCo = bank || (sic >= 6000 && sic <= 6499);
  if (SGA_MODE && !sgaFinCo && (!foreign || natCur)) {
    try {
      const r = await secFaceSga({ cik, sub, sym, natCur: foreign ? natCur : null });
      if (r.why) { sgaWhy = r.why; hardErrors.push(`판관비 본표 판독: ${r.why}`); } else sgaFace = r;
    } catch (e) { sgaWhy = `본표 판관비 판독 실패: ${String(e).slice(0, 80)}`; hardErrors.push(sgaWhy); }
  }
  // 앱 LTM 이 SEC 최신 정기공시 보고일보다 이르면(앱·companyfacts 가 같이 뒤처져도) 실패 — 재감사 HIGH
  {
    const rk = sub.filings?.recent ?? {};
    const latestRep = (rk.form ?? []).map((fm, i) => (/^10-[QK]$/.test(fm) ? rk.reportDate?.[i] : null)).filter(Boolean).sort().at(-1);
    const ltm = H.LTM?.date;
    if (latestRep && ltm) add("B", "앱 LTM 기준일 ≥ SEC 최신 정기공시 보고일", "LTM", Date.parse(ltm) >= Date.parse(latestRep) - 7 * 864e5
      ? { status: PASS, note: `앱 ${ltm} / SEC ${latestRep}` }
      : { status: FAIL, note: `앱 LTM ${ltm} 이 SEC 최신 정기공시 ${latestRep} 보다 이름(분기 누락)` });
  }

  // 결산일 실제 종가 = Yahoo 일별 종가(분할·분사 소급 조정값) × 결산일 이후 분할·분사 가격조정 계수(Yahoo 분할 이력, 앱과 독립).
  // 분사(WDC→SNDK 1323:1000)도 Yahoo 가 과거 종가를 조정하므로 되돌린다(EPS 보정과 달리 가격만의 조정).
  // 앱 결산일 주식수 = 앱 시가총액 ÷ 이 값 — 앱이 실제 종가를 썼다면 공시 주식수(정수)가 그대로 나온다.
  if (foreign && natCur && fxRows && H.LTM) { // 20-F FY 차입금 기대값은 항상 대조, LTM EV 공란 사유는 앱이 비웠을 때만 쓰인다
    try {
      // 감사 m2 + 오너 결정 "원칙 유지": SEC 원자료 FY 20-F 로 앱 규칙(본표 차입금 줄 + 리스)의 기대 차입금을 따로 계산하고(공통모드),
      // 앱 FY 차입금이 그 값(× 기말 환율)과 같은지, Yahoo FY 총차입금과의 차이가 무엇인지 숫자로 분해한 뒤, 그 차이 항목이 Yahoo 분기
      // 재무상태표에 없어서 같은 정의로 LTM 을 채울 수 없는지 확인한다.
      const c0 = Object.keys(H).filter((c) => c !== "LTM").sort((a, b) => H[a].date.localeCompare(H[b].date)).at(-1);
      const y0 = await yahoo();
      const ya = c0 ? await y0.fundamentalsTimeSeries(sym, { period1: "2018-01-01", type: "annual", module: "balance-sheet" }, { validateResult: false }) : [];
      const yr = ya.find((r) => r.totalDebt != null && dayDiff(new Date(r.date).toISOString().slice(0, 10), H[c0].date) <= 7);
      const yq = await y0.fundamentalsTimeSeries(sym, { period1: new Date(Date.parse(H.LTM.date) - 200 * 864e5), type: "quarterly", module: "balance-sheet" }, { validateResult: false });
      const yqL = yq.map((r) => ({ ...r, end: new Date(r.date).toISOString().slice(0, 10) })).filter((r) => dayDiff(r.end, H.LTM.date) <= 7).at(-1);
      const fl = c0 ? await filingAtDate(cik, sub, H[c0].date) : null;
      const unitRe = new RegExp(natCur, "i");
      const ex = fl ? expectedForeignDebt(fl, unitRe) : null;
      const rate = H[c0]?.date ? fxEndRate(fxRows, H[c0].date) : null;
      const partsTxt = ex ? ex.parts.map((x) => `${x.what} ${x.id.replace(/^[a-z0-9-]+_/, "")} ${x.v}`).join(" + ") : "";
      if (ex && rate != null) fyDebtCheck = { col: c0, r: vsSource(BS[c0]?.debt ?? null, ex.sum * rate, EXACT, `SEC ${fl.form} ${fl.date} 기대 차입금 ${ex.sum} ${natCur} = ${partsTxt} × 기말 환율 ${rate} · 공통모드(앱 규칙 재구현 — 차입금 규칙)${fxAt(H[c0].date)}`) };
      if (!yr || !ex) ltmEvCheck = { why: `Yahoo 연간 총차입금 또는 SEC ${c0} 기대 차입금 없음 — 사유 확인 불가` };
      else if (fyDebtCheck?.r.status !== PASS) ltmEvCheck = { why: `앱 ${c0} 차입금이 SEC 기대 차입금과 다름 — 사유 확인 전제 불성립` };
      else {
        const added = ex.parts.filter((x) => x.kind !== "face" && x.kind !== "note");
        const faceSum = ex.face.faceSum;
        const qHas = (k) => yqL && yqL[k] != null;
        let why = null;
        // (가) Yahoo FY = 본표 차입금 줄만 — 앱이 더한 주석 리스가 Yahoo 분기 재무상태표에 없다(TSM 유동 리스·ASML 금융리스)
        if (added.length && added.every((x) => ["curLease", "nonLease", "lease", "finLease"].includes(x.kind)) && Math.abs(yr.totalDebt - faceSum) <= 0.5) {
          const field = { curLease: "currentCapitalLeaseObligation", nonLease: "longTermCapitalLeaseObligation", lease: "capitalLeaseObligations", finLease: "capitalLeaseObligations" };
          const missing = added.filter((x) => !qHas(field[x.kind]));
          if (missing.length === added.length) why = `Yahoo ${c0} 총차입금 ${yr.totalDebt} = SEC 본표 차입금 줄 합 ${faceSum}(앱이 더한 ${added.map((x) => `${x.what} ${x.v}`).join(" + ")} 제외), Yahoo 분기(${yqL?.end ?? "없음"}) 재무상태표에 ${[...new Set(missing.map((x) => field[x.kind]))].join("·")} 없음`;
        }
        // (나) 본표 차입금 줄 없음(SAP): Yahoo FY = 사채 + CP + 리스, SEC Borrowings 에 그 밖의 차입금이 더 있다
        if (!why && ex.parts.some((x) => x.kind === "fallback")) {
          const bonds = ex.v0("ifrs-full_BondsIssued"), cp = ex.v0("ifrs-full_CommercialPapersIssued"), lease = ex.v0("ifrs-full_LeaseLiabilities") ?? 0, bor = ex.v0("ifrs-full_Borrowings");
          if (bonds != null && bor != null && Math.abs(yr.totalDebt - (bonds + (cp ?? 0) + lease)) <= 0.5 && bor - bonds - (cp ?? 0) > 0)
            why = `Yahoo ${c0} 총차입금 ${yr.totalDebt} = SEC 사채 ${bonds} + CP ${cp ?? 0} + 리스 ${lease} — SEC Borrowings ${bor} 의 기타 차입금 ${bor - bonds - (cp ?? 0)} 을 Yahoo 는 넣지 않음(분기 재무상태표에도 그 구분 없음)`;
        }
        ltmEvCheck = why ? { ok: `LTM EV 미표시 사유 확인 — ${why} → 같은 정의로 LTM 차입금을 채울 수 없음 · 앱 ${c0} 차입금 = SEC 기대값(${partsTxt})`, yDebt: yr.totalDebt }
          : { why: `Yahoo ${c0} 총차입금 ${yr.totalDebt} vs SEC 기대 ${ex.sum}(${partsTxt}) — 차이를 Yahoo 분기에 없는 항목으로 분해 못함` };
      }
    } catch (e) {
      hardErrors.push(`LTM EV 미표시 사유 확인(Yahoo 연간 재무상태표) 조회 실패: ${String(e).slice(0, 60)}`);
    }
  }
  let yCloses = null;
  if (!foreign && fyCols.length && !splitErr) {
    try {
      const first = fyCols.map((cc) => cc.date).sort()[0];
      const ch = await (await yahoo()).chart(sym, { period1: new Date(Date.parse(first) - 20 * 864e5), interval: "1d" });
      yCloses = ch.quotes.filter((q) => q.close != null).map((q) => ({ d: new Date(q.date).toISOString().slice(0, 10), c: q.close }));
    } catch (e) {
      hardErrors.push(`Yahoo 일별 종가(결산일 주식수) 조회 실패: ${String(e).slice(0, 60)}`);
    }
  }
  // 결산일 실제 체결가 = Yahoo 조정 종가 × 그 날 뒤 분할·분사 비율 누적곱을 **되돌린 뒤** 미국 호가 단위로 정리(오너 결정 2026-09-26).
  // Yahoo 종가는 float32 꼬리(146.9199981689453 = 146.92)가 있고, 인포맥스는 센트 종가를 곱한다. 앱도 같은 규칙(src 의 price-tick.ts)
  // 이지만 검증기는 import 하지 않고 여기서 따로 구현한다(공통모드 차단): $1 이상 센트, $1 미만 $0.0001, 0.5 는 0 에서 먼 쪽.
  // 조정가를 바로 반올림하지 않는다 — 분할 전 날짜의 조정가(49.522)는 센트로 표현되지 않는 게 정상
  const exchangeTick = (p) => { const a = Math.abs(p), k = a >= 1 ? 100 : 1e4; return (Math.sign(p) * Math.round(a * k)) / k; };
  const actualClose = (date) => {
    const q = yCloses?.filter((r) => r.d <= date).at(-1);
    return q && dayDiff(q.d, date) <= 7 ? exchangeTick(q.c * [...splits, ...spinoffs].filter((s) => s.date > date).reduce((k, s) => k * s.ratio, 1)) : null;
  };
  const appShares = (col) => { const p = H[col]?.mc != null ? actualClose(H[col].date) : null; return p ? H[col].mc / p : null; };
  /** SEC 결산일 본표 주식수 — 그 해 10-K(그 결산일 값을 처음 공시한 10-K) 기준, 후보 순서: 유통주식수 → 자본변동표
   *  SharesOutstanding → 발행 − 자기주식(같은 공시) → 발행(자기주식 태그 없음). CLAUDE.md 결산일 주식수 순서의 재구현(공통모드)
   *  — 가중평균 1.2배 검사·자본변동표 클래스 차원(WMT·BE·META)은 구현하지 않는다(그 경우 검증불가). */
  const secYearEndShares = (date, tol = 7) => {
    const firstAt = (t) => (G[t]?.units?.shares ?? []).filter((e) => !e.start && /^10-K/.test(e.form ?? "") && dayDiff(e.end, date) <= tol)
      .sort((a, b) => (a.filed ?? "").localeCompare(b.filed ?? ""))[0] ?? null;
    for (const t of ["CommonStockSharesOutstanding", "SharesOutstanding"]) { const e = firstAt(t); if (e) return { v: e.val, filed: e.filed, how: `${t}(${e.filed} 10-K)` }; }
    const iss = firstAt("CommonStockSharesIssued"), trs = firstAt("TreasuryStockShares") ?? firstAt("TreasuryStockCommonShares");
    if (iss && trs && iss.accn && iss.accn === trs.accn) return { v: iss.val - trs.val, filed: iss.filed, how: `발행 ${iss.val} − 자기주식 ${trs.val}(${iss.filed} 10-K)` };
    if (iss && !trs) return { v: iss.val, filed: iss.filed, how: `발행주식수(${iss.filed} 10-K, 자기주식 태그 없음)` };
    return null;
  };
  /** SEC 자산총계(결산일 ±7일, 최신 기준일 묶음) — 반올림 재태깅 제외 */
  /** 자본 정정(검증기 독립 구현, 오너 결정 2026-10-01 (다) — WDC FY2022): 그 결산일 자산총계를 실은 연간 공시의 지배주주 자본과 나중 정기공시가 다시 실은 자본이
   *  다르면(재무상태표 전체 재공시 없이 자본변동표 기초 잔액만 — 오류 정정) → { base, delta, filed }. 1억 단위 배수·자본 5% 초과 차이는 제외 */
  const eqRestate = (date) => {
    const af = new Set((G.Assets?.units?.USD ?? []).filter((e) => !e.start && /^(10-K|20-F|40-F)/.test(e.form ?? "") && dayDiff(e.end, date) <= 6).map((e) => e.filed));
    const se = (G.StockholdersEquity?.units?.USD ?? []).filter((e) => !e.start && /^(10-[KQ]|20-F|40-F)/.test(e.form ?? "") && dayDiff(e.end, date) <= 6);
    const col = se.filter((e) => af.has(e.filed));
    if (!col.length) return null;
    const last = (xs) => xs.reduce((a, b) => ((b.filed ?? "") > (a.filed ?? "") ? b : a));
    const base = last(col), lt = last(se);
    if (lt.val === base.val || (lt.filed ?? "") <= (base.filed ?? "")) return null;
    const delta = lt.val - base.val;
    if (Math.abs(delta) > Math.abs(base.val) * 0.05 || lt.val % 1e8 === 0) return null;
    return { base: base.val, delta, filed: lt.filed };
  };
  const assetsAt = (date) => {
    // 정기공시(10-K·10-Q·20-F)만 — 앱 재무상태표는 정기공시 판본으로 짠다(edgar-series ANNUAL_FORMS). 8-K 재작성본(GE 2021: 2023-04 8-K 가
    // LDTI 소급 적용으로 자산 198,874 → 205,378 백만, 자본 40,310 → 32,044)은 재무상태표 표시 기준이 아니다(자기자본만 PBR 분모에 재작성본 우선).
    const l = (G.Assets?.units?.USD ?? []).filter((e) => !e.start && /^(10-[KQ]|20-F|40-F)/.test(e.form ?? "") && dayDiff(e.end, date) <= 7);
    if (!l.length) return null;
    const end = l.map((e) => e.end).sort((p, q) => dayDiff(p, date) - dayDiff(q, date))[0];
    return latestPrecise(l.filter((e) => e.end === end));
  };
  /**
   * 결산일 주식수 SEC 후보 전부(감사 2026-09-25 — 불일치를 무조건 검증불가로 두면 가격 ×3 주입도 통과했다).
   * 기대값(expected) — 앱과 같은 규칙의 재구현(공통모드, 오너 결정 2026-09-25 "정확한 값 우선"):
   *  1. 판본: 같은 개념·같은 결산일의 공시값 중 **최신 공시**(나중 공시 정정). 단 최신값이 그 해 10-K 값의 분할 소급본(정수 배수)
   *     이거나 단위 오류(1000배 이상)면 그 해 10-K 값. 먼저 공시된 정밀값의 반올림으로 다시 태깅한 값은 판본에서 뺀다(MRVL 2022).
   *  2. 순서: 유통주식수 → 자본변동표 SharesOutstanding → 발행 − 자기주식(같은 공시의 두 값끼리만) → 발행. 같은 해 가중평균과
   *     1.2배 안(또는 정수 분할배수)인 첫 값.
   *  3. 정밀도: 같은 공시(accn) 안에서 반올림 범위(1천~100만) 안으로 일치하는 후보 중 가장 정밀한 값(CAT: 유통주식수 535,900,000
   *     대신 발행 − 자기주식 535,888,051).
   * 그 밖의 후보(판정 근거 표시용): 판본에서 밀린 값, 분할 소급본(÷ 그 사이 Yahoo 분할 배수), 표지(dei), 가중평균.
   * 자본변동표 클래스 차원(WMT·BE·META)은 없다 → 본표 후보가 없으면 검증불가.
   */
  const secShareCandidates = (date) => {
    const inst = (t) => (G[t]?.units?.shares ?? []).filter((e) => !e.start && /^10-[KQ]/.test(e.form ?? "") && dayDiff(e.end, date) <= 7)
      .sort((a, b) => (a.filed ?? "").localeCompare(b.filed ?? ""));
    const splitK = (filed) => splits.filter((s) => s.date > date && s.date <= (filed ?? "")).reduce((k, s) => k * s.ratio, 1);
    const nearInt = (r) => Math.round(r) >= 2 && Math.abs(r / Math.round(r) - 1) < 1e-3;
    /** 판본 선택 — list: [{ v, filed, form, accn }] 공시일 순 → { pick, why } */
    const choose = (list) => {
      if (!list.length) return null;
      const first10k = list.find((e) => /^10-K/.test(e.form ?? "")) ?? list[0];
      const kept = list.filter((e, i) => !list.slice(0, i).some((o) => roundingOf(e.v, o.v)));
      const latest = kept.at(-1);
      const r = latest.v / first10k.v;
      if (latest !== first10k && (nearInt(r) || nearInt(1 / r) || r >= 1000 || r <= 1 / 1000)) return { pick: first10k, why: `그 해 10-K — 최신 공시 ${latest.v}(${latest.filed})는 분할 소급·단위 오류` };
      return { pick: latest, why: latest === list.at(-1) ? (latest === first10k ? "그 해 10-K" : "최신 공시(정정)") : `최신 공시 — 나중 반올림 재태깅 ${list.at(-1).v}(${list.at(-1).filed}) 제외` };
    };
    const cands = [], ordered = [];
    const addOthers = (list, pick, lab) => {
      for (const e of list) {
        if (e === pick) continue;
        const k = splitK(e.filed);
        cands.push(k !== 1 ? { v: e.v / k, how: `${lab} 분할 소급본 ${e.v}(${e.filed} ${e.form}) ÷ 분할 ${k}` } : { v: e.v, how: `${lab} 다른 판본 ${e.v}(${e.filed} ${e.form})` });
      }
    };
    for (const t of ["CommonStockSharesOutstanding", "SharesOutstanding"]) {
      const l = inst(t).map((e) => ({ v: e.val, filed: e.filed, form: e.form, accn: e.accn }));
      const c = choose(l);
      if (c) ordered.push({ v: c.pick.v, accns: new Set(l.filter((e) => e.v === c.pick.v).map((e) => e.accn)), how: `${t}(${c.pick.filed} ${c.pick.form} · ${c.why})` });
      addOthers(l, c?.pick, t);
    }
    // 발행 − 자기주식: 같은 공시(accn)의 두 값끼리만
    const iss = inst("CommonStockSharesIssued"), trs = [...inst("TreasuryStockShares"), ...inst("TreasuryStockCommonShares")];
    const pairs = iss.map((e) => { const t = trs.find((x) => x.accn && x.accn === e.accn); return t ? { v: e.val - t.val, filed: e.filed, form: e.form, accn: e.accn, iss: e.val, trs: t.val } : null; }).filter(Boolean);
    const cp = choose(pairs);
    if (cp) ordered.push({ v: cp.pick.v, accns: new Set(pairs.filter((e) => e.v === cp.pick.v).map((e) => e.accn)), how: `발행 ${cp.pick.iss} − 자기주식 ${cp.pick.trs}(${cp.pick.filed} ${cp.pick.form} · ${cp.why})` });
    addOthers(pairs, cp?.pick, "발행 − 자기주식");
    // 발행주식수 단독 — 순서상 마지막 후보(발행 − 자기주식이 1.2배 검사에서 빠질 때: PEP 는 "발행" 태그가 유통 주식수라 발행 − 자기주식
    // 899M 이 가중평균 1,389M 과 안 맞는다)
    {
      const li = iss.map((e) => ({ v: e.val, filed: e.filed, form: e.form, accn: e.accn }));
      const ci = choose(li);
      if (ci) ordered.push({ v: ci.pick.v, accns: new Set(li.filter((e) => e.v === ci.pick.v).map((e) => e.accn)), how: `발행주식수(${ci.pick.filed} ${ci.pick.form} · ${ci.why}${trs.length ? "" : ", 자기주식 태그 없음"})` });
      addOthers(li, ci?.pick, "발행주식수");
    }
    const cover = (f.facts.dei?.EntityCommonStockSharesOutstanding?.units?.shares ?? []).filter((e) => /^10-K/.test(e.form ?? "") && e.end > date && dayDiff(e.end, date) <= 120);
    for (const e of cover) cands.push({ v: e.val, how: `표지(dei ${e.end}, ${e.filed} 10-K)`, otherDate: true });
    const wD = atEnd(ann("WeightedAverageNumberOfDilutedSharesOutstanding", "shares"), date), wB = atEnd(ann("WeightedAverageNumberOfSharesOutstandingBasic", "shares"), date);
    for (const [lab, w] of [["희석", wD], ["기본", wB]]) if (w) cands.push({ v: w.val, how: `가중평균 ${lab}(${w.filed})`, otherDate: true });
    const w = wD?.val ?? wB?.val ?? null;
    // 가중평균 주식수 단위 오류(MCD 716.4 = 백만 주 — CLAUDE.md fixScale)는 ×1천·×100만으로 맞춰 본다
    const plausible = (v) => { if (!w) return true; return [1, 1e3, 1e6].some((u) => { const r = v / (w * u); return (r >= 1 / 1.2 && r <= 1.2) || [2, 3, 4, 5, 10, 20, 50, 100].some((n) => Math.abs(r * n - 1) < 0.2 || Math.abs(r / n - 1) < 0.2); }); };
    let expected = ordered.find((o) => plausible(o.v)) ?? null;
    // 정밀도 — 같은 공시 안에서 기대값을 반올림값으로 갖는 더 정밀한 후보가 있으면 그 값(여러 단계면 가장 정밀한 것까지)
    for (let guard = 0; expected && guard < 4; guard++) {
      // 같은 공시 = 두 값이 함께 실린 공시(accn)가 하나라도 있음(판본 선택으로 고른 공시는 서로 다를 수 있다 — CAT)
      const finer = ordered.find((o) => o !== expected && [...o.accns].some((a) => a && expected.accns.has(a)) && roundingOf(expected.v, o.v));
      if (!finer) break;
      expected = { ...finer, how: `${finer.how} · 같은 공시의 ${expected.v}(${expected.how.split("(")[0]})보다 정밀 — 정확한 값 우선` };
    }
    return { expected, ordered, all: [...ordered, ...cands] };
  };
  /** a 가 b 를 1천·1만·10만·100만 단위로 반올림한 값인가(b 가 더 정밀) */
  const roundingOf = (a, b) => a !== b && [1e3, 1e4, 1e5, 1e6].some((u) => b % u !== 0 && Math.abs(Math.round(b / u) * u - a) <= 0.5);
  const SHARES_A = "결산일 주식수 앱(시총÷실제 종가) = SEC 본표 주식수";
  const sharesPassed = (col) => checks.some((k) => k.col === col && k.status === PASS && k.name === SHARES_A);
  /** SEC 공시 단위(값을 나누는 가장 큰 10의 거듭제곱, 최대 100만) */
  const secUnit = (v) => { let u = 1; while (u < 1e6 && v % (u * 10) === 0) u *= 10; return u; };

  for (const [c, x] of Object.entries(H)) {
    const isFy = c !== "LTM";
    // ── A. SEC 원자료 대조 (연도 열만 — 결산일로 매칭)
    if (isFy && foreign) {
      // 앱 USD = 원통화 공시값 × 기간 평균 환율. 환율은 검증기가 FRED 에서 따로 받은 연준 H.10(앱과 같은 공적 원천·같은 정의 — 독립 대조)이라
      // 정확히 같아야 한다(오너 지시 — "0% 맞춰라", 부동소수 표현 차만 — extEq). 앱 환율(역산)도 메모에 남긴다.
      // 창 끝이 H.10 최신 고시일 뒤면(미고시) 앱은 빈칸 + 사유여야 한다 — 값이 있으면 다른 환율로 대체한 것이라 FAIL
      const nat = nativeAt(x.date);
      const avg = nat && fxRows ? fxAvg(fxRows, nat.start, nat.end) : null;
      const pend = nat && fxRows ? fxPendingWhy(fxRows, nat.end) : null;
      const rateCheck = (name, app, native, k = 1) => {
        if (native != null && pend) return add("A", name, c, app == null ? { status: PASS, note: `${pend} — 앱 빈칸(대체 없음)` } : { status: FAIL, note: `${pend}인데 앱 값 ${app} — 다른 환율로 대체한 것으로 보임` });
        if (native == null || avg == null) return add("A", name, c, { status: NA, note: fxErr || "원통화 공시값 없음" });
        if (app == null) return add("A", name, c, { status: FAIL, note: `원통화 ${native} 있는데 앱 빈칸` });
        const exp = native * avg * k;
        const implied = app / (native * k);
        const ev = fxWin(nat.start, nat.end);
        add("A", name, c, extEq(app, exp)
          ? { status: PASS, note: `앱 ${app} = 원통화 ${native} × 연준 H.10 ${nat.start}~${nat.end} 산술평균 ${avg}${k !== 1 ? ` × ADR 비율 ${k}` : ""} (정확 일치)${ev}` }
          : { status: FAIL, note: `앱 ${app} ≠ 기대 ${exp} — 앱이 쓴 환율 ${implied.toPrecision(10)} vs H.10 기간 평균 ${avg.toPrecision(10)} (차 ${(((implied - avg) / avg) * 100).toFixed(4)}%)${ev}` });
      };
      rateCheck("매출 환산 환율 = 기간 평균(외화)", x.rev, nat?.rev ?? null);
      rateCheck("순이익 환산 환율 = 기간 평균(외화)", x.ni, nat?.ni ?? null);
      rateCheck("EPS 환산 환율 = 기간 평균(외화·ADR)", x.eps, nat?.eps ?? null, adrK);
      // 손익 줄(재감사 N1) — 손익계산서 화면 값 = SEC 원통화 × H.10 기간 평균. SEC 에 값이 있는데 화면이 비면 실패
      rateCheck("세전이익 환산 환율 = 기간 평균(외화)", IS[c]?.pretax ?? null, nat?.pt ?? null);
      rateCheck("법인세 환산 환율 = 기간 평균(외화)", IS[c]?.tax ?? null, nat?.tax ?? null);
      rateCheck("연구개발비 환산 환율 = 기간 평균(외화)", IS[c]?.rnd ?? null, nat?.rd ?? null);
      const im = imAnnual?.find((r) => dayDiff(r.end, x.date) <= 7);
      // 인포맥스(FactSet) USD 환산은 자체 환율(미공개)이라 연준 H.10 환산과 값이 다르다. 공시된 원천 환율로 정확 분해가 성립할 때만 ②,
      // 아니면 ③ 미해명(환율 출처 정의 차이 추정) — 숨기지 않는다(오너 결정 2026-09-27). 매출은 외부 대조가 켜져 있으면 F층 분류(put → causeOf)가
      // 판정하고, 순이익(분기별 환산 합산으로 보여 계절성만큼 더 벌어짐 — 실측 TSM 1.8~1.9%)은 여기 검토 목록에 남긴다
      if (!EXTERNAL && im?.rev && x.rev) review.push({ item: `${c} 매출 vs 인포맥스(USD 환산)`, ours: x.rev, other: im.rev, gapPct: ((x.rev - im.rev) / im.rev) * 100, note: FX_DEF_NOTE });
      if (im?.ni && x.ni) review.push({ item: `${c} 순이익 vs 인포맥스(USD 환산)`, ours: x.ni, other: im.ni, gapPct: ((x.ni - im.ni) / Math.abs(im.ni)) * 100, note: FX_DEF_NOTE });
    } else if (isFy) {
      const pn = parentNi(x.date);
      add("A", "순이익 앱 = SEC 지배주주 순이익", c, vsSource(x.ni, pn.v, EXACT, pn.note ?? pn.why ?? ""));
      // 결산일 주식수·시가총액 — 기대값(그 해 10-K 본표)과 정확 일치(±0.5주)면 통과. 앱이 기대값의 반올림본(나중 공시·분할
      // 소급본 — 정밀값이 있는데 덜 정밀한 값)을 쓰면 실패(CLAUDE.md "결산일마다 그 해의 10-K 값(공시 당시 기준)"), 어느 SEC
      // 후보와도 맞지 않으면 실패(가격·분할 오판 신호 — 비율이 분할·분사 배수·정수배면 메모). 다른 후보와만 맞으면 판정 보류.
      if (x.mc != null) {
        const sc = secShareCandidates(x.date), as = appShares(c), ex = sc.expected;
        const hit = (v) => as != null && Math.abs(as - v) <= 0.5;
        let r, used = ex; // 시가총액 기대값에 쓸 주식수(정밀 후보로 통과하면 그 값)
        // 본표 후보(유통·자본변동표·발행−자기주식·발행)가 하나도 없으면 판정하지 않는다 — 표지·가중평균만으로는 기준이 안 된다
        // (WMT: 자본변동표 클래스 차원 경로 미구현)
        if (!sc.ordered.length) r = { status: NA, note: `SEC 결산일 본표 주식수 태그 없음(자본변동표 클래스 차원 경로 미구현)${sc.all.length ? ` · 참고 후보 ${sc.all.map((o) => `${o.v}(${o.how})`).join(", ")}` : ""}` };
        else if (as == null) r = { status: NA, note: yCloses ? "결산일 종가 없음" : "Yahoo 일별 종가 없음" };
        else if (ex && hit(ex.v)) {
          // 같은 결산일의 본표 후보만(표지·가중평균은 다른 기준일이라 "더 정밀한 값"이 아니다)
          const finer = sc.all.find((o) => !o.otherDate && roundingOf(ex.v, o.v));
          r = { status: PASS, note: [`${ex.how} · 규칙 재구현(후보 순서·1.2배 검사는 공통모드)`, finer && `앱 결함 후보 — 더 정밀한 SEC 후보 ${finer.v}(${finer.how}), 본표 값이 반올림 공시`].filter(Boolean).join(" · ") };
        } else {
          const m = sc.all.find((o) => hit(o.v));
          // 앱이 쓴 값이 기대값보다 더 정밀(기대값 = 앱 값의 반올림 — NVDA 2024 2,464,300,000 분할 소급본 vs 그 해 10-K 2,464,000,000)
          // → 오너 결정 "정확한 값 우선"(2026-09-25): 그 해 10-K 값의 반올림 범위 안이면 통과
          if (m && ex && !m.otherDate && roundingOf(ex.v, m.v)) { r = { status: PASS, note: `정확한 값 우선 — 앱 ${as.toFixed(1)} = ${m.how}: 그 해 10-K 값 ${ex.v}(${ex.how})보다 정밀하고 그 반올림 범위 안 · 규칙 재구현(공통모드)` }; used = { v: m.v, how: m.how }; }
          else if (m && ex && !m.otherDate && roundingOf(m.v, ex.v)) r = { status: FAIL, note: `앱 ${as.toFixed(1)} = ${m.how} — 그 해 10-K 정밀값 ${ex.v}(${ex.how})의 반올림본(덜 정밀한 값 선택)` };
          else if (m) r = { status: NA, note: `판정 보류 — 앱 ${as.toFixed(1)} = ${m.how}, 기대 ${ex ? `${ex.v}(${ex.how})` : "없음(1.2배 검사 통과 후보 없음)"}` };
          else {
            const base = ex?.v ?? sc.all[0].v, k = as / base;
            const ratios = [...splits, ...spinoffs].map((s) => s.ratio);
            const sig = ratios.find((q) => Math.abs(k / q - 1) < 1e-3 || Math.abs(k * q - 1) < 1e-3) ?? (Math.abs(k - Math.round(k)) < 1e-3 && Math.round(k) >= 2 ? Math.round(k) : Math.abs(1 / k - Math.round(1 / k)) < 1e-3 && Math.round(1 / k) >= 2 ? `1/${Math.round(1 / k)}` : null);
            r = { status: FAIL, note: `앱 ${as.toFixed(1)} 이 SEC 후보 어느 것과도 다름(기대 ${ex ? `${ex.v} ${ex.how}` : "없음"}; 후보 ${sc.all.map((o) => o.v).join(", ")})${sig != null ? ` · 앱÷SEC = ${k.toFixed(4)} ≈ ${sig} — 결산일 가격·분할 오판 신호` : ""}` };
          }
        }
        add("A", SHARES_A, c, r);
        const px = actualClose(x.date);
        // 주식수 판정이 보류면 시가총액도 보류(같은 기대값을 쓰므로 판정만 중복된다)
        add("A", "결산일 시가총액 앱 = 결산일 실제 종가 × SEC 본표 주식수", c, r.status === NA ? { status: NA, note: `주식수 판정 보류 — ${r.note.slice(0, 80)}` }
          : !used || px == null ? { status: NA, note: !used ? "기대 주식수 없음" : "결산일 종가 없음" }
          : vsSource(x.mc, px * used.v, EXACT, `실제 종가 ${px}(Yahoo 종가 + 분할·분사 되돌림) × ${used.v}(${used.how})`));
      }
      // 매출 = SEC 본표 매출 줄(검증기 판독, 최신 판본) — 정확 일치. 은행도 본표 매출 줄(없으면 순수익 합성)
      {
        const sr = revFace?.annualAt(x.date) ?? null;
        let res = !revFace ? { status: NA, note: revFaceWhy } : vsSource(x.rev, sr?.v ?? null, EXACT, sr?.how ?? "읽은 공시(10-K 3건) 범위 밖");
        // 비영업 분리 기준은 앱과 같은 판정 규칙이라 독립 검증이 아니다(감사) — Yahoo 연간 매출도 같아야 통과
        if (sr?.split && res.status === PASS) {
          const yv = yRev.get([...yRev.keys()].find((d) => dayDiff(d, x.date) <= 7));
          // Yahoo 가 없으면 회사가 같은 공시에서 영업 매출 줄을 제품·서비스 차원 멤버로 직접 태깅한 값으로 확인(분리 규칙과 독립 —
          // 총액 − 비영업을 검증기가 계산한 값이 회사 자신의 태깅값과 정확히 같아야 한다. XOM 2021 SalesAndOtherOperatingRevenueMember)
          const own = yv == null ? sr.tagged?.find((t) => t.v === x.rev) : null;
          const vals = { app: res.app, src: res.src }; // 골든셋이 통과 행 값을 읽는다
          res = own ? { ...vals, status: PASS, note: `${sr.how} · 회사 태깅 영업 매출 줄 ${own.member} ${own.v} 와 정확 일치(분리 규칙과 독립 확인 — Yahoo 연간 없음)` }
            : yv == null ? { ...vals, status: NA, note: `${sr.how} — Yahoo 연간 매출 없음(독립 확인 불가)` }
            : extEq(yv, x.rev) ? { ...vals, status: PASS, note: `${sr.how} · Yahoo ${yv} 완전 일치` }
            : { ...vals, status: FAIL, note: `${sr.how} 로는 맞지만 Yahoo 연간 매출 ${yv} 와 다름` };
        }
        add("A", "매출 앱 = SEC 매출", c, res);
      }
      const e = atEnd(epsP, x.date);
      if (e && e.val === 0 && pn.v) {
        add("A", "EPS 앱 = SEC 공시 EPS(분할 보정)", c, x.eps == null ? { status: PASS, note: "공시 EPS 0(자리표시자) → 앱 빈칸" } : { status: FAIL, note: `공시 EPS 0(자리표시자)인데 앱 ${x.eps}` });
      } else if (e && splitErr) {
        add("A", "EPS 앱 = SEC 공시 EPS(분할 보정)", c, { status: NA, note: splitErr });
      } else if (e) {
        const k = splitAdj(e);
        let expected = e.val / k, splitNote = "";
        // 분할 재게시(오너 결정 2026-09-28 "원 공시 정밀값") — 분할 뒤 10-K 가 과거 EPS 를 분할 소급 후 소수 둘째 자리로 반올림해 다시 실으면
        // (NVDA FY2023 원 공시 1.74 → 0.17) 기준은 원 공시 ÷ 그 뒤 분할 배수(Yahoo 분할 이력으로 독립 산출) = 0.174. 반올림 관계일 때만
        const e0 = annualAllAt("EarningsPerShareDiluted", "USD/shares", x.date)[0];
        if (e0 && e0.val !== e.val && (e0.filed ?? "") < (e.filed ?? "")) {
          const k0 = splitAdj(e0), pre = e0.val / k0;
          if (k0 !== k && Math.abs(Math.round(pre * k * 100) / 100 - e.val) < 1e-9) { expected = pre; splitNote = `분할 재게시 — 원 공시 ${e0.val}(${e0.filed}) ÷ 분할 ${k0}(Yahoo 분할 이력) = ${pre}, 최신 공시 ${e.val} 는 그 반올림`; }
        }
        // 정확 비교(오너 원칙 — 허용치 통과 금지, 2026-09-25). 앱 fyEps = 공시값 × splitFactorsByYear 계수이고 반올림하지
        // 않는다(edgar-pershare.ts) → 기준 = 공시값 ÷ Yahoo 분할 배수, 부동소수 오차(상대 1e-9)만. 예전 허용치(0.006 + 0.3%)는
        // 작은 EPS 의 1% 오류·+0.004 오류를 통과시켰다(자체 주입).
        const r = vsSource(x.eps, expected, EXACT, "");
        const ok = x.eps != null && Math.abs(x.eps - expected) <= EXACT * Math.max(1, Math.abs(expected));
        add("A", "EPS 앱 = SEC 공시 EPS(분할 보정)", c, x.eps == null ? r : ok
          ? { status: PASS, ...(k !== 1 || retagNote(e) || splitNote ? { note: [splitNote, k !== 1 && !splitNote && `분할 보정 ÷${k}(Yahoo 분할 이력)`, retagNote(e)].filter(Boolean).join(" · ") } : {}), app: x.eps, src: expected }
          : { status: FAIL, note: `앱 ${x.eps} vs 공시 ${e.val}${k !== 1 ? ` ÷ 분할 ${k}` : ""} = ${expected}${splitErr ? ` · ${splitErr}` : ""}${retagNote(e) ? ` · ${retagNote(e)}` : ""}`, app: x.eps, src: expected });
      } else if (contDiscEps(x.date)) {
        // 총 희석 EPS 태그가 없고 계속영업·중단영업 희석 EPS 가 같은 10-K 에 둘 다 공시된 해 — 두 태그값의 합이 SEC 기준
        // (DELL FY2022 = 6.26 + 0.76). 공시 총 EPS 와 반올림 0.01 차이가 날 수 있어 허용치 없이 태그값 합 그대로 비교
        const cd = contDiscEps(x.date);
        if (splitErr) add("A", "EPS 앱 = SEC 공시 EPS(분할 보정)", c, { status: NA, note: splitErr });
        else {
          const k = splitAdj({ end: x.date, filed: cd.filed });
          const expected = (cd.cont + cd.disc) / k;
          const basis = `계속영업 ${cd.cont} + 중단영업 ${cd.disc} 희석 EPS(${cd.filed} 10-K, 총 EPS 태그 없음)${k !== 1 ? ` ÷ 분할 ${k}` : ""}`;
          add("A", "EPS 앱 = SEC 공시 EPS(분할 보정)", c, x.eps == null ? vsSource(null, expected, 0, basis)
            : Math.abs(x.eps - expected) <= 1e-9 * Math.max(1, Math.abs(expected)) ? { status: PASS, note: basis, app: x.eps, src: expected }
            : { status: FAIL, note: `앱 ${x.eps} vs ${basis} = ${expected}`, app: x.eps, src: expected });
        }
      } else {
        if (!inst.size && !instErr) inst = await classFactsFromInstances(cik).catch((err) => { instErr = String(err).slice(0, 80); hardErrors.push(`SEC 인스턴스(클래스별 EPS) 판독 실패: ${instErr}`); return new Map(); });
        const ie = [...inst].find(([end]) => dayDiff(end, x.date) <= 7)?.[1];
        add("A", "EPS 앱 = SEC 공시 EPS(분할 보정)", c, ie && !ie.basic && !splitErr
          // 인스턴스 값은 그 10-K 공시일 기준 — 이후 분할만 나눈다(최근 10-K 는 이미 재작성값일 수 있음)
          ? vsSource(x.eps, ie.eps / splitAdj({ end: x.date, filed: ie.filed }), EXACT, `${ie.basis} · 정확 비교(앱 classAEps 는 인스턴스 값을 그대로 씀)`)
          : { status: NA, note: instErr ? `인스턴스 판독 실패: ${instErr}` : ie?.basic ? "희석 EPS 는 클래스별로만 공시(기본 EPS 만 확인 가능)" : "공시 희석 EPS 없음" });
      }
    }
    // LTM 순이익 — SEC 분기 공시로 따로 계산한 TTM 과 대조(재감사: LTM 순이익은 원자료 대조가 없었음)
    if (!isFy && foreign) add("A", "LTM 순이익 앱 = SEC TTM", c, { status: NA, note: "외화 공시 — 분기 XBRL 없음(20-F)·환산은 인포맥스 대조로" });
    else if (!isFy) {
      const hasNciNow = [...nciTrace].some((e) => dayDiff(e, x.date) <= 400);
      // 감사 m1: 옛날에 끊긴 태그(기준일이 앱 LTM 과 다름)면 다음 태그로 — NetIncomeLoss → ProfitLoss − 비지배(또는 비지배 흔적이
      // 없으면 ProfitLoss) → 보통주 귀속 순이익(우선주 흔적 없을 때만)
      const fresh = (t0) => (t0 && dayDiff(t0.end, x.date) <= 7 ? t0 : null);
      const plNci = () => { const a = fresh(secTtm("ProfitLoss")), b = fresh(secTtm("NetIncomeLossAttributableToNoncontrollingInterest")); return a && b ? { v: a.v - b.v, end: a.end, how: `ProfitLoss − 비지배지분(${a.how})` } : null; };
      const t = fresh(secTtm("NetIncomeLoss")) ?? (hasNciNow ? plNci() : fresh(secTtm("ProfitLoss")))
        ?? (![...prefTrace].some((e) => dayDiff(e, x.date) <= 400) ? fresh(secTtm("NetIncomeLossAvailableToCommonStockholdersBasic")) : null)
        ?? secTtm("NetIncomeLoss") ?? (hasNciNow ? null : secTtm("ProfitLoss"));
      if (!t) add("A", "LTM 순이익 앱 = SEC TTM", c, { status: NA, note: "SEC 분기 순이익으로 TTM 계산 불가" });
      // 3차 감사: 앱 LTM 이 SEC 최신 분기보다 늦으면(한 분기 뒤처짐) 검증불가가 아니라 실패
      else if (Date.parse(x.date) < Date.parse(t.end) - 7 * 864e5) add("A", "LTM 순이익 앱 = SEC TTM", c, { status: FAIL, note: `앱 LTM 기준일 ${x.date} 이 SEC 최신 결산 ${t.end} 보다 늦음(분기 누락)` });
      else if (dayDiff(t.end, x.date) > 7) add("A", "LTM 순이익 앱 = SEC TTM", c, { status: NA, note: `기준일 다름(앱 ${x.date} / SEC ${t.end})` });
      else add("A", "LTM 순이익 앱 = SEC TTM", c, vsSource(x.ni, t.v, EXACT, t.how));
      // LTM 매출 = SEC 본표 매출 줄 최근 4개 분기 합(앱 LTM 정의, 오너 결정 2026-09-28 — 분기 못 채우면 종전 식)
      const lr = revFace?.ltmAt(x.date) ?? null;
      add("A", "매출 앱 = SEC 매출", c, !revFace ? { status: NA, note: revFaceWhy } : vsSource(x.rev, lr?.v ?? null, EXACT, lr?.how ?? `기준일 ${x.date} 의 SEC 누적 매출 조합 불가`));
    }
    // ── C. 화면 간 동일성
    if (!bank) add("C", "EV/EBITDA 하이라이트=재무분석", c, same(A[c]?.evx ?? null, x.evx));
    add("C", "PER 하이라이트=재무분석", c, same(A[c]?.per ?? null, x.per));
    add("C", "PBR 하이라이트=재무분석", c, same(A[c]?.pbr ?? null, x.pbr));
    add("C", "PSR 하이라이트=재무분석", c, same(A[c]?.psr ?? null, x.psr));
    add("C", "순이익 하이라이트=손익계산서", c, same(IS[c]?.ni ?? null, x.ni));
    add("C", "EPS 하이라이트=손익계산서", c, same(IS[c]?.eps ?? null, x.eps));
    add("C", "매출 하이라이트=손익계산서", c, same(IS[c]?.rev ?? null, x.rev));
    if (isFy) {
      if (!C[c]) { if (Number(c.slice(0, 4)) >= cMin || !cs) add("C", "컨센서스 연도 존재", c, cs ? { status: FAIL, note: "컨센서스 범위 안인데 이 연도 행 없음" } : { status: NA, note: "컨센서스 응답 없음" }); }
      else {
        if (!bank) add("C", "EV/EBITDA 컨센서스=하이라이트", c, same(C[c].evEbitda ?? null, x.evx));
        add("C", "PER 컨센서스=하이라이트", c, same(C[c].per ?? null, x.per));
        add("C", "PBR 컨센서스=하이라이트", c, same(C[c].pbr ?? null, x.pbr));
        add("C", "순이익 컨센서스=하이라이트", c, same(C[c].netIncome ?? null, x.ni));
        add("C", "EPS 컨센서스=하이라이트", c, same(C[c].eps ?? null, x.eps));
      }
    }
    if (!bank) {
      add("C", "EBITDA 하이라이트=손익계산서", c, same(IS[c]?.ebitda ?? null, x.ebitda));
      if (!captiveSec) {
        add("C", "차입금 하이라이트=대차대조표 주석", c, same(BS[c]?.debt ?? null, x.debt));
        add("C", "순차입금 하이라이트=대차대조표 주석", c, same(BS[c]?.nd ?? null, x.debt == null ? null : x.debt + (x.cash ?? 0)));
      } else {
        const fin = capFin.get(c);
        if (fin && x.debt != null) add("C", "순차입금 하이라이트 + 금융 부문 차입금 = 대차대조표 주석", c, same(BS[c]?.nd ?? null, x.debt + fin.v + (x.cash ?? 0)));
      }
    }
    // ── D. 항등식·부호 규칙·기대치
    const signRule = (name, mult, den) => {
      if (den == null) return;
      if (den <= 0) add("D", `${name} 부호 규칙(분모 ≤ 0 → 빈칸)`, c, mult == null ? { status: PASS } : { status: FAIL, note: `분모 ${den} 인데 ${name} ${mult}` });
      else add("D", `${name} 기대치(분모 > 0 → 값 있음)`, c, mult != null ? { status: PASS } : { status: FAIL, note: `분모 ${den} 인데 ${name} 빈칸` });
    };
    // 시가총액이 없는 해(상장 전)는 배수·EV 를 기대하지 않는다 — 대신 시가총액 부재를 기록
    if (x.mc == null) add("D", "시가총액 존재", c, { status: NA, note: "시가총액 없음(상장 전 등) — 배수·EV 기대치 생략" });
    if (x.mc != null) signRule("PER", x.per, x.eps);
    // 원자료로 정한 기대치 — 전 화면에서 같이 비어도 잡힌다(재감사: EBITDA·PBR·PSR 빈칸 회귀가 검증불가로만 남았음)
    if (isFy && !bank && atEnd(opP, x.date) && x.ebitda == null) add("D", "EBITDA 기대치(SEC 영업이익·세전이익 있음)", c, { status: FAIL, note: "SEC 에 이익 태그가 있는데 앱 EBITDA 빈칸" });
    // 영업이익·세전이익 = SEC 원자료 정확 일치(오너 지시 2026-09-24 — "허용치를 좁히는 것보다 완벽하게 일치").
    // 예전 "매출 25% 이내 괴리" 는 영업외 이익이 큰 정상 회사(GOOG 지분평가익·WDC)를 떨어뜨리고 보험·리츠 오류
    // (7.7%·12%)는 통과시켰다(재감사). 기간은 연도 열 = 10-K 결산일, LTM = SEC 분기 공시로 직접 낸 TTM.
    { const op = IS[c]?.op, pt = IS[c]?.pretax;
      const secNotes = [];
      const secAt = (tag) => {
        if (isFy) { const e = atEnd(ann(tag), x.date); if (retagNote(e)) secNotes.push(`${tag}: ${retagNote(e)}`); return e?.val ?? null; }
        const t = secTtm(tag);
        if (t && /반올림 재태깅|\[판본 #/.test(t.how)) secNotes.push(`${tag}: ${t.how}`);
        return t && dayDiff(t.end, x.date) <= 7 ? t.v : null;
      };
      // 본표 세전이익 소계가 지분법 차감 전 태그인 회사(AMD)는 그 태그가 기준(다른 태그는 법인세 주석 합계 — 오너 원칙 "본표 기준")
      const ptTags = pretaxBeforeEq ? ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments", ...PRETAX_TAGS] : PRETAX_TAGS;
      const secPt = ptTags.map(secAt).find((v) => v != null) ?? null;
      add("A", "세전이익 앱 = SEC 세전이익", c, vsSource(pt, secPt, EXACT, [pretaxBeforeEq ? "본표 세전이익 = 지분법 차감 전 소계" : "", ...secNotes].filter(Boolean).join(" · ")));
      // ── 손익계산서 나머지 줄(2026-09-29) ──
      if (!bank) {
        const I = IS[c] ?? {};
        // 항등식 — 계산 줄이 이미 SEC 로 확인한 줄들과 맞물리는지(한 줄이라도 빈칸이면 계산 줄도 빈칸이어야 한다)
        const ident = (name, got, parts, f, round = false) => {
          if (parts.some((v) => v == null)) return add("D", name, c, got == null ? { status: PASS, note: "구성 줄 빈칸 → 빈칸" } : { status: FAIL, note: `구성 줄 빈칸인데 앱 ${got}` });
          const exp = round ? Math.round(f(...parts)) : f(...parts);
          add("D", name, c, got != null && Math.abs(got - exp) < 1 /* 1달러 미만 — 외화 환산 금액의 달러 반올림(TSM 11,934,861 vs 11,934,860.96 · ASML 1.9e-6). 달러 공시는 값이 정수라 영향 없음 */ ? { status: PASS, app: got, src: exp } : { status: FAIL, note: `앱 ${got} vs 식 ${exp}`, app: got, src: exp });
        };
        ident("영업외손익 = 영업이익 − 세전이익", I.nonop, [I.op, I.pretax], (o, p) => o - p);
        ident("기타(비지배지분·중단영업 등) = 세전이익 − 법인세 − 순이익", I.otherNi, [I.pretax, I.tax, I.ni], (p, t, n) => p - t - n, true);
        const opexUnknown = (I.sga == null && I.sgaWhy && !/^본표에 줄 없음/.test(I.sgaWhy)) || (I.rnd == null && I.rndWhy && !/^본표에 줄 없음/.test(I.rndWhy));
        if (I.gp != null && I.op != null && opexUnknown) add("D", "기타 영업비용 = 매출총이익 − 판관비 − 연구개발비 − 영업이익", c, I.otherOpex == null ? { status: PASS, note: `판관비·연구개발비 빈칸(${(I.sga == null ? I.sgaWhy : I.rndWhy).slice(0, 60)}) → 빈칸` } : { status: FAIL, note: `판관비·연구개발비를 정할 수 없는데 앱 ${I.otherOpex}` });
        else if (I.gp != null && I.op != null) ident("기타 영업비용 = 매출총이익 − 판관비 − 연구개발비 − 영업이익", I.otherOpex, [I.gp, I.op], (g, o) => g - (I.sga ?? 0) - (I.rnd ?? 0) - o);
        // 법인세 = SEC IncomeTaxExpenseBenefit(연간 10-K · LTM = SEC TTM)
        secNotes.length = 0;
        const st = secAt("IncomeTaxExpenseBenefit");
        add("A", "법인세 앱 = SEC 법인세비용", c, st == null && I.tax == null ? { status: NA, note: "SEC 법인세 태그 없음" } : vsSource(I.tax, st, EXACT, secNotes.join(" · ")));
        // 순이자비용 = SEC 이자비용 − 이자수익(태그 목록 첫 값 — 앱과 같은 규칙 재구현, 공통모드)
        const firstOf = (tags) => { for (const t of tags) { const v = secAt(t); if (v != null) return { t, v }; } return null; };
        const ie = firstOf(["InterestExpense", "InterestExpenseNonoperating", "InterestAndDebtExpense", "InterestExpenseDebt"]);
        const ii = firstOf(["InvestmentIncomeInterestAndDividend", "InvestmentIncomeInterest", "InterestAndDividendIncomeOperating", "InterestIncomeOperating", "InterestIncomeNonoperating"]);
        // 한쪽 태그를 이 회사가 다른 기간엔 썼는데 이 기간에 없으면 0 이 아니라 빈칸(그 기간 이자수익이 다른 줄에 합쳐짐 — XOM 2024~) — 앱과 같은 원칙
        const everUsed = (tags) => tags.some((t) => (G[t]?.units?.USD ?? []).length > 0);
        const missingSide = (!ie && everUsed(["InterestExpense", "InterestExpenseNonoperating", "InterestAndDebtExpense", "InterestExpenseDebt"])) || (!ii && everUsed(["InvestmentIncomeInterestAndDividend", "InvestmentIncomeInterest", "InterestAndDividendIncomeOperating", "InterestIncomeOperating", "InterestIncomeNonoperating"]));
        if ((ie || ii) && missingSide) add("A", "순이자비용 앱 = SEC 이자비용 − 이자수익", c, I.netInt == null ? { status: PASS, note: `한쪽 태그가 이 기간에 없음(다른 기간엔 사용) → 빈칸 · ${ie ? `이자비용 ${ie.v}` : "이자비용 없음"} / ${ii ? `이자수익 ${ii.v}` : "이자수익 없음"}` } : { status: FAIL, note: `한쪽 태그가 이 기간에 없는데 앱 ${I.netInt}` });
        else if (ie || ii) {
          const exp = (ie?.v ?? 0) - (ii?.v ?? 0);
          add("A", "순이자비용 앱 = SEC 이자비용 − 이자수익", c, { ...vsSource(I.netInt, exp, EXACT, `${ie ? `${ie.t} ${ie.v}` : "이자비용 태그 없음 0"} − ${ii ? `${ii.t} ${ii.v}` : "이자수익 태그 없음 0"} · 규칙 재구현(태그 선택은 공통모드)`) });
        }
        // 기본 EPS = SEC 공시 기본 EPS ÷ 분할 배수(Yahoo 분할 이력) — 연간만(앱은 LTM 기본 EPS 를 내지 않는다)
        if (isFy) {
          const eb = atEnd(epsBP, x.date);
          if (!eb) add("A", "기본 EPS 앱 = SEC 공시 기본 EPS(분할 보정)", c, I.epsB == null ? { status: PASS, note: "공시 기본 EPS 없음 → 앱 빈칸" } : { status: NA, note: `공시 기본 EPS 없음(앱 ${I.epsB} — 클래스별 등)` });
          else if (splitErr) add("A", "기본 EPS 앱 = SEC 공시 기본 EPS(분할 보정)", c, { status: NA, note: splitErr });
          else { const k = splitAdj(eb); add("A", "기본 EPS 앱 = SEC 공시 기본 EPS(분할 보정)", c, vsSource(I.epsB, eb.val / k, EXACT, k !== 1 ? `공시 ${eb.val} ÷ 분할 ${k}(Yahoo 분할 이력)` : "")); }
        } else if (I.epsB != null) add("D", "LTM 기본 EPS 빈칸(앱 규칙)", c, { status: FAIL, note: `앱 LTM 기본 EPS ${I.epsB}` });
      }
      // 앱 라벨(합성 여부)은 판정 근거가 아니다(감사) — 합성(미결)은 SEC 쪽 근거(최신 10-K 본표에 영업이익 태그 없음)일
      // 때만. SEC 본표에 영업이익 태그가 있는데 앱이 합성했으면 실패.
      const synth = opRowName != null && opRowName !== "영업이익";
      const fin = sic >= 6000 && sic <= 6499;
      if (fin) {
        // 금융·보험: 앱 규칙 = 세전이익 − 지분법이익(CLAUDE.md "금융·보험업 영업이익 근사")
        const eq = secAt("IncomeLossFromEquityMethodInvestments") ?? 0;
        add("A", "영업이익 앱 = SEC 세전이익 − 지분법(금융·보험)", c, secPt == null ? { status: NA, note: "SEC 세전이익 없음" } : vsSource(op, secPt - eq, EXACT));
      } else if (!synth) {
        if (opOnFace === false) add("A", "영업이익 앱 = SEC 영업이익", c, { status: FAIL, note: "SEC 영업이익 태그가 손익계산서 본표에 없음(부문 주석값) — 앱이 구조 판독에 실패해 주석값을 쓴 것으로 보임" });
        // 20-F(IFRS)는 us-gaap 영업이익 태그가 없어 옛 검사가 검증불가만 남겼다 — --metric=opinc 의 "앱 = SEC 본표 영업이익"(원통화 × 환율)이 대신한다(감사 LOW-1)
        else if (!(OPINC_MODE && foreign)) { secNotes.length = 0; const so = secAt("OperatingIncomeLoss"); add("A", "영업이익 앱 = SEC 영업이익", c, vsSource(op, so, EXACT, secNotes.join(" · "))); }
      } else if (opOnFace === true && secAt("OperatingIncomeLoss") != null) {
        // 행 이름은 행 전체에 하나라 일부 기간만 합성일 수 있다 — 값으로 판정(SEC 태그 값과 정확히 같아야 통과)
        add("A", "영업이익 앱 = SEC 영업이익", c, vsSource(op, secAt("OperatingIncomeLoss"), EXACT, `SEC 본표에 영업이익 태그 있음 — 앱 행 "${opRowName}"`));
      } else if (opOnFace === true) {
        // --metric=opinc 는 아래 영업이익 A층(독립 계산 구조 대조)이 대신한다 — 미결 검증불가를 만들지 않는다
        if (!OPINC_MODE) add("A", "영업이익(합성) 앱 = SEC 손익계산서 구조", c, { status: NA, note: `미결 — 최신 10-K 본표엔 영업이익 태그가 있으나 이 기간 SEC 영업이익 값 없음. 합성 "${opRowName}"` });
      } else if (opOnFace === null) {
        // --metric=opinc 는 아래 영업이익 A층(독립 계산 구조 대조)이 대신한다 — 미결 검증불가를 만들지 않는다
        if (!OPINC_MODE) add("A", "영업이익(합성) 앱 = SEC 손익계산서 구조", c, { status: NA, note: `SEC 본표 판독 불가(계산 구조 없음·조회 실패) — 합성 "${opRowName}" 의 근거 확인 못함` });
      } else {
        // 합성 영업이익(소계 없는 손익계산서): SEC 세전이익에서 영업외 항목 태그를 되돌려 정확 대조.
        // NonoperatingIncomeExpense 가 회사마다 "영업외 합계"(이자·지분법 포함)이기도 하고 "기타수익" 한 줄이기도
        // 해서(DIS — 이자비용·지분법이 별도 줄) 두 해석을 모두 계산하고, 앱이 어느 쪽과 정확히 같은지 기록한다.
        // 태그 조합(영업외 합계·이자·지분법)으로 되살리는 식은 회사마다 태그 범위·부호가 달라 추측이 된다
        // (DIS: NonoperatingIncomeExpense 가 "기타수익" 한 줄뿐, 태그 조합 1,918 vs 손익계산서 실제 5,100).
        // 손익계산서 표시 구조의 독립 재구현 전까지는 판정하지 않고 미결로 남긴다 — 허용치·추측으로 통과시키지 않는다.
        // --metric=opinc 는 아래 영업이익 A층(독립 계산 구조 대조)이 대신한다 — 미결 검증불가를 만들지 않는다
        if (!OPINC_MODE) add("A", "영업이익(합성) 앱 = SEC 손익계산서 구조", c, { status: NA, note: `미결 — 합성 영업이익 "${opRowName}", SEC 영업이익 태그 없음(독립 구조 재구현 필요). 세전이익 ${secPt}` });
      }
      if (fin && pt != null && op != null && pt > 0 && op < 0) add("D", "금융·보험 영업이익 부호(세전 흑자 → 영업 적자 불가)", c, { status: FAIL, note: `세전이익 ${pt} 인데 영업이익 ${op}` });
    }
    // 감가상각비 = SEC 현금흐름표 본표 감가상각·상각 줄 합(최신 10-K 범위의 연도만, 정확 일치) — 외부 대조 원인 ⑥의 전제
    if (isFy && !bank && !foreign && !DA_MODE) {
      // 손상 포함 줄은 손상을, 중단사업 포함 현금흐름표는 중단사업 감가상각을 원본 태그로 따로 빼서 대조(계속사업·손상 제외 기준)
      const e = cfDa ? [...cfDa.byEnd].find(([end]) => dayDiff(end, x.date) <= 7) : null;
      const adjNote = e ? cfDa.notes.get(e[0]) : null;
      const unres = e ? cfDa.unresolved.get(e[0]) : null;
      add("A", "감가상각비 앱 = SEC 현금흐름표 감가상각·상각 줄 합", c, !cfDa ? { status: NA, note: cfDaWhy }
        : !e ? { status: NA, note: "최신 10-K 현금흐름표 기간 밖" }
        : unres ? { status: NA, note: `미결 — ${unres}(앱은 줄 값을 그대로 씀: ${IS[c]?.da ?? "빈칸"}, SEC 줄 합 ${e[1]}) · ${cfDa.lines}` }
        : vsSource(IS[c]?.da ?? null, e[1], EXACT, `규칙 재구현(줄 선택은 공통모드)${adjNote ? ` · ${adjNote}` : ""} · ${cfDa.lines}`));
    }
    // EBITDA = 영업이익 + 감가상각비(앱 손익계산서 주석·영업이익 행) — 은행 레이아웃 제외
    if (!bank) {
      const e = IS[c]?.ebitda ?? null, o = IS[c]?.op ?? null, d = IS[c]?.da ?? null;
      if (e != null || (o != null && d != null))
        add("D", "EBITDA = 영업이익 + 감가상각비(손익계산서)", c, e == null ? { status: FAIL, note: `영업이익 ${o}·감가상각비 ${d} 있는데 EBITDA 빈칸` }
          : o == null || d == null ? { status: FAIL, note: `EBITDA ${e} 있는데 구성요소 빈칸(영업이익 ${o}·감가상각비 ${d})` }
          : same(e, o + d));
    }
    // LTM 기대치 — 연도 열만 보던 EBITDA·PBR 기대치를 LTM 에도(감사). 기준은 SEC TTM·최신 분기 자본
    if (!isFy && !bank && !foreign) {
      const t = ["OperatingIncomeLoss", ...PRETAX_TAGS].map((tag) => ({ tag, t: secTtm(tag) })).find((r) => r.t && dayDiff(r.t.end, x.date) <= 7);
      // 감가상각비 모드: LTM 감가상각 줄이 구성 공시 간 기준 혼합(secFaceDa mixOf)이면 EBITDA 도 빈칸이 정답(감가상각비 빈칸 + 사유)
      const daMix = DA_MODE && daFace ? daFace.ltmAt(x.date)?.mix ?? null : null;
      // 감가상각비 모드: 검증기 자체 판독으로도 LTM 감가상각비를 만들 수 없으면(DAL — 10-Q 가 요약 현금흐름표라 감가상각 줄 없음) EBITDA 빈칸이
      // 정답(태그 값 대체 금지 — 오너 규칙). 앱이 값을 내면 실패(2026-09-27)
      const daLtm = DA_MODE && typeof daFace?.ltmAt === "function" && !daMix ? daFace.ltmAt(x.date) : undefined;
      let daNone = daLtm !== undefined && (daLtm == null || daLtm.v == null) ? (daLtm?.why ?? "SEC 현금흐름표 계산 구조로 LTM 감가상각비 계산 불가") : null;
      // 기본·영업이익 모드(2026-09-28 — DAL·HLT 기준선 실패): 앱이 LTM 감가상각비를 사유와 함께 비워 EBITDA 도 비웠으면(칸 사유가 감가상각비 공란 사유),
      // 감가상각비 모드와 같은 결정(c80e678 — LTM 감가상각비 계산 불가면 EBITDA 빈칸이 정답)을 적용한다. 사유는 검증기 자체 현금흐름표 판독
      // (secFaceDa — 감가상각비 모드와 같은 판독)으로 독립 확인: LTM 이 기준 혼합이거나 계산 불가면 PASS, SEC 로 계산되면 FAIL 그대로.
      // 판독 자체가 안 되면 앱 사유만 본 것이라 공통모드
      let daMix2 = null;
      if (t && !DA_MODE && x.ebitda == null) {
        const isRowsE = is?.sections?.flatMap((s) => s.items ?? []) ?? [];
        const eWhy = String(isRowsE.find((y) => y.accountName === "EBITDA")?.cellNotes?.["현재/LTM"] ?? ""), dWhy = String(isRowsE.find((y) => y.accountName === "감가상각비")?.cellNotes?.["현재/LTM"] ?? "");
        const appDaBlank = (IS.LTM?.da ?? null) == null && /감가상각/.test(`${eWhy} ${dWhy}`);
        if (appDaBlank) {
          let f2 = null, why2 = "";
          try { const r = await secFaceDa({ cik, sub, content: CONTENT_DA.has(sym) }); if (r.why) why2 = r.why; else f2 = r; } catch (e) { why2 = `현금흐름표 판독 실패: ${String(e).slice(0, 80)}`; }
          const r2 = f2 ? f2.ltmAt(x.date) : undefined;
          if (!f2) daNone = `앱 사유 "${dWhy || eWhy}" — 검증기 현금흐름표 판독 불가(${why2}) · 공통모드(앱 사유만 확인)`;
          else if (r2?.mix) daMix2 = `${r2.mix} · 앱 사유 "${dWhy || eWhy}" 독립 확인(검증기 현금흐름표 판독)`;
          else if (r2 == null || r2.v == null) daNone = `검증기 현금흐름표 판독으로도 LTM 감가상각비 계산 불가(구성 누적 기간 없음) · 앱 사유 "${dWhy || eWhy}"`;
        }
      }
      if (t && daMix2) add("D", "LTM EBITDA 기대치(SEC TTM 영업이익·세전이익 있음)", c, { status: PASS, note: `감가상각 줄 ${COGS_MIX} — LTM 감가상각비 빈칸이라 EBITDA 빈칸이 정답 · ${daMix2}` });
      else if (t && daNone) add("D", "LTM EBITDA 기대치(SEC TTM 영업이익·세전이익 있음)", c, x.ebitda == null ? { status: PASS, note: `LTM 감가상각비 계산 불가(${daNone}) — EBITDA 빈칸이 정답` } : { status: FAIL, note: `LTM 감가상각비 계산 불가(${daNone})인데 앱 LTM EBITDA ${x.ebitda}` });
      else if (t) add("D", "LTM EBITDA 기대치(SEC TTM 영업이익·세전이익 있음)", c, daMix
        ? x.ebitda == null ? { status: PASS, note: `감가상각 줄 ${COGS_MIX} — LTM 감가상각비 빈칸이라 EBITDA 빈칸이 정답 · ${daMix}` } : { status: FAIL, note: `감가상각 줄 ${COGS_MIX}인데 앱 LTM EBITDA ${x.ebitda} · ${daMix}` }
        : x.ebitda != null ? { status: PASS } : { status: FAIL, note: `SEC TTM ${t.tag} ${t.t.v}(${t.t.end}) 있는데 앱 LTM EBITDA 빈칸` });
    }
    if (!isFy && (x.mc != null || ov?.quote?.last != null)) {
      const ql = (G.StockholdersEquity?.units?.USD ?? []).filter((e) => !e.start && /^10-[QK]/.test(e.form) && dayDiff(e.end, x.date) <= 7);
      const q = ql.length ? latestPrecise(ql.filter((e) => e.end === ql.reduce((m, y) => (y.end > m ? y.end : m), ""))) : null;
      if (q) signRule("PBR", x.pbr, q.val);
    }
    if (x.mc != null && x.rev != null) signRule("PSR", x.psr, x.rev);
    if (isFy && x.mc != null) { const eq = atEnd(eqP, x.date)?.val; if (eq != null) signRule("PBR", x.pbr, eq); }
    // 금융 자회사 보유사(오너 지시 2026-10-01 "EV를 비워두면 안된다"): EV 를 표시하고, 하이라이트 차입금(제조 부문) + 금융 부문 차입금(공시 원본 부문 차원 태그,
    //    검증기 독립 계산) = 재무상태표 주석 연결 총차입금. EV 가 비면 실패
    if (captiveSec) {
      const fin = capFin.get(c);
      if (x.ev == null && x.mc != null) add("D", "금융 자회사 보유사 EV 표시", c, { status: FAIL, note: `EV 빈칸 — ${captiveSec}` });
      if (fin && x.debt != null && BS[c]?.debt != null) add("C", "금융 자회사 보유사 제조 부문 차입금 + 금융 부문 차입금 = 연결 총차입금", c, { ...same(x.debt + fin.v, BS[c].debt), note: `하이라이트 ${x.debt} + 금융 부문 ${fin.v}(${fin.how}) vs 주석 ${BS[c].debt}` });
      else if (x.debt != null) add("C", "금융 자회사 보유사 제조 부문 차입금 + 금융 부문 차입금 = 연결 총차입금", c, { status: NA, note: `금융 부문 차입금 원본 판독 없음(${fin ? "주석 없음" : "부문 차원 태그 없음"})` });
    }
    if (!bank && x.mc != null) {
      if (x.ev == null) {
        const ok = evBlockOkAt(x.date);
        add("D", "EV 기대치", c, ok ? { status: NA, note: `EV 미표시 — ${ok}` } : { status: FAIL, note: (x.evNote ?? evBlocked) ? `EV 미표시 — 앱 사유 "${(x.evNote ?? evBlocked).slice(0, 60)}" 를 이 날짜 원자료로 확인 못함${ltmEvCheck?.why ? ` · ${ltmEvCheck.why}` : ""}` : "EV 미표시 사유 없이 빈칸" });
      }
      else {
        const sum = (x.mc ?? 0) + (x.op ?? 0) + (x.debt ?? 0) + (x.pn ?? 0) + (x.cash ?? 0); // cash 행은 음수
        add("D", "EV = 시총+파트너지분+차입금+우선주·NCI−현금", c, same(x.ev, sum));
        if (x.ebitda != null && x.ebitda > 0) add("D", "EV/EBITDA = EV÷EBITDA", c, same(x.evx, x.ev / x.ebitda));
        signRule("EV/EBITDA", x.evx, x.ebitda);
        if (x.mc > 1e9 && !x.debt && !x.cash) add("D", "차입금·현금 원자료 반영", c, { status: FAIL, note: "대형주인데 차입금·현금이 모두 0/빈칸" });
      }
    }
    // 자산총계 = SEC Assets(결산일 시점 값, 최신 제출분)
    if (BS[c]?.assets != null) {
      // 최신 제출분 — 나중 공시의 반올림 재태깅(100만·1억·10억·100억 단위)은 제외(latestPrecise, 검증기 독립 판정)
      const a = assetsAt(x.date), rs = c !== "LTM" ? eqRestate(x.date) : null;
      // 자본 정정 열 — 자산 = SEC 자산 + 정정 금액(정정된 재무상태표 전체는 공시되지 않아 부채 + 자본으로 산출)
      add("A", "자산총계 앱 = SEC 자산총계", c, rs && a ? vsSource(BS[c].assets, a.val + rs.delta, EXACT, `SEC 자산 ${a.val} + 자본 정정 ${rs.delta}(${rs.filed}) — 오너 결정 (다)`) : vsSource(BS[c].assets, a?.val ?? null, EXACT, retagNote(a)));
    }
    if (BS[c]) {
      // 대차대조표 항등식 — 같은 공시의 두 합계라 정확 일치(예전 허용 0.05% 제거). 반올림 재태깅이 갈리는 날짜면 SEC 두 값을 메모에
      const rn = retagNote(assetsAt(x.date));
      const r = BS[c].assets == null || BS[c].le == null ? { status: NA, note: "대차대조표 값 없음" } : same(BS[c].assets, BS[c].le);
      add("D", "자산 총계 = 부채와 자본 총계", c, rn ? { ...r, note: [r.note, `SEC 자산총계 ${rn}`].filter(Boolean).join(" · ") } : r);
    }

    // ── E. 공시 내부 정합성 (공시 EPS × 가중평균 ≈ 보통주 귀속 순이익)
    if (isFy && foreign) {
      // 외화 공시(ASML·SPOT·TSM) — 같은 공시의 원통화 EPS·가중평균 주식수·순이익끼리(환산 없음). 오너 2026-10-07: "원자료 데이터가 맞으면
      // 외화 환산은 공시 기준 환율을 적용하기에 차이가 있을 수 있다" — 환산 USD 차이는 여기서 보지 않는다(USD 는 인포맥스 대조 몫).
      // 허용 = 아래 미국 경로와 같은 반올림 구간 규칙(순이익·주식수 보고 단위 반 칸, EPS 소수 자릿수 반 칸 — 구간이 겹치면 정합)
      const n = (m) => atEnd(m, x.date);
      const niD = n(natNiDil);
      const tries = [["희석", n(natEps), n(natWDil), niD ?? n(natNi), niD ? "분자 = 희석 효과 포함 지배주주 순이익" : "분자 = 지배주주 순이익"],
        ["기본", n(natEpsB), n(natWBas), n(natNi), "분자 = 지배주주 순이익"]];
      const t = tries.find(([, e, w, ni]) => e && e.val !== 0 && w?.val && ni);
      if (!t) add("E", "공시 EPS × 가중평균 ≈ 보통주 귀속 순이익", c, { status: NA, note: `원통화(${natCur}) 공시 EPS·가중평균 주식수·지배주주 순이익 중 없는 값이 있음` });
      else {
        const [kind, e, w, ni, numNote] = t;
        const eps = e.val, epsUnit = 10 ** -Math.max(2, (String(eps).split(".")[1] ?? "").length);
        const uN = secUnitAny(ni.val), uW = secUnitAny(w.val);
        const cs = [(ni.val - uN / 2) / (w.val - uW / 2), (ni.val - uN / 2) / (w.val + uW / 2), (ni.val + uN / 2) / (w.val - uW / 2), (ni.val + uN / 2) / (w.val + uW / 2)];
        const ok = Math.min(...cs) <= eps + epsUnit / 2 && Math.max(...cs) >= eps - epsUnit / 2;
        const note = `원통화(${natCur}) ${kind} — 순이익/주식수 ${(ni.val / w.val).toFixed(4)} vs 공시 EPS ${eps} · ${numNote} · 환산 없음`;
        add("E", "공시 EPS × 가중평균 ≈ 보통주 귀속 순이익", c, { status: ok ? PASS : FAIL, note });
      }
    }
    else if (isFy) {
      const e = atEnd(epsP, x.date) ?? null;
      const ie = [...inst].find(([end]) => dayDiff(end, x.date) <= 7)?.[1];
      let eps = e?.val ?? null, w = null, ni = null, notes = [];
      if (e && eps !== 0) {
        if (eps < 0) { w = atEnd(wBasP, x.date)?.val ?? null; notes.push("적자 연도 — 기본 주식수(반희석 제외)"); }
        else if (atEnd(wDilP, x.date)) w = atEnd(wDilP, x.date).val;
        else if (atEnd(wBasP, x.date) && atEnd(epsBP, x.date)?.val === eps) { w = atEnd(wBasP, x.date).val; notes.push("희석 EPS = 기본 EPS 라 기본 주식수"); }
        const cn = commonNi(x.date); ni = cn.v; if (cn.note) notes.push(cn.note); if (cn.why) notes.push(cn.why);
      } else if (ie) {
        eps = ie.eps; w = ie.shares; notes.push(ie.basis);
        const cn = ie.asConverted ? parentNi(x.date) : commonNi(x.date);
        ni = cn.v; if (ie.asConverted) notes.push("분자 = 지배주주 순이익(as-converted 분모와 같은 범위)");
        if (cn.why) notes.push(cn.why);
      }
      if (eps != null && eps !== 0 && w && ni != null) {
        // 공시 보고 단위만큼만 허용(예전 "0.005 + 0.3%" 허용치 대신, 2026-09-25): 순이익·가중평균 주식수는 각자 보고 단위
        // (값을 나누는 10의 거듭제곱, 최대 100만 — 예: 919,000,000 주 → ±50만 주) 반올림 구간, EPS 는 소수 자릿수(최소 센트)
        // 반올림 구간. 순이익 ÷ 주식수가 만들 수 있는 구간과 공시 EPS 반올림 구간이 겹치면 정합.
        const implied = ni / w;
        const epsUnit = 10 ** -Math.max(2, (String(eps).split(".")[1] ?? "").length);
        const consistent = (wk) => {
          const uN = secUnit(Math.abs(ni)), uW = secUnit(w) * wk;
          const cs = [(ni - uN / 2) / (w * wk - uW / 2), (ni - uN / 2) / (w * wk + uW / 2), (ni + uN / 2) / (w * wk - uW / 2), (ni + uN / 2) / (w * wk + uW / 2)];
          return Math.min(...cs) <= eps + epsUnit / 2 && Math.max(...cs) >= eps - epsUnit / 2;
        };
        let ok = consistent(1);
        let unitNote = "";
        if (!ok) for (const k of [1e3, 1e6]) if (consistent(k)) { ok = true; unitNote = `공시 주식수 단위 오류(×${k})`; }
        const r = ok ? { status: PASS, note: [unitNote, ...notes].filter(Boolean).join(" · ") || undefined }
          : { status: FAIL, note: `순이익/주식수 ${implied.toFixed(4)} vs 공시 EPS ${eps} · ${notes.join(" · ")}` };
        if (unitNote) {
          // 앱이 실제로 보정했는지 — 앱 EPS 가 공시 EPS 와 맞는지는 A 층에서 따로 판정한다
          r.note += " · 앱 보정 여부는 A층 EPS 대조로 확인";
        }
        if (r.status === FAIL) {
          // 공시 수치끼리 안 맞는 것 — 회사 공시 문제. A층(앱=공시)이 통과했을 때만 검토 목록으로
          const aRes = checks.find((k) => k.layer === "A" && k.col === c && k.name.startsWith("EPS"));
          if (aRes?.status === PASS) { review.push({ item: `${c} 공시 EPS×주식수≠보통주 순이익(앱 EPS=공시 EPS 확인됨)`, note: r.note }); add("E", "공시 EPS × 가중평균 ≈ 보통주 귀속 순이익", c, { status: NA, note: `공시 자체 불일치 — 검토 목록 · ${r.note}` }); }
          else add("E", "공시 EPS × 가중평균 ≈ 보통주 귀속 순이익", c, r);
        } else add("E", "공시 EPS × 가중평균 ≈ 보통주 귀속 순이익", c, r);
      } else add("E", "공시 EPS × 가중평균 ≈ 보통주 귀속 순이익", c, { status: NA, note: [e == null && !ie && "공시 희석 EPS 없음", e?.val === 0 && "공시 EPS 0", !w && "가중평균 주식수 없음", ni == null && "보통주 귀속 순이익 없음", instErr && `인스턴스: ${instErr}`, ...notes].filter(Boolean).join(" · ") });
    }
  }

  // ── 매출 A(분기)·C·D층(revenue.md §6, 2026-09-25) ────────────────────────────────────────────────
  // C: 소비처(하이라이트·손익계산서·총괄·재무분석·컨센서스 실적·개요·유니버스)가 같은 매출을 쓰는지 — 각 화면의 기준(연간/LTM)으로.
  //    재무분석·하이라이트의 성장률·마진·PSR 은 매출로 다시 계산해 정확히 같은지(부동소수 오차만).
  // D: 분기 4개 합 = 연간(같은 사업연도), LTM = 최근 4분기 합. 차이가 SEC 본표 매출의 "3개월값 합 − 누적값"과 정확히 같으면
  //    반올림 차(R4 — 누적·분기 공시값 반올림)로 명시하고 통과.
  {
    const revRow = (stmt) => { const a = rowOf(stmt, "매출액"); return Object.keys(a).length ? a : rowOf(stmt, "순수익"); };
    const SM = Object.fromEntries(Object.entries(revRow(sm)).map(([k, v]) => [lab(k), v]));
    const cols = [...Object.keys(H).filter((k) => k !== "LTM").sort((a, b) => H[a].date.localeCompare(H[b].date)), ...(H.LTM ? ["LTM"] : [])];
    const pct = (a, b) => (a != null && b != null && b !== 0 ? (a / b) * 100 : null);
    cols.forEach((c, i) => {
      const x = H[c], prev = i > 0 ? H[cols[i - 1]] : null;
      add("C", "매출 하이라이트=총괄", c, same(SM[c] ?? null, x.rev));
      if (C[c]) add("C", "매출 컨센서스 실적=하이라이트", c, same(C[c].revenue ?? null, x.rev));
      if (x.rev != null && prev?.rev) {
        const yoy = (x.rev / prev.rev - 1) * 100;
        add("C", "매출 성장률 하이라이트 = 매출 재계산(직전 열 대비)", c, same(x.revYoy, yoy));
        add("C", "매출 성장률 재무분석 = 매출 재계산(직전 열 대비)", c, same(A[c]?.revYoy ?? null, yoy));
        if (C[c] && c !== "LTM") add("C", "매출 성장률 컨센서스 = 매출 재계산(직전 연도 대비)", c, same(C[c].revenueYoY ?? null, yoy));
      }
      if (x.rev) {
        if (x.ni != null) add("C", "순이익률 하이라이트 = 순이익 ÷ 매출", c, same(x.niM, pct(x.ni, x.rev)));
        if (x.ni != null) add("C", "순이익률 재무분석 = 순이익 ÷ 매출", c, same(A[c]?.niM ?? null, pct(x.ni, x.rev)));
        if (x.ebitda != null) add("C", "EBITDA 마진 하이라이트 = EBITDA ÷ 매출", c, same(x.ebitdaM, pct(x.ebitda, x.rev)));
        if (IS[c]?.op != null) add("C", "영업이익률 재무분석 = 영업이익 ÷ 매출", c, same(A[c]?.opM ?? null, pct(IS[c].op, x.rev)));
        if (x.mc != null && x.rev > 0) add("C", "PSR 하이라이트 = 시가총액 ÷ 매출", c, same(x.psr, x.mc / x.rev));
      }
    });
    // 첫 연도 열의 성장률 — 앱은 화면에 없는 전년 매출(companyfacts 시계열)로 계산한다(edgar-highlights.ts seq). 그 전년 매출을
    // SEC 원자료(외화 공시는 원통화 × 기간 평균 환율)로 독립적으로 구해 첫 열 성장률을 다시 계산한다(재감사 2026-09-25 — 전 종목)
    const c0 = cols[0];
    if (c0 && c0 !== "LTM" && H[c0].rev != null) {
      const E0 = new Date(Date.parse(H[c0].date) - 365 * 864e5).toISOString().slice(0, 10);
      const name = "첫 열 전년 매출 = SEC(성장률 기준)";
      let prior = null, how = "";
      // 보조 신호(오너 결정 2026-09-25): 본표에서 전년 매출을 못 찾았을 때 SEC companyfacts 연간 매출 태그에도 없으면 "공시 없음"(분사 첫해 등),
      // 있으면 "검증기 본표 판독 실패" — 조용히 검증불가로 두지 않고 조회 오류로 기록
      const cfPrior = [...revP.keys()].find((k) => Math.abs(Date.parse(k) - Date.parse(E0)) <= 10 * 864e5);
      const naOrReadFail = (why) => cfPrior
        ? hardErrors.push(`첫 열 전년 매출 본표 판독 실패 — companyfacts 에는 ${cfPrior} 연간 매출 ${revP.get(cfPrior)?.val ?? revP.get(cfPrior)} 있음(${why})`)
        : add("A", name, c0, { status: NA, note: `${why} · companyfacts 연간 매출도 없음(공시 없음)` });

      if (foreign) {
        const r = atEnd(natRev, E0);
        const avg = r && fxRows ? fxAvg(fxRows, r.start, r.end) : null;
        if (!r) add("A", name, c0, { status: FAIL, note: `전년(${E0} 전후) 원통화 공시 매출 없음 — 첫 열 성장률 근거 대조 불가` });
        else if (avg == null && fxPendingWhy(fxRows, r.end)) add("A", name, c0, { status: NA, note: `${fxPendingWhy(fxRows, r.end)} — 전년 매출 환산 불가(${r.start}~${r.end})` });
        else if (avg == null) hardErrors.push(`첫 열 전년 매출 기간 평균 환율 없음(${r.start}~${r.end})${fxErr ? `: ${fxErr}` : ""}`);
        else { prior = r.val * avg; how = `원통화 ${r.val} ${natCur} × 기간 평균 환율 ${avg.toPrecision(6)} (${r.end})${fxWin(r.start, r.end)}`; }
      } else if (!revFace) {
        // 본표 판독 실패 — 앱이 첫 열 성장률을 보이면 대조 없이 둘 수 없어 FAIL(미검증 열 검사와 같은 규칙)
        const appYoy = [H[c0].revYoy, A[c0]?.revYoy, C[c0]?.revenueYoY].filter((v) => v != null);
        if (appYoy.length) add("A", name, c0, { status: FAIL, note: `${revFaceWhy} · 앱 첫 열 성장률 ${appYoy.join("/")} 표시` }); else naOrReadFail(revFaceWhy);
      }
      else {
        try { await revFace.extend(E0, "FY"); } catch (e) { hardErrors.push(`첫 열 전년 매출 SEC 공시 추가 판독 실패: ${String(e).slice(0, 80)}`); }
        const e = revFace.annualAt(E0);
        // 전년 정기공시 자체가 없으면(분사 첫해 등) 앱 성장률도 빈칸이어야 한다 — 양쪽 빈칸은 검증불가, 앱만 값이 있으면 실패
        const appYoy = [H[c0].revYoy, A[c0]?.revYoy, C[c0]?.revenueYoY].filter((v) => v != null);
        if (!e && appYoy.length === 0) naOrReadFail(`전년(${E0} 전후) SEC 본표 매출 없음 · 앱 첫 열 성장률도 빈칸`);
        else if (!e) add("A", name, c0, { status: FAIL, note: `전년(${E0} 전후) SEC 본표 매출 대응값 없음인데 앱 첫 열 성장률 ${appYoy.join("/")} 표시 — 근거 대조 불가` });
        else { prior = e.v; how = e.how; }
      }
      if (prior) add("A", name, c0, { status: PASS, note: `전년 ${prior} · ${how}` });
      if (prior) {
        const yoy = (H[c0].rev / prior - 1) * 100, note = (r) => ({ ...r, note: [r.note, `전년 ${prior} · ${how}`].filter(Boolean).join(" · ") });
        add("C", "매출 성장률 하이라이트 = 매출 재계산(첫 열 — SEC 전년 대비)", c0, note(same(H[c0].revYoy, yoy)));
        add("C", "매출 성장률 재무분석 = 매출 재계산(첫 열 — SEC 전년 대비)", c0, note(same(A[c0]?.revYoy ?? null, yoy)));
        if (C[c0]) add("C", "매출 성장률 컨센서스 = 매출 재계산(첫 열 — SEC 전년 대비)", c0, note(same(C[c0].revenueYoY ?? null, yoy)));
      }
    }
    // 개요(연간 = 최근 사업연도, TTM = LTM)·유니버스(LTM 열) — 앱이 실제로 계산한 값(verify-row)
    const lastFy = cols.filter((c) => c !== "LTM").at(-1);
    if (row && H.LTM) {
      const inp = row.overview?.multiples?.inputs ?? null, m = row.overview?.multiples ?? null, uv = row.universe && !row.universe.error ? row.universe : null, L0 = H.LTM;
      add("C", "매출 개요(TTM) = 하이라이트 LTM", "LTM", same(inp?.revenueTtm ?? null, L0.rev));
      if (lastFy) add("C", "매출 개요(연간) = 하이라이트 최근 사업연도", lastFy, same(inp?.revenueAnnual ?? null, H[lastFy].rev));
      if (m?.marketCap != null && L0.rev > 0) add("C", "PSR 개요 = 시가총액 ÷ LTM 매출", "LTM", same(m.psr ?? null, m.marketCap / L0.rev));
      if (uv) {
        add("C", "매출 유니버스(LTM) = 하이라이트 LTM", "LTM", same(uv.revenueAnnual ?? null, L0.rev));
        if (L0.rev && IS.LTM?.op != null) add("C", "영업이익률 유니버스 = LTM 영업이익 ÷ 매출", "LTM", same(uv.opMargin ?? null, IS.LTM.op / L0.rev));
        if (L0.rev && L0.ni != null) add("C", "순이익률 유니버스 = LTM 순이익 ÷ 매출", "LTM", same(uv.netMargin ?? null, L0.ni / L0.rev));
      }
    }
    // 분기 — 손익계산서 분기 열(최근 5개, Q4 = 사업연도 − 9개월)
    const QP = isq?.periods ?? [], QV = revRow(isq), SMQ = revRow(smq);
    for (const p of QP) {
      add("C", "분기 매출 손익계산서 = 총괄", p.label, same(SMQ[p.label] ?? null, QV[p.label] ?? null));
      if (foreign) continue;
      qEndOf.set(p.label, p.endDate);
      const e = revFace?.quarterAt(p.endDate, p.fiscalQuarter === 4) ?? null;
      add("A", p.fiscalQuarter === 4 ? "분기 매출 앱 = SEC 매출(Q4 = 사업연도 − 9개월)" : "분기 매출 앱 = SEC 매출(3개월)", p.label,
        !revFace ? { status: NA, note: revFaceWhy } : vsSource(QV[p.label] ?? null, e?.v ?? null, EXACT, e?.how ?? "읽은 공시(10-Q 4건·10-K 3건) 범위 밖"));
    }
    // R4 판정 — 앱 차이(dApp)가 SEC 본표 매출의 (분기 합 − 누적)과 정확히 같은가
    const secQ = (p) => (foreign ? null : revFace?.quarterAt(p.endDate, p.fiscalQuarter === 4) ?? null);
    const r4 = (name, col, sumApp, total, qs, secTotal) => {
      const r0 = same(sumApp, total);
      if (r0.status !== FAIL || sumApp == null || total == null) return add("D", name, col, r0);
      const parts = qs.map(secQ);
      if (secTotal == null || parts.some((x) => x == null)) return add("D", name, col, { ...r0, note: `${r0.note} · SEC 분기·누적 대응값 없음(R4 판정 불가)` });
      const dSec = parts.reduce((t, x) => t + x.v, 0) - secTotal.v, dApp = sumApp - total;
      add("D", name, col, Math.abs(dSec - dApp) <= 0.5 && dSec !== 0
        ? { status: PASS, note: `R4 반올림 차 — 앱 분기 합 − ${col === "LTM" ? "LTM" : "연간"} = ${dApp} = SEC 본표 3개월값 합 − 누적값 ${dSec}(공시값 자체의 반올림)` }
        : { status: FAIL, note: `${r0.note} · 앱 차 ${dApp} ≠ SEC(분기 합 − 누적) ${dSec}` });
    };
    let fullYears = 0;
    for (const fy of new Set(QP.map((p) => p.fiscalYear))) {
      const qs = QP.filter((p) => p.fiscalYear === fy);
      if (new Set(qs.map((p) => p.fiscalQuarter)).size !== 4 || qs.length !== 4) continue;
      fullYears++;
      const q4 = qs.find((p) => p.fiscalQuarter === 4);
      const col = cols.find((c) => c !== "LTM" && dayDiff(H[c].date, q4.endDate) <= 7);
      const sumApp = qs.every((p) => QV[p.label] != null) ? qs.reduce((t, p) => t + QV[p.label], 0) : null;
      if (!col) { add("D", "분기 4개 합 = 연간 매출", `FY${fy}`, { status: NA, note: `연도 열 없음(Q4 결산일 ${q4.endDate})` }); continue; }
      r4("분기 4개 합 = 연간 매출", col, sumApp, H[col].rev, qs, foreign ? null : revFace?.annualAt(H[col].date) ?? null);
    }
    // 분기 창(최근 5개 분기)에 온전한 사업연도가 없으면 이 검사는 만들지 않는다 — 값 문제가 아니라 창 범위라 검증불가로 세지 않음(오너 지적 2026-09-27).
    // 분기 값 하나하나는 A층(SEC 3개월 대조)이 따로 본다
    if (H.LTM && QP.length) {
      const last4 = QP.filter((p) => p.endDate <= H.LTM.date || dayDiff(p.endDate, H.LTM.date) <= 7).slice(-4);
      const ok = last4.length === 4 && dayDiff(last4[3].endDate, H.LTM.date) <= 7 && last4.every((p, k) => k === 0 || (dayDiff(p.endDate, last4[k - 1].endDate) >= 80 && dayDiff(p.endDate, last4[k - 1].endDate) <= 100));
      if (!ok) add("D", "LTM 매출 = 최근 4분기 합", "LTM", { status: NA, note: `LTM 기준일 ${H.LTM.date} 로 끝나는 연속 4분기가 앱 분기 열에 없음` });
      else r4("LTM 매출 = 최근 4분기 합", "LTM", last4.every((p) => QV[p.label] != null) ? last4.reduce((t, p) => t + QV[p.label], 0) : null, H.LTM.rev, last4, foreign ? null : revFace?.ltmAt(H.LTM.date) ?? null);
    }
  }

  // ── 매출원가·매출총이익 A층(--metric=cogs, 2026-09-26 착수 — 지표 미종결) ────────────────────────────────────────
  // 기대값 = 검증기가 본표 구조로 따로 판독한 값(secFaceCogs): 매출원가 = 매출총이익 식의 차감 항(소계면 소계), 매출총이익 = 본표 소계,
  // 소계가 없으면(C형) SEC 본표 매출 − SEC 본표 매출원가(합성 — 앱도 합성 표기를 달아야 함). 연간·분기(3개월, Q4 = 사업연도 − 9개월)·LTM.
  // D형(본표에 원가 줄 없음): 구성 규칙이 없으면 앱은 빈칸 + 사유 "구성 규칙 대기"(검증불가), 값이 있거나 사유 없이 비면 FAIL.
  // 구성 규칙(--cogs-rules)이 있으면 규칙 줄이 그 공시 본표에 있는지 확인하고 줄 값 합과 정확 대조.
  const cogsExp = new Map(); // 열(연간 "2025Y"·"LTM") → 본표 판독 결과 — F층 원인 규칙용
  const cogsSynth = new Set(); // 매출총이익이 합성인 열("연간|2025Y"·"연간|현재/LTM"·"분기|2025 Q2") — D층 항등식은 자명
  if (COGS_MODE) {
    const cRowA = isItem(is, COGS_ROW_RE), gRowA = isItem(is, GP_ROW_RE), cRowQ = isItem(isq, COGS_ROW_RE), gRowQ = isItem(isq, GP_ROW_RE);
    // 앱이 D형 빈칸에 단 사유 — 행·열 단위 필드 형식이 아직 정해지지 않아 응답 전체에서 찾는다(실제 앱 응답으로 확인 필요)
    const waitA = JSON.stringify(is ?? {}).includes(COGS_WAIT), waitQ = JSON.stringify(isq ?? {}).includes(COGS_WAIT);
    // 앱이 기준 혼합 빈칸에 단 사유(칸 각주 "… 기준 혼합(…)") — 응답 단위로 찾는다(COGS_WAIT 와 같은 방식)
    const mixA = JSON.stringify(is ?? {}).includes(COGS_MIX), mixQ = JSON.stringify(isq ?? {}).includes(COGS_MIX);
    const finCo = sic >= 6000 && sic <= 6499, finWait = /금융사/.test(JSON.stringify(is ?? {}));
    const synthMark = (row) => /합성|소계 없음/.test(JSON.stringify(row ?? {}));
    const revAt = (kind, E, isQ4) => {
      if (foreign) { const r = kind === "FY" ? atEnd(natRev, E) : null; return r ? { v: r.val, how: `원통화 공시 매출 ${r.val}` } : null; }
      if (!revFace) return null;
      return kind === "FY" ? revFace.annualAt(E) : kind === "LTM" ? revFace.ltmAt(E) : revFace.quarterAt(E, isQ4);
    };
    const judge = (kind, col, key, E, isQ4, cRow, gRow, wait, stmtTag) => {
      const sfx = kind === "Q" ? (isQ4 ? "(Q4 = 사업연도 − 9개월)" : "(3개월)") : "", pre = kind === "Q" ? "분기 " : "";
      const nC = `${pre}매출원가 앱 = SEC 매출원가${sfx}`, nG = `${pre}매출총이익 앱 = SEC 매출총이익${sfx}`;
      const appC = cRow?.values?.[key] ?? null, appG = gRow?.values?.[key] ?? null;
      // 카드·보험·은행 = 금융사 기준(오너 2026-09-26) — 매출원가·매출총이익 개념 없음. 검증기는 SEC 업종코드(60~64)로 따로 판정:
      // 앱이 빈칸 + "금융사" 사유면 검증불가(양쪽 빈칸), 값이 있거나 사유 없이 비면 FAIL
      if (finCo) {
        for (const [n, v] of [[nC, appC], [nG, appG]])
          add("A", n, col, v != null ? { status: FAIL, note: `금융사(SIC ${sic}) — 매출원가·매출총이익 해당 없음인데 앱 값 ${v}`, app: v, src: null }
            : finWait ? { status: NA, note: `금융사 기준(SIC ${sic}) — 해당 없음`, app: null, src: null }
            : { status: FAIL, note: `금융사(SIC ${sic}) — 앱 빈칸인데 사유 "금융사" 없음(조용한 빈칸)`, app: null, src: null });
        return;
      }
      if (!cogsFace) {
        add("A", nC, col, { status: NA, note: cogsWhy || "본표 판독 없음", app: appC, src: null });
        add("A", nG, col, { status: NA, note: cogsWhy || "본표 판독 없음", app: appG, src: null });
        return;
      }
      const e = kind === "FY" ? cogsFace.annualAt(E) : kind === "LTM" ? cogsFace.ltmAt(E) : cogsFace.quarterAt(E, isQ4);
      if (e?.err) {
        // 본표 원가 줄 판독 실패 — D형(본표에 원가 줄 없음)으로 넘기지 않는다
        hardErrors.push(`매출원가 본표 판독 실패(${col}): ${e.err}`);
        add("A", nC, col, { status: FAIL, note: `SEC 본표 판독 실패 — ${e.err}`, app: appC, src: null });
        add("A", nG, col, { status: FAIL, note: `SEC 본표 판독 실패 — ${e.err}`, app: appG, src: null });
        return;
      }
      if (kind !== "Q") cogsExp.set(col, e);
      if (!e) {
        add("A", nC, col, vsSource(appC, null, EXACT, `기간 ${E} — 읽은 공시(연차 3건·10-Q 4건) 범위 밖`));
        add("A", nG, col, vsSource(appG, null, EXACT, `기간 ${E} — 읽은 공시 범위 밖`));
        return;
      }
      if (e.mix) {
        // 구성 공시 간 기준 혼합(secFaceCogs withMix — 원 공시 값 ≠ 파생에 쓴 판본 값) — 앱은 빈칸 + "기준 혼합"이어야 한다
        const appMix = stmtTag === "분기" ? mixQ : mixA;
        for (const [n, v] of [[nC, appC], [nG, appG]])
          add("A", n, col, v != null ? { status: FAIL, note: `${COGS_MIX} 열에 앱 값 ${v} — 빈칸이어야 함(한 열 = 한 기준) · ${e.mix}`, app: v, src: null }
            : appMix ? { status: NA, note: `${COGS_MIX} — 양쪽 공란 기대 · ${e.mix}`, app: null, src: null }
            : { status: FAIL, note: `${COGS_MIX}인데 앱 빈칸 사유에 "${COGS_MIX}" 없음 · ${e.mix}`, app: null, src: null });
        return;
      }
      if (e.mixUnknown) {
        // 구성분이 원 공시와 다른데 decimals 근거가 없어(또는 원 공시를 못 읽어) 재게시·재작성을 못 가름 — 조용히 통과시키지 않는다
        for (const [n, v] of [[nC, appC], [nG, appG]])
          add("A", n, col, { status: NA, note: `${COGS_MIX} 판정 불가 — ${/decimals 없음/.test(e.mixUnknown) ? "decimals 없음" : /원 공시 없음/.test(e.mixUnknown) ? "원 공시 없음" : "판본 공시 판독 없음"} · ${e.mixUnknown}`, app: v, src: null });
        return;
      }
      if (e.cogs == null) {
        // D형 — 본표에 매출원가 줄 없음
        const base = `본표에 매출원가 줄 없음(D형) — ${e.how}`;
        if (e.rule) add("A", nC, col, { status: FAIL, note: `구성 규칙이 있는데 대조 불가 — ${e.offFace.length ? `규칙 줄이 본표에 없음: ${e.offFace.join("·")}` : "규칙 줄 값 없음"} · ${e.how}`, app: appC, src: null });
        else add("A", nC, col, appC != null ? { status: FAIL, note: `${base} · 구성 규칙 없음인데 앱 값 ${appC}`, app: appC, src: null }
          : wait ? { status: NA, note: `${COGS_WAIT} — ${base}`, app: null, src: null }
          : { status: FAIL, note: `${base} · 앱 빈칸인데 사유 "${COGS_WAIT}" 없음(조용한 빈칸)`, app: null, src: null });
        add("A", nG, col, appG != null ? { status: FAIL, note: `${base} · 매출원가 없이 앱 매출총이익 ${appG}`, app: appG, src: null }
          : { status: NA, note: `매출총이익 없음 — ${base}${wait ? ` · ${COGS_WAIT}` : ""}`, app: null, src: null });
        return;
      }
      if (e.rule && e.offFace.length) {
        add("A", nC, col, { status: FAIL, note: `구성 규칙 줄이 본표에 없음: ${e.offFace.join("·")} — 규칙은 본표 줄 조합이어야 함 · ${e.how}`, app: appC, src: e.cogs });
        return;
      }
      // 외화 공시 — 원통화 본표 × 기간 평균 환율(매출 미검증 열 대조와 같은 방식, 부동소수 오차만)
      let k = 1, fxNote = "";
      if (foreign) {
        const avg = fxRows ? fxAvg(fxRows, e.start, e.end) : null;
        const pend = fxPendingWhy(fxRows, e.end);
        if (pend) { add("A", nC, col, appC == null ? { status: PASS, note: `${pend} — 앱 빈칸(대체 없음)` } : { status: FAIL, note: `${pend}인데 앱 값 ${appC} — 다른 환율로 대체한 것으로 보임` }); return; }
        if (avg == null) { hardErrors.push(`매출원가 기간 평균 환율 없음(${e.start}~${e.end})${fxErr ? `: ${fxErr}` : ""}`); return; }
        k = avg;
        fxNote = ` · 원통화(${natCur}) × 기간 평균 환율 ${avg.toPrecision(6)}${fxWin(e.start, e.end)}`;
      }
      add("A", nC, col, vsSource(appC, e.cogs * k, EXACT, `${e.rule ? "구성 규칙 · " : ""}${e.how}${fxNote}`));
      let gExp = e.gp, gNote = e.how;
      if (e.gp == null) {
        // 구성 규칙 회사의 매출총이익은 기본 합성(매출 − 구성 매출원가 — 앱 설계와 같음), 규칙에 gp: "blank" 면 빈칸이어야 한다
        if (e.rule && COGS_RULES[sym]?.gp === "blank") {
          add("A", nG, col, appG != null ? { status: FAIL, note: `구성 규칙상 매출총이익 빈칸(gp: blank)인데 앱 ${appG}`, app: appG, src: null }
            : { status: NA, note: "구성 규칙상 매출총이익 빈칸(gp: blank)", app: null, src: null });
          return;
        }
        // C형(또는 구성 성분 중 소계 없는 공시가 섞임) — 합성: SEC 매출 − SEC 매출원가
        const r = revAt(kind, E, isQ4);
        gExp = r ? r.v - e.cogs : null;
        gNote = r ? `합성(본표 매출총이익 소계 없음, ${e.type}형) = SEC 매출 ${r.v} − SEC 매출원가 ${e.cogs} · 매출: ${r.how ?? ""} · 원가: ${e.how}` : `합성 대상이나 SEC 매출 기대값 없음(${revFaceWhy || "범위 밖"}) · ${e.how}`;
        cogsSynth.add(`${stmtTag}|${key}`);
        if (appG != null) add("C", "매출총이익 합성 표기 = 본표 소계 없음", col, synthMark(gRow) ? { status: PASS, note: `앱 행 "${gRow.accountName}"` }
          : { status: FAIL, note: `본표에 매출총이익 소계가 없어 합성값인데 앱에 합성 표기 없음 — 앱 행 "${gRow?.accountName}"` });
      }
      add("A", nG, col, vsSource(appG, gExp == null ? null : gExp * k, EXACT, `${gNote}${fxNote}`));
    };
    // 파생 열(Q4·LTM) 구성분의 원 공시를 먼저 읽어 둔다(기준 혼합 판정 — withMix)
    if (cogsFace && !foreign) await cogsFace.addOriginals([
      ...(H.LTM && (is?.periods ?? []).some((p) => p.label === "현재/LTM") ? [{ kind: "LTM", E: H.LTM.date }] : []),
      ...(isq?.periods ?? []).filter((p) => p.fiscalQuarter === 4 && p.endDate).map((p) => ({ kind: "Q4", E: p.endDate })),
    ]).catch((e) => hardErrors.push(`매출원가 원 공시 판독(기준 혼합 판정) 실패: ${String(e).slice(0, 160)}`));
    for (const per of is?.periods ?? []) {
      const key = per.label;
      if (key === "현재/LTM") { if (H.LTM && !foreign) judge("LTM", "LTM", key, H.LTM.date, false, cRowA, gRowA, waitA, "연간"); continue; }
      if (per.endDate) judge("FY", key.replace(/^FY(\d{4})$/, "$1Y"), key, per.endDate, false, cRowA, gRowA, waitA, "연간");
    }
    // 20-F 는 SEC 분기 원자료가 없다 — 분기·LTM 은 기존 "20-F LTM … = Yahoo 분기" 검사가 맡는다
    if (!foreign) for (const p of isq?.periods ?? []) { qEndOf.set(p.label, p.endDate); judge("Q", p.label, p.label, p.endDate, p.fiscalQuarter === 4, cRowQ, gRowQ, waitQ, "분기"); }

    // D. 분기 항등식 매출총이익 = 매출 − 매출원가(MCD 형 — 10-Q 만 다른 줄을 원가로 쓰는 경우). 합성 열은 식이 만든 값이라 자명 → 검증불가
    const revQ = isItem(isq, /^(매출액|순수익)$/);
    for (const p of isq?.periods ?? []) {
      const rev = revQ?.values?.[p.label] ?? null, cogs = cRowQ?.values?.[p.label] ?? null, gp = gRowQ?.values?.[p.label] ?? null;
      if (rev == null || cogs == null || gp == null) continue;
      const name = "분기 매출총이익 = 매출액 − 매출원가";
      if (cogsSynth.has(`분기|${p.label}`)) continue; // 자명(합성 매출총이익 = 매출 − 매출원가) — 검사 안 만듦(A층 매출·매출원가 대조가 대신, 2026-09-27)
      const dApp = gp - (rev - cogs);
      // 달러 정수끼리는 완전 일치(상대 오차 허용 없음), 환산값(외화)만 부동소수 오차
      let r0 = [rev, cogs, gp].every(Number.isInteger)
        ? (dApp === 0 ? { status: PASS } : { status: FAIL, note: `매출총이익 ${gp} ≠ 매출 ${rev} − 매출원가 ${cogs} (차 ${dApp})` })
        : same(gp, rev - cogs);
      if (r0.status === FAIL && cogsFace && revFace && !foreign) {
        // 회사 공시 자체가 반올림만큼 어기는 경우(IBM ±1) — SEC 본표 값으로 같은 차이가 정확히 재현되고 앱 매출총이익 = 본표 값일 때만
        const e = cogsFace.quarterAt(p.endDate, p.fiscalQuarter === 4), rv = revFace.quarterAt(p.endDate, p.fiscalQuarter === 4);
        const dSec = e?.gp != null && e.cogs != null && rv ? e.gp - (rv.v - e.cogs) : null;
        if (dSec != null && dSec !== 0 && dSec === dApp && gp === e.gp) {
          r0 = { status: PASS, note: `원인 확인(회사 공시 자체) — SEC 본표 매출총이익 ${e.gp} − (매출 ${rv.v} − 원가 ${e.cogs}) = ${dSec}, 앱 차이와 같음(회사 공시 반올림)` };
          review.push({ item: `${p.label} 분기 매출총이익 ≠ 매출 − 원가(회사 공시 자체)`, note: r0.note });
        }
      }
      add("D", name, p.label, r0);
    }
  }

  // ── 영업이익 A층(--metric=opinc, 2026-09-27 — 지표 미종결) ────────────────────────────────────────────────────────
  // 기대값 = 검증기가 본표 구조로 따로 판독한 값(secFaceOpinc): 소계가 있으면 그 줄(F), 없으면 세전이익 − 영업외 항목(S — FASB 택사노미 분류,
  // 총수익 분리 회사는 비영업 수익도). 연간·분기(3개월, Q4 = 사업연도 − 9개월)·LTM. 금융사·은행 레이아웃은 범위 밖(검사 없음).
  // 소계 없는 본표의 빈칸 기대: 금융 자회사(본표 금융 수익 표지)인데 금융 원가가 본표에 따로 없으면 "금융 자회사 이자비용 구분 불가",
  // 리츠(SIC 6798)·IFRS 세전이익·계산식 없음은 합성 대상 아님 — 앱이 값을 내면 FAIL, 빈칸이면 검사를 만들지 않는다(해당 없음)
  const opincExp = new Map(); // 열("2025Y"·"LTM") → 본표 판독 결과 + 기대값(exp) — F층 원인 규칙용
  if (OPINC_MODE && !opFinCo && !bank) {
    const OP_ROW_RE = /^영업이익(\s|\(|$)/;
    const oRowA = isItem(is, OP_ROW_RE), oRowQ = isItem(isq, OP_ROW_RE);
    const SYNTH_MARK = /소계 없음 · 세전이익 − 영업외 항목/;
    const revOpAt = (kind, E, isQ4) => (!revFace ? null : kind === "FY" ? revFace.annualAt(E) : kind === "LTM" ? revFace.ltmAt(E) : revFace.quarterAt(E, isQ4));
    const judgeO = (kind, col, key, E, isQ4, row) => {
      const sfx = kind === "Q" ? (isQ4 ? "(Q4 = 사업연도 − 9개월)" : "(3개월)") : "", pre = kind === "Q" ? "분기 " : "";
      const nF = `${pre}영업이익 앱 = SEC 본표 영업이익${sfx}`, nS = `${pre}영업이익(합성) 앱 = SEC 세전이익 − 영업외 항목${sfx}`;
      const app = row?.values?.[key] ?? null, cn = String(row?.cellNotes?.[key] ?? "");
      if (!opincFace) { add("A", nF, col, { status: NA, note: opincWhy || "본표 판독 없음", app, src: null }); return; }
      const e = kind === "FY" ? opincFace.annualAt(E) : kind === "LTM" ? opincFace.ltmAt(E) : opincFace.quarterAt(E, isQ4);
      if (!e) return; // 읽은 공시(연차 3건·10-Q 4건) 범위 밖 — 검사를 만들지 않는다(분기 창 범위)
      if (e.err) { hardErrors.push(`영업이익 본표 판독 실패(${col}): ${e.err}`); add("A", nF, col, { status: FAIL, note: `SEC 본표 판독 실패 — ${e.err}`, app, src: null }); return; }
      let k = 1, fxNote = "";
      if (foreign) {
        const avg = fxRows && e.start ? fxAvg(fxRows, e.start, e.end) : null;
        const pend = e.end ? fxPendingWhy(fxRows, e.end) : null;
        if (pend) { add("A", nF, col, app == null ? { status: PASS, note: `${pend} — 앱 빈칸(대체 없음)` } : { status: FAIL, note: `${pend}인데 앱 값 ${app} — 다른 환율로 대체한 것으로 보임` }); return; }
        if (avg == null) { hardErrors.push(`영업이익 기간 평균 환율 없음(${e.start}~${e.end})${fxErr ? `: ${fxErr}` : ""}`); return; }
        k = avg;
        fxNote = ` · 원통화(${natCur}) × 기간 평균 환율 ${avg.toPrecision(6)}${fxWin(e.start, e.end)}`;
      }
      if (e.type.includes("/")) { add("A", nF, col, { status: NA, note: `미결 — 구성 공시의 본표 구조가 섞임(${e.type}: 소계 있는 공시·없는 공시) · ${e.how}`, app, src: null }); return; }
      if (e.type === "F") {
        add("A", nF, col, vsSource(app, e.v * k, EXACT, `${e.how}${fxNote}`));
        if (kind !== "Q") opincExp.set(col, { ...e, exp: e.v * k });
        if (app != null && SYNTH_MARK.test(cn)) add("C", "영업이익 합성 표기 = SEC 본표 소계 유무", col, { status: FAIL, note: `SEC 본표에 영업이익 소계가 있는데 앱 칸 주석이 합성("${cn}")` });
        return;
      }
      // 소계 없음(S)
      if (e.blank || sic === 6798) {
        if (app != null) add("A", nS, col, { status: FAIL, note: `${e.blank ?? `리츠(SIC ${sic}) — 계산 구조 합성 대상 아님`}인데 앱 값 ${app}`, app, src: null });
        return;
      }
      if (e.finRev && !e.finCostSplit) {
        const nC = `${pre}영업이익 빈칸 = 금융 자회사(본표 소계 없음·금융 원가 미분리)`;
        add("A", nC, col, app != null ? { status: FAIL, note: `본표에 금융 부문 수익 표지가 있고 금융 원가가 따로 없어 이자비용 구분 불가인데 앱 값 ${app} · ${e.how}`, app, src: null }
          : /금융 자회사 이자비용 구분 불가/.test(cn) ? { status: PASS, note: `앱 빈칸 + 사유 "${cn}" · SEC 본표: 소계 없음, 금융 부문 수익 표지, 금융 원가 줄·멤버 없음` }
          : { status: FAIL, note: `앱 빈칸인데 사유 "금융 자회사 이자비용 구분 불가" 없음(조용한 빈칸) — 칸 주석 "${cn}"`, app: null, src: null });
        return;
      }
      let exp = e.v, how = e.how;
      if (opincFace.split) {
        const r = revOpAt(kind, E, isQ4);
        if (!r) { add("A", nS, col, { status: NA, note: `미결 — 총수익 분리 회사인데 영업 매출(SEC 본표 매출 기대값) 없음 · ${e.how}`, app, src: null }); return; }
        exp = e.v + r.v;
        how = `${how} + 영업 매출 ${r.v}(${r.how})`;
      }
      const cm = [
        e.extNonop?.length ? `회사 고유 줄 라벨로 영업외 판정 ${e.extNonop.join("·")}` : "",
        opincFace.split ? "총수익 비영업 분리(매출 A층 규칙 재구현)" : "",
      ].filter(Boolean);
      const capNote = e.finRev ? " · 금융 자회사 표지 있으나 금융 원가가 본표에 따로 있음(본표 이자비용 = 본사 이자) — 합성 대상" : "";
      add("A", nS, col, vsSource(app, exp * k, EXACT, `${how}${capNote}${cm.length ? ` · 공통모드(${cm.join(" · ")})` : ""}${fxNote}`));
      if (kind !== "Q") opincExp.set(col, { ...e, exp: exp * k, nonopRev: e.revTot != null && opincFace.split ? e.revTot - (exp - e.v) : null });
      if (app != null) add("C", "영업이익 합성 표기 = SEC 본표 소계 유무", col, SYNTH_MARK.test(cn) ? { status: PASS, note: `소계 없는 본표 — 앱 칸 주석 "${cn}"` }
        : { status: FAIL, note: `SEC 본표에 영업이익 소계가 없어 합성값인데 앱 칸 주석에 합성 표기 없음("${cn}")` });
    };
    for (const per of is?.periods ?? []) {
      const key = per.label;
      if (key === "현재/LTM") { if (H.LTM && !foreign) judgeO("LTM", "LTM", key, H.LTM.date, false, oRowA); continue; }
      if (per.endDate) judgeO("FY", key.replace(/^FY(\d{4})$/, "$1Y"), key, per.endDate, false, oRowA);
    }
    // 20-F 는 SEC 분기 원자료가 없다 — 분기·LTM 은 만들지 않는다
    if (!foreign) for (const p of isq?.periods ?? []) { qEndOf.set(p.label, p.endDate); if (p.endDate) judgeO("Q", p.label, p.label, p.endDate, p.fiscalQuarter === 4, oRowQ); }
    // 일회성비용 주석 행(2026-09-29 — 오너 지시 "안 한 항목도 다") = 본표 영업이익 식 안 일회성 줄(구조조정·손상·위약금·합의금 등) 합.
    // 검증기가 공시 원본 계산 구조에서 따로 고른 줄(OP_CHARGE_RE — 개념명·회사 라벨)이라 앱(edgar-oneoff)과 줄 선택 규칙이 다를 수 있다 — 규칙 재구현
    for (const [col, e] of opincExp) {
      if (col === "LTM" || e.type !== "F" || !(col in (IS ?? {}))) continue;
      if (process.env.VERIFY_DEBUG_ONEOFF) console.error("[oneoff]", sym, col, e.type, JSON.stringify(e.charges), String(e.how).slice(0, 160));
      // 줄 구성·금액 = 그 해를 담은 가장 최근 10-K(앱과 같은 판본 — 재작성 반영, WDC 분사 후 FY2024). 자기 10-K 본표는 ownAnnualAt(참고용)
      // 비용만(오너 결정 2026-09-28 — 일회성손익(순)으로 확장하지 않음): 처분손익 줄 제외
      const ch = (e.charges ?? []).filter((t) => t.kind === "charge" && !/GainLossOn(Disposition|Sale)|Gain(Loss)?OnSale|Divestiture|gains? on (the )?(sale|disposal|disposition|divest)/i.test(`${t.id} ${t.label}`)); // 처분손익만 제외 — 위약금(GainLossOnContractTermination, AMAT)·소송 합의(WDC)는 일회성
      const missing = ch.filter((t) => t.v == null);
      const exp = ch.reduce((s, t) => s + (t.v == null ? 0 : -t.w * t.v), 0) * (e.k ?? 1);
      const app = IS[col]?.oneOff ?? null;
      const ev = ch.length ? ch.map((t) => `${t.label} ${t.v ?? "그 해 없음 0"}`).join(" + ") : "본표 영업이익 식에 일회성 줄 없음 → 0";
      if (missing.length && !extEq(app, exp)) { add("A", "일회성비용 앱 = SEC 본표 일회성 줄 합", col, { status: NA, note: `최신 본표 일회성 줄 ${missing.map((t) => t.label).join("·")} 의 그 해 값 없음(개념 변경 가능 — ORCL FY2026 10-K) · 앱 ${app} vs 찾은 줄 합 ${exp}`, app, src: null }); continue; }
      add("A", "일회성비용 앱 = SEC 본표 일회성 줄 합", col, app == null && !ch.length ? { status: PASS, note: "일회성 줄 없음 · 앱 빈칸" } : vsSource(app, exp, EXACT, `${ev} · 규칙 재구현(줄 선택 규칙이 앱과 다를 수 있음)`));
    }
  }

  // ── 감가상각비 A층(--metric=da, 2026-09-27 — 지표 미종결) ────────────────────────────────────────────────────────
  // 기대값 = 검증기가 공시 원본에서 따로 판독한 현금흐름표 감가상각·상각 줄 합(secFaceDa — 손상 포함 줄·중단사업 포함 현금흐름표는 원본 태그로 조정,
  // NFLX 는 콘텐츠 상각 줄 포함). 연간(앱 연도 열마다 그 해를 담은 10-K 까지 읽는다)·LTM·분기(현금흐름표 누적 차 — Q1 3개월, Q2·Q3 누적 차,
  // Q4 = 사업연도 − 9개월). 은행 레이아웃·외화 공시는 범위 밖(검사 없음). 분기가 읽은 공시 범위 밖이면 검사를 만들지 않는다(분기 창 범위)
  const daExp = new Map(); // 열("2025Y"·"LTM") → 판독 결과(F층 원인 규칙용)
  const DA_NAME = "감가상각비 앱 = SEC 현금흐름표 감가상각·상각 줄 합";
  if (DA_MODE && !bank && (!foreign || natCur)) {
    const dRowA = isItem(is, /^감가상각비$/), dRowQ = isItem(isq, /^감가상각비$/);
    const judgeD = (kind, col, key, E, isQ4, row) => {
      const q = kind === "Q";
      const e0 = !daFace ? null : kind === "FY" ? daFace.annualAt(E) : kind === "LTM" ? daFace.ltmAt(E) : daFace.quarterAt(E, isQ4);
      const sfx = !q ? "" : isQ4 ? "(Q4 = 사업연도 − 9개월)" : e0 && /누적 차/.test(e0.how) ? "(누적 차)" : "(3개월)";
      const name = `${q ? "분기 " : ""}${DA_NAME}${sfx}`;
      const app = row?.values?.[key] ?? null;
      if (!daFace) { add("A", name, col, { status: NA, note: daWhy || "현금흐름표 판독 없음", app, src: null }); return; }
      if (!e0) {
        // 연간·LTM 은 그 기간을 담은 공시까지 읽었으므로 검증불가(사유). 분기는 그 분기말 10-Q 가 판독 제외(요약 현금흐름표 등)일 때만 검증불가 — 그 밖은 분기 창 범위라 검사를 만들지 않는다
        const sk = daFace.skipped.filter((x) => (Date.parse(x.report) - Date.parse(E)) / 864e5 >= -7 && (Date.parse(x.report) - Date.parse(E)) / 864e5 <= (q ? 7 : 400));
        if (!q || sk.length) add("A", name, col, { status: NA, note: `기간 ${E} — 구성 공시 현금흐름표에서 감가상각 줄 값을 찾지 못함${sk.length ? ` · 판독 제외 공시 ${sk.map((x) => x.txt).join(" · ")}` : ""}`, app, src: null });
        return;
      }
      // 구성 공시 간 감가상각 줄 기준 혼합(secFaceDa mixOf) — 정답은 앱 빈칸 + "기준 혼합" 사유(값을 내면 FAIL, 사유 없는 빈칸도 FAIL)
      if (e0.mix) {
        const why = row?.cellNotes?.[key] ?? "";
        add("A", name, col, app != null ? { status: FAIL, note: `감가상각 줄 ${COGS_MIX} 열에 앱 값 ${app} — 빈칸이어야 함(한 열 = 한 기준) · ${e0.mix}`, app, src: null }
          : why.includes(COGS_MIX) ? { status: PASS, note: `감가상각 줄 ${COGS_MIX} 확인 — 앱 빈칸 + 사유 · ${e0.mix}`, app: null, src: null }
          : { status: FAIL, note: `감가상각 줄 ${COGS_MIX}인데 앱 빈칸 사유에 "${COGS_MIX}" 없음(${why || "사유 없음"}) · ${e0.mix}`, app: null, src: null });
        return;
      }
      if (e0.unres) { add("A", name, col, { status: NA, note: `미결 — ${e0.unres}(앱 ${app ?? "빈칸"}, SEC 줄 합 ${e0.lineSum}) · ${e0.how}`, app, src: null }); return; }
      // LTM 종전 식 폴백 — 값 대조와 함께 칸 주석(DA_LTM_FALLBACK)이 있어야 한다
      if (e0.fallback && app != null && !(row?.cellNotes?.[key] ?? "").includes(e0.fallback)) { add("A", name, col, { status: FAIL, note: `LTM 분기 합 기준 혼합 → 종전 식인데 앱 칸 주석에 "${e0.fallback}" 없음 · ${e0.how}`, app, src: e0.v }); return; }
      // 20-F — 원통화 현금흐름표 줄 합 × 기간 평균 환율(연준 H.10, 매출원가 외화 대조와 같은 방식)
      let k = 1, fxNote = "";
      if (foreign) {
        const pend = fxPendingWhy(fxRows, e0.end);
        if (pend) { add("A", name, col, app == null ? { status: PASS, note: `${pend} — 앱 빈칸(대체 없음)` } : { status: FAIL, note: `${pend}인데 앱 값 ${app} — 다른 환율로 대체한 것으로 보임` }); return; }
        const avg = fxRows ? fxAvg(fxRows, e0.start, e0.end) : null;
        if (avg == null) { hardErrors.push(`감가상각비 기간 평균 환율 없음(${e0.start}~${e0.end})${fxErr ? `: ${fxErr}` : ""}`); return; }
        k = avg;
        fxNote = ` · 원통화(${natCur}) × 기간 평균 환율 ${avg.toPrecision(6)}${fxWin(e0.start, e0.end)}`;
      }
      add("A", name, col, vsSource(app, e0.v * k, EXACT, `규칙 재구현(줄 선택은 공통모드) · ${e0.how}${fxNote}`));
      if (!q) daExp.set(col, e0);
    };
    // 앱 연도 열·분기 열을 담은 공시를 먼저 더 읽는다(최근 10-K 3건·10-Q 4건 밖 — 과거 목록 파일까지)
    try {
      for (const per of is?.periods ?? []) if (per.label !== "현재/LTM" && per.endDate && daFace && !daFace.annualAt(per.endDate)) await daFace.extend(per.endDate, "FY");
      // 최초 공시 규칙(orig-first)용 — 연간 열마다 그 해 1~3분기 10-Q 를 읽어 둔다(원공시 판본)
      for (const per of is?.periods ?? []) { const fy = per.label !== "현재/LTM" && per.endDate && daFace ? daFace.annualAt(per.endDate) : null; if (fy?.start) { await daFace.extend(per.endDate, "FY"); } if (fy?.start) await daFace.extend(new Date(Date.parse(fy.start) + 80 * 864e5).toISOString().slice(0, 10), "Q"); }
      if (!foreign) for (const p of isq?.periods ?? []) if (p.endDate && daFace && !daFace.quarterAt(p.endDate, p.fiscalQuarter === 4)) await daFace.extend(p.endDate, "Q");
    } catch (e) { hardErrors.push(`감가상각비 과거 공시 판독 실패: ${String(e).slice(0, 120)}`); }
    for (const per of is?.periods ?? []) {
      const key = per.label;
      if (key === "현재/LTM") { if (H.LTM && !foreign) judgeD("LTM", "LTM", key, H.LTM.date, false, dRowA); continue; }
      if (per.endDate) judgeD("FY", key.replace(/^FY(\d{4})$/, "$1Y"), key, per.endDate, false, dRowA);
    }
    if (!foreign) for (const p of isq?.periods ?? []) { qEndOf.set(p.label, p.endDate); if (p.endDate) judgeD("Q", p.label, p.label, p.endDate, p.fiscalQuarter === 4, dRowQ); }
  }

  // ── 재무상태표·현금흐름표 A층·D층(--metric=bscf, 2026-09-30 — 오너 "계속 진행": 손익 다음 단계) ─────────────────────────────
  // A층: 합계·핵심 줄을 SEC 원자료와 정확 대조(재무상태표 = 결산일 ±7일 시점 값, 현금흐름표 = 사업연도 기간 값 · LTM = SEC TTM, 최신 공시 판본
  //      · 반올림 재태깅 제외). 개념 목록은 앱과 같은 순서(첫 개념 = 표준 합계 태그 — 대체 개념을 쓴 칸은 공통모드 표시).
  // D층: 기타 줄(나머지 채움)이 없는 항등식 — 자산 = 유동 + 비유동, 부채 = 유동 + 비유동, 영업·투자·재무 소계 = depth 1 줄 합,
  //      운전자본 변동 = 하위 줄 합, 현금 증감 = 영업 + 투자 + 재무 + 환율, FCF = 영업현금흐름 − CAPEX, CAPEX = −유형자산 취득
  if (BSCF_MODE && bs && fetched.cf) {
    const stItems = (st) => (st?.sections ?? []).flatMap((s0) => s0.items ?? []);
    const bsItems = stItems(bs), cfItems = stItems(fetched.cf);
    const byId = (items, id) => items.find((it) => it.accountId === id);
    const val = (it, col) => (it ? it.values?.[col === "LTM" ? "현재/LTM" : col] ?? null : null);
    const noteOf = (it, col) => String(it?.cellNotes?.[col === "LTM" ? "현재/LTM" : col] ?? "");
    // 연간 열 = 10-K(20-F·40-F) 값만 — 10-Q 비교 열의 연말 값은 쓰지 않는다(앱 연간 열과 같은 공시 종류). LTM = 10-Q·10-K
    // 연간 열 = 그 결산일 자산총계(Assets)를 실은 연간 공시의 값 — 자본변동표 기초 잔액만 재작성된 나중 공시(WDC FY2022 자본 12,323)는 재무상태표 본표가
    // 아니라 쓰지 않는다(그 공시들에 값이 없을 때만). 검증기 독립 구현
    const assetsFiled = (date) => new Set((G.Assets?.units?.USD ?? []).filter((e) => !e.start && /^(10-K|20-F|40-F)/.test(e.form ?? "") && dayDiff(e.end, date) <= 7).map((e) => e.filed));
    const inst = (c0, date, annual = true) => {
      let l = (G[c0]?.units?.USD ?? []).filter((e) => !e.start && (annual ? /^(10-K|20-F|40-F)/ : /^(10-[KQ]|20-F|40-F)/).test(e.form ?? "") && dayDiff(e.end, date) <= 7);
      if (annual) { const af = assetsFiled(date), l2 = l.filter((e) => af.has(e.filed)); if (l2.length) l = l2; }
      if (!l.length) return null;
      const end = l.map((e) => e.end).sort((p, q) => dayDiff(p, date) - dayDiff(q, date))[0];
      const same = l.filter((e) => e.end === end).sort((a, b) => (a.filed ?? "").localeCompare(b.filed ?? ""));
      const pick = latestPrecise(same);
      // 작은 단위(천·만·10만) 반올림 재게시 — 재게시 값이 그 단위의 배수이고 먼저 공시된 정밀값과 한 단위 이내면 정밀값(검증기 독립 구현 — 짝수 반올림·
      // 합계 맞춤 1단위 조정 포함, MRVL 2022-01-29 유동자산 2,493,450천 → 2,493.4백만). 오너 결정 "원 공시 정밀값"
      const y = pick && same.find((e) => (e.filed ?? "") < (pick.filed ?? "") && e.val !== pick.val && [1e3, 1e4, 1e5].some((p) => Math.abs(pick.val) >= 100 * p && pick.val % p === 0 && e.val % p !== 0 && Math.abs(pick.val - e.val) <= p));
      return y ? { ...y, retag: { val: pick.val, filed: pick.filed, unit: "작은 단위 반올림 재게시" } } : pick;
    };
    const dur = (c0, date) => {
      const l = (G[c0]?.units?.USD ?? []).filter((e) => e.start && /^(10-K|20-F|40-F)/.test(e.form ?? "") && dayDiff(e.end, date) <= 7 && (Date.parse(e.end) - Date.parse(e.start)) / 864e5 >= 300 && (Date.parse(e.end) - Date.parse(e.start)) / 864e5 <= 400);
      if (!l.length) return null;
      const pick = latestPrecise(l);
      // 부호만 뒤집힌 재게시(회사 XBRL 태깅 오류 — AMD 2021 투자·재무활동: 10-K 본문 표 (686)·(1,895), 2024 10-K 태그 +686·+1,895)는 앞선 값(앱과 같은 규칙, 오너 결정 2026-09-30)
      const prev = pick && pick.val !== 0 ? l.filter((e) => (e.filed ?? "") < (pick.filed ?? "")).sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? "")).find((e) => e.val !== pick.val) : null;
      return prev && prev.val === -pick.val ? { ...prev, retag: { val: pick.val, filed: pick.filed, unit: "부호 반전 재게시(태깅 오류)" } } : pick;
    };
    const cols = Object.keys(H).filter((c) => H[c]?.date);
    const tempSec = (date, annual) => {
      const all = inst("TemporaryEquityCarryingAmountIncludingPortionAttributableToNoncontrollingInterests", date, annual);
      if (all) return { v: all.val, how: "TemporaryEquityCarryingAmountIncludingPortionAttributableToNoncontrollingInterests" };
      const pa = inst("TemporaryEquityCarryingAmountAttributableToParent", date, annual);
      const nc = inst("RedeemableNoncontrollingInterestEquityCarryingAmount", date, annual) ?? inst("RedeemableNoncontrollingInterestEquityCommonCarryingAmount", date, annual);
      return pa || nc ? { v: (pa?.val ?? 0) + (nc?.val ?? 0), how: [pa && "TemporaryEquityCarryingAmountAttributableToParent", nc && "RedeemableNoncontrollingInterest"].filter(Boolean).join(" + ") } : null;
    };
    const A_BS = [
      ["bs:자산:현금·현금성자산", "현금·현금성자산", ["CashAndCashEquivalentsAtCarryingValue", "CashAndCashEquivalentsAtCarryingValueIncludingDiscontinuedOperations", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "Cash"]],
      ["bs:자산:유동자산 총계", "유동자산 총계", ["AssetsCurrent"]],
      ["bs:부채:유동부채 총계", "유동부채 총계", ["LiabilitiesCurrent"]],
      ["bs:부채:부채 총계", "부채 총계", ["Liabilities"]],
      ["bs:자본:자본 총계", "자본 총계", ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]],
    ];
    const A_CF = [
      ["cf:total:영업활동 현금흐름", "영업활동 현금흐름", ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"], 1],
      ["cf:total:투자활동 현금흐름", "투자활동 현금흐름", ["NetCashProvidedByUsedInInvestingActivities", "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations"], 1],
      ["cf:total:재무활동 현금흐름", "재무활동 현금흐름", ["NetCashProvidedByUsedInFinancingActivities", "NetCashProvidedByUsedInFinancingActivitiesContinuingOperations"], 1],
      ["cf:투자활동 현금흐름:유형자산 취득", "유형자산 취득(CAPEX)", ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"], -1],
      ["cf:재무활동 현금흐름:배당금 지급", "배당금 지급", ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"], -1],
      ["cf:재무활동 현금흐름:자기주식 취득", "자기주식 취득", ["PaymentsForRepurchaseOfCommonStock"], -1],
      ["cf:영업활동 현금흐름:주식보상비용", "주식보상비용", ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"], 1],
    ];
    const hasCol = (st, c) => (st?.periods ?? []).some((p) => p.label === (c === "LTM" ? "현재/LTM" : c));
    for (const c of cols) {
      const date = H[c].date;
      // 재무상태표 — 연간 열 + LTM(최근 분기말). 앱 표에 그 열이 없으면(상장 전 연도 — GEV 2022·SNDK 2023) 검사하지 않는다
      if (!hasCol(bs, c)) continue;
      for (const [id, nm, cs] of A_BS) {
        let it = byId(bsItems, id);
        if (!it) continue;
        // 앱이 표준 태그 대신 다른 정의의 태그를 별도 줄(:alt — 제한현금 포함 총액 등)로 실은 칸은 그 줄 값을 대체 개념과 대조
        const alt = byId(bsItems, `${id}:alt`);
        let csUse = cs;
        if (val(it, c) == null && alt && val(alt, c) != null) { it = alt; csUse = cs.filter((x) => /Restricted|^Cash$/.test(x)); }
        const app = val(it, c), why = noteOf(it, c);
        let hit = null, usedIdx = -1;
        for (let i = 0; i < csUse.length && !hit; i++) { hit = inst(csUse[i], date, c !== "LTM"); if (hit) usedIdx = i; }
        if (csUse !== cs && hit) usedIdx = cs.indexOf(csUse[usedIdx]);
        const cm = usedIdx > 0 ? ` · 공통모드(대체 개념 ${cs[usedIdx]} — 앱과 같은 개념 목록${csUse !== cs ? ", 앱 별도 줄 :alt" : ""})` : "";
        // 부채 총계 태그가 없으면 부채와 자본 총계 − 비지배지분 포함 자본(없으면 지배주주 자본 + 비지배지분)으로(2026-10-01 KO — 독립 계산)
        if (!hit && id === "bs:부채:부채 총계") {
          const le = inst("LiabilitiesAndStockholdersEquity", date, c !== "LTM"), ea = inst("StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", date, c !== "LTM");
          const se = inst("StockholdersEquity", date, c !== "LTM"), mi = inst("MinorityInterest", date, c !== "LTM");
          const eAll = ea?.val ?? (se ? se.val + (mi?.val ?? 0) : null), tq = tempSec(date, c !== "LTM");
          if (le && eAll != null) { add("A", `재무상태표 ${nm} 앱 = SEC`, c, vsSource(app, le.val - eAll - (tq?.v ?? 0), EXACT, `Liabilities 미태깅 — 부채와 자본 ${le.val} − 비지배지분 포함 자본 ${eAll}(${ea ? "포함 자본 태그" : "지배주주 자본 + 비지배지분"})${tq ? ` − 임시자본 ${tq.v}` : ""}`)); continue; }
        }
        // 자본 정정 열(오너 결정 (다)) — 그 열 재무상태표 자본 + 나중 정기공시의 정정 금액
        if (c !== "LTM" && (id === "bs:자본:자본 총계" || id === "bs:부채:부채 총계")) {
          const rs = eqRestate(date);
          if (rs && id === "bs:자본:자본 총계") { add("A", `재무상태표 ${nm} 앱 = SEC`, c, vsSource(app, rs.base + rs.delta, EXACT, `자본 정정 — 재무상태표 공시 ${rs.base} + 정정 ${rs.delta}(${rs.filed} 정기공시)`)); continue; }
        }
        // 자본 총계 — 지배주주 자본 태그가 없으면 비지배지분 포함 자본 − 비지배지분(2026-10-01 CAT — StockholdersEquity 미태깅)
        if (id === "bs:자본:자본 총계" && !inst("StockholdersEquity", date, c !== "LTM")) {
          const ea = inst("StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", date, c !== "LTM"), mi = inst("MinorityInterest", date, c !== "LTM");
          if (ea) { add("A", `재무상태표 ${nm} 앱 = SEC`, c, vsSource(app, ea.val - (mi?.val ?? 0), EXACT, `StockholdersEquity 미태깅 — 비지배지분 포함 자본 ${ea.val}${mi ? ` − 비지배지분 ${mi.val}` : "(비지배지분 태그 없음)"}`)); continue; }
        }
        if (!hit) { add("A", `재무상태표 ${nm} 앱 = SEC`, c, app == null ? { status: NA, note: `SEC ${cs.join("/")} 결산일 값 없음 — 앱 빈칸${why ? `(${why})` : ""}`, app, src: null } : { status: NA, note: `SEC ${cs.join("/")} 결산일 값 없음 — 앱 ${app}(파생값 가능: ${why || "사유 없음"})`, app, src: null }); continue; }
        const r0 = vsSource(app, hit.val, EXACT, `${cs[usedIdx]} ${hit.form} ${hit.filed}${retagNote(hit) ? ` · ${retagNote(hit)}` : ""}${cm}`);
        add("A", `재무상태표 ${nm} 앱 = SEC`, c, usedIdx > 0 && r0.status === PASS ? { ...r0, status: COMMON } : r0);
      }
      {
        const it = byId(bsItems, "bs:자본:임시자본"), app = val(it, c);
        const tq = tempSec(date, c !== "LTM");
        if (tq && tq.v === 0 && app == null) add("A", "재무상태표 임시자본 앱 = SEC", c, { status: PASS, note: `SEC ${tq.how} = 0 — 앱 빈칸(0, 합계 영향 없음)`, app, src: 0 });
        else if (tq) add("A", "재무상태표 임시자본 앱 = SEC", c, vsSource(app, tq.v, EXACT, tq.how));
        else if (app != null) {
          // 표준 태그 없음 — 결산일 공시 원본(인스턴스)에서 차원 없는 임시자본·상환가능 지분 계열 태그(회사 고유 포함)를 직접 읽는다(2026-10-01 AVGO
          // avgo_TemporaryEquityPreferredStockDividendObligation 27). 우선주 청산가치·주식수는 금액이 아니라 제외
          let r1 = { status: NA, note: `SEC 임시자본 표준 태그 없음 — 앱 ${app}(${noteOf(it, c) || "사유 없음"})`, app, src: null };
          try {
            const fa = await filingAtDate(cik, sub, date);
            const hits = (fa?.facts ?? []).filter((f) => !f.dims.length && /TemporaryEquity|RedeemableNoncontrolling|Mezzanine/i.test(f.id) && !/LiquidationPreference|Shares|PerShare|Redemption(Price|Value)/i.test(f.id));
            const ids = [...new Map(hits.map((f) => [f.id, f.v])).entries()];
            const one = ids.find(([, v]) => v === app), sum = ids.reduce((t, [, v]) => t + v, 0);
            if (one) r1 = vsSource(app, one[1], EXACT, `공시 원본 ${fa.form} ${fa.filed ?? ""} ${one[0]}(회사 고유 태그)`);
            else if (ids.length) r1 = vsSource(app, sum, EXACT, `공시 원본 ${fa.form} 임시자본 계열 합 ${ids.map(([k, v]) => `${k} ${v}`).join(" + ")}`);
          } catch (e) { r1 = { ...r1, note: `${r1.note} · 원본 판독 실패 ${String(e).slice(0, 60)}` }; }
          add("A", "재무상태표 임시자본 앱 = SEC", c, r1);
        }
      }
      // 현금흐름표 — 연간 열 = 10-K 사업연도 값, LTM = SEC TTM
      for (const [id, nm, cs, sg] of hasCol(fetched.cf, c) ? A_CF : []) {
        const it = byId(cfItems, id);
        if (!it) continue;
        const app = val(it, c), why = noteOf(it, c);
        let v = null, how = "", usedIdx = -1;
        for (let i = 0; i < cs.length && v == null; i++) {
          if (c === "LTM") { const t = secTtm(cs[i]); if (t && dayDiff(t.end, date) <= 7) { v = t.v; how = `${cs[i]} SEC TTM(${t.how ?? t.end})`; usedIdx = i; } }
          else { const e = dur(cs[i], date); if (e) { v = e.val; how = `${cs[i]} ${e.form} ${e.filed}${retagNote(e) ? ` · ${retagNote(e)}` : ""}`; usedIdx = i; } }
        }
        const cm = usedIdx > 0 ? ` · 공통모드(대체 개념 — 앱과 같은 개념 목록)` : "";
        // LTM — 회사가 사업연도(10-K)와 분기(10-Q)에 다른 태그를 단 경우(2026-10-01 MAR: 10-K PaymentsToAcquireProductiveAssets 604, 10-Q PaymentsToAcquirePropertyPlantAndEquipment)
        //    같은 개념 목록 안에서 사업연도 + 당기 누적 − 전년 동기(태그를 넘나듦 — 앱과 같은 목록이라 공통모드)
        if (v == null && c === "LTM") {
          const all = cs.flatMap((t) => (G[t]?.units?.USD ?? []).filter((e) => e.start && /^10-[KQ]/.test(e.form ?? "")).map((e) => ({ ...e, t })));
          const dd = (e) => (Date.parse(e.end) - Date.parse(e.start)) / 864e5;
          const curs = all.filter((e) => /^10-Q/.test(e.form) && dayDiff(e.end, date) <= 7 && dd(e) >= 80 && dd(e) <= 300);
          const mx = Math.max(0, ...curs.map(dd)), cur = latestPrecise(curs.filter((e) => dd(e) >= mx - 3));
          const fy = cur ? latestPrecise(all.filter((e) => dd(e) >= 300 && dayDiff(e.end, cur.start) <= 7)) : null;
          const prior = cur && fy ? latestPrecise(all.filter((e) => dayDiff(e.start, fy.start) <= 7 && Math.abs(dd(e) - dd(cur)) <= 7 && /^10-Q/.test(e.form))) : null;
          if (cur && fy && prior && new Set([cur.t, fy.t, prior.t]).size > 1) {
            const r1 = vsSource(app, sg * (fy.val + cur.val - prior.val), EXACT, `사업연도 ${fy.t} ${fy.val} + 당기 누적 ${cur.t} ${cur.val} − 전년 동기 ${prior.t} ${prior.val}(공시마다 태그가 다름)${sg < 0 ? " × −1" : ""}`);
            add("A", `현금흐름표 ${nm} 앱 = SEC`, c, r1.status === PASS ? { ...r1, status: COMMON } : r1);
            continue;
          }
        }
        if (v == null) { add("A", `현금흐름표 ${nm} 앱 = SEC`, c, { status: NA, note: `SEC ${cs.join("/")} 기간 값 없음 — 앱 ${app ?? `빈칸(${why || "사유 없음"})`}`, app, src: null }); continue; }
        const r0 = vsSource(app, sg * v, EXACT, `${how}${sg < 0 ? " × −1(현금 유출 표기)" : ""}${cm}`);
        add("A", `현금흐름표 ${nm} 앱 = SEC`, c, usedIdx > 0 && r0.status === PASS ? { ...r0, status: COMMON } : r0);
      }
      // D층 — 재무상태표
      const g = (id) => val(byId(bsItems, id), c);
      const eqD = (name, a, b, extra = "") => { if (a == null || b == null) return; add("D", name, c, Math.abs(a - b) < 1 ? { status: PASS, ...(extra ? { note: extra } : {}) } : { status: FAIL, note: `${a} ≠ ${b}(차 ${a - b})${extra ? ` · ${extra}` : ""}` }); };
      const cur = g("bs:자산:유동자산 총계"), non = g("bs:자산:비유동자산 총계"), tot = g("bs:자산:자산 총계");
      if (cur != null && non != null) eqD("재무상태표 자산 총계 = 유동 + 비유동", tot, cur + non);
      const lc = g("bs:부채:유동부채 총계"), ln = g("bs:부채:비유동부채 총계"), lt = g("bs:부채:부채 총계");
      if (lc != null && ln != null) eqD("재무상태표 부채 총계 = 유동 + 비유동", lt, lc + ln);
      const eqT = g("bs:자본:자본 총계"), nciT = g("bs:자본:비지배지분"), leT = g("bs:자본:부채와 자본 총계"), tmpT = g("bs:자본:임시자본");
      if (lt != null && eqT != null && leT != null) {
        const rhs = lt + eqT + (nciT ?? 0) + (tmpT ?? 0), ex = [nciT && `비지배지분 ${nciT}`, tmpT && `임시자본 ${tmpT}`].filter(Boolean).join(" · ");
        const d0 = leT - rhs;
        // 회사 표기 반올림 — SEC 공시 값(부채와 자본·부채·비지배지분 포함 자본·임시자본)끼리도 정확히 같은 차가 나오고 그 차가 표기 한 단위(100만) 이내(IBM 2024 −1)
        const an = c !== "LTM", sL = inst("LiabilitiesAndStockholdersEquity", date, an), sLi = inst("Liabilities", date, an);
        const sEa = inst("StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", date, an), sSe = inst("StockholdersEquity", date, an), sMi = inst("MinorityInterest", date, an);
        const sE = sEa?.val ?? (sSe ? sSe.val + (sMi?.val ?? 0) : null), sT = tempSec(date, an);
        const secD = sL && sLi && sE != null ? sL.val - sLi.val - sE - (sT?.v ?? 0) : null;
        if (Math.abs(d0) >= 1 && secD != null && Math.abs(secD - d0) < 1 && Math.abs(d0) <= 1e6)
          add("D", "재무상태표 부채와 자본 총계 = 부채 + 자본 + 비지배지분 + 임시자본", c, { status: PASS, note: `회사 표기 반올림 — SEC 공시 값끼리도 차 ${secD}(부채와 자본 ${sL.val} − 부채 ${sLi.val} − 자본 ${sE}${sT ? ` − 임시자본 ${sT.v}` : ""})${ex ? ` · ${ex}` : ""}` });
        else eqD("재무상태표 부채와 자본 총계 = 부채 + 자본 + 비지배지분 + 임시자본", leT, rhs, ex);
      }
      // D층 — 현금흐름표
      const f = (id) => val(byId(cfItems, id), c);
      for (const [sec, tid] of [["영업활동 현금흐름", "cf:total:영업활동 현금흐름"], ["투자활동 현금흐름", "cf:total:투자활동 현금흐름"], ["재무활동 현금흐름", "cf:total:재무활동 현금흐름"]]) {
        const rows = cfItems.filter((it) => it.accountId.startsWith(`cf:${sec}:`) && it.depth === 1);
        const vs = rows.map((it) => val(it, c));
        const blankWhy = rows.filter((it) => val(it, c) == null && noteOf(it, c)).map((it) => `${it.accountId.split(":").pop()}(${noteOf(it, c).slice(0, 40)})`);
        if (f(tid) != null && blankWhy.length) add("D", `현금흐름표 ${sec} = 구성 줄 합`, c, { status: NA, note: `구성 줄 일부 빈칸(사유 있음) — ${blankWhy.join(" · ")}` });
        else if (f(tid) != null && vs.some((x) => x != null)) eqD(`현금흐름표 ${sec} = 구성 줄 합`, f(tid), vs.reduce((t, x) => t + (x ?? 0), 0));
      }
      const wc = byId(cfItems, "cf:영업활동 현금흐름:운전자본 변동");
      if (wc) {
        const i0 = cfItems.indexOf(wc), kids = [];
        for (let i = i0 + 1; i < cfItems.length && cfItems[i].depth === 2; i++) kids.push(val(cfItems[i], c));
        if (kids.length && val(wc, c) != null && kids.some((x) => x != null)) eqD("현금흐름표 운전자본 변동 = 하위 줄 합", val(wc, c), kids.reduce((t, x) => t + (x ?? 0), 0));
      }
      const o = f("cf:total:영업활동 현금흐름"), iv = f("cf:total:투자활동 현금흐름"), fi = f("cf:total:재무활동 현금흐름"), fx = f("cf:fx"), nc = f("cf:netchange");
      const dsc = f("cf:disc"); // 중단사업 현금흐름(앱 2026-09-30 추가 — MRK 2021)
      if (o != null && iv != null && fi != null && nc != null) {
        const d0 = nc - (o + iv + fi + (fx ?? 0) + (dsc ?? 0));
        // 회사 공시 반올림 — SEC 사업연도 값(영업·투자·재무·환율·중단사업·순증감)으로도 같은 차이가 나면 통과(IBM 2022·2024, MCD 2024·2025 ±1)
        const sv = (cs) => { for (const c0 of cs) { const e = dur(c0, date); if (e) return e.val; } return null; };
        const secD = c === "LTM" || Math.abs(d0) < 1 ? null : (() => {
          const so = sv(["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"]), si = sv(["NetCashProvidedByUsedInInvestingActivities", "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations"]), sf = sv(["NetCashProvidedByUsedInFinancingActivities", "NetCashProvidedByUsedInFinancingActivitiesContinuingOperations"]);
          const sx = sv(["EffectOfExchangeRateOnCashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "EffectOfExchangeRateOnCashAndCashEquivalents"]) ?? 0, sd = sv(["NetCashProvidedByUsedInDiscontinuedOperations"]) ?? 0;
          const sn = sv(["CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect", "CashAndCashEquivalentsPeriodIncreaseDecrease"]);
          return so != null && si != null && sf != null && sn != null ? sn - (so + si + sf + sx + sd) : null;
        })();
        if (secD != null && Math.abs(secD - d0) < 1) add("D", "현금흐름표 현금 증감 = 영업 + 투자 + 재무 + 환율", c, { status: PASS, note: `회사 공시 반올림 — SEC 사업연도 값으로도 순증감 − 구간 합 = ${secD}(앱과 같은 차이)${dsc ? ` · 중단사업 현금흐름 ${dsc} 포함` : ""}` });
        else eqD("현금흐름표 현금 증감 = 영업 + 투자 + 재무 + 환율", nc, o + iv + fi + (fx ?? 0) + (dsc ?? 0), dsc ? `중단사업 현금흐름 ${dsc} 포함` : "");
      }
      const capex = f("cf:note:capex"), ppe = f("cf:투자활동 현금흐름:유형자산 취득"), fcf = f("cf:note:fcf");
      if (capex != null && ppe != null) eqD("현금흐름표 CAPEX = −유형자산 취득", capex, -ppe);
      if (fcf != null && o != null && capex != null) eqD("현금흐름표 FCF = 영업현금흐름 − CAPEX", fcf, o - capex);
    }
  }
  // ── 판관비·연구개발비 A층(--metric=sga, 2026-09-28 — 지표 미종결) ────────────────────────────────────────────────────────
  // 기대값 = 검증기가 공시 원본에서 따로 판독한 본표 판관비·연구개발비 성격 줄 합(secFaceSga). 연간·분기(3개월, Q4 = 사업연도 − 9개월)·LTM
  // (20-F 는 연간만 — 원통화 × H.10). 빈칸 기대: 성격 줄 없음 → "본표에 줄 없음", 구성 공시 간 줄 구성 다름(합도 다름) → "기준 혼합",
  // 금융사 → 해당 없음, 회사별 제외(DAL 판관비 — 오너 결정) → 그 사유. 여러 줄이면 하위 줄 = SEC 줄 값(값 모음 대조)·하위 줄 합 = 판관비 행(D층).
  const sgaExp = new Map(); // 열("2025Y"·"LTM") → 판독 결과 { sga, rnd, others } — F층 원인 규칙용
  const SGA_ROW = { sga: /^\(−\) 판매관리비(\s|\(|$)/, rnd: /^\(−\) 연구개발비(\s|\(|$)/ };
  const SGA_NM = { sga: "판관비", rnd: "연구개발비" };
  for (const k of ["sga", "rnd"]) {
    const row = isItem(is, SGA_ROW[k]);
    for (const [c, v] of Object.entries(row?.values ?? {})) { (IS[lab(c)] ??= {})[k] = v; if (v == null && String(row?.cellNotes?.[c] ?? "").includes(SGA_NOLINE)) IS[lab(c)][`${k}NoLine`] = true; }
  }
  if (SGA_MODE && (!foreign || natCur)) {
    const subRows = (stmt, k) => stmt?.sections?.flatMap((s) => s.items ?? []).filter((x) => (x.accountId ?? "").startsWith(`is:${k}:`)) ?? [];
    const fin = (stmt, tag) => {
      // 금융사(SIC 6000~6499·은행 레이아웃) — 판관비·연구개발비 해당 없음. 행이 있으면 빈칸 + "금융사" 사유여야 한다
      for (const k of ["sga", "rnd"]) {
        const row = isItem(stmt, SGA_ROW[k]);
        if (!row) { add("A", `${tag}${SGA_NM[k]} 빈칸 = 금융사 해당 없음`, "-", { status: NA, note: `금융사(SIC ${sic}${bank ? " · 은행 레이아웃" : ""}) — 손익계산서에 ${SGA_NM[k]} 행 없음(해당 없음)`, app: null, src: null }); continue; }
        for (const [key, v] of Object.entries(row.values ?? {})) {
          const why = String(row.cellNotes?.[key] ?? "");
          add("A", `${tag}${SGA_NM[k]} 빈칸 = 금융사 해당 없음`, key.replace(/^현재\/LTM$/, "LTM"), v != null ? { status: FAIL, note: `금융사(SIC ${sic}) — 해당 없음인데 앱 값 ${v}`, app: v, src: null }
            : /금융사/.test(why) ? { status: NA, note: `금융사 — 해당 없음(앱 사유 "${why}")`, app: null, src: null }
            : { status: FAIL, note: `금융사 — 앱 빈칸인데 사유 "금융사" 없음(${why || "사유 없음"})`, app: null, src: null });
        }
      }
    };
    const judgeS = (kind, col, key, E, isQ4, stmt) => {
      const q = kind === "Q", pre = q ? "분기 " : "", sfx = !q ? "" : isQ4 ? "(Q4 = 사업연도 − 9개월)" : "(3개월)";
      const e0 = !sgaFace ? null : kind === "FY" ? sgaFace.annualAt(E) : kind === "LTM" ? sgaFace.ltmAt(E) : sgaFace.quarterAt(E, isQ4);
      if (e0 && kind !== "Q") sgaExp.set(col, e0);
      // 20-F — 원통화 본표 × 기간 평균 환율(연준 H.10, 검증기가 따로 받은 값)
      let fx = 1, fxNote = "";
      if (foreign && e0) {
        const pend = fxPendingWhy(fxRows, e0.end);
        const avg = pend ? null : fxRows ? fxAvg(fxRows, e0.start, e0.end) : null;
        if (pend || avg == null) { if (!pend) hardErrors.push(`판관비 기간 평균 환율 없음(${e0.start}~${e0.end})${fxErr ? `: ${fxErr}` : ""}`); fx = null; fxNote = pend ?? "환율 없음"; }
        else { fx = avg; fxNote = ` · 원통화(${natCur}) × 기간 평균 환율 ${avg.toPrecision(6)}${fxWin(e0.start, e0.end)}`; }
      }
      for (const k of ["sga", "rnd"]) {
        const nm = SGA_NM[k], name = `${pre}${nm} 앱 = SEC 본표 ${nm} 성격 줄 합${sfx}`;
        const row = isItem(stmt, SGA_ROW[k]);
        const app = row?.values?.[key] ?? null, why = String(row?.cellNotes?.[key] ?? "");
        if (!row) { add("A", name, col, { status: FAIL, note: `앱 손익계산서에 "(−) ${nm === "판관비" ? "판매관리비" : nm}" 행 없음`, app: null, src: null }); continue; }
        // 회사별 제외(오너 결정) — 빈칸 + 그 사유
        if (k === "sga" && SGA_EXCLUDE[sym]) {
          const cm = `공통모드(회사별 예외 — ${sym} 판관비 제외, 오너 결정 2026-09-28)`;
          add("A", `${pre}판관비 빈칸 = 회사별 제외${sfx}`, col, app != null ? { status: FAIL, note: `${sym} 판관비 제외(오너 결정)인데 앱 값 ${app}`, app, src: null }
            : why.includes(SGA_EXCLUDE[sym]) ? { status: PASS, note: `앱 빈칸 + 사유 "${why}" · ${cm}`, app: null, src: null }
            : { status: FAIL, note: `${sym} 판관비 제외인데 앱 사유에 "${SGA_EXCLUDE[sym]}" 없음(${why || "사유 없음"})`, app: null, src: null });
          continue;
        }
        if (!sgaFace) { add("A", name, col, { status: NA, note: sgaWhy || "본표 판독 없음", app, src: null }); continue; }
        if (!e0) {
          // 연간·LTM 은 그 기간을 담은 공시까지 읽었으므로 검증불가(사유). 분기는 읽은 공시 범위 밖이면 검사를 만들지 않는다(분기 창 범위)
          if (!q) add("A", name, col, { status: NA, note: `기간 ${E} — 구성 공시 본표에서 기간을 찾지 못함${sgaFace.skipped.length ? ` · 판독 제외 공시 ${sgaFace.skipped.map((x) => x.txt).join(" · ")}` : ""}`, app, src: null });
          continue;
        }
        const e = e0[k];
        if (fx == null) { add("A", name, col, app == null ? { status: PASS, note: `${fxNote} — 앱 빈칸(대체 없음)` } : { status: FAIL, note: `${fxNote}인데 앱 값 ${app}` }); continue; }
        const cmWhy = [
          e.hows.includes("hint") ? SGA_HINTS[sym]?.why ?? "회사별 줄 지정" : "",
          e.hows.includes("own") ? "회사 고유 줄 — 라벨로 성격 판정" : "",
          e.loose ? "뿌리와 끊긴 줄 표시 순서 보충" : "",
        ].filter(Boolean);
        const cm = cmWhy.length ? ` · 공통모드(${cmWhy.join(" · ")})` : "";
        if (e.mix) {
          add("A", name, col, app != null ? { status: FAIL, note: `${nm} 줄 ${COGS_MIX} 열에 앱 값 ${app} — 빈칸이어야 함(한 열 = 한 기준) · ${e.mix}`, app, src: null }
            : why.includes(COGS_MIX) ? { status: PASS, note: `${nm} 줄 ${COGS_MIX} 확인 — 앱 빈칸 + 사유 · ${e.mix} · ${e.how}${cm}`, app: null, src: null }
            : { status: FAIL, note: `${nm} 줄 ${COGS_MIX}인데 앱 빈칸 사유에 "${COGS_MIX}" 없음(${why || "사유 없음"}) · ${e.mix}`, app: null, src: null });
          continue;
        }
        if (e.empty) {
          add("A", `${pre}${nm} 빈칸 = SEC ${SGA_NOLINE}${sfx}`, col, app != null ? { status: FAIL, note: `${e.how}인데 앱 값 ${app}`, app, src: null }
            : why.includes(SGA_NOLINE) ? { status: PASS, note: `앱 빈칸 + 사유 "${why}" · ${e.how}`, app: null, src: null }
            : { status: FAIL, note: `${e.how}인데 앱 빈칸 사유에 "${SGA_NOLINE}" 없음(${why || "사유 없음"})`, app: null, src: null });
          continue;
        }
        if (e.v == null) { add("A", name, col, { status: NA, note: `미결 — SEC 줄 값 없음(${e.missing.join("·")}) · 앱 ${app ?? `빈칸(${why || "사유 없음"})`} · ${e.how}`, app, src: null }); continue; }
        const r0 = vsSource(app, e.v * fx, EXACT, `${e.how}${e.same ? ` · ${e.same}` : ""}${cm}${fxNote}`);
        // 합 동일(구성 공시마다 줄 개념 다름) — 앱 칸 주석에 그 표시가 있어야 한다
        if (e.same && r0.status === PASS && !why.includes(SGA_SAME)) { r0.status = FAIL; r0.note = `값은 같으나 앱 칸 주석에 "${SGA_SAME}" 없음("${why}") · ${r0.note}`; }
        add("A", name, col, r0);
        // 하위 줄 — 여러 줄 합이고 구성이 한 가지인 열만 하위 줄 값이 있어야 한다(값 모음 대조 — 같은 이름 줄은 앱이 한 행으로 합친다)
        const appSubs = subRows(stmt, k).map((x) => x.values?.[key]).filter((v) => v != null);
        const expSubs = !e.same && e.lines.length >= 2 ? e.lines.map((t) => (t.v == null ? null : t.v * fx)) : [];
        const sn = `${pre}${nm} 하위 줄 앱 = SEC 본표 줄${sfx}`;
        if (expSubs.length) {
          const left = [...appSubs], miss = [];
          for (const x of expSubs) { const i = x == null ? -1 : left.findIndex((y) => foreign ? Math.abs(y - x) <= 1e-9 * Math.max(1, Math.abs(x)) : y === x); if (i < 0) miss.push(x); else left.splice(i, 1); }
          add("A", sn, col, !miss.length && !left.length ? { status: PASS, note: `하위 줄 ${expSubs.length}개 = ${e.lines.map((t) => `"${t.label}" ${t.v}`).join(" · ")}${cm}${fxNote}`, app: null, src: null }
            : { status: FAIL, note: `하위 줄 불일치 — SEC ${e.lines.map((t) => `"${t.label}" ${t.v}`).join(" · ")} / 앱 ${appSubs.join(" · ") || "없음"}(SEC 에 없는 앱 값 ${left.join("·") || "없음"}, 앱에 없는 SEC 값 ${miss.join("·") || "없음"})`, app: null, src: null });
          // D층 — 하위 줄 합 = 판관비 행(본표 소계가 줄 합과 반올림만큼 다르면 SEC 로 같은 차이가 재현될 때만 통과)
          if (app != null && appSubs.length >= 2) {
            const s = appSubs.reduce((t, v) => t + v, 0), d = app - s, dSec = e.tot ? e.v - e.lines.reduce((t, x) => t + (x.v ?? 0), 0) : 0;
            add("D", `${pre}${nm} = 하위 줄 합${sfx}`, col, (foreign ? Math.abs(d) <= 1e-9 * Math.abs(app) : d === 0) ? { status: PASS }
              : !foreign && dSec !== 0 && d === dSec ? { status: PASS, note: `본표 소계 ${e.v} − 줄 합 = ${dSec}(회사 공시 반올림) — 앱 차이와 같음` }
              : { status: FAIL, note: `${nm} ${app} ≠ 하위 줄 합 ${s} (차 ${d})` });
          }
        } else if (appSubs.length) {
          add("A", sn, col, { status: FAIL, note: `SEC ${e.same ? "구성 공시마다 줄 개념 다름(하위 줄 없음)" : "한 줄"}인데 앱 하위 줄 값 ${appSubs.join(" · ")}`, app: null, src: null });
        }
      }
    };
    if (sgaFinCo) { fin(is, ""); fin(isq, "분기 "); }
    else {
      // 앱 연도 열·분기 열을 담은 공시를 먼저 더 읽는다(최근 연차 3건·10-Q 4건 밖 — 과거 목록 파일까지)
      try {
        // 그 기간의 원 공시(보고일 = 열 결산일)도 읽는다 — 원 공시만 정밀값(decimals −3)을 싣고 비교 기간 재게시는 반올림(−5)인 경우(MRVL FY2022
        // 판관비 955,245,000 → 955,300,000) decimals 판본 판정에 원 공시가 있어야 한다(2026-09-28 — 검증기 결함 수정)
        const hasOrig = (E, re) => sgaFace.faces.some((f) => re.test(f.form) && dayDiff(f.report, E) <= 7);
        for (const per of is?.periods ?? []) if (per.label !== "현재/LTM" && per.endDate && sgaFace && (!sgaFace.annualAt(per.endDate) || !hasOrig(per.endDate, /^(10-K|20-F|40-F)$/))) await sgaFace.extend(per.endDate, "FY");
        if (!foreign) for (const p of isq?.periods ?? []) if (p.endDate && sgaFace && (!sgaFace.quarterAt(p.endDate, p.fiscalQuarter === 4) || !hasOrig(p.endDate, p.fiscalQuarter === 4 ? /^10-K$/ : /^10-Q$/))) await sgaFace.extend(p.endDate, p.fiscalQuarter === 4 ? "FY" : "Q");
      } catch (e) { hardErrors.push(`판관비 과거 공시 판독 실패: ${String(e).slice(0, 120)}`); }
      for (const per of is?.periods ?? []) {
        const key = per.label;
        if (key === "현재/LTM") { if (H.LTM && !foreign) judgeS("LTM", "LTM", key, H.LTM.date, false, is); continue; }
        if (per.endDate) judgeS("FY", key.replace(/^FY(\d{4})$/, "$1Y"), key, per.endDate, false, is);
      }
      if (!foreign) for (const p of isq?.periods ?? []) { qEndOf.set(p.label, p.endDate); if (p.endDate) judgeS("Q", p.label, p.label, p.endDate, p.fiscalQuarter === 4, isq); }
    }
  }

  // ── D. 손익 항등식 — 연간 전 열(감사 2026-09-25: LTM 만 보던 것을 확장). 매출총이익 = 매출 − 매출원가, 세전이익 = 영업이익 − 영업외손익.
  // 회사 공시값 자체가 반올림만큼 어기는 경우(GEV 형)는 SEC 10-K 값으로 같은 차이가 정확히 재현될 때만 검증불가·검토 목록(LTM 과 같은 규칙).
  // LTM 열은 아래 LTM 블록(SEC TTM 으로 같은 예외)
  {
    const isRows = is?.sections?.flatMap((s) => s.items ?? []) ?? [];
    const cv = (name, key) => isRows.find((x) => x.accountName === name)?.values?.[key] ?? null;
    const cogsTags = ["CostOfRevenue", "CostOfGoodsAndServicesSold"];
    for (const per of is?.periods ?? []) {
      if (per.label === "현재/LTM") continue;
      const key = per.label, col = key.replace(/^FY(\d{4})$/, "$1Y");
      // 매출원가·매출총이익 행은 이름 뒤 설명(합성 표기 등)까지 허용
      const rev = cv("매출액", key) ?? cv("순수익", key), cogs = isItem(is, COGS_ROW_RE)?.values?.[key] ?? null, gp = isItem(is, GP_ROW_RE)?.values?.[key] ?? null;
      if (rev == null || cogs == null || gp == null) continue;
      // --metric=cogs: 본표에 소계가 없어 합성한 열은 식이 만든 값 — 통과로 세지 않는다(CAT 형 검증 공백, A층 본표 대조가 대신)
      if (cogsSynth.has(`연간|${key}`)) continue; // 자명(합성) — 검사 안 만듦(A층 대조가 대신)
      let r0 = same(gp, rev - cogs);
      if (r0.status === FAIL && !foreign && per.endDate) {
        const at = (tags) => tags.map((t) => atEnd(ann(t), per.endDate)).find(Boolean) ?? null;
        const sRev = at(REV_TAGS), sCogs = at(cogsTags), sGp = at(["GrossProfit"]);
        const dApp = gp - (rev - cogs), dSec = sRev && sCogs && sGp ? sGp.val - (sRev.val - sCogs.val) : null;
        if (dSec != null && Math.abs(dApp - dSec) <= 0.5 && Math.abs(gp - sGp.val) <= 0.5) {
          r0 = { status: PASS, note: `원인 확인(회사 공시 자체) — SEC 10-K 매출총이익 ${sGp.val} − (매출 ${sRev.val} − 원가 ${sCogs.val}) = ${dSec}, 앱 차이 ${dApp} 와 같음(회사 공시 반올림)` };
          review.push({ item: `${col} 매출총이익 ≠ 매출 − 원가(회사 공시 자체)`, note: r0.note });
        }
      }
      add("D", "매출총이익 = 매출액 − 매출원가", col, r0);
    }
  }

  // ── D. fin 조립 항등식 불성립(architecture.md Gap.IDENTITY — 감사 2026-09-25) — 앱 손익계산서 응답의 finIssues.
  // 매출 줄이 걸린 불성립(그 열 매출을 앱이 비웠음)은 FAIL, 매출과 무관한 줄은 "다음 지표 미결" 검토 목록. BASIS_SHIFT 등 gaps 도 목록화
  {
    const fi = is?.finIssues ?? [];
    for (const q of fi) {
      if (q.rev?.length) add("D", "fin 조립 항등식(매출 경로)", q.col, { status: FAIL, note: `매출 줄이 걸린 조립 항등식 불성립 — 앱이 이 열 매출을 비움: ${q.rev.join("; ")}` });
      if (q.other?.length || q.gaps?.some((g) => g !== "IDENTITY"))
        review.push({ item: `${q.col} fin 조립 미결(다음 지표)`, note: `gaps[${(q.gaps ?? []).join("·")}]${q.other?.length ? ` · 매출 외 줄 항등식 불성립(매출 값 유지): ${q.other.join("; ")}` : ""}` });
    }
    if (is && !fi.some((q) => q.rev?.length)) add("D", "fin 조립 항등식(매출 경로)", "-", { status: PASS, note: fi.length ? `매출 경로 불성립 없음(미결 ${fi.length}열은 검토 목록)` : "미완전 열 없음" });
    // 항등식 미검증 열(매출 경로 식이 판정 불완전 — 앱은 매출 값을 둠) — 검토 목록이 아니라 A층 SEC 본표 직접 대조가 필수(재감사
    // 2026-09-25: 판정 불완전 예외가 틀린 매출을 숨김 — WDC 주입 재현). 화면에 없는 옛 열·분기 전부(finIssues 의 저장값·기간).
    // 대응값이 없으면 조용히 넘기지 않고 FAIL(외화 공시 연간 열은 원통화 × 기간 평균 환율로 대조, 분기·LTM 만 검증불가)
    for (const q of fi.filter((x) => x.unv?.length)) {
      const name = "항등식 미검증 열 매출 앱 = SEC 매출(직접 대조 필수)";
      const kind0 = q.col === "LTM" ? "LTM" : /^FY/.test(q.col) ? "FY" : /Q4$/.test(q.col) ? "Q4" : "Q";
      // 외화 공시(20-F) — SEC 본표 USD 매출이 없으니 표시 열과 같은 방식(원통화 공시값 × 기간 평균 환율, 부동소수 오차만)으로
      // 대조한다(재감사 2026-09-25: 값과 무관하게 검증불가로 넘겨 TSM FY2018 ×1.01 주입이 통과). 20-F 는 분기 원자료가 없어 Q·LTM 만 검증불가
      if (foreign) {
        if (kind0 !== "FY") { add("A", name, q.col, { status: NA, note: `20-F 분기 원자료 없음 · 미검증 식: ${q.unv.join("; ")}` }); continue; }
        const r = atEnd(natRev, q.end);
        if (!r) { add("A", name, q.col, { status: FAIL, note: `원통화 공시 매출 없음(${q.end}) — 미검증 열을 대조 없이 둘 수 없음 · 앱 ${q.v} · 미검증 식: ${q.unv.join("; ")}` }); continue; }
        const avg = fxRows ? fxAvg(fxRows, r.start, r.end) : null;
        if (avg == null && fxPendingWhy(fxRows, r.end)) { add("A", name, q.col, { status: FAIL, note: `${fxPendingWhy(fxRows, r.end)}인데 앱 값 ${q.v} — 다른 환율로 대체한 것으로 보임` }); continue; }
        if (avg == null) { hardErrors.push(`항등식 미검증 열 ${q.col} 기간 평균 환율 없음(${r.start}~${r.end})${fxErr ? `: ${fxErr}` : ""}`); continue; }
        add("A", name, q.col, vsSource(q.v, r.val * avg, EXACT, `원통화 ${r.val} ${natCur} × 기간 평균 환율 ${avg.toPrecision(6)}${fxWin(r.start, r.end)} · 미검증 식: ${q.unv.join("; ")}`));
        continue;
      }
      if (!revFace) { add("A", name, q.col, { status: FAIL, note: `SEC 본표 대조 불가(${revFaceWhy}) · 미검증 식: ${q.unv.join("; ")}` }); continue; }
      const kind = q.col === "LTM" ? "LTM" : /^FY/.test(q.col) ? "FY" : /Q4$/.test(q.col) ? "Q4" : "Q";
      try { await revFace.extend(q.end, kind); } catch (e) { hardErrors.push(`항등식 미검증 열 ${q.col} SEC 공시 추가 판독 실패: ${String(e).slice(0, 80)}`); }
      const e = kind === "FY" ? revFace.annualAt(q.end) : kind === "LTM" ? revFace.ltmAt(q.end) : revFace.quarterAt(q.end, kind === "Q4");
      add("A", name, q.col, e == null
        ? { status: FAIL, note: `SEC 본표 매출 대응값 없음(${q.start}~${q.end}) — 미검증 열을 대조 없이 둘 수 없음 · 앱 ${q.v} · 미검증 식: ${q.unv.join("; ")}` }
        : vsSource(q.v, e.v, EXACT, `${e.how} · 미검증 식: ${q.unv.join("; ")}`));
    }
  }

  // ── D. LTM 열 일관성(감사 결함 3 연계, 2026-09-25) — 인포맥스 분기로 LTM 손익 일부를 채우는 외화 공시(TSM·ASML·SPOT)에서
  // LTM 매출총이익(SEC 연말) < 영업이익(인포맥스 최근 4분기)처럼 기간이 다른 구성요소가 한 열에 섞였다.
  if (H.LTM) {
    const isRows = is?.sections?.flatMap((s) => s.items ?? []) ?? [];
    const lv = (name) => isRows.find((x) => x.accountName === name)?.values?.["현재/LTM"] ?? null;
    const rev = lv("매출액") ?? lv("순수익"), cogs = IS.LTM?.cogs ?? null, gp = IS.LTM?.gp ?? null, op = IS.LTM?.op ?? null, nonop = lv("(−) 영업외손익"), pt = IS.LTM?.pretax ?? null;
    if (gp != null && op != null) add("D", "LTM 매출총이익 ≥ 영업이익", "LTM", gp >= op ? { status: PASS } : { status: FAIL, note: `매출총이익 ${gp} < 영업이익 ${op} — 구성요소 기간이 섞였을 가능성` });
    // 합성 LTM 매출총이익의 항등식은 자명 — 검사 안 만듦(A층 대조가 대신, 2026-09-27)
    else if (rev != null && cogs != null && gp != null) {
      let r0 = same(gp, rev - cogs);
      // 회사 공시값 자체가 이 항등식을 반올림만큼 어기는 경우(GEV: 2025 상반기 매출 17,143 − 원가 13,828 = 3,315 인데 매출총이익 3,316
      // 태깅) — SEC TTM 으로 같은 차이가 정확히 재현되면 앱 결함이 아니라 공시 자체 불일치(검증불가·검토 목록)
      if (r0.status === FAIL && !foreign) {
        const tt = (tags) => tags.map((t) => secTtm(t)).find((t) => t && dayDiff(t.end, H.LTM.date) <= 7) ?? null;
        const sRev = tt(REV_TAGS), sCogs = tt(["CostOfRevenue", "CostOfGoodsAndServicesSold"]), sGp = tt(["GrossProfit"]);
        const dApp = gp - (rev - cogs), dSec = sRev && sCogs && sGp ? sGp.v - (sRev.v - sCogs.v) : null;
        if (dSec != null && Math.abs(dApp - dSec) <= 0.5 && Math.abs(gp - sGp.v) <= 0.5) {
          r0 = { status: PASS, note: `원인 확인(회사 공시 자체) — SEC TTM 매출총이익 ${sGp.v} − (매출 ${sRev.v} − 원가 ${sCogs.v}) = ${dSec}, 앱 차이 ${dApp} 와 같음(회사 공시 반올림)` };
          review.push({ item: "LTM 매출총이익 ≠ 매출 − 원가(회사 공시 자체)", note: r0.note });
        }
      }
      add("D", "LTM 매출총이익 = 매출액 − 매출원가", "LTM", r0);
    }
    if (op != null && nonop != null && pt != null) add("D", "LTM 세전이익 = 영업이익 − 영업외손익", "LTM", same(pt, op - nonop));
    // 구성요소 기준일 — 하이라이트 LTM 열·재무상태표 LTM 기말·ttm 손익 기간(~날짜)·ttm 재무상태표 스냅샷·재무제표 source 의 ~날짜
    const iso = (s) => (/(\d{4}-\d{2}-\d{2})/.exec(s ?? "") ?? [])[1] ?? null;
    const dates = {
      "하이라이트 LTM 열": H.LTM.date,
      "재무상태표 LTM 기말": bs?.periods?.find((p) => p.label === "현재/LTM")?.endDate ?? null,
      "ttm 손익 기간": iso(/~\s*(\d{4}-\d{2}-\d{2})/.exec(fetched.tt?.ttm?.periodLabel ?? "")?.[1]),
      "ttm 재무상태표 스냅샷": iso(fetched.tt?.ttm?.snapshot?.label),
      "손익계산서 source": iso(/~\s*(\d{4}-\d{2}-\d{2})/.exec(is?.source ?? "")?.[1]),
    };
    const got = Object.entries(dates).filter(([, d]) => d);
    if (got.length >= 2) {
      const bad = got.some(([, d]) => dayDiff(d, got[0][1]) > 7);
      add("D", "LTM 구성요소 기준일 동일", "LTM", bad ? { status: FAIL, note: got.map(([k, d]) => `${k} ${d}`).join(" · ") } : { status: PASS, note: got.map(([k, d]) => `${k} ${d}`).join(" · ") });
    }
    // 조정 행(영업외·기타 등)이 인포맥스 분기 구성요소와 다른 출처(SEC 연말)에서 온 경우 — 앱이 notes 에 적은 인포맥스 대상 행 목록으로 판정
    const imList = (h.notes ?? []).map((n) => /현재\/LTM 열 ([^=]+?) = 인포맥스/.exec(n)?.[1]).find(Boolean);
    if (imList) {
      const im = new Set(imList.split("·").map((x) => x.trim()));
      const adj = [["(−) 매출원가", "매출원가"], ["매출총이익", "매출총이익"], ["(−) 영업외손익", "영업외손익"], ["세전이익", "세전이익"], ["(−) 법인세비용", "법인세비용"], ["(−) 기타", "기타"]]
        .filter(([row, k]) => !im.has(k) && lv(row) != null).map(([, k]) => k);
      add("D", "LTM 조정 행 기간 = 구성요소 기간", "LTM", adj.length ? { status: FAIL, note: `인포맥스 분기 합 행(${[...im].join("·")})과 다른 출처의 행이 같은 LTM 열에 있음: ${adj.join("·")}` } : { status: PASS, note: `인포맥스 분기 합 행만(${[...im].join("·")})` });
    }
  }

  if (fyDebtCheck) add("A", "20-F FY 총차입금 앱 = SEC 본표 차입금 + 리스(규칙 재구현)", fyDebtCheck.col, fyDebtCheck.r);

  // ── A. 20-F LTM(Yahoo 분기) 독립 재계산(감사 M1, 2026-09-25) — 앱이 "LTM 열 = Yahoo 분기"라고 밝힌 외화 공시(TSM·ASML·SPOT)는
  // 검증기가 Yahoo 분기 재무 + 연준 H.10 일별 환율(검증기가 따로 받음)로 "최근 4개 분기 × 그 분기 평균 환율"(잔액은 최신 분기말 × 기말 환율)을 따로 계산해 정확 비교.
  // 분기 원천(Yahoo)이 앱과 같아 공통모드(환율은 H.10 독립) — 앱의 합산·환산 계산 오류를 잡는 검사이고 Yahoo 값 자체의 정합성은 보증하지 않는다.
  // 앱이 공란으로 둔 항목은 앱 notes 의 사유(Yahoo 연간 ≠ SEC FY)를 SEC 원본(검증기 판독)으로 따로 확인한다.
  const ltmYahooNote = (h.notes ?? []).find((n) => /LTM 열 = Yahoo 분기/.test(n));
  // 재감사 e-3: 20-F 인데 LTM 기준일이 사업연도말과 다르고 앱 각주(「LTM 열 = Yahoo 분기」)가 없으면 — 20-F LTM 검사가 통째로 사라지지 않게 실패
  if (foreign && H.LTM && !ltmYahooNote) {
    const fyC = Object.keys(H).filter((cc) => cc !== "LTM").sort((a, b) => H[a].date.localeCompare(H[b].date)).at(-1);
    if (!fyC || dayDiff(H.LTM.date, H[fyC].date) > 7) add("A", "20-F LTM 각주(LTM 열 = Yahoo 분기)", "LTM", { status: FAIL, note: `20-F 인데 LTM 기준일 ${H.LTM.date} ≠ 사업연도말 ${fyC ? H[fyC].date : "없음"}이고 앱 각주 「LTM 열 = Yahoo 분기」가 없음 — 20-F LTM 독립 재계산을 할 수 없음` });
  }
  /**
   * 재감사 e-1(2026-10-02): 앱이 회사 6-K 로 채운 값 전부(verify-row sixK — 각주의 「그 밖 N개 줄」 포함)를 검증기가 SEC 20-F 원본과 6-K 문서를 따로 읽어
   * 다시 계산한다(앱은 표 칸 판독, 검증기는 문서 글자 판독). 줄 선택: 라벨 = SEC 20-F 라벨 파일, 재무상태표는 연말 열 = SEC 값인 줄만, 현금흐름은 부호 반전 역할로 부호.
   * 다시 계산할 수 없는 기록은 실패(면제 없음)
   */
  const cfacts = f;
  // ── 검증기 SEC 원 개념 대응(재감사 13차 — 공란·0·근사·6-K·수준 보정의 SEC 개념을 앱 기록(ids)에서 가져오지 않는다).
  //   앱 us-gaap 개념 → SEC 원 개념 = 검증기가 받은 SEC companyfacts 에서 대응표 사본(IFRS_GROUPS_SNAPSHOT) 순서로 그 날짜 값이 있는 첫 묶음
  //   (앱 sourceIdsAt·srcIdsOf 와 같은 규칙의 재구현 — 공통모드). us-gaap 공시사(ASML)는 같은 이름. 앱 기록은 이 값과 대조만 한다
  //   companyfacts 에 최신 20-F 가 빠진 회사(TSM 2025 — 앱은 edgar-gapfill 로 인스턴스를 직접 읽는다)가 있어 그 날짜의 20-F 인스턴스(검증기 판독)도 함께 본다
  const ifrsNsC = cfacts?.facts?.["ifrs-full"] ?? {};
  const instCache = new Map();
  /** 그 날짜(±7일)의 정기공시 인스턴스(검증기 판독, filingAtDate). 조회 실패는 오류로 남기고 null */
  const instAt = async (d) => {
    if (!instCache.has(d)) instCache.set(d, filingAtDate(cik, sub, d).catch((e) => { hardErrors.push(`SEC 20-F 원본(${d}) 조회 실패: ${String(e).slice(0, 80)}`); return null; }));
    return await instCache.get(d);
  };
  const instHas = (inst, nm, kind) => !!inst && (kind === "bs" ? inst.facts : inst.durFacts).some((x) => x.id === `ifrs-full_${nm}` && !x.dims.length && (kind === "bs" || (Date.parse(x.end) - Date.parse(x.start)) / 864e5 > 300));
  const instNs = (inst, nm) => !!inst && [...inst.facts, ...inst.durFacts].some((x) => x.id === `ifrs-full_${nm}`);
  const hasAtC = (nm, kind, at) => Object.values(ifrsNsC[nm]?.units ?? {}).some((arr) => arr.some((e) => e.end === at && (kind === "bs" ? !e.start : !!e.start && (Date.parse(at) - Date.parse(e.start)) / 864e5 > 300)));
  /** 검증기가 정한 SEC 원 개념 [{ id, sign }] — kind bs(연말)·cf(1년 흐름), at = 그 날짜. single = 원소 하나짜리 묶음만(앱 bsDelta 규칙) */
  const secIdsOf = async (dst, kind, at, single = false) => {
    const inst = await instAt(at);
    const ifrsFiler = Object.keys(ifrsNsC).length > 0 || (!!inst && [...inst.facts, ...inst.durFacts].some((x) => x.id.startsWith("ifrs-full_")));
    if (!ifrsFiler) return [{ id: `us-gaap_${dst}`, sign: 1 }];
    const exists = (x) => !!ifrsNsC[x] || instNs(inst, x);
    const altPick = (el) => (typeof el === "string" ? (exists(el) ? el : null) : (el.find(exists) ?? null));
    for (const [d0, sum, sign] of IFRS_GROUPS_SNAPSHOT) {
      if (d0 !== dst || (single && !(sum.length === 1 && typeof sum[0] === "string"))) continue;
      const els = sum.map(altPick).filter((x) => x && (hasAtC(x, kind, at) || instHas(inst, x, kind)));
      if (els.length) return els.map((x) => ({ id: `ifrs-full_${x}`, sign }));
    }
    return [];
  };
  const idsKey = (ids) => (ids ?? []).map((x) => `${x.id}|${x.sign}`).sort().join(",");
  const idsTxt = (ids) => (ids ?? []).map((x) => `${x.sign < 0 ? "−" : ""}${x.id.replace(/^[a-z-]+_/, "")}`).join("+") || "없음";
  /** SEC 사업연도 흐름 값(원통화) — 검증기 대응 개념들의 20-F 인스턴스 값(보고 통화 — USD 편의 환산 제외), 없으면 companyfacts 20-F 최신 제출. 없으면 null */
  const secFlowFy = async (dst, E0) => {
    const ids = await secIdsOf(dst, "cf", E0);
    if (!ids.length) return null;
    const inst = await instAt(E0);
    const curCode = (u) => /^(?:u_)?(?:iso4217[_:]?)?([a-z]{3})$/i.exec(u ?? "")?.[1]?.toUpperCase() ?? null;
    const cnt = new Map();
    for (const x of inst?.durFacts ?? []) { const c0 = curCode(x.unit); if (c0) cnt.set(c0, (cnt.get(c0) ?? 0) + 1); }
    const rep = [...cnt].filter(([c0]) => c0 !== "USD").sort((a, b) => b[1] - a[1])[0]?.[0] ?? (cnt.has("USD") ? "USD" : null);
    let t = 0;
    for (const { id, sign } of ids) {
      const xi = inst?.durFacts.find((x) => x.id === id && !x.dims.length && curCode(x.unit) === rep && (Date.parse(x.end) - Date.parse(x.start)) / 864e5 > 300);
      let v = xi?.v ?? null;
      if (v == null) {
        const units = cfacts?.facts?.[id.slice(0, id.indexOf("_"))]?.[id.slice(id.indexOf("_") + 1)]?.units ?? {};
        const us = Object.keys(units).filter((u) => /^[A-Z]{3}$/.test(u));
        const pick = us.filter((u) => u !== "USD").length ? us.filter((u) => u !== "USD") : us;
        v = pick.flatMap((u) => units[u]).filter((x) => x.start && dayDiff(x.end, E0) <= 7 && (Date.parse(x.end) - Date.parse(x.start)) / 864e5 > 300 && /^20-F/.test(x.form ?? ""))
          .sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? ""))[0]?.val ?? null;
      }
      if (v == null) return null;
      t += sign * v;
    }
    return { v: t, ids };
  };
  /**
   * 재감사(2026-10-02): verify-row 의 LTM 항목 전부(최종 재무 데이터의 YAHOO-Q 항목 + 출처) — 앱이 따로 남긴 기록이 아니라 값 자체에 붙은 출처라
   * 값만 넣고 기록을 빠뜨릴 수 없다. 출처 없는 항목·다시 계산할 수 없는 항목은 실패. yRows = 검증기가 따로 받은 야후 분기
   */
  const checkLtmItems = async (yRows, qStartOf, last4) => {
    // verify-row ltm = { items(화면과 같은 선택 규칙으로 고른 LTM 값 + 고른 항목의 출처), gaps(사업연도 값은 있는데 LTM 이 빈 개념), sixKSource }
    const items = row?.ltm?.items ?? null, gaps = row?.ltm?.gaps ?? [], sixKSource = row?.ltm?.sixKSource ?? null;
    if (!items?.length) { add("A", "20-F LTM 항목 목록(verify-row)", "LTM", { status: FAIL, note: "verify-row 에 LTM 항목 목록 없음 — 독립 재계산 불가" }); return; }
    // 야후 연간 조회 실패는 오류(재감사 12차 ⑦ — 빈 목록으로 삼키면 공란 검사 ①이 조용히 꺼졌다)
    const ya = await (await yahoo()).fundamentalsTimeSeries(sym, { period1: "2018-01-01", type: "annual", module: "all" }, { validateResult: false })
      .catch((e) => { hardErrors.push(`20-F LTM 야후 연간 조회 실패: ${String(e).slice(0, 80)}`); return []; });
    const yaRows = ya.map((r) => ({ ...r, end: new Date(r.date).toISOString().slice(0, 10) }));
    const yv = (rec, k) => {
      if (!rec) return null;
      if (typeof k === "string") return k.includes("|") ? (k.split("|").map((x) => rec[x]).find((x) => x != null) ?? null) : (rec[k] ?? null);
      let t = 0;
      for (const x of k) { if (rec[x] == null) return null; t += rec[x]; }
      return t;
    };
    const yQ = (d) => yRows.find((r) => dayDiff(r.end, d) <= 7);
    const yAn = (d) => yaRows.find((r) => dayDiff(r.end, d) <= 7);
    // 앱 6-K 기록 형식으로(값은 기록이 아니라 실제 항목 값)
    const det = items.filter((x) => x.src?.via === "sixK").map((x) => ({ ...x.src.detail, usd: x.usd }));
    // 원본 조회 실패는 오류로도 남긴다(재감사 12차 ④ — null 로 삼키면 공란 판정에서 "줄 없음"과 구분되지 않았다)
    const fa = instAt;
    const shortId = (id) => id.replace(/^[a-z-]+_/, "");
    const latestFyEnd = [...det.map((x) => x.fyEnd), row?.ltm?.E].filter(Boolean).sort().at(-1);
    const labsOf = async (f0, id) => { const lf = latestFyEnd ? await fa(latestFyEnd) : null; return [...new Set([...(f0.labels.get(id) ?? []), ...(lf?.labels.get(id) ?? [])])]; };
    const negOf = async (f0, id) => { const lf = latestFyEnd ? await fa(latestFyEnd) : null; return new Set([...(f0.negLabels.get(id) ?? []), ...(lf?.negLabels.get(id) ?? [])].map((x) => x.toLowerCase())); };
    const expOf = new Map(); // `${concept}|${at}` → 검증기 기대값(USD) — 합성 개념 대조용
    const fyE = Object.keys(H).filter((cc) => cc !== "LTM").sort((a, b) => H[a].date.localeCompare(H[b].date)).at(-1);
    const secE = fyE ? await fa(H[fyE].date) : null;
    const secAt = async (ids, d0) => {
      const f0 = await fa(d0);
      let t = 0;
      for (const { id, sign } of ids) {
        let v = f0?.facts.find((x) => x.id === id && !x.dims.length)?.v;
        if (v == null) { const [ns0, nm0] = [id.slice(0, id.indexOf("_")), id.slice(id.indexOf("_") + 1)]; v = Object.values(cfacts?.facts?.[ns0]?.[nm0]?.units ?? {}).flat().filter((e) => !e.start && e.end === d0 && /^20-F/.test(e.form ?? "")).sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? ""))[0]?.val; }
        if (v == null) return null;
        t += sign * v;
      }
      return t;
    };
    for (const it of items.filter((x) => x.src?.via !== "sixK")) {
      const via = it.src?.via ?? "출처없음";
      const nm = `20-F LTM ${via} ${it.concept.replace(/^[a-z-]+_/, "")} @${it.at}`;
      const res = await (async () => {
        if (!it.src) return { status: FAIL, note: "LTM 항목에 출처 없음 — 값만 넣고 출처를 빠뜨림" };
        if (it.usd == null) return { status: FAIL, note: "흐름 LTM 조합 항목(사업연도·전기) 없음" };
        const s0 = it.src;
        // 야후 필드·부호·분기는 검증기가 정한다(재감사 12차 ② — 앱 기록 s0.y·s0.sign·s0.quarters 를 그대로 쓰면 앱이 필드를 바꿔도 통과했다).
        //   필드·부호 = 검증기 고정 사본(YAHOO_LTM_FIXED), 분기 = 검증기가 받은 야후 분기 최근 4개. 앱 기록이 다르면 실패
        let ym = null;
        if (s0.via === "yahoo" || s0.via === "yahooFlow" || s0.via === "yahooApprox") {
          ym = YAHOO_LTM_FIXED.get(it.concept);
          if (!ym) return { status: FAIL, note: `야후 대응 검증기 고정 사본에 없는 개념(앱 필드 ${JSON.stringify(s0.y)}) — 앱이 대응을 새로 만들었으면 사본 갱신` };
          if (JSON.stringify(s0.y) !== JSON.stringify(ym.y)) return { status: FAIL, note: `앱 야후 필드 ${JSON.stringify(s0.y)} ≠ 검증기 고정 사본 ${JSON.stringify(ym.y)} — 다른 야후 항목으로 채움` };
          if (s0.via === "yahooFlow" && s0.sign !== ym.sign) return { status: FAIL, note: `앱 부호 ${s0.sign} ≠ 검증기 고정 사본 ${ym.sign}` };
        }
        if ((s0.via === "yahooApprox" || s0.via === "zero" || s0.via === "debtApprox") && (!fyE || !s0.E || dayDiff(s0.E, H[fyE].date) > 7))
          return { status: FAIL, note: `앱 기록 연말 ${s0.E ?? "없음"} ≠ 최근 사업연도말 ${fyE ? H[fyE].date : "없음"}` };
        if (s0.via === "yahoo") {
          const v = yv(yQ(it.at), ym.y), r0 = fxEndRate(fxRows, it.at);
          if (v == null || r0 == null) return { status: FAIL, note: `야후 분기 ${JSON.stringify(ym.y)} ${it.at} 값${v == null ? "" : "(환율)"} 없음` };
          expOf.set(`${it.concept}|${it.at}`, v * r0);
          return vsSource(it.usd, v * r0, EXACT, `야후 분기 ${JSON.stringify(ym.y)} ${it.at} ${v} × 기말 H.10`);
        }
        if (s0.via === "yahooFlow") {
          const aq = s0.quarters ?? [];
          if (aq.length !== last4.length || aq.some((q, i) => dayDiff(q, last4[i]) > 7))
            return { status: FAIL, note: `앱 분기 ${aq.join("·") || "없음"} ≠ 검증기 야후 최근 4개 분기 ${last4.join("·")}` };
          let t = 0;
          for (const q of last4) {
            const v = yv(yQ(q), ym.y), r0 = fxAvg(fxRows, qStartOf(q), q);
            if (v == null || r0 == null) return { status: FAIL, note: `야후 분기 ${JSON.stringify(ym.y)} ${q} 값 또는 환율 없음` };
            t += ym.sign * v * r0;
          }
          let how = `야후 분기 ${last4.join("·")} ${JSON.stringify(ym.y)} × 분기 평균 H.10(필드·부호·분기 = 검증기 고정)`;
          if (s0.adj) {
            // 수준 보정 = (SEC 사업연도 − 야후 연간) × 사업연도 평균 환율 — 둘 다 검증기가 따로 읽는다
            // 감가상각 합산 보정은 재계산하지 않는다 — 명시적 실패(재감사 13차 ④)
            if (s0.adj.da) return { status: FAIL, note: "흐름 수준 보정(감가상각 합산) — 검증기 재계산 미구현(실패 유지)" };
            // SEC 원 개념 = 검증기 대응(앱 adj.ids 는 대조만 — 이중 기록으로 부풀려도 통과하던 문제, D7)
            const want = fyE ? await secIdsOf(it.concept, "cf", H[fyE].date) : [];
            if (!want.length) return { status: FAIL, note: `수준 보정 — 검증기 대응으로 SEC 사업연도 원 개념을 못 정함(앱 기록 ${idsTxt(s0.adj.ids)})` };
            if (idsKey(want) !== idsKey(s0.adj.ids)) return { status: FAIL, note: `앱 수준 보정 원 개념 ${idsTxt(s0.adj.ids)} ≠ 검증기 대응 ${idsTxt(want)}` };
            const fy0 = secE?.durFacts.filter((x) => x.id === want[0].id && !x.dims.length && (Date.parse(x.end) - Date.parse(x.start)) / 864e5 > 300)[0];
            let secV = 0;
            for (const { id, sign } of want) { const x = secE?.durFacts.find((z) => z.id === id && !z.dims.length && (Date.parse(z.end) - Date.parse(z.start)) / 864e5 > 300); if (!x) return { status: FAIL, note: `수준 보정 SEC 사업연도 ${id} 없음` }; secV += sign * x.v; }
            const yA = yv(yAn(fy0?.end ?? ""), ym.y), rF = fy0 ? fxAvg(fxRows, fy0.start, fy0.end) : null;
            if (yA == null || rF == null) return { status: FAIL, note: "수준 보정 야후 연간 또는 환율 없음" };
            // 앱 사업연도 값(verify-row fy)과도 대조 — 보정에 쓴 SEC 값이 앱 사업연도 열과 같은 값이어야 한다
            const appFy = row?.ltm?.fy?.[it.concept]?.v ?? null;
            if (appFy == null || Math.abs(appFy - secV * rF) > 1e-9 * Math.max(Math.abs(appFy), Math.abs(secV * rF), 1))
              return { status: FAIL, note: `수준 보정 SEC 사업연도 ${secV} × ${rF} = ${secV * rF} ≠ 앱 사업연도 값 ${appFy ?? "없음"}` };
            t += (secV - ym.sign * yA) * rF;
            how += ` + (SEC 사업연도 ${secV} − 야후 연간 ${ym.sign * yA}) × 사업연도 평균`;
          }
          expOf.set(`${it.concept}|${it.at}`, t);
          return vsSource(it.usd, t, EXACT, how);
        }
        if (s0.via === "yahooApprox" || s0.via === "debtApprox") {
          const yk = s0.via === "debtApprox" ? "totalDebt" : ym.y;
          let secN = null;
          if (s0.via === "yahooApprox") {
            // SEC 연말 원 개념 = 검증기 대응(앱 s0.ids 는 대조만, 재감사 13차 ②)
            const want = await secIdsOf(it.concept, "bs", s0.E);
            if (idsKey(want) !== idsKey(s0.ids)) return { status: FAIL, note: `앱 변동분 근사 원 개념 ${idsTxt(s0.ids)} ≠ 검증기 대응 ${idsTxt(want)}` };
            secN = want.length ? await secAt(want, s0.E) : null;
          }
          else { const fyDebt = rowOf(bs, "총차입금")?.[fyE] ?? null, rE0 = fxEndRate(fxRows, s0.E); secN = fyDebt != null && rE0 ? fyDebt / rE0 : null; }
          const yE0 = yv(yQ(s0.E), yk) ?? yv(yAn(s0.E), yk), yA0 = yv(yQ(it.at), yk), r0 = fxEndRate(fxRows, it.at);
          if (secN == null || yE0 == null || yA0 == null || r0 == null) return { status: FAIL, note: `변동분 근사 재계산 불가 — SEC 연말 ${secN ?? "없음"}·야후 ${yE0 ?? "없음"}→${yA0 ?? "없음"}` };
          const e0 = (secN + (yA0 - yE0)) * r0;
          expOf.set(`${it.concept}|${it.at}`, e0);
          return vsSource(it.usd, e0, EXACT, `${s0.via === "debtApprox" ? "앱 연말 총차입금(A층 별도 대조)" : "SEC 연말"} ${secN} + 야후 변동 ${yE0} → ${yA0} × 기말 H.10`);
        }
        if (s0.via === "zero") {
          // SEC 연말 원 개념 = 검증기 대응(앱 s0.ids 를 비워 SEC 값이 있는 비지배지분을 0 으로 만들면 통과하던 문제, D5b)
          const want = await secIdsOf(it.concept, "bs", s0.E);
          if (idsKey(want) !== idsKey(s0.ids)) return { status: FAIL, note: `앱 0 규칙 원 개념 ${idsTxt(s0.ids)} ≠ 검증기 대응 ${idsTxt(want)}` };
          const v = want.length ? await secAt(want, s0.E) : 0;
          if (v !== 0 && v != null) return { status: FAIL, note: `0 규칙인데 SEC 연말 ${v}` };
          expOf.set(`${it.concept}|${it.at}`, 0);
          return vsSource(it.usd, 0, EXACT, `SEC 연말 ${v == null ? "줄 없음" : 0} → 분기말 0(EV 구성요소)`);
        }
        return { status: FAIL, note: `알 수 없는 출처 ${via}` };
      })().catch((e) => ({ status: FAIL, note: `재계산 오류 ${String(e).slice(0, 80)}` }));
      add("A", nm, "LTM", res);
    }
    // 기준 줄 확인형(bsNote1)은 기준 줄(다른 6-K 항목)의 기대값이 먼저 있어야 한다 — 합성 개념과 함께 뒤로
    const detRank = (k) => (k === "derived" ? 2 : k === "bsNote1" ? 1 : 0);
    det.sort((a, b) => detRank(a.kind) - detRank(b.kind));
    /** 6-K 기록 하나의 기대값 — { exp, how } 또는 판정 행(실패·검증불가) */
    const sixKExp = async (d) => {
      try {
        // 합성 개념(derived)은 여기서 계산하지 않는다 — 구성 줄을 검증기 고정 규칙으로 정해야 해서 사업연도 완결성 블록(synthExp) 뒤에서 따로(재감사 12차 ①)
        if (d.kind === "derived") return { status: FAIL, note: "합성 개념 — 고정 구성 규칙 판정 전(내부 순서 오류)" };
        const f = await fa(d.fyEnd);
        if (!f) return { status: FAIL, note: `SEC 20-F(${d.fyEnd}) 원본 판독 실패` };
        const text = await sixKDocText(cik, d.report);
        if (!text) return { status: FAIL, note: `6-K 문서 판독 실패(${d.report})` };
        if (!d.ids?.length) return { status: FAIL, note: "원 개념 기록 없음" };
        // 원 개념 = 검증기 대응(재감사 13차 ③ — 매입채무에 비유동부채 원 개념을 기록해도 그 줄로 다시 계산해 통과했다, D6).
        //   감가상각 합계 개념은 앱이 보고서 줄이 있는 형제 개념의 원 개념을 같이 쓴다(같은 금액의 다른 이름 — flowSixK) — 형제 중 하나와 같으면 인정
        {
          const kd = d.kind === "cf" || d.kind === "cfZero" ? "cf" : "bs";
          const cands = DA_SIBLINGS.includes(d.concept) ? DA_SIBLINGS : [d.concept];
          const wants = [];
          // bsNote1 은 앱이 최근 사업연도말(E) 기준 원 개념을 쓴다(srcIdsOf) — 그 날짜로 대응
          for (const c of cands) { const w = await secIdsOf(c, kd, d.kind === "bsNote1" ? row.ltm.E : d.fyEnd, d.kind === "bsDelta"); if (w.length) wants.push(w); }
          if (!wants.some((w) => idsKey(w) === idsKey(d.ids)))
            return { status: FAIL, note: `앱 6-K 원 개념 ${idsTxt(d.ids)} ≠ 검증기 대응 ${wants.map(idsTxt).join(" / ") || "없음"}(${shortId(d.concept)})` };
        }
        if (d.kind === "cf" || d.kind === "cfZero") {
          let tot = 0;
          const notes = [];
          const priorEnd = new Date(Date.UTC(Number(d.at.slice(0, 4)) - 1, Number(d.at.slice(5, 7)), 0)).toISOString().slice(0, 10);
          for (const { id, sign } of d.ids) {
            const fy0 = f.durFacts.filter((x) => x.id === id && !x.dims.length && (Date.parse(x.end) - Date.parse(x.start)) / 864e5 > 300)[0];
            if (!fy0) return { status: FAIL, note: `SEC 20-F 사업연도 ${shortId(id)} 없음` };
            const fyStart = fy0.start, nextDay = new Date(Date.parse(d.fyEnd) + 864e5).toISOString().slice(0, 10);
            const rF = fxAvg(fxRows, fyStart, d.fyEnd), rC = fxAvg(fxRows, nextDay, d.at), rP = fxAvg(fxRows, fyStart, priorEnd);
            if (rF == null || rC == null || rP == null) return { status: FAIL, note: "환율 없음" };
            const labs = await labsOf(f, id), neg = await negOf(f, id);
            // 현금흐름표 구간만 — 제목 뒤 4천 자 안에 "operating activities" 가 있는 첫 제목 ~ 주석 시작(목차·주석 표의 같은 이름 줄 제외)
            let cs0 = -1;
            for (const h0 of text.matchAll(/statements? of cash flows?/g)) if (text.slice(h0.index, h0.index + 4_000).includes("operating activities")) { cs0 = h0.index; break; }
            if (cs0 < 0) return { status: FAIL, note: `6-K 현금흐름표 구간 못 찾음(${d.report})` };
            const ce1 = text.slice(cs0 + 200).search(/notes to (?:the )?(?:interim )?(?:condensed )?(?:consolidated|summary)/);
            const cfText = text.slice(cs0, ce1 < 0 ? undefined : cs0 + 200 + ce1);
            // 현금흐름 줄 = 가장 가까운 열 머리가 "… months ended" 인 줄(같은 구간의 재무상태표 슬라이드 줄 제외 — ASML 분기별 재무상태표)
            //   슬라이드 문서(§§ 구분 3개 이상)는 그 줄이 든 슬라이드에 "months ended" 가 있고 "total assets" 가 없어야 한다(머리가 표 중간에 있다 — ASML)
            const cfHd = [...cfText.matchAll(/months ended/g)].map((m) => m.index), bsHd = sixKBsHeaders(cfText).map((h) => h.i);
            const slides = cfText.split("§§").length > 3;
            const slideOf = (i) => { const a0 = cfText.lastIndexOf("§§", i), b1 = cfText.indexOf("§§", i); return cfText.slice(a0 < 0 ? 0 : a0, b1 < 0 ? undefined : b1); };
            const rows0 = sixKRows(cfText, labs).filter((r) => {
              if (slides) { const sl = slideOf(r.i); return /months ended/.test(sl) && !/total assets/.test(sl); }
              const c0 = cfHd.filter((i) => i < r.i).at(-1) ?? -1, b0 = bsHd.filter((i) => i < r.i).at(-1) ?? -1;
              return c0 > b0;
            });
            if (d.kind === "cfZero") {
              if (fy0.v !== 0) return { status: FAIL, note: `0 규칙인데 SEC 사업연도 ${shortId(id)} = ${fy0.v}` };
              const hd0 = rows0.filter((r) => /months ended/.test(cfText.slice(Math.max(0, r.i - 20_000), r.i + 20_000)));
              if (hd0.length) return { status: FAIL, note: `0 규칙인데 6-K 에 "${hd0[0].label}" 줄 있음` };
              notes.push(`${shortId(id)} 사업연도 0·분기 현금흐름표에 줄 없음`);
              continue;
            }
            // 열 — "… months ended <날짜들> … 연도 연도" 중 가장 가까운 머리, 누적 2열(4개면 뒤 2개)
            const yC = d.at.slice(0, 4), yP = priorEnd.slice(0, 4);
            const cands = [];
            for (const r of rows0) {
              let nums = r.nums;
              if (nums.length === 3 && Number.isInteger(nums[0]) && nums[0] > 0 && nums[0] < 100 && !/,/.test(r.toks[0])) nums = nums.slice(1);
              if (nums.length !== 2 && nums.length !== 4) continue;
              const lo = Math.max(0, r.i - 20_000), win = cfText.slice(lo, r.i + 20_000);
              const ys = [...win.matchAll(/months ended[^0-9]{0,200}?(?:[a-z]{3,9}\.? \d{1,2},?[\s‖]*)+[^0-9]{0,80}?(20\d\d)[\s‖]+(20\d\d)/g)].sort((a, b) => Math.abs(lo + a.index - r.i) - Math.abs(lo + b.index - r.i))[0];
              if (!ys || ![yC, yP].includes(ys[1]) || ![yC, yP].includes(ys[2]) || ys[1] === ys[2]) continue;
              const pair = nums.length === 4 ? nums.slice(2) : nums;
              const unit = sixKUnitAt(text, cs0 + r.i);
              if (!unit) continue;
              const isNeg = neg.has(r.label.toLowerCase()) && !labs.some((x) => x.toLowerCase() === r.label.toLowerCase() && !neg.has(x.toLowerCase()));
              cands.push({ cur: (ys[1] === yC ? pair[0] : pair[1]) * unit, prior: (ys[1] === yC ? pair[1] : pair[0]) * unit, neg: isNeg, label: r.label });
            }
            let u = [...new Map(cands.map((c) => [`${c.cur}|${c.prior}|${c.neg}`, c])).values()];
            // 같은 라벨이 여러 번(취득·처분) — 지급 개념은 유출(음수) 묶음, 수취 개념은 유입(양수) 묶음만
            if (u.length > 1 && /Payment|Purchase|Acquir|Repayment/.test(id)) u = u.filter((c) => c.cur <= 0 && c.prior <= 0);
            else if (u.length > 1 && /Proceeds|Sale|Disposal|Receipt/.test(id)) u = u.filter((c) => c.cur >= 0 && c.prior >= 0);
            // absent = 문서는 읽었고 그 줄이 없음(공란 정당 사유는 이것뿐 — 재감사 12차 ④)
            if (u.length !== 1) return { status: FAIL, note: `6-K 현금흐름 "${labs[0] ?? shortId(id)}" 줄 ${u.length ? `${u.length}개 후보로 모호` : "못 찾음"}(${d.report})`, absent: !u.length };
            const c0 = u[0], xs = c0.neg ? -1 : 1;
            tot += sign * (fy0.v * rF + xs * c0.cur * rC - xs * c0.prior * rP);
            notes.push(`${shortId(id)}: SEC 사업연도 ${fy0.v} + 6-K "${c0.label}" 당기 ${xs * c0.cur} − 전기 ${xs * c0.prior}${c0.neg ? "(부호 반전 라벨)" : ""}`);
          }
          return { exp: tot, how: `${notes.join(" · ")} · ${natCur} × H.10 기간 평균` };
        }
        // 재무상태표
        const rAt = fxEndRate(fxRows, d.at);
        if (rAt == null) return { status: FAIL, note: "기말 환율 없음" };
        // 기준일 열 하나뿐인 주석 표(bsNote1, 재감사 14차 ②) — 연말 확인 대신 같은 표의 기준 줄이 검증기 기대값(기준 개념의 그 날짜 값)과 같아야 한다.
        //   표 = 대상 줄과 기준 줄이 2천 자 안에 함께 있는 곳, 두 줄 모두 숫자 하나. 줄 머리가 아닌 곳의 같은 단어("non-current"·"total lease liabilities")는 같은 라벨로 보지 않는다
        if (d.kind === "bsNote1") {
          if (d.ids.length !== 1 || !d.anchor?.concept || d.anchor.ids?.length !== 1) return { status: FAIL, note: "기준 줄 확인형 기록 형식 오류(원 개념·기준 줄 하나씩)" };
          const aw = await secIdsOf(d.anchor.concept, "bs", d.fyEnd);
          if (idsKey(aw) !== idsKey(d.anchor.ids)) return { status: FAIL, note: `기준 줄 원 개념 앱 ${idsTxt(d.anchor.ids)} ≠ 검증기 ${idsTxt(aw)}` };
          const aExp = expOf.get(`${d.anchor.concept}|${d.at}`);
          if (aExp == null) return { status: FAIL, note: `기준 줄 ${shortId(d.anchor.concept)} @${d.at} 검증기 기대값 없음` };
          const aOrig = aExp / rAt;
          // 줄(칸) 머리에서 시작하는 라벨만 — 앞에 다른 단어가 붙은 줄("Total lease liabilities", "Non-current")은 같은 라벨로 보지 않는다
          const solo = (r) => r.nums.length === 1 && /^[\s‖]*$/.test(text.slice(text.lastIndexOf("\n", r.i) + 1, r.i + 1));
          const rowsT = sixKRows(text, await labsOf(f, d.ids[0].id)).filter(solo);
          const rowsA = sixKRows(text, await labsOf(f, d.anchor.ids[0].id)).filter(solo);
          const vals = new Set();
          for (const rt of rowsT) {
            const u0 = sixKUnitAt(text, rt.i);
            if (!u0) continue;
            if (rowsA.some((ra) => ra.i !== rt.i && Math.abs(ra.i - rt.i) < 2_000 && Math.abs(ra.nums[0] * u0 * d.anchor.ids[0].sign - aOrig) < 0.5 * u0)) vals.add(rt.nums[0] * u0);
          }
          if (vals.size !== 1) return { status: FAIL, note: `주석 표(기준 줄 ${shortId(d.anchor.concept)} ${aOrig}) 안 "${shortId(d.ids[0].id)}" 줄 ${vals.size ? `${vals.size}개 후보로 모호` : "못 찾음"}(${d.report})`, absent: !vals.size };
          const v0 = [...vals][0] * d.ids[0].sign;
          return { exp: v0 * rAt, how: `6-K 주석 표 "${shortId(d.ids[0].id)}" ${d.at} ${v0}(같은 표 기준 줄 ${shortId(d.anchor.concept)} = 검증기 기대값 ${aOrig}) · ${natCur} × 기말 H.10 ${d.at}` };
        }
        const hds = sixKBsHeaders(text);
        const cfHeads = [...text.matchAll(/months ended/g)].map((m) => m.index);
        let tot = 0;
        const notes = [];
        for (const { id, sign } of d.ids) {
          let fyF = f.facts.find((x) => x.id === id && !x.dims.length);
          if (!fyF) {
            const [ns0, nm0] = [id.slice(0, id.indexOf("_")), id.slice(id.indexOf("_") + 1)];
            const cf0 = Object.values(cfacts?.facts?.[ns0]?.[nm0]?.units ?? {}).flat().filter((e) => !e.start && e.end === d.fyEnd && /^20-F/.test(e.form ?? "")).sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? ""))[0];
            if (cf0) fyF = { id, v: cf0.val, dims: [], from: `companyfacts ${cf0.form} ${cf0.filed}` };
          }
          if (!fyF) return { status: FAIL, note: `SEC 20-F ${d.fyEnd} ${shortId(id)} 없음` };
          const labs = await labsOf(f, id);
          const rows0 = sixKRows(text, labs).map((r) => {
            const hd = hds.filter((x) => x.i < r.i && r.i - x.i < 60_000 && x.dates.includes(d.fyEnd)).at(-1);
            // 가장 가까운 열 머리가 현금흐름표("… months ended")면 재무상태표 줄이 아니다(SPOT "Repayment of exchangeable notes")
            if (hd && cfHeads.some((ci) => ci > hd.i && ci < r.i)) return null;
            const cols = hd ? sixKBsCols(r, hd) : null;
            const unit = sixKUnitAt(text, r.i);
            return hd && cols && unit ? { r, hd, cols: cols.map((x) => x * unit) } : null;
          }).filter(Boolean);
          const unitOf = (v) => { let u0 = 1; const a = Math.abs(Math.round(v)); while (u0 < 1e6 && a !== 0 && a % (u0 * 10) === 0) u0 *= 10; return u0; };
          const eqFy = (x) => [1, -1].some((sg) => Math.abs(sg * x.cols[x.hd.dates.indexOf(d.fyEnd)] - fyF.v) < unitOf(fyF.v) + Math.abs(fyF.v) * 1e-9);
          if (d.kind === "bsZero") {
            if (fyF.v !== 0) return { status: FAIL, note: `0 규칙인데 SEC ${shortId(id)} 연말 ${fyF.v}` };
            const has = rows0.filter((x) => x.hd.dates.includes(d.at) && x.cols[x.hd.dates.indexOf(d.at)] !== 0 && x.cols[x.hd.dates.indexOf(d.fyEnd)] === 0);
            if (has.length) return { status: FAIL, note: `0 규칙인데 6-K 재무상태표에 "${has[0].r.label}" 연말 0·기준일 ${has[0].cols[has[0].hd.dates.indexOf(d.at)]} 줄 있음` };
            notes.push(`${shortId(id)} 연말 0·기준일 값 있는 줄 없음`);
            continue;
          }
          if (d.kind === "bsDelta") {
            const u = rows0.filter((x) => x.hd.dates.includes(d.at));
            const uq = [...new Map(u.map((x) => [`${x.cols[x.hd.dates.indexOf(d.at)]}|${x.cols[x.hd.dates.indexOf(d.fyEnd)]}`, x])).values()];
            if (uq.length !== 1) return { status: FAIL, note: `변동분 근사 "${labs[0] ?? shortId(id)}" 줄 ${uq.length}개(${d.report})`, absent: !uq.length };
            const x = uq[0], vE = x.cols[x.hd.dates.indexOf(d.fyEnd)], vA = x.cols[x.hd.dates.indexOf(d.at)];
            tot += sign * (fyF.v + (vA - vE));
            notes.push(`${shortId(id)}: SEC 연말 ${fyF.v} + 6-K 변동(${vE} → ${vA})`);
            continue;
          }
          const ok = rows0.filter((x) => x.hd.dates.includes(d.at) && eqFy(x));
          const uq = [...new Map(ok.map((x) => [`${x.cols[x.hd.dates.indexOf(d.at)]}|${x.cols[x.hd.dates.indexOf(d.fyEnd)]}`, x])).values()];
          if (uq.length !== 1) return { status: FAIL, note: `6-K 재무상태표 "${labs[0] ?? shortId(id)}" 연말 열 = SEC ${fyF.v} 인 줄 ${uq.length}개(${d.report})`, absent: !uq.length };
          const x = uq[0], sg = Math.abs(x.cols[x.hd.dates.indexOf(d.fyEnd)] - fyF.v) < unitOf(fyF.v) + Math.abs(fyF.v) * 1e-9 ? 1 : -1;
          tot += sign * sg * x.cols[x.hd.dates.indexOf(d.at)];
          notes.push(`${shortId(id)}: 6-K "${x.r.label}" ${d.at} ${sg * x.cols[x.hd.dates.indexOf(d.at)]}(연말 열 = SEC ${fyF.v})`);
        }
        return { exp: tot * rAt, how: `${notes.join(" · ")} · ${natCur} × 기말 H.10 ${d.at}` };
      } catch (e) { return { status: FAIL, note: `재계산 오류 ${String(e).slice(0, 80)}` }; }
    };
    const derivedDets = det.filter((d) => d.kind === "derived");
    for (const d of det.filter((x) => x.kind !== "derived")) {
      const r = await sixKExp(d);
      if (r.exp != null) expOf.set(`${d.concept}|${d.at}`, r.exp);
      add("A", `20-F LTM 6-K ${d.kind} ${shortId(d.concept)} @${d.at}`, "LTM", r.exp != null ? vsSource(d.usd, r.exp, EXACT, r.how) : r);
    }
    // 완결성(재감사 P5) — 앱이 비운 LTM(사업연도 값 있음)을 검증기가 6-K 에서 찾으면 실패(채울 수 있었음). 6-K 에도 없거나 판정 불가면 공란 정당
    /** 1년 전 분기 6-K 보고서("6-K 접수번호 문서") — 분기말 at 뒤 120일 안 6-K(최대 8건) 중 큰 문서부터, 재무상태표 머리에 at·prevE 가 함께 있는 첫 문서 */
    const prevRep = new Map();
    const prevSixKReport = async (at, prevE) => {
      const k = `${at}|${prevE}`;
      if (prevRep.has(k)) return prevRep.get(k);
      const rc = sub.filings?.recent ?? {};
      const hi = new Date(Date.parse(at) + 120 * 864e5).toISOString().slice(0, 10);
      let out = { report: null, why: `${at} 뒤 120일 안 6-K 없음` };
      const cands = [];
      for (let i = 0; i < (rc.form ?? []).length && cands.length < 8; i++) if (rc.form[i] === "6-K" && rc.filingDate[i] > at && rc.filingDate[i] <= hi) cands.push(rc.accessionNumber[i]);
      outer: for (const accn of cands) {
        out = { report: null, why: `6-K ${cands.length}건에 ${at}·${prevE} 재무상태표 없음` };
        const items0 = (await secJson(`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn.replace(/-/g, "")}/index.json`)).directory.item;
        for (const d0 of items0.filter((x) => /\.htm$/i.test(x.name) && !/-index/i.test(x.name) && Number(x.size) > 15_000).sort((a, b) => Number(b.size) - Number(a.size)).slice(0, 6)) {
          const rep = `6-K ${accn} ${d0.name}`;
          const t0 = await sixKDocText(cik, rep);
          if (t0 && sixKBsHeaders(t0).some((h) => h.dates.includes(at) && h.dates.includes(prevE))) { out = { report: rep, why: null }; break outer; }
        }
      }
      prevRep.set(k, out);
      return out;
    };
    let gapOk = 0;
    const gapNa = [];
    // 앱 6-K 조회 실패 경고(verify-row fetchWarnings) — 공란 판정에서 "줄 없음"으로 보지 않는다
    const sixKFetchFail = (row?.ltm?.fetchWarnings ?? []).find((w) => /6-K[^"]*조회 실패/.test(w)) ?? null;
    const derivedGaps = [];
    for (const g of gaps) {
      const gname = `20-F LTM 공란 ${g.kind} ${shortId(g.concept)} @${g.at}`;
      // 공란 기록의 규칙(야후 필드·부호·현금흐름 여부·SEC 원 개념)은 검증기가 정한다 — 앱 기록(g.flow·g.cf·g.ids)은 대조만(재감사 13차 ①, P11:
      //   이자비용 부호를 뒤집어 "정의 차이" 공란을 만들어도 앱 부호로 판정해 통과했다)
      const E0 = row.ltm.E;
      const ymG = g.kind === "cf" && YAHOO_LTM_FLOW.has(g.concept) ? YAHOO_LTM_FIXED.get(g.concept) : null;
      const flowW = ymG ? { y: ymG.y, sign: ymG.sign, da: DA_SIBLINGS.includes(g.concept) } : null;
      const idsW = await secIdsOf(g.concept, "bs" === g.kind ? "bs" : "cf", E0);
      const cfW = g.kind === "cf" ? isCfFixed(g.concept) : null;
      const flowApp = g.flow ? { y: g.flow.y, sign: g.flow.sign, da: !!g.flow.da } : null;
      const bad = [
        JSON.stringify(flowApp) !== JSON.stringify(flowW) ? `흐름 규칙 앱 ${JSON.stringify(flowApp)} ≠ 검증기 ${JSON.stringify(flowW)}` : null,
        idsKey(g.ids) !== idsKey(idsW) ? `SEC 원 개념 앱 ${idsTxt(g.ids)} ≠ 검증기 ${idsTxt(idsW)}` : null,
        g.kind === "cf" && !!g.cf !== cfW ? `현금흐름 개념 여부 앱 ${!!g.cf} ≠ 검증기 ${cfW}` : null,
      ].filter(Boolean);
      if (bad.length) { add("A", gname, "LTM", { status: FAIL, note: `앱 LTM 공란 기록이 검증기 규칙과 다름 — ${bad.join(" · ")}` }); continue; }
      // 본표 합성 개념(…Derived)은 SEC 원 개념이 없다 — 검증기 고정 구성 규칙(synthExp)이 생긴 뒤 구성 줄 기준일 값으로 따로 판정(기준일·1년 전 모두)
      if (/Derived$/.test(g.concept)) {
        if (g.at !== row.ltm.through && sixKFetchFail) { add("A", gname, "LTM", { status: FAIL, note: `앱 1년 전 분기말 공란 — 6-K 조회 실패 경고(${sixKFetchFail})` }); continue; }
        derivedGaps.push(g); continue;
      }
      // 1년 전 분기말 공란(평균 잔액 기초 값 — 재감사 13차 ⑦) — 기준일 값의 출처 규칙으로 판정
      if (g.at !== row.ltm.through) {
        if (sixKFetchFail) { add("A", gname, "LTM", { status: FAIL, note: `앱 1년 전 분기말 공란 — 6-K 조회 실패 경고(${sixKFetchFail})로 값이 빠졌을 수 있음` }); continue; }
        const cur = items.find((x) => x.concept === g.concept && x.at === row.ltm.through)?.src ?? null;
        const ymB = YAHOO_LTM_FIXED.get(g.concept);
        const yP = ymB ? yv(yQ(g.at), ymB.y) : null;
        if (cur?.via === "zero") { add("A", gname, "LTM", { status: FAIL, note: "기준일 0 규칙 개념인데 1년 전 분기말 공란(앱 규칙상 0)" }); continue; }
        if ((cur?.via === "yahoo" || cur?.via === "yahooApprox" || cur?.via === "debtApprox") && (cur.via === "debtApprox" ? yv(yQ(g.at), "totalDebt") : yP) != null) {
          add("A", gname, "LTM", { status: FAIL, note: `기준일 야후 출처(${cur.via})인데 야후 ${g.at} 값 있음 — 1년 전 분기말 채울 수 있음` }); continue;
        }
        if (cur?.via === "sixK" && cur.detail?.report) {
          const r1 = await sixKExp({ concept: g.concept, kind: "bs", at: g.at, ids: idsW, report: cur.detail.report, fyEnd: cur.detail.fyEnd ?? E0, usd: null });
          if (r1.exp != null) { add("A", gname, "LTM", { status: FAIL, note: `앱 1년 전 분기말 공란인데 6-K(${cur.detail.report})에 값 ${r1.exp} — 채울 수 있음` }); continue; }
          if (!r1.absent) { add("A", gname, "LTM", { status: FAIL, note: `앱 1년 전 분기말 공란 — 6-K 판정 불가: ${r1.note}` }); continue; }
          // 이번 보고서에 없으면 1년 전 분기 6-K(검증기가 앱과 같은 규칙 — 분기말 뒤 120일 안 6-K 중 재무상태표 머리에 그 분기말·전년 사업연도말이
          // 있는 문서 — 로 직접 찾음, 재감사 14차 ①). 못 찾으면 실패, 찾으면 본표(연말 확인)·주석 표(기준 줄 확인) 두 규칙으로 판정
          const prevE0 = new Date(Date.UTC(Number(E0.slice(0, 4)) - 1, Number(E0.slice(5, 7)), 0)).toISOString().slice(0, 10);
          let pr;
          try { pr = await prevSixKReport(g.at, prevE0); }
          catch (e) { hardErrors.push(`1년 전 분기 6-K 조회 실패: ${String(e).slice(0, 80)}`); add("A", gname, "LTM", { status: FAIL, note: `앱 1년 전 분기말 공란 — 1년 전 분기 6-K 조회 실패로 판정 불가` }); continue; }
          if (!pr.report) { add("A", gname, "LTM", { status: FAIL, note: `앱 1년 전 분기말 공란 — 검증기도 1년 전 분기 6-K 를 못 찾음(${pr.why})${row?.ltm?.sixKPrevMiss ? ` · 앱 사유: ${row.ltm.sixKPrevMiss}` : ""} — 판정 불가` }); continue; }
          const idsP = await secIdsOf(g.concept, "bs", prevE0);
          const r2 = await sixKExp({ concept: g.concept, kind: "bs", at: g.at, ids: idsP, report: pr.report, fyEnd: prevE0, usd: null });
          if (r2.exp != null) { add("A", gname, "LTM", { status: FAIL, note: `앱 1년 전 분기말 공란인데 1년 전 6-K(${pr.report})에 값 ${r2.exp} — 채울 수 있음${row?.ltm?.sixKPrevMiss ? ` · 앱 사유: ${row.ltm.sixKPrevMiss}` : ""}` }); continue; }
          if (!r2.absent) { add("A", gname, "LTM", { status: FAIL, note: `앱 1년 전 분기말 공란 — 1년 전 6-K 판정 불가: ${r2.note}` }); continue; }
          // 주석 표(기준일 열 하나) — 그 날짜 6-K 로 채운 다른 개념을 기준 줄로
          let noteHit = null;
          for (const a0 of items.filter((x) => x.at === g.at && x.src?.via === "sixK" && x.concept !== g.concept && expOf.has(`${x.concept}|${g.at}`))) {
            const r3 = await sixKExp({ concept: g.concept, kind: "bsNote1", at: g.at, ids: idsW, report: pr.report, fyEnd: prevE0, usd: null, anchor: { concept: a0.concept, ids: await secIdsOf(a0.concept, "bs", prevE0) } });
            if (r3.exp != null) { noteHit = { r3, a0 }; break; }
          }
          if (noteHit) { add("A", gname, "LTM", { status: FAIL, note: `앱 1년 전 분기말 공란인데 1년 전 6-K 주석 표에 값 ${noteHit.r3.exp} — 채울 수 있음 · ${noteHit.r3.how}` }); continue; }
          gapOk++;
          continue;
        }
        add("A", gname, "LTM", { status: NA, note: `앱 1년 전 분기말 공란 — 기준일 출처 ${cur?.via ?? "없음"}, 야후에 1년 전 값 없음` });
        continue;
      }
      // ① 야후로 채울 수 있었는가(앱 규칙: 야후 최근 4개 분기가 다 있고 야후 연간이 SEC 사업연도와 5% 안이면 채운다 — 검증기 고정 필드·부호·원 개념으로)
      //    세전이익·이자비용은 SEC 영업이익 개념이 없으면(세전이익 기반 합성) 앱 규칙상 공란
      const opAbsent = /^IncomeLossFromContinuingOperationsBeforeIncomeTaxes|^Interest(Expense|AndDebtExpense)/.test(g.concept) && !(await secIdsOf("OperatingIncomeLoss", "cf", E0)).length;
      if (flowW && !flowW.da && idsW.length && !opAbsent) {
        const fy0 = secE?.durFacts.find((x) => x.id === idsW[0].id && !x.dims.length && (Date.parse(x.end) - Date.parse(x.start)) / 864e5 > 300);
        let secV = fy0 ? 0 : null;
        for (const { id, sign } of idsW) { const x = secE?.durFacts.find((z) => z.id === id && !z.dims.length && (Date.parse(z.end) - Date.parse(z.start)) / 864e5 > 300); if (!x) { secV = null; break; } secV += sign * x.v; }
        const yA = fy0 ? yv(yAn(fy0.end), flowW.y) : null;
        const qOk = last4.length === 4 && last4.every((q) => yv(yQ(q), flowW.y) != null);
        if (secV != null && yA != null && qOk && Math.abs(secV - flowW.sign * yA) <= Math.abs(secV) * 0.05) {
          add("A", gname, "LTM", { status: FAIL, note: `앱 LTM 공란${g.reason ? `(${g.reason})` : ""}인데 야후 최근 4개 분기가 다 있고 야후 연간 ${flowW.sign * yA} ≈ SEC 사업연도 ${secV}(5% 안, 검증기 고정 필드·부호) — 채울 수 있음` });
          continue;
        }
      }
      // ② 6-K 에서 찾을 수 있는가 — 재무상태표와 현금흐름표 개념만(손익 개념을 현금흐름 조정 줄로 찾지 않는다 — SPOT "Finance costs")
      if (g.kind === "cf" && !cfW) { gapOk++; continue; }
      // 6-K 가 없거나 원 개념이 없으면 판정 불가 — 실패(재감사 12차 ③: "대조 불가"를 통과 요약에 숨기면 6-K 조회 실패로 값이 사라져도 0 실패였다)
      if (!sixKSource || !idsW.length) {
        gapNa.push(`${shortId(g.concept)}(${!sixKSource ? "6-K 없음" : "원 개념 없음"})`);
        add("A", gname, "LTM", { status: FAIL, note: `앱 LTM 공란 — ${!sixKSource ? `앱이 쓴 6-K 보고서 없음${row?.ltm?.sixKMiss ? `(앱 사유: ${row.ltm.sixKMiss})` : ""}` : "SEC 원 개념 기록 없음"} — 6-K 로 채울 수 있었는지 판정 불가` });
        continue;
      }
      const r = await sixKExp({ concept: g.concept, kind: g.kind, at: g.at, ids: idsW, report: sixKSource, fyEnd: row.ltm.E, usd: null });
      if (r.exp != null) add("A", gname, "LTM", { status: FAIL, note: `앱 LTM 공란${g.reason ? `(${g.reason})` : ""}인데 6-K 에서 기대값 ${r.exp} — 채울 수 있음 · ${r.how}` });
      // 정당한 공란 = 문서를 읽었고 그 줄이 없음(absent)뿐(재감사 12차 ④). 모호·조회/판독 실패·환율 없음·재계산 오류는 판정 불가 — 실패,
      //   조회·판독·환율 실패는 오류(종료코드 1)로도 남긴다
      else if (r.absent) gapOk++;
      else {
        if (!/모호/.test(r.note ?? "")) hardErrors.push(`20-F LTM 공란 판정 불가(${shortId(g.concept)}): ${r.note ?? "사유 없음"}`);
        add("A", gname, "LTM", { status: FAIL, note: `앱 LTM 공란 — 6-K ${/모호/.test(r.note ?? "") ? "판독 모호" : "판정 불가"}로 채울 수 있는지 알 수 없음: ${r.note}` });
      }
    }
    /** 6-K 합성 개념(derived) 기대값 — 아래 사업연도 블록에서 검증기 고정 구성 규칙(synthExp)을 만든 뒤 정해진다. 못 만들면 null(전부 실패) */
    let derivedEval = null, derivedGapEval = null;
    // 사업연도 완결성(재감사 7차 E1·E3) — "있어야 할 값"을 앱 데이터가 아니라 검증기가 읽은 SEC 20-F 원본으로 정한다.
    //   20-F 인스턴스의 차원 없는 통화 값(연말 잔액·1년 흐름, 0 아님) 각각에 대해 그 값을 받는 앱 개념(IFRS 대응표, us-gaap 공시사는 같은 이름)이
    //   앱 사업연도 값에 하나도 없으면 실패. 원천이 하나뿐인 단순 대응은 값도 정확 대조(원통화 × H.10 — 잔액 기말, 흐름 기간 평균)
    {
      const fyRaw = row?.ltm?.fy ?? null, appGroups = row?.ltm?.ifrsGroups ?? null;
      // 대응표 = 검증기 고정 사본(scripts/lib/ifrs-groups-snapshot.json — 앱 edgar-foreign.ts ifrsDstGroups() 를 2026-10-03 에 떠 둔 것).
      // 앱 대응표가 사본과 다르면 실패(대응을 지워 값이 사라지는 경로 — 재감사 8차 ④). 대응표를 고치면 사본도 같이 고친다
      const gkey = (g) => `${g.dst}|${g.sign}|${JSON.stringify(g.sum)}`;
      // 순서도 비교한다(재감사 9차 (가) — 대체 후보 순서가 바뀌면 앱이 고르는 정의가 바뀐다)
      const groups = IFRS_GROUPS_SNAPSHOT.map(([dst, sum, sign]) => ({ dst, sum, sign }));
      if (appGroups) {
        const appK = new Set(appGroups.map(gkey)), snapK = new Set(groups.map(gkey));
        const lost = groups.filter((g) => !appK.has(gkey(g))), extra = appGroups.filter((g) => !snapK.has(gkey(g)));
        const orderOk = appGroups.length === groups.length && appGroups.every((g, i) => gkey(g) === gkey(groups[i]));
        if (!lost.length && !extra.length && !orderOk) add("A", "20-F 대응표 순서 = 검증기 사본", "LTM", { status: FAIL, note: "앱 대응표 묶음 순서가 검증기 사본과 다름 — 대체 후보 우선순위가 바뀜(의도한 변경이면 사본 갱신)" });
        add("A", "20-F 대응표 = 검증기 사본", "LTM", !lost.length && !extra.length
          ? { status: PASS, note: `IFRS 대응 묶음 ${groups.length}개 일치` }
          : { status: FAIL, note: `앱 대응표가 검증기 사본과 다름 — 빠짐 ${lost.map(gkey).join("; ") || "없음"} / 추가 ${extra.map(gkey).join("; ") || "없음"} (의도한 변경이면 사본 갱신)` });
      }
      const fyApp = fyRaw ? Object.fromEntries(Object.entries(fyRaw).map(([k0, x]) => [k0, x?.v ?? null])) : null;
      const fyKind = fyRaw ? Object.fromEntries(Object.entries(fyRaw).map(([k0, x]) => [k0, x?.k ?? null])) : {};
      if (!fyApp || !appGroups || !secE) add("A", "20-F 사업연도 완결성(SEC 20-F 원본)", "LTM", { status: FAIL, note: `${!secE ? "SEC 20-F 원본 판독 실패" : "verify-row 에 사업연도 값·대응표 없음"} — 대조 불가` });
      else {
        // 보고 통화 단위 = 인스턴스에서 가장 많이 쓴 통화 단위(단위 이름이 "twd"·"eur"·"iso4217_TWD" 등 회사마다 다르다). USD 편의 환산 값은 앱이 버리므로 대상 밖
        const curCode = (u) => /^(?:u_)?(?:iso4217[_:]?)?([a-z]{3})$/i.exec(u)?.[1]?.toUpperCase() ?? null;
        const cnt = new Map();
        for (const x of [...secE.facts, ...secE.durFacts]) { const c0 = curCode(x.unit); if (c0) cnt.set(c0, (cnt.get(c0) ?? 0) + 1); }
        const repCur = [...cnt].filter(([c0]) => c0 !== "USD").sort((a, b) => b[1] - a[1])[0]?.[0] ?? (cnt.has("USD") ? "USD" : null);
        const isCur = (u) => repCur != null && curCode(u) === repCur;
        const secFy = [
          ...secE.facts.filter((x) => !x.dims.length && isCur(x.unit)).map((x) => ({ ...x, kind: "bs" })),
          ...secE.durFacts.filter((x) => !x.dims.length && isCur(x.unit) && (Date.parse(x.end) - Date.parse(x.start)) / 864e5 > 300).map((x) => ({ ...x, kind: "cf" })),
        ];
        // 같은 개념이 같은 기간에 두 번 달리면(반올림 반복) 하나만
        const seen = new Set(), uniq = secFy.filter((x) => { const k = `${x.id}|${x.kind}`; if (seen.has(k)) return false; seen.add(k); return true; });
        const secOf = (nm, kind) => uniq.find((y) => y.id === `ifrs-full_${nm}` && y.kind === kind) ?? null;
        const rateOf = (x) => (repCur === "USD" ? 1 : x.kind === "bs" ? fxEndRate(fxRows, row.ltm.E) : fxAvg(fxRows, x.start, x.end));
        const dstsOf = (id) => {
          const ns = id.slice(0, id.indexOf("_")), nm = id.slice(id.indexOf("_") + 1);
          if (ns === "ifrs-full") return [...new Set(groups.filter((g) => g.sum.some((e) => (Array.isArray(e) ? e.includes(nm) : e === nm))).map((g) => g.dst))];
          if (ns === "us-gaap") return [nm];
          return [];
        };
        let okN = 0, noMap = 0;
        const needDst = new Map(); // 앱 개념 → 그 값을 만드는 SEC 원천이 있는 종류(bs·cf)
        for (const x of uniq) {
          const ds = dstsOf(x.id);
          if (!ds.length) { noMap++; continue; }
          // SEC 값 0 — 앱에 없어도 공란은 허용(0 표시와 공란은 화면 정책 문제), 앱에 있으면 아래 값 대조(기대 0)
          if (x.v === 0) { for (const d of ds) if (fyApp[d] != null && !needDst.has(d)) needDst.set(d, x.kind); continue; }
          const nm = `20-F 사업연도 ${x.kind === "bs" ? "연말" : "흐름"} ${shortId(x.id)} @${row.ltm.E}`;
          if (!ds.some((d) => fyApp[d] != null)) { add("A", nm, "LTM", { status: FAIL, note: `SEC 20-F 원본 ${x.id} = ${x.v} ${x.unit} 있는데 앱 사업연도 값 없음(받는 개념 ${ds.join("·")}) — 공란 사유와 무관하게 채워져야 함` }); continue; }
          okN++;
          for (const d of ds) needDst.set(d, x.kind);
        }
        // 값 대조(재감사 8차 ③ — 합산·대체 대응 포함): 앱 개념마다 대응 후보 묶음별 기대값 = 부호 × Σ(묶음 원소 — 배열 원소는 SEC 에 있는 첫 개념) × H.10.
        //   앱 값이 후보 기대값 중 하나와 정확히 같아야 통과(어느 후보를 쓰는지는 앱 순서 규칙 — 검증기는 "원본으로 만들 수 있는 값"인지만 본다)
        let valN = 0;
        for (const [d, kind] of needDst) {
          const nm = `20-F 사업연도 ${kind === "bs" ? "연말" : "흐름"} 값 ${d} @${row.ltm.E}`;
          const app = fyApp[d];
          if (app == null) continue;
          // 후보 순서 = 앱 변환 규칙(edgar-foreign mapIfrs): us-gaap 같은 이름 원본 → 단순 대응(표 순서, 그 기간 값이 있는 첫 개념) → 합산 묶음(첫 묶음) → 부호 반전.
          //   검증기는 그 순서에서 처음 성립하는 후보 하나와만 대조한다(재감사 9차 (가) — "후보 중 하나와 같음"은 정의 바꿔치기를 통과시켰다)
          const cands = [];
          if (uniq.some((y) => y.id === `us-gaap_${d}` && y.kind === kind)) { const y = uniq.find((z) => z.id === `us-gaap_${d}` && z.kind === kind); const r0 = rateOf(y); if (r0 != null) cands.push({ v: y.v * r0, how: `us-gaap_${d} ${y.v} × ${r0}` }); }
          const ordered = [
            ...groups.filter((g0) => g0.dst === d && g0.sign > 0 && g0.sum.length === 1 && typeof g0.sum[0] === "string" && IFRS_MAP_LIKE(g0)),
            ...groups.filter((g0) => g0.dst === d && g0.sign > 0 && !IFRS_MAP_LIKE(g0)),
            ...groups.filter((g0) => g0.dst === d && g0.sign < 0),
          ];
          for (const g of ordered) {
            let t = 0, n = 0, r0 = null;
            const parts = [];
            for (const e of g.sum) {
              const x = (Array.isArray(e) ? e : [e]).map((nm0) => secOf(nm0, kind)).find(Boolean);
              if (!x) continue;
              const r = rateOf(x);
              if (r == null) { n = -1; break; }
              t += x.v; n++; r0 = r; parts.push(`${shortId(x.id)} ${x.v}`);
            }
            if (n > 0) cands.push({ v: g.sign * t * r0, how: `${g.sign < 0 ? "−" : ""}(${parts.join(" + ")}) × H.10 ${kind === "bs" ? "기말" : "기간 평균"} ${r0}` });
          }
          if (!cands.length) { add("A", nm, "LTM", { status: FAIL, note: `앱 ${app} — SEC 원본으로 기대값을 만들 수 없음(환율 없음 등)` }); continue; }
          valN++;
          const first = cands[0];
          add("A", nm, "LTM", extEq(app, first.v)
            ? { status: PASS, note: `앱 ${app} = SEC 20-F ${first.how} (정확 일치 — 앱 순서 규칙의 첫 후보)`, app, src: first.v }
            : { status: FAIL, note: `앱 ${app} ≠ 앱 순서 규칙의 첫 후보 ${first.v} [${first.how}]${cands.length > 1 ? ` · 나머지 후보 ${cands.slice(1).map((c0) => `${c0.v} [${c0.how}]`).join(" / ")}` : ""}`, app, src: first.v });
        }
        // 앱 사업연도 값(0 아님) 전체 — 위 값 대조에 들지 않은 개념은 SEC 원본에 원천이 없는 값(재감사 9차 (나)·10차 — 대응표 밖 개념에 값을 만드는 경로).
        //   예외는 앱 합성 개념뿐이고 각자 규칙으로 대조한다: …Unified(영업이익 단일 시계열) = 앱 영업이익(위에서 SEC 대조),
        //   …FaceDerived(본표 합성 줄) = SEC 원본 연말 값 하나 또는 두 값의 합 × H.10 기말(정확 일치 — edgar-yahoo-quarters 본표 합성 규칙)
        const bsSec = uniq.filter((y) => y.kind === "bs" && y.v !== 0);
        const rBs = repCur === "USD" ? 1 : fxEndRate(fxRows, row.ltm.E);
        let orphanN = 0, synthN = 0;
        const near = (a0, b0) => Math.abs(a0 - b0) <= 1e-9 * Math.max(Math.abs(a0), Math.abs(b0)) || (a0 === 0 && b0 === 0);
        // 합성 개념 구성 규칙 — 검증기 고정(재감사 11차: "아무 SEC 값 하나·두 값 합 / 대조 통과 개념 부분합"은 정의 바꿔치기를 통과시켰다).
        //   부모 연결 = 20-F 재무상태표 계산 구조(검증기 판독). 유동·비유동 = 조상 노드 이름
        const parentOf = new Map();
        for (const [fr, ks] of secE.kids) for (const k0 of ks) if (!parentOf.has(k0)) parentOf.set(k0, fr);
        const sideOf = (id) => {
          for (let x = id, i = 0; x && i < 12; x = parentOf.get(x), i++) {
            const n0 = shortId(x);
            if (/Noncurrent|NonCurrent/.test(n0) && /Liabilit/.test(n0)) return "nc";
            if (/^(LiabilitiesCurrent|CurrentLiabilities)$/.test(n0)) return "cur";
            if (/^(AssetsCurrent|CurrentAssets)$/.test(n0)) return "curA";
          }
          return null;
        };
        const unitRe0 = new RegExp(`^(?:u_)?(?:iso4217[_:]?)?${repCur}$`, "i");
        const exDebt = expectedForeignDebt(secE, unitRe0);
        const synthExp = (d) => {
          if (rBs == null) return { v: null, why: "H.10 기말 환율 없음" };
          if (d === "DebtFaceDerived") {
            if (!exDebt) return { v: null, why: "SEC 본표 차입금 판독 불가" };
            return { v: exDebt.sum * rBs, ids: exDebt.parts.filter((x) => x.kind !== "note").map((x) => ({ id: x.id, v: x.v })), how: `SEC 20-F 본표 차입금 + 리스(${exDebt.parts.map((x) => `${x.what} ${shortId(x.id)} ${x.v}`).join(" + ")}) × H.10 기말 ${rBs}` };
          }
          if (d === "DebtFaceNoncurrentDerived") {
            if (!exDebt) return { v: null, why: "SEC 본표 차입금 판독 불가" };
            const nc = [];
            for (const x of exDebt.parts) {
              if (x.kind === "note") continue;
              if (x.kind === "face") { const sd = sideOf(x.id); if (sd === "nc") nc.push(x); else if (sd == null) return { v: null, why: `본표 차입금 줄 ${shortId(x.id)} 의 유동·비유동 판정 불가` }; continue; }
              if (x.kind === "nonLease" || (x.kind === "finLease" && /Noncurrent/.test(x.id))) { nc.push(x); continue; }
              if (x.kind === "curLease" || (x.kind === "finLease" && /Current$/.test(x.id))) continue;
              // 주석 금융리스 합계만 있는 경우(ASML) — 비유동 = 합계 − 주석 유동분(없으면 0). 미국 규칙(edgar-bs-structure)과 같은 정의
              if (x.kind === "finLease" && x.id === "us-gaap_FinanceLeaseLiability") { nc.push({ ...x, v: x.v - (exDebt.v0("us-gaap_FinanceLeaseLiabilityCurrent") ?? 0) }); continue; }
              return { v: null, why: `리스 구성(${x.kind}) 유동·비유동 판정 불가` };
            }
            return { v: nc.reduce((t, x) => t + x.v, 0) * rBs, ids: nc.map((x) => ({ id: x.id, v: x.v })), how: `SEC 20-F 비유동 차입금·리스 줄(${nc.map((x) => `${shortId(x.id)} ${x.v}`).join(" + ") || "없음 — 0"}) × H.10 기말 ${rBs}` };
          }
          if (d === "ShortTermInvestmentsFaceDerived") {
            const re = /ShortTermInvestments|CurrentInvestments|MarketableSecuritiesCurrent|AvailableForSaleSecuritiesDebtSecuritiesCurrent|ShorttermDeposits|CurrentFinancialAssets(AtAmortisedCost|AtFairValue)/;
            const ls = bsSec.filter((y) => re.test(y.id) && secE.faceIds.has(y.id) && sideOf(y.id) === "curA");
            return { v: ls.reduce((t, y) => t + y.v, 0) * rBs, ids: ls.map((y) => ({ id: y.id, v: y.v })), how: `SEC 20-F 유동자산 본표 단기투자 줄(${ls.map((y) => `${shortId(y.id)} ${y.v}`).join(" + ") || "없음 — 0"}) × H.10 기말 ${rBs}` };
          }
          return null;
        };
        for (const [d, v] of Object.entries(fyApp)) {
          if (v == null || needDst.has(d)) continue;
          // 0 은 합성 개념만 대조(재감사 11차 — 합성 값을 0 으로 바꾸면 대조가 없었다). 그 밖의 0 은 원천 없음 대상 아님(값 없음과 같음)
          if (v === 0 && !/Face\w*Derived$|Unified$/.test(d)) continue;
          const kindNm = fyKind[d] === "bs" ? "연말" : "흐름";
          if (/Unified$/.test(d)) {
            synthN++;
            const base = fyApp[d.replace(/Unified$/, "")];
            add("A", `20-F 사업연도 ${kindNm} 합성 ${d} @${row.ltm.E}`, "LTM", base != null && needDst.has(d.replace(/Unified$/, "")) && extEq(v, base)
              ? { status: PASS, note: `앱 ${v} = 앱 ${d.replace(/Unified$/, "")}(SEC 대조 통과 개념)` }
              : { status: FAIL, note: `앱 합성 ${v} ≠ SEC 대조된 ${d.replace(/Unified$/, "")} ${base ?? "없음"}` });
            continue;
          }
          if (/Face\w*Derived$/.test(d) && fyKind[d] === "bs") {
            synthN++;
            const exp = synthExp(d);
            add("A", `20-F 사업연도 ${kindNm} 합성 ${d} @${row.ltm.E}`, "LTM", !exp || exp.v == null
              ? { status: FAIL, note: `앱 합성 값 ${v} — 검증기에 이 합성 개념의 구성 규칙이 없거나 SEC 원본으로 계산 불가${exp?.why ? `(${exp.why})` : ""}` }
              : near(v, exp.v)
                ? { status: PASS, note: `앱 ${v} = ${exp.how} (정확 일치)`, app: v, src: exp.v }
                : { status: FAIL, note: `앱 합성 값 ${v} ≠ ${exp.how} = ${exp.v}`, app: v, src: exp.v });
            continue;
          }
          orphanN++;
          add("A", `20-F 사업연도 ${kindNm} 원천 없음 ${d} @${row.ltm.E}`, "LTM", { status: FAIL, note: `앱 사업연도 값 ${v} 이 있는데 SEC 20-F 원본(${row.ltm.E})에 이 개념을 만드는 원천 값이 없음(대응표·같은 이름 모두 없음) — 출처 불명 값` });
        }
        // 합성 개념 완결성(재감사 12차 — 합성 항목을 지우면 검사도 사라졌다): 구성 규칙이 있는 합성 개념은 앱 값 유무와 관계없이 기대값을 계산하고,
        //   기대값이 0 이 아닌데 앱 사업연도 값이 없으면 실패. 대상 = 본표 차입금 두 개(모든 20-F), 본표 단기투자(us-gaap 공시사 — 앱 본표 판독이
        //   us-gaap 재무상태표만 읽는다)
        const usGaapFiler = uniq.some((y) => y.id.startsWith("us-gaap_")) && !uniq.some((y) => y.id.startsWith("ifrs-full_"));
        for (const d of ["DebtFaceDerived", "DebtFaceNoncurrentDerived", ...(usGaapFiler ? ["ShortTermInvestmentsFaceDerived"] : [])]) {
          if (fyApp[d] != null) continue;
          synthN++;
          const exp = synthExp(d);
          add("A", `20-F 사업연도 연말 합성 ${d} @${row.ltm.E}`, "LTM", !exp || exp.v == null
            ? { status: FAIL, note: `앱 합성 값 없음 — SEC 원본으로 기대값도 계산 불가${exp?.why ? `(${exp.why})` : ""}` }
            : exp.v === 0
              ? { status: PASS, note: `앱 합성 값 없음 · SEC 원본 기대값 0(${exp.how}) — 없음과 같음` }
              : { status: FAIL, note: `앱 합성 값 없음인데 ${exp.how} = ${exp.v} — 있어야 할 값이 빠짐`, app: null, src: exp.v });
        }
        // 6-K LTM 합성 개념(재감사 12차 ① — 앱이 보낸 구성 줄 목록 d.parts 의 기대값 합만 보면 구성 줄을 빼고 목록에서도 빼면 통과했다):
        //   구성 줄 = 검증기 고정 규칙(synthExp — 20-F 본표 계산 구조) → 각 SEC 줄을 받는 앱 개념(대응표 사본·같은 이름). 앱 d.parts 가 이 구성과
        //   다르면(빠진 줄·규칙 밖 줄) 실패, 같으면 그 개념들의 기준일 기대값(검증기가 따로 계산한 값) 합과 대조
        derivedEval = (d) => {
          const exp = synthExp(d.concept);
          if (!exp || exp.v == null || !exp.ids) return { status: FAIL, note: `합성 개념 ${d.concept} — 검증기 고정 구성 규칙 없음 또는 SEC 원본으로 계산 불가${exp?.why ? `(${exp.why})` : ""}` };
          const parts = d.parts ?? [];
          // 연말 0 인 SEC 줄은 앱 판독이 구성 후보에서 빼므로(0 은 같은 줄 판정에 쓰지 않음) 대응 확인 대상에서 뺀다
          const comps = exp.ids.filter((x) => x.v !== 0);
          const unmapped = comps.filter((x) => !dstsOf(x.id).length);
          if (unmapped.length) return { status: FAIL, note: `검증기 구성 줄 ${unmapped.map((x) => shortId(x.id)).join(", ")} 을 받는 앱 개념이 대응표 사본에 없음 — 구성 대조 불가` };
          const want = new Set(comps.flatMap((x) => dstsOf(x.id)));
          const missing = comps.filter((x) => !dstsOf(x.id).some((dd) => parts.includes(dd)));
          const extra = parts.filter((p) => !want.has(p));
          const compTxt = comps.map((x) => `${shortId(x.id)}→${dstsOf(x.id).join("|")}`).join(", ");
          if (!parts.length || missing.length || extra.length)
            return { status: FAIL, note: `앱 구성 줄 ${parts.join(" + ") || "없음"} ≠ 검증기 고정 구성(${compTxt})${missing.length ? ` · 빠진 SEC 줄 ${missing.map((x) => shortId(x.id)).join(", ")}` : ""}${extra.length ? ` · 규칙 밖 줄 ${extra.join(", ")}` : ""}` };
          // 사업연도 확인 — 앱 구성 개념의 사업연도 값 합 = 검증기 기대값(같은 개념을 다른 정의로 바꿔 끼우는 경우)
          const fySum = parts.reduce((t, p) => (t == null || fyApp[p] == null ? null : t + fyApp[p]), 0);
          if (fySum == null || !near(fySum, exp.v)) return { status: FAIL, note: `앱 구성 줄 사업연도 값 합 ${fySum ?? "없음"} ≠ ${exp.how} = ${exp.v}` };
          const ex = parts.map((p) => expOf.get(`${p}|${d.at}`));
          if (ex.some((x) => x == null)) return { status: FAIL, note: `구성 줄 기대값 없음(${parts.filter((p, i) => ex[i] == null).join(", ")}) @${d.at}` };
          return { exp: ex.reduce((t, x) => t + x, 0), how: `검증기 고정 구성(${compTxt}) — 구성 개념 ${d.at} 기대값 합 ${parts.join(" + ")}` };
        };
        // 앱이 비운 합성 개념 LTM — 검증기 구성 줄이 모두 기준일 기대값(검증기가 따로 계산한 값)을 가지면 채울 수 있었음(실패),
        //   하나라도 기준일 값이 없으면 정당한 공란(그 구성 줄의 공란은 제 공란 행에서 따로 판정)
        derivedGapEval = (g) => {
          const exp = synthExp(g.concept);
          if (!exp || exp.v == null || !exp.ids) return { status: FAIL, note: `합성 개념 ${g.concept} — 검증기 고정 구성 규칙 없음 또는 SEC 원본으로 계산 불가${exp?.why ? `(${exp.why})` : ""}` };
          const comps = exp.ids.filter((x) => x.v !== 0);
          if (!comps.length) return { absent: true, note: "구성 줄 연말 값 모두 0" };
          const got = comps.map((x) => ({ x, d0: dstsOf(x.id).find((dd) => expOf.has(`${dd}|${g.at}`)) }));
          const miss = got.filter((y) => !y.d0);
          if (miss.length) return { absent: true, note: `구성 줄 ${miss.map((y) => `${shortId(y.x.id)}(${dstsOf(y.x.id).join("|") || "앱 개념 없음"})`).join(", ")} 의 기준일 값 없음` };
          // 여러 SEC 줄이 같은 앱 개념으로 들어가면(사채·장기차입금 → LongTermDebtNoncurrent) 그 개념은 한 번만 더한다(재감사 13차 ⑥)
          const uniq0 = [...new Set(got.map((y) => y.d0))];
          const sum0 = uniq0.reduce((t, d0) => t + expOf.get(`${d0}|${g.at}`), 0);
          return { status: FAIL, note: `앱 LTM 공란인데 검증기 고정 구성 줄이 모두 기준일 기대값을 가짐 — ${uniq0.map((d0) => `${d0} ${expOf.get(`${d0}|${g.at}`)}`).join(" + ")} = ${sum0}(SEC 줄 ${got.map((y) => `${shortId(y.x.id)}→${y.d0}`).join(", ")}) — 채울 수 있음` };
        };
        add("A", "20-F 사업연도 완결성(SEC 20-F 원본)", "LTM", { status: uniq.length ? PASS : FAIL, note: `${uniq.length ? "" : "SEC 20-F 통화 값을 하나도 못 읽음 — 대조 불가 · "}SEC 20-F ${repCur ?? "?"} 값 ${uniq.length}개 중 앱 개념 대응 ${okN}개 존재(앱 개념 값 대조 ${valN}개), 대응 개념 없음 ${noMap}개(회사 고유·대응표 밖), 합성 개념 대조 ${synthN}개, 원천 없는 앱 값 ${orphanN}개` });
      }
    }
    for (const g of derivedGaps) {
      const gname = `20-F LTM 공란 ${g.kind} ${shortId(g.concept)} @${g.at}`;
      const r = derivedGapEval ? derivedGapEval(g) : { status: FAIL, note: "SEC 20-F 원본·verify-row 사업연도 값이 없어 합성 개념 구성 규칙을 만들 수 없음" };
      if (r.absent) gapOk++;
      else add("A", gname, "LTM", r);
    }
    for (const d of derivedDets) {
      const r = derivedEval ? derivedEval(d) : { status: FAIL, note: "SEC 20-F 원본·verify-row 사업연도 값이 없어 합성 개념 구성 규칙을 만들 수 없음" };
      if (r.exp != null) expOf.set(`${d.concept}|${d.at}`, r.exp);
      add("A", `20-F LTM 6-K ${d.kind} ${shortId(d.concept)} @${d.at}`, "LTM", r.exp != null ? vsSource(d.usd, r.exp, EXACT, r.how) : r);
    }
    add("A", "20-F LTM 공란 완결성(6-K 대조)", "LTM", gapNa.length
      ? { status: FAIL, note: `앱 LTM 공란 ${gaps.length}개 중 6-K 대조 불가 ${gapNa.length}개(${gapNa.join(", ")}) — 정당한 공란인지 판정 못 함(${gapOk}개는 6-K 에 줄 없음 확인)` }
      : { status: PASS, note: `앱 LTM 공란 ${gaps.length}개 개념 중 6-K 에서 값을 찾은 것 없음(${gapOk}개 줄 없음 확인 — 판정 불가 공란은 개별 행에서 실패)` });
    // 20-F 인데 앱이 6-K 보고서를 쓰지 않음 — 공란이 없어도 기록(6-K 조회 실패면 verify-row 경고 "조회 실패"가 오류로 따로 잡힌다)
    if (!sixKSource) add("A", "20-F LTM 6-K 보고서", "LTM", gaps.length ? { status: FAIL, note: `앱이 쓴 6-K 보고서 없음${row?.ltm?.sixKMiss ? `(앱 사유: ${row.ltm.sixKMiss})` : ""} — 공란 ${gaps.length}개 판정 불가` } : { status: NA, note: `앱이 쓴 6-K 보고서 없음${row?.ltm?.sixKMiss ? `(앱 사유: ${row.ltm.sixKMiss})` : ""} · LTM 공란 없음` });
  };
  if (foreign && H.LTM && ltmYahooNote) {
    try {
      if (!fxRows) throw new Error(fxErr || "환율 없음");
      const yqq = await (await yahoo()).fundamentalsTimeSeries(sym, { period1: new Date(Date.parse(H.LTM.date) - 460 * 864e5), type: "quarterly", module: "all" }, { validateResult: false });
      const rows = yqq.map((r) => ({ ...r, end: new Date(r.date).toISOString().slice(0, 10) })).filter((r) => r.end <= H.LTM.date || dayDiff(r.end, H.LTM.date) <= 7).sort((a, b) => a.end.localeCompare(b.end));
      const last = rows.slice(-4);
      if (last.length !== 4 || dayDiff(last[3].end, H.LTM.date) > 7) add("A", "20-F LTM = Yahoo 분기 4개 × 분기 평균 환율", "LTM", { status: FAIL, note: `Yahoo 분기 4개(기준일 ${H.LTM.date})를 못 찾음 — ${last.map((r) => r.end).join(",")}` });
      else {
        const qStart = (e) => { const d = new Date(`${e}T00:00:00Z`); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 2, 1)).toISOString().slice(0, 10); };
        const avgR = last.map((r) => fxAvg(fxRows, qStart(r.end), r.end));
        const endR = fxEndRate(fxRows, last[3].end);
        // 앱이 Yahoo 분기 LTM 을 만들었는데 검증기 H.10 으로는 미고시 창이면 — 앱이 다른 환율을 쓴 것(대체 금지 위반)
        const pendQ = fxPendingWhy(fxRows, last[3].end);
        if (pendQ) add("A", "20-F LTM = Yahoo 분기 4개 × 분기 평균 환율", "LTM", { status: FAIL, note: `${pendQ}인데 앱이 LTM 열을 Yahoo 분기(~${last[3].end})로 채움 — 다른 환율로 대체한 것으로 보임` });
        // k = "a|b" — 앞 필드가 없으면 뒤 필드(앱 edgar-yahoo-quarters.ts 와 같은 규칙 — ASML 감가상각 depreciationAndAmortization)
        const fld = (r, k) => (k.includes("|") ? (k.split("|").map((x) => r[x]).find((x) => x != null) ?? null) : (r[k] ?? null));
        const flow = (k) => (last.every((r) => fld(r, k) != null) && avgR.every((x) => x != null) ? last.reduce((t, r, i) => t + fld(r, k) * avgR[i], 0) : null);
        const hv = (key) => h.rows.find((r) => r.key === key)?.values[h.columns.findIndex((cc) => cc.kind === "ltm")] ?? null;
        const bsL = (name) => rowOf(bs, name)["현재/LTM"] ?? null;
        // 각주 형식(2026-10-02): "공란 — 사유: 항목, … / 사유: 항목" · "SEC 연말 + Yahoo 분기 변동분: 항목, …"
        // 항목 단위 정확 비교(재감사 지적 2026-10-02 — 부분 문자열이면 "매출"이 "매출채권 증감"에 걸렸다). 앱 항목 이름은 띄어쓰기를 빼고 비교
        const nm0 = (x) => x.replace(/\s/g, "");
        const blanksTxt = /공란(?::| —) (.+?)(?: · |$)/.exec(ltmYahooNote)?.[1] ?? "";
        const approxSet = new Set((/SEC 연말 \+ Yahoo 분기 변동분: (.+?)(?: · |$)/.exec(ltmYahooNote)?.[1]?.split(", ") ?? []).map(nm0));
        // 앱이 회사 6-K 분기 재무제표에서 읽은 항목(2026-10-02) — 아래에서 검증기가 6-K 를 따로 읽어 다시 계산
        const sixKSet = new Set((/회사 6-K 분기 재무제표: (.+?)(?: · |$)/.exec(ltmYahooNote)?.[1]?.split(", ") ?? []).map(nm0));
        // 환율 = 검증기가 FRED 에서 따로 받은 연준 H.10(흐름 분기 창 4개 평균, 잔액 최신 분기말 기말) — 독립. Yahoo 분기 원천은 공통모드로 남는다
        const basis = `Yahoo 분기 ${last.map((r) => r.end).join("·")} × 분기 평균 환율(${natCur}→USD, 연준 H.10 ${fxRows.series})${pendQ ? "" : ` · ${FX_IND_MARK}(분기 창 4개 + 기말 ${last[3].end})`}`;
        const items = [
          ["매출", H.LTM.rev, flow("totalRevenue"), "totalRevenue"], ["매출원가", IS.LTM?.cogs ?? null, flow("costOfRevenue"), "costOfRevenue"],
          ["매출총이익", IS.LTM?.gp ?? null, flow("grossProfit"), "grossProfit"], ["영업이익", IS.LTM?.op ?? null, flow("totalOperatingIncomeAsReported"), "totalOperatingIncomeAsReported"],
          // 재무 5층 손익 줄(재감사 N2 — 판관비·연구개발비는 YAHOO-Q 항목 목록 밖), 세전이익·법인세
          ["판관비", IS.LTM?.sga ?? null, flow("sellingGeneralAndAdministration"), "sellingGeneralAndAdministration"], ["연구개발비", IS.LTM?.rnd ?? null, flow("researchAndDevelopment"), "researchAndDevelopment"],
          ["세전이익", IS.LTM?.pretax ?? null, flow("pretaxIncome"), "pretaxIncome"], ["법인세", IS.LTM?.tax ?? null, flow("taxProvision"), "taxProvision"],
          ["순이익", H.LTM.ni, flow("netIncome"), "netIncome"], ["감가상각비", IS.LTM?.da ?? null, flow("reconciledDepreciation|depreciationAndAmortization"), "reconciledDepreciation|depreciationAndAmortization"],
          // CapEx = 유형자산 취득(purchaseOfPPE) — 야후 capitalExpenditure 는 무형자산 취득까지 합(앱 2026-10-02 와 같은 정의)
          ["영업활동 현금흐름", hv("ocf"), flow("operatingCashFlow"), "operatingCashFlow"], ["CapEx", hv("capex"), flow("purchaseOfPPE"), "purchaseOfPPE"],
        ];
        const bals = [
          ["자산 총계", bsL("자산 총계"), "totalAssets"], ["부채 총계", bsL("부채 총계"), "totalLiabilitiesNetMinorityInterest"],
          ["자본 총계", bsL("자본 총계"), "stockholdersEquity"], ["현금·현금성자산", bsL("현금·현금성자산"), "cashAndCashEquivalents"],
          ["유동자산 총계", bsL("유동자산 총계"), "currentAssets"], ["유동부채 총계", bsL("유동부채 총계"), "currentLiabilities"],
        ].map(([n0, app, k]) => [n0, app, last[3][k] != null && endR != null ? last[3][k] * endR : null, k]);
        let secFy = null; // 공란 사유 확인용 SEC FY(원통화) — 필요할 때만 판독
        let yAnnBs = null; // 공란 사유 확인용 야후 연간 재무상태표 — 필요할 때만
        // 공란 사유 확인용 야후 연간 전체(흐름) — 조회 실패는 오류
        let yaOuter = null, yaOuterErr = null;
        const yaOuterP = (await yahoo()).fundamentalsTimeSeries(sym, { period1: "2018-01-01", type: "annual", module: "all" }, { validateResult: false })
          .then((x) => { yaOuter = x.map((r) => ({ ...r, end: new Date(r.date).toISOString().slice(0, 10) })); })
          .catch((e) => { yaOuterErr = String(e).slice(0, 80); hardErrors.push(`20-F LTM 공란 사유 확인 — 야후 연간 조회 실패: ${yaOuterErr}`); });
        await yaOuterP;
        const yaRowsOuter = () => yaOuter ?? [];
        const fyCol = Object.keys(H).filter((cc) => cc !== "LTM").sort((a, b) => H[a].date.localeCompare(H[b].date)).at(-1);
        for (const [n0, app, exp, k] of [...items, ...bals]) {
          const name = `20-F LTM ${n0} = Yahoo 분기${bals.some((b) => b[0] === n0) ? " 최신 분기말 × 기말 환율" : " 4개 × 분기 평균 환율"}`;
          // 앱이 "SEC 사업연도 + 야후 분기 변동분"(결정 (가) 방식)으로 만든 흐름 항목 — 기대값 = 야후 4개 분기 + (SEC FY − 야후 FY) × 사업연도 평균 환율.
          // SEC FY 는 검증기가 공시 원본에서 따로 읽는다(CapEx 만 — 나머지 항목은 미구현으로 남긴다)
          // 앱이 회사 6-K 분기 재무제표로 만든 흐름 항목 — 기대값 = SEC 20-F 사업연도(검증기 원본 판독) × 사업연도 평균 환율 + 6-K 당기 누적 × (사업연도 다음날~기준일)
          // 평균 환율 − 6-K 전기 누적 × (사업연도 시작~1년 전 기준일) 평균 환율. 6-K 값은 검증기가 따로 읽는다(sixKCfYtd)
          if (app != null && sixKSet.has(nm0(n0)) && !bals.some((b) => b[0] === n0)) {
            secFy ??= fyCol ? await filingAtDate(cik, sub, H[fyCol].date) : null;
            const reId = n0 === "CapEx" ? /_(?:PurchaseOfPropertyPlantAndEquipment\w*|PaymentsToAcquirePropertyPlantAndEquipment)$/
              : n0 === "영업활동 현금흐름" ? /_(?:NetCashProvidedByUsedInOperatingActivities|CashFlowsFromUsedInOperatingActivities)$/
              : n0 === "감가상각비" ? /_(?:DepreciationDepletionAndAmortization|DepreciationAndAmortization|AdjustmentsForDepreciationAndAmortisationExpense\w*)$/ : null;
            const fyF = reId ? secFy?.durFacts.filter((x0) => !x0.dims.length && reId.test(x0.id) && (Date.parse(x0.end) - Date.parse(x0.start)) / 864e5 > 300) : [];
            if (!reId || !fyF?.length) { add("A", name, "LTM", { status: FAIL, note: `앱이 "${n0}"을 회사 6-K 로 만듦 — 검증기 SEC 사업연도 값 ${reId ? "판독 실패" : "독립 재계산 미구현"}` }); continue; }
            const f0 = fyF.sort((a, b) => Math.abs(b.v) - Math.abs(a.v))[0];
            const labs = secFy.labels.get(f0.id) ?? [];
            const priorEnd = new Date(Date.UTC(Number(H.LTM.date.slice(0, 4)) - 1, Number(H.LTM.date.slice(5, 7)), 0)).toISOString().slice(0, 10);
            let yt;
            try { yt = await sixKCfYtd(cik, sub, H.LTM.date, priorEnd, labs, n0 === "CapEx" ? (f) => f.cur <= 0 && f.prior <= 0 : null); }
            catch (e) { hardErrors.push(`20-F LTM ${n0} 6-K 현금흐름표 ${String(e).slice(0, 100)}`); add("A", name, "LTM", { status: FAIL, note: `6-K 판독 불가: ${String(e).slice(0, 100)}` }); continue; }
            if (!yt || yt.ambiguous) { add("A", name, "LTM", { status: FAIL, note: `6-K 현금흐름표 "${labs[0] ?? f0.id}" 줄 ${yt ? `${yt.ambiguous}개 후보로 모호(${yt.src})` : "못 찾음"}` }); continue; }
            const fyEnd = f0.end, fyStart = f0.start;
            const sgn = n0 === "CapEx" ? -1 : 1, fyV = n0 === "CapEx" ? -Math.abs(f0.v) : f0.v;
            const cur = sgn === -1 ? -Math.abs(yt.cur) : yt.cur, prior = sgn === -1 ? -Math.abs(yt.prior) : yt.prior;
            const nextDay = new Date(Date.parse(fyEnd) + 864e5).toISOString().slice(0, 10);
            const rF = fxAvg(fxRows, fyStart, fyEnd), rC = fxAvg(fxRows, nextDay, H.LTM.date), rP = fxAvg(fxRows, fyStart, priorEnd);
            if (rF == null || rC == null || rP == null) { add("A", name, "LTM", { status: FAIL, note: "6-K 기대값 환율 없음" }); continue; }
            const exp6 = fyV * rF + cur * rC - prior * rP;
            add("A", name.replace(/= Yahoo 분기.*/, "= SEC 20-F + 6-K 누적(검증기 판독)"), "LTM", vsSource(app, exp6, EXACT, `SEC ${secFy.form} ${f0.id} ${fyV} + 6-K(${yt.src}) 당기 ${cur} − 전기 ${prior} ${natCur} × H.10 기간 평균`));
            continue;
          }
          if (app != null && approxSet.has(nm0(n0)) && !bals.some((b) => b[0] === n0)) {
            // CapEx 만 독립 재계산한다 — 다른 항목을 앱이 변동분 방식으로 만들었으면 검증되지 않은 값이므로 실패(재감사 지적: NA 면 앱이 스스로 검사를 면제받는다)
            if (n0 !== "CapEx") { add("A", name, "LTM", { status: FAIL, note: `앱이 "${n0}"을 SEC 사업연도 + 야후 분기 변동분으로 만듦 — 검증기 독립 재계산 미구현(구현 필요)` }); continue; }
            if (exp == null) { add("A", name, "LTM", { status: FAIL, note: `앱 ${app} 있는데 Yahoo ${k} 분기 없음` }); continue; }
            secFy ??= fyCol ? await filingAtDate(cik, sub, H[fyCol].date) : null;
            const cap = secFy?.durFacts.filter((x0) => !x0.dims.length && /PurchaseOfPropertyPlantAndEquipment|PaymentsToAcquirePropertyPlantAndEquipment/.test(x0.id) && (Date.parse(x0.end) - Date.parse(x0.start)) / 864e5 > 300).sort((a, b) => Math.abs(b.v) - Math.abs(a.v))[0];
            const ya2 = await (await yahoo()).fundamentalsTimeSeries(sym, { period1: "2018-01-01", type: "annual", module: "cash-flow" }, { validateResult: false });
            const yr2 = ya2.find((r) => r.purchaseOfPPE != null && dayDiff(new Date(r.date).toISOString().slice(0, 10), H[fyCol].date) <= 7);
            const fyEnd = H[fyCol].date, fyStart = new Date(Date.parse(fyEnd) - 364 * 864e5).toISOString().slice(0, 10);
            const fyR = fxAvg(fxRows, fyStart, fyEnd);
            if (!cap || !yr2 || fyR == null) { add("A", name, "LTM", { status: FAIL, note: `변동분 보정 기대값 계산 불가 — SEC ${cap ? "있음" : "없음"}·Yahoo 연간 ${yr2 ? "있음" : "없음"}·환율 ${fyR ?? "없음"}` }); continue; }
            const adj = (-Math.abs(cap.v) - yr2.purchaseOfPPE) * fyR;
            add("A", name, "LTM", vsSource(app, exp + adj, EXACT, `${basis} + (SEC ${secFy.form} ${-Math.abs(cap.v)} − Yahoo FY ${yr2.purchaseOfPPE}) × 사업연도 평균 환율`));
            continue;
          }
          if (app != null) { add("A", name, "LTM", exp == null ? { status: FAIL, note: `앱 ${app} 있는데 Yahoo ${k} 없음` } : vsSource(app, exp, EXACT, basis)); continue; }
          if (exp == null) {
            // 앱 공란 + 야후 없음 — 검증기가 6-K 에서 값을 찾으면 실패(있어야 할 값이 빈칸, 재감사 e-2). 6-K 에도 없을 때만 검증불가
            const reId0 = n0 === "CapEx" ? /_(?:PurchaseOfPropertyPlantAndEquipment\w*|PaymentsToAcquirePropertyPlantAndEquipment)$/
              : n0 === "영업활동 현금흐름" ? /_(?:NetCashProvidedByUsedInOperatingActivities|CashFlowsFromUsedInOperatingActivities)$/
              : n0 === "감가상각비" ? /_(?:DepreciationDepletionAndAmortization|DepreciationAndAmortization|AdjustmentsForDepreciationAndAmortisationExpense\w*)$/ : null;
            if (reId0) {
              secFy ??= fyCol ? await filingAtDate(cik, sub, H[fyCol].date) : null;
              const f0 = secFy?.durFacts.filter((x0) => !x0.dims.length && reId0.test(x0.id) && (Date.parse(x0.end) - Date.parse(x0.start)) / 864e5 > 300).sort((a, b) => Math.abs(b.v) - Math.abs(a.v))[0];
              const priorEnd0 = new Date(Date.UTC(Number(H.LTM.date.slice(0, 4)) - 1, Number(H.LTM.date.slice(5, 7)), 0)).toISOString().slice(0, 10);
              let yt0 = null;
              try { yt0 = f0 ? await sixKCfYtd(cik, sub, H.LTM.date, priorEnd0, secFy.labels.get(f0.id) ?? [], n0 === "CapEx" ? (f) => f.cur <= 0 && f.prior <= 0 : null) : null; }
              catch (e) { hardErrors.push(`20-F LTM ${n0} 공란 6-K 현금흐름표 ${String(e).slice(0, 100)}`); add("A", name, "LTM", { status: FAIL, note: `앱 공란 — 6-K 판독 불가로 채울 수 있는지 판정 못 함: ${String(e).slice(0, 100)}` }); continue; }
              // SEC 사업연도 값을 못 읽으면 판정 불가(재감사 12차 ⑦ — "양쪽 빈칸 검증불가"로 넘기지 않는다)
              if (!secFy) { add("A", name, "LTM", { status: FAIL, note: `앱 공란(Yahoo ${k} 없음) — SEC 20-F 원본 판독 실패로 6-K 대조 불가` }); continue; }
              if (!f0) { add("A", name, "LTM", { status: NA, note: `양쪽 빈칸(Yahoo ${k} 없음, SEC 20-F 사업연도에도 해당 줄 없음)` }); continue; }
              if (yt0 && !yt0.ambiguous) { add("A", name, "LTM", { status: FAIL, note: `앱 공란(Yahoo ${k} 없음)인데 6-K(${yt0.src})에 당기 누적 ${yt0.cur}·전기 ${yt0.prior} — 채울 수 있음` }); continue; }
            }
            add("A", name, "LTM", { status: NA, note: `양쪽 빈칸(Yahoo ${k} 없음, 6-K 값도 없음)` }); continue;
          }
          // 앱 공란 — notes 에 사유가 적힌 항목만, 사유(Yahoo 연간 ≠ SEC FY)를 SEC 원본으로 확인
          // 공란 목록 파싱: "사유: 항목, 항목 / 사유: 항목" — 조각마다 "사유: " 를 떼고 항목 단위로
          const blankItems = new Set(blanksTxt.split(" / ").flatMap((g0) => (g0.includes(": ") ? g0.slice(g0.indexOf(": ") + 2) : g0).split(", ")).map(nm0));
          if (!blankItems.has(nm0(n0))) { add("A", name, "LTM", { status: FAIL, note: `Yahoo ${k} ${exp} 있는데 앱 공란(사유 없음)` }); continue; }
          // 잔액 항목(재감사 12차 ⑥) — 앱 규칙(edgar-yahoo-quarters 잔액): 야후 FY말 = SEC(공시 단위 안)이면 야후 값, 15% 안이면 SEC 연말 + 야후 변동분.
          //   검증기가 SEC 20-F 원본(대응표 사본)과 야후 FY말(분기 → 없으면 연간)을 따로 읽어 판정 — 두 조건에 걸리면 공란 사유 불성립(실패)
          const balSpec = { "자산총계": ["Assets", "totalAssets"], "부채총계": ["Liabilities", "totalLiabilitiesNetMinorityInterest"],
            "자본총계": ["StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", "totalEquityGrossMinorityInterest"],
            "현금·현금성자산": ["CashAndCashEquivalentsAtCarryingValue", "cashAndCashEquivalents"], "유동자산총계": ["AssetsCurrent", "currentAssets"], "유동부채총계": ["LiabilitiesCurrent", "currentLiabilities"] }[nm0(n0)];
          if (balSpec) {
            const [dstC, yk] = balSpec;
            secFy ??= fyCol ? await filingAtDate(cik, sub, H[fyCol].date) : null;
            const fyEnd0 = H[fyCol].date;
            const qE = rows.find((r) => dayDiff(r.end, fyEnd0) <= 7);
            let yFy = qE ? fld(qE, yk) : null;
            if (yFy == null) {
              yAnnBs ??= await (await yahoo()).fundamentalsTimeSeries(sym, { period1: "2018-01-01", type: "annual", module: "balance-sheet" }, { validateResult: false })
                .catch((e) => { hardErrors.push(`20-F LTM 공란 사유 확인 — 야후 연간 재무상태표 조회 실패: ${String(e).slice(0, 80)}`); return null; });
              const aE = (yAnnBs ?? []).find((r) => dayDiff(new Date(r.date).toISOString().slice(0, 10), fyEnd0) <= 7);
              yFy = aE ? fld(aE, yk) : null;
              if (yAnnBs == null) { add("A", name, "LTM", { status: FAIL, note: "앱 공란 — 야후 연간 조회 실패로 사유 확인 불가" }); continue; }
            }
            if (yFy == null) { add("A", name, "LTM", { status: NA, note: `앱 공란 — 사유 확인: 야후 ${yk} FY말(${fyEnd0}) 값 없음` }); continue; }
            const sec0 = secFy ? secBalanceOf(secFy, dstC) : null;
            if (!sec0) { add("A", name, "LTM", { status: FAIL, note: `앱 공란 — SEC 20-F ${dstC} 연말 값 ${secFy ? "없음(대응표 사본 기준)" : "판독 실패"}로 사유 확인 불가` }); continue; }
            let unit = 1;
            for (const r0 = Math.round(Math.abs(sec0.v)); unit < 1e6 && r0 !== 0 && r0 % (unit * 10) === 0;) unit *= 10;
            const rel0 = Math.abs(sec0.v - yFy) / Math.max(1, Math.abs(sec0.v));
            add("A", name, "LTM", Math.abs(sec0.v - yFy) < unit + Math.abs(sec0.v) * 1e-9
              ? { status: FAIL, note: `앱 공란인데 야후 ${yk} FY말 ${yFy} = SEC ${sec0.how} ${sec0.v} ${natCur}(공시 단위 ${unit} 안) — 야후 값으로 채워야 함(사유 불성립)` }
              : rel0 <= 0.15
                ? { status: FAIL, note: `앱 공란인데 야후 FY말 ${yFy} vs SEC ${sec0.how} ${sec0.v} ${natCur} 차이 ${(rel0 * 100).toFixed(3)}% ≤ 15% — SEC 연말 + 야후 변동분으로 채워야 함(사유 불성립)` }
                : { status: NA, note: `앱 공란 — 사유 확인: 야후 ${yk} FY말 ${yFy} vs SEC ${sec0.how} ${sec0.v} ${natCur} — 차이 ${(rel0 * 100).toFixed(2)}% > 15%(정의 차이)` });
            continue;
          }
          // 흐름 항목(재감사 13차 ① — NA 로 면제하지 않는다): SEC 사업연도(검증기 대응 개념, companyfacts 20-F 원통화) vs 야후 연간(검증기 필드).
          //   재무 5층 항목(매출·매출원가·매출총이익·영업이익·판관비·연구개발비 — fin read/ltm-yahoo.ts)은 공시 단위 안 같을 때만 채운다,
          //   그 밖(세전이익·법인세·순이익·감가상각비·영업활동 현금흐름 — edgar-yahoo-quarters FLOWS)은 5% 안이면 채운다. 야후 최근 4개 분기도 다 있어야
          if (n0 !== "CapEx") {
            const PRETAX0 = ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
              "IncomeLossFromContinuingOperationsBeforeIncomeTaxesAndExtraordinaryItemsNoncontrollingInterest", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndEquityMethodInvestments"];
            const spec = { "매출": [["Revenues"], "exact"], "매출원가": [["CostOfRevenue"], "exact"], "매출총이익": [["GrossProfit"], "exact"], "영업이익": [["OperatingIncomeLoss"], "exact"],
              "판관비": [["SellingGeneralAndAdministrativeExpense"], "exact"], "연구개발비": [["ResearchAndDevelopmentExpense"], "exact"], "세전이익": [PRETAX0, "5%"], "법인세": [["IncomeTaxExpenseBenefit"], "5%"],
              "순이익": [["NetIncomeLoss"], "5%"], "감가상각비": [DA_SIBLINGS, "5%"], "영업활동현금흐름": [["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"], "5%"] }[nm0(n0)];
            if (!spec) { add("A", name, "LTM", { status: FAIL, note: `앱 공란(사유 "${n0}") — 검증기 흐름 규칙 없음` }); continue; }
            const fyEnd0 = H[fyCol].date;
            // 감가상각은 합계 태그 중 최댓값(앱 DA_TOTAL 규칙), 나머지는 SEC 사업연도 값이 있는 첫 개념
            const secs = [];
            for (const c of spec[0]) { const x = await secFlowFy(c, fyEnd0); if (x) secs.push(x); }
            const sec0 = nm0(n0) === "감가상각비" ? secs.sort((a, b) => Math.abs(b.v) - Math.abs(a.v))[0] : secs[0];
            if (nm0(n0) === "세전이익" && !(await secIdsOf("OperatingIncomeLoss", "cf", fyEnd0)).length) { add("A", name, "LTM", { status: NA, note: "앱 공란 — 사유 확인: SEC 영업이익 개념 없음(세전이익 기반 합성 — 앱 규칙상 공란)" }); continue; }
            if (!sec0) { add("A", name, "LTM", { status: FAIL, note: `앱 공란 — SEC 20-F 사업연도 ${spec[0][0]} 값을 검증기 대응으로 못 읽음(사유 확인 불가)` }); continue; }
            const aE = yaRowsOuter().find((r) => dayDiff(r.end, fyEnd0) <= 7);
            if (aE === undefined && yaOuterErr) { add("A", name, "LTM", { status: FAIL, note: "앱 공란 — 야후 연간 조회 실패로 사유 확인 불가" }); continue; }
            const yA0 = aE ? fld(aE, k) : null;
            const q4ok = last.every((r) => fld(r, k) != null);
            if (yA0 == null || !q4ok) { add("A", name, "LTM", { status: NA, note: `앱 공란 — 사유 확인: 야후 ${k} ${yA0 == null ? "연간 없음" : "최근 4개 분기 중 결측"}` }); continue; }
            let unit = 1;
            for (const r0 = Math.round(Math.abs(sec0.v)); unit < 1e6 && r0 !== 0 && r0 % (unit * 10) === 0;) unit *= 10;
            const same0 = Math.abs(sec0.v - yA0) < unit + Math.abs(sec0.v) * 1e-9, rel0 = Math.abs(sec0.v - yA0) / Math.max(1, Math.abs(sec0.v));
            add("A", name, "LTM", same0
              ? { status: FAIL, note: `앱 공란인데 야후 ${k} 연간 ${yA0} = SEC ${idsTxt(sec0.ids)} ${sec0.v} ${natCur}(공시 단위 안)·최근 4개 분기 있음 — 채워야 함(사유 불성립)` }
              : spec[1] === "5%" && rel0 <= 0.05
                ? { status: FAIL, note: `앱 공란인데 야후 ${k} 연간 ${yA0} vs SEC ${sec0.v} 차이 ${(rel0 * 100).toFixed(3)}% ≤ 5% — 수준 보정으로 채워야 함(사유 불성립)` }
                : { status: NA, note: `앱 공란 — 사유 확인: 야후 ${k} 연간 ${yA0} vs SEC ${idsTxt(sec0.ids)} ${sec0.v} ${natCur} 차이 ${(rel0 * 100).toFixed(3)}%(${spec[1] === "5%" ? "5% 초과" : "공시 단위 밖"} — 정의 차이)` });
            continue;
          }
          secFy ??= fyCol ? await filingAtDate(cik, sub, H[fyCol].date) : null;
          const cap = secFy?.durFacts.filter((x0) => !x0.dims.length && /PurchaseOfPropertyPlantAndEquipment|PaymentsToAcquirePropertyPlantAndEquipment/.test(x0.id) && (Date.parse(x0.end) - Date.parse(x0.start)) / 864e5 > 300).sort((a, b) => Math.abs(b.v) - Math.abs(a.v))[0];
          const ya = await (await yahoo()).fundamentalsTimeSeries(sym, { period1: "2018-01-01", type: "annual", module: "cash-flow" }, { validateResult: false });
          // 앱 규칙(2026-10-02): 야후 연간 유형자산 취득이 SEC 와 5% 안이면 변동분 보정으로 채운다 — 그 조건이면 공란은 사유 불성립(실패)
          const yr = ya.find((r) => r.purchaseOfPPE != null && dayDiff(new Date(r.date).toISOString().slice(0, 10), H[fyCol].date) <= 7);
          if (!cap || !yr) { add("A", name, "LTM", { status: FAIL, note: `앱 공란 사유(CapEx: Yahoo 연간 ≠ SEC FY) 확인 불가 — SEC ${cap ? "있음" : "없음"}·Yahoo ${yr ? "있음" : "없음"}` }); continue; }
          const rel0 = Math.abs(Math.abs(yr.purchaseOfPPE) - Math.abs(cap.v)) / Math.max(1, Math.abs(cap.v));
          add("A", name, "LTM", rel0 > 0.05 ? { status: NA, note: `앱 공란 — 사유 확인: Yahoo ${fyCol} 유형자산 취득 ${Math.abs(yr.purchaseOfPPE)} vs SEC ${secFy.form} ${Math.abs(cap.v)} ${natCur} — 차이 ${(rel0 * 100).toFixed(2)}% > 5%(정의 차이)` }
            : { status: FAIL, note: `앱 공란인데 Yahoo ${fyCol} 유형자산 취득 ${Math.abs(yr.purchaseOfPPE)} 와 SEC ${Math.abs(cap.v)} 차이 ${(rel0 * 100).toFixed(3)}% ≤ 5% — 변동분 보정으로 채울 수 있음(사유 불성립)` });
        }
        await checkLtmItems(rows, qStart, last.map((r) => r.end));
      }
    } catch (e) {
      hardErrors.push(`20-F LTM 독립 재계산(Yahoo 분기·환율) 조회 실패: ${String(e).slice(0, 60)}`);
    }
  }

  // ── C. 개요·유니버스 — 앱이 실제로 계산한 값(verify-row) vs 하이라이트 LTM
  const L = H.LTM;
  // LTM 열 기대치(감사 2차 ①) — 하이라이트 LTM 열이 없는 경우는 K1 「LTM 열 존재」가 실패로 남긴다. 재무분석·개요·유니버스 LTM 도 있어야 한다
  if (L && !A.LTM) add("C", "재무분석 LTM 열 존재", "LTM", { status: FAIL, note: "하이라이트 LTM 열이 있는데 재무분석 LTM 열 없음" });
  if (row && !L) add("C", "개요·유니버스 = 하이라이트 LTM", "LTM", { status: FAIL, note: "하이라이트 LTM 열 없음 — 개요·유니버스 대조 불가" });
  if (row && L) {
    const m = row.overview?.multiples ?? null, uv = row.universe ?? null;
    if (!m) add("C", "개요 멀티플 계산됨", "LTM", { status: FAIL, note: `개요 멀티플 없음 ${JSON.stringify(row.overview?.warnings ?? [])}` });
    else {
      add("C", "시가총액 개요=하이라이트", "LTM", same(m.marketCap, L.mc));
      add("C", "PER(TTM) 개요=하이라이트", "LTM", same(m.perTtm, L.per));
      add("C", "PBR 개요=하이라이트", "LTM", same(m.pbr, L.pbr));
      add("C", "PSR 개요=하이라이트", "LTM", same(m.psr, L.psr));
      if (!bank) add("C", "EV/EBITDA 개요=하이라이트", "LTM", same(m.evEbitda, L.evx));
    }
    if (!uv || uv.error) add("C", "유니버스 행 계산됨", "LTM", { status: FAIL, note: uv?.error ?? "응답 없음" });
    else {
      add("C", "시가총액 유니버스=하이라이트", "LTM", same(uv.marketCap, L.mc));
      add("C", "PER(TTM) 유니버스=하이라이트", "LTM", same(uv.perTtm, L.per));
      add("C", "PBR 유니버스=하이라이트", "LTM", same(uv.pbr, L.pbr));
    }
  }

  // ── F. 외부 대조 — 지표×기간마다 Yahoo·StockAnalysis·인포맥스를 한 줄에 모은다(오너 지시 2026-09-24 —
  // "단순히 한곳만 일치한다고 통과하면 안 된다"). 각 소스가 제 보고 단위 안에서 앱과 같은지 기록하고, 다른
  // 소스는 차이를 남긴다. 외부 소스는 정의가 제각각이라 판정(실패)이 아니라 원인 규명 대상 목록이다.
  // 기준일이 앱과 같은(±7일) 값만 넣는다.
  //
  // 판정(오너 지시 2026-09-26 — "허용오차는 허락한 적이 없다"): ① = 앱 값과 외부 값이 완전히 같을 때만(extEq — 부동소수 표현 차만 같음).
  // 외부 소스가 자기 표기 단위로 반올림해 싣는 값과의 차이는 ① 이 아니라 ② "외부 표기 단위 반올림" — roundHalfAway(앱, 단위) = 외부
  // 가 정확히 성립할 때만(causeOf 첫 규칙). 단위는 소스·종목의 실제 데이터로 정한 값 하나만 쓴다(여러 단위를 대입해 맞는 걸 고르지 않는다).
  // 파생 외부 값(인포맥스 매출원가 = 매출 − 매출총이익 등)은 성분마다 반올림한 식 Σ 부호·round(앱 성분, 단위) = 외부. 분기 합(LTM)은
  // 앱 분기값이 없어 반올림 식을 세우지 않는다(매출만 R4 가 SEC 분기값으로 분기별 식을 세운다).
  //
  //  소스·지표                         실제 표기 단위(2026-09-26 보고서 14개·47종목 실측)            반올림 식
  //  Yahoo fundamentalsTimeSeries      달러 정수(회사 공시값 그대로 — 최소 단위 = 회사 보고 단위)       없음(단위 1 — 완전 일치만)
  //  Yahoo LTM(분기 4개 합)·EBITDA(영업이익+감가상각)  달러 정수 합                                없음
  //  Yahoo 외화 × 환율(20-F)           부동소수 곱 — 앱도 SEC 원통화 × H.10(검증기 따로 조회)         없음(extEq 표현 차만)
  //  StockAnalysis 손익·현금흐름       종목별 단위(unitOfAll: 매출·순이익·영업이익 전 기간이 1e6 배수면 1e6, 1e3 배수면 1e3, 아니면 1)
  //                                    — 연간·TTM 모두 SA 가 싣는 값 하나(합산은 SA 쪽)            round(앱, 단위) = SA
  //  StockAnalysis 재무상태표(차입금)  종목별 단위(unitOfAll: 분기 차입금 전 값)                      round(앱, 단위) = SA
  //  인포맥스 연간 금액(매출·순이익·EBITDA·영업이익·자산총계·매출총이익)  종목별 단위(응답 전체 — 실측 전부 천 달러)  round(앱, 1e3) = 인포맥스
  //  인포맥스 감가상각비 = EBITDA − 영업이익, 매출원가 = 매출 − 매출총이익   두 값 각각 천 달러           round(앱 A) − round(앱 B) = 인포맥스
  //  인포맥스 LTM = 분기 4개(또는 8개) 합                                  분기마다 천 달러             식 없음(매출은 R4 분기별)
  //  인포맥스 희석 EPS                 소수 넷째 자리(순이익 ÷ 주식수 자체 계산 — 실측 418/420 값)     round(앱, 1e-4) = 인포맥스 / ⑨
  //  인포맥스 결산일 시가총액          센트(= 주식수 × 센트 종가 — 실측 주식수가 SEC 본표 주식수와 정수 일치)  없음(완전 일치만 ① — 앱도 호가 단위 종가)
  //  인포맥스 현재 주식수              천 주                                                         round(앱 주식수, 1e3) = 인포맥스
  // 판본 선택의 decimals 교차 확인 — 외부 대조 원인 규칙(aPassed·R6')이 그 결과를 보므로 그 앞에서(끝에서 한 번 더 — 뒤에 붙은 A층 검사)
  await applyVintage(checks, cik, hardErrors);
  if (EXTERNAL && !bank && L) {
    const recon = new Map();
    /** unit = 외부 표기 단위(반올림 식에 쓸 값 — null 이면 식 없음), parts = 파생 외부 값의 앱 성분 [[부호, 앱 값], …] */
    /** common = 앱과 같은 데이터·규칙으로 만든 외부 값의 사유 — 일치해도 ① 이 아니라 공통모드 */
    const put = (item, ours, name, v, unit = 1, parts = null, common = null) => {
      if (ours == null || v == null || !Number.isFinite(v)) return;
      const r = recon.get(item) ?? { item, ours, srcs: {} };
      r.srcs[name] = { v, unit, parts, common };
      recon.set(item, r);
    };
    const errs = [];
    // 연구개발비 원 10-K 본문 표 값(2026-09-29, XOM) — XBRL 이 1억 단위로만 태깅된 해("1.2 billion", decimals −8)는 판관비 규칙(note-rnd)이
    // 정밀값을 못 쓴다. 그 해 자기 10-K 본문의 "Research and development costs 1,228 987 879" 행 첫 값(백만)을 쓴다 — XBRL 값과 5% 안일 때만
    const rndText = new Map(); // 결산일 → 달러
    {
      const es = (G.ResearchAndDevelopmentExpense?.units?.USD ?? []).filter((e) => e.start && /^10-K/.test(e.form ?? "") && (Date.parse(e.end) - Date.parse(e.start)) / 864e5 > 300)
        .sort((a, b) => (a.filed ?? "").localeCompare(b.filed ?? ""));
      const first = new Map();
      for (const e of es) if (!first.has(e.end)) first.set(e.end, e);
      for (const e of first.values()) {
        if (e.val % 1e8 !== 0) continue;
        try {
          const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${e.accn.replace(/-/g, "")}`;
          const idx = await secJson(`${base}/index.json`);
          const doc = idx.directory.item.filter((x) => /\.htm$/i.test(x.name) && !/^(ex|R\d)/i.test(x.name)).sort((a, b) => Number(b.size || 0) - Number(a.size || 0))[0];
          if (!doc) continue;
          const txt = (await secText(`${base}/${doc.name}`)).replace(/<[^>]+>/g, " ").replace(/&#160;|&nbsp;/g, " ").replace(/\s+/g, " ");
          const m = /Research and development costs\s+\$?\s*([\d,]+)/i.exec(txt);
          const v = m ? Number(m[1].replace(/,/g, "")) * 1e6 : null;
          if (v != null && Math.abs(v - e.val) <= 0.05 * e.val) rndText.set(e.end, { v, accn: e.accn });
        } catch (e) { hardErrors.push(`연구개발비 10-K 본문 조회 실패: ${String(e).slice(0, 80)}`); }
      }
    }
    // StockAnalysis 현금흐름표 "기타 상각"(otherAmortization, 기간별) — 원인 판정 ⑦ 용
    const saOtherAmort = new Map();
    // StockAnalysis 손익 조정 항목(기간별) — 원인 R7(합성 영업이익 회사의 SA 영업이익 분류) 용
    const saIsAdj = new Map();
    // StockAnalysis 연간 재무상태표 결산일 보통주 주식수(sharesOutTotalCommon) — 인포맥스 시가총액 "외부 단독 이탈" 판정용
    const saYearEndShares = new Map();
    const iso = (d) => new Date(d).toISOString().slice(0, 10);
    const withLease = rowOf(bs, "총차입금 (운용리스 포함)")["현재/LTM"];

    // Yahoo — 연간·분기(EBITDA 는 앱과 같은 정의: 공시 영업이익 + 감가상각비)
    let yq = [], ya = [];
    try {
      const y = await yahoo();
      yq = await y.fundamentalsTimeSeries(sym, { period1: new Date(Date.now() - 500 * 864e5), type: "quarterly", module: "all" }, { validateResult: false });
      extYq = yq;
      ya = await y.fundamentalsTimeSeries(sym, { period1: "2018-01-01", type: "annual", module: "all" }, { validateResult: false });
      // Yahoo 는 52/53주 결산 분기말을 달력 월말로 적는다(PEP 2026-06-13 → 06-30). 월말이고 7일 안에 결산일이 없으면 같은 달 결산일(20일 이내 앞)로 맞춘다
      const ends = [...new Set([...qEndOf.values(), ...Object.values(H).map((x) => x.date)].filter(Boolean))];
      const snap = (r) => {
        const d = iso(r.date), t = new Date(r.date);
        if (new Date(t.getTime() + 864e5).getUTCDate() !== 1 || ends.some((e) => dayDiff(e, d) <= 7)) return r;
        const e = ends.find((e) => e.slice(0, 7) === d.slice(0, 7) && e < d && dayDiff(e, d) <= 20);
        return e ? { ...r, date: new Date(e) } : r;
      };
      yq = yq.map(snap); ya = ya.map(snap); extYq = yq;
    } catch (e) {
      errs.push(`Yahoo: ${String(e).slice(0, 60)}`);
    }
    const yEbitda = (r) => (r.totalOperatingIncomeAsReported != null && r.reconciledDepreciation != null ? r.totalOperatingIncomeAsReported + r.reconciledDepreciation : null);
    // 감사 M1: 외화 공시는 Yahoo 가 원통화라 USD 앱 값과 직접 비교하지 않는다(환산 비교는 A층 "20-F LTM" 검사가 한다)
    for (const [c, x] of Object.entries(H)) {
      if (c === "LTM" || foreign) continue;
      const r = ya.find((r) => dayDiff(iso(r.date), x.date) <= 7);
      if (!r) continue;
      put(`${c} 매출`, x.rev, "Yahoo", r.totalRevenue);
      put(`${c} 순이익`, x.ni, "Yahoo", r.netIncome ?? r.netIncomeCommonStockholders);
      // 희석 EPS — 공시 EPS 를 그대로 주는 소스(인포맥스는 순이익 ÷ 주식수 자체 계산이라 공시 EPS 의 독립 대조가 없었다, 2026-09-28)
      put(`${c} 희석 EPS`, x.eps, "Yahoo", r.dilutedEPS);
      put(`${c} EBITDA`, x.ebitda, "Yahoo", yEbitda(r));
      put(`${c} 영업이익`, IS[c]?.op, "Yahoo", r.totalOperatingIncomeAsReported);
      put(`${c} 감가상각비`, IS[c]?.da, "Yahoo", r.reconciledDepreciation);
      if (COGS_MODE) { put(`${c} 매출원가`, IS[c]?.cogs, "Yahoo", r.costOfRevenue); put(`${c} 매출총이익`, IS[c]?.gp, "Yahoo", r.grossProfit); }
    }
    // 외화 공시(20-F) 매출원가·매출총이익 연간 — Yahoo 연간(원통화) × 그 사업연도 평균 환율(검증기가 따로 받은 연준 H.10 — 독립,
    // 원통화 값은 SEC 본표와 독립). 앱 = SEC 원통화 × 같은 환율이라 원통화 값이 같으면 부동소수 오차 안에서 일치한다.
    // LTM 은 넣지 않는다 — 앱 LTM 열 자체가 Yahoo 분기 × 환율이라 독립 대조가 아니다(A층 "20-F LTM … = Yahoo 분기"가 계산 검사).
    // 인포맥스는 자체 환율로 USD 환산해(TSM 역산 환율이 매출·순이익마다 다름 — 위 "vs 인포맥스(USD 환산)") 정확 대조가 성립하지 않아 넣지 않는다
    if (COGS_MODE && foreign && fxRows) {
      for (const [c, x] of Object.entries(H)) {
        if (c === "LTM") continue;
        const e = cogsExp.get(c), r = ya.find((r) => dayDiff(iso(r.date), x.date) <= 7);
        const avg = e?.start && e.end ? fxAvg(fxRows, e.start, e.end) : null;
        if (!r || avg == null) continue;
        // 환율은 검증기가 따로 받은 연준 H.10(독립) — 원통화 값은 Yahoo(SEC 본표와 독립)라 공통모드가 아니다
        const cm = null;
        if (r.costOfRevenue != null) put(`${c} 매출원가`, IS[c]?.cogs, "Yahoo", r.costOfRevenue * avg, null, null, cm);
        if (r.grossProfit != null) put(`${c} 매출총이익`, IS[c]?.gp, "Yahoo", r.grossProfit * avg, null, null, cm);
      }
    }
    // 외화 공시 영업이익 연간(--metric=opinc) — 매출원가와 같은 방식(Yahoo 원통화 × 검증기 H.10 기간 평균). 인포맥스는 자체 환율 USD 값을 그대로
    // 넣는다 — 앱 = SEC 원통화 × H.10(A층 통과)이면 causeOf 첫 규칙이 NA "외부 환율 비공개"로 분류(기존 규칙)
    if (OPINC_MODE && foreign && fxRows) {
      for (const [c, x] of Object.entries(H)) {
        if (c === "LTM") continue;
        const e = opincExp.get(c), r = ya.find((r) => dayDiff(iso(r.date), x.date) <= 7);
        const avg = e?.start && e.end ? fxAvg(fxRows, e.start, e.end) : null;
        if (r?.totalOperatingIncomeAsReported != null && avg != null) put(`${c} 영업이익`, IS[c]?.op, "Yahoo", r.totalOperatingIncomeAsReported * avg, null);
        const im = imAnnual?.find((q) => dayDiff(q.end, x.date) <= 7);
        if (im?.op != null) put(`${c} 영업이익`, IS[c]?.op, "인포맥스", im.op, imAnnual.unit);
      }
    }
    // 외화 공시 감가상각비 연간(--metric=da) — 매출원가와 같은 방식(Yahoo 원통화 × 검증기 H.10 기간 평균)
    if (DA_MODE && foreign && fxRows) {
      for (const [c, x] of Object.entries(H)) {
        if (c === "LTM") continue;
        const e = daExp.get(c), r = ya.find((r) => dayDiff(iso(r.date), x.date) <= 7);
        const avg = e?.start && e.end ? fxAvg(fxRows, e.start, e.end) : null;
        if (r?.reconciledDepreciation != null && avg != null) put(`${c} 감가상각비`, IS[c]?.da, "Yahoo", r.reconciledDepreciation * avg, null);
      }
    }
    const last4 = foreign ? [] : yq.filter((r) => r.totalOperatingIncomeAsReported != null).slice(-4);
    if (last4.length === 4 && dayDiff(iso(last4.at(-1).date), L.date) <= 7) {
      if (last4.every((r) => yEbitda(r) != null)) put("LTM EBITDA", L.ebitda, "Yahoo", last4.reduce((s, r) => s + yEbitda(r), 0));
      if (last4.every((r) => r.totalRevenue != null)) put("LTM 매출", L.rev, "Yahoo", last4.reduce((s, r) => s + r.totalRevenue, 0));
      if (COGS_MODE && last4.every((r) => r.costOfRevenue != null)) put("LTM 매출원가", IS.LTM?.cogs, "Yahoo", last4.reduce((s, r) => s + r.costOfRevenue, 0));
      if (COGS_MODE && last4.every((r) => r.grossProfit != null)) put("LTM 매출총이익", IS.LTM?.gp, "Yahoo", last4.reduce((s, r) => s + r.grossProfit, 0));
      if (OPINC_MODE) put("LTM 영업이익", IS.LTM?.op, "Yahoo", last4.reduce((s, r) => s + r.totalOperatingIncomeAsReported, 0));
      if (DA_MODE && last4.every((r) => r.reconciledDepreciation != null)) put("LTM 감가상각비", IS.LTM?.da, "Yahoo", last4.reduce((s, r) => s + r.reconciledDepreciation, 0));
    }
    const bsq = yq.filter((r) => r.totalDebt != null).at(-1);
    if (bsq && !foreign && dayDiff(iso(bsq.date), L.date) <= 7) put("LTM 총차입금(운용리스 포함)", withLease, "Yahoo", bsq.totalDebt);
    // 블룸버그 표준화 B/S(분기) 단기 부채 + 장기 부채(2026-10-01)
    try { const bq0 = foreign ? null : loadBbg(sym)?.at(L.date); if (bq0?.bsStDebt && bq0?.bsLtDebt) put("LTM 총차입금(운용리스 포함)", withLease, "블룸버그", bq0.bsStDebt.v + bq0.bsLtDebt.v, bq0.bsStDebt.unit); } catch (e) { errs.push(`블룸버그 총차입금: ${String(e).slice(0, 80)}`); }

    // StockAnalysis — TTM 은 최근 분기말이 앱 LTM 기준일과 같을 때만
    if (!foreign) {
      try {
        const bq = await saStatement(sym, "balance-sheet", true);
        const qEnd = bq.datekey.find((d) => d !== "TTM");
        const ttmOk = qEnd && dayDiff(qEnd, L.date) <= 7;
        if (ttmOk) put("LTM 총차입금(운용리스 포함)", withLease, "StockAnalysis", bq.debt?.[bq.datekey.indexOf(qEnd)], unitOfAll(bq.debt ?? []));
        const ba = await saStatement(sym, "balance-sheet");
        for (const [c, x] of Object.entries(H)) {
          if (c === "LTM") continue;
          const k = ba.datekey.findIndex((d) => d !== "TTM" && dayDiff(d, x.date) <= 7);
          if (k >= 0 && ba.sharesOutTotalCommon?.[k] != null) saYearEndShares.set(c, ba.sharesOutTotalCommon[k]);
        }
        const inc = await saStatement(sym, "income-statement");
        // 표기 단위 — 대형주는 백만, 그 외는 천 단위(TER). 이 종목 SA 손익 전 기간 값으로 정한다(외부 표기 단위 반올림 식에만 쓴다)
        const saUnit = unitOfAll([inc.revenue, inc.netinc, inc.opinc].flat());
        for (const [c, x] of Object.entries(H)) {
          const k = c === "LTM" ? (ttmOk ? inc.datekey.indexOf("TTM") : -1) : inc.datekey.findIndex((d) => d !== "TTM" && dayDiff(d, x.date) <= 7);
          if (k < 0) continue;
          put(`${c} 매출`, x.rev, "StockAnalysis", inc.revenue?.[k], saUnit);
          put(`${c} 순이익`, x.ni, "StockAnalysis", inc.netinc?.[k], saUnit);
          // 희석 EPS(소수 둘째 자리 표기, 분할 소급) — 외화 공시는 원통화라 제외
          if (!foreign && c !== "LTM") put(`${c} 희석 EPS`, x.eps, "StockAnalysis", inc.epsdil?.[k], 0.01);
          put(`${c} EBITDA`, x.ebitda, "StockAnalysis", inc.ebitda?.[k], saUnit);
          put(`${c} 영업이익`, IS[c]?.op, "StockAnalysis", inc.opinc?.[k], saUnit);
          put(`${c} 감가상각비`, IS[c]?.da, "StockAnalysis", inc.depAmorEbitda?.[k], saUnit);
          if (COGS_MODE) { put(`${c} 매출원가`, IS[c]?.cogs, "StockAnalysis", inc.cor?.[k], saUnit); put(`${c} 매출총이익`, IS[c]?.gp, "StockAnalysis", inc.gp?.[k], saUnit); }
          saIsAdj.set(c, { aw: inc.assetWritedown?.[k] ?? 0, mr: inc.mergerRestructureCharges?.[k] ?? 0, ou: inc.otherUnusualItems?.[k] ?? 0, orv: inc.otherRevenue?.[k] ?? 0, opRev: inc.operatingRevenue?.[k] ?? null, ga: inc.gainAssets?.[k] ?? 0, cg: inc.currencyGains?.[k] ?? 0, ig: inc.impairmentGoodwill?.[k] ?? 0, ls: inc.legalSettlements?.[k] ?? 0, gi: inc.gainInvestments?.[k] ?? 0, ox: inc.otheropex?.[k] ?? 0 });
        }
        // 현금흐름표의 기타 상각 줄 — StockAnalysis 는 이 줄을 EBITDA 용 감가상각(depAmorEbitda)에서 뺀다(원인 ⑦)
        const cfs = await saStatement(sym, "cash-flow-statement");
        for (const [c, x] of Object.entries(H)) {
          const k = c === "LTM" ? (ttmOk ? cfs.datekey.indexOf("TTM") : -1) : cfs.datekey.findIndex((d) => d !== "TTM" && dayDiff(d, x.date) <= 7);
          if (k >= 0 && cfs.otherAmortization?.[k] != null) saOtherAmort.set(c, cfs.otherAmortization[k]);
        }
      } catch (e) {
        errs.push(`StockAnalysis: ${String(e).slice(0, 80)}`);
      }
    }

    // 인포맥스(FactSet) — 연간. 금액 표기 단위 = imAnnual.unit(실측 천 달러). 예전엔 백만 단위 허용(±50만, LTM ±200만)이라
    // IBM·MCD LTM 매출 +100만, TER −124.8만 같은 차이가 ① 로 숨었다(2026-09-26) — 이제 완전 일치만 ①
    // 외화 공시(20-F) — 인포맥스 USD 환산 매출(연간). 자체 환율이라 H.10 환산과 정확 일치하지 않으면 causeOf 가 "환율 출처 정의 차이 추정"(③)으로
    if (foreign && imAnnual) {
      for (const [c, x] of Object.entries(H)) {
        if (c === "LTM") continue;
        const im = imAnnual.find((r) => dayDiff(r.end, x.date) <= 7);
        if (im) put(`${c} 매출`, x.rev, "인포맥스", im.rev, imAnnual.unit);
      }
    }
    if (!foreign && imAnnual) {
      const iu = imAnnual.unit;
      for (const [c, x] of Object.entries(H)) {
        if (c === "LTM") continue;
        const im = imAnnual.find((r) => dayDiff(r.end, x.date) <= 7);
        if (!im) continue;
        put(`${c} 매출`, x.rev, "인포맥스", im.rev, iu);
        put(`${c} 순이익`, x.ni, "인포맥스", im.ni, iu);
        put(`${c} EBITDA`, x.ebitda, "인포맥스", im.ebitda, iu);
        put(`${c} 영업이익`, IS[c]?.op, "인포맥스", im.op, iu);
        // 인포맥스 감가상각비 = EBITDA − 영업이익(두 값 각각 표기 단위) — 반올림 식은 앱 EBITDA·영업이익 성분별
        put(`${c} 감가상각비`, IS[c]?.da, "인포맥스", im.da, iu, x.ebitda != null && IS[c]?.op != null ? [[1, x.ebitda], [-1, IS[c].op]] : null);
        put(`${c} 자산총계`, BS[c]?.assets, "인포맥스", im.assets, iu);
        // 인포맥스 EPS 는 순이익 ÷ 주식수 자체 계산, 소수 넷째 자리 표기. 앱(SEC 공시 EPS, 둘째 자리)과 다르면 ⑨ 가 식으로 분해
        put(`${c} 희석 EPS`, x.eps, "인포맥스", im.eps, 1e-4);
        // 시가총액 = 주식수 × 센트 종가 — 앱도 실제 체결가(호가 단위)를 곱하므로 반올림 식 없이 완전 일치만 ①(2026-09-26)
        put(`${c} 시가총액(결산일)`, x.mc, "인포맥스", im.mc, null);
        // 인포맥스는 매출총이익만 준다 — 매출원가 = 인포맥스 매출 − 매출총이익(두 값 각각 표기 단위 — 반올림 식은 앱 매출·매출총이익 성분별)
        if (COGS_MODE && im.rev != null && im.gp != null) {
          put(`${c} 매출원가`, IS[c]?.cogs, "인포맥스", im.rev - im.gp, iu, x.rev != null && IS[c]?.gp != null ? [[1, x.rev], [-1, IS[c].gp]] : null);
          put(`${c} 매출총이익`, IS[c]?.gp, "인포맥스", im.gp, iu);
        }
        // 인포맥스 "ev희석화수량" 은 표준 EV 가 아니다 — AAPL 2025: EV − 시가총액 = +1,168억 ≈ 인포맥스 총채무(채무자본금×자본총계
        // 1,124억), 현금을 빼지 않은 값으로 보인다. 정의가 다른 값이라 대조하지 않는다(시가총액은 일치 확인됨).
      }
      // LTM — 인포맥스 분기 4개 합(최근 분기말이 앱 LTM 기준일과 같을 때만)
      const q4 = (imAnnual.quarters ?? []).filter((r) => r.end <= L.date || dayDiff(r.end, L.date) <= 7).slice(-4);
      if (q4.length === 4 && dayDiff(q4[3].end, L.date) <= 7) {
        const sum = (k) => (q4.every((r) => r[k] != null) ? q4.reduce((s, r) => s + r[k], 0) : null);
        // 분기 4개 합 — 앱에는 분기값이 없어 반올림 식을 세우지 않는다(unit null). 완전 일치가 아니면 원인 규칙(매출 R4·R8) 또는 ③
        put("LTM 매출", L.rev, "인포맥스", sum("rev"), null);
        put("LTM 순이익", L.ni, "인포맥스", sum("ni"), null);
        put("LTM EBITDA", L.ebitda, "인포맥스", sum("ebitda"), null);
        put("LTM 영업이익", IS.LTM?.op, "인포맥스", sum("op"), null);
        put("LTM 감가상각비", IS.LTM?.da, "인포맥스", sum("da"), null);
        if (COGS_MODE && sum("rev") != null && sum("gp") != null) { put("LTM 매출원가", IS.LTM?.cogs, "인포맥스", sum("rev") - sum("gp"), null); put("LTM 매출총이익", IS.LTM?.gp, "인포맥스", sum("gp"), null); }
      }
    }
    try {
      const im = await infomaxShares(sym);
      const px = ov?.quote?.last;
      // 공통모드 — 앱 현재 주식수가 곧 인포맥스 주식수(us/current-shares.ts 보정)라 일치는 동어반복(오너 결정 2026-09-26)
      if (im && px && L.mc) put("현재 주식수(시총÷현재가)", L.mc / px, "인포맥스", im.shares, 1e3, null, "앱 현재 주식수 = 인포맥스 주식수(동어반복)"); // 인포맥스 주식수는 천 주 표기
    } catch (e) {
      errs.push(`인포맥스 주식수: ${String(e).slice(0, 60)}`);
    }

    // 판관비·연구개발비(--metric=sga) — Yahoo(sellingGeneralAndAdministration·researchAndDevelopment, 달러 정수)·StockAnalysis(sgna·rnd, 종목 단위)는
    // 두 항목 따로, 인포맥스(FactSet 판매비와관리비 = 연구개발비 포함)는 "판관비·연구개발비" 합 항목(Yahoo·SA 도 합으로 함께 넣어 비교). 앱 합 = 판관비 +
    // 연구개발비(연구개발비가 "본표에 줄 없음" 빈칸이면 0). 20-F 는 Yahoo 연간 원통화 × 검증기 H.10 기간 평균만(매출원가와 같은 방식)
    const sgaSum = (c) => (IS[c]?.sga == null ? null : IS[c].rnd != null ? IS[c].sga + IS[c].rnd : IS[c].rndNoLine ? IS[c].sga : null);
    let saQSga = null, imSga = null; // StockAnalysis 분기 손익·인포맥스 판관비(LTM 분기 합 원인 규칙용)
    // ── 재무상태표·현금흐름표 외부 대조(--metric=bscf, 2026-10-01) — 야후·StockAnalysis 값을 손익과 같은 방식(①②·외부 단독 이탈·③)으로 분류.
    //    앱 값 = 앱 재무상태표·현금흐름표 화면 값(:alt 별도 줄 포함), A층 전제 = "재무상태표·현금흐름표 X 앱 = SEC" 통과
    if (BSCF_MODE && bs && fetched.cf && !foreign) {
      const iso = (d) => new Date(d).toISOString().slice(0, 10);
      const itemsOf = (st) => (st?.sections ?? []).flatMap((s0) => s0.items ?? []);
      const bsI = itemsOf(bs), cfI = itemsOf(fetched.cf);
      const appv = (items, id, c) => {
        const key = c === "LTM" ? "현재/LTM" : c;
        const it = items.find((x) => x.accountId === id), alt = items.find((x) => x.accountId === `${id}:alt`);
        return it?.values?.[key] ?? alt?.values?.[key] ?? null;
      };
      // [항목, 앱 줄, 야후 필드, SA 필드]
      const BSX = [["재무상태표 현금·현금성자산", "bs:자산:현금·현금성자산", "cashAndCashEquivalents", "cashneq"], ["재무상태표 유동자산 총계", "bs:자산:유동자산 총계", "currentAssets", "assetsc"],
        ["재무상태표 유동부채 총계", "bs:부채:유동부채 총계", "currentLiabilities", "currentLiabilities"], ["재무상태표 부채 총계", "bs:부채:부채 총계", "totalLiabilitiesNetMinorityInterest", "liabilities"],
        ["재무상태표 자본 총계", "bs:자본:자본 총계", "stockholdersEquity", "equity"]];
      const CFX = [["현금흐름표 영업활동 현금흐름", "cf:total:영업활동 현금흐름", "operatingCashFlow", "ncfo"], ["현금흐름표 투자활동 현금흐름", "cf:total:투자활동 현금흐름", "investingCashFlow", "ncfi"],
        ["현금흐름표 재무활동 현금흐름", "cf:total:재무활동 현금흐름", "financingCashFlow", "ncff"], ["현금흐름표 유형자산 취득(CAPEX)", "cf:투자활동 현금흐름:유형자산 취득", "capitalExpenditure", "capex"],
        ["현금흐름표 배당금 지급", "cf:재무활동 현금흐름:배당금 지급", "cashDividendsPaid", "commonDividendCF"], ["현금흐름표 자기주식 취득", "cf:재무활동 현금흐름:자기주식 취득", "repurchaseOfCapitalStock", "commonRepurchased"],
        ["현금흐름표 주식보상비용", "cf:영업활동 현금흐름:주식보상비용", "stockBasedCompensation", "sbcomp"]];
      try {
        const y0 = await yahoo();
        const yb = await y0.fundamentalsTimeSeries(sym, { period1: "2019-01-01", type: "annual", module: "balance-sheet" }, { validateResult: false });
        const yc = await y0.fundamentalsTimeSeries(sym, { period1: "2019-01-01", type: "annual", module: "cash-flow" }, { validateResult: false });
        const ybq = H.LTM?.date ? await y0.fundamentalsTimeSeries(sym, { period1: new Date(Date.parse(H.LTM.date) - 200 * 864e5), type: "quarterly", module: "balance-sheet" }, { validateResult: false }) : [];
        const yct = H.LTM?.date ? await y0.fundamentalsTimeSeries(sym, { period1: new Date(Date.parse(H.LTM.date) - 400 * 864e5), type: "trailing", module: "cash-flow" }, { validateResult: false }) : [];
        for (const [c, x] of Object.entries(H)) {
          if (!x?.date) continue;
          const at = (arr) => arr.find((r) => dayDiff(iso(r.date), x.date) <= 7);
          const rb = c === "LTM" ? at(ybq) : at(yb), rcf = c === "LTM" ? at(yct) : at(yc);
          for (const [item, id, yk] of BSX) if (rb?.[yk] != null) put(`${c} ${item}`, appv(bsI, id, c), "Yahoo", rb[yk]);
          for (const [item, id, yk] of CFX) if (rcf?.[yk] != null) put(`${c} ${item}`, appv(cfI, id, c), "Yahoo", rcf[yk]);
        }
      } catch (e) { errs.push(`Yahoo 재무상태표·현금흐름표: ${String(e).slice(0, 80)}`); }
      try {
        const sb = await saStatement(sym, "balance-sheet"), sc = await saStatement(sym, "cash-flow-statement");
        const uB = unitOfAll([sb.assetsc, sb.liabilities, sb.equity].flat()), uC = unitOfAll([sc.ncfo, sc.ncfi, sc.ncff].flat());
        // TTM 열은 그 끝(분기 화면 첫 열)이 앱 LTM 기준일과 같을 때만(2026-10-01 MU — SA 는 FY2026 10-K(2026-09-03)까지 반영, 앱 LTM 은 직전 분기 → 기간이 달라
        // 투자활동 −61,641 vs −24,886 등이 ③ 으로 잡혔다)
        let saQEnd = null;
        try { saQEnd = (await saStatement(sym, "cash-flow-statement", true)).datekey.find((d) => d !== "TTM") ?? null; } catch (e) { hardErrors.push(`StockAnalysis 분기 현금흐름 조회 실패(TTM 대조 안 함): ${String(e).slice(0, 80)}`); }
        const ttmOk = !!(saQEnd && H.LTM?.date && dayDiff(saQEnd, H.LTM.date) <= 7);
        for (const [c, x] of Object.entries(H)) {
          if (!x?.date) continue;
          const kOf = (f) => (c === "LTM" ? (ttmOk ? f.datekey.indexOf("TTM") : -1) : f.datekey.findIndex((d) => d !== "TTM" && dayDiff(d, x.date) <= 7));
          const kb = kOf(sb), kc = kOf(sc);
          if (kb >= 0) for (const [item, id, , sk] of BSX) if (sb[sk]?.[kb] != null) put(`${c} ${item}`, appv(bsI, id, c), "StockAnalysis", sb[sk][kb], uB);
          if (kc >= 0) for (const [item, id, , sk] of CFX) if (sc[sk]?.[kc] != null) put(`${c} ${item}`, appv(cfI, id, c), "StockAnalysis", sc[sk][kc], uC);
        }
      } catch (e) { errs.push(`StockAnalysis 재무상태표·현금흐름표: ${String(e).slice(0, 80)}`); }
      // 블룸버그(2026-10-01) — 표준화 B/S(재무상태표 5줄) + 요약 화면 영업활동 현금흐름·자본지출. 현금흐름표 전체 화면은 스냅샷에 없어 나머지 줄은 대조 안 함
      try {
        const bb = loadBbg(sym);
        if (bb) for (const [c, x] of Object.entries(H)) {
          if (!x?.date) continue;
          const b = bb.at(x.date);
          for (const [item, id, k] of [["재무상태표 현금·현금성자산", "bs:자산:현금·현금성자산", "bsCash"], ["재무상태표 유동자산 총계", "bs:자산:유동자산 총계", "bsCa"], ["재무상태표 유동부채 총계", "bs:부채:유동부채 총계", "bsCl"],
            ["재무상태표 부채 총계", "bs:부채:부채 총계", "bsL"], ["재무상태표 자본 총계", "bs:자본:자본 총계", "bsEq"]])
            if (b[k]) put(`${c} ${item}`, appv(bsI, id, c), "블룸버그", b[k].v, b[k].unit);
          // 요약 화면 값 우선, 없으면 현금흐름표(표준화) — 같은 소스를 한 칸에 두 번 싣지 않는다
          b.cfOcf ??= b.cfOcfS; b.cfCapex ??= b.cfCapexS;
          for (const [item, id, k] of [["현금흐름표 영업활동 현금흐름", "cf:total:영업활동 현금흐름", "cfOcf"], ["현금흐름표 유형자산 취득(CAPEX)", "cf:투자활동 현금흐름:유형자산 취득", "cfCapex"],
            ["현금흐름표 투자활동 현금흐름", "cf:total:투자활동 현금흐름", "cfIcf"], ["현금흐름표 재무활동 현금흐름", "cf:total:재무활동 현금흐름", "cfFcf"],
            ["현금흐름표 배당금 지급", "cf:재무활동 현금흐름:배당금 지급", "cfDiv"], ["현금흐름표 자기주식 취득", "cf:재무활동 현금흐름:자기주식 취득", "cfBuyback"]])
            if (b[k]) put(`${c} ${item}`, appv(cfI, id, c), "블룸버그", b[k].v, b[k].unit);
        }
      } catch (e) { errs.push(`블룸버그 재무상태표·현금흐름표: ${String(e).slice(0, 80)}`); }
    }
    // 블룸버그(오너 결정 2026-09-28 — 정식 외부 소스): 오너가 준 FA 스냅샷(.cache/bbg, scripts/reference/bbg-import.mjs). 없는 종목은 건너뛴다.
    // BBG GAAP 화면은 SEC 공시 GAAP 를 그대로 싣는 기준이라 앱 로직 오류를 가장 직접 드러낸다. 외화 공시는 원통화라 제외
    try {
      const bb = foreign ? null : loadBbg(sym);
      if (bb) for (const [c, x] of Object.entries(H)) {
        const b = bb.at(x.date);
        b.da ??= b.daCf; // 조정 화면에 감가상각 칸이 없으면 현금흐름표(표준화) 감가상각비
        const P = (item, ours, k) => { if (b[k]) put(item, ours, "블룸버그", b[k].v, b[k].unit); };
        P(`${c} 매출`, x.rev, "rev");
        P(`${c} 순이익`, x.ni, "ni");
        if (c !== "LTM") P(`${c} 희석 EPS`, x.eps, "eps");
        P(`${c} EBITDA`, x.ebitda, "ebitda");
        P(`${c} 영업이익`, IS[c]?.op, "op");
        P(`${c} 감가상각비`, IS[c]?.da, "da");
        P(`${c} 세전이익`, IS[c]?.pretax, "pretax");
        if (COGS_MODE) { P(`${c} 매출원가`, IS[c]?.cogs, "cogs"); P(`${c} 매출총이익`, IS[c]?.gp, "gp"); }
        if (SGA_MODE) {
          P(`${c} 판관비`, IS[c]?.sga, "sga");
          P(`${c} 연구개발비`, IS[c]?.rnd, "rnd");
          if (b.sga) put(`${c} 판관비·연구개발비`, sgaSum(c), "블룸버그", b.sga.v + (b.rnd?.v ?? 0), b.sga.unit, IS[c]?.rnd != null && b.rnd ? [[1, IS[c].sga], [1, IS[c].rnd]] : null);
        }
      }
    } catch (e) { errs.push(`블룸버그: ${String(e).slice(0, 80)}`); }
    if (SGA_MODE) {
      const put3 = (c, name, sga, rnd, unit, fxk = 1) => {
        if (sga != null) put(`${c} 판관비`, IS[c]?.sga, name, sga * fxk, fxk === 1 ? unit : null);
        if (rnd != null) put(`${c} 연구개발비`, IS[c]?.rnd, name, rnd * fxk, fxk === 1 ? unit : null);
        // 합 — 외부 표기 단위 반올림 식은 성분별(각 칸이 따로 반올림돼 실린다)
        if (sga != null) put(`${c} 판관비·연구개발비`, sgaSum(c), name, (sga + (rnd ?? 0)) * fxk, fxk === 1 ? unit : null, fxk === 1 && IS[c]?.rnd != null && rnd != null ? [[1, IS[c].sga], [1, IS[c].rnd]] : null);
      };
      for (const [c, x] of Object.entries(H)) {
        if (c === "LTM") continue;
        const r = ya.find((r) => dayDiff(iso(r.date), x.date) <= 7);
        if (!r) continue;
        if (!foreign) put3(c, "Yahoo", r.sellingGeneralAndAdministration ?? null, r.researchAndDevelopment ?? null, 1);
        else if (fxRows) {
          const e = sgaExp.get(c), avg = e?.start && e.end ? fxAvg(fxRows, e.start, e.end) : null;
          if (avg != null) put3(c, "Yahoo", r.sellingGeneralAndAdministration ?? null, r.researchAndDevelopment ?? null, null, avg);
        }
      }
      if (!foreign && last4.length === 4 && dayDiff(iso(last4.at(-1).date), L.date) <= 7) {
        const s4 = (k) => (last4.every((r) => r[k] != null) ? last4.reduce((s, r) => s + r[k], 0) : null);
        put3("LTM", "Yahoo", s4("sellingGeneralAndAdministration"), s4("researchAndDevelopment"), 1);
      }
      if (!foreign) {
        try {
          const inc = await saStatement(sym, "income-statement");
          const saUnit = unitOfAll([inc.revenue, inc.netinc, inc.opinc].flat());
          const bq = await saStatement(sym, "income-statement", true);
          const qEnd = bq.datekey.find((d) => d !== "TTM"), ttmOk = qEnd && dayDiff(qEnd, L.date) <= 7;
          for (const [c, x] of Object.entries(H)) {
            const k = c === "LTM" ? (ttmOk ? inc.datekey.indexOf("TTM") : -1) : inc.datekey.findIndex((d) => d !== "TTM" && dayDiff(d, x.date) <= 7);
            if (k >= 0) put3(c, "StockAnalysis", inc.sgna?.[k] ?? null, inc.rnd?.[k] ?? null, saUnit);
          }
          saQSga = bq;
        } catch (e) { errs.push(`StockAnalysis 판관비: ${String(e).slice(0, 80)}`); }
        try {
          imSga = await infomaxSga(sym);
          for (const [c, x] of Object.entries(H)) {
            if (c === "LTM") continue;
            const im = imSga?.rows.find((r) => dayDiff(r.end, x.date) <= 7);
            // 인포맥스 판관비는 연구개발비 포함 — 합 항목에만(앱 합의 성분별 반올림 식)
            if (im?.sga != null) put(`${c} 판관비·연구개발비`, sgaSum(c), "인포맥스", im.sga, imSga.unit, IS[c]?.rnd != null ? [[1, IS[c].sga], [1, IS[c].rnd]] : null);
          }
          const q4 = (imSga?.quarters ?? []).filter((r) => r.end <= L.date || dayDiff(r.end, L.date) <= 7).slice(-4);
          if (q4.length === 4 && dayDiff(q4[3].end, L.date) <= 7 && q4.every((r) => r.sga != null)) put("LTM 판관비·연구개발비", sgaSum("LTM"), "인포맥스", q4.reduce((s, r) => s + r.sga, 0), null);
        } catch (e) { errs.push(`인포맥스 판관비: ${String(e).slice(0, 80)}`); }
      }
    }

    // 외부 불일치의 원인을 숫자로 확인한다(추정으로 통과시키지 않는다 — 식이 성립할 때만 "원인 확인").
    // 근거로 쓰는 A층은 허용치 없는 정확 대조(EXACT)만 — EPS(분할 반올림 허용)·금융사 근사식(앱 정의 재계산)은 제외(재감사)
    // 외화 공시(20-F)는 "환산 환율 = 기간 평균" 행이 SEC 원통화 × 검증기 H.10 정확 대조(독립)라 같은 전제로 쓴다
    // --metric=opinc: 영업이익 전제는 본표 판독 A층(소계 = 본표 영업이익 · 소계 없음 = 세전이익 − 영업외 항목)
    const EXACT_A = { 영업이익: OPINC_MODE ? /^영업이익(\(합성\))? 앱 = SEC (본표 영업이익|세전이익 − 영업외 항목)$/ : /^영업이익 앱 = SEC 영업이익$/, 매출: /^(매출 앱 = SEC 매출|매출 환산 환율 = 기간 평균\(외화\))$/, 순이익: /^((LTM )?순이익 앱 = SEC|순이익 환산 환율 = 기간 평균\(외화\))/, 자산총계: /^자산총계 앱 = SEC/, 매출원가: /^매출원가 앱 = SEC 매출원가$/, 매출총이익: /^매출총이익 앱 = SEC 매출총이익$/,
      // 감가상각비 전제(--metric=da)는 과거 10-K 까지 읽는 현금흐름표 줄 합 A층 — 기본 실행은 종전 원인 규칙(⑥⑦⑧)이 따로 판정하므로 넣지 않는다
      ...(DA_MODE ? { 감가상각비: /^감가상각비 앱 = SEC 현금흐름표 감가상각·상각 줄 합$/ } : {}),
      // 판관비·연구개발비(--metric=sga) — 본표 성격 줄 합 A층. 합 항목은 판관비 통과 + 연구개발비 통과(또는 "본표에 줄 없음" 빈칸 확인)
      ...(SGA_MODE ? { 판관비: /^판관비 앱 = SEC 본표 판관비 성격 줄 합$/, 연구개발비: /^연구개발비 앱 = SEC 본표 연구개발비 성격 줄 합$/, 연구개발비빈칸: /^연구개발비 빈칸 = SEC 본표에 줄 없음$/ } : {}),
      // 외부 단독 이탈 §0 을 EPS·세전이익·EBITDA 에도(오너 판단 2026-09-30 — "스탁만 다르면 단독 이탈") — 그 전제인 A층 검사 이름
      "희석 EPS": /^EPS 앱 = SEC 공시 EPS\(분할 보정\)$/, 세전이익: /^세전이익 앱 = SEC 세전이익$/,
      // 재무상태표·현금흐름표 외부 대조(--metric=bscf) — 전제 = 그 줄의 A층 SEC 대조 통과
      ...Object.fromEntries(["재무상태표 현금·현금성자산", "재무상태표 유동자산 총계", "재무상태표 유동부채 총계", "재무상태표 부채 총계", "재무상태표 자본 총계", "현금흐름표 영업활동 현금흐름", "현금흐름표 투자활동 현금흐름", "현금흐름표 재무활동 현금흐름", "현금흐름표 유형자산 취득(CAPEX)", "현금흐름표 배당금 지급", "현금흐름표 자기주식 취득", "현금흐름표 주식보상비용"].map((m) => [m, new RegExp("^" + m.replace(/[()]/g, "\\$&") + " 앱 = SEC$")])) };
    const aPassed0 = (col, metric) => EXACT_A[metric] && checks.some((k) => k.col === col && k.status === PASS && EXACT_A[metric].test(k.name));
    /** A층 검증불가 — 그 칸의 전제 검사(EXACT_A)가 통과는 없고 검증불가(NA)만 있음(2026-09-30 IBM 감가상각비: 중단사업 손익이 있는데 중단사업 감가상각
     *  태그 없음 — 계속사업분인지 확인 불가). ③(앱 문제 후보)과 구분해 "A층검증불가"로 표시 */
    const aNa0 = (col, metric) => EXACT_A[metric] && !aPassed0(col, metric) && checks.some((k) => k.col === col && k.status === NA && EXACT_A[metric].test(k.name));
    const aNa = (col, metric) => (metric === "EBITDA" ? (aNa0(col, "영업이익") || aNa0(col, "감가상각비")) && !(aPassed0(col, "영업이익") && aPassed0(col, "감가상각비"))
      : metric === "판관비·연구개발비" ? aNa0(col, "판관비") || aNa0(col, "연구개발비") : aNa0(col, metric));
    const aPassedOuter = (col, metric) => aPassed(col, metric);
    const aPassed = (col, metric) => (metric === "판관비·연구개발비" ? aPassed0(col, "판관비") && (aPassed0(col, "연구개발비") || aPassed0(col, "연구개발비빈칸"))
      : metric === "EBITDA" ? aPassed0(col, "영업이익") && aPassed0(col, "감가상각비") // EBITDA = 영업이익 + 감가상각비, 두 성분 모두 A층 통과
      : aPassed0(col, metric));
    /**
     * CAT 형 Yahoo 매출원가 = 본표 원가 + 본표 금융 부문 이자비용 줄("Interest expense of Financial Products"). ② 는 Yahoo 매출원가를
     * 대조한 **모든** 열(연간·LTM)에서 앱 = SEC 본표(A층) 이고 달러 단위까지 정확히 성립할 때만 — 한 기간이라도 안 맞거나 그 줄 값이
     * 없으면 규칙 전체를 쓰지 않는다(③ 유지). 실측 2026-09-26: CAT 2023·2024·2025 연간, 2025·2026 2분기 모두 정확 일치
     */
    let fpMemo;
    const yahooFpAll = () => {
      if (fpMemo !== undefined) return fpMemo;
      fpMemo = null;
      const items = [...recon.values()].filter((x) => /^(\d{4}Y|LTM) 매출원가$/.test(x.item) && x.srcs.Yahoo);
      const ev = [];
      let label = null;
      for (const x of items) {
        const col = x.item.split(" ")[0], e = cogsExp.get(col);
        if (e?.fpInt == null || !aPassed(col, "매출원가") || !extEq(x.srcs.Yahoo.v, x.ours + e.fpInt)) return fpMemo;
        label ??= e.fpIntLabel;
        ev.push(`${col} ${x.ours} + ${e.fpInt} = ${x.srcs.Yahoo.v}`);
      }
      if (ev.length) fpMemo = { label: label ?? "금융 부문 이자비용 줄", ev };
      return fpMemo;
    };
    // ── 매출원가 F층 전 열 규칙(2026-09-27) — yahooFpAll 과 같은 모양: 소스 n 이 대조된 매출원가 열(연간·LTM) 중 식을 SEC 원자료로 **계산할 수 있는
    //    모든 열**에서 앱 = SEC 본표(A층 정확 일치)이고 식이 외부 값과 정확히 같을 때만 ②. 계산되는 열이 하나라도 안 맞으면(또는 A층 미통과면) 규칙
    //    전체를 쓰지 않는다. 식을 계산할 수 없는 열(구성 공시가 그 항목을 싣지 않음 — 0 으로 채우지 않는다, 그림자 채우기 금지)은 증거에서 빼고 ②도
    //    주지 않는다(③ 유지 + 사유). 계산된 열 2개 이상 + 한 열 이상 비자명(식 ≠ 앱)일 때만. 허용 오차 없음 — StockAnalysis 만 자기 표기
    //    단위(unitOfAll) 반올림 식 인정(열마다 식 전체 1회)
    // ── S&P 비경상 줄(2026-09-29 — StockAnalysis 표준화 화면이 세전이익 위에 따로 싣는 줄). StockAnalysis(S&P Global 표준화)는 이 금액을 영업 비용
    //    줄(매출원가·판관비)과 영업이익에서 빼서 이 줄로 옮긴다 — 최근 연도 As Reported 대조로 확인(ORCL·INTC·DELL·AMD 구조조정, SBUX·BE 자산 상각,
    //    AMAT 영업권 손상). 값은 S&P 자신이 적은 금액(손익 부호 — 비용이 음수), 그 해 줄이 없으면 0. 한두 줄 ·세 줄 조합까지(ORCL 2022 = 구조조정 + 소송 합의 + 기타 비경상 — 우연 일치 방지로 네 줄 이상 금지), 각 지표의 전 열
    //    규칙(모든 연간 열 정확 성립)으로만 쓴다. 비용 줄: 외부 = 앱 + Σ줄, 영업이익: 외부 = 앱 − Σ줄
    const SP_UNUSUAL = [["mr", "합병·구조조정"], ["aw", "자산 상각"], ["ig", "영업권 손상"], ["ls", "소송 합의"], ["ou", "기타 비경상"], ["ga", "자산 처분손익"], ["gi", "투자 처분손익"], ["cg", "외환손익"]]; // cg: VRT 외환손실을 영업이익에서 뺌(2026-09-29)
    const spSubsets = []; // VERIFY_NO_SP=1 — 규칙 끄기(전후 비교용)
    if (!process.env.VERIFY_NO_SP) for (let i = 0; i < SP_UNUSUAL.length; i++) { spSubsets.push([SP_UNUSUAL[i]]); for (let j = i + 1; j < SP_UNUSUAL.length; j++) { spSubsets.push([SP_UNUSUAL[i], SP_UNUSUAL[j]]); for (let l = j + 1; l < SP_UNUSUAL.length; l++) spSubsets.push([SP_UNUSUAL[i], SP_UNUSUAL[j], SP_UNUSUAL[l]]); } }
    spSubsets.sort((a, b) => a.length - b.length); // 가장 작은 조합 먼저 — 금액 0 인 줄이 규칙 이름에 섞이지 않게
    const spTerm = (use, c) => {
      const a = saIsAdj.get(c);
      if (!a) return { skip: "그 열 StockAnalysis 비경상 줄 미조회" };
      const nzr = use.filter(([k]) => a[k]).length; return { s: use.reduce((t, [k]) => t + (a[k] ?? 0), 0), tol: nzr >= 1 ? 0.5e6 * (nzr + 1) : null, ev: use.map(([k, l]) => `S&P ${l} ${a[k] ?? 0}`).join(" + ") + (nzr >= 1 ? ` (S&P 줄 ${nzr}개와 SA 값이 각각 백만 단위 표기 — 성분별 반올림 허용 ±${0.5 * (nzr + 1)}백만)` : "") };
    };
    const spLabel = (use, m) => `StockAnalysis(S&P 표준화)는 ${use.map(([, l]) => l).join("·")} 금액을 ${m}에서 빼서 비경상 줄로 옮김 — S&P 자신이 적은 비경상 줄 금액으로 정확 성립`;
    const cogsCols = (n) => [...recon.values()].filter((x) => /^(\d{4}Y|LTM) 매출원가$/.test(x.item) && x.srcs[n]);
    const allColsMemo = new Map();
    /** expOf(col, x, e) → { exp, ev } | { skip: 사유 }(식 계산 불가) | null(식 불성립). 성립 시 { ev: [열별 근거], cols: Set(② 열), skipped: [[열, 사유]] } */
    const cogsAllCols = (n, key, expOf) => {
      const k = `${n}|${key}`;
      if (allColsMemo.has(k)) return allColsMemo.get(k);
      let out = null;
      const items = cogsCols(n), ev = [], cols = new Set(), skipped = [];
      let nonTrivial = false, ok = items.length > 0;
      for (const x of items) {
        const col = x.item.split(" ")[0], e = cogsExp.get(col);
        const r0 = e && e.cogs != null && aPassed(col, "매출원가") ? expOf(col, x, e) : null;
        if (r0?.skip) { skipped.push([col, r0.skip]); continue; }
        const u = x.srcs[n].unit ?? 1; // 외부 표기 단위 반올림 식 1회 — 모든 소스(2026-09-29: 블룸버그 0.01백만 표기 — NFLX 감가상각비 336.682 → 336.68)
        const hit0 = !!r0 && r0.exp != null && (extEq(x.srcs[n].v, r0.exp) || (u !== 1 && extRound(n, x.srcs[n].v, r0.exp, u)) || (r0.tol != null && Math.abs(x.srcs[n].v - r0.exp) <= r0.tol));
        // LTM 은 식이 정확 성립할 때만 증거에 넣고, 안 맞아도 연간 규칙을 깨지 않는다(감가상각비 daAllCols 와 같은 원칙 — 2026-09-30 MAR StockAnalysis:
        // 연간 5개 열 = "자가·임차 등 원가" 줄, LTM 만 외부 자기 분기 합이라 다름). 연간 열은 2개 이상 성립해야
        if (col === "LTM" && !hit0) continue;
        if (!hit0) { ok = false; break; }
        if (!extEq(r0.exp, x.ours)) nonTrivial = true;
        cols.add(col);
        ev.push(`${col} ${r0.ev} = ${r0.exp}${extEq(x.srcs[n].v, r0.exp) ? "" : `(표기 단위 ${u} 반올림 → ${x.srcs[n].v})`}`);
      }
      if (ok && nonTrivial && [...cols].filter((c) => c !== "LTM").length >= 2) out = { ev, cols, skipped };
      allColsMemo.set(k, out);
      return out;
    };
    const shortId = (id) => id.replace(/^[a-z0-9-]+_/i, "");
    /**
     * 열 col 의 공시 원본 사실 합 — 원가 판독 구성분(연간 = 그 사업연도 본표 공시, LTM = 분기 4개 — 각 분기의 3개월·누적·사업연도·9개월, 분기 못 채우면 사업연도 + 당기 누적 − 전년 동기)마다 그 본표 공시
     * 원본(cogsInst — 준비 단계에서 읽음)에서 pick 이 고른 사실 합 × 부호. 구성분 원본에 그 사실이 없으면 { skip }(10-Q 가 연간 주석 항목을
     * 싣지 않는 경우 — 0 으로 채우지 않는다). 원본을 못 읽었으면 null(규칙 불성립)
     */
    const compsOf = (e) => e?.comps ?? (e?.faceAccn ? [{ start: e.start, end: e.end, k: 1, faceAccn: e.faceAccn }] : null);
    const cogsInstAt = (col, pick, e0 = null) => {
      const e = e0 ?? cogsExp.get(col);
      const comps = compsOf(e);
      if (!comps) return null;
      let v = 0;
      const parts = [];
      for (const c of comps) {
        const fs = cogsInst?.get(c.faceAccn);
        if (!fs) return null;
        const hit = pick(fs.filter((x) => dayDiff(x.start, c.start) <= 3 && dayDiff(x.end, c.end) <= 3), e);
        if (!hit.ev) return { skip: `${c.start}~${c.end} 구성 공시(${c.faceAccn})에 해당 사실 없음` };
        v += c.k * hit.v;
        parts.push(`${c.k < 0 ? "− " : comps.length > 1 ? "+ " : ""}[${c.start}~${c.end} ${hit.ev}]`);
      }
      return { v, ev: parts.join(" ") };
    };
    /** ⓐ 원가 위치(IncomeStatementLocationAxis = 원가·매출총이익·매장 운영비 멤버) 구조조정·손상·인수합병 비용. 개념마다 위치 축 하나짜리 사실,
     *  없으면 세분 멤버가 하나뿐일 때만 그 값(세분이 여럿이면 합계와 겹칠 수 있어 쓰지 않는다). 손익 부호가 개념마다 달라 크기로 합산 */
    const COST_LOC_RE = /CostOf|GrossMargin|GrossProfit|StoreOperating/i, COST_CHARGE_RE = /Restructur|Impair|Severance|BusinessCombination|Merger|AcquisitionRelated|Integration/i;
    const pickCostLoc = (fs) => {
      const byC = new Map();
      for (const x of fs) {
        // 위치 축은 두 이름(LOC_AXES) — CL 은 StatementOfIncomeLocationBalanceAxis 를 typed 차원(QName us-gaap:GrossProfit)으로 싣는다(2026-09-27)
        const loc = x.dims.find((d) => LOC_AXES.includes(d[0]));
        if (!loc || !COST_LOC_RE.test(loc[1]) || !COST_CHARGE_RE.test(x.id)) continue;
        const b = byC.get(x.id) ?? { only: new Map(), more: new Map() };
        (x.dims.length === 1 ? b.only : b.more).set(x.dims.map((d) => d.join("=")).join(","), x);
        byC.set(x.id, b);
      }
      let v = 0;
      const ev = [];
      for (const [id, b] of byC) {
        const use = b.only.size ? [...b.only.values()].slice(0, 1) : b.more.size === 1 ? [...b.more.values()] : [];
        for (const x of use) { v += Math.abs(x.v); ev.push(`${shortId(id)}[${x.dims.map((d) => d[1]).join(",")}] ${x.v}`); }
      }
      return { v, ev: ev.join(" + ") };
    };
    /** ⓑ 원가 줄 안에 포함된 항목 — 개념명이 "…IncludedIn{원가 항 개념명}"인 차원 없는 사실(XOM 생산·제조비 안 세금) */
    const pickIncluded = (fs, e) => {
      const lines = new Set((e?.terms ?? []).map((t) => shortId(t.id.split("[")[0])));
      const seen = new Map();
      for (const x of fs) { const m = /IncludedIn(\w+)$/.exec(shortId(x.id)); if (m && lines.has(m[1]) && !x.dims.length) seen.set(x.id, x); }
      return { v: [...seen.values()].reduce((t, x) => t + x.v, 0), ev: [...seen.values()].map((x) => `${shortId(x.id)} ${x.v}`).join(" + ") };
    };
    /** 원가 항 개념의 ProductOrServiceAxis 멤버 사실(차원 하나짜리) — 본표가 원가를 제품·서비스·금융 등 멤버 줄로 나눠 싣는 경우(IBM·GEV) */
    const costMembers = (fs, e) => {
      const ids = new Set((e?.terms ?? []).map((t) => t.id.split("[")[0]));
      const seen = new Map();
      for (const x of fs) if (ids.has(x.id) && x.dims.length === 1 && x.dims[0][0] === "ProductOrServiceAxis") seen.set(`${x.id}|${x.dims[0][1]}`, x);
      return [...seen.values()];
    };
    const sumEv = (xs) => ({ v: xs.reduce((t, x) => t + x.v, 0), ev: xs.map((x) => `${shortId(x.id)}[${x.dims[0][1]}] ${x.v}`).join(" + ") });
    /** ⓒ 원가 멤버 줄 합(금융 부문 제외) — 금융 부문 멤버(…Financ…)가 있을 때만(IBM "Financing" 원가를 뺀 서비스·판매 원가 줄 합) */
    const pickNonFinMembers = (fs, e) => {
      const ms = costMembers(fs, e);
      return ms.some((x) => /Financ/i.test(x.dims[0][1])) ? sumEv(ms.filter((x) => !/Financ/i.test(x.dims[0][1]))) : { v: 0, ev: "" };
    };
    /** 원가 멤버 줄 전부의 합(줄마다 회사 반올림 — 합계 줄과 다를 수 있음). 멤버 2개 이상일 때만 */
    const pickAllMembers = (fs, e) => { const ms = costMembers(fs, e); return ms.length >= 2 ? sumEv(ms) : { v: 0, ev: "" }; };
    /** ⓐ' 원가 위치 비용(부호 그대로 — 환입은 음수) + 인수 재고 공정가치 조정 상각(본표 줄). MRVL(2026-09-29): S&P 는 둘 다 원가에서 빼서
     *  "합병·구조조정"으로 옮긴다 — FY2022 재고 조정 194.3 + 원가 구조조정 환입 −0.753 = 193.5, FY2023 38.7, FY2025 원가 구조조정 357.9. 위치 사실이
     *  개념 여럿이면 크기가 가장 큰 것(합계)만 — 세분과 겹치지 않게. 재고 조정 줄이 그 공시에 없으면 0(항목 없는 해). 둘 다 없으면 사실 없음 */
    const STEPUP_RE = /Inventor\w*(FairValue|StepUp|Stepup)|(FairValue|StepUp|Stepup)\w*Inventor/i;
    const pickLocStepUp = (fs) => {
      const loc = new Map(), su = new Map();
      for (const x of fs) {
        if (x.dims.length === 1 && LOC_AXES.includes(x.dims[0][0]) && COST_LOC_RE.test(x.dims[0][1]) && COST_CHARGE_RE.test(x.id) && !/Gain|Income/i.test(x.id)) loc.set(x.id, x);
        if (!x.dims.length && STEPUP_RE.test(x.id)) su.set(x.id, x);
      }
      if (!loc.size && !su.size) return { v: 0, ev: "" };
      const l = [...loc.values()].sort((a, b) => Math.abs(b.v) - Math.abs(a.v))[0], s = [...su.values()][0];
      const ev = [l ? `${shortId(l.id)}[${l.dims[0][1]}] ${l.v}` : "원가 위치 비용 없음 0", s ? `${shortId(s.id)} ${s.v}` : "재고 조정 상각 줄 없음 0"];
      return { v: (l?.v ?? 0) + (s?.v ?? 0), ev: ev.join(" + ") };
    };
    // [키, 설명, 사실 선택, keep(true = SA = 고른 사실 합 / false = SA = 앱 − 고른 사실 합)]
    const SA_COGS_RULES = [
      ["loc", "원가 위치 구조조정·손상·인수합병 비용(IncomeStatementLocationAxis)", pickCostLoc, false],
      ["loc-stepup", "원가 위치 구조조정 비용(환입 포함) + 인수 재고 공정가치 조정 상각 — S&P 는 둘 다 합병·구조조정 줄로 옮김", pickLocStepUp, false],
      ["incl", "원가 줄 안 포함 항목(…IncludedIn{원가 줄})", pickIncluded, false],
      ["fin", "원가 멤버 줄 중 금융 부문(ProductOrServiceAxis=…Financ…) 제외 합", pickNonFinMembers, true],
    ];
    /** StockAnalysis 매출원가 = 앱 − 공시 원본 사실(ⓐ·ⓑ·ⓒ 중 하나) — 전 열 성립 */
    /** SA 분기 4개(LTM 창) — saQInc 에서 LTM 기준일로 끝나는 4개 분기 { end, v } */
    const saQuarters = () => {
      if (!saQInc || !L) return null;
      const qs = saQInc.datekey.map((d, i) => ({ end: d, v: saQInc.cor?.[i] ?? null })).filter((r) => r.end !== "TTM" && (r.end <= L.date || dayDiff(r.end, L.date) <= 7))
        .sort((a, b) => a.end.localeCompare(b.end)).slice(-4);
      return qs.length === 4 && dayDiff(qs[3].end, L.date) <= 7 && qs.every((q) => q.v != null) ? qs : null;
    };
    /** SEC 분기 본표 판독(3개월, 4분기 = 사업연도 − 9개월) — cogsQuarterSum·SA 분기 경로 공용 */
    const secQuarter = (end) => {
      if (!cogsFace) return null;
      // 외부 소스는 52/53주 결산 회사의 분기말을 달의 말일로 싣는다(NVDA 2025-10-26 → 2025-10-31) — ±7일 안에서 가장 가까운 SEC 분기(분기 간격 ~91일이라 겹치지 않음)
      for (let d = 0; d <= 7; d++) {
        for (const sg of d ? [1, -1] : [1]) {
          const E = new Date(Date.parse(end) + sg * d * 864e5).toISOString().slice(0, 10);
          const isQ4 = !!cogsFace.annualAt(E);
          const s = cogsFace.quarterAt(E, isQ4);
          if (s && dayDiff(s.end, E) <= 3) return s.err || s.mix || s.mixUnknown || s.cogs == null ? null : { ...s, isQ4 };
        }
      }
      return null;
    };
    const saCogsInst = () => {
      for (const [key, label, pick, keep] of SA_COGS_RULES) {
        const hit = cogsAllCols("StockAnalysis", `inst-${key}`, (col, x) => {
          const a = cogsInstAt(col, pick);
          if (a?.skip || !a) return a;
          const direct = keep ? { exp: a.v, ev: a.ev } : { exp: x.ours - a.v, ev: `앱 ${x.ours} − ${a.ev}` };
          const u = x.srcs.StockAnalysis.unit ?? 1;
          const same = (p, q) => extEq(p, q) || (u !== 1 && extEq(p, roundHalfAway(q, u)));
          if (col !== "LTM" || same(x.srcs.StockAnalysis.v, direct.exp)) return direct;
          // LTM 은 SA 가 분기 4개를 더한 값 — 분기마다 SA = SEC 분기 원가 − 그 분기 공시 사실(같은 식)이고 SA LTM = SA 분기 합일 때만
          const qs = saQuarters();
          if (!qs || !extEq(x.srcs.StockAnalysis.v, qs.reduce((t, q) => t + q.v, 0))) return direct;
          const rows = [];
          let exp = 0;
          for (const q of qs) {
            const s = secQuarter(q.end), b = s ? cogsInstAt(null, pick, s) : null;
            if (!s || !b || b.skip || !same(q.v, keep ? b.v : s.cogs - b.v)) return b?.skip ? b : direct;
            exp += q.v;
            rows.push(`${q.end} SA ${q.v} = SEC ${s.isQ4 ? "사업연도 − 9개월" : "3개월"} ${keep ? b.ev : `${s.cogs} − ${b.ev}`}`);
          }
          return { exp, ev: `SA 분기 합(${rows.join(" · ")})` };
        });
        if (hit) return { label, keep, ...hit };
      }
      return null;
    };
    /** 원가 항(구성 규칙 줄) 부분집합 — D형 구성 규칙 회사(2~5줄)만. 모든 열에서 같은 줄 조합이어야 한다(StockAnalysis 가 환급·인건비 줄을 뺌) */
    const termSubsetAll = (n) => {
      // 줄은 구성 규칙 라벨로 맞춘다(공시마다 대안 개념으로 태깅될 수 있어 개념명으로는 열 사이를 못 잇는다)
      const e0 = [...cogsExp.values()].find((e) => e?.rule && e.terms?.length);
      const labs = e0?.terms.map((t) => t.label) ?? [];
      if (labs.length < 2 || labs.length > 5) return null;
      for (let mask = 1; mask < (1 << labs.length) - 1; mask++) {
        const use = labs.filter((_, i) => mask & (1 << i));
        const hit = cogsAllCols(n, `sub-${use.join("+")}`, (col, x, e) => {
          if (!e.rule) return null;
          const ts = use.map((l) => e.terms?.find((t) => t.label === l));
          if (ts.some((t) => !t)) return null;
          return { exp: ts.reduce((s, t) => s + t.v, 0), ev: `구성 규칙 줄 ${ts.map((t) => `${t.label} ${t.v}`).join(" + ")}` };
        });
        if (hit) return { use, drop: labs.filter((l) => !use.includes(l)), ...hit };
      }
      return null;
    };
    /** D형(구성 규칙) 외부 = 앱 + 본표 감가상각·상각 줄(부분집합, 모든 열 같은 줄 조합) — Yahoo·인포맥스 */
    const daAddAll = (n) => {
      const e0 = [...cogsExp.values()].find((e) => /D/.test(e?.type ?? "") && e.da?.length);
      const ids = (e0?.da ?? []).map((t) => t.id).slice(0, 4);
      for (let mask = 1; mask < 1 << ids.length; mask++) {
        const use = ids.filter((_, i) => mask & (1 << i));
        const hit = cogsAllCols(n, `da-${use.join("+")}`, (col, x, e) => {
          if (!/D/.test(e.type ?? "")) return null;
          const ts = use.map((id) => e.da?.find((t) => t.id === id));
          if (ts.some((t) => !t || t.v == null)) return { skip: "본표 감가상각 줄 값 없음" };
          return { exp: x.ours + ts.reduce((s, t) => s + t.v, 0), ev: `앱 ${x.ours} + 본표 ${ts.map((t) => `${t.label} ${t.v}`).join(" + ")}` };
        });
        if (hit) return hit;
      }
      return null;
    };
    /**
     * LTM 분기 합 — 소스 n 의 LTM 매출원가 = 자기 분기 4개 합이고 분기마다 SEC 본표 3개월값(4분기 = 사업연도 − 9개월)과 정확히 같다(인포맥스·SA 는
     * 자기 표기 단위 반올림 식도 분기마다 인정). 앱 LTM 도 분기 4개 합(오너 결정 2026-09-28)이라 대개 ①로 끝나고, 이 규칙은 앱이 분기를 못 채워 종전 식을 쓴 열에서만 성립(차이는 회사가 분기·누적을 따로 반올림한 몫)
     */
    const qSumMemo = new Map();
    const cogsQuarterSum = (n) => {
      if (!["Yahoo", "인포맥스", "StockAnalysis"].includes(n)) return null; // 분기 자료가 있는 소스만(블룸버그는 LTM 합계뿐 — 예전엔 기본 분기로 StockAnalysis 값을 써서 블룸버그가 잘못 ② 판정)
      if (qSumMemo.has(n)) return qSumMemo.get(n);
      qSumMemo.set(n, null);
      const x = recon.get("LTM 매출원가");
      if (!x?.srcs[n] || !cogsFace || !aPassed("LTM", "매출원가")) return null;
      const near = (r) => r.end <= L.date || dayDiff(r.end, L.date) <= 7;
      const qs = n === "Yahoo" ? last4.map((r) => ({ end: iso(r.date), v: r.costOfRevenue ?? null }))
        : n === "인포맥스" ? (imAnnual?.quarters ?? []).filter(near).slice(-4).map((r) => ({ end: r.end, v: r.rev != null && r.gp != null ? r.rev - r.gp : null }))
        : saQInc ? saQInc.datekey.map((d, i) => ({ end: d, v: saQInc.cor?.[i] ?? null })).filter((r) => r.end !== "TTM" && near(r)).sort((a, b) => a.end.localeCompare(b.end)).slice(-4) : [];
      if (qs.length !== 4 || dayDiff(qs[3].end, L.date) > 7 || qs.some((q) => q.v == null)) return null;
      const u = n === "인포맥스" ? imAnnual?.unit ?? 1 : n === "StockAnalysis" ? x.srcs[n].unit ?? 1 : 1;
      const rows = [];
      let sec = 0;
      const same = (p, q) => extEq(p, q) || (u !== 1 && extEq(p, roundHalfAway(q, u)));
      const bad = [];
      for (const q of qs) {
        const s = secQuarter(q.end);
        if (!s) return null;
        const how = s.isQ4 ? "사업연도 − 9개월" : "3개월";
        if (same(q.v, s.cogs)) { sec += s.cogs; rows.push(`${q.end} ${q.v} = SEC ${how} ${s.cogs}${extEq(q.v, s.cogs) ? "" : `(표기 단위 ${u} 반올림)`}`); continue; }
        // 본표가 원가를 멤버 줄(제품·서비스)로 나눠 싣고 외부가 줄 합을 쓰는 경우 — 회사가 줄마다 반올림해 합계 줄과 다를 수 있다(GEV)
        const m = cogsInstAt(null, pickAllMembers, s);
        if (m && !m.skip && same(q.v, m.v)) { sec += m.v; rows.push(`${q.end} ${q.v} = SEC ${how} 원가 멤버 줄 합 ${m.ev}(합계 줄 ${s.cogs})`); continue; }
        // StockAnalysis 분기 = SEC 분기 원가 − 그 분기 원가 위치 구조조정·손상(규칙 ⓐ 의 분기판 — CL 2026 2분기 2,065 − 2, 2026-09-27)
        if (n === "StockAnalysis") {
          const lc = cogsInstAt(null, pickCostLoc, s);
          if (lc && !lc.skip && lc.v && same(q.v, s.cogs - lc.v)) { sec += s.cogs - lc.v; rows.push(`${q.end} ${q.v} = SEC ${how} ${s.cogs} − 원가 위치 비용 ${lc.ev}`); continue; }
        }
        bad.push({ q, s });
      }
      const tot = qs.reduce((t, q) => t + q.v, 0);
      if (!extEq(x.srcs[n].v, tot) || extEq(tot, x.ours)) return null;
      let out = null;
      if (!bad.length) out = { rows, sec };
      else if (n === "인포맥스") {
        // 인포맥스 자체 집계 불일치 — SEC 와 다른 분기가 모두 4분기이고, 그 사업연도 인포맥스 연간 = 앱 = SEC 본표(A층 정확 일치)인데 인포맥스
        // 분기 4개 합 ≠ 인포맥스 연간(자기 모순). 원인 확인이 아니라 외부 단독 이탈(연간 imSelfGap 과 같은 분류)
        const why = [];
        for (const { q, s } of bad) {
          const c = s.isQ4 ? Object.keys(H).find((k) => k !== "LTM" && dayDiff(H[k].date, s.end) <= 7) : null;
          const ya = c ? recon.get(`${c} 매출원가`) : null;
          if (!c || !ya?.srcs[n] || !extEq(ya.srcs[n].v, ya.ours) || !aPassed(c, "매출원가")) { why.length = 0; break; }
          const fq = (imAnnual?.quarters ?? []).filter((r) => { const g = (Date.parse(H[c].date) - Date.parse(r.end)) / 864e5; return g > -8 && g < 330; });
          const fs = fq.length === 4 && fq.every((r) => r.rev != null && r.gp != null) ? fq.reduce((t, r) => t + r.rev - r.gp, 0) : null;
          if (fs == null || extEq(fs, ya.srcs[n].v)) { why.length = 0; break; }
          why.push(`${q.end} 인포맥스 ${q.v} ≠ SEC 사업연도 − 9개월 ${s.cogs} — 인포맥스 ${c} 연간 ${ya.srcs[n].v}(= 앱 = SEC 본표) ≠ 자기 분기 4개 합 ${fs}`);
        }
        if (why.length === bad.length) out = { outlier: `외부 단독 이탈(인포맥스 자체 집계 불일치) — ${why.join(" · ")} · 나머지 분기는 SEC 분기값과 정확 일치(${rows.join(" · ")})` };
      }
      qSumMemo.set(n, out);
      return out;
    };
    /**
     * R4 분기별 대조 — 소스 n(Yahoo·인포맥스)의 LTM 분기 4개 각각이 SEC 3개월값(4분기 = 사업연도 − 9개월) 또는 그 10-Q 본표 매출 하위 줄
     * 3개월 합(revQParts)과 완전히 같은가. 인포맥스는 자기 표기 단위(imAnnual.unit) 반올림 식도 분기마다 인정(roundHalfAway).
     * → { ok, sum, rows, t, bad } | null(SEC TTM·분기 모델 없음)
     */
    const r4Quarters = (n) => {
      const ours = L?.rev;
      for (const tag of REV_TAGS) {
        const t = secTtm(tag);
        if (!t || ours == null || dayDiff(t.end, L.date) > 7 || !extEq(t.v, ours)) continue;
        const qs = secQuarterSum(tag, L.date);
        if (!qs) return null;
        const u = n === "인포맥스" ? imAnnual?.unit ?? 1 : 1;
        const srcQ = (end) => (n === "인포맥스" ? (imAnnual?.quarters ?? []).find((x) => dayDiff(x.end, end) <= 7)?.rev : yq.find((x) => dayDiff(iso(x.date), end) <= 7)?.totalRevenue) ?? null;
        const same = (a, b) => extEq(a, b) || (u !== 1 && extEq(a, roundHalfAway(b, u)));
        const rows = [], bad = [];
        let sum = 0;
        for (const p of qs.parts) {
          const sv = srcQ(p.end);
          if (sv == null) return { ok: false, rows, bad: [p.end], t };
          sum += sv;
          const pp = [...(revQParts ?? new Map())].find(([e]) => dayDiff(e, p.end) <= 7)?.[1];
          const sub = pp?.sums.find(([, x]) => same(sv, x));
          const secTxt = p.how === "3개월" ? `SEC 3개월 ${p.v}` : `SEC ${p.how} = ${p.v}`;
          if (same(sv, p.v)) rows.push(`${p.end} ${sv} = ${secTxt}${extEq(sv, p.v) ? "" : `(표기 단위 ${u} 반올림)`}`);
          else if (sub) rows.push(`${p.end} ${sv} = 본표 하위 줄 합 ${sub[1]}(${pp.src} ${sub[0]}; 합계 줄 ${pp.total}, 회사 반올림 차 ${sub[1] - pp.total})${extEq(sv, sub[1]) ? "" : `(표기 단위 ${u} 반올림)`}`);
          else { bad.push(p.end); rows.push(`${p.end} ${sv} ≠ ${secTxt}${pp ? ` · 본표 하위 줄 합 ${pp.sums.map(([, x]) => x).join("/")}` : ""}`); }
        }
        return { ok: !bad.length, sum, rows, t, bad };
      }
      return null;
    };
    // ── 영업이익 F층 규칙(--metric=opinc, 2026-09-27) — 매출원가 전 열 규칙(cogsAllCols)과 같은 모양. 소스 n 이 대조된 **모든 연간 열**에서 앱 =
    //    SEC 본표(A층 정확 일치)이고 SEC 원자료 식이 외부 값과 정확히 같을 때만 ②(2열 이상 · 한 열 이상 비자명 · 허용 오차 없음 — StockAnalysis 만
    //    자기 표기 단위 반올림 식 1회). 식을 계산할 수 없는 열(그 열 본표에 그 줄이 없음)은 증거에서 빼고 ②도 주지 않는다(0 으로 채우지 않음).
    //    LTM 열은 외부가 분기 합이라 같은 식이 정확 성립할 때만 그 규칙에 함께 넣고(안 맞아도 연간 규칙을 깨지 않는다), 따로 opQuarterSum 이 본다
    const opCols = (n) => [...recon.values()].filter((x) => /^(\d{4}Y|LTM) 영업이익$/.test(x.item) && x.srcs[n]);
    const opMemo = new Map();
    const opAllCols = (n, key, expOf) => {
      const mk = `${n}|${key}`;
      if (opMemo.has(mk)) return opMemo.get(mk);
      let out = null, ok = true, nonTrivial = false, nAnn = 0;
      const ev = [], cols = new Set(), skipped = [];
      for (const x of opCols(n)) {
        const col = x.item.split(" ")[0], e = opincExp.get(col);
        const r0 = e && aPassed(col, "영업이익") ? expOf(col, x, e) : null;
        if (r0?.skip) { skipped.push([col, r0.skip]); continue; }
        const u = x.srcs[n].unit ?? 1; // 외부 표기 단위 반올림 식 1회 — 모든 소스(2026-09-29: 블룸버그 0.01백만 표기 — NFLX 감가상각비 336.682 → 336.68)
        const hit = !!r0 && r0.exp != null && (extEq(x.srcs[n].v, r0.exp) || (u !== 1 && extRound(n, x.srcs[n].v, r0.exp, u)) || (r0.tol != null && Math.abs(x.srcs[n].v - r0.exp) <= r0.tol));
        const txt = hit ? `${col} ${r0.ev} = ${r0.exp}${extEq(x.srcs[n].v, r0.exp) ? "" : `(표기 단위 ${u} 반올림 → ${x.srcs[n].v})`}` : "";
        if (col === "LTM") { if (hit) { cols.add(col); ev.push(txt); } continue; }
        if (!hit) { ok = false; break; }
        nAnn++;
        if (!extEq(r0.exp, x.ours)) nonTrivial = true;
        cols.add(col);
        ev.push(txt);
      }
      if (ok && nonTrivial && nAnn >= 2) out = { ev, cols, skipped };
      opMemo.set(mk, out);
      return out;
    };
    const OP_NONOP_REV = "(총수익 안 비영업 수익)";
    /** 소스 n 의 열 col 에 성립하는 첫 전 열 규칙 → { label, ev, cols } | null */
    const opRule = (n, col) => {
      const exps = [...opincExp.entries()].filter(([c]) => c !== "LTM").map(([, e]) => e);
      const rules = [["latest", "나중 공시의 반올림 재게시 값(앱은 먼저 공시된 정밀값)", (c, x, e) => (e.type !== "F" || e.vLatest == null ? null
        : { exp: e.vLatest * (e.k ?? 1), ev: e.vLatest === e.v ? "재게시 없음(= 앱)" : `최신 판본 ${e.vLatest}(앱 ${e.v})` })]];
      // (나) 소계 있는 본표 — 외부가 영업이익 식 안의 일회성·인수 무형상각 줄을 뺀다: 외부 = 앱 − Σ(부호 × 줄 값). 줄 조합은 모든 열 같게
      const chIds = [...new Set(exps.flatMap((e) => (e.charges ?? []).map((t) => t.id)))].slice(0, 5);
      for (let mask = 1; mask < 1 << chIds.length; mask++) {
        const use = chIds.filter((_, i) => mask & (1 << i));
        rules.push([`ch-${use.join("+")}`, `앱은 영업이익 식 안 일회성·인수 무형상각 줄(${use.map(shortId).join(" · ")})을 비용으로 차감, 외부는 차감하지 않음`, (c, x, e) => {
          if (e.type !== "F") return null;
          // 그 열 본표에 줄이 없거나 값이 없으면 0(항목 없는 해 — 오너 결정 2026-09-28): 그 해는 외부 = 앱이어야 성립한다(증거에서 빼지 않음)
          // 개념 이름만 바뀐 같은 줄(MAR: 2021 …IntegrationRelatedCosts → 2022~ …IntegrationRelatedCostsAndOther)은 없음(0)이 아니다 — 한 줄 규칙에서
          // 그 열 본표에 같은 종류(일회성·상각) 줄이 하나뿐이면 그 줄을 같은 줄로 본다(판관비 개념 변경과 같은 원칙)
          const kindOf = (id) => exps.flatMap((y) => y.charges ?? []).find((t) => t.id === id)?.kind;
          const ts = use.map((id) => {
            const t = (e.charges ?? []).find((y) => y.id === id);
            if (t && t.v != null) return t;
            const same = use.length === 1 && !t ? (e.charges ?? []).filter((y) => y.kind === kindOf(id) && y.v != null) : [];
            if (same.length === 1) return { ...same[0], label: `${same[0].label}(개념 변경 — ${shortId(id)} 자리)` };
            return { id, w: -1, label: shortId(id), v: 0, none: true };
          });
          return { exp: x.ours - ts.reduce((s, t) => s + t.w * t.v, 0) * (e.k ?? 1), ev: `앱 ${x.ours} ${ts.map((t) => `${t.w < 0 ? "+" : "−"} ${t.label} ${t.v}${t.none ? "(그 열 본표에 없음 → 0)" : ""}`).join(" ")}` };
        }]);
      }
      // (나-2) 주석에만 있는 일회성 금액(오너 결정 2026-09-28 — DELL 퇴직 관련 비용·ORCL 구조조정은 본표 줄이 아니라 주석 태그): 표준 태그 하나만
      //    (조합 금지 — 우연 일치 방지), 본표 일회성 줄과 겹치지 않는 개념만. 앱(GAAP)은 이 금액을 어느 비용 줄 안에서 차감했고 외부는 차감하지 않음:
      //    외부 = 앱 + 금액. 그 연도 10-K 의 연간 값(최신 제출분), 없으면 0 — 모든 연간 열에서 정확 성립해야 한다(opAllCols)
      const faceIds = new Set(exps.flatMap((e) => (e.charges ?? []).map((t) => t.id)));
      const noteVal = (concept, e) => {
        const es = (G[concept]?.units?.USD ?? []).filter((y) => y.start && /^10-K/.test(y.form ?? "") && dayDiff(y.end, e.end) <= 7 && (Date.parse(y.end) - Date.parse(y.start)) / 864e5 > 300);
        return es.length ? es.sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? ""))[0].val : null;
      };
      for (const concept of NOTE_ONEOFF) {
        if (faceIds.has(`us-gaap_${concept}`) || !exps.some((e) => e.type === "F" && e.end && noteVal(concept, e))) continue;
        rules.push([`note-${concept}`, `앱은 주석 일회성 금액(${concept})을 비용 줄 안에서 차감, 외부는 차감하지 않음`, (c, x, e) => {
          if (e.type !== "F" || !e.end) return null;
          const v = noteVal(concept, e);
          return { exp: x.ours + (v ?? 0) * (e.k ?? 1), ev: `앱 ${x.ours} + 주석 ${concept} ${v ?? "0(그 해 없음)"}` };
        }]);
      }
      // (다) 소계 없는 본표 — 외부가 영업외 줄 일부를 영업이익에 남긴다: 외부 = 앱 + Σ(부호 × 남긴 줄). 줄 조합은 모든 열 같게
      const itIds = [...new Set(exps.flatMap((e) => [...(e.items ?? []).map((t) => t.id), ...(e.nonopRev != null ? [OP_NONOP_REV] : [])]))].slice(0, 6);
      for (let mask = 1; mask < 1 << itIds.length; mask++) {
        const use = itIds.filter((_, i) => mask & (1 << i));
        rules.push([`it-${use.join("+")}`, `앱 + 영업외 줄 ${use.map(shortId).join(" · ")}(외부는 이 줄을 영업이익에 남김)`, (c, x, e) => {
          if (!/S/.test(e.type)) return null;
          let add = 0;
          const ev = [];
          for (const id of use) {
            if (id === OP_NONOP_REV) { if (e.nonopRev == null) return { skip: "비영업 수익 값 없음" }; add += e.nonopRev * (e.k ?? 1); ev.push(`+ 비영업 수익 ${e.nonopRev}`); continue; }
            const t = (e.items ?? []).find((y) => y.id === id);
            if (!t || t.v == null) return { skip: `${shortId(id)} 그 열 본표에 값 없음` };
            add += t.w * t.v * (e.k ?? 1);
            ev.push(`${t.w < 0 ? "−" : "+"} ${t.label} ${t.v}`);
          }
          return { exp: x.ours + add, ev: `앱 ${x.ours} ${ev.join(" ")}` };
        }]);
      }
      // (라) S&P 비경상 줄 — StockAnalysis 영업이익 = 앱 − Σ(S&P 비경상 줄). 소계 있는 본표만(소계 없는 본표는 R7 이 따로 본다)
      if (n === "StockAnalysis") for (const use of spSubsets) {
        rules.push([`sp-${use.map(([k]) => k).join("+")}`, spLabel(use, "영업이익"), (c, x, e) => {
          if (!e) return null; // F·S 모두(MRK 합성 영업이익)
          const t = spTerm(use, c);
          return t.skip ? t : { exp: x.ours - t.s, tol: t.tol, ev: `앱 ${x.ours} − (${t.ev})` };
        }]);
      }
      // (마) S&P 비경상 줄(0~2개) + SEC 항목 1개(2026-09-29 탐색으로 확인한 두 가지만): 연금 비근무원가(MRK — S&P 는 영업이익에 넣는다),
      //    기타 영업손익(MCD — S&P 는 회사의 기타 영업손익 줄 대신 자기 기타 영업비용 줄을 쓴다, 그 줄은 아래 S&P 줄 후보로). 그 해 10-K 값, 없으면 0
      if (n === "StockAnalysis") {
        const secFy = (concept, end) => { const es = (G[concept]?.units?.USD ?? []).filter((y) => y.start && /^10-K/.test(y.form ?? "") && dayDiff(y.end, end) <= 7 && (Date.parse(y.end) - Date.parse(y.start)) / 864e5 > 300).sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? "")); return es.length ? es[0].val : 0; };
        const EXTRA = [["NetPeriodicDefinedBenefitsExpenseReversalOfExpenseExcludingServiceCostComponent", "연금 비근무원가"], ["OtherOperatingIncomeExpenseNet", "회사 기타 영업손익"]];
        const OPX = [["otheropex", "기타 영업비용"]];
        for (const [concept, cl] of EXTRA) for (const sg of [1, -1]) for (const use of [[], ...spSubsets.filter((u) => u.length <= 2)]) for (const opx of [[], OPX]) {
          const all = [...use];
          rules.push([`sp+sec-${concept}-${sg}-${use.map(([k]) => k).join("+")}-${opx.length}`, `StockAnalysis(S&P 표준화) 영업이익 = 앱 − (${[...use.map(([, l]) => l), ...opx.map(([, l]) => `S&P ${l}`)].join("·") || "없음"}) ${sg < 0 ? "−" : "+"} ${cl}(SEC ${concept})`, (c, x, e) => {
            if (!e.end) return null; // 소계 있는 본표(F)·합성(S, MRK) 모두 — 식은 앱 영업이익 값 기준
            const t = spTerm(all, c); if (t.skip) return t;
            const a0 = saIsAdj.get(c), ox = opx.length ? (a0?.ox ?? 0) : 0;
            const sv = secFy(concept, e.end);
            const nzr = all.filter(([k]) => a0?.[k]).length + (ox ? 1 : 0);
            return { exp: x.ours - t.s - ox + sg * sv, tol: 0.5e6 * (nzr + 2) /* S&P 줄·SEC 항목·SA 값 각각 백만 단위 반올림 */, ev: `앱 ${x.ours} − (${t.ev}${ox ? ` + S&P 기타 영업비용 ${ox}` : ""}) ${sg < 0 ? "−" : "+"} ${concept} ${sv}` };
          }]);
        }
      }
      for (const [key, label, fn] of rules) { const h = opAllCols(n, key, fn); if (h && h.cols.has(col)) return { label, ...h }; }
      return null;
    };
    /** SEC 분기 영업이익(3개월, 4분기 = 사업연도 − 9개월) — 외부 분기말(달의 말일) ±7일 안에서 */
    const secOpQuarter = (end) => {
      if (!opincFace) return null;
      for (let d = 0; d <= 7; d++) {
        for (const sg of d ? [1, -1] : [1]) {
          const E = new Date(Date.parse(end) + sg * d * 864e5).toISOString().slice(0, 10);
          const fy = opincFace.annualAt(E), isQ4 = !!fy && !fy.err;
          const s = opincFace.quarterAt(E, isQ4);
          if (!s || s.err || s.blank || s.v == null || dayDiff(s.end, E) > 3 || s.type.includes("/") || (/S/.test(s.type) && s.finRev && !s.finCostSplit)) continue;
          let v = s.v;
          if (/S/.test(s.type) && opincFace.split) { const rq = revFace?.quarterAt(E, isQ4); if (!rq) return null; v += rq.v; }
          return { v, isQ4, end: E };
        }
      }
      return null;
    };
    /** LTM 분기 합 — 소스 n 의 LTM 영업이익 = 자기 분기 4개 합이고 분기마다 SEC 본표 분기값과 정확히 같다(매출원가 cogsQuarterSum 과 같은 모양) */
    const opQMemo = new Map();
    const opQuarterSum = (n) => {
      if (!["Yahoo", "인포맥스", "StockAnalysis"].includes(n)) return null; // 분기 자료가 있는 소스만(블룸버그는 LTM 합계뿐 — 예전엔 기본 분기로 StockAnalysis 값을 써서 블룸버그가 잘못 ② 판정)
      if (opQMemo.has(n)) return opQMemo.get(n);
      opQMemo.set(n, null);
      const x = recon.get("LTM 영업이익");
      if (!x?.srcs[n] || !opincFace || !aPassed("LTM", "영업이익")) return null;
      const near = (r) => r.end <= L.date || dayDiff(r.end, L.date) <= 7;
      const qs = n === "Yahoo" ? last4.map((r) => ({ end: iso(r.date), v: r.totalOperatingIncomeAsReported ?? null }))
        : n === "인포맥스" ? (imAnnual?.quarters ?? []).filter(near).slice(-4).map((r) => ({ end: r.end, v: r.op ?? null }))
        : saQInc ? saQInc.datekey.map((d, i) => ({ end: d, v: saQInc.opinc?.[i] ?? null })).filter((r) => r.end !== "TTM" && near(r)).sort((a, b) => a.end.localeCompare(b.end)).slice(-4) : [];
      if (qs.length !== 4 || dayDiff(qs[3].end, L.date) > 7 || qs.some((q) => q.v == null)) return null;
      const u = n === "인포맥스" ? imAnnual?.unit ?? 1 : n === "StockAnalysis" ? x.srcs[n].unit ?? 1 : 1;
      const same = (p, q) => extEq(p, q) || (u !== 1 && extEq(p, roundHalfAway(q, u)));
      const rows = [], bad = [];
      let sec = 0;
      for (const q of qs) {
        const s = secOpQuarter(q.end);
        if (!s) return null;
        const how = s.isQ4 ? "사업연도 − 9개월" : "3개월";
        if (same(q.v, s.v)) { sec += s.v; rows.push(`${q.end} ${q.v} = SEC ${how} ${s.v}${extEq(q.v, s.v) ? "" : `(표기 단위 ${u} 반올림)`}`); continue; }
        bad.push({ q, s });
      }
      const tot = qs.reduce((t, q) => t + q.v, 0);
      if (!extEq(x.srcs[n].v, tot) || extEq(tot, x.ours)) return null;
      let out = null;
      if (!bad.length) out = { rows, sec };
      else if (n === "인포맥스") {
        // 인포맥스 자체 집계 불일치 — SEC 와 다른 분기가 모두 4분기이고 그 사업연도 인포맥스 연간 = 앱 = SEC 본표인데 인포맥스 분기 4개 합 ≠ 연간
        const why = [];
        for (const { q, s } of bad) {
          const c = s.isQ4 ? Object.keys(H).find((k) => k !== "LTM" && dayDiff(H[k].date, s.end) <= 7) : null;
          const ya = c ? recon.get(`${c} 영업이익`) : null;
          if (!c || !ya?.srcs[n] || !extEq(ya.srcs[n].v, ya.ours) || !aPassed(c, "영업이익")) { why.length = 0; break; }
          const fq = (imAnnual?.quarters ?? []).filter((r) => { const g = (Date.parse(H[c].date) - Date.parse(r.end)) / 864e5; return g > -8 && g < 330; });
          const fs = fq.length === 4 && fq.every((r) => r.op != null) ? fq.reduce((t, r) => t + r.op, 0) : null;
          if (fs == null || extEq(fs, ya.srcs[n].v)) { why.length = 0; break; }
          why.push(`${q.end} 인포맥스 ${q.v} ≠ SEC 사업연도 − 9개월 ${s.v} — 인포맥스 ${c} 연간 ${ya.srcs[n].v}(= 앱 = SEC 본표) ≠ 자기 분기 4개 합 ${fs}`);
        }
        if (why.length === bad.length) out = { outlier: `외부 단독 이탈(인포맥스 자체 집계 불일치) — ${why.join(" · ")} · 나머지 분기는 SEC 분기값과 정확 일치(${rows.join(" · ")})` };
      }
      opQMemo.set(n, out);
      return out;
    };
    // ── 감가상각비 F층 규칙(--metric=da, 2026-09-27) — 영업이익 전 열 규칙(opAllCols)과 같은 모양. 소스 n 이 대조된 **모든 연간 열**에서 앱 = SEC
    //    현금흐름표 줄 합(A층 정확 일치)이고 SEC 원자료 식이 외부 값과 정확히 같을 때만 ②(2열 이상 · 한 열 이상 비자명 · 허용 오차 없음 — StockAnalysis
    //    만 자기 표기 단위 반올림 식 1회). 식을 계산할 수 없는 열(그 열 현금흐름표에 그 줄이 없음)은 증거에서 빼고 ②도 주지 않는다(0 으로 채우지 않음).
    //    LTM 열은 같은 식이 정확 성립할 때만 함께 넣고(안 맞아도 연간 규칙을 깨지 않는다), 따로 daQuarterSum 이 본다
    const daCols = (n) => [...recon.values()].filter((x) => /^(\d{4}Y|LTM) 감가상각비$/.test(x.item) && x.srcs[n]);
    const daMemo = new Map();
    const daAllCols = (n, key, expOf) => {
      const mk = `${n}|${key}`;
      if (daMemo.has(mk)) return daMemo.get(mk);
      let out = null, ok = true, nonTrivial = false, nAnn = 0;
      const ev = [], cols = new Set(), skipped = [];
      for (const x of daCols(n)) {
        const col = x.item.split(" ")[0], e = daExp.get(col);
        const r0 = e && aPassed(col, "감가상각비") ? expOf(col, x, e) : null;
        if (r0?.skip) { skipped.push([col, r0.skip]); continue; }
        const u = x.srcs[n].unit ?? 1; // 외부 표기 단위 반올림 식 1회 — 모든 소스(2026-09-29: 블룸버그 0.01백만 표기 — NFLX 감가상각비 336.682 → 336.68)
        const hit = !!r0 && r0.exp != null && (extEq(x.srcs[n].v, r0.exp) || (u !== 1 && extRound(n, x.srcs[n].v, r0.exp, u)) || (r0.tol != null && Math.abs(x.srcs[n].v - r0.exp) <= r0.tol));
        const txt = hit ? `${col} ${r0.ev} = ${r0.exp}${extEq(x.srcs[n].v, r0.exp) ? "" : `(표기 단위 ${u} 반올림 → ${x.srcs[n].v})`}` : "";
        if (col === "LTM") { if (hit) { cols.add(col); ev.push(txt); } continue; }
        if (!hit) { ok = false; break; }
        nAnn++;
        if (!extEq(r0.exp, x.ours)) nonTrivial = true;
        cols.add(col);
        ev.push(txt);
      }
      if (ok && nonTrivial && nAnn >= 2) out = { ev, cols, skipped };
      daMemo.set(mk, out);
      return out;
    };
    /** SEC 주석 항목(companyfacts — 현금흐름표 본표 줄이 아닌 태그) 열 값. LTM 은 SEC TTM(기준일 ±7일) */
    const noteOf = (tag, col, e) => {
      if (col === "LTM") { const t = secTtm(tag); return t && dayDiff(t.end, e.end) <= 7 ? t.v : null; }
      return atEnd(ann(tag), e.end)?.val ?? null;
    };
    // 외부 정의 차이 후보(SEC 원자료) — 더하는 쪽: 운용리스 사용권자산 상각(Yahoo·인포맥스 — CLAUDE.md PEP 사례). 빼는 쪽: 자본화 소프트웨어 상각
    // (StockAnalysis — PEP 2021~2025 실측)·무형자산 상각(현금흐름표에 한 줄로 합쳐 싣는 회사의 주석 값)
    const DA_NOTE_PLUS = ["OperatingLeaseRightOfUseAssetAmortizationExpense"];
    const DA_NOTE_MINUS = ["CapitalizedComputerSoftwareAmortization1", "CapitalizedComputerSoftwareAmortization", "AmortizationOfIntangibleAssets"];
    const DA_ADJ = "(손상·중단사업 조정액)";
    /** 후보 항목의 열 값 → { v, lab } | { skip } — "note:태그"(SEC 주석) · DA_ADJ · 현금흐름표 제외 줄(excl) · 감가상각 줄(lines) */
    const daItemOf = (id, c, e) => {
      if (id.startsWith("note:")) { const t = id.slice(5), v = noteOf(t, c, e); return v == null ? { skip: `SEC 주석 ${t} 값 없음` } : { v, lab: `${t}(SEC 주석) ${v}` }; }
      if (id === DA_ADJ) return e.adj ? { v: e.adj, lab: `현금흐름표 줄에 섞인 손상·중단사업 감가상각 ${e.adj}` } : { skip: "그 열 조정액 없음" };
      const t = (e.excl ?? []).find((y) => y.id === id) ?? (e.lines ?? []).find((y) => y.id === id);
      return !t || t.v == null ? { skip: `${DA_NM(id)} 그 열 현금흐름표에 값 없음` } : { v: t.v, lab: `${t.label} ${t.v}` };
    };
    const daLab = (id) => (id.startsWith("note:") ? `${id.slice(5)}(SEC 주석)` : id.startsWith("(") ? id : DA_NM(id));
    /** 소스 n 의 열 col 에 성립하는 첫 전 열 규칙 → { label, ev, cols, skipped } | null */
    const daRule = (n, col) => {
      const exps = [...daExp.entries()].filter(([c]) => c !== "LTM").map(([, e]) => e);
      const rules = [["latest", "나중 공시의 반올림 재게시 값(앱은 decimals 판정 정밀값)", (c, x, e) => (e.vLatest == null ? null
        : { exp: e.vLatest, ev: e.vLatest === e.v ? "재게시 없음(= 앱)" : `최신 판본 ${e.vLatest}(앱 ${e.v})` })]];
      // (가) 외부가 앱이 뺀 항목을 넣는다: 외부 = 앱 + Σ(현금흐름표 제외 줄 · SEC 주석 운용리스 상각 · 손상·중단사업 조정액 중 부분집합, 3개 이하)
      const plus = [...new Set(exps.flatMap((e) => (e.excl ?? []).map((t) => t.id))), ...DA_NOTE_PLUS.map((t) => `note:${t}`), DA_ADJ].slice(0, 8);
      // (나) 외부가 감가상각 일부를 뺀다: 외부 = 앱 − Σ(현금흐름표 감가상각 줄 일부(전부 아님) · SEC 주석 자본화 소프트웨어·무형자산 상각 중 부분집합, 3개 이하)
      const lineIds = [...new Set(exps.flatMap((e) => (e.lines ?? []).map((t) => t.id)))].slice(0, 5);
      const minus = [...lineIds, ...DA_NOTE_MINUS.map((t) => `note:${t}`)];
      for (const [sg, cand] of [[1, plus], [-1, minus]]) {
        for (let mask = 1; mask < 1 << cand.length; mask++) {
          const use = cand.filter((_, i) => mask & (1 << i));
          if (use.length > 3 || (sg < 0 && lineIds.length && lineIds.every((id) => use.includes(id)))) continue;
          rules.push([`${sg > 0 ? "plus" : "minus"}-${use.join("+")}`, `앱 ${sg > 0 ? "+" : "−"} ${use.map(daLab).join(` ${sg > 0 ? "+" : "−"} `)} — 외부는 이 항목을 감가상각비에 ${sg > 0 ? "넣음" : "넣지 않음"}`, (c, x, e) => {
            let d = 0;
            const ev = [];
            for (const id of use) { const r = daItemOf(id, c, e); if (r.skip) return r; d += r.v; ev.push(`${sg > 0 ? "+" : "−"} ${r.lab}`); }
            return { exp: x.ours + sg * d, ev: `앱 ${x.ours} ${ev.join(" ")}` };
          }]);
        }
      }
      // (나-2) 외부 = 현금흐름표 줄 합(앱의 손상·중단사업 조정 전) − SEC 주석 항목 하나(2026-09-30 DELL StockAnalysis: FY2022 4,288 = 줄 합 4,551(VMware
      //    중단사업 포함) − 자본화 소프트웨어 상각 263, FY2023~2026 = 앱 − 소프트웨어 상각 — 조정이 없는 해는 조정 0)
      for (const t of DA_NOTE_MINUS) rules.push([`unadj-minus-${t}`, `현금흐름표 줄 합(앱의 손상·중단사업 조정 전) − ${t}(SEC 주석) — 외부는 중단사업 감가상각을 빼지 않고 이 항목만 뺌`, (c, x, e) => {
        const v0 = noteOf(t, c, e);
        if (v0 == null) return { skip: `SEC 주석 ${t} 값 없음` };
        return { exp: x.ours + (e.adj ?? 0) - v0, ev: `앱 ${x.ours}${e.adj ? ` + 조정 되돌림 ${e.adj}` : ""} − ${t} ${v0}` };
      }]);
      // (다) 외부 = SEC 태그 1~2개의 합(현금흐름표 줄이 아닌 다른 구성 — 2026-09-30 CEG Yahoo: 손익계산서 감가상각 줄 1,091 + 핵연료 상각 758
      //    = 1,849. 앱은 현금흐름표 줄 2,427 = 둘 + 자산복구충당부채 증가 543 + 전력계약 상각 35). 모든 연간 열 정확 성립일 때만
      const BUILD = ["CostOfGoodsAndServicesSoldDepreciationAndAmortization", "DepreciationAndAmortization", "DepreciationDepletionAndAmortization", "AmortizationOfNuclearFuelLease", "Depreciation", "AmortizationOfIntangibleAssets"];
      for (let i = 0; i < BUILD.length; i++) for (let j = i; j < BUILD.length; j++) {
        const use = i === j ? [BUILD[i]] : [BUILD[i], BUILD[j]];
        rules.push([`build-${use.join("+")}`, `외부 감가상각비 = ${use.map((t) => `SEC ${t}`).join(" + ")} — 앱은 현금흐름표 감가상각·상각 줄 합`, (c, x, e) => {
          let s = 0; const ev = [];
          for (const t of use) { const v0 = noteOf(t, c, e); if (v0 == null) return { skip: `SEC ${t} 값 없음` }; s += v0; ev.push(`${t} ${v0}`); }
          return { exp: s, ev: ev.join(" + ") };
        }]);
      }
      // (라) 외부 = 최초 공시 값(2026-09-30 블룸버그 MSFT — FY2024 22,287·FY2025 34,153 = 원 10-K, 나중 10-K 가 20,958·29,433 으로 재작성. FY2026 43,448
      //    = 원 10-Q 분기 13,061 + 9,198 + 10,167 + 4분기 11,022 — 1분기를 다음 10-Q 가 8,147 로 재작성). 식: 연간 원공시 + (1~3분기 원공시 합 − 9개월
      //    누적 원공시). 그 해 안 재작성이 없으면 연간 원공시와 같다. 1~3분기 3개월 원공시·9개월 누적 원공시가 모두 읽혔을 때만(연간 열만)
      if (daFace?.origAt) rules.push(["orig-first", "최초 공시 값(연간 원 10-K + 그 해 분기 재작성 되돌림) — 외부는 재작성 전 값, 앱은 최신 판본", (c, x, e) => {
        // LTM(사업연도 도중) — 직전 사업연도 원공시 + 당기 누적 원공시 − 전년 동기 누적 원공시(ISRG LTM 812.0 — 전년 동기 상반기 원공시는 계약원가 상각 17.8 제외)
        if (c === "LTM" && H.LTM?.date && !Object.keys(H).some((k) => k !== "LTM" && H[k]?.date && dayDiff(H[k].date, H.LTM.date) <= 7)) {
          const L0 = H.LTM.date, fyc = Object.keys(H).filter((k) => k !== "LTM" && H[k]?.date && H[k].date < L0).sort((p1, p2) => H[p2].date.localeCompare(H[p1].date))[0];
          const fe = fyc ? daExp.get(fyc) : null;
          if (!fe?.start || !fe?.end) return null;
          const all = [...new Set(daFace.faces.flatMap((g) => [...g.periods]))].map((k) => k.split("|"));
          const cur = all.find(([a1, b1]) => dayDiff(a1, new Date(Date.parse(fe.end) + 864e5).toISOString().slice(0, 10)) <= 5 && dayDiff(b1, L0) <= 7);
          if (!cur) return null;
          const yb = (d0) => new Date(Date.parse(d0) - 365 * 864e5).toISOString().slice(0, 10);
          const pri = all.find(([a1, b1]) => dayDiff(a1, yb(cur[0])) <= 7 && dayDiff(b1, yb(cur[1])) <= 7);
          const f0 = daFace.origAt(fe.start, fe.end), c0 = daFace.origAt(cur[0], cur[1]), p0 = pri ? daFace.origAt(pri[0], pri[1]) : null;
          if (!f0 || !c0 || !p0) return { skip: "LTM 구성 원공시 없음" };
          return { exp: f0.v + c0.v - p0.v, ev: `사업연도 원공시 ${f0.v}(${f0.filed}) + 당기 누적 원공시 ${c0.v}(${c0.filed}) − 전년 동기 원공시 ${p0.v}(${p0.filed})` };
        }
        if (!e.start || !e.end || (Date.parse(e.end) - Date.parse(e.start)) / 864e5 < 300) return null; // LTM 은 그 기간이 사업연도 자체일 때만(MSFT 6월 결산 직후)
        const fy = daFace.origAt(e.start, e.end);
        const ps = daFace.periodsIn(e.start, e.end);
        const ddp = ([a, b]) => (Date.parse(b) - Date.parse(a)) / 864e5;
        const n9 = ps.filter((p) => ddp(p) >= 250 && ddp(p) <= 290)[0];
        const qs = ps.filter((p) => ddp(p) >= 80 && ddp(p) <= 100 && p[1] < e.end);
        if (!fy) return null;
        const q3 = qs.filter((p) => ddp([e.start, p[1]]) <= 290).sort((a, b) => a[1].localeCompare(b[1]));
        // 분기 3개월 값: 1분기는 3개월 = 누적. 2·3분기는 3개월 기간 자체
        const q1 = ps.filter((p) => ddp(p) >= 80 && ddp(p) <= 100 && dayDiff(p[0], e.start) <= 5)[0];
        const quarters = [q1, ...q3.filter((p) => !q1 || p[1] !== q1[1])].filter(Boolean);
        // 현금흐름표에 누적 열만 싣는 회사(3개월 열 없음 — GOOG): 분기 = 원공시 누적 차라 분기 합 = 9개월 원공시 → 식이 연간 원공시로 줄어든다
        if (!quarters.length || (quarters.length === 1 && q1)) return { exp: fy.v, ev: `연간 원공시 ${fy.v}(${fy.form} ${fy.filed} — 현금흐름표 누적 열만)` };
        if (!n9 || quarters.length !== 3) return { skip: "1~3분기 원공시 또는 9개월 누적 원공시를 읽지 못함" };
        const qo = quarters.map((p) => daFace.origAt(p[0], p[1])), no = daFace.origAt(n9[0], n9[1]);
        if (qo.some((q) => !q) || !no) return { skip: "분기 원공시 값 없음" };
        const exp = fy.v + qo.reduce((t, q) => t + q.v, 0) - no.v;
        return { exp, ev: `연간 원공시 ${fy.v}(${fy.form} ${fy.filed}) + 분기 원공시 ${qo.map((q) => `${q.v}(${q.filed})`).join(" + ")} − 9개월 원공시 ${no.v}(${no.filed})` };
      }]);
      for (const [key, label, fn] of rules) { const h = daAllCols(n, key, fn); if (h && h.cols.has(col)) return { label, ...h }; }
      return null;
    };
    /** SEC 분기 감가상각비(3개월 · 누적 차 · 4분기 = 사업연도 − 9개월) — 외부 분기말(달의 말일) ±7일 안에서 */
    const secDaQuarter = (end) => {
      if (!daFace) return null;
      for (let d = 0; d <= 7; d++) {
        for (const sg of d ? [1, -1] : [1]) {
          const E = new Date(Date.parse(end) + sg * d * 864e5).toISOString().slice(0, 10);
          const isQ4 = !!daFace.annualAt(E);
          const s = daFace.quarterAt(E, isQ4);
          if (!s || s.unres || dayDiff(s.end, E) > 3) continue;
          return { v: s.v, isQ4, how: isQ4 ? "사업연도 − 9개월" : /누적 차/.test(s.how) ? "누적 차" : "3개월" };
        }
      }
      return null;
    };
    /** LTM 분기 합 — 소스 n 의 LTM 감가상각비 = 자기 분기 4개 합이고 분기마다 SEC 분기값과 정확히 같다(영업이익 opQuarterSum 과 같은 모양) */
    const daQMemo = new Map();
    const daQuarterSum = (n) => {
      if (!["Yahoo", "인포맥스", "StockAnalysis"].includes(n)) return null; // 분기 자료가 있는 소스만(블룸버그는 LTM 합계뿐 — 예전엔 기본 분기로 StockAnalysis 값을 써서 블룸버그가 잘못 ② 판정)
      if (daQMemo.has(n)) return daQMemo.get(n);
      daQMemo.set(n, null);
      const x = recon.get("LTM 감가상각비");
      if (!x?.srcs[n] || !daFace || !aPassed("LTM", "감가상각비")) return null;
      const near = (r) => r.end <= L.date || dayDiff(r.end, L.date) <= 7;
      const qs = n === "Yahoo" ? last4.map((r) => ({ end: iso(r.date), v: r.reconciledDepreciation ?? null }))
        : n === "인포맥스" ? (imAnnual?.quarters ?? []).filter(near).slice(-4).map((r) => ({ end: r.end, v: r.da ?? null }))
        : saQInc ? saQInc.datekey.map((d, i) => ({ end: d, v: saQInc.depAmorEbitda?.[i] ?? null })).filter((r) => r.end !== "TTM" && near(r)).sort((a, b) => a.end.localeCompare(b.end)).slice(-4) : [];
      if (qs.length !== 4 || dayDiff(qs[3].end, L.date) > 7 || qs.some((q) => q.v == null)) return null;
      const u = n === "인포맥스" ? imAnnual?.unit ?? 1 : n === "StockAnalysis" ? x.srcs[n].unit ?? 1 : 1;
      const same = (p, q) => extEq(p, q) || (u !== 1 && extEq(p, roundHalfAway(q, u)));
      const rows = [], bad = [];
      let sec = 0;
      for (const q of qs) {
        const s = secDaQuarter(q.end);
        if (!s) return null;
        if (same(q.v, s.v)) { sec += s.v; rows.push(`${q.end} ${q.v} = SEC ${s.how} ${s.v}${extEq(q.v, s.v) ? "" : `(표기 단위 ${u} 반올림)`}`); continue; }
        bad.push({ q, s });
      }
      const tot = qs.reduce((t, q) => t + q.v, 0);
      if (!extEq(x.srcs[n].v, tot) || extEq(tot, x.ours)) return null;
      const out = bad.length ? null : { rows, sec };
      daQMemo.set(n, out);
      return out;
    };
    // ── 판관비·연구개발비 F층 규칙(--metric=sga, 2026-09-28) — 감가상각비 전 열 규칙(daAllCols)과 같은 모양. 소스 n 이 대조된 **모든 연간 열**에서
    //    앱 = SEC 본표(A층 정확 일치)이고 SEC 본표 줄로 만든 식이 외부 값과 정확히 같을 때만 ②(2열 이상 · 한 열 이상 비자명 · 허용 오차 없음 — 외부
    //    표기 단위 반올림 식 1회만). 식 후보는 본표 줄뿐: (가) 외부 = 앱 − 앱이 넣은 성격 줄 일부(전부 아님), (나) 외부 = 앱 + 뿌리 식의 그 밖 말단
    //    비용 줄(판관비·연구개발비·원가 밖 — D&A·구조조정·기타 영업비용 등) 일부, (다) 판관비만: 외부 = 앱 + 앱 연구개발비(외부가 연구개발비를
    //    판관비에 합침), 각 2개 이하·(가)(나) 한 개씩 조합까지. 식을 계산할 수 없는 열(그 열 본표에 그 줄 없음)은 증거에서 빼고 0 으로 채우지 않는다
    const SGA_METRIC_RE = /^(\d{4}Y|LTM) (판관비|연구개발비|판관비·연구개발비)$/;
    // 손익 위치 차원 사실(연간 열마다 그 사업연도 10-K 원본 — 차원 1개, 손익 위치 축 = 연구개발비·판관비). 외부 원인 규칙(noteRules "loc-")용.
    //   실측 2026-09-28: DELL StockAnalysis 연구개발비 = 앱 − SeveranceCosts1[위치=연구개발비] FY2022~2026(7·56·40·119·130),
    //   BE StockAnalysis 연구개발비 = 앱 − AssetImpairmentCharges[위치=연구개발비] 2025 3.0(그 밖 해 없음·차이 0)
    const locFacts = new Map(); // 열 → [{ c: 개념, loc: "rnd"|"sga", v }]
    if (SGA_MODE && !foreign) {
      for (const [col, e] of sgaExp) {
        if (col === "LTM" || !e?.start || !e?.end) continue;
        const accn = (e.comps?.length === 1 ? e.comps[0].faceAccn : null) ?? e.sga?.faceAccn ?? null;
        if (!accn) continue;
        let idx = null;
        try { idx = await instanceDecimals(cik, accn); } catch { continue; }
        const arr = [];
        for (const [k, fs0] of idx ?? []) {
          const [c, st, en, dim] = k.split("|");
          if (st !== e.start || en !== e.end || !dim) continue;
          const [ax, mem] = dim.split("=");
          if (!/IncomeStatementLocationAxis|StatementOfIncomeLocationBalanceAxis/.test(ax)) continue;
          const loc = /^ResearchAndDevelopmentExpense/.test(mem) ? "rnd" : /^SellingGeneralAndAdministrativeExpense/.test(mem) ? "sga" : null;
          if (loc && fs0.length) arr.push({ c, loc, v: fs0[fs0.length - 1].v });
        }
        locFacts.set(col, arr);
      }
    }
    // 금융 부문 이자비용(FinancingInterestExpense[ProductOrServiceAxis=…Financ…], 그 사업연도 10-K 원본) — 블룸버그 원가 원인 규칙용.
    //   실측 2026-09-28 CAT: 블룸버그 원가 = 앱 + 금융상품 이자비용 455·565·1,030·1,286·1,359(2021~2025)
    const finIntFacts = new Map();
    if (COGS_MODE && !foreign) for (const [col, e] of cogsExp) {
      const accn = e?.comps?.length === 1 ? e.comps[0].faceAccn : e?.faceAccn;
      if (col === "LTM" || !accn || !e.start || !e.end) continue;
      let idx = null;
      try { idx = await instanceDecimals(cik, accn); } catch { continue; }
      for (const [k, fs0] of idx ?? []) {
        const [c, st, en, dim] = k.split("|");
        if (c === "FinancingInterestExpense" && st === e.start && en === e.end && /^ProductOrServiceAxis=.*Financ/i.test(dim ?? "") && fs0.length) finIntFacts.set(col, fs0[fs0.length - 1].v);
      }
    }
    // LTM(2026-09-30 CAT 블룸버그 LTM 매출원가 = 앱 + 1,404 = 2025 연간 1,359 + 2026 상반기 707 − 2025 상반기 662) — LTM 기준일 10-Q 원본의
    // 당기 누적·전년 동기 누적 차원 사실. LTM 이 사업연도 자체면 그 연간 값
    if (COGS_MODE && !foreign && finIntFacts.size && H.LTM?.date) {
      const L0 = H.LTM.date;
      const fyc = Object.keys(H).filter((k) => k !== "LTM" && H[k]?.date && H[k].date <= new Date(Date.parse(L0) + 7 * 864e5).toISOString().slice(0, 10)).sort((p1, p2) => H[p2].date.localeCompare(H[p1].date))[0];
      if (fyc && dayDiff(H[fyc].date, L0) <= 7) { if (finIntFacts.has(fyc)) finIntFacts.set("LTM", finIntFacts.get(fyc)); }
      else if (fyc && finIntFacts.has(fyc)) {
        const rc0 = sub.filings?.recent ?? {};
        const i = (rc0.form ?? []).findIndex((fm, j) => fm === "10-Q" && rc0.reportDate[j] && dayDiff(rc0.reportDate[j], L0) <= 7);
        if (i >= 0) {
          try {
            const idx = await instanceDecimals(cik, rc0.accessionNumber[i]);
            const fy = cogsExp.get(fyc), s0 = fy?.end ? new Date(Date.parse(fy.end) + 864e5).toISOString().slice(0, 10) : null;
            const yb = (d0) => new Date(Date.parse(d0) - 365 * 864e5).toISOString().slice(0, 10);
            let cur = null, pri = null;
            for (const [k, fs0] of idx ?? []) {
              const [c, st, en, dim] = k.split("|");
              if (c !== "FinancingInterestExpense" || !/^ProductOrServiceAxis=.*Financ/i.test(dim ?? "") || !fs0.length) continue;
              if (s0 && dayDiff(st, s0) <= 5 && dayDiff(en, L0) <= 7) cur = fs0[fs0.length - 1].v;
              if (s0 && dayDiff(st, yb(s0)) <= 7 && dayDiff(en, yb(L0)) <= 7) pri = fs0[fs0.length - 1].v;
            }
            if (cur != null && pri != null) finIntFacts.set("LTM", finIntFacts.get(fyc) + cur - pri);
          } catch (e) { hardErrors.push(`금융 부문 이자비용 10-Q 원본 조회 실패(LTM 규칙 없음): ${String(e).slice(0, 80)}`); }
        }
      }
    }
    const sgaCols = (n, m) => [...recon.values()].filter((x) => x.item.endsWith(` ${m}`) && SGA_METRIC_RE.test(x.item) && x.srcs[n]);
    const sgaMemo = new Map();
    const sgaAllCols = (n, m, key, expOf) => {
      const mk = `${n}|${m}|${key}`;
      if (sgaMemo.has(mk)) return sgaMemo.get(mk);
      let out = null, ok = true, nonTrivial = false, nAnn = 0;
      const ev = [], cols = new Set(), skipped = [];
      for (const x of sgaCols(n, m)) {
        const col = x.item.split(" ")[0], e = sgaExp.get(col);
        const r0 = e && aPassed(col, m) ? expOf(col, x, e) : null;
        if (r0?.skip) { skipped.push([col, r0.skip]); continue; }
        const u = x.srcs[n].unit ?? 1;
        const hit = !!r0 && r0.exp != null && (extEq(x.srcs[n].v, r0.exp) || (u !== 1 && extRound(n, x.srcs[n].v, r0.exp, u)) || (r0.tol != null && Math.abs(x.srcs[n].v - r0.exp) <= r0.tol));
        const txt = hit ? `${col} ${r0.ev} = ${r0.exp}${extEq(x.srcs[n].v, r0.exp) ? "" : `(표기 단위 ${u} 반올림 → ${x.srcs[n].v})`}` : "";
        if (col === "LTM") { if (hit) { cols.add(col); ev.push(txt); } continue; }
        if (!hit) { ok = false; break; }
        nAnn++;
        if (!extEq(r0.exp, x.ours)) nonTrivial = true;
        cols.add(col);
        ev.push(txt);
      }
      if (ok && nonTrivial && nAnn >= 2) out = { ev, cols, skipped };
      sgaMemo.set(mk, out);
      return out;
    };
    const sgaNm = (id) => id.replace(/^[a-z0-9-]+_/i, "");
    /** 열 e 에서 줄 id 값 — 성격 줄(sga·rnd lines) 또는 그 밖 말단 줄(others). "rnd:app" = 앱 연구개발비 */
    const sgaTermOf = (id, c, e) => {
      if (id === "rnd:app") return IS[c]?.rnd != null && aPassed(c, "연구개발비") ? { v: IS[c].rnd, lab: `앱 연구개발비 ${IS[c].rnd}` } : { skip: "그 열 연구개발비 없음(또는 A층 미통과)" };
      const pool = (x) => [...(x.sga?.lines ?? []), ...(x.rnd?.lines ?? []), ...(x.others ?? []), ...(x.sga?.aligned ?? []), ...(x.rnd?.aligned ?? [])];
      let t = pool(e).find((y) => y.id === id);
      // 그 열 공시가 같은 줄을 다른 개념으로 태깅했으면(KO 2021 10-K "Other operating charges" = OtherCostAndExpenseOperating) 라벨로 찾는다 —
      // 다른 열에서 이 id 의 라벨을 얻고, 이 열에 같은 라벨 줄이 정확히 하나일 때만
      if (!t) {
        const lk = (y) => String(y?.label ?? "").trim().toLowerCase();
        const lab0 = [...sgaExp.values()].map((x) => pool(x).find((y) => y.id === id)).find(Boolean);
        const same = lab0 ? pool(e).filter((y) => lk(y) === lk(lab0)) : [];
        if (same.length === 1) t = { ...same[0], label: `${same[0].label}(라벨 일치 — ${sgaNm(same[0].id)})` };
      }
      return !t || t.v == null ? { skip: `${sgaNm(id)} 그 열 본표에 값 없음` } : { v: t.v, lab: `${t.label} ${t.v}` };
    };
    /** 소스 n 의 지표 m 열 col 에 성립하는 첫 전 열 규칙 → { label, ev, cols, skipped } | null */
    const sgaRule = (n, m, col) => {
      const exps = [...sgaExp.entries()].filter(([c]) => c !== "LTM").map(([, e]) => e);
      const kinds = m === "판관비" ? ["sga"] : m === "연구개발비" ? ["rnd"] : ["sga", "rnd"];
      const own = [...new Set(exps.flatMap((e) => kinds.flatMap((k) => (e[k]?.lines ?? []).map((t) => t.id))))].slice(0, 6);
      const oth = [...new Set(exps.flatMap((e) => (e.others ?? []).map((t) => t.id)))].slice(0, 12);
      const plus = [...oth, ...(m === "판관비" ? ["rnd:app"] : [])];
      const combos = [];
      for (let i = 0; i < own.length; i++) { combos.push([[own[i]], []]); for (let j = i + 1; j < own.length; j++) combos.push([[own[i], own[j]], []]); }
      for (let i = 0; i < plus.length; i++) { combos.push([[], [plus[i]]]); for (let j = i + 1; j < plus.length; j++) combos.push([[], [plus[i], plus[j]]]); }
      for (const a of own) for (const b of plus) combos.push([[a], [b]]);
      const lab = (id) => (id === "rnd:app" ? "앱 연구개발비" : sgaNm(id));
      // 먼저 — 외부 = 나중 공시의 반올림 재게시 값(앱은 decimals 판정 정밀값 — 감가상각비 "latest" 규칙과 같은 모양)
      const latestOf = (e) => { const ks = kinds.map((k) => e[k]); if (ks[0]?.vLatest == null) return null; return ks.reduce((t, x) => t + (x?.empty ? 0 : x?.vLatest ?? NaN), 0); };
      const hl = sgaAllCols(n, m, "latest", (c, x, e) => { const v = latestOf(e); return v == null || Number.isNaN(v) ? null : { exp: v, ev: extEq(v, x.ours) ? "재게시 없음(= 앱)" : `최신 판본 ${v}(앱 ${x.ours})` }; });
      if (hl && hl.cols.has(col)) return { label: "나중 공시의 반올림 재게시 값(앱은 decimals 판정 정밀값)", ...hl };
      // 주석 금액·원 공시(2026-09-28 블룸버그 대조로 확인 — 소스 무관, 전 열 정확 성립일 때만)
      //  · 외부 = 앱 − 주석 연구개발비: 손익계산서에 연구개발비 줄이 없어 판관비 안에 든 회사(XOM·MDLZ·CL — 블룸버그가 주석 연구개발비를 떼어냄)
      //  · 외부 = 앱 + 주석 광고비: 광고비가 매장 운영비 안에 든 회사(SBUX — 블룸버그 판관비 = 일반관리비 + 광고비)
      //  · 외부 = 성격 줄의 원 10-K 값: 나중 10-K 가 과거 연도 판관비를 재작성(MAR 2023 1,011 → 867) — 앱은 최신 10-K(오너 결정 2026-09-28 GOOG 와 같음)
      const fyNote = (concept, date, first = false) => { const es = (G[concept]?.units?.USD ?? []).filter((y) => y.start && /^10-K/.test(y.form ?? "") && date && dayDiff(y.end, date) <= 7 && (Date.parse(y.end) - Date.parse(y.start)) / 864e5 > 300).sort((a, b) => (a.filed ?? "").localeCompare(b.filed ?? "")); return es.length ? (first ? es[0] : es.at(-1)).val : null; };
      const noteRules = [];
      if (m === "판관비") noteRules.push(["note-rnd", "앱 − 주석 연구개발비(손익계산서 줄 없음 — 판관비 안) — 외부는 연구개발비를 판관비에서 떼어냄", (c) => { const v = fyNote("ResearchAndDevelopmentExpense", H[c]?.date, true); if (v == null) return null; const t = [...rndText.entries()].find(([d]) => H[c]?.date && dayDiff(d, H[c].date) <= 7)?.[1]; return t ? [-t.v, `− 연구개발비 ${t.v}(10-K ${t.accn} 본문 표 — XBRL ${v} 는 1억 단위)`] : [-v, `− 주석 연구개발비 ${v}`]; }]);
      // 영업권 손상(AMAT 2025 — StockAnalysis 가 판관비에서 뺌). 손상이 없는 해는 0(항목 없는 해 = 0, 오너 결정 2026-09-28)
      if (m === "판관비") noteRules.push(["note-gw", "앱 − 영업권 손상 — 외부는 영업권 손상을 판관비에서 뺌", (c) => { const v = fyNote("GoodwillImpairmentLoss", H[c]?.date, true) ?? 0; return [-v, `− 영업권 손상 ${v}`]; }]);
      if (m !== "연구개발비") noteRules.push(["note-adv", `앱 + 주석 광고비 — 외부는 광고비를 ${m}에 넣음`, (c) => { const v = fyNote("AdvertisingExpense", H[c]?.date, true); return v == null ? null : [v, `+ 주석 광고비 ${v}`]; }]);
      noteRules.push(["orig-10k", "성격 줄의 원 10-K 값(앱은 최신 10-K 재작성값) — 외부는 최초 공시 값", (c, e) => {
        const ids = kinds.flatMap((k) => (e[k]?.lines ?? []).map((t) => t.id)).filter((id) => /^us-gaap_/.test(id));
        if (!ids.length) return null;
        let d = 0; const ev = [];
        for (const id of ids) { const o = fyNote(id.slice(8), H[c]?.date, true), l = fyNote(id.slice(8), H[c]?.date); if (o == null || l == null) return null; d += o - l; if (o !== l) ev.push(`${sgaNm(id)} 원 ${o}(최신 ${l})`); }
        return [d, ev.length ? ev.join(" · ") : "재작성 없음(= 앱)"];
      }]);
      // 성격 줄 안의 항목(손익 위치 차원) — 외부 = 앱 − 그 항목(없는 해 0). 한 개념씩만(조합 금지)
      const locWant = m === "연구개발비" ? "rnd" : m === "판관비" ? "sga" : null;
      if (locWant) for (const c of [...new Set([...locFacts.values()].flat().filter((x) => x.loc === locWant).map((x) => x.c))]) {
        noteRules.push([`loc-${c}`, `앱 − ${m} 줄 안의 ${c}(손익 위치 차원, 없는 해 0) — 외부는 이 금액을 ${m}에서 뺌`, (col0) => {
          if (!locFacts.has(col0)) return null;
          const v = locFacts.get(col0).find((x) => x.c === c && x.loc === locWant)?.v ?? 0;
          return [-v, `− ${c}[위치=${m}] ${v}`];
        }]);
      }
      for (const [key, label, f] of noteRules) {
        const h = sgaAllCols(n, m, key, (c, x, e) => { const r = f(c, e); return r ? { exp: x.ours + r[0], ev: `앱 ${x.ours} ${r[1]}` } : null; });
        if (h && h.cols.has(col)) return { label, ...h };
      }
      if (n === "StockAnalysis") for (const use of spSubsets) {
        const h = sgaAllCols(n, m, `sp-${use.map(([k]) => k).join("+")}`, (c, x) => { const t = spTerm(use, c); return t.skip ? t : { exp: x.ours + t.s, tol: t.tol, ev: `앱 ${x.ours} + ${t.ev}` }; });
        if (h && h.cols.has(col)) return { label: spLabel(use, m), ...h };
      }
      for (const [minus, add] of combos) {
        if (minus.length && own.length && own.every((id) => minus.includes(id))) continue; // 성격 줄 전부 빼기는 규칙 아님
        const key = `${minus.join("+")}|${add.join("+")}`;
        const label = `앱${minus.map((id) => ` − ${lab(id)}`).join("")}${add.map((id) => ` + ${lab(id)}`).join("")} — 외부는 ${[minus.length ? `${minus.map(lab).join("·")} 을 ${m}에서 뺌` : "", add.length ? `${add.map(lab).join("·")} 을 ${m}에 넣음` : ""].filter(Boolean).join(", ")}`;
        const h = sgaAllCols(n, m, key, (c, x, e) => {
          let d = 0;
          const ev = [];
          for (const [sg, ids] of [[-1, minus], [1, add]]) for (const id of ids) { const r = sgaTermOf(id, c, e); if (r.skip) return r; d += sg * r.v; ev.push(`${sg < 0 ? "−" : "+"} ${r.lab}`); }
          return { exp: x.ours + d, ev: `앱 ${x.ours} ${ev.join(" ")}` };
        });
        if (h && h.cols.has(col)) return { label, ...h };
      }
      return null;
    };
    /** SEC 분기 판관비·연구개발비(3개월 · Q4 = 사업연도 − 9개월) — 외부 분기말 ±7일 안에서. m 은 지표 이름 */
    const secSgaQuarter = (end, m) => {
      if (!sgaFace) return null;
      for (let d = 0; d <= 7; d++) {
        for (const sg of d ? [1, -1] : [1]) {
          const E = new Date(Date.parse(end) + sg * d * 864e5).toISOString().slice(0, 10);
          const isQ4 = !!sgaFace.annualAt(E);
          const s = sgaFace.quarterAt(E, isQ4);
          if (!s || dayDiff(s.end, E) > 3) continue;
          const v = m === "판관비" ? s.sga.v : m === "연구개발비" ? s.rnd.v : s.sga.v == null ? null : s.sga.v + (s.rnd.empty ? 0 : s.rnd.v ?? NaN);
          return v == null || Number.isNaN(v) ? null : { v, how: isQ4 ? "사업연도 − 9개월" : "3개월" };
        }
      }
      return null;
    };
    /** LTM 분기 합 — 소스 n 의 LTM = 자기 분기 4개 합이고 분기마다 SEC 본표 분기값과 정확히 같다(감가상각비 daQuarterSum 과 같은 모양) */
    const sgaQMemo = new Map();
    const sgaQuarterSum = (n, m) => {
      if (!["Yahoo", "인포맥스", "StockAnalysis"].includes(n)) return null; // 분기 자료가 있는 소스만(블룸버그는 LTM 합계뿐 — 예전엔 기본 분기로 StockAnalysis 값을 써서 블룸버그가 잘못 ② 판정)
      const mk = `${n}|${m}`;
      if (sgaQMemo.has(mk)) return sgaQMemo.get(mk);
      sgaQMemo.set(mk, null);
      const x = recon.get(`LTM ${m}`);
      if (!x?.srcs[n] || !sgaFace || !aPassed("LTM", m)) return null;
      const near = (r) => r.end <= L.date || dayDiff(r.end, L.date) <= 7;
      const yv = (r) => (m === "판관비" ? r.sellingGeneralAndAdministration : m === "연구개발비" ? r.researchAndDevelopment : r.sellingGeneralAndAdministration == null ? null : r.sellingGeneralAndAdministration + (r.researchAndDevelopment ?? 0));
      const sv = (i) => { const a = saQSga?.sgna?.[i] ?? null, b = saQSga?.rnd?.[i] ?? null; return m === "판관비" ? a : m === "연구개발비" ? b : a == null ? null : a + (b ?? 0); };
      const qs = n === "Yahoo" ? last4.map((r) => ({ end: iso(r.date), v: yv(r) ?? null }))
        : n === "인포맥스" ? (m === "판관비·연구개발비" ? (imSga?.quarters ?? []).filter(near).slice(-4).map((r) => ({ end: r.end, v: r.sga })) : [])
        : saQSga ? saQSga.datekey.map((d, i) => ({ end: d, v: sv(i) })).filter((r) => r.end !== "TTM" && near(r)).sort((a, b) => a.end.localeCompare(b.end)).slice(-4) : [];
      if (qs.length !== 4 || dayDiff(qs[3].end, L.date) > 7 || qs.some((q) => q.v == null)) return null;
      const u = n === "인포맥스" ? imSga?.unit ?? 1 : n === "StockAnalysis" ? x.srcs[n].unit ?? 1 : 1;
      const same = (p, q) => extEq(p, q) || (u !== 1 && extEq(p, roundHalfAway(q, u)));
      const rows = [];
      let sec = 0;
      for (const q of qs) {
        const s = secSgaQuarter(q.end, m);
        if (!s || !same(q.v, s.v)) return null;
        sec += s.v;
        rows.push(`${q.end} ${q.v} = SEC ${s.how} ${s.v}${extEq(q.v, s.v) ? "" : `(표기 단위 ${u} 반올림)`}`);
      }
      const tot = qs.reduce((t, q) => t + q.v, 0);
      if (!extEq(x.srcs[n].v, tot) || extEq(tot, x.ours)) return null;
      const out = { rows, sec };
      sgaQMemo.set(mk, out);
      return out;
    };
    const causeOf = (r, n, done) => {
      const col = r.item.split(" ")[0];
      const metric = r.item.slice(col.length + 1);
      const item0 = r.item;
      const v = r.srcs[n].v, unit = r.srcs[n].unit, parts = r.srcs[n].parts;
      // 외화 공시(20-F 원통화 — 그 칸의 "환산 환율 = 기간 평균(외화)" 검사 통과로 판정, IFRS 공시는 usdOnly 가 원통화를 못 봄) × 인포맥스 — 인포맥스는 자체(FactSet) 환율로 USD 환산하는데 그 환율이 공개돼 있지 않아 식으로 증명할 수 없다
      // (SPOT 2025 암시환율 1.128578 vs H.10 일평균 1.130622 — H.10 일·월·분기평균·월말값 모두 불일치, 실측 2026-09-27). 앱 값이 SEC 원통화 ×
      // H.10 독립 대조(A층)를 통과한 칸만 NA "검증불가(외부 환율 비공개)" — 오너 결정 2026-09-27. A층 미통과면 이 규칙을 쓰지 않는다
      if (n === "인포맥스" && aPassed(col, metric) && checks.some((k) => k.col === col && k.status === PASS && /환산 환율 = 기간 평균\(외화\)/.test(k.name))) return { na: `인포맥스 자체 환율(비공개)로 USD 환산 — 앱 = SEC 원통화 × H.10 기간 평균(A층 통과)`, naLabel: NA_FX };
      // 원인 규칙의 식 성립 판정 — 허용 오차 없음(오너 지시 2026-09-26). 외부 값 v 가 기대값 exp(SEC 원자료로 만든 식)와 완전히 같거나,
      // 외부가 자기 표기 단위로 반올림해 실었다면 roundHalfAway(exp, 단위) 와 완전히 같을 때만. 둘 이상의 외부 값을 섞는 식(⑦·④)은 완전 일치만
      const eqExp = (exp) => exp != null && (extEq(v, exp) || (unit != null && unit !== 1 && extEq(v, roundHalfAway(exp, unit))));
      const rnd = (exp) => (extEq(v, exp) ? "" : ` · 외부 표기 단위 ${unit} 반올림(0.5 는 0 에서 먼 쪽): round(${exp}) = ${v}`);
      // StockAnalysis 희석 EPS 끝자리(2026-09-30) — 공시 EPS(소수 둘째 자리, A층 통과)와 정확히 1e-6(SA 표기 마지막 자리)만 0 쪽으로 다르다
      //    (VRT 2024 1.279999·VST 2021~2025 −2.689999·−3.259999·2.179999). 순이익 ÷ 주식수 반올림·버림, float32 변환 모두 일관되게 재현 안 됨
      //    → 식 없는 표기 끝자리 차로 외부 정밀도 부족(NA)에만 넣는다
      // StockAnalysis 자체 계산 EPS(소수 6자리, 2026-10-01 V 2021 5.626599) — 공시 EPS 자릿수(소수 둘째 자리)로 반올림하면 앱(공시 EPS, A층 통과)과 같다 → 외부 표기 정밀도 차
      if (metric === "희석 EPS" && n === "StockAnalysis" && col !== "LTM" && !extEq(v, r.ours) && Math.abs(r.ours * 100 - Math.round(r.ours * 100)) < 1e-9 && Math.abs(Math.round(v * 100) / 100 - r.ours) < 1e-9
        && checks.some((k) => k.col === col && k.status === PASS && k.name === "EPS 앱 = SEC 공시 EPS(분할 보정)"))
        return { na: `StockAnalysis 자체 계산 EPS ${v}(소수 6자리) — 공시 EPS 자릿수로 반올림하면 앱 ${r.ours}` };
      if (metric === "희석 EPS" && n === "StockAnalysis" && col !== "LTM" && Math.abs(Math.abs(v - r.ours) - 1e-6) < 1e-9 && Math.abs(v) < Math.abs(r.ours)
        && Math.abs(r.ours * 100 - Math.round(r.ours * 100)) < 1e-9 && checks.some((k) => k.col === col && k.status === PASS && k.name === "EPS 앱 = SEC 공시 EPS(분할 보정)"))
        return { na: `StockAnalysis 표기 끝자리 — 앱(공시 EPS) ${r.ours} 와 정확히 0.000001 차(0 쪽), 순이익 ÷ 주식수로는 재현 안 됨` };
      // 현금흐름표 정의 차이(2026-10-01 — 블룸버그 분기·연간 현금흐름표 제공분 대조로 발견). 외부 = 앱 + SEC 태그 값(그 사업연도 10-K, LTM = SEC TTM), 정확 성립만
      //  · 자본지출 + 임대장비 취득(CAT 2024 블룸버그·야후·SA 3,215 = 1,988 + PaymentsToAcquireEquipmentOnLease 1,227)
      //  · 배당 + 우선주 배당(VST 463 = 313 + 150, WDC 184 = 174 + 10) · 비지배지분 배당(DELL FY2022 2,240 — VMware 특별배당 비지배분) · 계열사 분배(CEG 2021 Exelon 분배 1,832)
      //  · 영업·투자·재무활동 합계 + 중단사업 현금흐름(MRK 2021 — 앱은 계속사업분, 외부는 중단사업 포함 987 · −134 · −504)
      if (/^현금흐름표 /.test(metric) && H[col]?.date) {
        const CF_ADD = {
          "현금흐름표 유형자산 취득(CAPEX)": [[-1, "PaymentsToAcquireEquipmentOnLease", "임대장비 취득"]],
          "현금흐름표 배당금 지급": [[-1, "PaymentsOfDividendsPreferredStockAndPreferenceStock", "우선주 배당"], [-1, "PaymentsOfDividendsMinorityInterest", "비지배지분 배당"], [-1, "PaymentsOfDistributionsToAffiliates", "계열사(모회사) 분배"]],
          "현금흐름표 영업활동 현금흐름": [[1, "CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations", "중단사업 영업활동 현금흐름"]],
          "현금흐름표 투자활동 현금흐름": [[1, "CashProvidedByUsedInInvestingActivitiesDiscontinuedOperations", "중단사업 투자활동 현금흐름"]],
          "현금흐름표 재무활동 현금흐름": [[1, "CashProvidedByUsedInFinancingActivitiesDiscontinuedOperations", "중단사업 재무활동 현금흐름"]],
        }[metric];
        const tv = (tag) => {
          if (col === "LTM") { const t = secTtm(tag); return t && dayDiff(t.end, H.LTM.date) <= 7 ? t.v : null; }
          const l = (G[tag]?.units?.USD ?? []).filter((e) => e.start && /^10-K/.test(e.form ?? "") && dayDiff(e.end, H[col].date) <= 7 && (Date.parse(e.end) - Date.parse(e.start)) / 864e5 >= 300);
          return l.length ? latestPrecise(l).val : null;
        };
        const terms = (CF_ADD ?? []).map(([sg, tag, lab]) => ({ sg, tag, lab, v: tv(tag) })).filter((t) => t.v);
        if (metric === "현금흐름표 유형자산 취득(CAPEX)") for (const f of capexCustom.get(col) ?? []) terms.push({ sg: -1, tag: f.id, lab: `회사 고유 설비 취득 줄(${f.form} 원본)`, v: f.v });
        // 자사주: 소비세 줄 + 주식 발행 순유출(ProceedsFromIssuanceOrSaleOfEquity 가 음수 = 원천징수 차감 후 순유출) — 외부는 이 줄을 자사주 취득에 합친다
        if (metric === "현금흐름표 자기주식 취득") {
          for (const f of buybackCustom.get(col) ?? []) terms.push({ sg: -1, tag: f.id, lab: `자사주 매입 소비세(${col === "LTM" ? f.form : `${f.form} 원본`})`, v: f.v });
          const iss = tv("ProceedsFromIssuanceOrSaleOfEquity");
          if (iss != null && iss < 0) terms.push({ sg: 1, tag: "ProceedsFromIssuanceOrSaleOfEquity", lab: "주식 발행(원천징수 차감) 순유출", v: iss });
        }
        for (let m = 1; m < 1 << terms.length; m++) {
          const use = terms.filter((_, i) => m & (1 << i)), exp = r.ours + use.reduce((t, x) => t + x.sg * x.v, 0);
          if (eqExp(exp)) return { ok: `${n} = 앱 ${r.ours} ${use.map((x) => `${x.sg > 0 ? "+" : "−"} ${x.lab} ${x.v}(${x.tag})`).join(" ")} = ${exp}${rnd(exp)} — 외부는 이 금액을 포함` };
        }
      }
      // 외부 = 같은 SEC 태그의 이전 10-K 판본 값(2026-10-01 WDC FY2023 세전이익 — 2024 10-K −1,550(SanDisk 분할 전 연결), 2025 10-K −849(분할 후 계속사업으로
      //    재작성). 앱은 나중 공시 우선(오너 결정), 외부는 재작성 전 판본을 유지. 판본 값과 정확히 같을 때만 ②
      if (col !== "LTM" && H[col]?.date && aPassed(col, metric)) {
        const VT = { 세전이익: ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"],
          순이익: ["NetIncomeLoss"], 매출: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax"], 영업이익: ["OperatingIncomeLoss"], 매출원가: ["CostOfRevenue", "CostOfGoodsAndServicesSold"] }[metric];
        for (const tag of VT ?? []) {
          const l = (G[tag]?.units?.USD ?? []).filter((e) => e.start && /^10-K/.test(e.form ?? "") && dayDiff(e.end, H[col].date) <= 7 && (Date.parse(e.end) - Date.parse(e.start)) / 864e5 >= 300);
          if (!l.length) continue;
          const last = l.reduce((x, y) => ((y.filed ?? "") > (x.filed ?? "") ? y : x));
          const old = l.find((e) => (e.filed ?? "") < (last.filed ?? "") && e.val !== last.val && eqExp(e.val));
          if (old && extEq(last.val, r.ours)) return { ok: `${n} = SEC ${tag} 이전 판본 ${old.val}(${old.form} ${old.filed}) — 앱은 최신 판본 ${last.val}(${last.form} ${last.filed}, 재작성), 나중 공시 우선` };
        }
      }
      // 현금흐름 LTM 다른 산식(2026-10-01 MCD LTM 투자활동 SA −3,829 = 사업연도 −3,822 + 당기 누적 −1,648 − 전년 동기 −1,641): 앱은 분기 4개 합(−3,826) —
      //    회사가 분기·누적을 따로 반올림해 두 산식이 백만 단위로 갈린다. 외부 = SEC 사업연도 + 10-Q 누적 − 전년 동기 누적이 정확 성립하면 ②
      if (col === "LTM" && /^현금흐름표 /.test(metric) && H.LTM?.date) {
        const T = { "현금흐름표 영업활동 현금흐름": ["NetCashProvidedByUsedInOperatingActivities", 1], "현금흐름표 투자활동 현금흐름": ["NetCashProvidedByUsedInInvestingActivities", 1],
          "현금흐름표 재무활동 현금흐름": ["NetCashProvidedByUsedInFinancingActivities", 1], "현금흐름표 유형자산 취득(CAPEX)": ["PaymentsToAcquirePropertyPlantAndEquipment", -1],
          "현금흐름표 배당금 지급": ["PaymentsOfDividendsCommonStock", -1], "현금흐름표 자기주식 취득": ["PaymentsForRepurchaseOfCommonStock", -1] }[metric];
        const l = T ? (G[T[0]]?.units?.USD ?? []).filter((e) => e.start && /^10-[KQ]/.test(e.form ?? "")) : [];
        const dur = (e) => (Date.parse(e.end) - Date.parse(e.start)) / 864e5;
        // 당기 누적 = 그 기준일 10-Q 값 중 가장 긴 기간(3개월 값이 아니라 사업연도 초부터의 누적)
        const curAll = l.filter((e) => dayDiff(e.end, H.LTM.date) <= 7 && dur(e) >= 80 && dur(e) <= 300 && /^10-Q/.test(e.form));
        const maxDur = Math.max(0, ...curAll.map(dur));
        const cur = latestPrecise(curAll.filter((e) => dur(e) >= maxDur - 3));
        const fy = cur ? latestPrecise(l.filter((e) => dur(e) >= 300 && dayDiff(e.start, cur.start) > 300 && dayDiff(e.start, cur.start) < 430 && dayDiff(e.end, cur.start) <= 7)) : null;
        const prior = cur && fy ? latestPrecise(l.filter((e) => dayDiff(e.start, fy.start) <= 7 && Math.abs(dur(e) - dur(cur)) <= 7)) : null;
        if (cur && fy && prior) {
          const exp = T[1] * (fy.val + cur.val - prior.val);
          if (!extEq(exp, r.ours) && eqExp(exp)) return { ok: `${n} LTM = SEC 사업연도 ${fy.val} + 당기 누적 ${cur.val} − 전년 동기 ${prior.val} = ${exp}${T[1] < 0 ? "(유출 표기)" : ""} — 앱은 분기 4개 합 ${r.ours}(회사가 분기·누적을 따로 반올림)` };
        }
      }
      // 자본 정정 전 값(오너 결정 (다), WDC FY2022): 외부 = 그 열 재무상태표 원 공시 자본(정정 전) — 앱은 나중 정기공시의 정정 값
      if (metric === "재무상태표 자본 총계" && col !== "LTM" && H[col]?.date) {
        const rs = eqRestate(H[col].date);
        if (rs && extEq(r.ours, rs.base + rs.delta) && eqExp(rs.base)) return { ok: `${n} = 정정 전 원 공시 자본 ${rs.base} — 앱은 ${rs.filed} 정기공시의 정정 값 ${rs.base + rs.delta}(오류 정정 +${rs.delta}, 나중 공시 우선)` };
      }
      // 블룸버그 자체 불일치(2026-10-01 GEV 2025 세전이익) — 블룸버그 분기 화면의 그 사업연도 네 분기 합이 앱(= SEC 연간, A층)과 정확히 같은데 블룸버그 연간 열만
      //    다르다 → 같은 기간에 대한 블룸버그 자신의 두 값이 서로 다름. 외부 단독 이탈
      if (n === "블룸버그" && col !== "LTM" && H[col]?.date && aPassed(col, metric)) {
        const BK = { 매출: "rev", 순이익: "ni", 영업이익: "op", 세전이익: "pretax", 감가상각비: "da", 매출원가: "cogs", 매출총이익: "gp", 판관비: "sga", 연구개발비: "rnd" }[metric];
        const q = BK ? loadBbg(sym)?.qSum(BK, H[col].date) : null;
        if (q && extEq(q.v, r.ours) && !extEq(v, r.ours))
          return { outlier: `외부 자체 불일치 — 블룸버그 분기 화면 ${col} 네 분기 합(${q.parts.join(" + ")}) = ${q.v / 1e6} = 앱(SEC 연간)인데 블룸버그 연간 열만 ${v / 1e6}` };
      }
      // 외부 자체 불일치(2026-09-30) — LTM 기간 = 최근 사업연도(결산일 ±7일, 결산 직후 분기 공시 전 — MSFT FY2026)이고 그 소스의 같은 사업연도 연간
      //    값은 앱과 정확히 같은데 LTM 값만 다르면, 같은 기간에 대한 외부 자신의 두 값이 서로 다르다 → 외부 단독 이탈
      // 자사주 취득(외부) = 앱 − 주식보상 원천징수 세금 납부(2026-10-01 — AAPL StockAnalysis 95,625 = 89,402 + 6,223, DELL 야후·StockAnalysis 3,281 = 2,883 + 398).
      //    SEC PaymentsRelatedToTaxWithholdingForShareBasedCompensation 사업연도 값, 외부가 그 소스로 가진 모든 연간 열에서 정확 성립할 때만
      if (metric === "현금흐름표 자기주식 취득" && col !== "LTM") {
        const tw = (c0) => { const d0 = H[c0]?.date; if (!d0) return null; const l = (G.PaymentsRelatedToTaxWithholdingForShareBasedCompensation?.units?.USD ?? []).filter((e) => e.start && /^10-K/.test(e.form ?? "") && dayDiff(e.end, d0) <= 7 && (Date.parse(e.end) - Date.parse(e.start)) / 864e5 >= 300); return l.length ? latestPrecise(l).val : 0; };
        const rows = [...recon.values()].filter((x) => /^\d{4}Y 현금흐름표 자기주식 취득$/.test(x.item) && x.srcs[n] && x.ours != null);
        const ev = rows.map((x) => { const c0 = x.item.split(" ")[0], w = tw(c0), e = x.ours - (w ?? 0); const u0 = x.srcs[n].unit ?? 1; return { c0, w, ok: extEq(x.srcs[n].v, e) || (u0 !== 1 && extRound(n, x.srcs[n].v, e, u0)) }; });
        if (rows.length >= 2 && ev.every((z) => z.ok) && ev.some((z) => z.w))
          return { ok: `${n} 자사주 취득 = 앱(자기주식 매입) + 주식보상 원천징수 세금 납부 — 모든 연간 열 정확 성립(${ev.map((z) => `${z.c0} 원천징수 ${z.w}`).join(" · ")})` };
      }
      if (metric === "현금흐름표 자기주식 취득" && col === "LTM" && H.LTM?.date) {
        const t = secTtm("PaymentsRelatedToTaxWithholdingForShareBasedCompensation");
        if (t && dayDiff(t.end, H.LTM.date) <= 7 && t.v && eqExp(r.ours - t.v)) return { ok: `${n} LTM 자사주 취득 = 앱 + 주식보상 원천징수 세금 SEC TTM ${t.v}(${t.how ?? ""}) — 연간 열과 같은 정의` };
      }
      // 자본 총계(외부) = 앱(지배주주 자본) + 비지배지분(2026-10-01 — KO·DELL StockAnalysis 는 비지배지분 포함 자본). SEC MinorityInterest 결산일 값
      //    + 임시자본(2026-10-01 — 외부 자본 = 앱 + 비지배지분 + 임시자본: TSLA 2021 SA 31,583 = 30,189 + 826 + 568, BE·UBER·WDC·AVGO 도 같은 꼴).
      //    외부 부채 = 앱 ± 임시자본(TER SA 1,246.981 = 1,245.469 + 1.512 · WMT 야후·SA = 앱 − 상환가능 비지배지분 237 — WMT 는 부채 태그에 포함)
      //    또는 외부 부채 = 부채와 자본 − 자본 − 임시자본(IBM 2024 SA·야후 109,782 — 회사 부채 합계 109,783 과 표기 반올림 1 차).
      //    비지배지분·임시자본은 앱 재무상태표 줄(A층 SEC 대조를 거친 값), 없으면 SEC MinorityInterest
      if ((metric === "재무상태표 자본 총계" || metric === "재무상태표 부채 총계") && H[col]?.date) {
        const l = (G.MinorityInterest?.units?.USD ?? []).filter((e) => !e.start && (col === "LTM" ? /^10-[KQ]/ : /^10-K/).test(e.form ?? "") && dayDiff(e.end, H[col].date) <= 7);
        const bsRows = (bs?.sections ?? []).flatMap((s0) => s0.items ?? []), rv = (id) => bsRows.find((x) => x.accountId === id)?.values?.[col === "LTM" ? "현재/LTM" : col] ?? null;
        const mi = rv("bs:자본:비지배지분") ?? (l.length ? latestPrecise(l).val : null), tq = rv("bs:자본:임시자본");
        if (metric === "재무상태표 자본 총계") {
          for (const [a, b] of [[1, 0], [1, 1], [0, 1]]) {
            if ((a && !mi) || (b && !tq)) continue;
            const exp = r.ours + a * (mi ?? 0) + b * (tq ?? 0);
            if (eqExp(exp)) return { ok: `${n} 자본 총계 = 앱(지배주주 자본) ${r.ours}${a ? ` + 비지배지분 ${mi}` : ""}${b ? ` + 임시자본 ${tq}` : ""} = ${exp}${rnd(exp)} — 외부는 ${[a && "비지배지분", b && "임시자본(상환가능 지분)"].filter(Boolean).join("·")} 포함 자본` };
          }
        } else {
          for (const sg of [1, -1]) if (tq && eqExp(r.ours + sg * tq)) return { ok: `${n} 부채 총계 = 앱 ${r.ours} ${sg > 0 ? "+" : "−"} 임시자본(상환가능 지분) ${tq}${rnd(r.ours + sg * tq)} — ${sg > 0 ? "외부는 임시자본을 부채에 넣음" : "SEC 부채 태그가 임시자본 포함, 외부는 제외"}` };
          const le = rv("bs:자본:부채와 자본 총계"), eq = rv("bs:자본:자본 총계");
          if (le != null && eq != null) {
            const exp = le - eq - (mi ?? 0) - (tq ?? 0);
            if (exp !== r.ours && eqExp(exp)) return { ok: `${n} 부채 총계 = 부채와 자본 ${le} − 자본 ${eq}${mi ? ` − 비지배지분 ${mi}` : ""}${tq ? ` − 임시자본 ${tq}` : ""} = ${exp} — 외부는 차감으로 계산, 회사 부채 합계 ${r.ours} 와 표기 반올림 차` };
          }
        }
      }
      // 재무상태표·현금흐름표 외부 표기 반올림(2026-10-01 MCD 2022·2023 — 앱 = SEC 10만 달러 단위 정밀값, 야후·SA 는 100만 단위(반올림·버림)).
      //    외부가 100만의 배수이고 앱은 아니며 차가 100만 미만일 때만 — 외부 정밀도 부족(NA)
      if (/^(재무상태표|현금흐름표) /.test(metric) && r.ours != null && r.ours % 1e6 !== 0 && v % 1e6 === 0 && Math.abs(v - r.ours) < 1e6 && aPassed(col, metric))
        return { na: `${n} 100만 단위 표기 — 앱(SEC 정밀값) ${r.ours} → ${v}` };
      // 블룸버그 부동소수 반올림(2026-10-01 TER 2021 세전이익 1,160,955천 → 블룸버그 1,160.95 — 1160.955 는 이진 부동소수로 1160.95499… 라
      //    소수 2자리 반올림이 .95). 십진 반올림(0.5 먼 쪽·짝수 쪽)으로는 안 되고 부동소수 toFixed 로만 정확히 재현될 때 외부 정밀도 부족
      if (n === "블룸버그" && unit != null && unit >= 1 && unit < 1e6 && r.ours != null && !extEq(v, r.ours)) {
        const dec = Math.round(Math.log10(1e6 / unit));
        if (dec >= 1 && dec <= 3) {
          const fl = Math.round(Number((r.ours / 1e6).toFixed(dec)) * 1e6);
          if (fl === Math.round(v) && ![roundHalfAway, roundHalfEven].some((f) => extEq(v, f(r.ours, unit))))
            return { na: `블룸버그 부동소수 반올림 — (${r.ours / 1e6}).toFixed(${dec}) = ${(r.ours / 1e6).toFixed(dec)}(이진 표현 때문에 .5 가 아래로) = 블룸버그 ${v / 1e6}` };
        }
      }
      // 블룸버그 LTM = 앱 LTM − 앱 4분기(연간 − 9개월 누적, SEC) + 4분기 실적발표 8-K 분기값(CL·IBM 세전이익, 블룸버그 분기 화면으로 확인 2026-09-30)
      if (n === "블룸버그" && col === "LTM" && metric === "감가상각비" && q4Rel.has(metric)) {
        const q = q4Rel.get(metric);
        const qrow = (isq?.sections ?? []).flatMap((x) => x.items ?? []).find((it) => it.accountName === "감가상각비");
        const qp = (isq?.periods ?? []).find((pp) => pp.endDate && dayDiff(pp.endDate, q.fyEnd) <= 7);
        const appQ4 = qp ? qrow?.values?.[qp.label] ?? null : null;
        if (appQ4 != null && q.v !== appQ4) {
          const exp = r.ours - appQ4 + q.v;
          if (eqExp(exp)) return { ok: `블룸버그 LTM 감가상각비 = 앱 LTM ${r.ours} − 앱 4분기(${qp.label}, 사업연도 − 9개월) ${appQ4} + 4분기 실적발표 8-K(${q.filed}) 분기값 ${q.v} = ${exp}${rnd(exp)} — 회사가 연간·누적·분기를 따로 반올림, 블룸버그는 발표 분기값 사용 · ${q.url}` };
        }
      }
      if (n === "블룸버그" && col === "LTM" && q4Rel.has(metric) && metric !== "감가상각비") {
        const q = q4Rel.get(metric);
        const TAG = { 세전이익: "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest" }[metric];
        const l = (G[TAG]?.units?.USD ?? []).filter((e) => e.start && /^10-[KQ]/.test(e.form ?? ""));
        const fyE = latestPrecise(l.filter((e) => dayDiff(e.end, q.fyEnd) <= 7 && (Date.parse(e.end) - Date.parse(e.start)) / 864e5 >= 300));
        const nine = fyE ? latestPrecise(l.filter((e) => dayDiff(e.start, fyE.start) <= 5 && (Date.parse(e.end) - Date.parse(e.start)) / 864e5 >= 250 && (Date.parse(e.end) - Date.parse(e.start)) / 864e5 <= 290)) : null;
        if (fyE && nine) {
          const q4sec = fyE.val - nine.val, exp = r.ours - q4sec + q.v;
          if (q.v !== q4sec && eqExp(exp))
            return { ok: `블룸버그 LTM ${metric} = 앱 LTM ${r.ours} − 앱 4분기(연간 ${fyE.val} − 9개월 ${nine.val} = ${q4sec}) + 4분기 실적발표 8-K(${q.filed}) 분기값 ${q.v} = ${exp}${rnd(exp)} — 회사가 연간·누적·분기를 따로 반올림, 블룸버그는 발표 분기값 사용 · ${q.url}` };
        }
      }
      // 외부 자체 불일치(감가상각비) — 외부 EBITDA − 외부 영업이익 = 앱 감가상각비인데 외부 감가상각비 칸만 다르다(SNDK FY2026 블룸버그: EBITDA 12,538
      //    − 영업이익 = 149 = 앱, 감가상각비 칸 113 = 149 − 1분기 36)
      if (metric === "감가상각비" && !extEq(v, r.ours)) {
        const eb = recon.get(`${col} EBITDA`)?.srcs[n]?.v, op = recon.get(`${col} 영업이익`)?.srcs[n]?.v;
        if (eb != null && op != null && extEq(eb - op, r.ours) && !extEq(eb - op, v))
          return { outlier: `외부 자체 불일치 — ${n} EBITDA ${eb} − ${n} 영업이익 ${op} = ${eb - op} = 앱 감가상각비인데 ${n} 감가상각비 칸만 ${v}` };
      }
      // 블룸버그 암묵 감가상각비(2026-10-01 CEG·VST 2021 — 블룸버그에 감가상각비 칸이 없음): 블룸버그 EBITDA − 블룸버그 영업이익 = 앱 감가상각비(A층 통과)면
      //    블룸버그도 앱과 같은 감가상각비를 쓴 것 → 이 소스만 다름(외부 단독 이탈)
      // A층이 공통모드(줄 선택 규칙 = 앱)여도 블룸버그 암묵값이 앱과 정확히 같으면 그것이 독립 확인(independentOr 원칙)
      if (metric === "감가상각비" && n !== "블룸버그" && !extEq(v, r.ours) && checks.some((k) => k.col === col && (k.status === PASS || k.status === COMMON) && /^감가상각비 앱 = SEC 현금흐름표 감가상각·상각 줄 합$/.test(k.name))) {
        const B = (k) => recon.get(`${col} ${k}`)?.srcs["블룸버그"]?.v;
        const eb = B("EBITDA"), op = B("영업이익");
        if (B("감가상각비") == null && eb != null && op != null && extEq(eb - op, r.ours))
          return { outlier: `블룸버그 EBITDA ${eb} − 영업이익 ${op} = ${eb - op} = 앱 감가상각비(블룸버그 감가상각비 칸 없음) — ${n} 만 ${v}` };
      }
      if (col === "LTM" && H.LTM?.date && !extEq(v, r.ours) && !(metric === "감가상각비" && daRule(n, col))) {
        const fyc = Object.keys(H).find((c) => c !== "LTM" && H[c]?.date && dayDiff(H[c].date, H.LTM.date) <= 7);
        const x = fyc ? recon.get(`${fyc} ${metric}`) : null;
        if (x?.srcs[n] && extEq(x.ours, r.ours) && extEq(x.srcs[n].v, x.ours))
          return { outlier: `외부 자체 불일치 — LTM 기간 = ${fyc}(결산일 ${H[fyc].date}), ${n} ${fyc} 연간 값 ${x.srcs[n].v} = 앱 ${r.ours}인데 ${n} LTM 만 ${v}` };
      }
      // 블룸버그 "정정" 열 순이익 끼워 맞춤(2026-09-30 WDC FY2022, 블룸버그 "공시기준" 화면 "정정:2022 A" 확인) — 나중 10-K 가 그 해 순이익을 재작성
      //    (원 10-K 1,500 → 1,546)했을 때 블룸버그는 재작성 순이익만 받고 나머지 줄은 원 10-K 값을 둔 채 차이(ΔNI = +46)를 판관비에서 뺀다:
      //    판관비 = 원 판관비 − ΔNI(1,117 → 1,071), 영업이익 = 원 영업이익 + ΔNI(2,391 → 2,437), 세전이익 = 원 세전이익 + ΔNI(2,123 → 2,169 — 실제 재작성
      //    세전이익은 2,171), EBITDA 도 + ΔNI. 판관비·영업이익·세전이익·순이익은 모두 SEC 원 10-K 판본·최신 판본 값으로 정확히 성립할 때만
      if (n === "블룸버그" && col !== "LTM" && H[col]?.date && /^(판관비|판관비·연구개발비|영업이익|세전이익|EBITDA)$/.test(metric)) {
        const all = (t) => annualAllAt(t, "USD", H[col].date);
        const NI = all("NetIncomeLoss"), ni0 = NI[0], ni1 = NI.at(-1), dNi = ni0 && ni1 ? ni1.val - ni0.val : 0;
        if (dNi !== 0) {
          const first = (t) => all(t)[0] ?? null;
          const tagOf = { 판관비: "SellingGeneralAndAdministrativeExpense", 영업이익: "OperatingIncomeLoss", 세전이익: "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest" };
          let exp = null, ev = "";
          if (metric === "판관비" || metric === "판관비·연구개발비") {
            const sg = first(tagOf.판관비);
            const rd = metric === "판관비·연구개발비" ? (first("ResearchAndDevelopmentExpense") ?? first("ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost")) : null;
            if (sg && (metric === "판관비" || rd)) { exp = sg.val - dNi + (rd?.val ?? 0); ev = `원 10-K 판관비 ${sg.val}(${sg.filed})${rd ? ` + 연구개발비 ${rd.val}` : ""} − ΔNI ${dNi}`; }
          } else if (metric === "EBITDA") {
            const op = first(tagOf.영업이익), da = recon.get(`${col} 감가상각비`)?.srcs[n]?.v;
            if (op && da != null) { exp = op.val + dNi + da; ev = `원 10-K 영업이익 ${op.val}(${op.filed}) + ΔNI ${dNi} + 블룸버그 감가상각비 ${da}`; }
          } else {
            const x = first(tagOf[metric]);
            if (x) { exp = x.val + dNi; ev = `원 10-K ${metric} ${x.val}(${x.filed}) + ΔNI ${dNi}`; }
          }
          if (exp != null && eqExp(exp) && !extEq(exp, r.ours))
            return { outlier: `외부 단독 이탈(블룸버그 자체 구성, 오너 판단 2026-09-30 — 공시에 없는 값) — 블룸버그 "정정" 열 — 재작성 순이익만 반영(원 10-K ${ni0.val}(${ni0.filed}) → ${ni1.val}(${ni1.filed}), ΔNI ${dNi})하고 차이를 판관비에서 뺌: ${ev} = ${exp}${rnd(exp)} · 앱은 SEC 최신 판본` };
        }
      }
      // EBITDA 성분 판정(오너 지시 2026-09-30 "에비타만 떼서도") — 외부 EBITDA = 외부 영업이익 + 외부 감가상각비(같은 소스·같은 열, 정확 일치 또는
      //    블룸버그 성분별 반올림)이고 두 성분이 모두 ①(앱과 일치) 또는 원인 확인·외부 정밀도 부족이면 EBITDA 도 그 원인을 물려받는다
      if (metric === "EBITDA") {
        const it = (m) => recon.get(`${col} ${m}`);
        // 성분이 이 소스만 앱과 다르고 다른 외부가 앱과 정확히 일치하면 "이탈"(2026-10-01 CEG LTM — 야후 감가상각비 2,334, 블룸버그 3,669 = 앱)
        const st = (m) => { const x = it(m), s0 = x?.srcs[n]; if (!s0) return null; if (extEq(x.ours, s0.v)) return "①"; const d = done.get(`${x.item}|${n}`); if (d?.ok) return "②"; if (d?.na) return "NA"; if (d?.outlier || Object.entries(x.srcs).some(([k, z]) => k !== n && k !== "인포맥스" && (extEq(z.v, x.ours) || done.get(`${x.item}|${k}`)?.ok))) return "이탈"; return null; };
        const o = it("영업이익")?.srcs[n]?.v, d = it("감가상각비")?.srcs[n]?.v, so = st("영업이익"), sd = st("감가상각비");
        if (o != null && d != null && so && sd && (so === "이탈" || sd === "이탈") && extEq(v, o + d))
          return { outlier: `EBITDA = ${n} 영업이익 ${o}(${so}) + ${n} 감가상각비 ${d}(${sd}) — 차이는 ${n} 단독 이탈 성분 몫` };
        if (o != null && d != null && so && sd && so !== "이탈" && sd !== "이탈" && (extEq(v, o + d) || (n === "블룸버그" && unit >= 1 && ([roundHalfAway, roundHalfEven].some((f) => extEq(v, f(o, unit) + f(d, unit))) || (Math.abs(v - (o + d)) <= unit + 1e-6 && (so === "NA" || sd === "NA"))))))
          return (so === "NA" || sd === "NA") && so !== "②" && sd !== "②"
            ? { na: `EBITDA = ${n} 영업이익 ${o}(${so}) + ${n} 감가상각비 ${d}(${sd}) — 성분 외부 정밀도 부족` }
            : { ok: `EBITDA = ${n} 영업이익 ${o}(${so}) + ${n} 감가상각비 ${d}(${sd}) — 두 성분 모두 앱과 일치 또는 원인 확인` };
      }
      // 영업이익 = 외부 매출총이익 − 판관비 − 연구개발비(오너 지시 2026-09-30 "IBM 진행") — 외부가 본표의 기타 영업수익·손익 줄(IBM "지식재산·
      //    주문개발 수익" 612·663·860·996·964)을 영업이익에서 뺀다. 판관비·연구개발비가 그 소스에서 앱과 일치(①)할 때만, 외부 자기 매출총이익으로
      //    정확 일치. 매출총이익 칸의 차이(IBM 블룸버그 매출원가 ±1)는 그 칸에 따로 남는다
      if (metric === "영업이익" && true /* LTM 도(2026-09-30 IBM LTM 블룸버그) */) {
        const it = (m) => recon.get(`${col} ${m}`);
        const same = (m) => { const x = it(m); return x?.srcs[n] && extEq(x.ours, x.srcs[n].v) ? x.ours : null; };
        const gpx = it("매출총이익")?.srcs[n]?.v, sg = same("판관비"), rd = it("연구개발비")?.srcs[n] ? same("연구개발비") : 0;
        if (gpx != null && sg != null && rd != null && IS[col]?.gp != null) {
          const exp = gpx - sg - rd, other = r.ours - (IS[col].gp - sg - rd);
          if (extEq(v, exp) && Math.abs(other) >= 1e6) {
            const ip = annualAllAt("IntellectualPropertyAndCustomDevelopmentIncome", "USD", H[col]?.date ?? "").at(-1);
            return { ok: `${n} 영업이익 = ${n} 매출총이익 ${gpx} − 판관비 ${sg} − 연구개발비 ${rd} = ${exp} — 앱 영업이익은 본표의 기타 영업 항목 ${other}${ip ? `(지식재산·주문개발 수익 ${ip.val} 포함)` : ""}을 포함, 외부는 제외` };
          }
        }
      }
      // 블룸버그 매출총이익 0.5 관계식(오너 지시 2026-09-30) — 블룸버그 = round(앱 매출) − round(앱 매출원가)(각자 표기 단위, 0.5 먼 쪽·짝수 쪽).
      //    매출총이익 성분 판정(gpCause)보다 먼저 — 식이 정확히 같을 때만 NA(외부 정밀도 부족)
      if (n === "블룸버그" && metric === "매출총이익" && col !== "LTM" && unit >= 1 && IS[col]?.rev != null && IS[col]?.cogs != null && !extEq(v, r.ours)) {
        for (const f of [roundHalfAway, roundHalfEven]) {
          const s = f(IS[col].rev, unit) - f(IS[col].cogs, unit);
          if (extEq(v, s)) return { na: `블룸버그 표기 단위(${unit}) 반올림 관계식 — round(앱 매출 ${IS[col].rev}) − round(앱 매출원가 ${IS[col].cogs}) = ${v}(0.5 는 ${f === roundHalfEven ? "짝수 쪽" : "0 에서 먼 쪽"})` };
        }
      }
      // ⑬ 외부 LTM = SEC 종전 식(사업연도 + 당기 누적 − 전년 동기), 앱 LTM = 최근 4개 분기 합(오너 결정 2026-09-28). 두 식 모두 SEC 원자료로
      //    검증기가 따로 계산 — 외부 = 앱 + (종전 식 − 분기 합) 이 정확히 성립할 때만(회사가 연간·누적·분기를 따로 반올림한 ±1 등)
      if (col === "LTM" && H.LTM?.date && aPassed(col, metric === "판관비·연구개발비" ? "판관비" : metric)) {
        const L0 = H.LTM.date;
        const pick = (old) => {
          if (metric === "매출") return revFace?.ltmAt(L0, old)?.v ?? null;
          if (metric === "매출원가") return cogsFace?.ltmAt(L0, old)?.cogs ?? null;
          if (metric === "매출총이익") { const e = cogsFace?.ltmAt(L0, old), rv = revFace?.ltmAt(L0, old)?.v; return e?.gp ?? (e?.cogs != null && rv != null ? rv - e.cogs : null); }
          if (metric === "영업이익") return opincFace?.ltmAt(L0, old)?.v ?? null;
          if (metric === "감가상각비") return daFace?.ltmAt(L0, old)?.v ?? null;
          if (metric === "판관비" || metric === "연구개발비" || metric === "판관비·연구개발비") {
            const e = sgaFace?.ltmAt(L0, old);
            const sg = e?.sga?.v ?? null, rd = e?.rnd?.empty ? 0 : e?.rnd?.v ?? null;
            return metric === "판관비" ? sg : metric === "연구개발비" ? rd : sg != null && rd != null ? sg + rd : null;
          }
          if (metric === "순이익" || metric === "세전이익") {
            const tags = metric === "순이익" ? ["NetIncomeLoss", "ProfitLoss"] : PRETAX_TAGS;
            for (const t of tags) { const x = secTtm(t, old); if (x && dayDiff(x.end, L0) <= 7) return x.v; }
          }
          return null;
        };
        const oldV = pick(true), newV = pick(false);
        if (oldV != null && newV != null && oldV !== newV && eqExp(r.ours + (oldV - newV)))
          return { ok: `${n} LTM ${metric} = SEC 종전 식(사업연도 + 당기 누적 − 전년 동기) ${oldV} — 앱 LTM 은 최근 4개 분기 합 ${newV}(오너 결정 2026-09-28), 회사가 연간·누적·분기를 따로 반올림한 차 ${oldV - newV}${rnd(r.ours + oldV - newV)}` };
      }
      // ⑪ 외부 = 그 결산기를 처음 실은 10-K 의 원 공시 값(재작성 전), 앱 = 최신 공시(재작성본) — 2026-09-28 실측: WDC FY2023·FY2024 인포맥스
      //    매출 12,318·13,003 = 샌디스크 분사 재작성 전 원 10-K(앱 6,255·6,317 = 2025 10-K 재작성본), 매출원가·매출총이익도 같은 판본.
      //    같은 개념의 연간 사실이 공시마다 다르고, 앱 = 최신 공시 값(A층 통과)이며 외부 = 최초 공시 값일 때만 — 허용 오차 없음
      if (col !== "LTM" && H[col]?.date && aPassed(col, metric) && /^(매출|매출원가|매출총이익)$/.test(metric)) {
        const cs = metric === "매출" ? ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"]
          : metric === "매출원가" ? ["CostOfGoodsAndServicesSold", "CostOfRevenue", "CostOfGoodsSold"] : ["GrossProfit"];
        for (const c of cs) {
          const L = annualAllAt(c, "USD", H[col].date);
          if (L.length < 2) continue;
          const first = L[0], last = L.at(-1);
          if (first.val !== last.val && extEq(r.ours, last.val) && eqExp(first.val))
            return { ok: `${n} ${metric} = 재작성 전 원 공시 값 — ${c} ${first.form} ${first.filed} ${first.val}${rnd(first.val)}, 앱 = 최신 공시 ${last.form} ${last.filed} ${last.val}(A층 통과) · 공통모드 아님(SEC 판본으로 독립 재현)` };
        }
      }
      // ⑫ 외부 매출원가 = 앱 + 무형자산 상각(AmortizationOfIntangibleAssets, 차원 없는 연간 값), 매출총이익 = 앱 − 같은 금액 — 외부가 본표 영업비용의
      //    무형자산 상각 줄을 원가로 옮긴다. 2026-09-28 실측: ORCL FY2023~2026 인포맥스 원가 차 3,582·3,010·2,307·1,671 = 그 해 무형자산 상각 정확 일치
      if (col !== "LTM" && H[col]?.date && aPassed(col, metric) && /^(매출원가|매출총이익)$/.test(metric)) {
        const am = annualAllAt("AmortizationOfIntangibleAssets", "USD", H[col].date).at(-1);
        if (am?.val) {
          const exp = metric === "매출원가" ? r.ours + am.val : r.ours - am.val;
          if (eqExp(exp)) return { ok: `${n} ${metric} = 앱 ${metric === "매출원가" ? "+" : "−"} 무형자산 상각 ${am.val}(AmortizationOfIntangibleAssets ${am.form} ${am.filed}) = ${exp}${rnd(exp)} — 외부는 영업비용의 무형자산 상각을 원가에 넣음 · 공통모드 아님` };
        }
      }
      // 인포맥스 값 하나(분기·연간) = SEC 식 — 완전 일치 또는 인포맥스 표기 단위 반올림 식
      const iu = imAnnual?.unit ?? 1;
      const imEq = (a, b) => extEq(a, b) || (iu !== 1 && b != null && extEq(a, roundHalfAway(b, iu)));
      // 외부 표기 단위 반올림 — 외부 = roundHalfAway(앱, 외부 표기 단위)(파생 외부 값은 성분별 반올림의 합). 오너 결정 2026-09-26:
      //    이 식만으로 설명되는 차이는 증거가 아니다(앱 값이 단위 안에서 틀려도 성립) — ② 가 아니라 NA "검증불가(외부 정밀도 부족)".
      //    바로 돌려주지 않고 표시만 해 둔다 — 아래 독립 규칙(SEC 원자료 식)이 성립하면 그쪽이 우선
      let unitNa = null;
      if (unit != null && unit !== 1) {
        if (!parts && extRound(n, v, r.ours, unit))
          unitNa = `외부 표기 단위 반올림 — round(앱 ${r.ours}, ${unit}${n === "블룸버그" ? ", 0.5 는 0 에서 먼 쪽 또는 짝수 쪽" : ", 0.5 는 0 에서 먼 쪽"}) = ${n} ${v}`;
        else if (parts) {
          const s = parts.reduce((t, [sg, a]) => t + sg * roundHalfAway(a, unit), 0), se = n === "블룸버그" && unit >= 1 ? parts.reduce((t, [sg, a]) => t + sg * roundHalfEven(a, unit), 0) : null;
          if (extEq(v, s) || (se != null && extEq(v, se))) unitNa = `외부 표기 단위 반올림(성분별) — ${parts.map(([sg, a]) => `${sg < 0 ? "− " : ""}round(앱 ${a}, ${unit})`).join(" ")} = ${n} ${v}`;
        }
      }
      // 블룸버그 0.5 관계식(오너 지시 2026-09-30 — "±1백만도 0.5 관계식을 찾아라"): 블룸버그는 분기·성분을 각자 표기 단위로 반올림한 뒤 더한다.
      //    (가) LTM = Σ round(앱 분기 4개 — SEC 분기 대조 통과 값, 블룸버그 표기 단위), (나) 매출총이익 = round(앱 매출) − round(앱 매출원가)
      //    (LTM 이면 분기마다 반올림한 매출 − 매출원가의 합). 반올림은 0.5 먼 쪽·짝수 쪽 둘 다. 식이 정확히 같을 때만 NA(외부 정밀도 부족)
      if (!unitNa && n === "블룸버그" && unit != null && unit >= 1) {
        const RR = { 매출: /^(매출액|순수익)(\s|$)/, 매출원가: COGS_ROW_RE, 매출총이익: GP_ROW_RE, 판관비: /^\(−\) 판매관리비/, 연구개발비: /^\(−\) 연구개발비/, 영업이익: /^영업이익/, 순이익: /^당기순이익$/, 감가상각비: /^감가상각비$/, 세전이익: /^세전이익/ };
        const qRow = (re) => { const it = isItem(isq, re); const ps = (isq?.periods ?? []).slice(-4); if (!it || ps.length !== 4) return null; const vs = ps.map((p) => it.values?.[p.label]); return vs.every((x) => x != null) ? vs : null; };
        const rsum = (vs, f) => vs.reduce((t, x) => t + f(x, unit), 0);
        const comp = metric === "판관비·연구개발비" ? [[1, "판관비"], [1, "연구개발비"]] : metric === "매출총이익" ? [[1, "매출"], [-1, "매출원가"]] : [[1, metric]];
        for (const f of [roundHalfAway, roundHalfEven]) {
          let s = 0, ok = true, how = [];
          for (const [sg, m] of comp) {
            if (col === "LTM") { const vs = RR[m] ? qRow(RR[m]) : null; if (!vs) { ok = false; break; } s += sg * rsum(vs, f); how.push(`${sg < 0 ? "− " : ""}Σround(앱 ${m} 분기 ${vs.join("·")})`); }
            else { const a = m === "매출" ? IS[col]?.rev : m === "매출원가" ? IS[col]?.cogs : m === "판관비" ? IS[col]?.sga : m === "연구개발비" ? IS[col]?.rnd : null; if (a == null || comp.length === 1) { ok = false; break; } s += sg * f(a, unit); how.push(`${sg < 0 ? "− " : ""}round(앱 ${m} ${a})`); }
          }
          if (ok && extEq(v, s) && !extEq(v, r.ours)) { unitNa = `블룸버그 표기 단위(${unit}) 반올림 관계식 — ${how.join(" ")} = ${v}(0.5 는 ${f === roundHalfEven ? "짝수 쪽" : "0 에서 먼 쪽"})`; break; }
        }
      }
      // (삭제 2026-09-26) 예전 "종가 표기 단위(센트)" NA 규칙 — 앱이 Yahoo 부동소수 종가를 곱해 인포맥스(센트 종가)와 주식수 × 꼬리만큼
      //    달랐던 것을 NA 로 보냈다. 앱이 실제 체결가(호가 단위)로 정리한 뒤로는 같은 주식수면 완전 일치(①)이고, 남는 차이는 다른 원인
      //    규칙이 설명하지 못하면 ③ 이다(오너 결정).
      // 영업이익(--metric=opinc) — 전 열 규칙(opRule)·LTM 분기 합(opQuarterSum)만. 아래 옛 열 단위 규칙(일회성비용 한 열 · R7 SA 자체 분류)은
      //    이 모드에서 쓰지 않는다 — 앱 행 값·SA 자기 조정값이라 SEC 원자료 식이 아니고, 한 해만 맞는 식은 규칙이 아니다
      if (OPINC_MODE && metric === "영업이익") {
        if (!aPassed(col, "영업이익")) return { guess: "앱 ≠ SEC 본표 영업이익(A층 미통과) — 원인 판정 전제 없음" };
        const tail = "앱 = SEC 본표 영업이익(A층 정확 일치)";
        if (col === "LTM") {
          const qs = opQuarterSum(n);
          if (qs?.outlier) return { outlier: qs.outlier };
          if (qs) return { ok: `${n} LTM 영업이익 = 자기 분기 4개 합, 분기마다 SEC 본표 분기값과 정확 일치(${qs.rows.join(" · ")}) — SEC 분기 합 ${qs.sec} ≠ 앱 LTM ${r.ours}(앱이 분기 4개를 못 채워 종전 식 — 사업연도 + 당기 누적 − 전년 동기 — 을 쓴 열: 회사가 분기·누적을 따로 반올림) · ${tail}` };
        }
        const hit = opRule(n, col);
        if (hit) return { ok: `${n} 영업이익 = ${hit.label} — 식을 계산할 수 있는 모든 연간 열 정확 성립(${hit.ev.join(" · ")})${hit.skipped.length ? ` · 계산 불가 열 ${hit.skipped.map(([c, w]) => `${c}(${w})`).join(", ")}` : ""} · ${tail}` };
        if (n === "인포맥스" && col !== "LTM" && H[col]?.date) { const g = imSelfGap(imAnnual, H[col].date, v, r.ours, (q) => q.op); if (g) return g; }
        if (unitNa) return { na: unitNa };
        return { appsec: `${tail} — ${n} 정의 미분해` };
      }
      // 감가상각비(--metric=da) — 전 열 규칙(daRule)·LTM 분기 합(daQuarterSum)만. 아래 옛 열 단위 규칙(⑥ 운용리스 한 열 · ⑦ SA 자체 기타상각 · ⑧ 한 열
      //    조정액 · ⑤ 다른 소스 일치 추정)은 이 모드에서 쓰지 않는다 — 한 해만 맞는 식은 규칙이 아니고, SA 자기 값은 SEC 원자료 식이 아니다
      if (DA_MODE && metric === "감가상각비") {
        if (!aPassed(col, "감가상각비")) return { guess: "앱 ≠ SEC 현금흐름표 감가상각·상각 줄 합(A층 미통과) — 원인 판정 전제 없음" };
        const tail = "앱 = SEC 현금흐름표 감가상각·상각 줄 합(A층 정확 일치)";
        if (col === "LTM") {
          const qs = daQuarterSum(n);
          if (qs) return { ok: `${n} LTM 감가상각비 = 자기 분기 4개 합, 분기마다 SEC 현금흐름표 분기값(누적 차)과 정확 일치(${qs.rows.join(" · ")}) — SEC 분기 합 ${qs.sec} ≠ 앱 LTM ${r.ours}(앱이 분기 4개를 못 채워 종전 식 — 사업연도 + 당기 누적 − 전년 동기 — 을 쓴 열: 회사가 분기·누적을 따로 반올림) · ${tail}` };
        }
        const hit = daRule(n, col);
        if (hit) return { ok: `${n} 감가상각비 = ${hit.label} — 식을 계산할 수 있는 모든 연간 열 정확 성립(${hit.ev.join(" · ")})${hit.skipped.length ? ` · 계산 불가 열 ${hit.skipped.map(([c, w]) => `${c}(${w})`).join(", ")}` : ""} · ${tail}` };
        if (n === "인포맥스" && col !== "LTM" && H[col]?.date) { const g = imSelfGap(imAnnual, H[col].date, v, r.ours, (q) => q.da); if (g) return g; }
        if (unitNa) return { na: unitNa };
        return { appsec: `${tail} — ${n} 정의 미분해` };
      }
      // 판관비·연구개발비(--metric=sga) — 전 열 규칙(sgaRule)·LTM 분기 합(sgaQuarterSum)만(감가상각비와 같은 모양)
      if (SGA_MODE && /^(판관비|연구개발비|판관비·연구개발비)$/.test(metric)) {
        if (!aPassed(col, metric)) return { guess: "앱 ≠ SEC 본표 판관비·연구개발비 성격 줄 합(A층 미통과) — 원인 판정 전제 없음" };
        const tail = "앱 = SEC 본표 성격 줄 합(A층 정확 일치)";
        if (col === "LTM") {
          const qs = sgaQuarterSum(n, metric);
          if (qs) return { ok: `${n} LTM ${metric} = 자기 분기 4개 합, 분기마다 SEC 본표 분기값과 정확 일치(${qs.rows.join(" · ")}) — SEC 분기 합 ${qs.sec} ≠ 앱 LTM ${r.ours}(앱이 분기 4개를 못 채워 종전 식 — 사업연도 + 당기 누적 − 전년 동기 — 을 쓴 열: 회사가 분기·누적을 따로 반올림) · ${tail}` };
        }
        const hit = sgaRule(n, metric, col);
        if (hit) return { ok: `${n} ${metric} = ${hit.label} — 식을 계산할 수 있는 모든 연간 열 정확 성립(${hit.ev.join(" · ")})${hit.skipped.length ? ` · 계산 불가 열 ${hit.skipped.map(([c, w]) => `${c}(${w})`).join(", ")}` : ""} · ${tail}` };
        if (unitNa) return { na: unitNa };
        return { appsec: `${tail} — ${n} 정의 미분해` };
      }
      // ① 외부가 일회성 항목을 뺀 조정값 — 외부 = 앱 + 앱 일회성비용(식 정확 성립)
      const oneOff = /^(영업이익|EBITDA)$/.test(metric) ? IS[col]?.oneOff : null;
      if (oneOff != null && oneOff !== 0 && eqExp(r.ours + oneOff)) return { ok: `일회성 항목 조정 — ${n} = 앱 ${r.ours} + 앱 일회성비용 ${oneOff}${rnd(r.ours + oneOff)}` };
      // ② 외화 공시의 Yahoo 는 원통화 — 같은 해 두 지표에서 "앱 ÷ Yahoo" 비율(=환율)이 같다(부동소수 표현 차만 — 허용 오차 없음)
      if (foreign && n === "Yahoo") {
        const other = ["매출", "순이익", "영업이익"].filter((m) => m !== metric).map((m) => recon.get(`${col} ${m}`)).find((x) => x?.srcs.Yahoo?.v);
        if (other) {
          const k1 = r.ours / v, k2 = other.ours / other.srcs.Yahoo.v;
          if (extEq(r.ours / k2, v) && Math.abs(k1 - 1) > 1e-3) return { ok: `Yahoo 원통화 표시 — 앱÷Yahoo 비율 ${k1.toPrecision(6)} 이 ${other.item} 과 같음(환율)` };
        }
      }
      // ⑨ 인포맥스 희석 EPS = round(SEC 순이익 ÷ SEC 희석 가중평균주식수, 소수 넷째 자리) — 인포맥스는 공시 EPS 가 아니라
      //    자체 계산한다(실측: AMAT 2021·CEG·DAL·HLT·MU 2022·PEP 2021 최신 공시 순이익, WDC 2022·DELL 2024 최초 공시 순이익).
      //    앱 EPS 가 A층 SEC 공시 EPS 대조를 통과한 기간만. 공통모드 아님 — SEC 원자료로 인포맥스 값을 독립 재현.
      //    A층 EPS 는 이제 정확 비교(상대 1e-9)지만, 인스턴스(클래스별) 경로도 같은 이름을 쓰므로 여기서 다시 공시 희석 EPS(분할
      //    보정) 또는 계속+중단영업 합과 **정확히** 같은지 확인한다(예전 허용치 0.006 + 0.3% 시절 MU 2024 0.70×1.01 주입이 통과했던 경로).
      const epsExact = (() => {
        if (!H[col]?.date || r.ours == null) return false;
        const e = atEnd(epsP, H[col].date), cd = e ? null : contDiscEps(H[col].date);
        const exp = e ? e.val / splitAdj(e) : cd ? (cd.cont + cd.disc) / splitAdj({ end: H[col].date, filed: cd.filed }) : null;
        return exp != null && Math.abs(r.ours - exp) <= 1e-9 * Math.max(1, Math.abs(exp));
      })();
      if (metric === "희석 EPS" && n === "인포맥스" && col !== "LTM" && epsExact && !splitErr
        && checks.some((k) => k.col === col && k.status === PASS && k.name === "EPS 앱 = SEC 공시 EPS(분할 보정)")) {
        const niL = annualAllAt("NetIncomeLoss", "USD", H[col].date);
        const sh = annualAllAt("WeightedAverageNumberOfDilutedSharesOutstanding", "shares", H[col].date).at(-1);
        if (sh?.val) {
          const k = splitAdj(sh); // 희석주식수 공시 뒤 분할 → 오늘 주식 기준
          for (const [lab, ni] of [["최신 공시", niL.at(-1)], ["최초 공시", niL[0]]]) {
            if (!ni) continue;
            const q = ni.val / (sh.val * k);
            // 식: roundHalfAway(SEC 순이익 ÷ 희석 가중평균, 소수 넷째 자리) = 인포맥스(허용 오차 없음 — 넷째 자리 정수 배율로 비교)
            if (Math.round(roundHalfAway(q, 1e-4) * 1e4) === Math.round(v * 1e4)) return { ok: `인포맥스는 순이익 ÷ 희석주식수로 자체 계산(공시 EPS 아님) — SEC 순이익(${lab} ${ni.filed}) ${ni.val} ÷ 희석 가중평균 ${sh.val}${k !== 1 ? `×분할 ${k}` : ""} = ${q}, 소수 넷째 자리 반올림(0.5 는 0 에서 먼 쪽) ${q.toFixed(4)} = 인포맥스, 앱 EPS = SEC 공시 EPS 정확 일치(A층 통과) · 공통모드 아님(SEC 원자료로 독립 재현)` };
          }
        }
      }
      // ⑩ 순이익 — 외부가 다른 SEC 판본·줄을 쓴 경우(2026-09-29): (가) 나중 10-K 의 반올림 재게시 값(MCD 2022 6,177.4 → 2025 10-K 6,177 —
      //    앱은 원 공시 정밀값), (나) 보통주 귀속 순이익(TSLA Yahoo 12,583 · WDC 2026 Yahoo 9,298 — 앱은 지배주주 순이익 NetIncomeLoss).
      //    그 해 10-K 태그 값과 정확히 같을 때만. 공통모드 아님(SEC 원자료)
      if (metric === "순이익" && col !== "LTM" && H[col]?.date && aPassed(col, "순이익")) {
        const at = (tag) => annualAllAt(tag, "USD", H[col].date);
        const L = at("NetIncomeLoss"), last = L.at(-1);
        if (last && extEq(v, last.val) && !extEq(last.val, r.ours) && L.some((e) => extEq(e.val, r.ours)))
          return { ok: `${n} 순이익 = 나중 10-K(${last.filed})의 반올림 재게시 값 ${last.val} — 앱은 원 공시 정밀값 ${r.ours}(오너 결정 2026-09-28) · 판본: ${L.map((e) => `${e.filed} ${e.val}`).join(" · ")}` };
        // (다) 지배주주 순이익 − 상환가능 비지배지분 귀속 순이익(같은 10-K) — Yahoo BE 2022 −301,408천 = −301,708 − (−300)(2026-09-30)
        { const Rs = at("NetIncomeLossAttributableToRedeemableNoncontrollingInterest"), R = Rs.find((e) => e.accn === last?.accn) ?? Rs.at(-1);
          if (last && R && R.val !== 0 && (extEq(v, last.val - R.val) || (unit != null && unit !== 1 && extRound(n, v, last.val - R.val, unit))) && extEq(last.val, r.ours))
            return { ok: `${n} 순이익 = SEC NetIncomeLoss ${last.val} − 상환가능 비지배지분 귀속 순이익 ${R.val}(${R.filed} 10-K) — 앱은 지배주주 순이익` }; }
        for (const tag of ["NetIncomeLossAvailableToCommonStockholdersBasic", "NetIncomeLossAvailableToCommonStockholdersDiluted"]) {
          const e = at(tag).at(-1);
          if (e && extEq(v, e.val)) return { ok: `${n} 순이익 = 보통주 귀속 순이익 SEC ${tag} ${e.val}(${e.filed} 10-K) — 앱은 지배주주 순이익(NetIncomeLoss ${r.ours}), 차이는 우선주 배당·참가증권 배분 등` };
        }
      }
      // ⑪ 희석 EPS — 외부가 다른 공시 값을 쓴 경우(2026-09-29): (가) 공시 기본 EPS(VRT 2022 블룸버그 0.20 — 공시 희석 −0.04),
      //    (나) 분할 뒤 10-K 의 반올림 재게시 EPS(NVDA FY2024 Yahoo 1.19 — 앱은 원 공시 ÷ 분할 1.193, 오너 결정 2026-09-28).
      //    SEC 태그 값(분할 보정)과 정확히 같을 때만. 앱 EPS = SEC(A층) 기간만
      if (metric === "희석 EPS" && col !== "LTM" && H[col]?.date && !splitErr
        && (epsExact || checks.some((k) => k.col === col && k.status === PASS && k.name === "EPS 앱 = SEC 공시 EPS(분할 보정)"))) {
        // (라) 외부 = 앱 EPS(원 공시 ÷ 분할)를 외부 값 자신의 소수 자릿수(3자리 이상)로 반올림(Yahoo WMT FY2023 1.423333 = 4.27 ÷ 3)
        { const dec = (String(v).split(".")[1] ?? "").length, u = 10 ** -Math.min(dec, 6);
          if (dec >= 3 && Math.round(roundHalfAway(r.ours, u) / u) === Math.round(v / u)) return { ok: `${n} 희석 EPS = 앱 ${r.ours}(원 공시 ÷ 분할, A층 통과)의 소수 ${Math.min(dec, 6)}자리 반올림` }; }
        // (마)·(바) 실적발표 8-K(항목 2.02, 오너 지시 2026-09-30) — (마) 분할 전 연간 GAAP 희석 EPS ÷ 분할(WMT FY2024 5.74 ÷ 3 = 1.913333 — 그 해
        //    10-K 는 분할 뒤 제출돼 분할 전 값은 8-K 에만 있다), (바) 1~3분기 원 10-Q 희석 EPS + 4분기 실적발표 값(TSLA 2023 0.73 + 0.78 + 0.53 + 2.27
        //    = 4.31 — 연간 공시 4.30). 4분기 값은 연간 − 9개월 누적(둘 다 원 공시)과 0.02 안이어야
        const rel = relEps.get(col);
        if (rel) {
          const dec = (String(v).split(".")[1] ?? "").length, u = 10 ** -Math.min(Math.max(dec, 2), 6), same = (x) => Math.round(roundHalfAway(x, u) / u) === Math.round(v / u);
          const k = splitAdj({ filed: rel.filed, end: H[col].date });
          if (k !== 1) for (const R of rel.vals) if (same(R / k) && !extEq(R / k, r.ours) && Math.abs(R / k - r.ours) < 0.02 * Math.max(1, Math.abs(r.ours)))
            return { ok: `${n} 희석 EPS = 실적발표 8-K(${rel.filed}) GAAP 희석 EPS ${R} ÷ 분할 ${k} = ${R / k} — 분할 전 발표값(그 해 10-K 는 분할 뒤 제출 — 재게시 ${r.ours}) · ${rel.url}` };
          const dOf = (e) => (Date.parse(e.end) - Date.parse(e.start)) / 864e5;
          const fy0 = annualAllAt("EarningsPerShareDiluted", "USD/shares", H[col].date)[0];
          const all = !fy0 ? [] : (G.EarningsPerShareDiluted?.units?.["USD/shares"] ?? []).filter((e) => e.start && Date.parse(e.start) >= Date.parse(fy0.start) - 5 * 864e5 && Date.parse(e.end) < Date.parse(H[col].date) - 20 * 864e5);
          const orig = (l) => l.sort((a, b) => (a.filed ?? "").localeCompare(b.filed ?? ""))[0];
          const q3m = [...new Set(all.filter((e) => dOf(e) >= 80 && dOf(e) <= 100).map((e) => e.end))].sort().map((end) => orig(all.filter((e) => e.end === end && dOf(e) >= 80 && dOf(e) <= 100)));
          const nine = orig(all.filter((e) => dOf(e) >= 250 && dOf(e) <= 290));
          if (fy0 && nine && q3m.length === 3) {
            const qs = q3m.map((e) => e.val / splitAdj(e)), s3 = qs.reduce((t, x) => t + x, 0), q4ref = fy0.val / splitAdj(fy0) - nine.val / splitAdj(nine);
            for (const R of rel.vals) {
              const q4 = R / k;
              // 4분기 값 확인: 연간 − 9개월 EPS 와 0.02 안, 또는 4분기 순이익(연간 − 9개월) ÷ 3분기 희석 가중평균과 5% 안(주식수가 크게 변한 해 — SNDK FY2026
              // 43.97: 연간 − 9개월 EPS 는 44.34)
              const niQ4 = (() => {
                const f = annualAllAt("NetIncomeLoss", "USD", H[col].date)[0];
                const n9 = (G.NetIncomeLoss?.units?.USD ?? []).filter((e) => e.start && dayDiff(e.start, fy0.start) <= 5 && dOf(e) >= 250 && dOf(e) <= 290).sort((a, b) => (a.filed ?? "").localeCompare(b.filed ?? ""))[0];
                const sh = (G.WeightedAverageNumberOfDilutedSharesOutstanding?.units?.shares ?? []).find((e) => e.start && q3m[2] && e.end === q3m[2].end && dOf(e) <= 100);
                return f && n9 && sh ? (f.val - n9.val) / sh.val : null;
              })();
              const q4ok = Math.abs(q4 - q4ref) <= 0.02 + 1e-9 || (niQ4 != null && Math.abs(q4 - niQ4) <= 0.05 * Math.abs(q4));
              if (!q4ok || !same(s3 + q4) || extEq(s3 + q4, r.ours)) continue;
              return { ok: `${n} 희석 EPS = 분기 EPS 합 ${[...qs, q4].map((x) => +x.toFixed(6)).join(" + ")} = ${+(s3 + q4).toFixed(6)} — 1~3분기 원 10-Q 공시(${q3m.map((e) => e.filed).join("·")}) + 4분기 실적발표 8-K(${rel.filed}) ${R}${k !== 1 ? ` ÷ 분할 ${k}` : ""} · 앱은 연간 공시 희석 EPS ${r.ours}(분기 반올림값 합과 다름)` };
            }
          }
        }
        // 기본 EPS 판본: 최신 → 원 공시 순(WDC FY2022 블룸버그 4.81 = 원 10-K 기본 EPS)
        const Bs = annualAllAt("EarningsPerShareBasic", "USD/shares", H[col].date);
        const B = [Bs.at(-1), Bs[0]].find((b) => b && Math.abs(b.val / splitAdj(b) - v) < 1e-9);
        if (B && Math.abs(B.val / splitAdj(B) - r.ours) > 1e-9) return { ok: `${n} 희석 EPS = 공시 기본 EPS ${B.val}(${B.filed} 10-K${splitAdj(B) !== 1 ? ` ÷ 분할 ${splitAdj(B)}` : ""}) — 앱은 공시 희석 EPS ${r.ours}` };
        const D = annualAllAt("EarningsPerShareDiluted", "USD/shares", H[col].date);
        const last = D.at(-1);
        // (다) 최초 공시 희석 EPS ÷ 분할을 외부 값 자신의 소수 자릿수(3자리 이상)로 반올림(Yahoo WMT FY2024 1.913333 = 5.74 ÷ 3 — 앱은 분할 뒤
        //    10-K 의 재게시 1.91). 분할이 있었던 기간만
        const first = D[0], dec = (String(v).split(".")[1] ?? "").length;
        if (first && splitAdj(first) !== 1 && dec >= 3 && Math.abs(v - r.ours) > 1e-9) {
          const u = 10 ** -Math.min(dec, 6);
          if (Math.round(roundHalfAway(first.val / splitAdj(first), u) / u) === Math.round(v / u))
            return { ok: `${n} 희석 EPS = 최초 공시(${first.filed}) ${first.val} ÷ 분할 ${splitAdj(first)} = ${first.val / splitAdj(first)}, 소수 ${Math.min(dec, 6)}자리 반올림 — 앱은 분할 뒤 10-K 재게시 값 ${r.ours} · 판본: ${D.map((e) => `${e.filed} ${e.val}`).join(" · ")}` };
        }
        if (last && D.length > 1 && Math.abs(last.val / splitAdj(last) - v) < 1e-9 && Math.abs(v - r.ours) > 1e-9) return { ok: `${n} 희석 EPS = 나중 10-K(${last.filed})의 재게시 값 ${last.val}${splitAdj(last) !== 1 ? ` ÷ 분할 ${splitAdj(last)}` : ""} — 앱은 원 공시 정밀값 ${r.ours}(분할 소급 반올림 전) · 판본: ${D.map((e) => `${e.filed} ${e.val}`).join(" · ")}` };
      }
      // Yahoo 희석 EPS = 앱(공시 EPS) × 종목 고정 배수(2026-09-30 — DAL 1.000004·MDLZ 1.00004, 4개 연도 모두 소수 6자리까지 정확). 배수 후보는
      //    1 ± d×10^-k(d 1~9, k 3~7) 하나 — 그 종목 Yahoo 희석 EPS 가 있는 연도 전부(2개 이상)에서 round(앱 × 배수, 소수 6자리) = Yahoo 이고,
      //    이 열의 다른 외부 소스(인포맥스 제외)는 앱과 일치해야 한다. 배수의 이유는 공시로 설명되지 않아 외부 단독 이탈로만 분류
      if (metric === "희석 EPS" && n === "Yahoo" && col !== "LTM") {
        const others = Object.entries(r.srcs).filter(([k]) => k !== n && k !== "인포맥스");
        const yrs = [...recon.values()].filter((x) => /^\d{4}Y 희석 EPS$/.test(x.item) && x.srcs.Yahoo && x.ours);
        if (others.length && others.every(([, y]) => extEq(y.v, r.ours)) && yrs.length >= 2) {
          const r6 = (x) => Math.round(x * 1e6);
          for (let k = 3; k <= 7; k++) for (let d = 1; d <= 9; d++) for (const sg of [1, -1]) {
            const c = 1 + sg * d * 10 ** -k;
            if (yrs.every((x) => r6(x.ours * c) === r6(x.srcs.Yahoo.v)))
              return { outlier: `Yahoo 희석 EPS = 앱(공시 EPS) × 고정 배수 ${c} — Yahoo 가 있는 ${yrs.length}개 연도 전부 소수 6자리까지 정확(${yrs.map((x) => `${x.item.split(" ")[0]} ${x.ours}×${c} = ${x.srcs.Yahoo.v}`).join(" · ")}), 이 열 ${others.map(([k]) => k).join("·")} = 앱 · 배수의 근거는 공시에 없음` };
          }
        }
      }
      // ⑨' StockAnalysis·Yahoo 희석 EPS = SEC 순이익(보통주 귀속 또는 지배주주) ÷ SEC 희석 가중평균, 외부 값 자신의 소수 자릿수로 반올림
      //    (2026-09-29 — SA AMD 2023 0.52912·Yahoo PLTR 2023 0.090131 등 공시 EPS(둘째 자리)가 아닌 자체 계산). 외부 값이 소수 셋째 자리
      //    이상일 때만(둘째 자리면 공시 EPS 와 구분 불가). 앱 EPS = SEC 공시 EPS(A층 통과) 기간만. 공통모드 아님 — SEC 원자료로 독립 재현
      if (metric === "희석 EPS" && (n === "StockAnalysis" || n === "Yahoo" || n === "블룸버그") && col !== "LTM" && epsExact && !splitErr
        && checks.some((k) => k.col === col && k.status === PASS && k.name === "EPS 앱 = SEC 공시 EPS(분할 보정)")) {
        const dec = (String(v).split(".")[1] ?? "").length;
        // 분모: 희석 가중평균(없으면·손실이면 기본 — AMD 2023 SA 0.52912 = 순이익 ÷ 기본), 반올림 또는 버림(SA 는 소수 여섯째 자리 버림 —
        // INTC 2024 −4.3822427 → −4.382242). 소수 자릿수 전부 정확히 같아야
        const shs = [["희석 가중평균", annualAllAt("WeightedAverageNumberOfDilutedSharesOutstanding", "shares", H[col].date).at(-1)], ["기본 가중평균", annualAllAt("WeightedAverageNumberOfSharesOutstandingBasic", "shares", H[col].date).at(-1)],
          // 결산일 유통주식수(Yahoo VST 2022~2025 = 순이익 ÷ 결산일 CommonStockSharesOutstanding, CEG 2022 — 2026-09-30 실측)
          ...(() => { const y = secYearEndShares(H[col].date); return y ? [[`결산일 유통주식수 ${y.how}`, { val: y.v, filed: y.filed }]] : []; })()].filter(([, x]) => x?.val);
        if ((dec >= 3 || (n === "블룸버그" && dec === 2)) && shs.length) { // 블룸버그는 둘째 자리 표기 — 공시 EPS 와 다른 값일 때만 여기 온다
          const u = 10 ** -Math.min(dec, 6), ui = Math.round(1 / u);
          for (const [sl, sh] of shs) {
            const k = splitAdj(sh);
            for (const tag of ["NetIncomeLossAvailableToCommonStockholdersDiluted", "NetIncomeLossAvailableToCommonStockholdersBasic", "NetIncomeLoss"]) {
              const nis = annualAllAt(tag, "USD", H[col].date);
              for (const [lab, ni] of [["최신 공시", nis.at(-1)], ["최초 공시", nis[0]]]) {
                if (!ni) continue;
                const q = ni.val / (sh.val * k), vi = Math.round(v * ui);
                const how = Math.round(roundHalfAway(q, u) * ui) === vi ? "반올림" : Math.trunc(q * ui + (q < 0 ? -1e-9 : 1e-9)) === vi ? "버림" : null;
                if (how) return { ok: `${n} 는 순이익 ÷ 주식수로 자체 계산(공시 EPS 아님) — SEC ${tag}(${lab} ${ni.filed}) ${ni.val} ÷ ${sl} ${sh.val}${k !== 1 ? `×분할 ${k}` : ""} = ${q}, 소수 ${Math.min(dec, 6)}자리 ${how} = ${n} ${v}, 앱 EPS = SEC 공시 EPS 정확 일치(A층 통과) · 공통모드 아님(SEC 원자료로 독립 재현)` };
              }
            }
          }
        }
      }
      // ⑩ 인포맥스 결산일 시가총액 ÷ 결산일 실제 종가 = 앱 직전 연도 결산일 주식수(센트 종가 곱이 인포맥스 시총과 센트까지 완전 일치) — 인포맥스가 전년도 주식수를 쓴다
      //    (실측 MCD 2022·2023, MU 2022). 앱 그 해·직전 연도 주식수가 둘 다 A층 SEC 본표 주식수와 일치한 경우만.
      //    그 해 앱 = SEC 본표 = StockAnalysis(SEC 공시 단위 안)인데 인포맥스만 다르면 원인 확인이 아니라 "외부 단독 이탈"(PLTR 2021).
      if (metric === "시가총액(결산일)" && n === "인포맥스" && col !== "LTM" && sharesPassed(col)) {
        const px = actualClose(H[col].date), mine = appShares(col);
        if (px && mine) {
          // 인포맥스 시총 = 주식수 × 센트 단위 종가(MCD 2022: 744,800,000 × 263.53 = 196,277,144,000 정확히 — 2026-09-26 실측 전 종목
          // 주식수가 정수로 떨어짐). Yahoo 종가의 부동소수(263.5299987…)를 센트로 되돌린다. 판정은 허용 오차 없이 센트 단위 완전 일치
          // (주식수 × 센트 종가 = 인포맥스 시총)만
          const pxC = px; // actualClose 가 이미 실제 체결가를 호가 단위(센트)로 정리해 준다
          const imSh = v / pxC;
          const imIs = (shares) => shares != null && Math.round(Math.round(shares) * pxC * 100) === Math.round(v * 100);
          const gap = (p) => (Date.parse(H[col].date) - Date.parse(H[p].date)) / 864e5;
          const prev = Object.keys(H).find((p) => p !== "LTM" && gap(p) >= 330 && gap(p) <= 400);
          // 직전 연도 주식수: 앱 열이 있으면 그 열(A층 통과일 때만), 앱 열이 없으면(첫 열) SEC 본표 전년 결산일 값을 직접
          const secPrev = prev ? null : secYearEndShares(new Date(Date.parse(H[col].date) - 365 * 864e5).toISOString().slice(0, 10), 10);
          const ps = prev ? (sharesPassed(prev) ? appShares(prev) : null) : secPrev?.v ?? null;
          const psLab = prev ? `앱 ${prev} 주식수(= SEC 본표, A층 통과)` : `SEC 본표 전년 결산일 주식수 ${secPrev?.how ?? ""}(앱 열 없음)`;
          if (ps != null && imIs(ps))
            return { common: `인포맥스가 전년도 주식수 사용 — 인포맥스 시총 ÷ 결산일 실제 종가 ${pxC} = ${imSh.toFixed(1)}주 = ${psLab} ${ps.toFixed(0)}주, 앱 ${col} 주식수 = SEC 본표(A층 통과 — 후보 순서 재구현, 공통모드)` };
          const sa = saYearEndShares.get(col), unit = secUnit(Math.round(mine));
          // 인포맥스 = StockAnalysis 인데 앱만 다르면(CAT 2021~2025: 둘 다 535,888,051 = 발행 − 자기주식, 앱 535,900,000 = 본표 유통주식수
          // 10만 주 반올림) 외부 탓이 아니다 — 정의차(앱 = 본표 반올림값, 외부 = 정확 주식수) 또는 앱 결함 후보. 원인(causes)에 넣지 않는다.
          if (sa != null && imIs(sa) && sa !== Math.round(mine))
            return { defdiff: `정의차(앱 결함 후보) — 인포맥스 시총 ÷ 실제 종가 ${pxC} = ${imSh.toFixed(1)}주 = StockAnalysis ${sa}(정확 주식수), 앱 ${mine.toFixed(0)}주 = SEC 본표 반올림값(공시 단위 ${unit})` };
          // 전년도 주식수로도 설명되지 않음이 확인될 때만(전년 값을 모르면 분류하지 않는다 — MCD 2021 처럼 전년도 원인이 가려질 수 있다).
          // 인포맥스가 StockAnalysis 와도 달라야 한다(감사 — 외부 두 곳이 같은 값이면 "외부 단독"이 아니다)
          // 앱 = SEC 본표(공시 단위 반올림값) — round(SA 정확 주식수, SEC 공시 단위) = 앱 이 정확히 성립할 때만
          if (ps != null && sa != null && roundHalfAway(sa, unit) === Math.round(mine) && !imIs(mine) && !imIs(sa))
            return { outlier: `외부 단독 이탈(앱=SEC 본표) — 앱 주식수 ${mine.toFixed(0)} = SEC 본표(A층 통과) = StockAnalysis ${sa}(round(SA, SEC 공시 단위 ${unit}) = 앱), 인포맥스 시총 ÷ 실제 종가 ${pxC} = ${imSh.toFixed(1)}주 ≠ 전년도 ${ps.toFixed(0)}주` };
        }
      }
      // R1 Yahoo 총차입금 = SEC 본표 차입금·리스 줄 합(최신 정기공시 계산 구조). 앱(운용리스 포함) = 본표 줄 합 + 주석 유동 차입금
      //    + 주석 금융리스 + 본표 밖 운용리스 가 SEC 값으로 정확히(1달러) 성립할 때만 — 공통모드(본표 차입금 줄 선택은 앱과 같은 성격의
      //    규칙 재구현). 종목별 식: DAL(Yahoo 가 본표 ShortTermNonBankLoansAndNotesPayable 을 뺌)·SNDK(본표 밖 비유동 운용리스를 넣음).
      if (item0 === "LTM 총차입금(운용리스 포함)" && n === "Yahoo" && debtDec?.appOk) {
        const d = debtDec;
        const variants = [["", d.faceSum]];
        if (sym === "DAL") { const x = d.val0("us-gaap_ShortTermNonBankLoansAndNotesPayable"); if (x != null && d.onFace("us-gaap_ShortTermNonBankLoansAndNotesPayable")) variants.push(["종목별 식(DAL): Yahoo 는 본표 ShortTermNonBankLoansAndNotesPayable 제외", d.faceSum - x]); }
        if (sym === "SNDK") { const x = d.val0("us-gaap_OperatingLeaseLiabilityNoncurrent"); if (x != null && !d.onFace("us-gaap_OperatingLeaseLiabilityNoncurrent")) variants.push(["종목별 식(SNDK): Yahoo 는 본표 밖 비유동 운용리스 포함", d.faceSum + x]); }
        for (const [how, exp] of variants)
          if (eqExp(exp)) return { common: `Yahoo 총차입금 = SEC 본표 차입금·리스 줄 합 ${exp}${rnd(exp)}(${d.fl.form} ${d.fl.date}: ${d.faceVals.map((x) => `${d.nm(x.id)} ${x.v}`).join(" + ")})${how ? ` · ${how}` : ""} — 앱 = 본표 합 + ${d.off.map((x) => `${x.why} ${d.nm(x.id)} ${x.v}`).join(" + ") || "없음"} (SEC 값으로 정확 성립) · 공통모드(본표 줄 선택 규칙 재구현)` };
        // 앱 − 본표 밖 항목 하나(BE: 비유동 금융리스 3,395천 — 본표 "기타 비유동부채" 안, Yahoo 는 유동분만 넣음, 2026-09-30)
        if (d.off?.length > 1) for (const x of d.off) if (x.v && eqExp(r.ours - x.v))
          return { common: `Yahoo 총차입금 = 앱 ${r.ours} − 본표 밖 ${x.why} ${d.nm(x.id)} ${x.v}${rnd(r.ours - x.v)} — Yahoo 는 앱의 본표 밖 항목(${d.off.map((y) => `${y.why} ${d.nm(y.id)} ${y.v}`).join(" + ")}) 중 이것만 뺌 · 앱 = 본표 합 + 본표 밖 항목(SEC 값으로 정확 성립) · 공통모드(본표 줄 선택 규칙 재구현)` };
      }
      // R2·R3 StockAnalysis 총차입금 = 앱 + 금리·통화금리 파생상품 부채(R2) + 본표 밖 회사 고유 금융 의무(R3, AMZN). 앱 차입금이
      //    SEC 본표·주석 값으로 정확히 분해될 때(R1 과 같은 전제)만 원인 확인, 아니면 추정. 파생상품 값이 금리 외 멤버에도 있으면 추정.
      if (item0 === "LTM 총차입금(운용리스 포함)" && n === "StockAnalysis" && (irDeriv || finOblig)) {
        const parts = [irDeriv && irDeriv.add !== 0 && [`금리 파생상품 부채 ${irDeriv.add}(${irDeriv.how}: ${irDeriv.members.join("·")})`, irDeriv.add], finOblig && [`본표 밖 금융 의무 ${finOblig.sum}(${finOblig.ids.join(" + ")})`, finOblig.sum]].filter(Boolean);
        for (let mask = 1; mask < 1 << parts.length; mask++) {
          const use = parts.filter((_, i) => mask & (1 << i)), add = use.reduce((t, x) => t + x[1], 0);
          if (!eqExp(r.ours + add)) continue;
          const txt = `StockAnalysis 총차입금 = 앱 + ${use.map((x) => x[0]).join(" + ")}${rnd(r.ours + add)}`;
          const dup = use.some((x) => x[0].startsWith("금리") && irDeriv.dup);
          return debtDec?.appOk && !dup ? { ok: `${txt} · 앱 = SEC 본표·주석 분해 정확 성립 · 공통모드 아님(파생상품·금융 의무는 SEC 원본값)` }
            : { guess: `${txt}${dup ? " — 같은 값이 금리 외 파생상품 멤버에도 있어 확정 못 함" : " — 앱 차입금 SEC 분해 미확인"}` };
        }
      }
      // R5·R6 연간 매출 차원 분해 — 인포맥스: Revenues − 현금흐름위험회피 AOCI 재분류분(NFLX), 또는 Σ 사업부문 고객계약 매출(GOOG, 잔여
      //    +100 은 성립 안 함 → 미해명). StockAnalysis(호텔 HLT·MAR): Revenues − 비용 환급 매출(ProductOrServiceAxis = …Reimburs…).
      //    전제: 앱 매출 = SEC(A층 정확 일치). 공통모드 아님(10-K 원본 차원값).
      // R6' 외부 = SEC 에 실제로 있는 반올림 재태깅 값(MCD 2022·2023 StockAnalysis 23,183·25,494 — 나중 10-K 가 과거 정밀값
      //    23,182.6·25,493.7 을 백만 단위로 다시 태깅). 앱은 dropRoundedRetags 로 먼저 공시된 정밀값을 쓴다(revenue.md R6).
      //    공통모드 — 재태깅 제외 판정이 앱과 같은 규칙이라 외부가 반올림값인 것만 확인될 뿐 앱 정밀값의 독립 근거가 아니다(2026-09-26 정정)
      // R9 외부 = 그 기간을 담은 최신 10-K 의 본표 매출 하위 줄 합(회사가 줄마다 반올림해 하위 합 ≠ 합계 줄). MCD Yahoo 23,182 =
      //    14,106 + 8,748 + 328(2024 10-K, 합계 줄 23,183), IBM 2021 57,351 = 29,225 + 27,346 + 780(합계 줄 57,350).
      //    둘 다 SEC 사실값으로 외부 값을 정확히(보고 단위 반올림 없이) 재현할 때만. 공통모드 아님(10-K 원본 값).
      if (metric === "매출" && col !== "LTM" && aPassed(col, "매출") && H[col]?.date) {
        const sr = revFace?.annualAt(H[col].date);
        if (sr?.retag && extEq(v, sr.retag.val)) {
          // ② 는 decimals 근거가 있을 때만 — 그 판본 등록의 decimals 판정이 앱 값(정밀값)을 고르고, 외부 값을 그 정밀값의 재게시로 확인
          const id = Number(/\[판본 #(\d+)\]/.exec(sr.how ?? "")?.[1]), r = vintRes.get(id);
          const rep = r?.ok && r.val === sr.v ? r.represented.find((x) => x.val === sr.retag.val) : null;
          return rep
            ? { ok: `${n} 매출 = SEC 정밀도만 낮춘 재게시 값 ${sr.retag.val}(${sr.retag.filed} 공시 decimals ${rep.dec} = round(${rep.of}, 10^${-rep.dec})) — 앱 = 먼저 공시된 정밀값 ${sr.v}(A층 정확 일치, 판본은 decimals 독립 판정: ${r.txt}) · 공통모드 아님(공시 원본 decimals)` }
            : { common: `${n} 매출 = SEC 반올림 재태깅 값 ${sr.retag.val}(${sr.retag.filed} 공시, ${sr.retag.unit} 단위) — 앱 = 먼저 공시된 정밀값 ${sr.v}(반올림 재태깅 제외 = 앱과 같은 규칙, A층 정확 일치 · decimals 근거 ${r?.ok ? "는 재게시를 확인 못함" : `없음(${r?.why ?? "미판정"})`})` };
        }
        const p = [...(revParts ?? new Map())].find(([end]) => dayDiff(end, H[col].date) <= 7)?.[1];
        for (const [how, s] of p?.sums ?? []) if (extEq(v, s))
          return { ok: `${n} 매출 = 본표 매출 하위 줄 합 ${s}(${p.src} ${how}) — 합계 줄 ${p.total} 과 회사 반올림 차 ${s - p.total}, 앱 = SEC 본표 합계(A층 정확 일치) · 공통모드 아님(10-K 원본 값)` };
      }
      if (metric === "매출" && col !== "LTM" && revDims && aPassed(col, "매출") && H[col]?.date) {
        // 기존 규칙(R3·R5·R8 AOCI 축·호텔 환급)은 최근 10-K 3건만(fi ≤ 3) — 옛 10-K 를 섞으면 같은 성분이 다른 멤버명으로 두 번 잡힌다
        const atAll = revDims.filter((x) => dayDiff(x.end, H[col].date) <= 7);
        const at = atAll.filter((x) => x.fi <= 3);
        const tot = at.find((x) => x.id === "Revenues" && !x.dims.length)?.v;
        const one = (pred) => at.filter((x) => x.dims.length >= 1 && pred(x.dims));
        const cands = [];
        // R8 확장 — 인포맥스 매출 = SEC 본표 매출 − 매출 줄에 인식된 파생상품 손익(현금흐름위험회피 재분류 cf · 비지정 파생상품 nd)
        //    − 매출 줄 차감 상각(제품·서비스 차원 …Amortization… 멤버 am). 손익계산서 위치 차원(IncomeStatementLocationAxis)이 매출·판매
        //    멤버인 사실만. 실측: AMAT 2021(cf 4)·PEP 2021(cf −6)·SBUX 2021(cf 1.8)·LRCX 2022(cf 45.057)·CAT 2021(cf −13)·
        //    KO 2021~2023(cf + nd)·XOM 2021~2023(nd)·VST 2021~2023(nd + am). 조합 중 하나가 정확히(인포맥스 보고 단위 반올림 안) 성립할 때만.
        if (n === "인포맥스") {
          const cf = revDerivFamily(atAll, "cf"), nd = revDerivFamily(atAll, "nd");
          // 매출 차감 상각 멤버는 옛 연도의 경우 그 해 10-K 에만 있다(VST 2022 RetailContractAmortizationMember −6) — 그 해 10-K 까지(atAll)
          const amF = atAll.filter((x) => (x.id === "Revenues" || x.id === "RevenueFromContractWithCustomerExcludingAssessedTax") && x.dims.length === 1 && /ProductOrServiceAxis$/.test(x.dims[0][0]) && /Amortization/i.test(x.dims[0][1]) && x.v !== 0);
          // 공시마다 멤버가 다를 수 있어(VST 2024 10-K IntangibleAmortizationAndOtherRevenuesMember −4 vs 2022 10-K RetailContractAmortizationMember −6)
          // 멤버·공시별 값을 각각 선택지로(같은 값은 하나)
          const am = amF.map((x) => ({ id: `${x.id}[${x.dims[0][1]}]`, v: x.v })).filter((o, i, a) => a.findIndex((p) => p.v === o.v) === i);
          // 성분별 선택지(빼지 않음 + 공시별 값) 조합 — 하나 이상 뺀 조합만
          let combos = [[]];
          for (const [lab, opts] of [["매출 위치 현금흐름위험회피 재분류", cf], ["매출 위치 비지정 파생상품 손익", nd], ["매출 차감 상각", am]])
            combos = combos.flatMap((c) => [c, ...opts.map((o) => [...c, [lab, o]])]);
          for (const use of combos.filter((c) => c.length))
            cands.push([`인포맥스 매출 = SEC 본표 매출 ${r.ours} − ${use.map(([lab, f]) => `${lab}(${f.id}) ${f.v}`).join(" − ")}`, r.ours - use.reduce((t, [, f]) => t + f.v, 0)]);
        }
        if (n === "인포맥스" && tot != null) {
          const cf = one((ds) => ds.some((d) => d[0] === "ReclassificationOutOfAccumulatedOtherComprehensiveIncomeAxis") && ds.some((d) => d[1] === "AccumulatedGainLossNetCashFlowHedgeParentMember")).filter((x) => x.id === "Revenues");
          if (cf.length === 1) cands.push([`인포맥스 매출 = Revenues ${tot} − 현금흐름위험회피 AOCI 재분류 ${cf[0].v}`, tot - cf[0].v]);
        }
        if (n === "인포맥스") {
          const seg = one((ds) => ds.length === 1 && ds[0][0] === "StatementBusinessSegmentsAxis").filter((x) => x.id === "RevenueFromContractWithCustomerExcludingAssessedTax");
          if (seg.length >= 2) cands.push([`인포맥스 매출 = Σ 사업부문 고객계약 매출(${seg.length}개 부문)`, seg.reduce((t, x) => t + x.v, 0)]);
        }
        if (n === "StockAnalysis" && tot != null) {
          // 환급 매출은 Revenues(MAR) 또는 고객계약 매출(HLT ReimbursementRevenueMember) 차원 — Revenues 쪽을 우선, 없으면 고객계약 매출
          const reAll = one((ds) => ds.length === 1 && ds[0][0] === "ProductOrServiceAxis" && /Reimburs/i.test(ds[0][1]) && !/Exclud/i.test(ds[0][1]));
          const re = reAll.some((x) => x.id === "Revenues") ? reAll.filter((x) => x.id === "Revenues") : reAll.filter((x) => x.id === "RevenueFromContractWithCustomerExcludingAssessedTax");
          if (re.length) cands.push([`StockAnalysis 매출 = Revenues ${tot} − 비용 환급 매출 ${re.map((x) => x.v).join("+")}`, tot - re.reduce((t, x) => t + x.v, 0)]);
        }
        // StockAnalysis 매출 = SA 영업매출(operatingRevenue, 앱과 정확 일치) + SA 기타매출(otherRevenue). 기타매출이 SEC 본표 "기타수익"
        //    줄(Revenues[OtherRevenueMember|OtherIncomeMember]) − SA 자산처분이익 − SA 환차익과 정확히 같을 때만(XOM 2021: 2,291 − 1,841 − 2
        //    = 448). SA 가 기타수익 중 처분·환 손익을 뺀 나머지를 매출에 넣는 정의. 비영업 분리 회사(앱이 기타수익을 뺀 회사)만.
        if (n === "StockAnalysis" && revFace?.split) {
          const a = saIsAdj.get(col), oth = at.filter((x) => x.id === "Revenues" && x.dims.length === 1 && /ProductOrServiceAxis$/.test(x.dims[0][0]) && /^(OtherRevenueMember|OtherIncomeMember)$/.test(x.dims[0][1]));
          if (a?.opRev === r.ours && a.orv && oth.length === 1 && oth[0].v === a.orv + a.ga + a.cg)
            cands.push([`StockAnalysis 매출 = SA 영업매출 ${a.opRev}(= 앱) + SA 기타매출 ${a.orv}(= SEC 기타수익 줄 ${oth[0].v} − SA 자산처분이익 ${a.ga} − SA 환차익 ${a.cg})`, r.ours + a.orv]);
        }
        for (const [how, exp] of cands) if (eqExp(exp)) return { ok: `${how} = ${exp}${rnd(exp)}, 앱 = SEC 매출(A층 정확 일치) · 공통모드 아님(10-K 원본 차원값)` };
      }
      // R4 Yahoo·인포맥스 LTM 매출 = Σ 분기, 분기마다 그 소스 분기값 = SEC 3개월값(4분기 = 사업연도 − 9개월 누적) 또는 그 10-Q 본표 매출
      //    하위 줄 3개월 합(회사가 줄마다 반올림 — MCD 2025-09-30 7,077 = 2,563 + 4,363 + 151, 합계 줄 7,078). 앱 LTM 은 사업연도 + 당기
      //    누적 − 전년 누적(SEC TTM) — 전제: 앱 LTM 매출 = SEC TTM(같은 태그, 1달러 안). 차이 = 누적값과 분기값 합의 재작성·반올림 차.
      //    합계만 맞추지 않는다 — 분기마다 식이 완전히 성립해야 한다(허용 오차 없음, 2026-09-26: MCD 는 합계 27,703 이 SEC 3개월 합과 같지만
      //    분기 두 곳이 −1·+1 로 상쇄된 것이었다). 공통모드 아님(SEC 분기 공시값으로 외부 값을 독립 재현). 실측 CL·GOOG·NVDA·ORCL·IBM·MCD.
      // StockAnalysis LTM 매출 = 자기 분기 4개 합, 분기마다 SEC "매출 − 비용 환급 매출"(3개월, 4분기 = 연간 − 9개월)과 정확 일치 — 분기별 전부 성립할 때만.
      //    실측 2026-09-28 HLT: 1,283 + 1,280(= 4,954 − 3,674) + 1,182 + 1,359 = 5,104(앱 LTM 12,485 는 환급 포함 총매출)
      if (metric === "매출" && col === "LTM" && n === "StockAnalysis" && saQInc && reimbExQ?.size && L?.date) {
        const qs = saQInc.datekey.map((d, i) => ({ end: d, v: saQInc.revenue?.[i] ?? null })).filter((q) => q.end !== "TTM" && (q.end <= L.date || dayDiff(q.end, L.date) <= 7)).sort((a, b) => a.end.localeCompare(b.end)).slice(-4);
        const u = r.srcs[n]?.unit ?? 1;
        const rows = qs.map((q) => { const e = [...reimbExQ].find(([k]) => dayDiff(k, q.end) <= 7)?.[1]; return { q, e, ok: e != null && q.v != null && (extEq(q.v, e.v) || (u !== 1 && extEq(q.v, roundHalfAway(e.v, u)))) }; });
        if (qs.length === 4 && rows.every((x) => x.ok) && eqExp(qs.reduce((t0, q) => t0 + q.v, 0)))
          return { ok: `StockAnalysis LTM 매출 = 자기 분기 4개 합, 분기마다 SEC "매출 − 비용 환급 매출"과 정확 일치(${rows.map((x) => `${x.q.end} ${x.q.v} = ${x.e.v}(${x.e.how})`).join(" · ")}) — StockAnalysis 는 분기 매출을 환급 제외로, 연간은 총매출로 싣는다 · 앱 = SEC TTM(총매출)` };
      }
      if (metric === "매출" && col === "LTM" && (n === "Yahoo" || n === "인포맥스") && L?.date) {
        const q = r4Quarters(n);
        if (q?.ok) return { ok: `${n} LTM 매출 = Σ 분기 ${q.sum} — ${q.rows.join(" · ")} — 앱 = SEC TTM(${q.t.how}) ${q.t.v}, 차 ${r.ours - q.sum} = 누적과 분기 합의 차 · 공통모드 아님(SEC 원자료로 독립 재현)` };
      }
      // R8 분기 확장 — 인포맥스 LTM 매출 = Σ 분기(SEC 3개월 매출 − 그 분기 매출 위치 파생상품 손익). 4분기 = 연간 − 9개월(매출·파생 모두).
      //    성립하지 않고 한 분기만 어긋나면, 그 분기의 인포맥스 값이 인포맥스 자신의 연간 − 나머지 3분기와 다르고 그 차감값이 SEC 식과
      //    정확히 같을 때 인포맥스 자체 집계 불일치(외부 단독 이탈, 오너 승인 2026-09-25). GOOG: 2025 Q4 인포맥스 113,996 ≠ 인포맥스 연간
      //    402,962 − Q1~Q3 = 113,895 = SEC 113,829 − 파생(−126 − (−60)).
      if (metric === "매출" && col === "LTM" && n === "인포맥스" && revQDeriv && aPassed("LTM", "매출") && L?.date && imAnnual?.quarters) {
        // 비영업 분리 회사(XOM·CVX — revFace.split): 앱 LTM = SEC 본표 매출 − 비영업(분리값)이라 원 태그 TTM(secTtm)과 다르다.
        // 분기 4개도 분리값(revFace.quarterAt — 4분기는 사업연도 − 9개월)으로 구성해 같은 R8 분기 경로를 태운다(감사 2026-09-25)
        let tag = null, qs = null;
        if (revFace?.split) {
          const lt = revFace.ltmAt(L.date);
          const ends = imAnnual.quarters.filter((q) => q.end <= L.date || dayDiff(q.end, L.date) <= 7).slice(-4).map((q) => q.end);
          if (lt && Math.abs(lt.v - r.ours) <= 0.5 && ends.length === 4) {
            const ps = ends.map((E) => { const x = revFace.quarterAt(E, !!revFace.annualAt(E)); return x ? { end: E, v: x.v, how: x.how } : null; });
            if (ps.every(Boolean)) { tag = "본표 매출(비영업 분리)"; qs = { sum: ps.reduce((t, p) => t + p.v, 0), parts: ps }; }
          }
        } else {
          tag = REV_TAGS.find((t) => { const x = secTtm(t); return x && dayDiff(x.end, L.date) <= 7 && Math.abs(x.v - r.ours) <= 0.5; }) ?? null;
          qs = tag ? secQuarterSum(tag, L.date) : null;
        }
        const imQ = qs ? qs.parts.map((p) => imAnnual.quarters.find((q) => dayDiff(q.end, p.end) <= 7) ?? null) : [];
        if (qs && imQ.every((q) => q?.rev != null)) {
          const dur = (x) => (Date.parse(x.end) - Date.parse(x.start)) / 864e5;
          const split = !!revFace?.split;
          const inFy = (a, e) => { const d = (Date.parse(a.end) - Date.parse(e)) / 864e5; return d > -8 && d < 330; };
          const derivIds = Object.values(DERIV_FAM).flatMap((f) => f.ids);
          const hasLoc = (x) => x.dims.some((d) => LOC_AXES.includes(d[0]));
          const nonLoc = (x) => x.dims.filter((d) => !LOC_AXES.includes(d[0])).map((d) => d.join("=")).sort().join("|");
          const sameP = (x, y) => x.start === y.start && x.end === y.end;
          const isRounded = (x) => !!x.dec && x.dec !== "INF" && Number(x.dec) <= -7;
          const factTxt = (x) => `${x.accn ?? `공시${x.fi}`} ${x.id}${x.dims.length ? `[${x.dims.map((d) => d[1]).join(",")}]` : ""} ${x.start}~${x.end} ${x.v}${isRounded(x) ? `(decimals ${x.dec} 반올림 공시)` : ""}`;
          // 비영업 분리 회사만(XOM·CVX) — 매출 줄 파생상품 손익의 위치 판정(버그 수정 2026-09-25: 예전엔 위치 없는 손익을 "다른 공시에서 매출
          // 위치로만 태깅됐다"는 이유로 매출 줄로 추정했다 — XOM 2025 3분기 10-Q 의 위치 없는 −48 은 매출 줄 −31 + 원유 매입 줄 −17 합계였다).
          // ① 매출 개념 + 헤지 지정 축(Revenues[NotDesignated…]) = 매출 줄 파생상품 손익(10-Q 가 매출 줄 금액을 이렇게 따로 태깅)
          // ② 위치 없는 손익(GainLossOnDerivativeInstrumentsNetPretax 등) = 기본은 합계(매출 + 매입 등) — 매출 줄로 쓰지 않는다
          // ③ 단, 같은 공시의 위치 없는 사실 하나가 다른 공시의 같은 기간 매출 줄 값과 정확히 같고 다른 공시의 같은 기간 위치 없는 값(합계)과는
          //    겹치지 않으면(2026 2분기 10-Q 전년 비교 534 = 2025 2분기 10-Q Revenues[NotDesignated] 6개월 534 ≠ 합계 540) 그 공시의 위치 없는
          //    사실(같은 개념·같은 비위치 차원)은 매출 줄로 확인. 증거 없이 위치를 추정하지 않는다
          const revLine = (x) => split && x.id === "Revenues" && x.dims.some((d) => d[0] === HEDGE_DES);
          const revLineVals = split ? revQDeriv.filter((y) => revLine(y) || (derivIds.includes(y.id) && revLoc(y.dims))) : [];
          const confirmed = new Map(); // `${fi}|${id}|${nonLoc}` → 근거
          for (const x of split ? revQDeriv.filter((y) => derivIds.includes(y.id) && !hasLoc(y)) : []) {
            const k = `${x.fi}|${x.id}|${nonLoc(x)}`;
            if (confirmed.has(k)) continue;
            const m = revLineVals.find((y) => y.fi !== x.fi && sameP(x, y) && y.v === x.v && nonLoc(y) === nonLoc(x));
            const ambiguous = revQDeriv.some((z) => z.fi !== x.fi && z.id === x.id && !hasLoc(z) && sameP(x, z) && z.v === x.v);
            if (m && !ambiguous) confirmed.set(k, `위치 확인: ${factTxt(x)} = 매출 줄 ${factTxt(m)}`);
          }
          const accepted = (x) => revLoc(x.dims) || revLine(x) || (split && !hasLoc(x) && confirmed.has(`${x.fi}|${x.id}|${nonLoc(x)}`));
          const one = (kind, pred) => {
            const fs = revQDeriv.filter((x) => (DERIV_FAM[kind].ids.includes(x.id) || (kind === "nd" && revLine(x))) && accepted(x) && DERIV_FAM[kind].pred(x.dims) && pred(x));
            if (!fs.length) return null;
            const fi = Math.min(...fs.map((x) => x.fi));
            const own = fs.filter((x) => x.fi === fi), f0 = own[0];
            const conf = [...new Set(own.map((x) => confirmed.get(`${x.fi}|${x.id}|${nonLoc(x)}`)).filter(Boolean))];
            return { v: aggDeriv(own), start: f0.start, dur: dur(f0), rounded: own.some(isRounded), ev: [...own.map(factTxt), ...conf].join("; ") };
          };
          // 분기 파생상품 손익 — 3개월 사실, 없으면 누적 차(같은 시작일의 누적 − 3개월 짧은 누적: 연간 − 9M, 9M − 6M, 6M − 3M). 근거는 derivEv
          const derivEv = new Map();
          const derivQ = (kind, E) => {
            const key = `${kind}|${E}`;
            const q = one(kind, (x) => dayDiff(x.end, E) <= 7 && dur(x) >= 80 && dur(x) <= 100);
            if (q) { derivEv.set(key, q.ev); return q.v; }
            // 비영업 분리 회사의 4분기: 인포맥스 연간 = SEC 본표 연간이고 (인포맥스 연간 − 자기 분기 4개 합) = 같은 해 1~3분기 매출 줄 조정
            // (9개월 매출 줄 파생상품 손익)이면 인포맥스는 그 해 연간을 조정하지 않았다 → 4분기 조정 0(XOM 2025: 323,905 = SEC,
            // 323,905 − 323,402 = 503 = 2025 9개월 Revenues[NotDesignated] 503). 아니면 같은 기준(둘 다 매출 줄)의 연간 − 9개월
            const secA = split ? revFace.annualAt(E) : null;
            if (secA) {
              const im = imAnnual.find((a) => dayDiff(a.end, E) <= 7);
              const fq = im ? imAnnual.quarters.filter((q0) => inFy(im, q0.end)) : [];
              const nine = one(kind, (x) => dayDiff(x.start, secA.start) <= 5 && dur(x) >= 250 && dur(x) <= 290 && x.end < E);
              if (im?.rev != null && fq.length === 4 && fq.every((q0) => q0.rev != null) && nine) {
                const sq = fq.reduce((t, q0) => t + q0.rev, 0);
                if (imEq(im.rev, secA.v) && extEq(im.rev - sq, nine.v)) {
                  derivEv.set(key, `4분기 조정 0 — 인포맥스 ${E} 연간 ${im.rev} = SEC 본표 연간 ${secA.v}, 인포맥스 연간 − 자기 분기 4개 합 ${sq} = ${im.rev - sq} = 1~3분기 매출 줄 조정(${nine.ev})`);
                  return 0;
                }
              }
            }
            for (const [lo, hi] of [[300, 400], [250, 290], [160, 200]]) {
              const ytd = one(kind, (x) => dayDiff(x.end, E) <= 7 && dur(x) >= lo && dur(x) <= hi);
              if (!ytd) continue;
              // 연간 값이 문장 속 반올림값(decimals ≤ −7)뿐이면 정확한 4분기 값이 아니다 — 미해결(비영업 분리 회사)
              if (split && lo === 300 && ytd.rounded) { derivEv.set(key, `연간 매출 줄 파생상품 손익이 반올림 공시뿐(${ytd.ev}) — 4분기 미해결`); return null; }
              const prev = one(kind, (x) => x.start === ytd.start && x.end < E && ytd.dur - dur(x) >= 80 && ytd.dur - dur(x) <= 100);
              if (prev) derivEv.set(key, `${ytd.ev} − ${prev.ev}`);
              return prev ? ytd.v - prev.v : null;
            }
            return null;
          };
          const fams = ["cf", "nd"].map((k) => [k, qs.parts.map((p) => derivQ(k, p.end))]).filter(([, vs]) => vs.every((x) => x != null) && vs.some((x) => x !== 0));
          // Yahoo 분기 매출 = SEC 본표(분리값) 여부 — 비영업 분리 회사 ② 메모(인포맥스와 독립인 소스가 SEC 와 같다는 확인)
          const yNote = () => {
            const ys = qs.parts.map((p) => yq.find((r) => dayDiff(iso(r.date), p.end) <= 7)?.totalRevenue ?? null);
            return ys.every((y, i) => y != null && extEq(y, qs.parts[i].v)) ? " · Yahoo 분기 4개 = SEC 본표(분리값) = 앱 정확 일치" : ` · Yahoo 분기 ${ys.join("/")}(SEC 와 일부 불일치 또는 없음)`;
          };
          for (let mask = 1; mask < 1 << fams.length; mask++) {
            const use = fams.filter((_, i) => mask & (1 << i));
            const exp = qs.parts.map((p, i) => p.v - use.reduce((t, [, vs]) => t + vs[i], 0));
            const txt = qs.parts.map((p, i) => `${p.end} ${p.v}${use.map(([k, vs]) => ` − ${k} ${vs[i]}`).join("")}`).join(" + ");
            const s = exp.reduce((t, x) => t + x, 0);
            // 분기마다 식 완전 성립(인포맥스 표기 단위 반올림 식 포함) — 합계만 맞추지 않는다(허용 오차 없음, 2026-09-26)
            if (exp.every((x, i) => imEq(imQ[i].rev, x))) {
              if (!split) return { ok: `인포맥스 LTM 매출 = Σ 분기(SEC ${tag} 3개월 − 매출 위치 파생상품 손익) ${s}(${txt}) — 앱 = SEC TTM(A층 정확 일치) · 공통모드 아님(10-Q·10-K 원본 차원값)` };
              const ev = qs.parts.map((p, i) => `${p.end}: 인포맥스 − SEC = ${imQ[i].rev - p.v}, 조정(매출 줄 파생) ${use.reduce((t, [, vs]) => t + vs[i], 0)}, 잔차 ${imQ[i].rev - exp[i]} [${use.map(([k]) => `${k}: ${derivEv.get(`${k}|${p.end}`) ?? ""}`).join(" / ")}]`).join(" · ");
              return { ok: `인포맥스 LTM 매출 = Σ(SEC 본표 3개월 매출 − 그 분기 매출 줄 파생상품 손익), 인포맥스 연간 = SEC 본표인 해의 Q4 는 조정 0 — ${s}(${txt}) · 분기별 ${ev} — 앱 = SEC 본표 매출(비영업 분리, A층 정확 일치)${yNote()} · 공통모드 아님(10-Q·10-K 원본 차원값)` };
            }
            const bad = exp.map((x, i) => i).filter((i) => !imEq(imQ[i].rev, exp[i]));
            if (bad.length !== 1) continue;
            const k = bad[0], qe = imQ[k].end;
            const ann = imAnnual.find((a) => (Date.parse(a.end) - Date.parse(qe)) / 864e5 > -8 && (Date.parse(a.end) - Date.parse(qe)) / 864e5 < 330);
            const fyQ = ann ? imAnnual.quarters.filter((q) => (Date.parse(ann.end) - Date.parse(q.end)) / 864e5 > -8 && (Date.parse(ann.end) - Date.parse(q.end)) / 864e5 < 330) : [];
            if (ann?.rev == null || fyQ.length !== 4 || fyQ.some((q) => q.rev == null)) continue;
            const derived = ann.rev - fyQ.filter((q) => q.end !== qe).reduce((t, q) => t + q.rev, 0);
            if (imEq(derived, exp[k]))
              return { outlier: `외부 단독 이탈(인포맥스 자체 집계 불일치) — 인포맥스 ${qe} 분기 ${imQ[k].rev} ≠ 인포맥스 연간 ${ann.rev} − 나머지 3분기 = ${derived} = SEC 식(${txt.split(" + ")[k]}) ${exp[k]}, 나머지 3분기는 SEC 식과 정확 일치 · 앱 = SEC TTM(A층 정확 일치)` };
          }
          // 정확히 닫히지 않음(비영업 분리 회사) — ③ 유지(반올림 허용 없음, 오너 결정). 잔차 금액·분기·근거를 결과에 남긴다(감사 분해 재현).
          // 분기마다: 인포맥스 = SEC 분리값이면 "조정 없음", 아니면 SEC 분리값 − 매출 줄 파생상품 손익(가족 합)과 비교해 분기 잔차.
          // 다른 회사는 종전 "정의 미분해" 표기 유지
          if (split) {
            const adj = qs.parts.map((p) => ["cf", "nd"].map((k) => derivQ(k, p.end)).filter((x) => x != null));
            const rows = qs.parts.map((p, i) => {
              const d = imQ[i].rev - p.v;
              // 차이 0 이어도 파생상품 조정은 계산한다 — 조정이 있는데 차이가 0 이면 그 분기 잔차는 a(재감사 2026-09-25)
              const a = adj[i].reduce((t, x) => t + x, 0);
              const why = ["cf", "nd"].map((k) => derivEv.get(`${k}|${p.end}`)).filter(Boolean).join(" / ");
              const head = d === 0 ? `${p.end} 인포맥스 = SEC ${p.v}` : `${p.end} 인포맥스 ${imQ[i].rev} − SEC ${p.v} = ${d}`;
              return { end: p.end, resid: d + a, txt: `${head}, 파생 ${adj[i].length ? a : "없음"}${why ? ` [${why}]` : ""} → 잔차 ${d + a}` };
            });
            const resid = rows.reduce((t, x) => t + x.resid, 0);
            // 인포맥스 연간 ≠ 자기 분기 4개 합(분기 값에만 조정이 들어간 경우) — 메모
            const selfGap = imAnnual.filter((a) => a.rev != null && qs.parts.some((p) => inFy(a, p.end))).map((a) => {
              const fq = imAnnual.quarters.filter((q) => inFy(a, q.end));
              if (fq.length !== 4 || fq.some((q) => q.rev == null)) return null;
              const sq = fq.reduce((t, q) => t + q.rev, 0);
              return sq === a.rev ? null : `인포맥스 ${a.end} 연간 ${a.rev} ≠ 자기 분기 4개 합 ${sq}(차 ${a.rev - sq})`;
            }).filter(Boolean);
            if (resid !== 0)
              return { appsec: `앱 = SEC 본표 매출(비영업 분리, A층 정확 일치) — 인포맥스 LTM 미분해 잔차 ${resid}(${rows.filter((x) => x.resid).map((x) => `${x.end} ${x.resid}`).join(", ") || "없음"}) · 분기별: ${rows.map((x) => x.txt).join(" · ")}${selfGap.length ? ` · ${selfGap.join(" · ")}` : ""}` };
          }
        }
      }
      // 인포맥스 연간 매출 ≠ 인포맥스 자신의 분기 4개 합, 그리고 그 분기 합 = 앱 = SEC 본표(A층 정확 일치) — 인포맥스 집계 자체의
      //    불일치라 정의 차이(②)가 아니라 외부 단독 이탈로 둔다(HLT 2025: 연간 11,982 vs 분기 합 12,039 = SEC).
      if (metric === "매출" && col !== "LTM" && n === "인포맥스" && aPassed(col, "매출") && H[col]?.date && imAnnual?.quarters) {
        const E = H[col].date;
        const qs = imAnnual.quarters.filter((q) => (Date.parse(E) - Date.parse(q.end)) / 864e5 > -8 && (Date.parse(E) - Date.parse(q.end)) / 864e5 < 330);
        const s = qs.length === 4 && qs.every((q) => q.rev != null) ? qs.reduce((t, q) => t + q.rev, 0) : null;
        if (s != null && extEq(s, r.ours) && !extEq(v, s))
          return { outlier: `외부 단독 이탈(인포맥스 자체 집계 불일치) — 인포맥스 연간 ${v} ≠ 인포맥스 분기 4개 합 ${s}(${qs.map((q) => `${q.end} ${q.rev}`).join(" + ")}) = 앱 = SEC 본표(A층 정확 일치)` };
      }
      // R7 합성 영업이익 회사(소계 없는 손익계산서 — XOM)의 StockAnalysis 영업이익 = 앱 − (SA 자산손상 + 합병·구조조정 + 기타 비경상)
      //    + SA 기타수익. SA 자체 분류(SEC 태그값과 다름) — SA 가 이 항목들을 영업 밖으로 옮긴다. 전제: 앱 세전이익 = SEC(A층 정확
      //    일치). 식 완전 일치만. IBM 은 퇴직 관련 손익 등 다른 항목이 필요해 미적용.
      if (metric === "영업이익" && n === "StockAnalysis" && opRowName && opRowName !== "영업이익"
        && checks.some((k) => k.col === col && k.status === PASS && k.name === "세전이익 앱 = SEC 세전이익")) {
        const a = saIsAdj.get(col);
        if (a) {
          const exp = r.ours - (a.aw + a.mr + a.ou) + a.orv;
          const nz = [a.aw, a.mr, a.ou, a.orv].filter((x) => x).length;
          // 식 완전 일치만(예전엔 SA 보고 단위 × (항목 수 + 1) / 2 허용 — 오너 지시 2026-09-26 허용 오차 금지)
          if (nz && extEq(v, exp))
            return { ok: `SA 자체 분류(SEC 태그값과 다름) — SA 영업이익 = 앱 합성 영업이익 − (자산손상 ${a.aw} + 합병·구조조정 ${a.mr} + 기타 비경상 ${a.ou}) + 기타수익 ${a.orv} = ${exp}, 앱 세전이익 = SEC(A층 통과)` };
        }
      }
      // ③ 앱 = SEC 원자료(A층 정확 일치)인데 외부 값의 정의를 숫자로 분해하지 못한 경우 — 원인 확인이 아니다(오너 결정 2026-09-25,
      //    "원인 확인은 숫자로 성립할 때만"). 별도 분류(appEqualsSec)로 남기고 explained 에 넣지 않는다 — 미해명 건수에 포함된다.
      // 매출원가·매출총이익(--metric=cogs) — 분해식은 기간마다 달러 단위 정확 성립만(허용치 없음). 전제: 앱 = SEC 본표(A층 정확 일치)
      if (COGS_MODE && metric === "매출원가" && aPassed(col, "매출원가")) {
        if (n === "Yahoo") { const fp = yahooFpAll(); if (fp) return { ok: `Yahoo 매출원가 = 본표 원가 + 본표 ${fp.label} — 대조한 모든 기간 정확 성립(${fp.ev.join(" · ")}) · 앱 = SEC 본표 매출원가(A층 정확 일치) · 공통모드 아님(공시 원본 값)` }; }
        // 전 열 규칙(2026-09-27) — 소스가 대조된 모든 매출원가 열에서 같은 식이 정확 성립할 때만
        const tail = "앱 = SEC 본표 매출원가(A층 정확 일치) · 공통모드 아님(공시 원본 값)";
        if (col === "LTM") {
          const qs = cogsQuarterSum(n);
          if (qs?.outlier) return { outlier: qs.outlier };
          if (qs) return { ok: `${n} LTM 매출원가 = 자기 분기 4개 합, 분기마다 SEC 본표 분기값과 정확 일치(${qs.rows.join(" · ")}) — SEC 분기 합 ${qs.sec} ≠ 앱 LTM ${r.ours}(앱이 분기 4개를 못 채워 종전 식 — 사업연도 + 당기 누적 − 전년 동기 — 을 쓴 열: 회사가 분기·누적을 따로 반올림) · ${tail}` };
        }
        if (n === "StockAnalysis") {
          const si = saCogsInst();
          if (si && !si.cols.has(col)) return { appsec: `앱 = SEC 공시 매출원가(A층 정확 일치) — StockAnalysis 식(${si.keep ? "" : "앱 − "}${si.label})이 다른 열에서 정확 성립하나 이 열은 계산 불가(${si.skipped.find(([c]) => c === col)?.[1] ?? "구성 공시 판독 없음"})` };
          if (si) return { ok: `StockAnalysis 매출원가 = ${si.keep ? "" : "앱 − "}${si.label} — 식을 계산할 수 있는 모든 열 정확 성립(${si.ev.join(" · ")}) · ${tail}` };
          const ts = termSubsetAll(n);
          if (ts && ts.cols.has(col)) return { ok: `StockAnalysis 매출원가 = 구성 규칙 줄 중 ${ts.use.join("·")}만(${ts.drop.join("·")} 제외) — 대조한 모든 열 정확 성립(${ts.ev.join(" · ")}) · ${tail}` };
          for (const use of spSubsets) {
            const h = cogsAllCols(n, `sp-${use.map(([k]) => k).join("+")}`, (c2, x) => { const t = spTerm(use, c2); return t.skip ? t : { exp: x.ours + t.s, tol: t.tol, ev: `앱 ${x.ours} + ${t.ev}` }; });
            if (h && h.cols.has(col)) return { ok: `${spLabel(use, "매출원가")} — 대조한 모든 열 정확 성립(${h.ev.join(" · ")}) · ${tail}` };
          }
        }
        {
          // 외부 = 반올림 재게시 판본 값 — 나중 공시가 과거 연도 원가 줄을 정수 백만으로 다시 실었고(MCD 2025 10-K: 2023 식자재 3,039 등) 외부는
          // 그 값을, 앱은 먼저 공시된 정밀값(반올림 재태깅 제외 규칙)을 쓴다. 전 열 성립(재게시 없는 열은 식 = 앱)
          const lt = cogsAllCols(n, "latest", (c, x, e) => (e.cogsLatest == null ? null : { exp: e.cogsLatest, ev: e.latestEv?.length ? `최신 공시 판본 줄 값 합(${e.latestEv.join(", ")})` : "재게시 없음(= 앱)" }));
          if (lt && lt.cols.has(col)) return { ok: `${n} 매출원가 = 나중 공시의 반올림 재게시 값 합(앱은 먼저 공시된 정밀값) — 식을 계산할 수 있는 모든 열 정확 성립(${lt.ev.join(" · ")}) · ${tail}` };
        }
        // 외부 = 최초 공시 판본 원가(2026-09-30 블룸버그 MAR — 2023·2024 을 나중 10-K 가 일반관리비 144·129 를 원가로 옮겨 재작성, 블룸버그는 원 10-K 값).
        //    연간 = 그 사업연도를 처음 실은 공시의 원가, LTM(사업연도 도중) = 사업연도 원공시 + 당기 누적 원공시 − 전년 동기 원공시. 전 열 성립일 때만
        if (cogsFace?.origAt) {
          const oh = cogsAllCols(n, "orig-first", (c2, x, e) => {
            if (!e.start || !e.end) return null;
            const L0 = H.LTM?.date;
            if (c2 === "LTM" && L0 && !Object.keys(H).some((k) => k !== "LTM" && H[k]?.date && dayDiff(H[k].date, L0) <= 7)) {
              const fyc = Object.keys(H).filter((k) => k !== "LTM" && H[k]?.date && H[k].date < L0).sort((p1, p2) => H[p2].date.localeCompare(H[p1].date))[0];
              const fe = fyc ? cogsExp.get(fyc) : null;
              if (!fe?.start || !fe?.end) return null;
              const all = cogsFace.periodsAll(), s0 = new Date(Date.parse(fe.end) + 864e5).toISOString().slice(0, 10), yb = (d0) => new Date(Date.parse(d0) - 365 * 864e5).toISOString().slice(0, 10);
              const cur = all.find(([a1, b1]) => dayDiff(a1, s0) <= 5 && dayDiff(b1, L0) <= 7), pri = cur && all.find(([a1, b1]) => dayDiff(a1, yb(cur[0])) <= 7 && dayDiff(b1, yb(cur[1])) <= 7);
              const f0 = cogsFace.origAt(fe.start, fe.end), c0 = cur && cogsFace.origAt(cur[0], cur[1]), p0 = pri && cogsFace.origAt(pri[0], pri[1]);
              if (!f0 || !c0 || !p0) return { skip: "LTM 구성 원공시 없음" };
              return { exp: f0.cogs + c0.cogs - p0.cogs, ev: `사업연도 원공시 ${f0.cogs}(${f0.filed}) + 당기 누적 원공시 ${c0.cogs}(${c0.filed}) − 전년 동기 원공시 ${p0.cogs}(${p0.filed})` };
            }
            const o = cogsFace.origAt(e.start, e.end);
            return o ? { exp: o.cogs, ev: `원공시 ${o.form} ${o.filed} ${o.cogs}` } : { skip: "원공시 원가 없음" };
          });
          if (oh && oh.cols.has(col)) return { ok: `${n} 매출원가 = 최초 공시 판본(외부는 재작성 전 값, 앱은 최신 판본) — 대조한 모든 열 정확 성립(${oh.ev.join(" · ")}) · ${tail}` };
        }
        if (n === "블룸버그") {
          // 블룸버그(오너 결정 2026-09-28) — D형 원가를 자기 템플릿으로 다시 구성한다. 앱 규칙은 Yahoo·StockAnalysis 와 같은 쪽 유지.
          // ① 구성 규칙 줄 일부만(MCD: 기타 매장비용 제외 · CEG: 운영·유지 제외 — 연료·구매전력만)
          const ts = termSubsetAll(n);
          if (ts && ts.cols.has(col)) return { ok: `블룸버그 매출원가 = 구성 규칙 줄 중 ${ts.use.join("·")}만(${ts.drop.join("·")} 제외) — 대조한 모든 열 정확 성립(${ts.ev.join(" · ")}) · ${tail}` };
          // ③ 앱 + 금융 부문 이자비용(없는 해 0 — 전 열 성립)
          if (finIntFacts.size) {
            const fh = cogsAllCols(n, "fin-int", (c2, x) => c2 === "LTM" && !finIntFacts.has("LTM") ? { skip: "LTM — 10-Q 차원 사실 없음" } : ({ exp: x.ours + (finIntFacts.get(c2) ?? 0), ev: `앱 ${x.ours} + 금융상품 이자비용 ${finIntFacts.get(c2) ?? 0}` }));
            if (fh && fh.cols.has(col)) return { ok: `블룸버그 매출원가 = 앱 + 금융 부문 이자비용(FinancingInterestExpense[금융상품]) — 대조한 모든 열 정확 성립(${fh.ev.join(" · ")}) · ${tail}` };
          }
          // ② 구성 규칙 원가 + 본표 감가상각 줄 + 소득세 외 세금(XOM: 원가 + 기타 세금 25,167 + 감가상각 25,993 = 277,832, 2025)
          // 사업연도 10-K 연간 값(filed 순) — first: 원 공시(정밀값), 아니면 최신
          const fyVal = (concept, date, first = false) => { const es = (G[concept]?.units?.USD ?? []).filter((y) => y.start && /^10-K/.test(y.form ?? "") && date && dayDiff(y.end, date) <= 7 && (Date.parse(y.end) - Date.parse(y.start)) / 864e5 > 300).sort((a, b) => (a.filed ?? "").localeCompare(b.filed ?? "")); return es.length ? (first ? es[0] : es.at(-1)).val : null; };
          const taxAt = (col) => { if (col !== "LTM") return fyVal("TaxesOther", H[col]?.date); const t = secTtm("TaxesOther"); return t && H.LTM?.date && dayDiff(t.end, H.LTM.date) <= 7 ? t.v : null; }; // LTM = SEC TTM(분기 합)
          // ①-b 구성 규칙 줄 하나를 원 공시 정밀값으로 뺀다(MCD 기타 매장비용 2022 244.8·2023 232.5 — 나중 10-K 는 245·232 로 반올림 재게시)
          for (const ln of COGS_RULES[sym]?.lines ?? []) {
            const cs = [ln.concept].flat().filter((c) => /^us-gaap_/.test(c)).map((c) => c.slice(8));
            if (!cs.length) continue;
            const hit = cogsAllCols(n, `drop-${cs[0]}`, (c2, x) => {
              const v0 = cs.map((c) => fyVal(c, H[c2]?.date, true)).find((v) => v != null);
              return v0 == null ? { skip: `${cs[0]} 연간 값 없음` } : { exp: x.ours - v0, ev: `앱 ${x.ours} − ${ln.label ?? cs[0]}(원 공시) ${v0}` };
            });
            if (hit && hit.cols.has(col)) return { ok: `블룸버그 매출원가 = 앱 − 구성 규칙 줄 ${ln.label ?? cs[0]}(원 공시 정밀값) — 대조한 모든 열 정확 성립(${hit.ev.join(" · ")}) · ${tail}` };
          }
          const e0 = [...cogsExp.values()].find((e) => /D/.test(e?.type ?? "") && e.da?.length);
          if (e0) {
            const hit = cogsAllCols(n, "da+taxes", (c2, x, e) => {
              if (!/D/.test(e.type ?? "")) return null;
              const tx = taxAt(c2);
              if (tx == null || e.da?.some((t) => t.v == null)) return { skip: "기타 세금·본표 감가상각 값 없음" };
              const d = (e.da ?? []).reduce((t, y) => t + y.v, 0);
              return { exp: x.ours + tx + d, ev: `앱 ${x.ours} + 기타 세금(TaxesOther) ${tx} + 본표 감가상각 ${d}` };
            });
            if (hit && hit.cols.has(col)) return { ok: `블룸버그 매출원가 = 구성 규칙 원가 + 소득세 외 세금 + 본표 감가상각 — 대조한 모든 열 정확 성립(${hit.ev.join(" · ")}) · ${tail}` };
          }
        }
        if (n === "Yahoo" || n === "인포맥스" || n === "블룸버그") {
          const da = daAddAll(n);
          if (da && da.cols.has(col)) return { ok: `${n} 매출원가 = 구성 규칙 원가 + 본표 감가상각·상각 줄 — 대조한 모든 열 정확 성립(${da.ev.join(" · ")}) · ${tail}` };
        }
        const hedge = n === "인포맥스" && col !== "LTM" && cogsDims && H[col]?.date ? cogsHedgeAt(cogsDims, H[col].date) : null;
        const hit = exactCause(v, cogsCauseCands(n, r.ours, cogsExp.get(col), hedge), parts ? 1 : unit); // 파생 외부 값(성분별 반올림)은 식 전체 반올림을 쓰지 않는다
        if (hit) return { ok: `${hit[0]} = ${hit[1]} — 앱 = SEC 본표 매출원가(A층 정확 일치) · 공통모드 아님(공시 원본 값)` };
        if (n === "인포맥스" && col !== "LTM" && H[col]?.date) { const g = imSelfGap(imAnnual, H[col].date, v, r.ours, (q) => (q.rev != null && q.gp != null ? q.rev - q.gp : null)); if (g) return g; }
      }
      if (COGS_MODE && metric === "매출총이익" && aPassed(col, "매출총이익")) {
        const it = (m) => recon.get(`${col} ${m}`);
        const okOf = (m) => { const x = it(m), s0 = x?.srcs[n]; return !!s0 && (extEq(x.ours, s0.v) || !!done.get(`${x.item}|${n}`)?.ok); };
        const c = gpCause(n, v, {
          ours: r.ours, rev: H[col]?.rev ?? null, cogs: IS[col]?.cogs ?? null, revPassed: aPassed(col, "매출"), cogsPassed: aPassed(col, "매출원가"),
          srcRev: it("매출")?.srcs[n]?.v ?? null, srcCogs: it("매출원가")?.srcs[n]?.v ?? null, srcRevOk: okOf("매출"), srcCogsOk: okOf("매출원가"),
        });
        if (c) return c;
        // 구성요소 중 외부 단독 이탈이 섞인 경우(2026-09-27) — 외부 매출총이익 = 그 소스 매출 − 매출원가가 정확 성립하고 두 성분이 모두 ①·② 또는
        // 외부 단독 이탈(§0: 앱 = SEC 본표 + 다른 외부 2곳 이상 앱과 일치, 또는 원인 규칙의 이탈 판정)이면 매출총이익도 외부 단독 이탈(② 아님)
        const outOf = (m) => {
          const x = it(m), s0 = x?.srcs[n];
          if (!s0 || !aPassed(col, m)) return false;
          if (done.get(`${x.item}|${n}`)?.outlier) return true;
          const others = Object.keys(x.srcs).filter((k) => k !== n && extEq(x.ours, x.srcs[k].v));
          return others.length >= 2 && !extEq(x.ours, s0.v);
        };
        const sR = it("매출")?.srcs[n]?.v ?? null, sC = it("매출원가")?.srcs[n]?.v ?? null;
        const okR = okOf("매출"), okC = okOf("매출원가"), oR = !okR && outOf("매출"), oC = !okC && outOf("매출원가");
        if (sR != null && sC != null && (okR || oR) && (okC || oC) && (oR || oC) && aPassed(col, "매출총이익") && extEq(v, sR - sC))
          return { outlier: `외부 단독 이탈(구성요소) — ${n} 매출총이익 = ${n} 매출 ${sR} − ${n} 매출원가 ${sC}, 이탈 성분: ${[oR && "매출", oC && "매출원가"].filter(Boolean).join("·")}(나머지 성분 ①·②)` };
        if (n === "인포맥스" && col !== "LTM" && H[col]?.date) { const g = imSelfGap(imAnnual, H[col].date, v, r.ours, (q) => q.gp); if (g) return g; }
      }
      if (unitNa && aPassed(col, metric)) return { na: unitNa };
      if (aPassed(col, metric)) return { appsec: `앱 = SEC 공시 ${metric}(A층 정확 일치) — ${n} 정의 미분해` };
      // ⑥ 감가상각비·EBITDA: 차이 = SEC 운용리스 사용권자산 상각 — 외부는 운용리스 상각을 감가상각에 넣고 앱은 뺀다
      //    (CLAUDE.md: 운용리스 비용은 임차료 성격이라 EBITDA 에 이미 반영, PEP 2025 Yahoo 4,178 = 3,451 + 727)
      //    감사: 앱이 운용리스 상각을 한 번 더 뺀 오류도 이 식이 성립한다 → 앱 감가상각비가 SEC 현금흐름표 본표 줄 합과
      //    정확히 일치(A층 통과)한 기간에만 인정. EBITDA 는 영업이익도 확인(A층 정확 일치 또는 같은 소스와 일치)돼야 한다.
      //    독립 대조가 없는 기간(LTM·옛 연도·계산 구조 없음)은 적용하지 않는다(미해명).
      //    공통모드(2026-09-26) — 전제인 A층 감가상각비 대조가 앱과 같은 줄 선택 규칙이라 ② 가 아니라 공통모드
      const daVerified = checks.some((k) => k.col === col && k.status === PASS && k.name === "감가상각비 앱 = SEC 현금흐름표 감가상각·상각 줄 합");
      const opVerified = metric !== "EBITDA" || aPassed(col, "영업이익") || (() => { const x = recon.get(`${col} 영업이익`)?.srcs[n]; return !!x && extEq(IS[col]?.op, x.v); })();
      if (/^(감가상각비|EBITDA)$/.test(metric) && daVerified && opVerified) {
        const ol = col === "LTM" ? secTtm("OperatingLeaseRightOfUseAssetAmortizationExpense")?.v : atEnd(ann("OperatingLeaseRightOfUseAssetAmortizationExpense"), H[col]?.date ?? "")?.val;
        if (ol && eqExp(r.ours + ol)) return { common: `운용리스 사용권자산 상각(${ol}) 포함 여부${rnd(r.ours + ol)} — 앱은 제외(임차료 성격), 앱 감가상각비 = SEC 현금흐름표 본표 줄 합 확인(공통모드 A층 기준)` };
      }
      // ④ EBITDA: 같은 소스의 영업이익 차 + 감가상각비 차로 분해되고, **두 구성요소 모두 원인 확인**일 때만 확인.
      //    분해식 자체는 항상 성립하므로(앱 EBITDA = 영업이익 + 감가상각비, 인포맥스 감가상각비 = EBITDA − 영업이익)
      //    구성요소 판정 없이 확인으로 치면 틀린 EBITDA 가 지나간다(재감사 HIGH)
      if (metric === "EBITDA" && done) {
        const part = (m) => {
          const x = recon.get(`${col} ${m}`);
          if (!x?.srcs[n]) return null;
          return { d: x.srcs[n].v - x.ours, ok: extEq(x.ours, x.srcs[n].v) || !!done.get(`${col} ${m}|${n}`)?.ok };
        };
        const o = part("영업이익"), d = part("감가상각비");
        if (o && d && extEq(v - o.d - d.d, r.ours) && o.ok && d.ok) return { ok: `구성요소 모두 원인 확인 — 영업이익 차 ${o.d}, 감가상각비 차 ${d.d}` };
      }
      // ⑧ 감가상각비: 외부 = SEC 현금흐름표 줄 전액(손상·중단사업 감가상각 포함) — 앱은 A층에서 그 금액을 뺀 값과 정확히
      //    일치(daVerified)했고, 차이가 바로 그 조정액일 때만(TSLA·XOM 손상, WDC 중단사업)
      //    감사: 손상·중단사업 조정 판정이 앱과 같은 규칙(공통모드)이라 A층 통과만으로는 독립 근거가 아니다 → 제3 소스(n 이 아닌
      //    외부 소스)가 앱과 보고 단위 안에서 일치할 때만 원인 확인.
      if (metric === "감가상각비" && daVerified && cfDa && H[col]?.date) {
        const e = [...cfDa.lineByEnd].find(([end]) => dayDiff(end, H[col].date) <= 7);
        const adj = e ? cfDa.notes.get(e[0]) : null;
        const third = Object.keys(r.srcs).filter((m) => m !== n && extEq(r.ours, r.srcs[m].v));
        if (adj && eqExp(e[1]) && third.length) return { ok: `${n} 는 현금흐름표 줄 전액(${e[1]}) — 앱은 ${adj} · 제3 소스 ${third.join("·")} = 앱` };
      }
      // ⑦ 감가상각비: StockAnalysis 는 현금흐름표 "기타 상각"(otherAmortization, 별도 줄)을 EBITDA 용 감가상각에서 뺀다 —
      //    앱 = depAmorEbitda + otherAmortization 이 정확히 성립할 때만(실측 35건: DAL·DELL·IBM·MU·NFLX·ORCL·META·MAR·PEP).
      //    앱 감가상각비가 SEC 현금흐름표 줄 대조(A층)를 통과한 기간에만 인정한다(⑥과 같은 전제 — 앱 오류가 이 식으로 가려지지 않게)
      if (metric === "감가상각비" && n === "StockAnalysis" && daVerified) {
        const oa = saOtherAmort.get(col);
        if (oa && extEq(v + oa, r.ours)) return { ok: `StockAnalysis 는 기타상각(현금흐름표 별도 줄 ${oa})을 EBITDA 감가상각에서 제외 — 앱 = depAmorEbitda + otherAmortization, 앱 감가상각비 = SEC 현금흐름표 줄 대조 통과` };
      }
      if (unitNa) return { na: unitNa };
      // 외화 공시 — 인포맥스는 자체(미공개) 환율로 USD 환산한다. 공시 원천 환율로 정확 분해할 방법이 없어 원인 확인(②)이 아니다 — ③ 미해명으로
      // 남기되 사유를 적는다(오너 결정 2026-09-27, 앱 = 원통화 공시 × 연준 H.10)
      if (foreign && n === "인포맥스") return { guess: `환율 출처 정의 차이 추정 — 인포맥스(FactSet) 환산 환율 미공개라 정확 분해 불가(차 ${v - r.ours}, 앱 = 원통화 공시 × 연준 H.10)` };
      // ⑤ 감가상각비: 다른 외부 소스가 앱과 정확히 같다 — 앱이 맞다는 증거는 아니어서(SEC 독립 대조 없음) 추정만
      if (metric === "감가상각비") {
        const same = Object.keys(r.srcs).filter((m) => m !== n && extEq(r.ours, r.srcs[m].v));
        if (same.length) return { guess: `앱(현금흐름표 본표 줄) = ${same.join("·")} — ${n} 는 다른 정의로 보임` };
      }
      if (oneOff != null && oneOff !== 0 && Math.abs(v - r.ours - oneOff) <= Math.abs(v) * 1e-3) return { guess: `일회성 항목 조정 — 잔차 ${v - r.ours - oneOff}` };
      if (Math.abs(v - r.ours) <= Math.abs(v) * 5e-4) return { guess: `0.05% 이내 — 소스 반올림·주식수 기준일 차 추정(차 ${v - r.ours})` };
      return {};
    };
    // ── 원인 R1~R3·R5·R6 준비 — 해당 불일치가 있을 때만 공시 원본을 읽는다(SEC 요청 절약)
    const mism = (item, src) => { const x = recon.get(item); return !!x?.srcs[src] && !extEq(x.ours, x.srcs[src].v); };
    let debtDec = null, irDeriv = null, finOblig = null, revDims = null, revParts = null, revQDeriv = null, cogsDims = null, revQParts = null, cogsInst = null, saQInc = null;
    if (mism("LTM 총차입금(운용리스 포함)", "Yahoo") || mism("LTM 총차입금(운용리스 포함)", "StockAnalysis")) {
      try {
        const fl = await filingAtDate(cik, sub, L.date);
        if (fl) {
          const { faceVals, faceSum, val0, nm } = faceDebtLines(fl);
          const onFace = (id) => fl.faceIds.has(id);
          const firstOff = (ids) => { for (const id of ids) if (!onFace(id) && val0(id) != null) return { id, v: val0(id) }; return null; };
          const off = [];
          // 본표에 유동 차입금 줄(운용리스 제외 — "LongTermDebtAndCapitalLeaseObligationsCurrent" 는 차입금+금융리스 유동분)이 없을 때만 주석값
          if (!faceVals.some((x) => /Current/.test(nm(x.id)) && !/OperatingLease/.test(nm(x.id)))) {
            // DebtCurrent 는 단기차입금 포함 합계. 없으면 유동성 장기부채 + 단기차입금·CP(본표 밖 — AMZN ShortTermBorrowings 325)
            const dc = firstOff(["us-gaap_DebtCurrent"]);
            if (dc) off.push({ ...dc, why: "주석 유동 차입금" });
            else {
              const c = firstOff(["us-gaap_LongTermDebtAndCapitalLeaseObligationsCurrent", "us-gaap_LongTermDebtCurrent"]);
              if (c) off.push({ ...c, why: "주석 유동 차입금" });
              for (const id of ["us-gaap_ShortTermBorrowings", "us-gaap_CommercialPaper"]) { const x = firstOff([id]); if (x) off.push({ ...x, why: "주석 단기차입금" }); }
            }
          }
          // 본표의 일반 리스부채 줄(LeaseLiability·LeaseLiabilityNoncurrent — 금융·운용 합산, AMZN)이 이미 담은 쪽은 주석값을 보태지 않는다
          const genNon = faceVals.some((x) => /^LeaseLiability(Noncurrent)?$/.test(nm(x.id))), genCur = faceVals.some((x) => /^LeaseLiability(Current)?$/.test(nm(x.id)));
          if (!faceVals.some((x) => /FinanceLease|CapitalLease/.test(nm(x.id)))) {
            const cur = genCur ? null : firstOff(["us-gaap_FinanceLeaseLiabilityCurrent"]), non = genNon ? null : firstOff(["us-gaap_FinanceLeaseLiabilityNoncurrent"]);
            if (cur || non) { if (cur) off.push({ ...cur, why: "주석 금융리스" }); if (non) off.push({ ...non, why: "주석 금융리스" }); }
            else if (!genNon && !genCur) { const t = firstOff(["us-gaap_FinanceLeaseLiability"]); if (t) off.push({ ...t, why: "주석 금융리스" }); }
          }
          const opCur = genCur ? null : firstOff(["us-gaap_OperatingLeaseLiabilityCurrent"]), opNon = genNon ? null : firstOff(["us-gaap_OperatingLeaseLiabilityNoncurrent"]);
          if (opCur) off.push({ ...opCur, why: "본표 밖 운용리스" });
          if (opNon) off.push({ ...opNon, why: "본표 밖 운용리스" });
          if (!opCur && !opNon && !genNon && !genCur && !faceVals.some((x) => /OperatingLease/.test(nm(x.id)))) { const t = firstOff(["us-gaap_OperatingLeaseLiability"]); if (t) off.push({ ...t, why: "본표 밖 운용리스" }); }
          // 유동 운용리스 태그 없이 총액만 있고 본표엔 비유동만(MSFT: 유동분은 OperatingLeaseLiability[기타유동부채] 차원) → 총액 − 본표 비유동
          const faceOpNon = faceVals.find((x) => nm(x.id) === "OperatingLeaseLiabilityNoncurrent"), opTot = val0("us-gaap_OperatingLeaseLiability");
          // 본표에 유동 운용리스 줄이 이미 있으면 적용하지 않는다(BE 2026-06-30 — 본표 유동 23,094천을 두 번 셌다, 2026-09-30)
          if (!opCur && !genCur && faceOpNon && opTot != null && !onFace("us-gaap_OperatingLeaseLiability") && !onFace("us-gaap_OperatingLeaseLiabilityCurrent") && opTot - faceOpNon.v > 0) off.push({ id: "us-gaap_OperatingLeaseLiability", v: opTot - faceOpNon.v, why: `본표 밖 유동 운용리스(총액 ${opTot} − 본표 비유동)` });
          const offSum = off.reduce((t, x) => t + x.v, 0);
          debtDec = { fl, faceVals, faceSum, off, offSum, appOk: withLease != null && Math.abs(withLease - (faceSum + offSum)) <= 1, val0, onFace, nm };
          if (!debtDec.appOk) review.push({ item: "LTM 총차입금 SEC 본표 분해 불성립", note: `앱(운용리스 포함) ${withLease} ≠ 본표 줄 합 ${faceSum}(${faceVals.map((x) => `${nm(x.id)} ${x.v}`).join(" + ")}) + 주석·본표 밖 ${offSum}(${off.map((x) => `${x.why} ${nm(x.id)} ${x.v}`).join(" + ") || "없음"}) — ${fl.form} ${fl.date}. 차입금 원인 R1·R2·R3 은 추정까지만` });
          // R2 금리·통화금리 파생상품 부채(DerivativeInstrumentRiskAxis) — 멤버별로 위치(유동·비유동) 내역이 있으면 그 합, 없으면 차원 합
          const IR = /InterestRate|CrossCurrencyInterestRate/i;
          const irOf = (concept) => {
            const byM = new Map();
            for (const x of fl.facts) {
              if (x.id !== `us-gaap_${concept}`) continue;
              const risk = x.dims.find((d) => d[0] === "DerivativeInstrumentRiskAxis");
              if (!risk || !IR.test(risk[1])) continue;
              const loc = x.dims.some((d) => /StatementOfFinancialPositionLocation|BalanceSheetLocation/.test(d[0]));
              const b = byM.get(risk[1]) ?? { loc: [], no: [] };
              (loc ? b.loc : b.no).push(x.v);
              byM.set(risk[1], b);
            }
            if (!byM.size) return null;
            const sum = [...byM.values()].reduce((t, b) => t + (b.loc.length ? b.loc : b.no).reduce((a, y) => a + y, 0), 0);
            // 같은 값이 금리 외 멤버에도 있으면 어느 멤버 값인지 확정 못 함(DELL 13) → 추정
            // (위험 축이 있는 금리 외 멤버만 본다 — 위험 축 없는 합계 줄(WMT −1,337)은 같은 값이어도 중복이 아니다)
            const dup = sum !== 0 && fl.facts.some((x) => x.id.includes("Derivative") && Math.abs(x.v) === Math.abs(sum) && x.dims.some((d) => d[0] === "DerivativeInstrumentRiskAxis" && !IR.test(d[1])));
            return { sum, dup, members: [...byM.keys()] };
          };
          const liab = irOf("DerivativeFairValueOfDerivativeLiability"), net = liab ? null : irOf("DerivativeFairValueOfDerivativeNet");
          irDeriv = liab ? { ...liab, add: liab.sum, how: "DerivativeFairValueOfDerivativeLiability" } : net ? { ...net, add: -net.sum, how: "DerivativeFairValueOfDerivativeNet(부호 반전)" } : null;
          // R3 본표 밖 회사 고유 금융 의무(…FinancingObligation(s)Current/Noncurrent — AMZN)
          const fo = fl.facts.filter((x) => !x.id.startsWith("us-gaap_") && !x.dims.length && /FinancingObligations?(Current|Noncurrent)$/.test(x.id) && !onFace(x.id));
          finOblig = fo.length ? { sum: fo.reduce((t, x) => t + x.v, 0), ids: fo.map((x) => `${nm(x.id)} ${x.v}`) } : null;
        }
      } catch (e) {
        errs.push(`차입금 원인 판정 공시 원본(${L.date}) 조회 실패: ${String(e).slice(0, 60)}`);
      }
    }
    const revItems = [...recon.values()].filter((x) => /^\d{4}Y 매출$/.test(x.item) && ((x.srcs["인포맥스"] && !extEq(x.ours, x.srcs["인포맥스"].v)) || (x.srcs.StockAnalysis && !extEq(x.ours, x.srcs.StockAnalysis.v))));
    if (revItems.length && !foreign) {
      // 불일치 연도의 그 해 10-K 도 읽는다(파생상품 표가 옛 연도를 안 싣는 경우 — LRCX FY2022·CAT 2021)
      const ends = revItems.map((x) => H[x.item.split(" ")[0]]?.date).filter(Boolean);
      try { revDims = await annualRevenueDimFacts(cik, sub, 3, ends); }
      catch (e) { errs.push(`매출 차원 공시 원본 조회 실패: ${String(e).slice(0, 60)}`); }
    }
    // 매출원가 인포맥스 원인(원가 위치 현금흐름위험회피 재분류 — NFLX) — 연간 매출원가가 인포맥스와 다를 때만 10-K 원본 차원 사실을 읽는다
    if (COGS_MODE && !foreign) {
      const ends = Object.keys(H).filter((c) => c !== "LTM" && mism(`${c} 매출원가`, "인포맥스")).map((c) => H[c].date);
      if (ends.length) {
        try { cogsDims = await annualRevenueDimFacts(cik, sub, 3, ends); }
        catch (e) { errs.push(`매출원가 차원 공시 원본 조회 실패: ${String(e).slice(0, 60)}`); }
      }
    }
    // 매출원가 LTM 분기 합(cogsQuarterSum·saCogsInst 분기 경로) — SA LTM 이 다를 때만 SA 분기 손익(같은 소스의 분기 표)을 받는다
    if ((COGS_MODE && !foreign && mism("LTM 매출원가", "StockAnalysis")) || (OPINC_MODE && !foreign && mism("LTM 영업이익", "StockAnalysis")) || (DA_MODE && !foreign && mism("LTM 감가상각비", "StockAnalysis"))) {
      try { saQInc = await saStatement(sym, "income-statement", true); }
      catch (e) { errs.push(`StockAnalysis 분기 손익 조회 실패: ${String(e).slice(0, 60)}`); }
    }
    // 매출원가 StockAnalysis 전 열 규칙(saCogsInst) — 어느 매출원가 열이든 SA 와 다를 때만, 원가 판독 구성분(LTM 은 SA 분기 구성분까지)의 본표 공시
    // 원본(이미 판독한 공시)을 읽는다
    // LTM 분기 합(cogsQuarterSum)의 원가 멤버 줄 합 경로도 같은 원본을 쓴다 — LTM 매출원가가 Yahoo·인포맥스와 다를 때 그 분기 구성분 공시까지
    const ltmQMism = ["Yahoo", "인포맥스"].filter((n) => mism("LTM 매출원가", n));
    if (COGS_MODE && !foreign && cogsFace && (ltmQMism.length || cogsCols("StockAnalysis").some((x) => !extEq(x.ours, x.srcs.StockAnalysis.v)))) {
      const accns = new Set();
      for (const x of cogsCols("StockAnalysis")) for (const c of compsOf(cogsExp.get(x.item.split(" ")[0])) ?? []) if (c.faceAccn) accns.add(c.faceAccn);
      const qEnds = [...(saQuarters() ?? []).map((q) => q.end), ...(ltmQMism.includes("Yahoo") ? last4.map((r) => iso(r.date)) : []),
        ...(ltmQMism.includes("인포맥스") ? (imAnnual?.quarters ?? []).filter((r) => r.end <= L.date || dayDiff(r.end, L.date) <= 7).slice(-4).map((r) => r.end) : [])];
      for (const end of new Set(qEnds)) for (const c of compsOf(secQuarter(end)) ?? []) if (c.faceAccn) accns.add(c.faceAccn);
      try {
        cogsInst = new Map();
        for (const accn of accns) {
          const url = cogsFace.faces.find((f) => f.accn === accn)?.instUrl;
          if (!url) continue;
          const xml = await secInstance(url);
          const ctx = parseContexts(xml), out = [], seen = new Set();
          for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*?)contextRef="([^"]+)"([^>]*)>\s*(-?[\d.]+)\s*</g)) {
            const c = ctx.get(m[4]);
            if (!c?.start || !c.end || !/unitRef="[^"]*USD/i.test(`${m[3]} ${m[5]}`)) continue;
            const k = `${m[1]}_${m[2]}|${c.start}|${c.end}|${c.dims.flat().join(",")}`;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({ id: `${m[1]}_${m[2]}`, start: c.start, end: c.end, dims: c.dims, v: Number(m[6]) });
          }
          cogsInst.set(accn, out);
        }
      } catch (e) { cogsInst = null; errs.push(`매출원가 원가 안 항목 공시 원본 조회 실패: ${String(e).slice(0, 60)}`); }
    }
    // R9 본표 매출 하위 줄 합 — 연간 매출이 어느 외부 소스와든 다를 때만, 이미 읽은 10-K 본표 구조(revFace.faces)의 원본에서
    const revAnyMism = [...recon.values()].some((x) => /^\d{4}Y 매출$/.test(x.item) && Object.values(x.srcs).some((s) => !extEq(x.ours, s.v)));
    if (revAnyMism && revFace && !foreign) {
      try { revParts = await faceRevenueParts(revFace.faces); }
      catch (e) { errs.push(`매출 본표 하위 줄 공시 원본 조회 실패: ${String(e).slice(0, 60)}`); }
    }
    // R4 분기별 — LTM 매출이 Yahoo·인포맥스와 다르고 어떤 분기가 SEC 3개월값과 다를 때만, 그 LTM 창의 10-Q 본표 하위 줄 3개월 합을 읽는다
    if (revFace && !foreign && ["Yahoo", "인포맥스"].some((n) => mism("LTM 매출", n) && r4Quarters(n)?.bad?.length)) {
      const from = new Date(Date.parse(L.date) - 370 * 864e5).toISOString().slice(0, 10);
      try { revQParts = await faceRevenueQuarterParts(revFace.faces.filter((f) => f.form === "10-Q" && f.report >= from && f.report <= L.date)); }
      catch (e) { errs.push(`매출 분기 본표 하위 줄 공시 원본 조회 실패: ${String(e).slice(0, 60)}`); }
    }
    // StockAnalysis LTM 매출이 다를 때만 — LTM 창의 10-Q·10-K 원본에서 분기별 "매출 − 비용 환급 매출"(HLT: StockAnalysis 분기 매출 = 환급 제외)
    let reimbExQ = null;
    if (revFace && !foreign && saQInc && mism("LTM 매출", "StockAnalysis")) {
      const from = new Date(Date.parse(L.date) - 470 * 864e5).toISOString().slice(0, 10);
      try { reimbExQ = await reimbExQuarterValues(revFace.faces.filter((f) => f.report >= from && f.report <= L.date)); }
      catch (e) { errs.push(`매출 분기 환급 제외 공시 원본 조회 실패: ${String(e).slice(0, 60)}`); }
    }
    // R8 분기 확장 — 인포맥스 LTM 매출이 다를 때만, 인포맥스 최근 4분기 결산일의 10-Q·10-K 원본에서 매출 위치 파생상품 손익
    if (mism("LTM 매출", "인포맥스") && revFace && !foreign && imAnnual?.quarters) {
      const qEnds = imAnnual.quarters.filter((q) => q.end <= L.date || dayDiff(q.end, L.date) <= 7).slice(-4).map((q) => q.end);
      // 분기 결산일 공시 + 누적 차(6M − 3M 등)에 필요한 그 사이 공시(LTM 창 첫 분기 − 100일 이후)
      const from = qEnds.length ? new Date(Date.parse(qEnds[0]) - 100 * 864e5).toISOString().slice(0, 10) : "";
      try { if (qEnds.length === 4) revQDeriv = await derivFactsOf(revFace.faces.filter((f) => !f.any && f.instUrl && (qEnds.some((E) => dayDiff(f.report, E) <= 7) || (f.report >= from && f.report <= L.date)))); }
      catch (e) { errs.push(`매출 분기 파생상품 공시 원본 조회 실패: ${String(e).slice(0, 60)}`); }
    }
    // 4분기 실적발표 8-K 분기값(2026-09-30 — 블룸버그 LTM 세전이익 CL 2,941·IBM 10,440: 블룸버그 분기 화면 확인 결과 4분기 = 회사 실적발표 8-K 표의
    // 분기값(CL 107, IBM 4,144), 앱 4분기 = 연간 − 9개월 누적(108·4,143 — 회사가 연간·누적·분기를 따로 반올림)). LTM 창 안의 사업연도 결산 뒤 첫 항목
    // 2.02 8-K 에서 "Income before income taxes" 행의 첫 숫자(당분기)를 읽는다. 블룸버그 LTM 칸이 앱과 다를 때만(원문 디스크 캐시)
    const q4Rel = new Map(); // 지표 → { v, filed, url, fyEnd, q4sec }
    // 회사 고유 설비 취득 줄(2026-10-01 INTC 2021 — 현금흐름표 투자활동에 "매각 예정 NAND 설비 취득" 1,596 이 별도 줄, 태그 intc_DivestitureAdditionsTo
    // PropertyPlantAndEquipmentHeldForSale). 자본지출 외부값이 앱과 다른 연간 열만 그 결산일 10-K 원본을 읽는다 → 열 → [{ id, v }]
    const capexCustom = new Map();
    // 자사주 매입 소비세 회사 고유 줄(2026-10-01 CAT 2025 — 재무활동 "Excise tax paid on purchase of common stock" 73, cat_PaymentsForExciseTaxOnPurchaseOfCommonStock)
    const buybackCustom = new Map();
    for (const [c0, x] of Object.entries(H)) {
      if (c0 === "LTM" || !x?.date) continue;
      const rr = recon.get(`${c0} 현금흐름표 자기주식 취득`);
      if (!rr || rr.ours == null || !Object.values(rr.srcs).some((z) => !extEq(z.v, rr.ours))) continue;
      try {
        const fa = await filingAtDate(cik, sub, x.date);
        const hits = (fa?.durFacts ?? []).filter((f) => !f.dims.length && /Excise/i.test(f.id) && /Repurchase|Purchase|Buyback|Treasury|CommonStock/i.test(f.id) && (Date.parse(f.end) - Date.parse(f.start)) / 864e5 >= 300 && f.v);
        if (hits.length) buybackCustom.set(c0, [...new Map(hits.map((f) => [f.id, f.v])).entries()].map(([id, v]) => ({ id, v, form: fa.form })));
      } catch (e) { errs.push(`자사주 회사 고유 줄 조회 실패(${c0}): ${String(e).slice(0, 60)}`); }
    }
    // LTM 소비세 = 직전 사업연도 + 최근 10-Q 당기 누적 − 전년 동기 누적(2026-10-01 CAT LTM: 73 + 49 − 73 = 49 → SA 7,273 = 7,224 + 49). 같은 회사 고유 태그만
    {
      const rr = recon.get("LTM 현금흐름표 자기주식 취득"), fyc = Object.keys(H).filter((k) => k !== "LTM" && H[k]?.date && H.LTM?.date && H[k].date < H.LTM.date).sort((a, b) => H[b].date.localeCompare(H[a].date))[0];
      const fyv = fyc ? buybackCustom.get(fyc) : null;
      if (rr && rr.ours != null && fyv?.length && Object.values(rr.srcs).some((z) => !extEq(z.v, rr.ours))) {
        try {
          const rc = sub.filings.recent, k = (rc.form ?? []).findIndex((fm, i) => fm === "10-Q" && rc.reportDate?.[i] && dayDiff(rc.reportDate[i], H.LTM.date) <= 7);
          if (k >= 0) {
            const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${rc.accessionNumber[k].replace(/-/g, "")}`;
            const nm = (await secJson(`${base}/index.json`)).directory.item.map((x) => x.name).find((x) => /_htm\.xml$/i.test(x));
            const xml = nm ? await secInstance(`${base}/${nm}`) : "";
            const ctx = parseContexts(xml), out = [];
            for (const f of fyv) {
              const [ns, local] = [f.id.slice(0, f.id.indexOf("_")), f.id.slice(f.id.indexOf("_") + 1)];
              const vals = [...xml.matchAll(new RegExp(`<${ns}:${local}\\b[^>]*contextRef="([^"]+)"[^>]*>\\s*(-?[\\d.]+)\\s*<`, "g"))].map((m) => ({ c: ctx.get(m[1]), v: Number(m[2]) })).filter((x) => x.c?.start && !x.c.dims.length);
              const cur = vals.find((x) => dayDiff(x.c.end, H.LTM.date) <= 7 && dayDiff(x.c.start, H.LTM.date) > 60), prior = cur && vals.find((x) => dayDiff(x.c.end, H.LTM.date) >= 358 && dayDiff(x.c.end, H.LTM.date) <= 372 && Math.abs(dayDiff(x.c.start, x.c.end) - dayDiff(cur.c.start, cur.c.end)) <= 7);
              if (cur && prior) out.push({ id: f.id, v: f.v + cur.v - prior.v, form: `${fyc} 10-K ${f.v} + 10-Q 누적 ${cur.v} − 전년 동기 ${prior.v}` });
            }
            if (out.length) buybackCustom.set("LTM", out);
          }
        } catch (e) { errs.push(`자사주 회사 고유 줄 LTM 조회 실패: ${String(e).slice(0, 60)}`); }
      }
    }
    for (const [c0, x] of Object.entries(H)) {
      if (c0 === "LTM" || !x?.date) continue;
      const rr = recon.get(`${c0} 현금흐름표 유형자산 취득(CAPEX)`);
      if (!rr || rr.ours == null || !Object.values(rr.srcs).some((z) => !extEq(z.v, rr.ours))) continue;
      try {
        const fa = await filingAtDate(cik, sub, x.date);
        const hits = (fa?.durFacts ?? []).filter((f) => !f.dims.length && !/^us-gaap_/.test(f.id) && /PropertyPlantAndEquipment|CapitalExpenditure/i.test(f.id) && /Addition|Purchase|Payment|Acqui|Expenditure/i.test(f.id)
          && (Date.parse(f.end) - Date.parse(f.start)) / 864e5 >= 300 && f.v);
        if (hits.length) capexCustom.set(c0, [...new Map(hits.map((f) => [f.id, f.v])).entries()].map(([id, v]) => ({ id, v, form: fa.form })));
      } catch (e) { errs.push(`자본지출 회사 고유 줄 조회 실패(${c0}): ${String(e).slice(0, 60)}`); }
    }
    {
      const lt = recon.get("LTM 세전이익");
      const fyc = Object.keys(H).filter((k) => k !== "LTM" && H[k]?.date && H.LTM?.date && H[k].date < H.LTM.date).sort((a, b) => H[b].date.localeCompare(H[a].date))[0];
      if (lt?.srcs?.["블룸버그"] && !extEq(lt.srcs["블룸버그"].v, lt.ours) && fyc) {
        const E = H[fyc].date;
        try {
          const rc0 = sub.filings.recent;
          const i = (rc0.form ?? []).map((fm, j) => j).filter((j) => rc0.form[j] === "8-K" && /2\.02/.test(rc0.items?.[j] ?? "") && rc0.filingDate[j] > E && dayDiff(rc0.filingDate[j], E) <= 80).sort((a, b) => rc0.filingDate[a].localeCompare(rc0.filingDate[b]))[0];
          if (i != null) {
            const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${rc0.accessionNumber[i].replace(/-/g, "")}`;
            const idx = await secJson(`${base}/index.json`);
            for (const d0 of idx.directory.item.filter((x) => /\.htm$/i.test(x.name) && !/^R\d+\.htm$/i.test(x.name))) {
              const txt = (await secText(`${base}/${d0.name}`)).replace(/<[^>]+>/g, " ").replace(/&#160;|&nbsp;|&#36;|&#x24;/gi, " ").replace(/\s+/g, " ");
              const m = txt.match(/income (?:\(loss\) )?(?:from continuing operations )?before income taxes\s*\$?\s*(\(?-?[\d,]+(?:\.\d+)?\)?)/i);
              if (!m) continue;
              const raw = m[1], neg = /\(|-/.test(raw), num = Number(raw.replace(/[^\d.]/g, ""));
              const scale = /in thousands/i.test(txt.slice(0, 20000)) ? 1e3 : 1e6;
              if (Number.isFinite(num)) { q4Rel.set("세전이익", { v: (neg ? -num : num) * scale, filed: rc0.filingDate[i], url: `${base}/${d0.name}`, fyEnd: E }); break; }
            }
          }
        } catch (e) { errs.push(`4분기 실적발표 8-K 조회 실패: ${String(e).slice(0, 60)}`); }
      }
    }
    // 4분기 실적발표 8-K 의 분기 감가상각·상각(2026-10-01 IBM — 8-K 현금흐름 요약 "Depreciation/Amortization of Intangibles" 4분기 1,297, 10-K·10-Q 로는
    //    사업연도 5,021 − 9개월 3,725 = 1,296). 블룸버그 LTM 이 앱과 다를 때만 읽는다
    {
      const lt = recon.get("LTM 감가상각비");
      const fyc = Object.keys(H).filter((k) => k !== "LTM" && H[k]?.date && H.LTM?.date && H[k].date < H.LTM.date).sort((a, b) => H[b].date.localeCompare(H[a].date))[0];
      if (lt?.srcs?.["블룸버그"] && !extEq(lt.srcs["블룸버그"].v, lt.ours) && fyc) {
        const E = H[fyc].date;
        try {
          const rc0 = sub.filings.recent;
          const i = (rc0.form ?? []).map((fm, j) => j).filter((j) => rc0.form[j] === "8-K" && /2\.02/.test(rc0.items?.[j] ?? "") && rc0.filingDate[j] > E && dayDiff(rc0.filingDate[j], E) <= 80).sort((a, b) => rc0.filingDate[a].localeCompare(rc0.filingDate[b]))[0];
          if (i != null) {
            const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${rc0.accessionNumber[i].replace(/-/g, "")}`;
            const idx = await secJson(`${base}/index.json`);
            for (const d0 of idx.directory.item.filter((x) => /\.htm$/i.test(x.name) && !/^R\d+\.htm$/i.test(x.name))) {
              const txt = (await secText(`${base}/${d0.name}`)).replace(/<[^>]+>/g, " ").replace(/&#47;/g, "/").replace(/&#160;|&nbsp;|&#x200B;|&#36;|&#x24;/gi, " ").replace(/\s+/g, " ");
              const m = txt.match(/Depreciation\s*\/\s*Amortization of Intangibles\s*(?:\(\d\))?\s*\$?\s*([\d,]+(?:\.\d+)?)/i);
              if (!m) continue;
              const num = Number(m[1].replace(/,/g, "")), scale = /in thousands/i.test(txt.slice(0, 20000)) ? 1e3 : 1e6;
              if (Number.isFinite(num)) { q4Rel.set("감가상각비", { v: num * scale, filed: rc0.filingDate[i], url: `${base}/${d0.name}`, fyEnd: E }); break; }
            }
          }
        } catch (e) { errs.push(`4분기 실적발표 8-K(감가상각비) 조회 실패: ${String(e).slice(0, 60)}`); }
      }
    }
    // 실적발표 8-K(항목 2.02) GAAP 희석 EPS(오너 지시 2026-09-30 — "8k 도 반영"). 10-K 에 없는 값 두 가지를 확인한다: 분할 전 연간 EPS
    // (WMT FY2024 5.74 — 그 해 10-K 는 분할 뒤 제출돼 1.91 로 실림, 분할 전 값의 출처는 8-K 뿐), 4분기 EPS(TSLA 2023 2.27 — XBRL 에 4분기
    // 3개월 값이 없음). 앱 EPS 와 다른 외부 값이 있는 연도만 받는다(원문은 디스크 캐시). 숫자: "GAAP EPS of $X" 류 · "diluted" 뒤 숫자열(괄호 = 음수)
    const relEps = new Map(); // 연도 열 → { filed, url, vals }
    {
      const want = [...recon.values()].filter((x) => /^\d{4}Y 희석 EPS$/.test(x.item) && Object.entries(x.srcs).some(([k, y]) => k !== "인포맥스" && !extEq(y.v, x.ours))).map((x) => x.item.split(" ")[0]);
      let pages = null;
      const num = (t) => { const neg = t.includes("(") || t.trim().startsWith("-"); const n0 = Number(t.replace(/[^\d.]/g, "")); return Number.isFinite(n0) ? (neg ? -n0 : n0) : null; };
      for (const col of want) {
        const E = H[col]?.date;
        if (!E) continue;
        try {
          pages ??= [sub.filings.recent];
          const hits = () => pages.flatMap((pg) => (pg.form ?? []).map((fm, i) => ({ fm, i, pg })).filter(({ fm, i, pg }) => fm === "8-K" && /2\.02/.test(pg.items?.[i] ?? "")
            && pg.filingDate[i] > E && dayDiff(pg.filingDate[i], E) >= 10 && dayDiff(pg.filingDate[i], E) <= 80));
          for (const fl of sub.filings.files ?? []) { if (hits().length || (fl.filingTo ?? "") < E) break; pages.push(await secJson(`https://data.sec.gov/submissions/${fl.name}`)); }
          const h = hits().sort((a, b) => a.pg.filingDate[a.i].localeCompare(b.pg.filingDate[b.i]))[0];
          if (!h) continue;
          const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${h.pg.accessionNumber[h.i].replace(/-/g, "")}`;
          const idx = await secJson(`${base}/index.json`);
          const docs = idx.directory.item.filter((x) => /\.htm$/i.test(x.name) && /ex-?99|earnings|release|press/i.test(x.name) && !/presentation/i.test(x.name));
          const vals = new Set();
          for (const dct of docs) {
            const txt = (await secText(`${base}/${dct.name}`)).replace(/<[^>]+>/g, " ").replace(/&#160;|&nbsp;|&#36;|&#x24;/gi, " ").replace(/&#59;/g, ";").replace(/\s+/g, " ");
            for (const m of txt.matchAll(/(?:GAAP EPS|earnings per share|EPS)[^.$\d]{0,40}(?:of|was)\s*\$?\s*(\(?-?\d+\.\d{2}\)?)/gi)) { const v0 = num(m[1]); if (v0 != null) vals.add(v0); }
            for (const m of txt.matchAll(/\$\s*(\(?-?\d+\.\d{2}\)?)\s*(?:of\s*)?(?:GAAP\s*)?diluted/gi)) { const v0 = num(m[1]); if (v0 != null) vals.add(v0); } // "($43.97 diluted net income per share)" — SNDK FY2026
            for (const m of txt.matchAll(/diluted[^0-9()$]{0,80}((?:\s*\$?\s*\(?-?\d{1,3}\.\d{2}\)?){1,10})/gi))
              for (const t of m[1].match(/\(?-?\d{1,3}\.\d{2}\)?/g) ?? []) { const v0 = num(t); if (v0 != null) vals.add(v0); }
          }
          if (vals.size) relEps.set(col, { filed: h.pg.filingDate[h.i], url: base, vals: [...vals] });
        } catch (e) { errs.push(`${col} 실적발표 8-K 조회 실패: ${String(e).slice(0, 60)}`); }
      }
    }
    // 1차: EBITDA 외 항목 → 2차: EBITDA(구성요소 판정 결과를 쓴다)
    const done = new Map();
    // 매출총이익은 매출·매출원가 판정 결과(구성요소 규칙)를 쓰므로 그 뒤, EBITDA 는 맨 뒤
    const rank = (x) => (/EBITDA$/.test(x.item) ? 2 : /매출총이익$/.test(x.item) ? 1 : 0);
    const ordered = [...recon.values()].sort((a, b) => rank(a) - rank(b));
    for (const r of ordered) {
      const names = Object.keys(r.srcs);
      // 인포맥스 = 참고(오너 결정 2026-09-28 — "인포맥스만 유일하게 차이가 나는 게 대부분"): 값·원인은 표시하되 ①②③·외부 단독 이탈 분류와
      // 원인 미확인 목록에서 뺀다. 예외 — 외화 공시 종목(USD 환산 대조는 인포맥스만 가능)·시가총액·주식수 항목은 정식 소스 유지
      const clsNames = names.filter((n) => n !== "인포맥스" || process.env.IM_REFERENCE === "0" || foreign || /시가총액|주식수/.test(r.item));
      // 공통모드 소스(앱과 같은 데이터·규칙으로 만든 외부 값)의 일치는 ① 이 아니다 — matched 에서 빼고 commonMode 로 따로 남긴다
      const commonMode = Object.fromEntries(names.filter((n) => r.srcs[n].common && extEq(r.ours, r.srcs[n].v)).map((n) => [n, `일치 — ${r.srcs[n].common}`]));
      const matched = names.filter((n) => extEq(r.ours, r.srcs[n].v) && !commonMode[n]);
      const causes = Object.fromEntries(names.filter((n) => !matched.includes(n) && !commonMode[n]).map((n) => [n, causeOf(r, n, done)]));
      for (const [n, c] of Object.entries(causes)) done.set(`${r.item}|${n}`, c);
      // 원인 규칙이 공통모드(앱과 같은 규칙·A층 공통모드 전제)이거나 외부 정밀도 부족(표기 단위 반올림)이면 ② 가 아니다
      for (const n of names) if (causes[n]?.common) commonMode[n] = causes[n].common;
      const precisionNa = Object.fromEntries(names.filter((n) => causes[n]?.na).map((n) => [n, causes[n].na]));
      const explained = names.filter((n) => causes[n]?.ok);
      // 외부 단독 이탈 — 원인 확인이 아니다(explained 에 넣지 않는다). 앱 = SEC 본표 = 다른 소스일 때만 붙는 분류
      const outliers = names.filter((n) => causes[n]?.outlier);
      // 정의차(앱 결함 후보) — 원인도 이탈도 아니다. causes 에 넣지 않고 따로 남긴다
      const defDiffs = Object.fromEntries(names.filter((n) => causes[n]?.defdiff).map((n) => [n, causes[n].defdiff]));
      const appSec = Object.fromEntries(names.filter((n) => causes[n]?.appsec).map((n) => [n, causes[n].appsec]));
      const why = (n) => (causes[n]?.ok ? ` [원인 확인: ${causes[n].ok}]` : causes[n]?.common ? ` [${COMMON_LABEL}: ${causes[n].common}]` : causes[n]?.na ? ` [${causes[n].naLabel ?? NA_PRECISION}: ${causes[n].na}]` : causes[n]?.outlier ? ` [${causes[n].outlier}]` : causes[n]?.defdiff ? ` [${causes[n].defdiff}]` : causes[n]?.appsec ? ` [${causes[n].appsec}]` : causes[n]?.guess ? ` [원인 추정: ${causes[n].guess}]` : "");
      const off = names.filter((n) => !matched.includes(n) && !(commonMode[n] && extEq(r.ours, r.srcs[n].v))).map((n) => `${n} ${r.srcs[n].v} (${(((r.ours - r.srcs[n].v) / Math.abs(r.srcs[n].v)) * 100).toFixed(2)}%)${why(n)}`);
      // 매출 분류(revenue.md §0): ① 일치 · ② 정의 차이(분해식 정확 성립 = 원인 확인) · 외부 단독 이탈(앱 = SEC 본표 정확 일치 +
      // 다른 외부 2곳 이상 앱과 일치 + 이 소스만 이탈) · ③ 오류(그 밖 전부 — 추정·미분해·앱≠SEC 포함)
      let revenueClass = null;
      if (/^(\d{4}Y|LTM) 매출$/.test(r.item)) {
        const col0 = r.item.split(" ")[0];
        // 외부 단독 이탈 두 경로: §0(앱 = SEC + 외부 2곳 이상 일치 + 이 소스만 이탈), 또는 그 소스 자체 집계 불일치가 숫자로 확인됨
        // (causes.outlier — 인포맥스 연간 ≠ 자기 분기 4개 합 = 앱 = SEC). 둘 다 앱 = SEC 본표(A층 정확 일치) 전제
        const clsMatched = matched.filter((n) => clsNames.includes(n));
        revenueClass = Object.fromEntries(clsNames.map((n) => [n, matched.includes(n) ? "①" : commonMode[n] ? "공통모드" : precisionNa[n] ? "NA" : causes[n]?.ok ? "②"
          : aPassed(col0, "매출") && ((clsMatched.length >= 2 && clsNames.length - clsMatched.length === 1) || causes[n]?.outlier) ? "외부단독이탈" : "③"]));
        for (const n of clsNames) if (revenueClass[n] === "③") revErrors.push({ item: r.item, source: n, ours: r.ours, other: r.srcs[n].v, note: `${why(n).trim() || "분해식 없음"}${aPassed(col0, "매출") ? "" : " · 앱 ≠ SEC 본표(A층 미통과)"}` });
      }
      // 매출원가·매출총이익 분류(--metric=cogs) — 매출과 같은 §0 기준. 외부 단독 이탈 = 앱 = SEC 본표 + 다른 외부 2곳 이상 일치 + 이 소스만
      // 이탈, 또는 외부 자기 모순(인포맥스 연간 ≠ 자기 분기 합 = 앱 = SEC)
      // 줄 단위 구성 대조 반영 — 연간·LTM(LTM 은 연간과 같은 구성이 LTM 에서도 성립할 때만 recon 이 ②)
      const reconApply = (cls, col0, m0) => {
        for (const n of Object.keys(cls)) {
          // 외부단독이탈(외부 자기모순 — 숫자로 확인된 근거)은 덮어쓰지 않는다(감사 2026-09-28 HIGH-2)
          if (cls[n] !== "외부정의분해불가") continue;
          const x = RECON.get(`${sym}|${n}|${m0}|${col0.replace(/Y$/, "")}`);
          // 이번 실행의 외부값·앱값과 같을 때만 그 대조 결과를 쓴다(다른 실행 기준 결과를 붙이지 않음)
          const same = x && x.ext === r.srcs[n]?.v && x.app === r.ours;
          // 분해 안 되면 외부 단독 이탈(오너 결정 2026-09-30 — "구성 미분해" 폐지: 앱 = SEC 본표 + 다른 외부 1곳 이상 일치인데 이 소스만 해마다 기준이 바뀌면 외부 쪽 문제)
          if (x?.ok && same) { cls[n] = "②"; causes[n] = { ok: `구성 분해(줄 단위 대조): ${x.how}` }; } else cls[n] = "외부단독이탈";
        }
      };
      if (revenueClass) reconApply(revenueClass, r.item.split(" ")[0], "매출");
      // 환율 영향(보류, 오너 지시 2026-09-28): 외화 공시(20-F·IFRS — TSM·ASML·SPOT·NVO 등)의 외부 단독 이탈은 외부가 USD 로 역산한
      // 환율 차이가 섞여 따로 둔다 — 미국 10-K 종목부터 닫고 이 구분은 뒤로 뺀다
      const fxHold = (cls) => { if (cls && foreign) for (const n of Object.keys(cls)) if (cls[n] === "외부단독이탈") cls[n] = "환율영향"; };
      fxHold(revenueClass);
      let metricClass = null;
      if ((COGS_MODE && /^(\d{4}Y|LTM) (매출원가|매출총이익)$/.test(r.item)) || (OPINC_MODE && /^(\d{4}Y|LTM) 영업이익$/.test(r.item)) || (DA_MODE && /^(\d{4}Y|LTM) 감가상각비$/.test(r.item)) || (SGA_MODE && SGA_METRIC_RE.test(r.item))) {
        const [col0, m0] = r.item.split(" ");
        const clsMatched = matched.filter((n) => clsNames.includes(n));
        metricClass = Object.fromEntries(clsNames.map((n) => [n, matched.includes(n) ? "①" : commonMode[n] ? "공통모드" : precisionNa[n] ? "NA" : causes[n]?.ok ? "②"
          : aPassed(col0, m0) && ((clsMatched.length >= 2 && clsNames.length - clsMatched.length === 1) || causes[n]?.outlier) ? "외부단독이탈"
          // 외부 정의 분해 불가(오너 결정 2026-09-27): 앱 = SEC 본표(A층 정확 일치) + 다른 외부 1곳 이상 정확 일치(공통모드 아님)인데 이 소스는
          // 해마다 다른 재분류로 식이 성립하지 않는 경우. ①·② 로 세지 않고 따로 표기. 외부 일치 0곳이면 ③(미결) 유지.
          // 기준 소스는 ② 도 인정(오너 결정 2026-09-27 — 분기마다 SEC 와 정확 일치하고 앱과의 차이 원인이 규명된 소스)
          : aPassed(col0, m0) && clsNames.some((o) => o !== n && (matched.includes(o) || causes[o]?.ok || precisionNa[o])) ? "외부정의분해불가" : aNa(col0, m0) ? "A층검증불가" : "③"]));
        reconApply(metricClass, col0, m0);
        fxHold(metricClass);
        for (const n of clsNames) if (metricClass[n] === "③") (m0 === "영업이익" ? opincErrors : m0 === "감가상각비" ? daErrors : /^(판관비|연구개발비)/.test(m0) ? sgaErrors : cogsErrors).push({ item: r.item, source: n, ours: r.ours, other: r.srcs[n].v, note: `${why(n).trim() || "분해식 없음"}${aPassed(col0, m0) ? "" : " · 앱 ≠ SEC 본표(A층 미통과)"}` });
      }
      // 그 밖 항목(희석 EPS·순이익·세전이익·EBITDA — 2026-09-30): ①·②·NA·공통모드는 원인 판정 그대로, 외부 단독 이탈은 §0(앱 = SEC(A층) + 다른
      // 외부 2곳 이상 일치 + 이 소스만 이탈) 또는 원인 규칙의 이탈 판정. 그 밖은 ③. 오류 목록(종료코드)에는 넣지 않는다(분류 표시만)
      if (!metricClass && !revenueClass && /^(\d{4}Y|LTM) (희석 EPS|순이익|세전이익|EBITDA|총차입금\(운용리스 포함\)|재무상태표 .+|현금흐름표 .+)$/.test(r.item)) {
        const [col0, ...mm] = r.item.split(" "), m0 = mm.join(" ");
        // 총차입금은 A층 전제를 SEC 본표·주석 분해 성립(debtDec.appOk)으로 본다(앱 = 본표 차입금·리스 줄 합 + 주석 항목, 1달러 안)
        const clsMatched = matched.filter((n) => clsNames.includes(n));
        // 재무상태표·현금흐름표 A층이 공통모드(앱 = SEC 값, 대체 개념 선택만 앱과 같은 목록 — GEV 제한현금 포함 현금, MCD·ORCL 보통주 배당 태그)여도 외부 1곳 이상이
        // 앱과 정확히 일치하면 독립 확인(independentOr 와 같은 원칙, 2026-10-01) — 단독 이탈 판정 전제로 인정
        const aCommonOk = (c, m) => /^(재무상태표|현금흐름표) /.test(m) && clsMatched.length >= 1 && EXACT_A[m] && checks.some((k) => k.col === c && k.status === COMMON && EXACT_A[m].test(k.name));
        const aPassed = (c, m) => (m === "총차입금(운용리스 포함)" ? !!debtDec?.appOk && c === "LTM" : aPassedOuter(c, m) || aCommonOk(c, m));
        metricClass = Object.fromEntries(clsNames.map((n) => [n, matched.includes(n) ? "①" : commonMode[n] ? "공통모드" : precisionNa[n] ? "NA" : causes[n]?.ok ? "②"
          : causes[n]?.outlier || (aPassed(col0, m0) && clsMatched.length >= 2 && clsNames.length - clsMatched.length === 1) ? "외부단독이탈"
          // 다른 외부 1곳 이상 일치(또는 원인 확인)면 외부 단독 이탈(오너 결정 2026-09-30 — 옛 "구성 미분해"와 같은 기준)
          : aPassed(col0, m0) && clsNames.some((o) => o !== n && (matched.includes(o) || causes[o]?.ok || precisionNa[o])) ? "외부단독이탈" : aNa(col0, m0) ? "A층검증불가" : "③"]));
        fxHold(metricClass);
      }
      review.push({
        ...(revenueClass ? { revenueClass } : {}),
        ...(metricClass ? { metricClass } : {}),
        item: r.item,
        ours: r.ours,
        sources: Object.fromEntries(names.map((n) => [n, r.srcs[n].v])),
        matched,
        explained,
        ...(outliers.length ? { outliers } : {}),
        ...(Object.keys(defDiffs).length ? { definitionDiffs: defDiffs } : {}),
        ...(Object.keys(appSec).length ? { appEqualsSec: appSec } : {}),
        ...(Object.keys(commonMode).length ? { commonMode } : {}),
        ...(Object.keys(precisionNa).length ? { precisionNa } : {}),
        causes: Object.fromEntries(Object.entries(causes).map(([n, c]) => [n, c.ok ?? c.outlier ?? c.common ?? c.na ?? (c.guess ? `추정: ${c.guess}` : null)])),
        // 모두 같은 값인데 독립 일치가 하나도 없으면(공통모드 소스만) "일치"가 아니라 공통모드 — 외부 전부일치 건수에 넣지 않는다
        verdict: off.length ? `${matched.length}/${names.length}곳 일치 — 불일치: ${off.join(", ")}`
          : !matched.length ? `${COMMON_LABEL} — ${Object.entries(commonMode).map(([n, w]) => `${n} ${w}`).join("; ")}`
          : `${names.length}곳 모두 일치${Object.keys(commonMode).length ? `(독립 ${matched.length}곳 · 공통모드 ${Object.keys(commonMode).join("·")})` : ""}`,
      });
    }

    for (const e of errs) { review.push({ item: "외부 소스 조회 실패", note: e }); hardErrors.push(`외부 소스 조회 실패 — ${e}`); }
  }
  // ── 공통모드 판정(오너 결정 2026-09-26) — 앱과 같은 규칙·데이터로 낸 PASS(commonModeOf)는 외부 소스가 앱 값과 정확히 같을 때만 PASS,
  //    아니면 COMMON. 외부 대조 원인 규칙의 전제(aPassed 등)는 위에서 이미 판정됐다 — 여기서는 결과 상태만 바꾼다(전제 재판정은 2단계)
  const quarterExt = (end, metric) => {
    if (!end) return [];
    const out = [];
    const yr = foreign ? null : extYq.find((x) => dayDiff(new Date(x.date).toISOString().slice(0, 10), end) <= 7);
    const yv = !yr ? null : metric === "매출" ? yr.totalRevenue : metric === "매출원가" ? yr.costOfRevenue : metric === "매출총이익" ? yr.grossProfit : metric === "영업이익" ? yr.totalOperatingIncomeAsReported : metric === "판관비" ? yr.sellingGeneralAndAdministration : metric === "연구개발비" ? yr.researchAndDevelopment : metric === "감가상각비" ? yr.reconciledDepreciation : null;
    if (yv != null) out.push(["Yahoo", yv]);
    const iq = foreign ? null : (imAnnual?.quarters ?? []).find((q) => dayDiff(q.end, end) <= 7);
    const iv = !iq ? null : metric === "매출" ? iq.rev : metric === "매출원가" ? (iq.rev != null && iq.gp != null ? iq.rev - iq.gp : null) : metric === "매출총이익" ? iq.gp : metric === "영업이익" ? iq.op : metric === "감가상각비" ? iq.da : null;
    if (iv != null) out.push(["인포맥스", iv]);
    return out;
  };
  const extExactFor = (k) => {
    const it = extItemOf(k);
    if (!it) return null;
    if (it.quarter) {
      const hit = k.app == null ? [] : quarterExt(qEndOf.get(k.col), it.metric).filter(([, v]) => extEq(k.app, v)).map(([n]) => n);
      return hit.length ? `분기 ${hit.join("·")}` : null;
    }
    const x = review.find((y) => y.item === it.item && y.sources);
    if (!x?.matched?.length || (k.app != null && !extEq(k.app, x.ours))) return null;
    return x.matched.join("·");
  };
  await applyVintage(checks, cik, hardErrors);
  // 판본 판정 불일치(decimals ≠ 옛 규칙) 행 — 리드 결정 2026-09-26(값 모양 규칙 도입 없이): 앱 값이 두 SEC 후보(옛 규칙·decimals) 중 하나이고
  // 독립 외부 소스(공통모드·외부 정밀도 부족이 아닌 matched)가 앱 값과 정확히 같으면 PASS — 회사 decimals 표기 오류(MCD 가 백만 단위 값을
  // decimals −5 로 선언)를 외부로 확인. 외부 정확 일치가 없으면 FAIL 유지. 외부 대조가 끝난 뒤라야 한다(여기)
  for (let i = 0; i < checks.length; i++) {
    const k = checks[i];
    if (k.vintage !== "disagree" || k.status !== FAIL || k.app == null || !k.vintageVals?.some((v) => extEq(k.app, v))) continue;
    const it = extItemOf(k) ?? (k.layer === "A" && /^자산총계 /.test(k.name) && /^\d{4}Y$/.test(k.col) ? { item: `${k.col} 자산총계` } : null);
    let hit = [];
    if (it?.quarter) hit = quarterExt(qEndOf.get(k.col), it.metric).filter(([, v]) => extEq(k.app, v));
    else if (it) {
      const x = review.find((y) => y.item === it.item && y.sources);
      if (x && extEq(k.app, x.ours)) hit = (x.matched ?? []).map((n) => [n, x.sources[n]]);
    }
    if (hit.length) checks[i] = { ...k, status: PASS, note: `${k.note} · 회사 decimals 표기 불일치 — 외부 독립 확인(${hit.map(([n, v]) => `${n} ${v}`).join(", ")} = 앱 ${k.app})` };
  }
  for (let i = 0; i < checks.length; i++) {
    const k = checks[i];
    if (k.status !== PASS) continue;
    const why = commonModeOf(k);
    if (!why) continue;
    let ext = extExactFor(k);
    // D형 구성 규칙 행은 외부 2곳 이상 정확 일치여야 독립(1곳이면 공통모드 유지)
    if (ext && why === COGS_RULE_COMMON && ext.replace(/^분기 /, "").split("·").length < 2) ext = null;
    checks[i] = independentOr(k, ext, why);
  }
  // 관리자 화면 감사표(--post) — 최근 사업연도 열·LTM. 이미 계산한 값만 옮긴다(scripts/metrics/audit.mjs)
  const fyLast = Object.keys(H).filter((c) => c !== "LTM").sort((a, b) => H[a].date.localeCompare(H[b].date)).at(-1);
  const auditApp = Object.fromEntries([fyLast, "LTM"].filter((c) => c && H[c]).map((c) => [c, {
    date: H[c].date, 매출: H[c].rev, 매출원가: IS[c]?.cogs ?? null, 매출총이익: IS[c]?.gp ?? null, 영업이익: IS[c]?.op ?? null, 감가상각비: IS[c]?.da ?? null, 순이익: H[c].ni, EPS: H[c].eps,
    // BPS 는 개요(verify-row)에만 있다 — 연도 열은 앱이 BPS 를 내지 않아 빈칸
    BPS: c === "LTM" ? row?.overview?.multiples?.bps ?? null : null,
    시가총액: H[c].mc, EV: H[c].ev, EBITDA: H[c].ebitda, PER: H[c].per, PBR: H[c].pbr, PSR: H[c].psr, "EV/EBITDA": H[c].evx,
  }]));
  const audit = buildAudit({ app: auditApp, cols: [fyLast, "LTM"].filter(Boolean), checks, review, closed: CLOSED_METRICS });
  const fyDates = Object.fromEntries(Object.entries(H ?? {}).filter(([, x]) => x?.date).map(([c, x]) => [c, x.date]));
  // LTM ③ 보정(2026-09-30) — LTM 열은 비교 소스(블룸버그 등)가 없어 ③ 으로 남기 쉽다. 같은 소스·같은 지표의 연간 열이 2개 이상이고 **모두**
  //  외부 단독 이탈이면(앱 = SEC 는 LTM 에서도 A층 통과) LTM 도 외부 단독 이탈 — 그 소스의 정의가 연간 내내 앱과 다르다는 근거
  for (const o of review) {
    const cls = o.metricClass;
    if (!cls || !/^LTM /.test(o.item ?? "")) continue;
    const m = o.item.slice(4);
    for (const n of Object.keys(cls)) {
      if (cls[n] !== "③") continue;
      const ann = review.filter((x) => x.metricClass?.[n] && /^\d{4}Y /.test(x.item ?? "") && x.item.slice(6) === m);
      if (ann.length >= 2 && ann.every((x) => x.metricClass[n] === "외부단독이탈")) { cls[n] = "외부단독이탈"; continue; }
      // LTM 기간 = 사업연도(결산일 ±7일 — 결산 직후, WDC FY2026 2026-07-03)이고 그 소스의 연간 칸 값·앱 값이 LTM 과 같으면 같은 칸 — 연간 판정을 따른다(2026-10-01)
      const fyc = Object.keys(fyDates).find((c) => fyDates.LTM && c !== "LTM" && dayDiff(fyDates[c], fyDates.LTM) <= 7);
      const same = fyc && review.find((x) => x.item === `${fyc} ${m}` && x.metricClass?.[n] && x.ours === o.ours && x.sources?.[n] === o.sources?.[n]);
      if (same && same.metricClass[n] !== "③") cls[n] = same.metricClass[n];
    }
  }
  // 연간 ③ 보정(2026-10-01 DAL 2021 SA 매출원가 — 다른 소스가 그 연도만 없어 비교 대상이 없음): 같은 소스·같은 지표의 다른 연간 열이 3개 이상이고 **모두**
  //  외부 단독 이탈이면 이 열도 외부 단독 이탈(그 소스 정의가 연도 내내 앱과 다르다는 근거 — LTM 보정과 같은 원칙). A층 통과 열만
  for (const o of review) {
    const cls = o.metricClass;
    if (!cls || !/^\d{4}Y /.test(o.item ?? "")) continue;
    const m = o.item.slice(6), col = o.item.slice(0, 5);
    for (const n of Object.keys(cls)) {
      if (cls[n] !== "③") continue;
      const oth = review.filter((x) => x !== o && x.metricClass?.[n] && /^\d{4}Y /.test(x.item ?? "") && x.item.slice(6) === m);
      if (oth.length >= 3 && oth.every((x) => x.metricClass[n] === "외부단독이탈") && !checks.some((k) => k.col === col && k.status === FAIL)) cls[n] = "외부단독이탈";
    }
  }
  return { sym, checks, review, hardErrors, revErrors, cogsErrors, opincErrors, daErrors, sgaErrors, audit };
}

// ── 한국 종목 1개 (kr/dart-ev.ts 단일 기준) ─────────────────────────────
// 한국은 아직 원자료(DART) 직접 대조 층이 없다 — 화면 간·항등식·기대치·LTM 기준일만.
// ── 한국 A층 — DART 원자료(fnlttSinglAcntAll, 2026-10-01) ──
// 앱과 무관하게 DART 를 직접 불러 사업연도 값을 얻는다(미국 A층이 SEC companyfacts 를 직접 읽는 것과 같은 구조). 연결(CFS) 우선,
// 없으면 별도(OFS) — 앱과 같은 순서. 판본: 사업연도 Y 값 = 가장 최근 사업보고서의 값(Y+1 보고서의 전기, 없으면 Y 보고서의 당기) —
// 앱 연간 로더 규칙(연도별 최신 보고서)과 같다. 처음 공시값(Y 보고서의 당기)도 함께 남겨 정정 공시 여부를 구분한다.
const KR_CORP = new Map(JSON.parse(readFileSync(new URL("../src/lib/markets/kr/data/corpcodes.json", import.meta.url), "utf8")).map((r) => [r.s, r.c]));
const dartCache = new Map();
// DART·KRX 디스크 캐시(오너 제안 2026-10-05) — 열쇠 = 보고서 최신 접수번호(verify-kr/dart.mjs). 상한 KR_CACHE_MAX_GB(기본 5), 90일 안 쓴 파일 삭제
// 한국 검증은 DART 원자료가 기준 — 키가 없으면 종목마다 조회 실패를 쌓지 않고 처음에 멈춘다(2026-10-05 — 운영 키와 같은 키를 막아 둔 동안)
if (MARKET === "kr" && !String(env.DART_API_KEY ?? "").trim()) die("DART 키 없음 — 검증 중단(.env.local DART_API_KEY 에 검증 전용 키를 넣을 것, 운영 키 금지)");
const KR_CACHE = MARKET === "kr" ? makeDiskCache(pathResolve(env.KR_VERIFY_CACHE_DIR || "reports/.dart-cache"), { maxBytes: Number(env.KR_CACHE_MAX_GB ?? 5) * 1024 ** 3, maxIdleDays: 90 }) : null;
if (KR_CACHE) {
  KR_CACHE.cleanup();
  configureDart({ key: env.DART_API_KEY, cache: KR_CACHE, cap: Number(env.DART_DAILY_CAP_VERIFY ?? 3000) });
  configureKrx({ key: env.KRX_API_KEY, cache: KR_CACHE });
  configureCalendar({ cache: KR_CACHE });
}
/** 사업보고서 재무제표(연결·별도) — 목록 또는 null(013). 조회 실패는 던진다(verify-kr/dart.mjs — 요청 간격 300ms 한 줄) */
async function dartFy(corp, year, fsDiv) {
  const k = `${corp}|${year}|${fsDiv}`;
  if (!dartCache.has(k)) dartCache.set(k, dartFnltt(corp, year, "11011", fsDiv));
  return dartCache.get(k);
}
const dartNum = (v) => (v == null || v === "" || v === "-" ? null : Number(String(v).replace(/,/g, "")));
/** 보고서 L(사업연도 by)의 사업연도 y 열에 손익계산서 값이 하나라도 있는가 — 당기·전기·전전기 열 */
const KR_FY_COLS = ["thstrm_amount", "frmtrm_amount", "bfefrmtrm_amount"];
const dartHasIs = (L, by, y) => {
  const f = KR_FY_COLS[by - y];
  const val = (v) => { const t = String(v ?? "").trim(); return t === "" || t === "-" ? null : Number(t.replace(/,/g, "")); };
  return !!(L && f && L.some((r) => (r.sj_div === "IS" || r.sj_div === "CIS") && Number.isFinite(val(r[f]))));
};
/**
 * 사업연도 y 의 원자료 — 연결(CFS) 보고서 Y·Y+1·Y+2 어디든 y 손익 값이 있으면 연결, 없으면 별도(OFS) 같은 규칙, 둘 다 없으면 null.
 * 해마다 따로 정한다(2026-10-04 — 연결을 2024 부터 낸 LS마린솔루션 2021 은 별도). 조회 실패는 던진다
 */
async function dartYearSource(corp, y) {
  for (const fsDiv of ["CFS", "OFS"]) {
    const [cur, next, next2] = await Promise.all([dartFy(corp, y, fsDiv), dartFy(corp, y + 1, fsDiv), dartFy(corp, y + 2, fsDiv)]);
    if ([[cur, y], [next, y + 1], [next2, y + 2]].some(([L, by]) => dartHasIs(L, by, y))) return { fsDiv, cur, next, next2 };
  }
  return null;
}
/** 최근 사업연도 — 연결 사업보고서(작년·재작년) 먼저, 없으면 별도(앱 연간 로더와 같은 순서). 없으면 null */
async function dartLatestFy(corp) {
  const cy = new Date().getFullYear();
  for (const fsDiv of ["CFS", "OFS"]) for (const y of [cy - 1, cy - 2]) if (await dartFy(corp, y, fsDiv)) return y;
  return null;
}
/** 계정 하나 — account_id 우선(보고서 구분 sj 집합 안), 없으면 계정명(공백·괄호 제거) */
function dartPick(list, sjs, ids, names, field) {
  // 우선주 줄에 단 보통주 EPS 코드는 무시(삼성SDI 2021 원자료 태그 오류)
  const rows = (list ?? []).filter((r) => sjs.includes(r.sj_div) && !(/우선주/.test(r.account_nm ?? "") && /EarningsLossPerShare/.test(r.account_id ?? "")));
  const nm = (x) => String(x ?? "").replace(/\s|\(.*?\)/g, "");
  const hit = rows.find((r) => ids.includes(r.account_id)) ?? rows.find((r) => names.includes(nm(r.account_nm)));
  return hit ? dartNum(hit[field]) : null;
}
/** 계정 후보 줄 전부 — account_id 가 맞는 줄이 있으면 그것들, 없으면 계정명(공백·괄호 제거)이 같은 줄들 */
function dartRows(list, sjs, ids, names) {
  const rows = (list ?? []).filter((r) => sjs.includes(r.sj_div) && !(/우선주/.test(r.account_nm ?? "") && /EarningsLossPerShare/.test(r.account_id ?? "")));
  const nm = (x) => String(x ?? "").replace(/\s|\(.*?\)/g, "");
  const byId = rows.filter((r) => ids.includes(r.account_id));
  return byId.length ? byId : rows.filter((r) => names.includes(nm(r.account_nm)));
}
/**
 * 사업연도 y 값 — 최신 판본(y+2 보고서 전전기 → y+1 보고서 전기 → y 보고서 당기)과 처음 공시값. 한 보고서에 같은 계정 후보가 여럿이면
 * (카카오 2023 "현금및현금성자산" 두 줄 — 본 계정·부문 표시, 둘 다 표준 코드 없음) 다른 보고서에서 한 줄로만 나온 값과 겹치는 연도 값이
 * 같은 줄 하나를 고른다. 못 고르면 null(검증불가 — 사유 ambiguous)
 */
function dartYearValue(cur, next, next2, y, sjs, ids, names) {
  const reps = [[next2, y + 2], [next, y + 1], [cur, y]];
  const COL = ["thstrm_amount", "frmtrm_amount", "bfefrmtrm_amount"];
  const valsOf = (r, by) => new Map(COL.map((c, i) => [by - i, dartNum(r[c])]).filter(([, v]) => v != null));
  const known = new Map();
  for (const [L, by] of reps) {
    const rows = dartRows(L, sjs, ids, names);
    if (rows.length === 1) for (const [yr, v] of valsOf(rows[0], by)) if (!known.has(yr)) known.set(yr, v);
  }
  let ambiguous = false;
  const pickAt = (L, by) => {
    const rows = dartRows(L, sjs, ids, names);
    if (!rows.length) return undefined;
    const col = COL[by - y];
    if (rows.length === 1) return dartNum(rows[0][col]);
    // 후보가 여럿이어도 값이 모두 같으면 그 값(손익계산서·포괄손익계산서에 같은 당기순이익 줄)
    { const vs = rows.map((r) => dartNum(r[col])); if (vs.every((v) => v != null && v === vs[0])) return vs[0]; }
    // 현금: 같은 이름 줄이 여럿이면 합계가 같은 보고서 현금흐름표 기말 현금과 정확히 같을 때 합계(카카오 2021 — 금융업 소항목 현금)
    if (ids.includes("ifrs-full_CashAndCashEquivalents")) {
      const vs = rows.map((r) => dartNum(r[col]));
      const end = (L ?? []).find((r) => r.sj_div === "CF" && (r.account_id === "dart_CashAndCashEquivalentsAtEndOfPeriodCf" || String(r.account_nm ?? "").replace(/\s/g, "") === "기말현금및현금성자산"));
      if (vs.every((v) => v != null) && end && dartNum(end[col]) === vs.reduce((a, b) => a + b, 0)) return vs.reduce((a, b) => a + b, 0);
    }
    const fit = rows.filter((r) => [...valsOf(r, by)].some(([yr, v]) => yr !== y && known.get(yr) === v && v !== 0));
    if (fit.length === 1) return dartNum(fit[0][col]);
    ambiguous = true;
    return null;
  };
  // 기준 보고서 = 그 해 값이 하나라도 실린 가장 최근 보고서(앱 연간 로더의 "연도별 주인 보고서" 규칙 — 옛 보고서와 섞으면 같은 계정이 다른 키로
  // 두 번 잡혔다). 기준 보고서에 이 계정이 없으면 빈칸(옛 보고서로 내려가지 않음)
  let latest = null;
  // 주인 보고서는 재무제표별(앱 dart-facts.ts loadAnnual 과 같은 규칙 — 재무상태표에만 전전기 열을 실은 보고서가 손익의 주인이 되지 않게, 052690
  // 2021: 2023 보고서 전전기 열엔 재무상태표만 있다)
  const stmtOk = (r) => sjs.includes(r.sj_div) || (sjs.includes("IS") && r.sj_div === "CIS") || (sjs.includes("CIS") && r.sj_div === "IS");
  for (const [L, by] of reps) {
    const col = COL[by - y];
    if (!L || !L.some((r) => stmtOk(r) && dartNum(r[col]) != null)) continue;
    latest = pickAt(L, by) ?? null;
    break;
  }
  const o = pickAt(cur, y);
  return { latest: latest ?? null, orig: o ?? null, ambiguous };
}
// [이름, 앱 위치(손익 계정명 · 재무상태표/현금흐름 accountId), 보고서 구분, account_id, 계정명 폴백]
const KR_A_ITEMS = [
  ["매출액", { is: "매출액" }, ["IS", "CIS"], ["ifrs-full_Revenue"], ["매출액", "수익매출액", "영업수익", "매출"]],
  ["영업이익", { is: "영업이익" }, ["IS", "CIS"], ["dart_OperatingIncomeLoss"], ["영업이익", "영업이익손실"]],
  ["세전이익", { is: "세전이익" }, ["IS", "CIS"], ["ifrs-full_ProfitLossBeforeTax"], ["법인세비용차감전순이익", "법인세비용차감전순이익손실"]],
  ["당기순이익(연결)", { is: "당기순이익" }, ["IS", "CIS"], ["ifrs-full_ProfitLoss"], ["당기순이익", "당기순이익손실"]],
  ["당기순이익(지배)", { is: "(지배주주 귀속)" }, ["IS", "CIS"], ["ifrs-full_ProfitLossAttributableToOwnersOfParent"], []],
  ["자산총계", { bs: "bs:자산:자산 총계" }, ["BS"], ["ifrs-full_Assets"], ["자산총계"]],
  ["유동자산", { bs: "bs:자산:유동자산 총계" }, ["BS"], ["ifrs-full_CurrentAssets"], ["유동자산"]],
  ["현금및현금성자산", { bs: "bs:자산:현금·현금성자산" }, ["BS"], ["ifrs-full_CashAndCashEquivalents"], ["현금및현금성자산"]],
  ["부채총계", { bs: "bs:부채:부채 총계" }, ["BS"], ["ifrs-full_Liabilities"], ["부채총계"]],
  ["유동부채", { bs: "bs:부채:유동부채 총계" }, ["BS"], ["ifrs-full_CurrentLiabilities"], ["유동부채"]],
  ["자본총계", { bs: "bs:자본:자본 총계" }, ["BS"], ["ifrs-full_Equity"], ["자본총계"]],
  ["지배주주 지분", { bs: "bs:note:지배주주 지분" }, ["BS"], ["ifrs-full_EquityAttributableToOwnersOfParent"], ["지배기업의소유주에게귀속되는자본", "지배기업소유주지분"]],
  ["비지배지분", { bs: "bs:note:비지배지분" }, ["BS"], ["ifrs-full_NoncontrollingInterests"], ["비지배지분"]],
  ["영업활동 현금흐름", { cf: "cf:total:영업활동 현금흐름" }, ["CF"], ["ifrs-full_CashFlowsFromUsedInOperatingActivities"], ["영업활동현금흐름", "영업활동으로인한현금흐름"]],
  ["투자활동 현금흐름", { cf: "cf:total:투자활동 현금흐름" }, ["CF"], ["ifrs-full_CashFlowsFromUsedInInvestingActivities"], ["투자활동현금흐름", "투자활동으로인한현금흐름"]],
  ["재무활동 현금흐름", { cf: "cf:total:재무활동 현금흐름" }, ["CF"], ["ifrs-full_CashFlowsFromUsedInFinancingActivities"], ["재무활동현금흐름", "재무활동으로인한현금흐름"]],
];

/**
 * 한국 A층 대조 — vsSource 와 같되 **앱에만 값이 있으면 실패**(감사 1차 ⑧ — 060370 2021 별도 재무제표 해의 "(지배주주 귀속)" 행이 연결 순이익을
 * 복사한 값이었는데 원자료 없음 = 검증불가로 지나갔다). 승인·표시된 규칙으로 앱만 값을 내는 경우는 없다(있으면 여기 사유와 함께 추가)
 */
function vsDart(app, src, srcNote = "") {
  if (src == null && app != null) return { status: FAIL, app, src: null, note: `원자료(DART) 없음인데 앱 값 ${app}${srcNote ? ` · ${srcNote}` : ""}` };
  return vsSource(app, src, 0, srcNote);
}

async function verifyKr(sym) {
  const u = `/api/markets/kr/${encodeURIComponent(sym)}`;
  const checks = [];
  const add = (layer, name, col, r) => checks.push({ layer, name, col, ...r });
  const fetched = {};
  for (const [k, p] of Object.entries({
    hl: `${u}/highlights`, an: `${u}/financials?view=analysis`, tt: `${u}/ttm`,
    cs: `${u}/consensus`, bs: `${u}/financials?view=bs&period=annual`, is: `${u}/financials?view=is&period=annual`,
    cf: `${u}/financials?view=cf&period=annual`,
    isq: `${u}/financials?view=is&period=quarter`, bsq: `${u}/financials?view=bs&period=quarter`, cfq: `${u}/financials?view=cf&period=quarter`,
    sm: `${u}/financials?view=summary&period=annual`, smq: `${u}/financials?view=summary&period=quarter`,
  })) {
    try { fetched[k] = await getJson(p); } catch (e) { fetched[k] = null; add("응답", `API 응답 ${k}`, "-", { status: FAIL, note: String(e).slice(0, 120) }); }
  }
  let row = null;
  try { row = await getJson(`/api/cron/verify-row?market=kr&symbol=${encodeURIComponent(sym)}`, 240_000, AUTH); }
  catch (e) { add("응답", "API 응답 verify-row", "-", { status: FAIL, note: String(e).slice(0, 120) }); }
  const { hl, an, tt, cs, bs, is, cf, isq, bsq, cfq, sm, smq } = fetched;
  const h = hl?.highlights;
  if (!h) return { sym, error: "하이라이트 없음", checks, review: [] };
  const fyCols = h.columns.filter((c) => c.kind === "fy");
  const hardErrors0 = [];
  // 기대 연도 열 = 앱 표시 범위(최근 사업연도 포함 5개 해) 중 DART 에 그 해 손익계산서 값이 있는 해 — 그해 보고서 당기, 다음 해 보고서 전기,
  // 다다음 해 보고서 전전기 어디든(연결 먼저, 없으면 별도 — 해마다). 사업보고서 목록 기준(2026-10-04 앞 판)은 2024 상장 산일전기(062040)의
  // 2024 보고서 전기 열 FY2023 을 "보고서 없는 열"로 오판했다. 검사기 자체 DART 조회로 정하고(앱 출력 아님), 조회 실패는 실패 + 오류
  {
    const corp = KR_CORP.get(sym);
    const shown = fyCols.map((c) => Number(String(c.label).slice(0, 4))).filter(Number.isFinite);
    if (!fyCols.length) add("B", "연도 열 존재", "-", { status: FAIL, note: "하이라이트 연도 열 0개" });
    if (!corp) add("B", "연도 열 = DART 손익 자료 연도", "-", { status: FAIL, note: "corpcodes.json 에 종목코드 없음" });
    else {
      try {
        const last = await dartLatestFy(corp);
        if (last == null) add("B", "연도 열 = DART 손익 자료 연도", "-", { status: FAIL, note: "DART 사업보고서 없음(최근 2개 연도, 연결·별도)" });
        else {
          const exp = [], ofs = [];
          for (let y = last - 4; y <= last; y++) {
            const src = await dartYearSource(corp, y);
            if (src) { exp.push(y); if (src.fsDiv === "OFS") ofs.push(y); }
          }
          const missing = exp.filter((y) => !shown.includes(y)), extra = shown.filter((y) => !exp.includes(y));
          const sep = ofs.length ? ` · 별도 재무제표 ${ofs.join("·")}` : "";
          add("B", "연도 열 = DART 손익 자료 연도", "-", missing.length || extra.length
            ? { status: FAIL, note: `기대 ${exp.join("·")}${sep} / 앱 ${shown.join("·")}${missing.length ? ` — 빠짐 ${missing.join("·")}` : ""}${extra.length ? ` — DART 손익 자료 없는 열 ${extra.join("·")}` : ""}` }
            : { status: PASS, note: `${exp.length}개 연도(${exp.join("·")})${sep}` });
          // 별도로 채운 해는 화면 주석이 있어야 한다(조용한 대체 금지)
          if (ofs.length && fyCols.length) {
            const fsSrc = await dartFy(corp, last, "CFS");
            const allOfs = !fsSrc;
            if (!allOfs) {
              const note = (h.notes ?? []).find((n) => /연결 재무제표 없음 → 별도/.test(n)) ?? "";
              const noted = ofs.filter((y) => shown.includes(y) && note.includes(`FY${y}`));
              const lack = ofs.filter((y) => shown.includes(y) && !noted.includes(y));
              add("B", "별도 재무제표 해 주석", "-", lack.length ? { status: FAIL, note: `별도로 채운 ${lack.join("·")} 주석 없음` } : { status: PASS, note: note || "해당 없음" });
            }
          }
        }
      } catch (e) {
        add("응답", "DART 원자료(연도 열 기대치)", "-", { status: FAIL, note: String(e).slice(0, 120) });
        hardErrors0.push(`DART 조회 실패(연도 열 기대치): ${String(e).slice(0, 80)}`);
      }
    }
  }

  const H = {};
  h.columns.forEach((c, i) => {
    if (c.kind === "estimate") return;
    const lab = c.kind === "ltm" ? "LTM" : c.label;
    const r = (k) => h.rows.find((x) => x.key === k)?.values[i] ?? null;
    const v = (k) => h.valuationRows.find((x) => x.key === k)?.values[i] ?? null;
    H[lab] = { date: c.date, mc: r("mktcap"), pref: r("pref_mcap"), cash: r("cash"), debt: r("debt"), nci: r("nci"), ev: r("ev"), ebitda: r("ebitda"), ni: r("ni"), eps: r("eps"), per: v("per"), pbr: v("pbr"), psr: v("psr"), evx: v("ev_ebitda") };
  });
  const rowOf = (stmt, name) => stmt?.sections?.flatMap((s) => s.items ?? []).find((x) => x.accountName === name)?.values ?? {};
  const lab = (k) => (k === "현재/LTM" ? "LTM" : k);
  const A = {};
  for (const [name, key] of [["EV/EBITDA", "evx"], ["PER", "per"], ["PBR", "pbr"], ["PSR", "psr"]])
    for (const [k, v] of Object.entries(rowOf(an, name))) (A[lab(k)] ??= {})[key] = v;
  const C = {};
  for (const r of cs?.rows ?? []) if (!r.isEstimate) C[`${r.fy}Y`] = r;
  const cActual = (cs?.rows ?? []).filter((r) => !r.isEstimate);
  if (cs && !cActual.length) add("C", "컨센서스 실적 행 존재", "-", { status: FAIL, note: "컨센서스 응답에 실적 연도 행이 0개" });
  const cMin = cActual.length ? Math.min(...cActual.map((r) => r.fy)) : Infinity;
  // 손익계산서(연간 라벨 "FY2025" → "2025Y") — 순이익·EPS 화면 간 대조(재감사: 한국은 순이익·EPS 검사가 없었음)
  const IS = {};
  for (const [name, key] of [["당기순이익", "ni"], ["희석 EPS", "eps"], ["매출액", "rev"], ["영업이익", "op"], ["EBITDA", "ebitda"], ["감가상각비·무형자산상각비", "da"], ["감가·무형상각비", "da"]])
    // 감가상각 행 이름은 모바일 한 줄 표시로 "감가·무형상각비"로 줄였다(2026-10-02) — 옛 이름도 인식(배포 시점 차이)
    for (const [k, v] of Object.entries(rowOf(is, name))) (IS[k.replace(/^FY(\d{4})$/, "$1Y")] ??= {})[key] ??= v;
  // 지배주주 귀속 순이익 행 — FnGuide 당기순이익(지배)와 같은 정의(하이라이트 순이익은 연결·비지배 포함)
  // 정확 일치 — 부분일치는 "(비지배주주 귀속)" 에도 걸린다(감사 3차)
  const parentRow = is?.sections?.flatMap((s) => s.items ?? []).find((x) => x.accountName?.trim() === "(지배주주 귀속)");
  for (const [k, v] of Object.entries(parentRow?.values ?? {})) (IS[k.replace(/^FY(\d{4})$/, "$1Y")] ??= {}).niParent = v;
  const hardErrors = [...hardErrors0];
  for (const [k, v] of Object.entries({ ...fetched, "verify-row": row })) for (const w of appFetchWarnings(v)) hardErrors.push(`앱 조회 실패 경고(${k}): ${w}`);
  const BS = {};
  for (const [name, key] of [["총차입금", "debt"], ["순차입금", "nd"]])
    for (const [k, v] of Object.entries(rowOf(bs, name))) (BS[k.replace(/^FY(\d{4})$/, "$1Y")] ??= {})[key] = v;

  // ── A. DART 원자료 대조(사업연도 열, 허용 오차 없음 — 원 단위 정수) ──
  /** 항목별 DART 처음 공시·최신 판본 — F층 원인 확인(외부 = 처음 공시, 앱 = 최신 재작성)에 쓴다 */
  const dartVint = {};
  {
    const corp = KR_CORP.get(sym);
    const itemsOf = (st) => (st?.sections ?? []).flatMap((x) => x.items ?? []);
    const isByName = (name, k) => itemsOf(is).find((x) => x.accountName?.trim() === name)?.values?.[k] ?? null;
    const byId = (st, id, k) => itemsOf(st).find((x) => x.accountId === id)?.values?.[k] ?? null;
    if (!corp) add("A", "DART 고유번호", "-", { status: FAIL, note: "corpcodes.json 에 종목코드 없음" });
    else {
      const years = (is?.periods ?? []).map((p0) => p0.label).filter((l) => /^FY\d{4}$/.test(l)).map((l) => Number(l.slice(2)));
      for (const y of years) {
        const k = `FY${y}`, col = `${y}Y`;
        let cur, next, next2, fsDiv = "CFS";
        try {
          // 연결 보고서(그해·다음 해·다다음 해) 어디에든 그해 손익 값이 있으면 연결(금융지주는 2021·2022 보고서에 연결 XBRL 이 없고 2023
          // 보고서 전기·전전기에 있다 — 앱도 그 값을 쓴다), 없으면 별도 — 해마다(dartYearSource). 조회 실패는 "없음"으로 넘기지 않고
          // 오류(예전엔 SK 2025 보고서 조회 실패가 판본 차이로 보였다)
          const src = await dartYearSource(corp, y);
          if (src) ({ cur, next, next2, fsDiv } = src);
        } catch (e) {
          add("A", "DART 원자료 조회", col, { status: FAIL, note: String(e).slice(0, 120) });
          hardErrors.push(`DART 조회 실패 ${col}: ${String(e).slice(0, 80)}`);
          continue;
        }
        if (!cur && !next && !next2) { add("A", "DART 손익 자료 존재", col, { status: FAIL, note: "앱에 연도 열이 있는데 DART 보고서(Y·Y+1·Y+2, 연결·별도)에 그해 손익 값 없음" }); continue; }
        for (const [name, loc, sjs, ids, names] of KR_A_ITEMS) {
          const app = loc.is ? isByName(loc.is, k) : loc.bs ? byId(bs, loc.bs, k) : byId(cf, loc.cf, k);
          // 최신 판본 = Y+2 보고서 전전기 → Y+1 보고서 전기 → Y 보고서 당기(앱 규칙 "연도별 가장 최신 보고서" — 현대차 2021 매출은
          // 2023 보고서 전전기에서 재작성 116.45조, 2022 보고서 전기는 117.61조)
          const yv = dartYearValue(cur, next, next2, y, sjs, ids, names);
          const orig = yv.orig;
          let latest = yv.latest, rule = "";
          // 승인된 규칙(2026-09-28, 앱 dart-income.ts — 칸 주석 표시): 연결 재무제표인데 DART 가 지배주주 귀속 줄을 생략했고, 같은 보고서에 비지배지분
          // 순이익 줄 값도 없고 재무상태표 비지배지분도 없거나 0 이면 지배 = 당기순이익. 검증기가 DART 원자료로 조건을 따로 확인한다(앱 주석을 믿지 않음)
          if (name === "당기순이익(지배)" && latest == null && fsDiv === "CFS") {
            const own = [[next2, "bfefrmtrm_amount"], [next, "frmtrm_amount"], [cur, "thstrm_amount"]].find(([L0, f]) => L0 && L0.some((r0) => dartNum(r0[f]) != null));
            if (own) {
              const [L0, f] = own;
              const isNci = dartRows(L0, ["IS", "CIS"], ["ifrs-full_ProfitLossAttributableToNonControllingInterests", "ifrs-full_ProfitLossAttributableToNoncontrollingInterests"], ["비지배지분"]).map((r0) => dartNum(r0[f])).filter((v0) => v0 != null);
              const bsNci = dartRows(L0, ["BS"], ["ifrs-full_NoncontrollingInterests"], ["비지배지분"]).map((r0) => dartNum(r0[f])).filter((v0) => v0 != null && v0 !== 0);
              if (!isNci.length && !bsNci.length) {
                latest = dartYearValue(cur, next, next2, y, ["IS", "CIS"], ["ifrs-full_ProfitLoss"], ["당기순이익", "당기순이익손실"]).latest;
                rule = "DART 지배주주 귀속 줄 생략 · 비지배지분 순이익·재무상태표 비지배지분 없음(검증기 확인) → 지배 = 당기순이익(승인 규칙)";
              }
            }
          }
          // 승인된 규칙(앱 dart-income.ts — 칸 주석 "손익계산서에 당기순이익 줄 없음 — 지배주주 귀속 + 비지배지분 귀속"): DART 에 당기순이익 줄이 없고
          // 지배·비지배 귀속 줄이 둘 다 있으면 합(103590 2021·2022). 검증기가 DART 줄로 따로 계산
          if (name === "당기순이익(연결)" && latest == null) {
            const p0 = dartYearValue(cur, next, next2, y, ["IS", "CIS"], ["ifrs-full_ProfitLossAttributableToOwnersOfParent"], []).latest;
            const n0 = dartYearValue(cur, next, next2, y, ["IS", "CIS"], ["ifrs-full_ProfitLossAttributableToNonControllingInterests", "ifrs-full_ProfitLossAttributableToNoncontrollingInterests"], []).latest;
            const b0 = dartYearValue(cur, next, next2, y, ["BS"], ["ifrs-full_NoncontrollingInterests"], ["비지배지분"]).latest;
            if (p0 != null && n0 != null) { latest = p0 + n0; rule = `DART 당기순이익 줄 없음 → 지배 ${p0} + 비지배 ${n0}(승인 규칙)`; }
            else if (p0 != null && n0 == null && (b0 == null || b0 === 0)) { latest = p0; rule = `DART 당기순이익 줄 없음 · 비지배지분 없음 → 지배 ${p0}(승인 규칙)`; }
          }
          const r = vsDart(app, latest, [fsDiv === "OFS" ? "별도 재무제표" : "", yv.ambiguous ? "같은 이름 줄이 여럿 — 값 연속성으로 못 고름" : "", rule].filter(Boolean).join(" · "));
          if (r.status === FAIL && app != null && orig != null && app === orig && latest !== orig)
            r.note = `앱 = 처음 공시 ${orig} · 최신 보고서 값 ${latest} — 앱이 재작성 값을 안 씀`;
          else if (r.status === PASS && orig != null && latest !== orig) r.note = `최신 보고서의 재작성 값 — 처음 공시 ${orig}`;
          add("A", `${name} = DART`, col, r);
          const vAll = [[cur, y, "thstrm_amount"], [next, y + 1, "frmtrm_amount"], [next2, y + 2, "bfefrmtrm_amount"]]
            .map(([L, by, f]) => { const rs = L ? dartRows(L, sjs, ids, names) : []; return rs.length === 1 ? { by, v: dartNum(rs[0][f]) } : null; })
            .filter((x) => x && x.v != null);
          dartVint[`${col}|${name}`] = { orig, latest, app, pass: r.status === PASS, vAll };
        }
        // EPS(기본·희석) — 전체 EPS 줄(표준 ID 또는 "보통주 기본주당이익" 같은 이름 — 현대차는 표준 코드 없음). 전체 EPS 를 공시하지
        // 않았으면 계속영업 + 중단영업 주당이익(같은 기준끼리, NAVER 2021) — 앱 코드와 무관하게 DART 값만으로 계산.
        // 희석 EPS 미공시(희석 증권 없음)면 앱 희석 EPS 는 기본 EPS 와 같아야 한다
        const epsOf = (L, f, kind) => {
          if (!L) return null;
          const T = kind === "d" ? [["ifrs-full_DilutedEarningsLossPerShare"], ["희석주당이익", "희석주당순이익", "보통주희석주당이익", "희석주당이익손실", "보통주기본및희석주당이익", "보통주기본및희석주당순이익", "기본및희석주당이익"]]
            : [["ifrs-full_BasicEarningsLossPerShare"], ["기본주당이익", "기본주당순이익", "보통주기본주당이익", "기본주당이익손실", "기본및희석주당이익", "보통주기본및희석주당이익", "보통주기본및희석주당순이익"]];
          const tot = dartPick(L, ["IS", "CIS"], ...T, f);
          if (tot != null) return { v: tot, how: "" };
          // 기본·희석 합친 줄(LG "보통주 기본/희석주당순이익") — 하나거나 값이 같으면 그 값, 둘이 다르면 차이가 그 해 중단영업손익과 부호가 같은 쪽
          { const nm = (x) => String(x ?? "").replace(/\s|\(.*?\)/g, "");
            const CMB = ["보통주기본/희석주당순이익", "기본/희석주당순이익", "보통주기본/희석주당이익", "기본/희석주당이익"];
            const vs = L.filter((r) => ["IS", "CIS"].includes(r.sj_div) && CMB.includes(nm(r.account_nm))).map((r) => dartNum(r[f])).filter((v) => v != null);
            if (vs.length === 1 || (vs.length === 2 && vs[0] === vs[1])) return { v: vs[0], how: "기본·희석 합친 줄" };
            if (vs.length === 2) {
              const disc = dartPick(L, ["IS", "CIS"], ["ifrs-full_ProfitLossFromDiscontinuedOperations"], [], f);
              if (disc) return { v: Math.sign(vs[0] - vs[1]) === Math.sign(disc) ? vs[0] : vs[1], how: `기본·희석 합친 줄 둘(전체·계속영업) — 차이 부호 = 중단영업손익 ${disc}` };
            } }
          const pre = kind === "d" ? "Diluted" : "Basic";
          const c = dartPick(L, ["IS", "CIS"], [`ifrs-full_${pre}EarningsLossPerShareFromContinuingOperations`], [], f);
          if (c == null) return null;
          const d = dartPick(L, ["IS", "CIS"], [`ifrs-full_${pre}EarningsLossPerShareFromDiscontinuedOperations`], [], f) ?? 0;
          return { v: c + d, how: `전체 EPS 미공시 — 계속영업 ${c} + 중단영업 ${d}` };
        };
        // 기준 보고서 = 그 해 값이 실린 가장 최근 보고서(dartYearValue 와 같은 규칙)
        const ownerOf = () => { for (const [L, f] of [[next2, "bfefrmtrm_amount"], [next, "frmtrm_amount"], [cur, "thstrm_amount"]]) if (L && L.some((r) => (r.sj_div === "IS" || r.sj_div === "CIS") && dartNum(r[f]) != null)) return [L, f]; return [null, null]; };
        const latestEps = (kind) => { const [L, f] = ownerOf(); return L ? epsOf(L, f, kind) : null; };
        const bE = latestEps("b"), dE = latestEps("d");
        add("A", "기본 EPS = DART", col, vsDart(isByName("기본 EPS", k), bE?.v ?? null, bE?.how ?? ""));
        { const rr = vsSource(isByName("희석 EPS", k), (dE ?? bE)?.v ?? null, 0); dartVint[`${col}|희석 EPS`] = { app: rr.app, latest: rr.src, pass: rr.status === PASS, vAll: [] }; }
        add("A", "희석 EPS = DART", col, vsDart(isByName("희석 EPS", k), (dE ?? bE)?.v ?? null, dE ? dE.how : bE ? `DART 희석 EPS 미공시 — 기본 EPS 와 대조${bE.how ? " · " + bE.how : ""}` : ""));
      }
    }
  }

  // ── 원자료 층 K1~K5(감사 1차 2026-10-05) — KRX·DART 를 검증기가 직접(verify-kr/layers.mjs)
  {
    const corp = KR_CORP.get(sym);
    if (corp) await krOriginalLayers({
      sym, corp, env, h, H, IS, tt, add, hardErrors, dartYearSource, same,
      consts: { PASS, FAIL, NA, COMMON },
      // 분기 재무제표 화면 A층(감사 2차 ②) — 분기 열마다 DART 와 정확 대조
      quarter: { isq, bsq, cfq }, items: KR_A_ITEMS,
      yahooBars: async (s) => {
        const y = await yahoo();
        for (const suf of [".KS", ".KQ"]) {
          let r;
          // 코스닥 종목은 .KS 가 "No data found" 로 던진다 — 그때만 다음 접미사(다른 오류는 그대로 던짐)
          try { r = await y.chart(s + suf, { period1: new Date(Date.now() - 20 * 864e5), interval: "1d" }, { validateResult: false }); }
          catch (e) { if (/No data found/i.test(String(e?.message ?? e))) continue; throw e; }
          const q = (r?.quotes ?? []).filter((b) => b.close != null).map((b) => ({ date: new Date(new Date(b.date).getTime() + 9 * 3600e3).toISOString().slice(0, 10), close: b.close }));
          if (q.length) return q;
        }
        throw new Error("Yahoo 일봉 없음(.KS·.KQ)");
      },
    });
  }

  // LTM 기준일 — 손익 TTM 이 분기까지 왔는데 재무상태표 스냅샷이 연말값이면 현금·차입금·자본이 낡았다
  const t = tt?.ttm;
  if (t?.snapshot) {
    // 손익 TTM 이 분기까지 왔으면 스냅샷 라벨은 정확히 그 분기("2026 Q2")여야 한다 —
    // 연말값 폴백("FY2025 (… 연말값)")·일부 항목 폴백 라벨은 실패로 둔다.
    const fq = (t.periodLabel ?? "").match(/\+\s*(\d{4})\s*(1분기|반기|3분기)/);
    const want = fq ? `${fq[1]} Q${{ "1분기": 1, 반기: 2, "3분기": 3 }[fq[2]]}` : null;
    const ok = want ? t.snapshot.label === want : /^FY\d{4}$/.test(t.snapshot.label ?? "");
    add("B", "LTM 재무상태표 기준일 = 손익 TTM 기준 분기", "LTM", ok
      ? { status: PASS, note: `손익 ${t.periodLabel} / 재무상태표 ${t.snapshot.label}` }
      : { status: FAIL, note: `손익 ${t.periodLabel} / 재무상태표 ${t.snapshot.label}${want ? ` (기대 ${want})` : ""}` });
  } else add("B", "LTM 스냅샷 존재", "LTM", { status: FAIL, note: "ttm.snapshot 없음" });

  for (const [c, x] of Object.entries(H)) {
    if (c !== "LTM") {
      add("C", "순이익 하이라이트=손익계산서", c, same(IS[c]?.ni ?? null, x.ni));
      add("C", "EPS 하이라이트=손익계산서", c, same(IS[c]?.eps ?? null, x.eps));
      add("C", "차입금 하이라이트=대차대조표 주석", c, same(BS[c]?.debt ?? null, x.debt));
      add("C", "순차입금 하이라이트=대차대조표 주석", c, same(BS[c]?.nd ?? null, x.debt == null ? null : x.debt + (x.cash ?? 0)));
      // EBITDA = 영업이익 + 감가상각비·무형자산상각비(손익계산서 주석)
      { const e = IS[c]?.ebitda ?? null, o = IS[c]?.op ?? null, d = IS[c]?.da ?? null;
        if (e != null || (o != null && d != null))
          add("D", "EBITDA = 영업이익 + 감가상각비(손익계산서)", c, e == null ? { status: FAIL, note: `영업이익 ${o}·감가상각비 ${d} 있는데 EBITDA 빈칸` }
            : o == null || d == null ? { status: FAIL, note: `EBITDA ${e} 있는데 구성요소 빈칸(영업이익 ${o}·감가상각비 ${d})` }
            : same(e, o + d)); }
      if (!C[c]) { if (Number(c.slice(0, 4)) >= cMin || !cs) add("C", "컨센서스 연도 존재", c, cs ? { status: FAIL, note: "컨센서스 범위 안인데 이 연도 행 없음" } : { status: NA, note: "컨센서스 응답 없음" }); }
      else {
        add("C", "EV/EBITDA 컨센서스=하이라이트", c, same(C[c].evEbitda ?? null, x.evx));
        add("C", "PER 컨센서스=하이라이트", c, same(C[c].per ?? null, x.per));
        add("C", "PBR 컨센서스=하이라이트", c, same(C[c].pbr ?? null, x.pbr));
      }
    }
    add("C", "EV/EBITDA 하이라이트=재무분석", c, same(A[c]?.evx ?? null, x.evx));
    add("C", "PER 하이라이트=재무분석", c, same(A[c]?.per ?? null, x.per));
    add("C", "PBR 하이라이트=재무분석", c, same(A[c]?.pbr ?? null, x.pbr));
    add("C", "PSR 하이라이트=재무분석", c, same(A[c]?.psr ?? null, x.psr));
    if (x.mc == null) add("D", "시가총액 존재", c, { status: NA, note: "시가총액 없음(상장 전 등) — 배수·EV 기대치 생략" });
    if (x.eps != null && x.mc != null) {
      if (x.eps <= 0) add("D", "PER 부호 규칙(분모 ≤ 0 → 빈칸)", c, x.per == null ? { status: PASS } : { status: FAIL, note: `EPS ${x.eps} 인데 PER ${x.per}` });
      else add("D", "PER 기대치(분모 > 0 → 값 있음)", c, x.per != null ? { status: PASS } : { status: FAIL, note: `EPS ${x.eps} 인데 PER 빈칸` });
    }
    // EV 기대치(공란 여부)는 K2 층이 검증기 자체 판정(금융업·금융 자회사·리스 확인 불가·KRX)으로 정한다 — 앱 주석 문구를 근거로 쓰지 않는다(감사 1차 ⑤)
    if (x.mc != null) {
      if (x.ev != null) {
        const sum = (x.mc ?? 0) + (x.pref ?? 0) + (x.debt ?? 0) + (x.nci ?? 0) + (x.cash ?? 0);
        add("D", "EV = 보통주+우선주 시총+차입금+NCI−현금", c, same(x.ev, sum));
        if (x.ebitda != null && x.ebitda > 0) add("D", "EV/EBITDA = EV÷EBITDA", c, same(x.evx, x.ev / x.ebitda));
        if (x.ebitda != null && x.ebitda <= 0) add("D", "EV/EBITDA 부호 규칙", c, x.evx == null ? { status: PASS } : { status: FAIL, note: `EBITDA ${x.ebitda} 인데 ${x.evx}` });
      }
    }
  }
  // ── C층 화면 간 일치(한국, 2026-10-02 — 미국과 같은 검사): 분기 열 · 총괄 = 각 재무제표(연간·분기) · 하이라이트 LTM = 최근 4개 분기 합(손익)·
  //    최근 분기 재무상태표(총차입금·비지배지분)
  if (isq && bsq && cfq && sm && smq) {
    const itemsK = (st) => (st?.sections ?? []).flatMap((x) => x.items ?? []);
    const rid = (st) => Object.fromEntries(itemsK(st).map((it) => [it.accountId, it.values ?? {}]));
    const rnm = (st) => { const o = {}; for (const it of itemsK(st)) { const k0 = String(it.accountName ?? "").trim(); if (!(k0 in o)) o[k0] = it.values ?? {}; } return o; };
    const qcols = (st) => (st?.periods ?? []).map((p0) => `${p0.label}@${p0.endDate}`).join(",");
    const qI = qcols(isq);
    for (const [nm, st] of [["재무상태표", bsq], ["현금흐름표", cfq], ["총괄", smq]])
      add("C", `분기 화면 열 손익계산서 = ${nm}`, "-", qI === qcols(st) ? { status: PASS, note: qI } : { status: FAIL, note: `${qI} ≠ ${qcols(st)}` });
    const eqv = (nm, col, a, b0) => { if (a == null && b0 == null) return; add("C", nm, col, same(a, b0)); };
    for (const [S0, I0, B0, C0, per] of [[rid(sm), rnm(is), rid(bs), rid(cf), is?.periods], [rid(smq), rnm(isq), rid(bsq), rid(cfq), isq?.periods]]) for (const p0 of per ?? []) {
      const k0 = p0.label, c0 = k0.replace(/^FY(\d{4})$/, "$1Y");
      eqv("총괄 매출 = 손익계산서", c0, S0["sum:is:rev"]?.[k0], I0["매출액"]?.[k0]);
      eqv("총괄 영업이익 = 손익계산서", c0, S0["sum:is:op"]?.[k0], I0["영업이익"]?.[k0]);
      eqv("총괄 순이익 = 손익계산서", c0, S0["sum:is:ni"]?.[k0], I0["당기순이익"]?.[k0]);
      eqv("총괄 자산 = 재무상태표", c0, S0["sum:bs:자산"]?.[k0], B0["bs:자산:자산 총계"]?.[k0]);
      eqv("총괄 부채 = 재무상태표", c0, S0["sum:bs:부채"]?.[k0], B0["bs:부채:부채 총계"]?.[k0]);
      eqv("총괄 자본 = 재무상태표", c0, S0["sum:bs:자본"]?.[k0], B0["bs:자본:자본 총계"]?.[k0]);
      eqv("총괄 영업현금흐름 = 현금흐름표", c0, S0["sum:cf:영업활동으로 인한 현금흐름"]?.[k0], C0["cf:total:영업활동 현금흐름"]?.[k0]);
      eqv("총괄 투자현금흐름 = 현금흐름표", c0, S0["sum:cf:투자활동으로 인한 현금흐름"]?.[k0], C0["cf:total:투자활동 현금흐름"]?.[k0]);
      eqv("총괄 재무현금흐름 = 현금흐름표", c0, S0["sum:cf:재무활동으로 인한 현금흐름"]?.[k0], C0["cf:total:재무활동 현금흐름"]?.[k0]);
    }
    // 하이라이트 LTM — 손익 TTM 기준 분기(ttm.periodLabel "… + 2026 반기 − 2025 반기")가 분기 화면 마지막 열과 같을 때만
    const LH = H.LTM, IQn = rnm(isq), BQi = rid(bsq);
    const ql = (isq.periods ?? []).map((p0) => p0.label), l4 = ql.slice(-4), lq = ql.at(-1);
    const fq = (tt?.ttm?.periodLabel ?? "").match(/\+\s*(\d{4})\s*(1분기|반기|3분기)/);
    // 손익 TTM 이 사업연도("FY2025" — 사업보고서 뒤 1분기 보고서 전, 감사 3차)면 그해 4분기까지의 네 분기
    const fy0 = (tt?.ttm?.periodLabel ?? "").match(/^FY(\d{4})$/);
    const want = fq ? `${fq[1]} Q${{ "1분기": 1, 반기: 2, "3분기": 3 }[fq[2]]}` : fy0 ? `${fy0[1]} Q4` : null;
    if (LH && l4.length === 4 && want && lq === want) {
      const s4 = (nm) => { const xs = l4.map((k0) => IQn[nm]?.[k0]); return xs.every((v0) => v0 != null) ? xs.reduce((a0, b1) => a0 + b1, 0) : null; };
      const hRow = (key) => { const i0 = h.columns.findIndex((c) => c.kind === "ltm"); return h.rows.find((r1) => r1.key === key)?.values[i0] ?? null; };
      eqv("하이라이트 LTM 매출 = 분기 최근 4개 합", "LTM", hRow("revenue"), s4("매출액"));
      eqv("하이라이트 LTM 영업이익 = 분기 최근 4개 합", "LTM", hRow("opinc"), s4("영업이익"));
      eqv("하이라이트 LTM 순이익 = 분기 최근 4개 합", "LTM", LH.ni, s4("당기순이익"));
      eqv("하이라이트 LTM 총차입금 = 최근 분기 재무상태표", "LTM", LH.debt, BQi["bs:note:총차입금"]?.[lq]);
      // 하이라이트는 비지배지분이 전 열 0(또는 없음)이면 줄을 숨긴다 — 숨긴 줄은 0 으로 읽는다. 재무상태표 값이 0 이 아니면 그대로 실패(2026-10-02)
      const nciHidden = !h.rows.some((x) => x.key === "nci");
      const bNci = BQi["bs:note:비지배지분"]?.[lq];
      eqv("하이라이트 LTM 비지배지분 = 최근 분기 재무상태표", "LTM", LH.nci ?? (nciHidden && bNci != null ? 0 : null), bNci);
    } else if (LH) add("C", "하이라이트 LTM = 분기 화면", "LTM", { status: NA, note: `손익 TTM 기준 분기 ${want ?? "없음"} · 분기 화면 마지막 열 ${lq ?? "없음"}` });
  }

  const L = H.LTM;
  // LTM 열 기대치(감사 2차 ①) — 하이라이트 LTM 열이 없는 경우는 K1 「LTM 열 존재」가 실패로 남긴다. 재무분석·개요·유니버스 LTM 도 있어야 한다
  if (L && !A.LTM) add("C", "재무분석 LTM 열 존재", "LTM", { status: FAIL, note: "하이라이트 LTM 열이 있는데 재무분석 LTM 열 없음" });
  if (row && !L) add("C", "개요·유니버스 = 하이라이트 LTM", "LTM", { status: FAIL, note: "하이라이트 LTM 열 없음 — 개요·유니버스 대조 불가" });
  if (row && L) {
    const m = row.overview?.multiples ?? null, uv = row.universe ?? null;
    if (!m) add("C", "개요 멀티플 계산됨", "LTM", { status: FAIL, note: `개요 멀티플 없음 ${JSON.stringify(row.overview?.warnings ?? [])}` });
    else {
      add("C", "시가총액 개요=하이라이트", "LTM", same(m.marketCap, L.mc));
      add("C", "PER(TTM) 개요=하이라이트", "LTM", same(m.perTtm, L.per));
      add("C", "PBR 개요=하이라이트", "LTM", same(m.pbr, L.pbr));
      add("C", "PSR 개요=하이라이트", "LTM", same(m.psr, L.psr));
      add("C", "EV/EBITDA 개요=하이라이트", "LTM", same(m.evEbitda, L.evx));
    }
    if (!uv || uv.error) add("C", "유니버스 행 계산됨", "LTM", { status: FAIL, note: uv?.error ?? "응답 없음" });
    else {
      add("C", "시가총액 유니버스=하이라이트", "LTM", same(uv.marketCap, L.mc));
      add("C", "PER(TTM) 유니버스=하이라이트", "LTM", same(uv.perTtm, L.per));
      add("C", "PBR 유니버스=하이라이트", "LTM", same(uv.pbr, L.pbr));
    }
  }

  // ── F. 외부 대조 — FnGuide·Yahoo(국내, 오너 지시 2026-09-24 "FnGuide 만 믿을 수 없다"). 소스마다 보고 단위 안에서 일치
  // (FnGuide 투자지표 억원·재무제표 백만원, Yahoo 백만원). 인베스팅닷컴은 스크립트 접근이 403 이라 브라우저 개별 확인만.
  const review = [];
  if (EXTERNAL) {
    const items = new Map(); // 항목 → { ours, src: { 소스: { v, unit, cause } } }
    // 판본 차이 원인 확인 — 외부 값 = DART 처음 공시(보고 단위 안) 이고 앱 값 = DART 최신 재작성(A층 통과)일 때만. 숫자로 성립할 때만 원인
    // 원인 확인(숫자로 성립할 때만): ① 외부 = DART 이전 판본(처음 공시·다음 해 보고서 전기)이고 앱 = 최신 재작성 ② 앱 = DART 공시값(A층 정확 일치)
    //    — 미국 F층 "앱 = SEC(A층 일치)" 와 같은 원칙(외부는 자체 계산·자체 정의)
    const F2A = { "매출": "매출액", "영업이익": "영업이익", "순이익(연결)": "당기순이익(연결)", "순이익(지배)": "당기순이익(지배)", "EPS": "희석 EPS" };
    const vintCause = (item) => {
      const [c, ...rest] = item.split(" ");
      const a = dartVint[`${c}|${F2A[rest.join(" ")] ?? ""}`];
      if (!a || !a.pass) return null;
      return (ours, v, unit) => {
        if (ours !== a.app) return null;
        const old = (a.vAll ?? []).find((x) => x.v !== a.latest && sameAt(x.v, v, unit));
        if (old) return `외부 = DART ${old.by} 사업보고서 판본 ${old.v}, 앱 = 최신 보고서 ${a.latest}`;
        return `앱 = DART 공시값 ${a.latest}(A층 정확 일치) — 외부는 자체 계산·정의`;
      };
    };
    const putS = (src, item, ours, v, unit, cause) => {
      if (ours == null || v == null) return;
      const it = items.get(item) ?? { ours, src: {} };
      it.src[src] = { v, unit, cause };
      items.set(item, it);
    };
    try {
      const fg = await fnguideInvest(sym);
      const fin = await fnguideFinance(sym);
      const ymOf = (d) => (d ? `${d.slice(0, 4)}/${d.slice(5, 7)}` : null);
      const put = (item, ours, v, unit, cause) => putS("FnGuide", item, ours, v, unit, cause ?? vintCause(item));
      for (const [c, x] of Object.entries(H)) {
        const ym = ymOf(x.date);
        if (!ym || !fg.cols.includes(ym)) continue;
        const isLtm = c === "LTM";
        const eok = (v) => (v != null ? v * 1e8 : null);
        put(`${c} EBITDA`, x.ebitda, eok(fg.ebitda[ym]), 1e8);
        // FnGuide EV 는 비지배지분을 뺀 정의. 앱 비지배지분이 FnGuide 재무상태표 비지배주주지분과 백만원 단위로 먼저 일치하고,
        // 앱 EV − FnGuide EV 가 그 값과 억원 반올림(±0.5억) 안에서 같을 때만 원인 확인(감사 3차 — 앱 nci 를 그대로 믿으면
        // nci 오류가 EV 에 같이 들어간 경우를 정당화했다)
        const fNci = fin?.nci[ym];
        const nciOk = x.nci != null && fNci != null && Math.abs(x.nci - fNci * 1e8) <= 0.5e6;
        put(`${c} EV`, x.ev, eok(fg.ev[ym]), 1e8, (ours, v) =>
          nciOk && x.nci !== 0 && Math.abs(ours - v - x.nci) <= 0.5e8 ? `FnGuide EV 는 비지배지분 제외 — 앱 EV − FnGuide EV = 비지배지분 ${x.nci}(FnGuide 재무상태표와 일치, 억원 반올림 안)` : null);
        put(`${c} 비지배지분`, x.nci, fNci != null ? fNci * 1e8 : null, 1e6);
        put(`${c} 매출`, isLtm ? null : IS[c]?.rev ?? null, eok(fg.rev[ym]), 1e8);
        // EPS 는 원인 판정 없음 — FnGuide 는 자체 주식수로 계산하지만 앱 EPS 의 정확성을 독립 소스로 확인할 수 없어(DART 원자료
        // 대조 부재) "자사주 포함" 설명이 오류를 정당화할 수 있었다(감사 3차). 차이는 미해명으로 남긴다.
        put(`${c} EPS`, x.eps, fg.epsTtm[ym], 1);
        if (!isLtm) {
          // 연결 순이익 = FnGuide 지배 + 비지배 당기순이익(재무제표 페이지, 백만원 단위 두 값 합 → ±1백만)
          const fN = fin?.niParent[ym], fM = fin?.niNci[ym];
          put(`${c} 순이익(연결)`, x.ni, fN != null && fM != null ? (fN + fM) * 1e8 : null, 2e6);
          // 순이익(지배) = 앱 손익계산서 "(지배주주 귀속)" 행 — 하이라이트 순이익(연결)으로 대체하지 않는다
          if (fg.niParent[ym] == null) continue;
          if (IS[c]?.niParent == null) add("C", "손익계산서 (지배주주 귀속) 행 존재(FnGuide 값 있음)", c, { status: FAIL, note: `FnGuide 순이익(지배) ${fg.niParent[ym] * 1e8} · 앱 행 없음` });
          else put(`${c} 순이익(지배)`, IS[c].niParent, fg.niParent[ym] * 1e8, 1e8);
        }
      }
    } catch (e) {
      review.push({ item: "외부 소스 조회 실패", note: `FnGuide: ${String(e).slice(0, 80)}` });
      hardErrors.push(`외부 소스 조회 실패 — FnGuide: ${String(e).slice(0, 80)}`);
    }

    // Yahoo — 연간(원 단위, DART 백만원 공시 그대로). 코스피 .KS, 없으면 코스닥 .KQ
    try {
      const y = await yahoo();
      let ya = [];
      for (const suf of [".KS", ".KQ"]) {
        ya = (await y.fundamentalsTimeSeries(sym + suf, { period1: "2018-01-01", type: "annual", module: "all" }, { validateResult: false }))
          .filter((r) => r.totalRevenue != null);
        if (ya.length) break;
      }
      if (!ya.length) throw new Error("연간 재무 없음(.KS·.KQ)");
      const iso = (d) => new Date(d).toISOString().slice(0, 10);
      const yEbitda = (r) => (r.totalOperatingIncomeAsReported != null && r.reconciledDepreciation != null ? r.totalOperatingIncomeAsReported + r.reconciledDepreciation : null);
      const put = (item, ours, v, unit) => putS("Yahoo", item, ours, v, unit, vintCause(item));
      for (const [c, x] of Object.entries(H)) {
        if (c === "LTM") continue;
        const r = ya.find((r) => dayDiff(iso(r.date), x.date) <= 7);
        if (!r) continue;
        put(`${c} 매출`, IS[c]?.rev ?? null, r.totalRevenue, 1e6);
        put(`${c} 영업이익`, IS[c]?.op ?? null, r.totalOperatingIncomeAsReported, 1e6);
        put(`${c} 감가상각비`, IS[c]?.da ?? null, r.reconciledDepreciation, 1e6);
        put(`${c} EBITDA`, x.ebitda, yEbitda(r), 2e6); // 두 백만원 값의 합 → ±1백만
        put(`${c} 순이익(연결)`, x.ni, r.netIncomeIncludingNoncontrollingInterests, 1e6);
        put(`${c} 순이익(지배)`, IS[c]?.niParent ?? null, r.netIncomeCommonStockholders ?? r.netIncome, 1e6);
        put(`${c} EPS`, x.eps, r.dilutedEPS, 1);
        put(`${c} 비지배지분`, x.nci, r.minorityInterest, 1e6);
        put(`${c} 총차입금`, x.debt, r.totalDebt, 1e6);
      }
    } catch (e) {
      review.push({ item: "외부 소스 조회 실패", note: `Yahoo: ${String(e).slice(0, 80)}` });
      hardErrors.push(`외부 소스 조회 실패 — Yahoo: ${String(e).slice(0, 80)}`);
    }

    // 항목별 판정 — 통과는 모든 소스와 일치할 때만, 원인 확인은 숫자로 성립한 소스만
    for (const [item, it] of items) {
      const names = Object.keys(it.src);
      const matched = [], explained = [], causes = {}, off = [];
      for (const n of names) {
        const s = it.src[n];
        if (sameAt(it.ours, s.v, s.unit)) { matched.push(n); continue; }
        const why = s.cause?.(it.ours, s.v, s.unit) ?? null;
        if (why) { explained.push(n); causes[n] = why; }
        off.push(`${n} ${s.v} (${(((it.ours - s.v) / Math.abs(s.v || 1)) * 100).toFixed(2)}%)${why ? ` [원인 확인: ${why}]` : ""}`);
      }
      review.push({
        item, ours: it.ours, sources: Object.fromEntries(names.map((n) => [n, it.src[n].v])), matched, explained,
        ...(explained.length ? { causes } : {}),
        verdict: matched.length === names.length ? `${names.length}곳 모두 일치` : `${matched.length}/${names.length}곳 일치 — 불일치: ${off.join(", ")}`,
      });
    }
  }
  return { sym, checks, review, hardErrors };
}

// ── 실행 ─────────────────────────────────────────────────────────────
const syms = await symbolList();
if (!syms.length) die("검증 대상 0종목");
const kst = new Date(Date.now() + 9 * 3600e3).toISOString();
// 초까지 — 같은 분에 연달아 돌리면 결과 파일이 덮어써졌다
const stamp = `${MARKET}-${kst.slice(0, 10).replace(/-/g, "")}-${kst.slice(11, 19).replace(/:/g, "")}`;
const dir = new URL("../reports/verify/", import.meta.url);
mkdirSync(dir, { recursive: true });
const partialFile = new URL(`verify-${stamp}.partial.json`, dir);
console.log(`검증 대상 ${syms.length}종목 · ${MARKET} · ${BASE} · 외부대조 ${EXTERNAL ? "켬" : "끔"}`);

const results = [];
let idx = 0;
// 외부 대조 행 분류 — 공통모드 소스만 일치한 행(verdict 가 공통모드로 시작)은 "외부 전부일치"가 아니다
const extCommonOnly = (x) => !!x.verdict && x.verdict.startsWith(COMMON_LABEL);
const extAllMatch = (x) => !!x.matched && !!x.verdict && !/불일치/.test(x.verdict) && !extCommonOnly(x);
async function worker() {
  while (idx < syms.length) {
    const s = syms[idx++];
    // DART 하루 요청 상한·020 으로 멈췄으면 남은 종목은 검증하지 않고 오류로 남긴다(조용히 건너뛰지 않음 — 종료코드 1)
    const dq = MARKET === "kr" ? dartQuota()?.stopped : null;
    if (dq) { results.push({ sym: s, error: `${dq.message} — 상한 도달, 남은 종목 검증불가`, checks: [], review: [] }); console.log(`${s.padEnd(7)} 오류: 상한 도달 — 검증불가(${dq.kind})`); continue; }
    try {
      const r = MARKET === "kr" ? await verifyKr(s) : await verifyUs(s);
      results.push(r);
      const f = r.checks.filter((c) => c.status === FAIL).length;
      const n = r.checks.filter((c) => c.status === NA).length;
      const p = r.checks.filter((c) => c.status === PASS).length;
      const cm = r.checks.filter((c) => c.status === COMMON).length;
      console.log(`${s.padEnd(7)} ${r.skipped ? `건너뜀: ${r.skipped}` : r.error ? `오류: ${r.error}` : `실패 ${f} · 검증불가 ${n} · 통과 ${p} · 공통모드 ${cm} · 외부 전부일치 ${r.review.filter(extAllMatch).length} · 외부 공통모드 ${r.review.filter(extCommonOnly).length} · 외부 불일치 ${r.review.filter((x) => /불일치/.test(x.verdict ?? "")).length} · 기타검토 ${r.review.filter((x) => !x.matched).length} · 조회실패 ${r.hardErrors?.length ?? 0}${MARKET === "us" ? ` · 매출 ③ 오류 ${r.revErrors?.length ?? 0}` : ""}${COGS_MODE ? ` · 매출원가·매출총이익 ③ 오류 ${r.cogsErrors?.length ?? 0}` : ""}${OPINC_MODE ? ` · 영업이익 ③ 오류 ${r.opincErrors?.length ?? 0}` : ""}${DA_MODE ? ` · 감가상각비 ③ 오류 ${r.daErrors?.length ?? 0}` : ""}${SGA_MODE ? ` · 판관비·연구개발비 ③ 오류 ${r.sgaErrors?.length ?? 0}` : ""}`}`);
    } catch (e) {
      if (process.env.VERIFY_STACK) console.error(e?.stack); results.push({ sym: s, error: String(e).slice(0, 160), checks: [], review: [] });
      console.log(`${s.padEnd(7)} 오류: ${String(e).slice(0, 120)}`);
    }
    if (results.length % 10 === 0) writeFileSync(partialFile, JSON.stringify({ base: BASE, market: MARKET, total: syms.length, results }));
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const all = results.flatMap((r) => r.checks.map((c) => ({ sym: r.sym, ...c })));
const fails = all.filter((c) => c.status === FAIL);
const errors = results.filter((r) => r.error || r.hardErrors?.length);
const badSkips = results.filter((r) => r.skipped && !r.allowedSkip);
const empty = results.filter((r) => !r.error && !r.skipped && r.checks.filter((c) => c.status === PASS).length === 0);
const missing = syms.filter((s) => !results.some((r) => r.sym === s));

const byName = {};
for (const c of all) {
  const b = (byName[`${c.layer} ${c.name}`] ??= { pass: 0, fail: 0, unverifiable: 0, common: 0, naWhy: {} });
  b[c.status]++;
  if (c.status === NA) b.naWhy[(c.note ?? "").split(" · ")[0].slice(0, 40)] = (b.naWhy[(c.note ?? "").split(" · ")[0].slice(0, 40)] ?? 0) + 1;
}
console.log("\n── 검사 항목별 (층 A=SEC 원자료 B=결산기간 C=화면간 D=항등식·기대치 E=공시정합성 · 공통모드 = 독립 검증 아님, 통과에 세지 않음) ──");
for (const [n, b] of Object.entries(byName).sort()) {
  console.log(`  ${n.padEnd(52)} 통과 ${b.pass} · 실패 ${b.fail} · 검증불가 ${b.unverifiable}${b.common ? ` · 공통모드 ${b.common}` : ""}`);
  for (const [why, k] of Object.entries(b.naWhy)) console.log(`      └ 검증불가 ${k}: ${why}`);
}
if (fails.length) {
  console.log("\n── 실패 상세 ──");
  for (const f of fails) console.log(`  ${f.sym} ${f.col} [${f.layer}] ${f.name}: ${f.note ?? ""}`);
}
const reviews = results.flatMap((r) => (r.review ?? []).map((x) => ({ sym: r.sym, ...x })));
// 외부 대조는 허용치 없이 — 소스 하나라도 앱과 다르면 원인 규명 대상으로 전부 보인다
const shownReviews = reviews.filter((x) => !x.verdict || /불일치/.test(x.verdict));
if (shownReviews.length) {
  console.log("\n── 외부 대조 불일치·기타 검토 (원인 규명 대상) ──");
  for (const x of shownReviews) console.log(`  ${x.sym} ${x.item}: ${x.verdict ?? x.note ?? ""}`);
}
const hardList = results.flatMap((r) => (r.hardErrors ?? []).map((e) => ({ sym: r.sym, e })));
if (hardList.length || badSkips.length) {
  console.log("\n── 조회 실패·부당 건너뜀 (종료코드 1) ──");
  for (const x of hardList) console.log(`  ${x.sym} ${x.e}`);
  for (const r of badSkips) console.log(`  ${r.sym} 건너뜀: ${r.skipped}`);
}
const out = new URL(`verify-${stamp}.json`, dir);
writeFileSync(out, JSON.stringify({ base: BASE, market: MARKET, at: new Date().toISOString(), symbols: syms, results }, null, 2));
rmSync(partialFile, { force: true });

// 관리자 화면(/admin/verify)용 저장 — 종목별 최신 결과로 교체. 통과 항목은 건수만.
if (args.post) {
  const docs = results.map((r) => {
    const cs = r.checks ?? [];
    const rv = r.review ?? [];
    const pick = (st) => cs.filter((c) => c.status === st).map((c) => ({ layer: c.layer, name: c.name, col: c.col, note: c.note ?? "" }));
    return {
      market: MARKET,
      symbol: r.sym,
      runAt: new Date().toISOString(),
      base: BASE,
      commit: process.env.GITHUB_SHA ?? null,
      counts: {
        fail: cs.filter((c) => c.status === FAIL).length,
        unverifiable: cs.filter((c) => c.status === NA).length,
        pass: cs.filter((c) => c.status === PASS).length,
        common: cs.filter((c) => c.status === COMMON).length,
        extAllMatch: rv.filter(extAllMatch).length,
        extCommon: rv.filter(extCommonOnly).length,
        extMismatch: rv.filter((x) => /불일치/.test(x.verdict ?? "")).length,
        otherReview: rv.filter((x) => !x.verdict).length,
      },
      fails: pick(FAIL),
      unverifiable: pick(NA),
      common: pick(COMMON),
      external: rv,
      ...(r.audit ? { audit: r.audit } : {}),
      errors: [r.error, r.skipped && !r.allowedSkip ? `건너뜀: ${r.skipped}` : null, ...(r.hardErrors ?? [])].filter(Boolean),
    };
  });
  for (let i = 0; i < docs.length; i += 10) {
    const res = await fetch(`${BASE}/api/cron/verify-results`, {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ results: docs.slice(i, i + 10) }),
    });
    if (!res.ok) {
      console.error(`결과 저장 실패 HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
      process.exit(1);
    }
  }
  console.log(`결과 저장 ${docs.length}종목 → ${BASE}/admin/verify`);
}
// ── 매출(revenue.md §0·§6) — 외부 대조 분류와 ③ 오류는 검토 목록에 묻히지 않게 따로 낸다
const isRevCheck = (c) => /매출(?!총이익|원가)|순수익|PSR/.test(c.name);
const revFails = fails.filter(isRevCheck);
const revErrs = results.flatMap((r) => (r.revErrors ?? []).map((e) => ({ sym: r.sym, ...e })));
const revCls = { "①": 0, "②": 0, 외부단독이탈: 0, 환율영향: 0, 공통모드: 0, NA: 0, "③": 0 };
for (const x of reviews) for (const v of Object.values(x.revenueClass ?? {})) revCls[v]++;
if (MARKET === "us") {
  console.log(`\n── 매출 외부 대조 분류 — ① 일치 ${revCls["①"]} · ② 정의 차이 ${revCls["②"]} · 외부 단독 이탈 ${revCls.외부단독이탈} · 환율 영향(보류) ${revCls.환율영향} · 공통모드 ${revCls.공통모드} · ${NA_PRECISION} ${revCls.NA} · ③ 오류 ${revErrs.length}건 ──`);
  for (const x of reviews.filter((y) => Object.values(y.revenueClass ?? {}).includes("외부단독이탈"))) console.log(`  [외부 단독 이탈] ${x.sym} ${x.item}: ${x.verdict}`);
  for (const e of revErrs) console.log(`  [③ 오류] ${e.sym} ${e.item} — ${e.source} ${e.other} vs 앱 ${e.ours} (차 ${e.ours - e.other}) · ${e.note}`);
  console.log(`매출 검사 실패 ${revFails.length} · 매출 ③ 오류 ${revErrs.length}건${METRIC === "revenue" ? " (매출 닫기 모드 — 종료코드 기준)" : ""}`);
}
const commons = all.filter((c) => c.status === COMMON);
const commonSkips = results.filter((r) => r.commonSkip);
const extCommonN = reviews.filter(extCommonOnly).length;
const extCommonCause = reviews.reduce((t, x) => t + Object.keys(x.commonMode ?? {}).length, 0);
const extPrecN = reviews.reduce((t, x) => t + Object.keys(x.precisionNa ?? {}).length, 0);
// 공통모드는 실패가 아니다(종료코드 무관) — 다만 통과로 세지 않고 따로 보인다
console.log(`\n${COMMON_LABEL}: 검사 ${commons.length}건 · 외부 대조 공통모드 소스 ${extCommonCause}건(그중 공통모드만 일치한 행 ${extCommonN}) · ${NA_PRECISION} 외부 ${extPrecN}건${commonSkips.length ? ` · 공통모드 건너뜀(모기지 리츠) ${commonSkips.length}종목` : ""}`);
console.log(`\n실패 ${fails.length} · 공통모드 ${commons.length} · 오류 ${errors.length}(조회 실패 ${hardList.length}건) · 부당 건너뜀 ${badSkips.length} · 통과 0건 종목 ${empty.length} · 누락 ${missing.length}${MARKET === "us" ? ` · 매출 ③ 오류 ${revErrs.length}건` : ""} · 결과 ${decodeURIComponent(out.pathname)}`);
// ── 매출원가·매출총이익(--metric=cogs) — 분류와 ③ 오류를 따로 낸다. 종료코드 = 이 지표 검사 실패·③ 오류·조회 실패
const isCogsCheck = (c) => /매출원가|매출총이익/.test(c.name);
const cogsFails = fails.filter(isCogsCheck);
const cogsErrs = results.flatMap((r) => (r.cogsErrors ?? []).map((e) => ({ sym: r.sym, ...e })));
if (MARKET === "us" && COGS_MODE) {
  const cls = { "①": 0, "②": 0, 외부단독이탈: 0, 환율영향: 0, 외부정의분해불가: 0, 구성미분해: 0, 공통모드: 0, NA: 0, "③": 0 };
  for (const x of reviews.filter((y) => /(매출원가|매출총이익)$/.test(y.item ?? ""))) for (const v of Object.values(x.metricClass ?? {})) cls[v]++;
  console.log(`\n── 매출원가·매출총이익 외부 대조 분류 — ① 일치 ${cls["①"]} · ② 정의 차이 ${cls["②"]} · 외부 단독 이탈 ${cls.외부단독이탈} · 환율 영향(보류) ${cls.환율영향} · 외부 정의 분해 불가 ${cls.외부정의분해불가} · 구성 미분해 ${cls.구성미분해} · 공통모드 ${cls.공통모드} · ${NA_PRECISION} ${cls.NA} · ③ 오류 ${cogsErrs.length}건 ──`);
  for (const x of reviews.filter((y) => /(매출원가|매출총이익)$/.test(y.item ?? "") && Object.values(y.metricClass ?? {}).includes("외부단독이탈"))) console.log(`  [외부 단독 이탈] ${x.sym} ${x.item}: ${x.verdict}`);
  for (const e of cogsErrs) console.log(`  [③ 오류] ${e.sym} ${e.item} — ${e.source} ${e.other} vs 앱 ${e.ours} (차 ${e.ours - e.other}) · ${e.note}`);
  const naWait = all.filter((c) => isCogsCheck(c) && c.status === NA && (c.note ?? "").startsWith(COGS_WAIT)).length;
  console.log(`매출원가·매출총이익 검사 실패 ${cogsFails.length} · ③ 오류 ${cogsErrs.length}건 · "${COGS_WAIT}" 검증불가 ${naWait}건 (매출원가 모드 — 종료코드 기준, 지표 미종결)`);
}
// ── 영업이익(--metric=opinc) — 분류와 ③ 오류를 따로 낸다. 종료코드 = 매출원가·매출총이익·영업이익 검사 실패·③ 오류·조회 실패
const isOpincCheck = (c) => /^(분기 )?영업이익(\(합성\))? 앱 = SEC (본표 영업이익|세전이익 − 영업외 항목)|^(분기 )?영업이익 빈칸 = |^영업이익 합성 표기/.test(c.name);
const opincFails = fails.filter(isOpincCheck);
const opincErrs = results.flatMap((r) => (r.opincErrors ?? []).map((e) => ({ sym: r.sym, ...e })));
if (MARKET === "us" && OPINC_MODE) {
  const cls = { "①": 0, "②": 0, 외부단독이탈: 0, 환율영향: 0, 외부정의분해불가: 0, 구성미분해: 0, 공통모드: 0, NA: 0, "③": 0 };
  const isOp = (x) => /^(\d{4}Y|LTM) 영업이익$/.test(x.item ?? "");
  for (const x of reviews.filter(isOp)) for (const v of Object.values(x.metricClass ?? {})) cls[v]++;
  console.log(`\n── 영업이익 외부 대조 분류 — ① 일치 ${cls["①"]} · ② 정의 차이 ${cls["②"]} · 외부 단독 이탈 ${cls.외부단독이탈} · 환율 영향(보류) ${cls.환율영향} · 외부 정의 분해 불가 ${cls.외부정의분해불가} · 구성 미분해 ${cls.구성미분해} · 공통모드 ${cls.공통모드} · ${NA_PRECISION} ${cls.NA} · ③ 오류 ${opincErrs.length}건 ──`);
  for (const x of reviews.filter((y) => isOp(y) && Object.values(y.metricClass ?? {}).includes("외부단독이탈"))) console.log(`  [외부 단독 이탈] ${x.sym} ${x.item}: ${x.verdict}`);
  for (const e of opincErrs) console.log(`  [③ 오류] ${e.sym} ${e.item} — ${e.source} ${e.other} vs 앱 ${e.ours} (차 ${e.ours - e.other}) · ${e.note}`);
  const opAll = all.filter(isOpincCheck);
  console.log(`영업이익 검사 통과 ${opAll.filter((c) => c.status === PASS).length} · 실패 ${opincFails.length} · 공통모드 ${opAll.filter((c) => c.status === COMMON).length} · 검증불가 ${opAll.filter((c) => c.status === NA).length} · ③ 오류 ${opincErrs.length}건 (영업이익 모드 — 종료코드 기준, 지표 미종결)`);
}
// ── 감가상각비(--metric=da) — 분류와 ③ 오류를 따로 낸다. 종료코드 = 매출원가·매출총이익·영업이익·감가상각비 검사 실패·③ 오류·조회 실패
const isDaCheck = (c) => /^(분기 )?감가상각비 앱 = SEC 현금흐름표/.test(c.name);
const daFails = fails.filter(isDaCheck);
const daErrs = results.flatMap((r) => (r.daErrors ?? []).map((e) => ({ sym: r.sym, ...e })));
if (MARKET === "us" && DA_MODE) {
  const cls = { "①": 0, "②": 0, 외부단독이탈: 0, 환율영향: 0, 외부정의분해불가: 0, 구성미분해: 0, 공통모드: 0, NA: 0, "③": 0 };
  const isDa = (x) => /^(\d{4}Y|LTM) 감가상각비$/.test(x.item ?? "");
  for (const x of reviews.filter(isDa)) for (const v of Object.values(x.metricClass ?? {})) cls[v]++;
  console.log(`\n── 감가상각비 외부 대조 분류 — ① 일치 ${cls["①"]} · ② 정의 차이 ${cls["②"]} · 외부 단독 이탈 ${cls.외부단독이탈} · 환율 영향(보류) ${cls.환율영향} · 외부 정의 분해 불가 ${cls.외부정의분해불가} · 구성 미분해 ${cls.구성미분해} · 공통모드 ${cls.공통모드} · ${NA_PRECISION} ${cls.NA} · ③ 오류 ${daErrs.length}건 ──`);
  for (const x of reviews.filter((y) => isDa(y) && Object.values(y.metricClass ?? {}).includes("외부단독이탈"))) console.log(`  [외부 단독 이탈] ${x.sym} ${x.item}: ${x.verdict}`);
  for (const e of daErrs) console.log(`  [③ 오류] ${e.sym} ${e.item} — ${e.source} ${e.other} vs 앱 ${e.ours} (차 ${e.ours - e.other}) · ${e.note}`);
  const dAll = all.filter(isDaCheck);
  console.log(`감가상각비 검사 통과 ${dAll.filter((c) => c.status === PASS).length} · 실패 ${daFails.length} · 공통모드 ${dAll.filter((c) => c.status === COMMON).length} · 검증불가 ${dAll.filter((c) => c.status === NA).length} · ③ 오류 ${daErrs.length}건 (감가상각비 모드 — 종료코드 기준, 지표 미종결)`);
}
// ── 판관비·연구개발비(--metric=sga) — 분류와 ③ 오류를 따로 낸다. 종료코드 = 위 지표 + 판관비·연구개발비 검사 실패·③ 오류·조회 실패
const isSgaCheck = (c) => /^(분기 )?(판관비|연구개발비)( 하위 줄)? (앱 = SEC 본표|빈칸 = )|^(분기 )?(판관비|연구개발비) = 하위 줄 합/.test(c.name);
const sgaFails = fails.filter(isSgaCheck);
const sgaErrs = results.flatMap((r) => (r.sgaErrors ?? []).map((e) => ({ sym: r.sym, ...e })));
if (MARKET === "us" && SGA_MODE) {
  for (const m of ["판관비", "연구개발비", "판관비·연구개발비"]) {
    const cls = { "①": 0, "②": 0, 외부단독이탈: 0, 환율영향: 0, 외부정의분해불가: 0, 구성미분해: 0, 공통모드: 0, NA: 0, "③": 0 };
    const isM = (x) => (x.item ?? "").replace(/^(\d{4}Y|LTM) /, "") === m && /^(\d{4}Y|LTM) /.test(x.item ?? "");
    for (const x of reviews.filter(isM)) for (const v of Object.values(x.metricClass ?? {})) cls[v]++;
    const errsM = sgaErrs.filter((e) => isM(e));
    console.log(`
── ${m} 외부 대조 분류 — ① 일치 ${cls["①"]} · ② 정의 차이 ${cls["②"]} · 외부 단독 이탈 ${cls.외부단독이탈} · 환율 영향(보류) ${cls.환율영향} · 외부 정의 분해 불가 ${cls.외부정의분해불가} · 구성 미분해 ${cls.구성미분해} · 공통모드 ${cls.공통모드} · ${NA_PRECISION} ${cls.NA} · ③ 오류 ${errsM.length}건 ──`);
    for (const x of reviews.filter((y) => isM(y) && Object.values(y.metricClass ?? {}).includes("외부단독이탈"))) console.log(`  [외부 단독 이탈] ${x.sym} ${x.item}: ${x.verdict}`);
    for (const e of errsM) console.log(`  [③ 오류] ${e.sym} ${e.item} — ${e.source} ${e.other} vs 앱 ${e.ours} (차 ${e.ours - e.other}) · ${e.note}`);
  }
  const sAll = all.filter(isSgaCheck);
  console.log(`판관비·연구개발비 검사 통과 ${sAll.filter((c) => c.status === PASS).length} · 실패 ${sgaFails.length} · 공통모드 ${sAll.filter((c) => c.status === COMMON).length} · 검증불가 ${sAll.filter((c) => c.status === NA).length} · ③ 오류 ${sgaErrs.length}건 (판관비·연구개발비 모드 — 종료코드 기준, 지표 미종결)`);
  for (const c of sgaFails) console.log(`  [실패] ${c.sym} [${c.col}] ${c.name} — ${String(c.note ?? "").slice(0, 300)}`);
}
if (KR_CACHE) {
  const cs = KR_CACHE.summary();
  console.log(`
DART·KRX 디스크 캐시 — 적중 ${cs.hit} · 미스 ${cs.miss} · 새로 씀 ${cs.write} · 정리(옛 판본 ${cs.deletedOld} · 90일 미사용 ${cs.deletedIdle} · 상한 초과 ${cs.deletedCap}) · 총 ${cs.files}파일 ${(cs.bytes / 1024 ** 2).toFixed(1)}MB · DART 요청 ${dartStats.requests} · KRX 요청 ${krxStats.requests}`);
  const qs = dartQuota()?.state();
  if (qs) console.log(`DART 하루 요청(검증기) ${qs.count}/${qs.cap} — ${qs.day} KST${qs.stopped ? ` · 중단: ${qs.stopped.message}` : ""}`);
  await closeKrLayers();
}
const infraBad = errors.length || badSkips.length || empty.length || missing.length;
// 한국 — 층별 집계와 재실행 필요(감사 2차 ③·④): 게시 전(KRX 자료가 아직 안 나온 거래일)이라 확인 못 한 검사는 검증불가로 남고, 그런 검사가 하나라도
// 있으면 실패가 없어도 "깨끗한 통과"가 아니다 — 재실행 필요(종료코드 3). 공통모드(적재본과만 맞은 칸 등)는 통과로 세지 않는다
const rerun = all.filter((c) => c.status === NA && /재실행 필요/.test(c.note ?? ""));
if (MARKET === "kr") {
  const grp = (c) => (c.layer === "A" && /^분기 /.test(c.name) ? "A 분기" : c.layer === "A" ? "A 연간" : c.layer);
  const by = {};
  for (const c of all) { const b = (by[grp(c)] ??= { pass: 0, fail: 0, unverifiable: 0, common: 0 }); b[c.status] = (b[c.status] ?? 0) + 1; }
  console.log("\n── 한국 층별 집계 (A 연간·A 분기 = DART 재무제표, K1 시가총액 KRX, K2 EV 구성요소, K3 감가상각, K4 LTM 손익, K5 배당) ──");
  for (const [k, b] of Object.entries(by).sort()) console.log(`  ${k.padEnd(8)} 통과 ${b.pass} · 실패 ${b.fail} · 검증불가 ${b.unverifiable} · 공통모드 ${b.common}`);
  console.log(rerun.length ? `\n재실행 필요 ${rerun.length}건(게시 전 등으로 확인 못 함 — 종료코드 3): ${[...new Set(rerun.map((c) => `${c.sym} ${c.name}`))].slice(0, 20).join(" · ")}` : "\n재실행 필요 0건");
}
if (!(fails.length || infraBad) && rerun.length && !METRIC) process.exit(3);
process.exit(METRIC === "revenue" ? (revFails.length || revErrs.length || infraBad ? 1 : 0)
  : METRIC === "cogs" ? (cogsFails.length || cogsErrs.length || infraBad ? 1 : 0)
  : METRIC === "opinc" ? (cogsFails.length || cogsErrs.length || opincFails.length || opincErrs.length || infraBad ? 1 : 0)
  : METRIC === "da" ? (cogsFails.length || cogsErrs.length || opincFails.length || opincErrs.length || daFails.length || daErrs.length || infraBad ? 1 : 0)
  : METRIC === "sga" ? (cogsFails.length || cogsErrs.length || opincFails.length || opincErrs.length || daFails.length || daErrs.length || sgaFails.length || sgaErrs.length || infraBad ? 1 : 0)
  : (fails.length || infraBad ? 1 : 0));
