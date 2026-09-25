/**
 * 그림자 비교(architecture.md §7 1단계) — 새 경로(src/lib/fin, 비저장 조립)의 매출(연간·분기·Q4·LTM)을 기존 화면 값
 * (하이라이트·손익계산서 연간/분기·TTM API)과 칸 단위로 비교해 ① 일치 ② 정의·판본 차이(분해식 성립) ③ 원인 미상으로 나눈다.
 *
 *   node scripts/fin/shadow-revenue.mjs --symbols=AAPL,WDC,XOM [--base=http://localhost:3000] [--out=shadow.json]
 *
 * 기존 값은 실행 중인 개발 서버 API 에서 받는다(화면이 실제로 보여주는 값). 새 값은 같은 프로세스에서 jiti 로 조립한다.
 * ② 판정은 숫자로 성립할 때만:
 *   - 신규 채움: 기존 빈칸 → 새 값(Q4D 열 = D5 해결)
 *   - 판본: 기존 값 = 같은 개념·같은 기간의 다른(옛) 공시 값 → 최신 판본 규칙(D4)
 *   - 태그: 기존 값 = 같은 열의 다른 매출 개념 값 → 조립 IS 줄 선택(D1·증권사 순수익 등)
 *   - LTM 구성: 기존 LTM = 다른 개념·판본 조합
 * 종목은 순차, SEC 요청은 source/us/sec.ts 가 순차·간격·디스크 캐시.
 */
import { createJiti } from "jiti";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
if (existsSync(resolve(root, ".env.local"))) process.loadEnvFile(resolve(root, ".env.local"));
process.env.FIN_SEC_CACHE_DIR ??= resolve(root, ".omc/tmp/sec-cache");
const jiti = createJiti(import.meta.url, {
  alias: { "@": resolve(root, "src"), "server-only": resolve(root, "node_modules/server-only/empty.js") },
});
const fin = await jiti.import(resolve(root, "src/lib/fin/index.ts"));
const { UsReader } = await jiti.import(resolve(root, "src/lib/fin/read/index.ts"));

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const BASE = arg("base") ?? "http://localhost:3000";
const symbols = (arg("symbols") ?? "AAPL,WDC,XOM,AXP,MET,GS,TSM,GE").split(",").map((s) => s.trim().toUpperCase());

const REV_CONCEPTS = [
  "us-gaap:Revenues", "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", "us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax",
  "us-gaap:RevenuesNetOfInterestExpense", "ifrs-full:Revenue", "ifrs-full:RevenueFromContractsWithCustomers",
];
const eq = (a, b) => a != null && b != null && Math.abs(a - b) <= Math.max(0.5, Math.abs(b) * 1e-9);
const M = (v) => (v == null ? "—" : (v / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 }));

async function get(path) {
  const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(240_000) });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

/** 기존 화면 값 — {원천: {열키: 값}} */
async function oldValues(sym) {
  const out = { hl: {}, isA: {}, isQ: {}, ttm: {} };
  const hl = (await get(`/api/markets/us/${sym}/highlights`)).highlights;
  // 은행·카드사 레이아웃은 "순수익" 행(net_revenue / is:순수익)
  const row = hl?.rows?.find((r) => r.key === "revenue") ?? hl?.rows?.find((r) => r.key === "net_revenue");
  hl?.columns?.forEach((c, i) => { if (c.kind === "fy" || c.kind === "ltm") out.hl[c.key] = row?.values?.[i] ?? null; });
  for (const [period, dst] of [["annual", out.isA], ["quarter", out.isQ]]) {
    const f = await get(`/api/markets/us/${sym}/financials?view=is&period=${period}`);
    const items = f.sections?.flatMap((s) => s.items) ?? [];
    const item = items.find((i) => i.accountId === "is:매출액") ?? items.find((i) => i.accountId === "is:순수익");
    for (const p of f.periods ?? []) {
      const key = p.fiscalQuarter ? `${p.fiscalYear}Q${p.fiscalQuarter}` : /LTM/.test(p.label) ? "LTM" : `FY${p.fiscalYear}`;
      dst[key] = item?.values?.[p.label] ?? null;
    }
  }
  const t = await get(`/api/markets/us/${sym}/ttm`);
  out.ttm.LTM = t?.ttm?.revenue ?? t?.revenue ?? null;
  return out;
}

/** 차이 설명(분해식) — 성립하면 문자열, 아니면 null */
async function explain(reader, spec, oldV, newMv) {
  if (!spec) return null;
  // 태그: 같은 열의 다른 매출 개념(최신 판본)
  for (const c of REV_CONCEPTS) {
    if (c === newMv.line) continue;
    const cell = await reader.value(c, spec);
    if (eq(cell.v, oldV)) return `태그: 기존 = ${c}(같은 열·최신 판본), 새 = 조립 IS 줄 ${newMv.line}(${newMv.rule})`;
  }
  // 판본: 같은 개념·같은 기간의 다른 공시 값(FY·Q 단일 공시 열만)
  const parts = spec.segments.flatMap((s) => s.parts);
  if (parts.length === 1 && newMv.line) {
    const p = parts[0];
    const rate = reader.fx?.cur === "USD" ? 1 : reader.fx?.avg(p.start, p.end);
    for (const c of [newMv.line, ...REV_CONCEPTS]) {
      for (const f of reader.idx.get(c)) {
        if (f.start == null || Math.abs(Date.parse(f.start) - Date.parse(p.start)) > 3 * 864e5 || Math.abs(Date.parse(f.end) - Date.parse(p.end)) > 3 * 864e5) continue;
        if (Object.keys(f.dims).length || f.prov.accn === p.accn) continue;
        if (eq(f.val * (rate ?? NaN), oldV))
          return `판본: 기존 = ${c} ${f.prov.form} ${f.prov.accn}(제출 ${f.prov.filed}), 새 = 최신 판본 ${p.form} ${p.accn}(제출 ${p.filed})`;
      }
    }
  }
  return null;
}

const report = [];
const summary = [];
for (const sym of symbols) {
  const t0 = Date.now();
  let nw, old, reader;
  try {
    nw = await fin.assemble("us", sym, { persist: false });
    reader = await UsReader.open(sym);
    old = await oldValues(sym);
  } catch (e) {
    console.error(`${sym} 실패: ${e.message}`);
    summary.push({ sym, error: e.message });
    continue;
  }
  const rev = nw.metrics.revenue.values;
  const specs = new Map();
  const allQ = reader.quarterCols(1000);
  for (const c of [...reader.annualCols(10), ...allQ.slice(-20)]) specs.set(c.key, c);
  const ltm = reader.ltmCol(allQ);
  if (ltm) specs.set("LTM", ltm);
  const cells = [];
  for (const [src, vals] of Object.entries(old))
    for (const [key, ov] of Object.entries(vals)) cells.push({ src, key, old: ov });
  // 기존 분기 표 범위 안의 새 Q4D 열(기존엔 없음) — D5
  const qKeys = Object.keys(old.isQ).filter((k) => k !== "LTM").sort();
  if (qKeys.length)
    for (const a of nw.quarterly)
      if (a.col.kind === "Q4D" && a.col.key > qKeys[0] && a.col.key < qKeys[qKeys.length - 1] && !(a.col.key in old.isQ))
        cells.push({ src: "isQ", key: a.col.key, old: null });
  const counts = { 1: 0, 2: 0, 3: 0 };
  for (const cell of cells) {
    const mv = rev[cell.key];
    const nv = mv?.v ?? null;
    let cls, why;
    if (cell.old == null && nv == null) { cls = 1; why = "양쪽 빈칸"; }
    else if (eq(nv, cell.old)) { cls = 1; why = "일치"; }
    else if (cell.old == null) {
      const kind = nw.quarterly.find((a) => a.col.key === cell.key)?.col.kind;
      if (kind === "Q4D") { cls = 2; why = "신규 채움: Q4 파생 열(연간 − 9개월, D5 해결)"; }
      else if (nw.profile.type === "broker" && mv.rule === "net") { cls = 2; why = "신규 채움: 증권사 순수익(D1 해결)"; }
      else { cls = 3; why = `기존 빈칸 → 새 값(${mv?.rule})`; }
    } else if (nv == null) { cls = 3; why = `새 경로 빈칸(${mv?.rule ?? "열 없음"}, gaps ${fin.gapNames(mv?.gaps ?? 0).join(",")})`; }
    else {
      const e = await explain(reader, specs.get(cell.key), cell.old, mv);
      if (e) { cls = 2; why = e; }
      else { cls = 3; why = `원인 미상(${mv.rule}, ${mv.line})`; }
    }
    counts[cls]++;
    report.push({ sym, ...cell, new: nv, cls, why, rule: mv?.rule ?? null, line: mv?.line ?? null });
  }
  summary.push({ sym, type: nw.profile.type, filer: nw.profile.filer, cells: cells.length, c1: counts[1], c2: counts[2], c3: counts[3], sec: ((Date.now() - t0) / 1000).toFixed(0) });
  console.log(`${sym.padEnd(5)} ${nw.profile.type}/${nw.profile.filer} 칸 ${cells.length} ①${counts[1]} ②${counts[2]} ③${counts[3]} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  for (const r of report.filter((r) => r.sym === sym && r.cls !== 1))
    console.log(`   ${r.cls === 2 ? "②" : "③"} ${r.src.padEnd(4)} ${r.key.padEnd(7)} 기존 ${M(r.old).padStart(12)} 새 ${M(r.new).padStart(12)}  ${r.why}`);
}
const out = arg("out");
if (out) writeFileSync(out, JSON.stringify({ summary, report }, null, 1));
process.exit(0);
