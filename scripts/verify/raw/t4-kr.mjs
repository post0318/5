#!/usr/bin/env node
/**
 * 시험 T4(설계 10 §7-4) 한국 — 옛 검증기 A층(DART 직접, 최신 판본)이 읽은 값(src)과 새 ① 출력 Item(최신 보고서)을 칸마다 대조.
 * 실행: RAW_STORE_DIR=… node scripts/verify/raw/t4-kr.mjs --old=<옛 결과 json> [--symbols=005930,...]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "./common/env.mjs";
import { openStore } from "./common/store.mjs";
import { makeDart } from "./kr/dart.mjs";
import { runKr } from "./kr/adapter.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]));
const env = loadEnv();
const old = JSON.parse(readFileSync(String(args.old), "utf8"));
const store = openStore({ root: env.RAW_STORE_DIR, actor: "verify" });
const dart = makeDart({ store, quotaRoot: join(env.RAW_STORE_DIR, "quota"), key: env.DART_API_KEY });

const MAP = [
  [/^매출액 = DART$/, "revenue"], [/^영업이익 = DART$/, "oi"], [/^세전이익 = DART$/, "pretax"],
  [/^당기순이익\(연결\) = DART$/, "ni_total"], [/^당기순이익\(지배\) = DART$/, "ni_parent"],
  [/^자산총계 = DART$/, "assets"], [/^부채총계 = DART$/, "liabilities"], [/^자본총계 = DART$/, "equity_total"],
  [/^지배주주 지분 = DART$/, "equity_parent"], [/^비지배지분 = DART$/, "nci_equity"],
  [/^유동자산 = DART$/, "current_assets"], [/^유동부채 = DART$/, "current_liabilities"], [/^현금및현금성자산 = DART$/, "cash_and_equivalents"],
  [/^영업활동 현금흐름 = DART$/, "ocf"], [/^투자활동 현금흐름 = DART$/, "icf"], [/^재무활동 현금흐름 = DART$/, "fcf_financing"],
  [/^기본 EPS = DART$/, "eps_basic_total"], [/^희석 EPS = DART$/, "eps_diluted_total"],
];
const want = args.symbols ? String(args.symbols).split(",") : old.results.map((r) => r.sym);
const out = { at: new Date().toISOString(), old: String(args.old), rows: [], summary: {}, failures: [] };
for (const sym of want) {
  const oldR = old.results.find((r) => r.sym === sym);
  if (!oldR) continue;
  let r;
  try {
    r = await runKr(dart, { sym, quarters: 0 });
  } catch (e) {
    out.failures.push({ sym, stage: "run", code: e.code ?? "error", message: String(e.message).slice(0, 200) });
    if (e.code === "quota_stop") break;
    continue;
  }
  for (const f of r.failures) out.failures.push({ sym, ...f });
  for (const c of oldR.checks) {
    if (c.layer !== "A" || !/^\d{4}Y$/.test(c.col ?? "")) continue;
    const m = MAP.find(([re]) => re.test(c.name));
    if (!m) continue;
    const key = m[1];
    const fy = Number(c.col.slice(0, 4));
    // 그 사업연도 열(사업보고서 열 — 12개월·연말) 중 가장 나중 보고서(접수번호) — 연결 우선
    const cands = r.items.filter((i) => i.key === key && i.period.fy_key === fy && (i.period.kind === "instant" ? /-12-31$/.test(i.period.end) : i.period.months === 12) && i.vintage_basis?.form === "11011");
    cands.sort((a, b) => (b.vintage_basis.filing ?? "").localeCompare(a.vintage_basis.filing ?? ""));
    const latest = cands[0] ?? null;
    const newV = latest?.value ?? null;
    const oldV = c.src ?? null;
    const eq = (a, b) => (a == null || b == null ? false : Number(a) === Number(b));
    const status = newV == null && oldV == null ? "both_blank" : newV == null ? "new_blank" : oldV == null ? "old_blank" : eq(newV, oldV) ? "match" : "diff";
    out.rows.push({ sym, key, fy, status, old: oldV, new: newV, newFiling: latest?.vintage_basis?.filing ?? null, newCol: latest?.vintage_basis?.field ?? null, newBlank: latest?.blank_reason ?? (latest ? null : "no_item"), fs: latest?.scope?.consolidation ?? null, oldNote: c.note ?? null });
  }
  process.stdout.write(`${sym} `);
}
for (const row of out.rows) {
  const s = (out.summary[row.key] ??= { match: 0, diff: 0, new_blank: 0, old_blank: 0, both_blank: 0 });
  s[row.status]++;
}
out.fetchLog = dart.log;
mkdirSync("reports", { recursive: true });
const f = join("reports", `raw-t4-kr-${out.at.replace(/[:.]/g, "-")}.json`);
writeFileSync(f, JSON.stringify(out, null, 1));
console.log(`\n${JSON.stringify(out.summary)}\n실패 ${out.failures.length} · DART 요청 ${dart.log.requests} · 결과 ${f}`);
