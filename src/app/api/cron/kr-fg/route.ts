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
  extendFutBasisHistory,
  importForeignFuturesNet,
  importVkospi,
  resetKrStockRoll,
  runKrFgBatch,
} from "@/lib/macro/kr/batch";
import { refreshUniverseOverview } from "@/lib/universe/overview";

export const maxDuration = 300;

/**
 * 한국 F&G 일일 배치. Vercel Cron 이 호출 — 09:30 UTC(18:30 KST, 장마감 15:30
 * KST 로부터 3시간 뒤. 공공데이터 API 종가 반영 시차 감안한 여유)에 그날 KST
 * 거래일 데이터를 곧바로 수집한다("직전 영업일"이 아니라 "오늘"을 목표로 함 —
 * 예전엔 UTC 기준 하루를 통째로 더 빼서 실제로는 이틀 전 데이터를 모으고
 * 있었음, KST 는 UTC+9 라 크론 실행 시각(UTC)의 날짜가 이미 그날 KST 거래일과
 * 같은 날짜라 추가로 뺄 필요가 없었던 것).
 *  - 기본: 오늘(KST) 거래일 1일치 수집 (주말이면 직전 금요일)
 *  - ?backfill=N : 최근 N 거래일 백필 (초기 히스토리 구축용, 수동 호출)
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const appPw = process.env.APP_PASSWORD;
  // 수동 실행 허용 (관리자 비밀번호)
  if (appPw && req.headers.get("x-app-token") === appPw) return true;
  if (secret) {
    // 권장: Vercel Cron 이 자동으로 이 헤더를 주입
    return req.headers.get("authorization") === `Bearer ${secret}`;
  }
  // CRON_SECRET 미설정 시 임시 안전장치 — Vercel Cron 요청만 허용.
  // (UA 스푸핑 가능하나 기존 "전면 개방"보다는 안전. CRON_SECRET 설정 강력 권장.)
  return (req.headers.get("user-agent") ?? "").includes("vercel-cron");
}

/**
 * 수동 데이터 주입.
 *  body = { vkospi: [{date, vkospi}] } 또는
 *  body = { foreignFutNet: [{date, value}] } (외국인 KOSPI200 선물 순매수, 계약수)
 */
export async function POST(req: Request) {
  try {
    if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });
    const body = (await req.json()) as {
      vkospi?: { date: string; vkospi: number }[];
      foreignFutNet?: { date: string; value: number }[];
    };
    if (Array.isArray(body.foreignFutNet)) {
      return ok({ mode: "import-foreign-fut", ...(await importForeignFuturesNet(body.foreignFutNet)) });
    }
    if (!Array.isArray(body.vkospi)) return Response.json({ error: "vkospi 또는 foreignFutNet 배열 필요" }, { status: 400 });
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
    if (sp.get("extend") === "basis") {
      const from = sp.get("from");
      const to = sp.get("to");
      if (!from || !to) return Response.json({ error: "from/to 필요" }, { status: 400 });
      return ok({ mode: "extend-basis", ...(await extendFutBasisHistory(from, to)) });
    }
    if (sp.get("bootstrap") === "kospi") {
      return ok({ mode: "bootstrap-kospi", ...(await bootstrapKospiHistory(sp.get("since") ?? undefined)) });
    }
    if (sp.get("extend") === "breadth") {
      const from = sp.get("from");
      const to = sp.get("to");
      if (!from || !to) return Response.json({ error: "from/to 필요" }, { status: 400 });
      return ok({ mode: "extend-breadth", ...(await extendBreadthHistory(from, to)) });
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

    // 오늘(KST 거래일 — 크론이 18:30 KST 에 도는 동안 UTC 날짜는 이미 같은 KST
    // 거래일과 일치하므로 추가로 하루를 빼지 않는다). 주말이면 직전 금요일.
    const d = new Date();
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
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
