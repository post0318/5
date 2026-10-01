import { timingSafeEqual } from "node:crypto";
import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { isStorableTtm, readTtmSnap, ttmSnapVersion, writeTtmSnap } from "@/lib/db/ttm-snap";
import { getAdapter } from "@/lib/markets/registry";
import type { TtmFlows } from "@/lib/markets/types";
import { listUniverseDistinct } from "@/lib/universe/repo";

export const maxDuration = 300;

/**
 * 미국 TTM 스냅샷 미리 채우기(db/ttm-snap.ts, 오너 결정 2026-10-01 (가)) — GitHub Actions(`.github/workflows/ttm-build.yml`)가
 * 매일 재무 배치 뒤·배포 직후 부른다. 유니버스(전 계정 합집합) 미국 종목 중 유효한 저장본(같은 배포판·24시간 안)이 없는 것만 계산·저장.
 * 종목을 하나씩 순서대로(SEC 요청 제한 — 동시 조회로 막힌 실측 2026-10-01), 마감 120초 전부터는 새 종목을 시작하지 않는다.
 *
 *  GET               — 현재 배포판(커밋)만 돌려준다(워크플로가 새 배포 반영을 기다리는 용도, 인증 불필요·작업 없음)
 *  POST ?n=10        — CRON_SECRET(Bearer) 또는 로컬 수동 실행용 x-app-token: APP_PASSWORD
 *  POST ?symbols=AAPL,KO — 지정 종목만
 *  POST ?exclude=AAPL,KO — 이번 실행에서 이미 실패한 종목 제외(워크플로가 누적해 넘긴다 — 같은 종목만 반복 재시도하지 않게)
 */
const eq = (a: string | null, b: string) => {
  if (a == null) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const appPw = process.env.APP_PASSWORD;
  if (secret && eq(req.headers.get("authorization"), `Bearer ${secret}`)) return true;
  return !!appPw && eq(req.headers.get("x-app-token"), appPw);
}

const SYMBOL_RE = /^[A-Z0-9.-]{1,12}$/;

export async function GET() {
  return ok({ version: ttmSnapVersion() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const started = Date.now();
  // 마감 120초 전부터 새 종목을 시작하지 않는다 — 재무(fin) 저장본이 없는 종목은 종목당 35초+(실측 2026-10-01, 60초 여유로 504)
  const deadline = started + (maxDuration - 120) * 1000;
  try {
    if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });
    const sp = new URL(req.url).searchParams;
    const n = Math.min(Math.max(Number(sp.get("n")) || 10, 1), 30);
    const symbols = sp.get("symbols")
      ? sp.get("symbols")!.split(",").map((s) => s.trim().toUpperCase()).filter((s) => SYMBOL_RE.test(s))
      : [...new Set((await listUniverseDistinct({ market: "us" })).map((u) => u.symbol.toUpperCase()))];
    const exclude = new Set((sp.get("exclude") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
    const adapter = getAdapter("us");
    const built: { symbol: string; ms: number }[] = [];
    const failed: { symbol: string; reason: string }[] = [];
    let fresh = 0;
    let pending = 0;
    for (const sym of symbols) {
      if (exclude.has(sym)) continue;
      if (await readTtmSnap("us", sym).catch(() => null)) {
        fresh++;
        continue;
      }
      if (built.length + failed.length >= n || Date.now() > deadline) {
        pending++;
        continue;
      }
      const t0 = Date.now();
      const ttm: TtmFlows | null = adapter.getTtm ? await adapter.getTtm(sym).catch((e) => ({ periodLabel: "", error: String(e) }) as TtmFlows) : null;
      if (ttm && isStorableTtm(ttm)) {
        await writeTtmSnap("us", sym, ttm);
        built.push({ symbol: sym, ms: Date.now() - t0 });
      } else {
        failed.push({ symbol: sym, reason: ttm?.error ?? ttm?.degraded?.join("; ") ?? "TTM 없음" });
      }
    }
    return ok(
      { version: ttmSnapVersion(), total: symbols.length, fresh, built, failed, pending, ms: Date.now() - started },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return jsonError(err);
  }
}
