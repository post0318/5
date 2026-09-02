import { jsonError, ok } from "@/lib/api";
import { getMacroDashboard, getSeriesLongTermMean } from "@/lib/macro/fred";
import { getIndices } from "@/lib/macro/indices";
import { getFearGreed } from "@/lib/macro/feargreed";

export const revalidate = 3600;

export async function GET() {
  try {
    const [dashboard, indices, fearGreed, vixMean] = await Promise.all([
      getMacroDashboard(),
      getIndices().catch(() => []),
      getFearGreed().catch(() => null),
      getSeriesLongTermMean("VIXCLS", "1990-01-01").catch(() => null),
    ]);
    return ok({
      ...dashboard,
      indices,
      fearGreed: fearGreed
        ? { ...fearGreed, vixHistoricalAvg: vixMean?.mean ?? null }
        : null,
    });
  } catch (err) {
    return jsonError(err);
  }
}
