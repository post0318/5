#!/usr/bin/env node
/**
 * 시험 T2(설계 10 §7-2) 오프라인 재현 — 네트워크를 막은 채(요청하면 즉시 실패) 같은 종목을 두 번 돌려 출력(Item·RawFact) 해시가 같고
 * 요청 시도가 0 인지 본다. 보관소가 채워진 직후(갱신형 응답 ttl 안)에 돌린다.
 * 실행: RAW_STORE_DIR=… node scripts/verify/raw/t2-offline.mjs --market=us|kr|jp --symbols=…
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadEnv } from "./common/env.mjs";
import { openStore } from "./common/store.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]));
const env = loadEnv();
const syms = String(args.symbols).split(",");
let attempts = 0;
const blocked = async (url) => {
  attempts++;
  throw new Error(`네트워크 막음(T2): ${String(url).slice(0, 60)}`);
};
const stable = (x) => JSON.stringify(x, (k, v) => (k === "fromStore" || k === "fetchLog" || k === "checkedAt" ? undefined : v));

async function once() {
  const store = openStore({ root: env.RAW_STORE_DIR, actor: "verify" });
  const quotaRoot = join(env.RAW_STORE_DIR, "quota-t2"); // 시험 요청이 실제 상한 카운터를 먹지 않게
  const h = createHash("md5");
  const summary = [];
  if (args.market === "us") {
    const { makeSec } = await import("./us/sec.mjs");
    const { runUs } = await import("./us/adapter.mjs");
    const sec = makeSec({ store, quotaRoot, env, fetchImpl: blocked });
    const tick = await sec.tickers();
    for (const s of syms) {
      const cik = s === "XOM" ? "34088" : String(Object.values(tick.json).find((x) => x.ticker === s)?.cik_str);
      const r = await runUs(sec, { sym: s, cik, maxAnnual: 6, maxQuarterly: 0 });
      h.update(stable({ items: r.items, facts: r.rawFacts.length, failures: r.failures }));
      summary.push({ s, items: r.items.length, facts: r.rawFacts.length, failures: r.failures.length });
    }
  } else if (args.market === "kr") {
    const { makeDart } = await import("./kr/dart.mjs");
    const { runKr } = await import("./kr/adapter.mjs");
    const dart = makeDart({ store, quotaRoot, key: env.DART_API_KEY, fetchImpl: blocked });
    for (const s of syms) {
      const r = await runKr(dart, { sym: s, quarters: 0 });
      h.update(stable({ items: r.items, facts: r.rawFacts.length, failures: r.failures }));
      summary.push({ s, items: r.items.length, facts: r.rawFacts.length, failures: r.failures.length });
    }
  } else if (args.market === "jp") {
    const { makeEdinet } = await import("./jp/edinet.mjs");
    const { prepareJp, runJp } = await import("./jp/adapter.mjs");
    const ed = makeEdinet({ store, quotaRoot, key: env.EDINET_API_KEY, fetchImpl: blocked });
    const to = new Date(Date.now() + 9 * 3600e3 - 2 * 864e5).toISOString().slice(0, 10);
    await prepareJp(ed, { syms, from: String(args.from ?? "2020-04-01"), to });
    for (const s of syms) {
      const r = await runJp(ed, { sym: s });
      h.update(stable({ items: r.items, facts: r.rawFacts.length, failures: r.failures.filter((f) => f.stage !== "list") }));
      summary.push({ s, items: r.items.length, facts: r.rawFacts.length, failures: r.failures.length });
    }
  } else throw new Error("--market=us|kr|jp");
  return { md5: h.digest("hex"), summary };
}

const a = await once();
const n1 = attempts;
const b = await once();
console.log(JSON.stringify({ run1: a, run2: b, sameOutput: a.md5 === b.md5, attempts1: n1, attempts2: attempts - n1 }, null, 1));
process.exit(a.md5 === b.md5 && attempts === 0 ? 0 : 1);
