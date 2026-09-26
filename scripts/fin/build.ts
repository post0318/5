/**
 * 재무 5층 구조 배치(architecture.md §5.1) — 유니버스 종목을 조립해 fin_sym·fin_stmt 에 저장한다.
 *
 *   node scripts/fin/run.mjs scripts/fin/build.ts                    # 유니버스(미국) 전 종목 저장
 *   node scripts/fin/run.mjs scripts/fin/build.ts --symbols=AAPL,WDC # 지정 종목 저장
 *   node scripts/fin/run.mjs scripts/fin/build.ts --symbols=AAPL --dry --out=x.json  # 비저장 조립(§5.3) 결과만
 *
 * 종목은 순차로 돈다(SEC 요청 순차·간격은 source/us/sec.ts). 한 종목 실패가 배치를 멈추지 않는다.
 */
import { writeFileSync } from "node:fs";
import { assemble, gapNames } from "@/lib/fin";
import { listUniverseDistinct } from "@/lib/universe/repo";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const flag = (k: string) => process.argv.includes(`--${k}`);

async function main() {
  const dry = flag("dry");
  const symbols = arg("symbols")?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    ?? (await listUniverseDistinct({ market: "us" })).map((u) => u.symbol.toUpperCase());
  const out: Record<string, unknown> = {};
  let fail = 0;
  for (const s of symbols) {
    const t0 = Date.now();
    try {
      const r = await assemble("us", s, { persist: !dry });
      const rev = r.metrics.revenue.values;
      out[s] = dry ? r : { gaps: gapNames(r.gaps), persisted: r.persisted };
      const ltm = rev.LTM?.v;
      const mm = (v: number | null | undefined) => (v == null ? "—" : Math.round(v / 1e6).toLocaleString("en-US"));
      console.log(`${s.padEnd(6)} ${r.profile.type}/${r.profile.filer} 열 ${r.annual.length}+${r.quarterly.length} LTM매출 ${mm(ltm)}백만 매출원가 ${mm(r.metrics.cogs.values.LTM?.v)} 매출총이익 ${mm(r.metrics.gp.values.LTM?.v)} gaps[${gapNames(r.gaps).join(",")}]` +
        (r.persisted ? ` 변경칸 ${r.persisted.changed}${r.persisted.kept ? "(기존 유지)" : ""}` : "") + ` ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      if (r.warnings.length) console.log(`       경고: ${r.warnings.join(" / ")}`);
    } catch (e) {
      fail++;
      console.error(`${s.padEnd(6)} 실패: ${(e as Error).message}`);
    }
  }
  const file = arg("out");
  if (file) writeFileSync(file, JSON.stringify(out, null, 1));
  if (fail) process.exitCode = 1;
  // mongodb 연결이 열려 있으면 프로세스가 끝나지 않는다
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
  if (!dry) process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
