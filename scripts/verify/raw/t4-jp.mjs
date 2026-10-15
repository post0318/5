#!/usr/bin/env node
/**
 * 시험 T4 일본 — 옛 검증기 A층 「주요 항목 … — 본표」 값(src)과 새 ① 출력 Item(가장 나중 서류)을 칸마다 대조.
 * 실행: RAW_STORE_DIR=… node scripts/verify/raw/t4-jp.mjs --old=<옛 결과 json> [--symbols=7203,…] [--from=2020-04-01]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "./common/env.mjs";
import { openStore } from "./common/store.mjs";
import { makeEdinet } from "./jp/edinet.mjs";
import { prepareJp, runJp } from "./jp/adapter.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]));
const env = loadEnv();
const old = JSON.parse(readFileSync(String(args.old), "utf8"));
const store = openStore({ root: env.RAW_STORE_DIR, actor: "verify" });
const ed = makeEdinet({ store, quotaRoot: join(env.RAW_STORE_DIR, "quota"), key: env.EDINET_API_KEY });
const MAP = [
  [/^주요 항목 매출 — 본표$/, ["revenue_face", "revenue"]], [/^주요 항목 영업이익 — 본표$/, ["oi"]], [/^주요 항목 경상이익 — 본표$/, ["ordinary_income"]],
  [/^주요 항목 세전이익 — 본표$/, ["pretax"]], [/^주요 항목 순이익\(지배\) — 본표$/, ["ni_parent"]], [/^주요 항목 자산총계 — 본표$/, ["assets"]],
  [/^주요 항목 부채총계 — 본표$/, ["liabilities"]], [/^주요 항목 자본총계 — 본표$/, ["equity_total"]], [/^주요 항목 지배주주 자본 — 본표$/, ["equity_parent"]],
  [/^주요 항목 현금\(재무상태표\) — 본표$/, ["cash_bs"]], [/^주요 항목 영업활동 CF — 본표$/, ["ocf"]], [/^주요 항목 투자활동 CF — 본표$/, ["icf"]], [/^주요 항목 재무활동 CF — 본표$/, ["fcf_financing"]],
];
const want = args.symbols ? String(args.symbols).split(",") : old.results.map((r) => r.sym);
const to = new Date(Date.now() + 9 * 3600e3 - 2 * 864e5).toISOString().slice(0, 10);
const prep = await prepareJp(ed, { syms: want, from: String(args.from ?? "2020-04-01"), to });
const out = { at: new Date().toISOString(), old: String(args.old), missingDates: prep.missingDates.length, rows: [], summary: {}, failures: [] };
for (const sym of want) {
  const oldR = old.results.find((r) => r.sym === sym);
  if (!oldR) continue;
  let r;
  try {
    r = await runJp(ed, { sym });
  } catch (e) {
    out.failures.push({ sym, stage: "run", code: e.code ?? "error", message: String(e.message).slice(0, 200) });
    if (e.code === "quota_stop") break;
    continue;
  }
  for (const f of r.failures) out.failures.push({ sym, ...f });
  for (const c of oldR.checks) {
    if (c.layer !== "A" || !/^FY\d{4}$/.test(c.col ?? "")) continue;
    const m = MAP.find(([re]) => re.test(c.name));
    if (!m) continue;
    const keys = m[1];
    const fy = Number(c.col.slice(2));
    const cands = r.items.filter((i) => keys.includes(i.key) && i.period.fy_key === fy && (i.period.kind === "instant" || (i.period.months >= 11 && i.period.months <= 13)) && ["120", "130"].includes(i.vintage_basis?.form));
    cands.sort((a, b) => (b.vintage_basis.filed_at ?? "").localeCompare(a.vintage_basis.filed_at ?? "") || (a.scope.consolidation === "consolidated" ? -1 : 1));
    const pick = cands.find((i) => i.scope.consolidation === "consolidated" && i.value != null && String(i.value) === String(c.src)) ?? cands.find((i) => i.scope.consolidation === "consolidated") ?? cands[0] ?? null;
    const newV = pick?.value ?? null, oldV = c.src ?? null;
    const status = newV == null && oldV == null ? "both_blank" : newV == null ? "new_blank" : oldV == null ? "old_blank" : Number(newV) === Number(oldV) ? "match" : "diff";
    out.rows.push({ sym, key: keys.join("|"), fy, status, old: oldV, new: newV, newDoc: pick?.vintage_basis?.filing ?? null, newKey: pick?.key ?? null, newRule: pick?.rule ?? null, oldNote: c.note ?? null });
  }
  process.stdout.write(`${sym} `);
}
for (const row of out.rows) {
  const s = (out.summary[row.key] ??= { match: 0, diff: 0, new_blank: 0, old_blank: 0, both_blank: 0 });
  s[row.status]++;
}
out.fetchLog = ed.log;
mkdirSync("reports", { recursive: true });
const f = join("reports", `raw-t4-jp-${out.at.replace(/[:.]/g, "-")}.json`);
writeFileSync(f, JSON.stringify(out, null, 1));
console.log(`\n${JSON.stringify(out.summary)}\n실패 ${out.failures.length} · EDINET 요청 ${ed.log.requests} · 목록 빠진 날 ${out.missingDates} · 결과 ${f}`);
