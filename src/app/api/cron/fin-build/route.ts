import { timingSafeEqual } from "node:crypto";
import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { refreshStored } from "@/lib/fin";
import { listUniverseDistinct } from "@/lib/universe/repo";
import { listRecentlyViewed } from "@/lib/db/ttm-snap";

export const maxDuration = 300;

/**
 * 재무 5층 구조 배치 갱신(docs/metrics/architecture.md §5.1) — GitHub Actions(`.github/workflows/fin-build.yml`)가 호출한다.
 * 유니버스(전 계정 합집합, 미국) 종목 중 **저장본이 없거나 · 엔진판이 다르거나 · 저장 후 새 정기공시가 나온** 종목만 조립해
 * fin_sym·fin_stmt 에 저장한다(`refreshStored`). 호출당 최대 n 종목(기본 3) — 종목당 SEC 원본 조회로 수십 초가 걸려
 * 함수 시간(maxDuration) 안에 끝나도록 마감 150초 전부터는 새 조립을 시작하지 않는다. 남은 종목은 `pending` 으로 돌려주고
 * 워크플로가 pending 0 이 될 때까지 다시 부른다.
 *
 *  POST ?n=3            — CRON_SECRET(Bearer) 또는 로컬 수동 실행용 x-app-token: APP_PASSWORD
 *  POST ?symbols=AAPL,WDC — 지정 종목만(유니버스 여부 무관, 같은 판정)
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

export async function POST(req: Request) {
  const started = Date.now();
  try {
    if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });
    const sp = new URL(req.url).searchParams;
    const n = Math.min(Math.max(Number(sp.get("n")) || 3, 1), 10);
    const symbols = sp.get("symbols")
      ? sp.get("symbols")!.split(",").map((s) => s.trim().toUpperCase()).filter((s) => SYMBOL_RE.test(s))
      : // 유니버스 + 최근 30일 안에 화면에서 조회된 종목(유니버스 밖 종목도 조회 때 저장되므로 새 공시 갱신 대상, 오너 결정 2026-10-01 ①)
        [...new Set([...(await listUniverseDistinct({ market: "us" })).map((u) => u.symbol.toUpperCase()), ...(await listRecentlyViewed("us"))])];
    // 마감 150초 전부터 새 조립을 시작하지 않는다 — 종목당 조립 30~100초(실측 2026-10-01: 3종목 호출 130초, 마감 20초 전 시작한 조립이 300초를 넘겨 504)
    const r = await refreshStored("us", symbols, { max: n, deadline: started + (maxDuration - 150) * 1000 });
    return ok({ total: symbols.length, ...r, ms: Date.now() - started }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return jsonError(err);
  }
}
