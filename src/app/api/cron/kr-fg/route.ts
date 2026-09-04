import { revalidatePath } from "next/cache";
import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import {
  backfillEcosRates,
  backfillRange,
  bootstrapKospiHistory,
  deepBackfill,
  deepBackfillAuto,
  extendBreadthHistory,
  importVkospi,
  resetKrStockRoll,
  runKrFgBatch,
} from "@/lib/macro/kr/batch";
import { refreshUniverseOverview } from "@/lib/universe/overview";

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
      return ok({ mode: "bootstrap-kospi", ...(await bootstrapKospiHistory(sp.get("since") ?? undefined)) });
    }
    if (sp.get("extend") === "breadth") {
      const from = sp.get("from");
      const to = sp.get("to");
      if (!from || !to) return Response.json({ error: "from/to 필요" }, { status: 400 });
      return ok({ mode: "extend-breadth", ...(await extendBreadthHistory(from, to)) });
    }
    if (sp.get("debug") === "credit") {
      const { krFgDailyCol } = await import("@/lib/db/kr-fg");
      const col = await krFgDailyCol();
      const days = Number(sp.get("days")) || 180;
      const docs = await col
        .find({}, { projection: { gov3y: 1, corpAA: 1, corpBBB: 1 } })
        .sort({ _id: -1 })
        .limit(days)
        .toArray();
      const rows = docs.reverse();
      const stats = (vals: number[]) =>
        vals.length ? { min: Math.min(...vals), max: Math.max(...vals), range: Math.max(...vals) - Math.min(...vals), last: vals.at(-1) } : null;
      const bbbAa = rows.map((d) => (d.corpBBB != null && d.corpAA != null ? d.corpBBB - d.corpAA : null)).filter((v): v is number => v != null);
      const bbbGov = rows.map((d) => (d.corpBBB != null && d.gov3y != null ? d.corpBBB - d.gov3y : null)).filter((v): v is number => v != null);
      const aaGov = rows.map((d) => (d.corpAA != null && d.gov3y != null ? d.corpAA - d.gov3y : null)).filter((v): v is number => v != null);
      return ok({
        mode: "debug-credit",
        n: rows.length,
        "BBB-AA": stats(bbbAa),
        "BBB-gov3y": stats(bbbGov),
        "AA-gov3y": stats(aaGov),
      });
    }
    if (sp.get("debug") === "strength") {
      const { krFgDailyCol } = await import("@/lib/db/kr-fg");
      const col = await krFgDailyCol();
      const docs = await col
        .find({}, { projection: { newHigh52: 1, newLow52: 1, totalWithHistory: 1, advancers: 1, decliners: 1 } })
        .sort({ _id: -1 })
        .limit(15)
        .toArray();
      return ok({ mode: "debug-strength", rows: docs.reverse() });
    }
    if (sp.get("reset") === "roll") {
      return ok({ mode: "reset-roll", ...(await resetKrStockRoll()) });
    }
    if (sp.get("ecos") === "1") {
      return ok({ mode: "ecos-backfill", ...(await backfillEcosRates(sp.get("start") ?? undefined)) });
    }
    if (sp.get("overview") === "1") {
      return ok({ mode: "overview-refresh", count: (await refreshUniverseOverview()).count });
    }
    if (sp.get("deep") === "auto") {
      const md = Number(sp.get("days")) || 120;
      return ok({ mode: "deep-auto", ...(await deepBackfillAuto(md)) });
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
    // 유니버스 통합 뷰 사전 계산 (조회는 DB 우선)
    const overview = await refreshUniverseOverview()
      .then((r) => r.count)
      .catch(() => null);
    // 히스토리 딥백필은 토·일에만 한 청크씩 이어받기 (2021~ 자동 구축)
    const dow = new Date().getUTCDay();
    const deep =
      dow === 6 || dow === 0 ? await deepBackfillAuto(90).catch(() => null) : null;
    return ok({ mode: "daily", ...res, overview, deep });
  } catch (err) {
    return jsonError(err);
  } finally {
    // 배치/백필 후 지수 캐시 무효화
    revalidatePath("/api/macro");
    revalidatePath("/api/macro/kr-fg");
  }
}
