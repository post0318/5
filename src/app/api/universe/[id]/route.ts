import { updateTag } from "next/cache";
import { jsonError, ok } from "@/lib/api";
import { deleteUniverseItem, universePatchSchema, updateUniverseItem } from "@/lib/universe/repo";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = universePatchSchema.parse(await request.json());
    const item = await updateUniverseItem(id, body);
    if (!item) return Response.json({ error: "없는 항목" }, { status: 404 });
    updateTag("universe-overview");
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
    updateTag("universe-overview");
    return ok({ deleted: true });
  } catch (err) {
    return jsonError(err);
  }
}
