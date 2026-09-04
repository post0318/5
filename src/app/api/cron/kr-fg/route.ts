import { revalidatePath } from "next/cache";
import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import {
  backfillEcosRates,
  backfillRange,
  bootstrapKospiHistory,
  deepBackfill,
  deepBackfillAuto,
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
      return ok({ mode: "bootstrap-kospi", ...(await bootstrapKospiHistory()) });
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
    if (sp.get("debug") === "coverage") {
      const { krFgDailyCol } = await import("@/lib/db/kr-fg");
      const col = await krFgDailyCol();
      const docs = await col.find({}, { projection: { kospiClose: 1, vkospi: 1, putCallVal: 1, corpBBB: 1 } }).sort({ _id: 1 }).toArray();
      const byMonth: Record<string, { docs: number; kospi: number; vkospi: number; putCall: number; credit: number }> = {};
      for (const d of docs) {
        const m = String(d._id).slice(0, 7);
        const b = (byMonth[m] ??= { docs: 0, kospi: 0, vkospi: 0, putCall: 0, credit: 0 });
        b.docs++;
        if (d.kospiClose != null) b.kospi++;
        if (d.vkospi != null) b.vkospi++;
        if (d.putCallVal != null) b.putCall++;
        if (d.corpBBB != null) b.credit++;
      }
      return ok({
        mode: "debug-coverage",
        totalDocs: docs.length,
        firstId: docs[0]?._id ?? null,
        lastId: docs.at(-1)?._id ?? null,
        byMonth,
      });
    }
    if (sp.get("debug") === "momentum") {
      const { getKrFgHistory } = await import("@/lib/db/kr-fg");
      const all = await getKrFgHistory();
      const closes = all.map((x) => x.kospiClose);
      // null 위치 구간 찾기
      const nullRuns: string[] = [];
      let runStart: string | null = null;
      all.forEach((d, i) => {
        if (closes[i] == null) {
          if (!runStart) runStart = String(d._id);
        } else if (runStart) {
          nullRuns.push(`${runStart}..${String(all[i - 1]._id)}`);
          runStart = null;
        }
      });
      if (runStart) nullRuns.push(`${runStart}..(end)`);
      // 125일 SMA 유효 구간
      const p = 125;
      let firstValid: string | null = null;
      let validCount = 0;
      for (let i = p - 1; i < closes.length; i++) {
        let okWin = true;
        for (let k = i - p + 1; k <= i; k++) if (closes[k] == null) { okWin = false; break; }
        if (okWin) {
          validCount++;
          if (!firstValid) firstValid = String(all[i]._id);
        }
      }
      return ok({
        mode: "debug-momentum",
        allLen: all.length,
        allFirst: String(all[0]?._id),
        allLast: String(all.at(-1)?._id),
        closeNonNull: closes.filter((c) => c != null).length,
        nullRuns,
        sma125FirstValid: firstValid,
        sma125ValidDays: validCount,
      });
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
