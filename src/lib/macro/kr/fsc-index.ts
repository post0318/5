import "server-only";

/**
 * 금융위원회_지수시세정보 (data.go.kr, GetMarketIndexInfoService/getStockMarketIndex).
 * KOSPI·KOSDAQ 일별 종가 — 지수차트용 Yahoo 대체 (KRX 데이터).
 * 커버리지 2020~ (그 이전은 호출자가 Yahoo 폴백).
 */

const EP =
  "https://apis.data.go.kr/1160100/service/GetMarketIndexInfoService/getStockMarketIndex";

const num = (s: unknown): number | null => {
  const n = Number(String(s ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** idxNm 완전일치. 예: "코스피", "코스닥" */
export async function fetchKrIndexDaily(
  idxNm: string,
  beginYmd: string,
  endYmd: string,
): Promise<{ date: string; close: number }[]> {
  const key = process.env.DATA_GO_KR_KEY ?? "";
  if (!key) return [];
  const out: { date: string; close: number }[] = [];
  try {
    for (let page = 1; page <= 8; page++) {
      const url =
        `${EP}?serviceKey=${key}&resultType=json&numOfRows=1000&pageNo=${page}` +
        `&beginBasDt=${beginYmd}&endBasDt=${endYmd}&idxNm=${encodeURIComponent(idxNm)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) break;
      const text = await res.text();
      if (text.includes("OpenAPI_ServiceResponse")) break;
      const body = (JSON.parse(text) as { response?: { body?: unknown } })?.response?.body as
        | { items?: { item?: unknown }; totalCount?: number }
        | undefined;
      const item = body?.items?.item;
      const rows = (item ? (Array.isArray(item) ? item : [item]) : []) as Record<string, string>[];
      for (const r of rows) {
        if ((r.idxNm ?? "") !== idxNm) continue; // 완전일치만
        const d = String(r.basDt ?? "").replace(/\D/g, "");
        const c = num(r.clpr);
        if (d.length === 8 && c != null && c > 0) {
          out.push({ date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, close: c });
        }
      }
      if (rows.length < 1000) break;
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
