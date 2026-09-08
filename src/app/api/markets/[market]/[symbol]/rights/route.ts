import { ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId } from "@/lib/markets/types";
import { getKrJurirNo } from "@/lib/markets/kr/opendart";
import { fetchKrRightsSchedule } from "@/lib/markets/kr/rights-schedule";
import { fetchUsRightsSchedule } from "@/lib/markets/us/rights-schedule";

export const maxDuration = 30;

/**
 * 주식 권리일정. 한국: 금융위 주식권리일정정보 + 배당정보 + DART 공시.
 * 미국: yahoo-finance2 배당/분할 이벤트 + calendarEvents. 최선노력형.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ market: string; symbol: string }> },
) {
  const { market, symbol } = await params;
  if (!isMarketId(market)) {
    return Response.json({ error: "알 수 없는 시장" }, { status: 404 });
  }

  if (market === "us") {
    const adapter = getAdapter("us");
    const sym = adapter.normalizeSymbol(decodeURIComponent(symbol));
    const url = new URL(request.url);
    const yahoo = url.searchParams.get("yahoo");

    if (url.searchParams.get("debug") === "polygon") {
      const names = ["POLYGON_API_KEY", "MASSIVE_API_KEY", "POLYGON_KEY", "POLYGONIO_API_KEY"];
      const present = Object.fromEntries(names.map((n) => [n, Boolean(process.env[n])]));
      const key = (process.env.POLYGON_API_KEY ?? "").trim();
      const s = sym.replace(/[^A-Za-z.]/g, "").toUpperCase();
      const path = `/v3/reference/dividends?ticker=${s}&limit=5&order=desc&sort=ex_dividend_date`;
      const attempts: { label: string; url: string; headers?: Record<string, string> }[] = [
        { label: "polygon.io ?apiKey", url: `https://api.polygon.io${path}&apiKey=${key}` },
        { label: "polygon.io Bearer", url: `https://api.polygon.io${path}`, headers: { Authorization: `Bearer ${key}` } },
        { label: "massive.com ?apiKey", url: `https://api.massive.com${path}&apiKey=${key}` },
        { label: "massive.com Bearer", url: `https://api.massive.com${path}`, headers: { Authorization: `Bearer ${key}` } },
      ];
      const probe: Record<string, unknown> = { keyLen: key.length };
      for (const a of attempts) {
        try {
          const r = await fetch(a.url, { headers: a.headers, signal: AbortSignal.timeout(10_000) });
          const body = (await r.json().catch(() => null)) as {
            status?: string;
            results?: { ex_dividend_date?: string; pay_date?: string }[];
            error?: string;
            message?: string;
          } | null;
          probe[a.label] = {
            http: r.status,
            apiStatus: body?.status,
            error: body?.error ?? body?.message,
            count: body?.results?.length ?? 0,
            firstPayDate: body?.results?.[0]?.pay_date,
          };
        } catch (e) {
          probe[a.label] = { fetchError: String(e) };
        }
      }
      return ok({ envPresent: present, probe });
    }
    try {
      const events = await fetchUsRightsSchedule(sym, yahoo);
      return ok(
        { events },
        { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
      );
    } catch (err) {
      return ok({ events: [], detail: err instanceof Error ? err.message : String(err) });
    }
  }

  if (market !== "kr") return ok({ events: [] });

  const adapter = getAdapter("kr");
  const code = adapter.normalizeSymbol(decodeURIComponent(symbol));
  try {
    const [crno, filings] = await Promise.all([
      getKrJurirNo(code),
      adapter.getFilings(code, { limit: 100 }).catch(() => []),
    ]);
    if (!crno) return ok({ events: [], detail: "법인등록번호 조회 실패" });
    const events =
      (await fetchKrRightsSchedule(
        crno,
        code,
        filings.map((f) => ({ title: f.title, url: f.url, date: f.date })),
      )) ?? [];
    return ok(
      { events },
      { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return ok({ events: [], pending: true, detail });
  }
}
