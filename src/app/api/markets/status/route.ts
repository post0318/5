import { ok } from "@/lib/api";
import { marketStatus } from "@/lib/markets/registry";

export async function GET() {
  return ok({ markets: marketStatus() });
}
