#!/usr/bin/env node
/**
 * 시험 T4(설계 10 §7-4) 미국 — 옛 검증기 A층이 읽은 SEC 원자료 값(결과 파일의 src)과 새 ① 출력(Item, 최신 판본)을 칸마다 대조.
 * 다르면 둘 다 기록한다(어느 쪽이 원문과 맞는지는 locator 로 사람이 가린다 — 이 스크립트는 판정하지 않음).
 *
 * 실행: RAW_STORE_DIR=… node scripts/verify/raw/t4-us.mjs --old=<옛 결과 json> [--symbols=AAPL,MSFT]
 * 출력: reports/raw-t4-us-<시각>.json + 요약
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "./common/store.mjs";
import { makeSec } from "./us/sec.mjs";
import { runUs } from "./us/adapter.mjs";
import { loadEnv } from "./common/env.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]));
const env = loadEnv();
const old = JSON.parse(readFileSync(String(args.old), "utf8"));
const store = openStore({ root: env.RAW_STORE_DIR, actor: "verify" });
const sec = makeSec({ store, quotaRoot: join(env.RAW_STORE_DIR, "quota"), env });

// 옛 A층 이름 → 새 Item 키(정의가 같은 것만 — 분할 보정 EPS·LTM·합성 값은 ④ 몫이라 제외)
const MAP = [
  [/^순이익 앱 = SEC 지배주주 순이익$/, "ni_parent"],
  [/^자산총계 앱 = SEC 자산총계$/, "assets"],
  [/^재무상태표 현금·현금성자산 앱 = SEC$/, "cash_and_equivalents", "cash_incl_restricted", "cash_incl_discontinued"],
  [/^현금흐름표 영업활동 현금흐름 앱 = SEC$/, "ocf"],
  [/^현금흐름표 유형자산 취득\(CAPEX\) 앱 = SEC$/, "capex_ppe_line"],
  [/^감가상각비 앱 = SEC 현금흐름표 감가상각·상각 줄 합$/, "da_cf_lines"],
  [/^세전이익 앱 = SEC 세전이익$/, "pretax_incl_equity_method", "pretax_before_equity_method", "pretax_face_line"],
];

const tick = await sec.tickers();
const cikOf = (s) => (s === "XOM" ? "34088" : String(Object.values(tick.json).find((x) => x.ticker === s.replace(".", "-"))?.cik_str ?? ""));
const want = args.symbols ? String(args.symbols).split(",") : old.symbols ?? old.results.map((r) => r.sym);
const out = { at: new Date().toISOString(), old: String(args.old), rows: [], summary: {}, failures: [] };

for (const sym of want) {
  const oldR = old.results.find((r) => r.sym === sym);
  if (!oldR) continue;
  const cik = cikOf(sym);
  let r;
  try {
    r = await runUs(sec, { sym, cik, maxAnnual: 6, maxQuarterly: 0 });
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
    const keys = m.slice(1);
    const fy = Number(c.col.slice(0, 4));
    // 그 사업연도(12개월·결산일 연도 = fy, 재무상태표는 시점) 의 Item 중 가장 나중 서류
    // 정기 연간 서류(10-K·20-F·40-F 와 그 정정)의 값만, 반올림 재태깅은 빼고(④ 규칙 흉내 — 판정 아님)
    const ANNUAL = /^(10-K|20-F|40-F|10-KT)(\/A)?$/;
    const cands = r.items.filter((i) => keys.includes(i.key) && i.period.fy_key === fy && (i.period.kind === "instant" || i.period.months === 12)
      && ANNUAL.test(i.vintage_basis?.form ?? "") && !i.flags?.rounded_retag_of_first);
    const key = keys.join("|");
    // 사업연도 결산일 — 같은 fy_key 의 10-K 결산일과 같은 칸만
    const fyEnd = r.filings.find((f) => /^(10-K|20-F|40-F)$/.test(f.form) && f.period_end && Number(f.period_end.slice(0, 4)) - (f.period_end.slice(5, 7) === "01" && Number(f.period_end.slice(8, 10)) <= 7 ? 1 : 0) === fy)?.period_end;
    const atEnd = cands.filter((i) => !fyEnd || i.period.end === fyEnd);
    atEnd.sort((a, b) => (b.vintage_basis?.filed_at ?? "").localeCompare(a.vintage_basis?.filed_at ?? ""));
    // 정의가 둘인 키(세전이익)는 옛 값과 같은 쪽이 있으면 그 쪽(어느 정의였는지 기록)
    const latest = keys.length > 1 ? (atEnd.find((i) => c.src != null && String(Math.abs(Number(i.value))) === String(Math.abs(Number(c.src)))) ?? atEnd[0] ?? null) : atEnd[0] ?? null;
    const newV = latest?.value ?? null;
    const oldV = c.src ?? null;
    const norm = (v) => (v == null ? null : String(Math.abs(Number(v))));
    const status = newV == null && oldV == null ? "both_blank" : newV == null ? "new_blank" : oldV == null ? "old_blank" : norm(newV) === norm(oldV) ? "match" : "diff";
    out.rows.push({ sym, key, fy, status, old: oldV, new: newV, newFiling: latest?.vintage_basis?.filing ?? null, newRule: latest?.rule ?? null, newBlank: latest?.blank_reason ?? (latest ? null : "no_item"), oldNote: c.note ?? null });
  }
  process.stdout.write(`${sym} `);
}
for (const row of out.rows) {
  const s = (out.summary[row.key] ??= { match: 0, diff: 0, new_blank: 0, old_blank: 0, both_blank: 0 });
  s[row.status]++;
}
out.fetchLog = sec.log;
mkdirSync("reports", { recursive: true });
const f = join("reports", `raw-t4-us-${out.at.replace(/[:.]/g, "-")}.json`);
writeFileSync(f, JSON.stringify(out, null, 1));
console.log(`\n${JSON.stringify(out.summary, null, 1)}\n실패 ${out.failures.length} · SEC 요청 ${sec.log.requests} · 결과 ${f}`);
