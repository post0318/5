import { z } from "zod";
import { jsonError, ok } from "@/lib/api";
import { deleteUniverseItem, setActive } from "@/lib/universe/repo";

const patchSchema = z.object({ active: z.boolean() });

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = patchSchema.parse(await request.json());
    const item = await setActive(Number(id), body.active);
    if (!item) return Response.json({ error: "없는 항목" }, { status: 404 });
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
    const deleted = await deleteUniverseItem(Number(id));
    if (!deleted) return Response.json({ error: "없는 항목" }, { status: 404 });
    return ok({ deleted: true });
  } catch (err) {
    return jsonError(err);
  }
}
