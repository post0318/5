import { after } from "next/server";
import { jsonError, ok } from "@/lib/api";
import { deleteUniverseItem, universePatchSchema, updateUniverseItem } from "@/lib/universe/repo";
import { refreshOverviewItem, removeOverviewItem } from "@/lib/universe/overview";
import { authErrorResponse, requireAppUser } from "@/lib/server/app-auth";

/**
 * 항목 수정·삭제. 저장소 함수가 ownerId 를 조건에 걸어 남의 항목은 애초에
 * 찾히지 않는다 — 없는 항목과 남의 항목이 똑같이 404 다.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const who = await requireAppUser();
    if (!who.ok) return authErrorResponse(who);

    const { id } = await params;
    const body = universePatchSchema.parse(await request.json());
    const item = await updateUniverseItem(who.userId, id, body);
    if (!item) return Response.json({ error: "없는 항목" }, { status: 404 });
    // 이름·그룹·태그는 조회 시 유니버스 항목 값으로 덮어써 즉시 반영된다.
    // 시세 등 공유 캐시만 백그라운드 재계산.
    after(() => refreshOverviewItem(item).catch(() => {}));
    return ok({ item });
  } catch (err) {
    return jsonError(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const who = await requireAppUser();
    if (!who.ok) return authErrorResponse(who);

    const { id } = await params;
    const deleted = await deleteUniverseItem(who.userId, id);
    if (!deleted) return Response.json({ error: "없는 항목" }, { status: 404 });
    // 다른 계정이 아직 담고 있으면 공유 캐시는 남겨둔다.
    await removeOverviewItem(deleted.market, deleted.symbol);
    return ok({ deleted: true });
  } catch (err) {
    return jsonError(err);
  }
}
