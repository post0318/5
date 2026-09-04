import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { getKrFearGreed } from "@/lib/macro/kr/fear-greed";

export const revalidate = 1800;

export async function GET() {
  try {
    if (!isDbConfigured()) return ok({ krFearGreed: null, reason: "DB 미설정" });
    const krFearGreed = await getKrFearGreed().catch(() => null);
    return ok({ krFearGreed });
  } catch (err) {
    return jsonError(err);
  }
}
