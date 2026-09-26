#!/usr/bin/env node
// 정답 데이터셋(골든셋) — 회귀 검증 (오너 확인 2026-09-26, docs/handoff-verification.md 재개 절차 3번)
//
// 원자료(SEC 본표·원통화 × 환율)와 정확 일치가 확인된 값만 종목·검사·열별로 고정해 git 으로 관리한다(운영 DB 에 넣지 않음).
// 코드를 고친 뒤 검증기를 다시 돌리고 이 스크립트로 대조하면 "이번 수정 때문에 바뀐 값"을 바로 잡는다.
//
//   build: node scripts/metrics/golden.mjs build <검증 결과 JSON...>   → scripts/metrics/golden/us.json 새로 작성
//   check: node scripts/metrics/golden.mjs check <검증 결과 JSON...>   → 정답과 대조, 이상 있으면 종료코드 1
//
// 규칙
// - 닫힌 지표만 담는다(GOLDEN_CHECKS). 아직 검증이 닫히지 않은 지표는 틀린 값이 정답이 될 수 있어 넣지 않는다.
// - 검증 결과 행이 PASS 이고 앱 값 = 원자료 값(부동소수 오차 1e-9 안)인 것만 담는다 — 앱 값만 있는 행은 넣지 않는다.
// - 결과 파일이 여럿이면 종목마다 가장 나중에 실행된 결과를 쓴다.
// - 대조 판정: 앱 값 그대로 = 일치 / 앱 값만 바뀜 = 코드 회귀 / 원자료·판본도 바뀜 = 새 공시(재작성) — 사람 확인 후 build 로
//   정답 갱신 / 검사 행이 사라짐 = 누락. 일치 외에는 모두 종료코드 1.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const GOLDEN_FILE = path.resolve("scripts/metrics/golden/us.json");
/** 닫힌 지표의 A층(원자료 대조) 검사 이름 — 지표를 닫을 때마다 추가 */
const GOLDEN_CHECKS = {
  revenue: [
    "매출 앱 = SEC 매출",
    "분기 매출 앱 = SEC 매출(3개월)",
    "분기 매출 앱 = SEC 매출(Q4 = 사업연도 − 9개월)",
    "항등식 미검증 열 매출 앱 = SEC 매출(직접 대조 필수)",
    "20-F LTM 매출 = Yahoo 분기 4개 × 분기 평균 환율",
  ],
};
const NAMES = new Set(Object.values(GOLDEN_CHECKS).flat());
// 원자료 대조 값은 달러 정수(또는 같은 입력의 환율 곱)라 부동소수 오차만 허용 — 1e-9 는 4천억 달러에서 400달러를 통과시켜 1달러
// 회귀를 놓쳤다(주입 시험 2026-09-26). 1e-12 = 4천억 달러에서 0.4달러
const EXACT = 1e-12;
const eq = (a, b) => a === b || (a != null && b != null && Math.abs(a - b) <= EXACT * Math.max(Math.abs(b), 1));
/** 근거 메모의 판본 표기("판본 10-K 2024-02-28") — 새 공시 판정용 */
const filingOf = (note) => note?.match(/판본 ((?:10-K|10-Q|20-F|40-F|6-K)(?:\/A)? \d{4}-\d{2}-\d{2})/)?.[1] ?? null;

function latestPerSymbol(files) {
  const bySym = new Map();
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    if (j.market && j.market !== "us") throw new Error(`${f}: 미국 결과만 지원(market=${j.market})`);
    for (const r of j.results ?? []) {
      const prev = bySym.get(r.sym);
      if (!prev || prev.at < j.at) bySym.set(r.sym, { at: j.at, file: path.basename(f), res: r });
    }
  }
  return bySym;
}
const rowsOf = (res) => (res.checks ?? []).filter((c) => c.layer === "A" && NAMES.has(c.name));
const keyOf = (c) => `${c.name}|${c.col}`;

function build(files) {
  const bySym = latestPerSymbol(files);
  const out = { meta: { builtAt: new Date().toISOString(), commit: execSync("git rev-parse HEAD").toString().trim(), metrics: Object.keys(GOLDEN_CHECKS), reports: [...new Set([...bySym.values()].map((x) => x.file))].sort() }, symbols: {} };
  let n = 0, skipped = 0, noVal = 0;
  for (const sym of [...bySym.keys()].sort()) {
    const rows = {};
    for (const c of rowsOf(bySym.get(sym).res)) {
      if (c.status !== "pass") { skipped++; continue; }
      if (c.app == null || c.src == null) { noVal++; continue; }
      if (!eq(c.app, c.src)) { skipped++; continue; }
      rows[keyOf(c)] = { v: c.app, src: c.src, filing: filingOf(c.note) };
      n++;
    }
    out.symbols[sym] = Object.fromEntries(Object.entries(rows).sort(([a], [b]) => a.localeCompare(b)));
  }
  if (noVal) throw new Error(`값이 없는 통과 행 ${noVal}건 — 검증 결과가 vsSource 값 기록(2026-09-26) 이전 판본이다. 검증기를 다시 돌린 결과로 만들 것`);
  fs.mkdirSync(path.dirname(GOLDEN_FILE), { recursive: true });
  fs.writeFileSync(GOLDEN_FILE, JSON.stringify(out, null, 1) + "\n");
  console.log(`골든셋 작성: ${Object.keys(out.symbols).length}종목 · ${n}값 (통과 아님·불일치 제외 ${skipped}) → ${path.relative(process.cwd(), GOLDEN_FILE)}`);
}

function check(files) {
  const g = JSON.parse(fs.readFileSync(GOLDEN_FILE, "utf8"));
  const bySym = latestPerSymbol(files);
  const bad = { regress: [], filing: [], missing: [], srcOnly: [] };
  let ok = 0, notRun = [];
  for (const [sym, rows] of Object.entries(g.symbols)) {
    const cur = bySym.get(sym);
    if (!cur) { notRun.push(sym); continue; }
    const now = new Map(rowsOf(cur.res).map((c) => [keyOf(c), c]));
    for (const [k, gv] of Object.entries(rows)) {
      const c = now.get(k);
      if (!c) { bad.missing.push(`${sym} ${k} — 검사 행이 사라짐(정답 ${gv.v})`); continue; }
      const appSame = eq(c.app, gv.v), srcSame = eq(c.src, gv.src), filing = filingOf(c.note);
      if (appSame && srcSame) { ok++; continue; }
      const line = `${sym} ${k} — 정답 ${gv.v}(${gv.filing ?? "판본 표기 없음"}) → 앱 ${c.app} · 원자료 ${c.src}(${filing ?? "판본 표기 없음"}) · 검증 ${c.status}`;
      if (!appSame && srcSame) bad.regress.push(line);
      else if (!srcSame && (filing !== gv.filing)) bad.filing.push(line);
      else bad.srcOnly.push(line);
    }
  }
  const sec = (title, list) => list.length && console.log(`\n${title} ${list.length}건\n${list.map((x) => `  ${x}`).join("\n")}`);
  console.log(`골든셋 대조 — 일치 ${ok} · 코드 회귀 ${bad.regress.length} · 새 공시(정답 갱신 필요) ${bad.filing.length} · 원자료만 변동 ${bad.srcOnly.length} · 누락 ${bad.missing.length} · 미실행 종목 ${notRun.length}`);
  sec("[코드 회귀] 원자료·판본은 같은데 앱 값이 바뀜", bad.regress);
  sec("[새 공시] 원자료·판본이 바뀜 — 확인 후 build 로 정답 갱신", bad.filing);
  sec("[원자료만 변동] 판본 표기는 같은데 원자료 값이 바뀜 — 검증기 판독 변경 여부 확인", bad.srcOnly);
  sec("[누락] 정답에 있는 검사가 이번 결과에 없음", bad.missing);
  if (notRun.length) console.log(`\n미실행 종목(이번 결과에 없음 — 대조 안 함): ${notRun.join(",")}`);
  const fail = bad.regress.length + bad.filing.length + bad.srcOnly.length + bad.missing.length;
  process.exitCode = fail ? 1 : 0;
}

const [mode, ...files] = process.argv.slice(2);
if (!["build", "check"].includes(mode) || !files.length) {
  console.error("사용법: node scripts/metrics/golden.mjs <build|check> <검증 결과 JSON...>");
  process.exit(2);
}
(mode === "build" ? build : check)(files);
