#!/usr/bin/env node
/**
 * EDINET 날짜별 서류 목록을 공유 보관소에 채운다(확정일만 저장 — 최근 2일은 저장하지 않음). 서류 찾기(R-JP1)의 입력.
 * 이미 보관된 날짜는 요청하지 않는다(두 번째 실행 요청 0). 하루 상한(EDINET_DAILY_CAP_VERIFY)에 닿으면 멈추고 남은 날짜 수를 알린다.
 * 실행: RAW_STORE_DIR=… node scripts/verify/raw/jp/scan-lists.mjs --from=2020-04-01 [--to=YYYY-MM-DD]
 */
import { join } from "node:path";
import { loadEnv } from "../common/env.mjs";
import { openStore } from "../common/store.mjs";
import { makeEdinet } from "./edinet.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]));
const env = loadEnv();
const store = openStore({ root: env.RAW_STORE_DIR, actor: "verify" });
const ed = makeEdinet({ store, quotaRoot: join(env.RAW_STORE_DIR, "quota"), key: env.EDINET_API_KEY });
const to = String(args.to ?? new Date(Date.now() + 9 * 3600e3 - 2 * 864e5).toISOString().slice(0, 10));
const from = String(args.from ?? "2020-04-01");
let d = to, n = 0, fetched = 0, failed = [];
for (let guard = 0; d >= from && guard < 4000; guard++) {
  try {
    const r = await ed.dayList(d);
    n++;
    if (!r.fromStore) fetched++;
  } catch (e) {
    if (e.code === "quota_stop") { console.log(`상한 도달 — ${d} 에서 멈춤`); break; }
    failed.push({ d, why: String(e.message).slice(0, 120) });
  }
  if (n % 100 === 0) process.stdout.write(`${d} (${n}, 새로 ${fetched}) `);
  d = new Date(Date.parse(`${d}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
}
console.log(`\n날짜 ${n} · 새로 받음 ${fetched} · 실패 ${failed.length} · 요청 ${ed.log.requests}`);
for (const f of failed.slice(0, 20)) console.log("  실패", f.d, f.why);
