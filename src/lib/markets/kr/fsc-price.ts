import "server-only";

/**
 * 금융위원회 주식시세정보 (data.go.kr, GetStockSecuritiesInfoService).
 * 국내 종목 일봉 종가 — Yahoo 대체 (KRX EOD, 지연 없음).
 */

const KEY = () => process.env.DATA_GO_KR_KEY ?? "";

const num = (s: unknown): number | null => {
  const n = Number(String(s ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** srtnCd 종목의 일별 종가 Map<YYYYMMDD, close>. begin/end = YYYYMMDD */
export async function fetchKrDailyCloses(
  srtnCd: string,
  beginYmd: string,
  endYmd: string,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const key = KEY();
  if (!key) return map;
  const digits = srtnCd.replace(/\D/g, "");
  try {
    for (let page = 1; page <= 4; page++) {
      const url =
        `https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo` +
        `?serviceKey=${key}&resultType=json&numOfRows=500&pageNo=${page}` +
        `&beginBasDt=${beginYmd}&endBasDt=${endYmd}&likeSrtnCd=${digits}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
      if (!res.ok) break;
      const text = await res.text();
      if (text.includes("OpenAPI_ServiceResponse")) break;
      const body = (JSON.parse(text) as { response?: { body?: unknown } })?.response?.body as
        | { items?: { item?: unknown }; totalCount?: number }
        | undefined;
      const item = body?.items?.item;
      const rows = (item ? (Array.isArray(item) ? item : [item]) : []) as Record<string, string>[];
      for (const r of rows) {
        // likeSrtnCd 는 접두 일치 → 정확히 일치하는 것만
        if ((r.srtnCd ?? "").replace(/\D/g, "") !== digits) continue;
        const d = String(r.basDt ?? "").replace(/\D/g, "");
        const c = num(r.clpr);
        if (d.length === 8 && c != null && c > 0) map.set(d, c);
      }
      if (rows.length < 500) break;
    }
  } catch {
    /* 실패 시 빈 맵 */
  }
  return map;
}
