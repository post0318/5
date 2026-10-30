/**
 * 일본 X층 외부 원문 미리 받기 — node scripts/verify-jp/ext-prefetch.mjs --symbols=7203,6758,…
 * 검증기(scripts/verify-financials.mjs --market=jp)와 같은 캐시·열쇠(최신 有報 docID)·요청 간격(株探 3초·그 밖 1.5초)을 쓴다(ext.mjs). 개발 서버를 쓰지 않아
 * 검증 잠금(/tmp/macro-verify.lock) 밖에서 돌려도 된다. 이미 받은 것은 다시 받지 않는다 — 끝에 외부 요청 수를 찍는다(두 번째 실행은 0 이어야 한다).
 * 판독 결과도 함께 확인한다(소스별 연도 행 수). 실패한 소스는 끝에 모아 보이고 종료코드 1.
 */
import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { configureEdinet, edinetStats } from "./edinet.mjs";
import { configureJpLayers, jpLatestAnnualRow } from "./layers.mjs";
import { configureJpExt, jpExtSources, extStats, SRC_NAME } from "./ext.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => /^--([a-z-]+)=(.*)$/.exec(a)).filter(Boolean).map((m) => [m[1], m[2]]));
const env = { ...process.env };
try {
  for (const line of readFileSync(new URL("../../.env.local", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*?)"?\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
} catch (e) { console.warn(`.env.local 읽기 실패 — 환경 변수만 씀(${e.message})`); }
configureEdinet({ key: env.EDINET_API_KEY, root: pathResolve(env.JP_VERIFY_CACHE_DIR || "reports/.edinet-cache") });
configureJpLayers({ from: args["jp-from"] ?? null });
configureJpExt({ root: env.JP_VERIFY_EXT_CACHE_DIR ? pathResolve(env.JP_VERIFY_EXT_CACHE_DIR) : null });
const syms = String(args.symbols ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!syms.length) { console.error("--symbols= 필요"); process.exit(2); }
const failed = [];
for (const s of syms) {
  const row = await jpLatestAnnualRow(s);
  if (!row) { failed.push(`${s} 최신 有報 목록 행 없음`); console.log(`${s} 최신 有報 없음`); continue; }
  const r = await jpExtSources(s, row.docID, row.submitDateTime.slice(0, 10));
  console.log(`${s} ${row.docID} ${Object.entries(r).map(([k, v]) => `${SRC_NAME[k]} ${v.error ? `실패(${v.error})` : `${Object.keys(v.parsed).length}행·${v.from}`}`).join(" · ")}`);
  for (const [k, v] of Object.entries(r)) if (v.error) failed.push(`${s} ${SRC_NAME[k]} ${v.error}`);
}
console.log(`외부 요청 ${extStats.requests}(${Object.entries(extStats.byHost).map(([h, n]) => `${h} ${n}`).join(" · ") || "없음"}) · 캐시 적중 ${extStats.cacheHit} · 실패 저장 ${extStats.failedStored} · EDINET 요청 ${edinetStats.requests}`);
for (const f of failed) console.log(`  실패 ${f}`);
process.exit(failed.length ? 1 : 0);
