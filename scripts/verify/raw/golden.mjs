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
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const cases = JSON.parse(readFileSync(new URL("./golden/cases.json", import.meta.url), "utf8")).cases.filter((c) => !only || new RegExp(only).test(c.id)); // --only=정규식(사례 id) — 심은 오류 시험용
const store = openStore({ root: env.RAW_STORE_DIR, actor: "verify" });
const quotaRoot = join(env.RAW_STORE_DIR, online ? "quota" : "quota-t2");
const fetchImpl = online ? undefined : async (u) => { throw new Error(`네트워크 막음(golden): ${String(u).slice(0, 60)}`); };
const runs = new Map();
const JP_TO = "2026-10-14"; // 오프라인 재현용 일본 목록 끝 날짜(보관소에 있는 마지막 날)

async function run(c) {
  const k = `${c.market}|${c.sym}|${c.sixk ? 1 : 0}|${c.inject ?? ""}`;
  if (runs.has(k)) return runs.get(k);
  let r;
  if (c.market === "us") {
    const { makeSec } = await import("./us/sec.mjs");
    const { runUs } = await import("./us/adapter.mjs");
    const sec = makeSec({ store, quotaRoot, env, fetchImpl, replay: !online });
    const tick = await sec.tickers();
    const cik = c.sym === "XOM" ? "34088" : String(Object.values(tick.json).find((x) => x.ticker === c.sym)?.cik_str);
    r = await runUs(sec, { sym: c.sym, cik, maxAnnual: 6, maxQuarterly: 0, withSixK: !!c.sixk });
  } else if (c.market === "kr") {
    const { makeDart } = await import("./kr/dart.mjs");
    const { runKr } = await import("./kr/adapter.mjs");
    const dart = makeDart({ store, quotaRoot, key: env.DART_API_KEY, fetchImpl, replay: !online });
    // inject = 그 조회를 실패로 바꿔 실패가 failures·빈칸 사유로 남는지 본다(감사 10-16 3차 ③-4 — 정적 검사 t8 만으로는 기록을 지워도 통과했다)
    if (c.inject) dart[c.inject] = async () => { throw Object.assign(new Error(`심은 조회 실패(golden inject ${c.inject})`), { code: "fetch_failed" }); };
    r = await runKr(dart, { sym: c.sym, quarters: 0 });
  } else {
    const { makeEdinet } = await import("./jp/edinet.mjs");
    const { prepareJp, runJp } = await import("./jp/adapter.mjs");
    const ed = makeEdinet({ store, quotaRoot, key: env.EDINET_API_KEY, fetchImpl, replay: !online });
    // 목록 끝 날짜를 고정 — 날마다 늘면 오프라인 재현이 깨진다(감사 10-16 2차 ④)
    const to = online ? new Date(Date.now() + 9 * 3600e3 - 2 * 864e5).toISOString().slice(0, 10) : JP_TO;
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
    const fs = r.rawFacts.filter((f) => f.locator?.source === c.rawfact && f.concept.id === c.concept && f.period.kind === c.kind && f.period.end === c.end && (c.months == null || f.period.months === c.months)
      && (c.accn == null || f.filing.id === c.accn) && (c.value_is == null || f.value.num === c.value_is));
    const why = [];
    // RawFact 판본 표시(반올림 재태깅 R-US1) — 그 값 사실에 rounded_retag_of_first 가 기대 단위로(감사 10-16 2차 U1). 0 = 표시가 없어야(감사 10-16 3차)
    if (c.vintage_rounded != null) {
      if (!fs.length) why.push(`값 ${c.value_is} 사실 없음`);
      else if (!fs.every((f) => (f.vintage?.rounded_retag_of_first ?? 0) === c.vintage_rounded)) why.push(`반올림 재태깅 표시 ${fs.map((f) => f.vintage?.rounded_retag_of_first ?? "없음").join(",")} ≠ ${c.vintage_rounded}`);
      if (why.length) { fail++; console.log(`실패 ${c.id}: ${why.join(" · ")}`); } else { pass++; console.log(`통과 ${c.id}`); }
      continue;
    }
    if (c.absent) { if (fs.length) why.push(`있으면 안 되는 사실 ${fs.length}건 — ${fs.map((f) => f.value.num).join(",")}`); }
    else if (fs.length !== 1 || fs[0].value.num !== c.value) why.push(`사실 ${fs.length}건 — ${fs.map((f) => f.value.num).join(",") || "없음"} (기대 ${c.value})`);
    if (why.length) { fail++; console.log(`실패 ${c.id}: ${why.join(" · ")}`); } else { pass++; console.log(`통과 ${c.id}`); }
    continue;
  }
  const its = r.items.filter((i) => i.key === c.key && (c.end ? i.period.end === c.end : i.period.fy_key === c.end_year)
    && (c.kind === "instant" ? i.period.kind === "instant" : c.months ? i.period.months === c.months : true)
    && (c.filing_year == null || String(i.vintage_basis?.filing ?? "").startsWith(String(c.filing_year + 1)))
    && (c.filing == null || i.vintage_basis?.filing === c.filing)); // filing = 그 서류의 Item 만(편의 환산 USD 는 그해 20-F 에만 있다)
  const why = [];
  // 연결 서류에서 별도(개별) Item 이 새는지(감사 10-16 J1) — scope_absent 사례
  if (c.scope_absent) {
    const bad = r.items.filter((i) => i.key === c.key && i.scope?.consolidation === c.scope_absent && (c.end ? i.period.end === c.end : true));
    if (bad.length) why.push(`${c.scope_absent} Item ${bad.length}건 — ${bad.slice(0, 3).map((i) => i.value).join(",")}`);
    if (why.length) { fail++; console.log(`실패 ${c.id}: ${why.join(" · ")}`); } else { pass++; console.log(`통과 ${c.id}`); }
    continue;
  }
  // 값 판정은 가장 나중 서류의 Item 으로(「하나라도 같으면 통과」 금지 — 감사 10-16 ③-4). values_include 는 여러 판본 사례용
  const latestFiled = its.map((i) => i.vintage_basis?.filed_at ?? "").sort().at(-1);
  const latest = its.filter((i) => (i.vintage_basis?.filed_at ?? "") === latestFiled);
  if (c.present && !its.some((i) => i.value != null)) why.push(`값 있는 Item 없음 — ${its.map((i) => i.value ?? `빈칸:${i.blank_reason}`).join(",")}`);
  if (!its.length) why.push(`Item 없음(실패 ${r.failures.length}: ${r.failures.slice(0, 2).map((f) => f.stage + " " + f.message).join(" / ").slice(0, 160)})`);
  if (c.value != null && !(latest.length && latest.every((i) => i.value === c.value))) why.push(`가장 나중 서류 값 ≠ ${c.value} — ${[...new Set(latest.map((i) => i.value ?? `빈칸:${i.blank_reason}`))].join(", ") || "없음"}`);
  if (c.values_include) for (const v of c.values_include) if (!its.some((i) => i.value === v)) why.push(`값 ${v} 없음`);
  if (c.rounded_retag_value && !its.some((i) => i.value === c.rounded_retag_value && i.flags?.rounded_retag_of_first)) why.push(`반올림 재태깅 ${c.rounded_retag_value} 표시 없음`);
  if (c.blank_reason && !its.some((i) => i.value == null && i.blank_reason === c.blank_reason)) why.push(`빈칸 사유 ${c.blank_reason} 없음 — ${its.map((i) => i.value ?? i.blank_reason).join(",")}`);
  if (c.expect_failure_stage && !r.failures.some((f) => f.stage === c.expect_failure_stage)) why.push(`실행 failures 에 ${c.expect_failure_stage} 없음 — ${[...new Set(r.failures.map((f) => f.stage))].join(",") || "없음"}`);
  if (c.flags) for (const [fk, fv] of Object.entries(c.flags)) if (!its.some((i) => (c.value == null || i.value === c.value) && i.flags?.[fk] === fv)) why.push(`표시 ${fk}=${fv} 없음`);
  if (why.length) { fail++; console.log(`실패 ${c.id}: ${why.join(" · ")}`); } else { pass++; console.log(`통과 ${c.id}`); }
}
// 실행 단위 failures(조회·판독 실패) — 사례가 다 통과해도 실행에 실패가 있으면 그 종목 결과는 완전하지 않다(감사 10-16 3차 ⑧).
// 보관소에 원본이 없는 알려진 실패는 cases.json known_run_failures 에 「단계 + 메시지 앞부분」으로 적고, 그 밖의 실패는 실패로 센다(심은 실패 inject 실행 제외)
const known = JSON.parse(readFileSync(new URL("./golden/cases.json", import.meta.url), "utf8")).known_run_failures ?? {};
for (const [k, r] of runs) {
  if (k.split("|")[3]) continue;
  const runKey = k.split("|").slice(0, 3).join("|");
  const allow = known[runKey] ?? [];
  const extra = r.failures.filter((f) => !allow.some((a) => f.stage === a.stage && String(f.message ?? "").includes(a.message)));
  const unused = allow.filter((a) => !r.failures.some((f) => f.stage === a.stage && String(f.message ?? "").includes(a.message)));
  if (extra.length || unused.length) {
    fail++;
    console.log(`실패 실행 ${runKey}: 알려지지 않은 failures ${extra.length}건${extra.length ? " — " + extra.slice(0, 5).map((f) => `${f.stage}: ${String(f.message).slice(0, 100)}`).join(" / ") : ""}${unused.length ? ` · 사라진 알려진 실패 ${unused.length}건(목록 갱신 필요)` : ""}`);
  } else if (r.failures.length) console.log(`실행 ${runKey}: 알려진 failures ${r.failures.length}건(known_run_failures — 원인 확인됨)`);
}
console.log(`\n통과 ${pass} · 실패 ${fail} · 원본 없음 ${noSrc}`);
process.exit(fail || noSrc ? 1 : 0);
