import { jsonError, ok } from "@/lib/api";
import { getMacroDashboard } from "@/lib/macro/fred";

export const revalidate = 3600;

export async function GET() {
  try {
    const data = await getMacroDashboard();
    return ok(data);
  } catch (err) {
    return jsonError(err);
  }
}
