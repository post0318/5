import { revalidatePath } from "next/cache";
import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import {
  backfillEcosRates,
  backfillRange,
  bootstrapKospiHistory,
  deepBackfill,
  importVkospi,
  resetKrStockRoll,
  runKrFgBatch,
} from "@/lib/macro/kr/batch";

export const maxDuration = 300;

/**
 * 한국 F&G 일일 배치. Vercel Cron 이 호출 (매 영업일 장 마감 후).
 *  - 기본: 직전 영업일 1일치 수집
 *  - ?backfill=N : 최근 N 거래일 백필 (초기 히스토리 구축용, 수동 호출)
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // 미설정 시 열어둠 (개발)
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

/** VKOSPI 과거치 주입: body = { vkospi: [{date:"YYYY-MM-DD", vkospi:number}] } */
export async function POST(req: Request) {
  try {
    if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });
    const body = (await req.json()) as { vkospi?: { date: string; vkospi: number }[] };
    if (!Array.isArray(body.vkospi)) return Response.json({ error: "vkospi 배열 필요" }, { status: 400 });
    return ok({ mode: "import-vkospi", ...(await importVkospi(body.vkospi)) });
  } catch (err) {
    return jsonError(err);
  }
}

export async function GET(req: Request) {
  try {
    if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });

    const sp = new URL(req.url).searchParams;
    if (sp.get("bootstrap") === "kospi") {
      return ok({ mode: "bootstrap-kospi", ...(await bootstrapKospiHistory()) });
    }
    if (sp.get("reset") === "roll") {
      return ok({ mode: "reset-roll", ...(await resetKrStockRoll()) });
    }
    if (sp.get("ecos") === "1") {
      return ok({ mode: "ecos-backfill", ...(await backfillEcosRates(sp.get("start") ?? undefined)) });
    }
    const from = sp.get("from");
    const to = sp.get("to");
    if (from && to) {
      if (sp.get("deep") === "1") {
        return ok({ mode: "deep-backfill", ...(await deepBackfill(from, to)) });
      }
      const force = sp.get("force") === "1";
      return ok({ mode: "backfill-range", ...(await backfillRange(from, to, !force)) });
    }

    // 직전 영업일
    const d = new Date();
    d.setDate(d.getDate() - 1);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
    const ymd = d.toISOString().slice(0, 10).replace(/-/g, "");
    const res = await runKrFgBatch(ymd);
    return ok({ mode: "daily", ...res });
  } catch (err) {
    return jsonError(err);
  } finally {
    // 배치/백필 후 지수 캐시 무효화
    revalidatePath("/api/macro");
    revalidatePath("/api/macro/kr-fg");
  }
}
