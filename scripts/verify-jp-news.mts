/**
 * 일본 종목 일본어 기사 판정 기준 세트 채점 — scripts/golden/jp-news.golden.json 의 사람 판정(broad·strict)과 앱 판정(judgeJapaneseTitle,
 * 이름 묶음은 앱과 같은 jaNamesFor — EDINET 상장사 목록을 받는다)을 비교해 묶음(set)별 정밀도·재현율을 낸다. DB·외부 뉴스 요청 없음.
 * 실행: NODE_OPTIONS=--conditions=react-server npx -y tsx@4.23.15 --tsconfig tsconfig.json scripts/verify-jp-news.mts [--detail]
 */
import { readFileSync } from "node:fs";
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());
const { judgeJapaneseTitle } = await import("../src/lib/markets/news-rules");
const { jaNamesFor } = await import("../src/lib/markets/news");
const { getEdinetCodeIndex } = await import("../src/lib/markets/jp/edinetcode");

type Item = { set: string; symbol: string; no: number; title: string; publisher: string; broad: boolean; strict: boolean };
const golden = JSON.parse(readFileSync(new URL("./golden/jp-news.golden.json", import.meta.url), "utf8")) as { sets: Record<string, string>; items: Item[] };
const detail = process.argv.includes("--detail");
const idx = await getEdinetCodeIndex();

const names = new Map<string, Awaited<ReturnType<typeof jaNamesFor>>>();
for (const sym of new Set(golden.items.map((i) => i.symbol))) {
  const e = idx.byTicker.get(sym);
  if (!e) throw new Error(`EDINET 에 없는 종목 ${sym}`);
  names.set(sym, await jaNamesFor(sym, e.name, e.nameEng));
}

for (const label of ["broad", "strict"] as const) {
  console.log(`\n== 정답 기준 ${label} — ${(golden as unknown as { labels: Record<string, string> }).labels?.[label] ?? ""}`);
  for (const set of Object.keys(golden.sets)) {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    const rows = golden.items.filter((i) => i.set === set);
    for (const it of rows) {
      const n = names.get(it.symbol);
      const v = n ? judgeJapaneseTitle(it.title, it.publisher, n) : { keep: false, reason: "이름 없음" };
      const truth = it[label];
      if (v.keep && truth) tp++;
      else if (v.keep) fp++;
      else if (truth) fn++;
      else tn++;
      if (detail && v.keep !== truth) console.log(`   ${v.keep ? "FP" : "FN"} ${it.symbol}#${it.no} ${v.reason} | ${it.title.slice(0, 60)} | ${it.publisher}`);
    }
    const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "-");
    console.log(`  ${set} ${golden.sets[set]} — ${rows.length}건, 정답 ${tp + fn}, 채택 ${tp + fp}: 정밀도 ${pct(tp, tp + fp)} · 재현율 ${pct(tp, tp + fn)} (TP ${tp} FP ${fp} FN ${fn} TN ${tn})`);
  }
}
process.exit(0);
