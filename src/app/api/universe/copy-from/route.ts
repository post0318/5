import { clerkClient } from "@clerk/nextjs/server";
import { jsonError, ok } from "@/lib/api";
import { copyUniverseFrom, countUniverseByOwner } from "@/lib/universe/repo";
import { authErrorResponse, requireAppUser } from "@/lib/server/app-auth";

/**
 * 다른 계정의 유니버스를 **내 계정으로** 복제한다 (오너 지시 2026-09-17).
 *
 * 복제지 공유가 아니다 — 가져온 뒤에는 각자 따로 편집된다. 계정별 분리를
 * 유지하면서 "처음 상태만 맞추기"를 지원하는 것이 목적.
 *
 * 방향이 항상 "남의 것 → 내 것"이라 남의 유니버스를 건드릴 수 없다. 그래서
 * 관리자 전용으로 두지 않고 로그인한 계정이면 쓸 수 있다.
 *
 *  GET  → 복제해 올 수 있는 다른 계정 목록(이메일·보유 종목 수)
 *  POST { fromUserId } → 그 계정의 유니버스를 내 계정으로 복제
 */

export async function GET() {
  try {
    const who = await requireAppUser();
    if (!who.ok) return authErrorResponse(who);

    const client = await clerkClient();
    const [{ data: users }, counts] = await Promise.all([
      client.users.getUserList({ limit: 100, orderBy: "-created_at" }),
      countUniverseByOwner(),
    ]);

    const accounts = users
      .filter((u) => u.id !== who.userId)
      .map((u) => ({
        id: u.id,
        email:
          u.emailAddresses.find((a) => a.id === u.primaryEmailAddressId)?.emailAddress ??
          u.emailAddresses[0]?.emailAddress ??
          "",
        universeCount: counts.get(u.id) ?? 0,
      }))
      // 담은 종목이 없는 계정은 가져올 게 없어 목록에서 뺀다
      .filter((a) => a.universeCount > 0);

    return ok(
      { accounts, mine: counts.get(who.userId) ?? 0 },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST(req: Request) {
  try {
    const who = await requireAppUser();
    if (!who.ok) return authErrorResponse(who);

    const body = (await req.json().catch(() => ({}))) as { fromUserId?: unknown };
    const fromUserId = typeof body.fromUserId === "string" ? body.fromUserId.trim() : "";
    if (!fromUserId) return Response.json({ error: "fromUserId 필요" }, { status: 400 });
    if (fromUserId === who.userId) {
      return Response.json({ error: "자기 자신에게서는 가져올 수 없습니다" }, { status: 400 });
    }

    const res = await copyUniverseFrom(fromUserId, who.userId);
    return ok(res);
  } catch (err) {
    return jsonError(err);
  }
}
