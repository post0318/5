import { jsonError, ok } from "@/lib/api";
import { getIndexChart } from "@/lib/macro/index-chart";

export const revalidate = 3600;
export const maxDuration = 30;

export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    const { key } = await params;
    const data = await getIndexChart(key);
    if (!data) return Response.json({ error: `차트를 불러올 수 없습니다: ${key}` }, { status: 400 });
    return ok(data);
  } catch (err) {
    return jsonError(err);
  }
}
