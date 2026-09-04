import { after } from "next/server";
import { jsonError, ok } from "@/lib/api";
import { deleteUniverseItem, universePatchSchema, updateUniverseItem } from "@/lib/universe/repo";
import {
  patchOverviewItemMeta,
  refreshOverviewItem,
  removeOverviewItem,
} from "@/lib/universe/overview";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = universePatchSchema.parse(await request.json());
    const item = await updateUniverseItem(id, body);
    if (!item) return Response.json({ error: "없는 항목" }, { status: 404 });
    // 이름·그룹·태그는 즉시 반영, 시세 등 전체는 백그라운드 재계산
    await patchOverviewItemMeta(item);
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
    const { id } = await params;
    const deleted = await deleteUniverseItem(id);
    if (!deleted) return Response.json({ error: "없는 항목" }, { status: 404 });
    await removeOverviewItem(deleted.market, deleted.symbol);
    return ok({ deleted: true });
  } catch (err) {
    return jsonError(err);
  }
}
