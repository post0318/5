import { jsonError, ok } from "@/lib/api";
import { getMacroDashboard } from "@/lib/macro/fred";
import { getIndices } from "@/lib/macro/indices";
import { getFearGreed } from "@/lib/macro/feargreed";

export const revalidate = 3600;

export async function GET() {
  try {
    const [dashboard, indices, fearGreed] = await Promise.all([
      getMacroDashboard(),
      getIndices().catch(() => []),
      getFearGreed().catch(() => null),
    ]);
    return ok({ ...dashboard, indices, fearGreed });
  } catch (err) {
    return jsonError(err);
  }
}
