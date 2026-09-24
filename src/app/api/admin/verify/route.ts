import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { verifyResultsCol, type VerifyResultDoc } from "@/lib/db/verify-results";
import { authErrorResponse, requireAdmin } from "@/lib/server/app-auth";
import { listUniverseDistinct } from "@/lib/universe/repo";

export const runtime = "nodejs";

export interface AdminVerifyRow {
  market: string;
  symbol: string;
  name: string | null;
  /** 유니버스에 있는데 아직 검증 결과가 없음 */
  pending: boolean;
  result: VerifyResultDoc | null;
}

/** 재무 검증 결과 — 관리자만. 유니버스 전 종목(전 계정 합집합) + 검증 결과, 미검증 종목 포함. */
export async function GET() {
  try {
    const who = await requireAdmin();
    if (!who.ok) return authErrorResponse(who);
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });
    const [universe, col] = await Promise.all([listUniverseDistinct({ activeOnly: true }), verifyResultsCol()]);
    const results = new Map((await col.find({}).toArray()).map((d) => [d._id, d]));
    const rows: AdminVerifyRow[] = universe.map((u) => {
      const r = results.get(`${u.market}:${u.symbol}`) ?? null;
      return { market: u.market, symbol: u.symbol, name: u.name ?? null, pending: !r, result: r };
    });
    return ok({ rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return jsonError(err);
  }
}
