/**
 * 발표자료 점유율·투자포인트 API 자동 채우기 실행(오너 2026-10-31 「나」 방식) — 앱 화면 「자동 채우기」와 같은 함수(src/lib/ppt/claude-fill.ts).
 *
 *   NODE_OPTIONS=--conditions=react-server npx -y tsx@4.23.15 --tsconfig tsconfig.json scripts/run/ppt-fill.mts \
 *     (--symbols=kr:005930,us:NVDA | --universe) [--estimate] [--dry] [--force] [--limit=N] [--env=~/5/.env.local]
 *
 *   --estimate : 호출하지 않고 대상 종목 수와 예상 비용만(가정: 종목당 검색 4회~상한, 입력 3만~12만·출력 3천~8천 토큰 — 검색 결과가 입력 토큰으로 들어가 크게 늘 수 있음)
 *   --dry      : 호출은 하되 저장하지 않음(비용은 기록됨 — 실제 과금)
 * 키(ANTHROPIC_API_KEY)가 없으면 호출 없이 「꺼짐」으로 끝난다. 오너 승인 전 실제 호출 금지(2026-10-31).
 */
import { homedir } from "node:os";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
const flag = (k: string) => process.argv.includes(`--${k}`);

async function main() {
  const envFile = (arg("env") ?? "").replace(/^~(?=\/)/, homedir());
  if (envFile) process.loadEnvFile(envFile); // DB·키를 읽은 뒤에 앱 모듈을 불러야 한다(모듈이 불릴 때 MONGODB_URI 고정)
  const { claudeFillConfig, fillCompany, needsFill, costUsd } = await import("@/lib/ppt/claude-fill");
  const { getCompany } = await import("@/lib/ppt/store");
  const { listUniverseDistinct } = await import("@/lib/universe/repo");
  const cfg = claudeFillConfig();
  let targets: { market: "kr" | "us" | "jp"; symbol: string }[] = [];
  if (flag("universe")) {
    targets = (await listUniverseDistinct({ activeOnly: true }))
      .filter((u) => u.market === "kr" || u.market === "us" || u.market === "jp")
      .map((u) => ({ market: u.market as "kr" | "us" | "jp", symbol: u.symbol }));
  } else {
    targets = (arg("symbols") ?? "").split(",").filter(Boolean).map((s) => {
      const [m, sym] = s.split(":");
      if (!["kr", "us", "jp"].includes(m) || !sym) throw new Error(`종목 형식 오류: ${s} (예 kr:005930)`);
      return { market: m as "kr" | "us" | "jp", symbol: sym };
    });
  }
  if (!targets.length) throw new Error("--symbols 또는 --universe 필요");
  const pending = [];
  for (const t of targets) if (flag("force") || needsFill(await getCompany(t.market, t.symbol))) pending.push(t);
  const limit = Number(arg("limit") ?? pending.length);
  const run = pending.slice(0, limit);
  const byMarket = run.reduce<Record<string, number>>((a, t) => ((a[t.market] = (a[t.market] ?? 0) + 1), a), {});
  const lo = costUsd(cfg.model, { input: 30_000, output: 3_000, cacheRead: 0, cacheWrite: 0, searches: 4 });
  const hi = costUsd(cfg.model, { input: 120_000, output: 8_000, cacheRead: 0, cacheWrite: 0, searches: cfg.maxSearches });
  console.log(JSON.stringify({ enabled: cfg.enabled, reason: cfg.reason, model: cfg.model, budgetUsd: cfg.budgetUsd, targets: targets.length, pending: pending.length, run: run.length, byMarket, perStockUsd: [lo, hi], totalUsd: [lo * run.length, hi * run.length] }, null, 2));
  if (flag("estimate")) return;
  let total = 0;
  for (const t of run) {
    const r = await fillCompany(t.market, t.symbol, { by: "batch:ppt-fill", force: flag("force"), dryRun: flag("dry") });
    total += r.costUsd;
    console.log(JSON.stringify(r));
    if (r.status === "disabled" || r.status === "budget") break;
  }
  console.log(`합계 추정 비용 ${total.toFixed(3)}달러`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
