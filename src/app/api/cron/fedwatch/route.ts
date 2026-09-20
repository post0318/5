import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { backfillFedWatchDays, saveFedWatchSnapshot } from "@/lib/db/fedwatch";
import { getFedWatch, getFedWatchHistory } from "@/lib/macro/fedwatch";

// 백필은 임계값 11개 × candlesticks 조회라 기본 제한을 넘을 수 있다.
export const maxDuration = 60;

/**
 * Fed 금리 확률(Kalshi) 일별 스냅샷 저장 — CME/investing.com 처럼 "전일·전주"
 * 비교를 보여주기 위한 하루 1회 배치(오너 지시 2026-09-20). 다른 cron 라우트와
 * 동일 인증 패턴(kr-fg 참고): CRON_SECRET(Vercel Cron 자동 헤더) 또는
 * x-app-token(APP_PASSWORD, 로컬 수동 실행).
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const appPw = process.env.APP_PASSWORD;
  if (appPw && req.headers.get("x-app-token") === appPw) return true;
  if (secret) return req.headers.get("authorization") === `Bearer ${secret}`;
  return (req.headers.get("user-agent") ?? "").includes("vercel-cron");
}

export async function GET(req: Request) {
  try {
    if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!isDbConfigured()) return Response.json({ error: "MONGODB_URI 미설정" }, { status: 503 });

    // ?backfill=60 — Kalshi candlesticks 로 과거 N일치를 한 번에 채운다(1회성).
    // 하루 1회 수집만으로는 전일·전주 비교가 1주일 뒤에야 채워져서 추가
    // (오너 지시 2026-09-20). 이미 있는 날짜는 덮지 않는다.
    const backfill = Number(new URL(req.url).searchParams.get("backfill") ?? 0);
    if (Number.isFinite(backfill) && backfill > 0) {
      const days = await getFedWatchHistory(Math.min(backfill, 180));
      const inserted = await backfillFedWatchDays(days);
      return ok({
        backfilled: inserted,
        fetched: days.length,
        from: days[0]?.date ?? null,
        to: days[days.length - 1]?.date ?? null,
      });
    }

    const fw = await getFedWatch();
    if (!fw) return Response.json({ error: "Kalshi 데이터 없음(비어 있거나 API 실패)" }, { status: 502 });

    await saveFedWatchSnapshot(fw);
    return ok({ saved: true, meetingDate: fw.meetingDate, asOf: fw.asOf });
  } catch (err) {
    return jsonError(err);
  }
}
