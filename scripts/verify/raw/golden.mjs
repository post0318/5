#!/usr/bin/env node
/**
 * 시험 T1·T7 — golden/cases.json 의 사례마다 ① 을 네트워크를 막고(보관소만) 돌려 기대값과 대조. 보관소에 원본이 없으면 그 사례는 「원본 없음」(통과 아님).
 * 실행: RAW_STORE_DIR=… node scripts/verify/raw/golden.mjs [--online](보관소에 없는 원본을 받아도 되면)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "./common/env.mjs";
import { openStore } from "./common/store.mjs";

const online = process.argv.includes("--online");
const env = loadEnv();
const cases = JSON.parse(readFileSync(new URL("./golden/cases.json", import.meta.url), "utf8")).cases;
const store = openStore({ root: env.RAW_STORE_DIR, actor: "verify" });
const quotaRoot = join(env.RAW_STORE_DIR, online ? "quota" : "quota-t2");
const fetchImpl = online ? undefined : async (u) => { throw new Error(`네트워크 막음(golden): ${String(u).slice(0, 60)}`); };
const runs = new Map();

async function run(c) {
  const k = `${c.market}|${c.sym}|${c.sixk ? 1 : 0}`;
  if (runs.has(k)) return runs.get(k);
  let r;
  if (c.market === "us") {
    const { makeSec } = await import("./us/sec.mjs");
    const { runUs } = await import("./us/adapter.mjs");
    const sec = makeSec({ store, quotaRoot, env, fetchImpl });
    const tick = await sec.tickers();
    const cik = c.sym === "XOM" ? "34088" : String(Object.values(tick.json).find((x) => x.ticker === c.sym)?.cik_str);
    r = await runUs(sec, { sym: c.sym, cik, maxAnnual: 6, maxQuarterly: 0, withSixK: !!c.sixk });
  } else if (c.market === "kr") {
    const { makeDart } = await import("./kr/dart.mjs");
    const { runKr } = await import("./kr/adapter.mjs");
    r = await runKr(makeDart({ store, quotaRoot, key: env.DART_API_KEY, fetchImpl }), { sym: c.sym, quarters: 0 });
  } else {
    const { makeEdinet } = await import("./jp/edinet.mjs");
    const { prepareJp, runJp } = await import("./jp/adapter.mjs");
    const ed = makeEdinet({ store, quotaRoot, key: env.EDINET_API_KEY, fetchImpl });
    const to = new Date(Date.now() + 9 * 3600e3 - 2 * 864e5).toISOString().slice(0, 10);
    await prepareJp(ed, { syms: [c.sym], from: "2020-04-01", to });
    r = await runJp(ed, { sym: c.sym });
  }
  runs.set(k, r);
  return r;
}

let pass = 0, fail = 0, noSrc = 0;
for (const c of cases) {
  let r;
  try {
    r = await run(c);
  } catch (e) {
    console.log(`원본 없음/실행 실패 ${c.id}: ${String(e.message).slice(0, 120)}`);
    noSrc++;
    continue;
  }
  if (c.rawfact) {
    // RawFact 사례(6-K 등 Item 이 없는 판독) — 같은 개념·기간 종류·끝 날짜의 사실이 정확히 하나이고 값이 같아야(absent: 없어야) 통과
    const fs = r.rawFacts.filter((f) => f.locator?.source === c.rawfact && f.concept.id === c.concept && f.period.kind === c.kind && f.period.end === c.end && (c.months == null || f.period.months === c.months));
    const why = [];
    if (c.absent) { if (fs.length) why.push(`있으면 안 되는 사실 ${fs.length}건 — ${fs.map((f) => f.value.num).join(",")}`); }
    else if (fs.length !== 1 || fs[0].value.num !== c.value) why.push(`사실 ${fs.length}건 — ${fs.map((f) => f.value.num).join(",") || "없음"} (기대 ${c.value})`);
    if (why.length) { fail++; console.log(`실패 ${c.id}: ${why.join(" · ")}`); } else { pass++; console.log(`통과 ${c.id}`); }
    continue;
  }
  const its = r.items.filter((i) => i.key === c.key && (c.end ? i.period.end === c.end : i.period.fy_key === c.end_year)
    && (c.kind === "instant" ? i.period.kind === "instant" : c.months ? i.period.months === c.months : true)
    && (c.filing_year == null || String(i.vintage_basis?.filing ?? "").startsWith(String(c.filing_year + 1))));
  const why = [];
  if (!its.length) why.push(`Item 없음(실패 ${r.failures.length}: ${r.failures.slice(0, 2).map((f) => f.stage + " " + f.message).join(" / ").slice(0, 160)})`);
  if (c.value != null && !its.some((i) => i.value === c.value)) why.push(`값 ${c.value} 없음 — 있는 값 ${[...new Set(its.map((i) => i.value ?? `빈칸:${i.blank_reason}`))].join(", ")}`);
  if (c.values_include) for (const v of c.values_include) if (!its.some((i) => i.value === v)) why.push(`값 ${v} 없음`);
  if (c.rounded_retag_value && !its.some((i) => i.value === c.rounded_retag_value && i.flags?.rounded_retag_of_first)) why.push(`반올림 재태깅 ${c.rounded_retag_value} 표시 없음`);
  if (c.blank_reason && !its.some((i) => i.value == null && i.blank_reason === c.blank_reason)) why.push(`빈칸 사유 ${c.blank_reason} 없음 — ${its.map((i) => i.value ?? i.blank_reason).join(",")}`);
  if (c.flags) for (const [fk, fv] of Object.entries(c.flags)) if (!its.some((i) => (c.value == null || i.value === c.value) && i.flags?.[fk] === fv)) why.push(`표시 ${fk}=${fv} 없음`);
  if (why.length) { fail++; console.log(`실패 ${c.id}: ${why.join(" · ")}`); } else { pass++; console.log(`통과 ${c.id}`); }
}
console.log(`\n통과 ${pass} · 실패 ${fail} · 원본 없음 ${noSrc}`);
process.exit(fail || noSrc ? 1 : 0);
