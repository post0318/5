/**
 * 미국 TTM 스냅샷 채우기 — GitHub Actions 실행 서버에서 직접 계산해 DB(ttm_snap)에 저장한다(운영 서버 CPU 사용 안 함, 2026-10-03 오너 결정).
 * 저장본은 "운영 배포판(커밋)이 같을 때만" 유효(db/ttm-snap.ts) — 워크플로가 운영 배포판 번호를 물어 그 커밋을 받아 실행하고,
 * VERCEL_GIT_COMMIT_SHA 에 그 번호를 넣는다(ttmSnapVersion 이 그 값으로 저장). 계산은 라우트와 같은 함수(adapter.getTtm·isStorableTtm).
 *
 * 실행: VERCEL_GIT_COMMIT_SHA=<운영 배포판> NODE_OPTIONS=--conditions=react-server npx -y tsx@4.23.15 --tsconfig tsconfig.json scripts/run/ttm-build.mts
 *       [--symbols=AAPL,KO] [--minutes=90] [--dry]
 *   --dry : 계산만 하고 저장하지 않는다(로컬 확인용 — 판번호 "local" 로 운영 저장본을 덮지 않게)
 * 필요한 환경변수: MONGODB_URI(필수), SEC_USER_AGENT(권장), VERCEL_GIT_COMMIT_SHA(저장 시 필수)
 */
import { isDbConfigured } from "@/lib/db";
import { isStorableTtm, listRecentlyViewed, readTtmSnap, ttmSnapVersion, writeTtmSnap } from "@/lib/db/ttm-snap";
import { getAdapter } from "@/lib/markets/registry";
import type { TtmFlows } from "@/lib/markets/types";
import { listUniverseDistinct } from "@/lib/universe/repo";

const SYMBOL_RE = /^[A-Z0-9.-]{1,12}$/;
const PER_SYMBOL_MS = 180_000;
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;

async function main() {
  if (!isDbConfigured()) throw new Error("MONGODB_URI 미설정");
  const dry = process.argv.includes("--dry");
  if (!dry && ttmSnapVersion() === "local")
    throw new Error("APP_COMMIT_SHA(또는 VERCEL_GIT_COMMIT_SHA) 미설정 — 로컬 판번호로 저장하면 운영이 읽지 않는다(값은 아무 배포 커밋이면 된다, 판번호는 계산 규칙으로 정해짐)");
  const minutes = Number(arg("minutes") ?? 90);
  const deadline = Date.now() + minutes * 60_000;
  const symbols = arg("symbols")
    ? arg("symbols")!.split(",").map((s) => s.trim().toUpperCase()).filter((s) => SYMBOL_RE.test(s))
    : [...new Set([...(await listUniverseDistinct({ market: "us" })).map((u) => u.symbol.toUpperCase()), ...(await listRecentlyViewed("us"))])];
  console.log(`판번호 ${ttmSnapVersion()} · 대상 ${symbols.length}종목${dry ? " (저장 안 함)" : ""}`);
  const adapter = getAdapter("us");
  if (!adapter.getTtm) throw new Error("미국 어댑터에 getTtm 없음");
  let fresh = 0, pending = 0;
  const built: string[] = [];
  const failed: { symbol: string; reason: string }[] = [];
  for (const sym of symbols) {
    if (!dry && (await readTtmSnap("us", sym).catch(() => null))) { fresh++; continue; }
    if (Date.now() > deadline) { pending++; continue; }
    const t0 = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<TtmFlows>((resolve) => {
      timer = setTimeout(() => resolve({ periodLabel: "", error: `시간 초과(${PER_SYMBOL_MS / 1000}초)`, netIncome: null, revenue: null, opIncome: null, eps: null }), PER_SYMBOL_MS);
    });
    const ttm = await Promise.race([adapter.getTtm(sym).catch((e) => ({ periodLabel: "", error: String(e) }) as TtmFlows), timeout]);
    clearTimeout(timer);
    const ms = Date.now() - t0;
    if (ttm && isStorableTtm(ttm)) {
      const w = dry ? null : await writeTtmSnap("us", sym, ttm);
      built.push(sym);
      // 저장본 교체 기록(ttm_chg) — 바뀐 칸 수·옛 판번호
      const chg = w ? (w.changed == null ? " · 새 저장본" : ` · 교체(옛 판 ${w.from}) 바뀐 칸 ${w.changed}`) : "";
      console.log(`계산 ${sym} ${ms}ms${dry ? " (저장 안 함)" : chg}`);
    } else {
      const reason = ttm?.error ?? ttm?.degraded?.join("; ") ?? "TTM 없음";
      failed.push({ symbol: sym, reason });
      console.log(`실패 ${sym} ${ms}ms — ${reason}`);
      // 처음 3종목이 모두 실패면 공통 원인(SEC 빈 응답·요청 제한 등) — 나머지를 계속 계산하지 않는다
      if (!built.length && failed.length >= 3) { console.log("::error::처음 3종목 연속 실패 — 공통 원인 확인 후 다시 실행"); return 1; }
    }
  }
  console.log(`완료 · 계산 ${built.length} · 이미 유효 ${fresh} · 실패 ${failed.length} · 남음 ${pending}`);
  if (failed.length) console.log(`::warning::저장 못 한 종목: ${failed.map((f) => `${f.symbol}(${f.reason.slice(0, 60)})`).join(", ")}`);
  if (pending) console.log(`::warning::시간 한도(${minutes}분)로 남은 종목 ${pending}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("::error::", e);
    process.exit(1);
  });
