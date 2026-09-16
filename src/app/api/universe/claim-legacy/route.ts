import { jsonError, ok } from "@/lib/api";
import { claimLegacyUniverse, countLegacyUniverse } from "@/lib/universe/repo";
import { authErrorResponse, requireAdmin } from "@/lib/server/app-auth";

/**
 * Clerk 도입 이전(공유 비밀번호 시절)에 만들어진 소유자 없는 유니버스를 부르는
 * 관리자 계정에 귀속시킨다. 계정별 분리로 넘어가는 1회성 마이그레이션이라
 * 관리 화면에 남은 건수가 있을 때만 배너로 노출한다.
 */
export async function GET() {
  try {
    const who = await requireAdmin();
    if (!who.ok) return authErrorResponse(who);
    return ok({ pending: await countLegacyUniverse() }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST() {
  try {
    const who = await requireAdmin();
    if (!who.ok) return authErrorResponse(who);
    const res = await claimLegacyUniverse(who.userId);
    return ok(res);
  } catch (err) {
    return jsonError(err);
  }
}
