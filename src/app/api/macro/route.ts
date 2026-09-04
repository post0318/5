import { jsonError, ok } from "@/lib/api";
import { getMacroDashboard, getSeriesLongTermMean } from "@/lib/macro/fred";
import { getIndices } from "@/lib/macro/indices";
import { getFearGreed } from "@/lib/macro/feargreed";
import { getKrFearGreed } from "@/lib/macro/kr/fear-greed";

export const revalidate = 3600;

export async function GET() {
  try {
    const [dashboard, indices, fearGreed, vixMean, krFearGreed] = await Promise.all([
      getMacroDashboard(),
      getIndices().catch(() => []),
      getFearGreed().catch(() => null),
      getSeriesLongTermMean("VIXCLS", "1990-01-01").catch(() => null),
      getKrFearGreed().catch(() => null),
    ]);
    return ok({
      ...dashboard,
      indices,
      fearGreed: fearGreed
        ? { ...fearGreed, vixHistoricalAvg: vixMean?.mean ?? null }
        : null,
      krFearGreed,
    });
  } catch (err) {
    return jsonError(err);
  }
}
