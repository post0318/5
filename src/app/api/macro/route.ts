import { jsonError, ok } from "@/lib/api";
import { getMacroDashboard } from "@/lib/macro/fred";
import { getIndices } from "@/lib/macro/indices";

export const revalidate = 3600;

export async function GET() {
  try {
    const [dashboard, indices] = await Promise.all([
      getMacroDashboard(),
      getIndices().catch(() => []),
    ]);
    return ok({ ...dashboard, indices });
  } catch (err) {
    return jsonError(err);
  }
}
