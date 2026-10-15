/**
 * 일본 검증기 서류 목록 채우기 — node scripts/verify-jp/scan.mjs [--from=2021-04-01] [--to=오늘]
 * 검증기(scripts/verify-financials.mjs --market=jp)는 실행 때 빠진 날만 받지만, 처음 한 번은 약 2,000일(요청 간격 1초 — 약 35분)이라 따로 돌려 둔다.
 * 실패한 날은 끝에 모아 보이고 종료코드 1(다시 실행하면 그 날만 받는다).
 */
import { readFileSync } from "node:fs";
import { configureEdinet, dayList, addDays, edinetStats, redact } from "./edinet.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => /^--([a-z]+)=(.*)$/.exec(a)).filter(Boolean).map((m) => [m[1], m[2]]));
const env = { ...process.env };
try {
  for (const line of readFileSync(new URL("../../.env.local", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*?)"?\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
} catch { /* .env.local 없음 */ }
configureEdinet({ key: env.EDINET_API_KEY, root: env.JP_VERIFY_CACHE_DIR || "reports/.edinet-cache" });
const from = args.from ?? "2021-04-01";
const to = args.to ?? new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const failed = [];
let n = 0;
for (let d = to; d >= from; d = addDays(d, -1)) {
  try { await dayList(d); } catch (e) { failed.push(`${d} ${redact(e.message)}`); }
  if (++n % 100 === 0) console.log(`${d} — ${n}일 · 요청 ${edinetStats.requests} · 디스크 ${edinetStats.hit} · 실패 ${failed.length}`);
}
console.log(`끝 ${n}일 · 요청 ${edinetStats.requests} · 디스크 ${edinetStats.hit} · 실패 ${failed.length}`);
for (const f of failed) console.log(`  실패 ${f}`);
process.exit(failed.length ? 1 : 0);
