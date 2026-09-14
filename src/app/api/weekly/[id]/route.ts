import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { getWeeklyReport, updateWeeklyReport } from "@/lib/db/weekly-reports";

const ID_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!ID_RE.test(id)) return Response.json({ error: "잘못된 id" }, { status: 400 });
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });
    const doc = await getWeeklyReport(id);
    if (!doc) return Response.json({ error: "없음" }, { status: 404 });
    return ok(doc, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return jsonError(err);
  }
}

/** 본문 수정·발행/발행취소 — proxy.ts 매처로 로그인 필요. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!ID_RE.test(id)) return Response.json({ error: "잘못된 id" }, { status: 400 });
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });
    const body = (await req.json()) as { body?: unknown; status?: unknown };
    const patch: { body?: string; status?: "draft" | "published" } = {};
    if (typeof body.body === "string") {
      if (body.body.length > 50_000) return Response.json({ error: "본문이 너무 큽니다" }, { status: 400 });
      patch.body = body.body;
    }
    if (body.status === "draft" || body.status === "published") patch.status = body.status;
    if (!("body" in patch) && !patch.status) return Response.json({ error: "수정할 내용 없음" }, { status: 400 });
    const doc = await updateWeeklyReport(id, patch);
    if (!doc) return Response.json({ error: "없음" }, { status: 404 });
    return ok(doc);
  } catch (err) {
    return jsonError(err);
  }
}
