import { jsonError, ok } from "@/lib/api";
import { CHART_YEARS, getIndexChart, type ChartYears } from "@/lib/macro/index-chart";

export const revalidate = 3600;
export const maxDuration = 30;

export async function GET(req: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    const { key } = await params;
    const yParam = Number(new URL(req.url).searchParams.get("y"));
    const years = (CHART_YEARS as readonly number[]).includes(yParam)
      ? (yParam as ChartYears)
      : 1;
    const data = await getIndexChart(key, years);
    if (!data) return Response.json({ error: `차트를 불러올 수 없습니다: ${key}` }, { status: 400 });
    return ok(data);
  } catch (err) {
    return jsonError(err);
  }
}
