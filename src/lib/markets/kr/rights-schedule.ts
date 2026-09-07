import "server-only";

/**
 * 금융위원회_주식권리일정정보 (공공데이터포털).
 *  End Point: https://apis.data.go.kr/1160100/GetStocRighScheService_V2
 *  Operation: getRighExerReasSche (권리행사사유별일정조회)
 *  DATA_GO_KR_KEY 필요 (Encoding 인증키 — 이미 URL 인코딩된 문자열).
 *
 * 배당락·무상증자·유상증자·액면분할/병합·주식병합·주주총회·감자 등
 * 권리 이벤트 일정. 일 1회 갱신(익영업일 13시 이후).
 */

const EP = "https://apis.data.go.kr/1160100/GetStocRighScheService_V2/getRighExerReasSche";

export interface KrRightEvent {
  /** 기준일자 YYYY-MM-DD */
  basDt: string;
  /** 권리행사(권리락) 사유 — 예: 현금배당, 무상증자, 유상증자, 주식분할 */
  reason: string;
  /** 권리행사 시작일 */
  startDt: string | null;
  /** 권리행사 종료일 */
  endDt: string | null;
  /** 명부폐쇄 시작/종료 */
  closeStartDt: string | null;
  closeEndDt: string | null;
  companyName: string | null;
  isinCd: string | null;
}

const key = () => process.env.DATA_GO_KR_KEY ?? "";
const isConfigured = () => key().length > 0;

const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
const dash = (s: unknown): string | null => {
  const v = String(s ?? "").replace(/\D/g, "");
  return v.length === 8 ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null;
};

/** 응답 항목에서 이름이 조금씩 달라도 잡아내기 위한 유연 접근 */
function pick(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const hit = Object.keys(obj).find((kk) => kk.toLowerCase() === k.toLowerCase());
    if (hit && obj[hit] != null && String(obj[hit]).trim() !== "") return String(obj[hit]);
  }
  return null;
}

async function callApi(params: Record<string, string>): Promise<Record<string, unknown>[]> {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  // serviceKey 는 이미 인코딩돼 있으므로 직접 이어붙인다
  const url = `${EP}?serviceKey=${key()}&${qs}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`권리일정 API ${res.status}: ${text.slice(0, 300).replace(/\s+/g, " ")}`);
  if (text.includes("NO_OPENAPI_SERVICE_ERROR"))
    throw new Error("권리일정 API 미승인/전파대기 (NO_OPENAPI_SERVICE)");
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error("권리일정 API 비JSON 응답");
  }
  const body = (j as { response?: { body?: { items?: { item?: unknown } } } })?.response?.body;
  const item = body?.items?.item;
  if (!item) return [];
  return (Array.isArray(item) ? item : [item]) as Record<string, unknown>[];
}

/**
 * 한 종목의 권리일정. 현재 기준 1년 전 ~ 미래 데이터.
 * name: 주식발행회사명 (예: "삼성전자"), isin: 있으면 우선 사용.
 */
export async function fetchKrRightsSchedule(
  name: string | null,
  isin: string | null,
): Promise<KrRightEvent[] | null> {
  if (!isConfigured()) return null;

  const now = new Date();
  const begin = new Date(now);
  begin.setFullYear(begin.getFullYear() - 1);
  const end = new Date(now);
  end.setFullYear(end.getFullYear() + 1);

  const common = {
    resultType: "json",
    numOfRows: "200",
    pageNo: "1",
    beginBasDt: ymd(begin),
    endBasDt: ymd(end),
  };

  const cleanName = (name ?? "").replace(/\(주\)|주식회사|㈜/g, "").trim();

  let rows: Record<string, unknown>[] = [];
  try {
    if (isin) rows = await callApi({ ...common, isinCd: isin });
    if (rows.length === 0 && cleanName)
      rows = await callApi({ ...common, likeStckIssuCmpyNm: cleanName });
    if (rows.length === 0 && cleanName)
      rows = await callApi({ ...common, stckIssuCmpyNm: cleanName });
  } catch (err) {
    throw err;
  }

  const events: KrRightEvent[] = rows.map((r) => ({
    basDt: dash(pick(r, "basDt")) ?? "",
    reason:
      pick(r, "scrsItmsKcdNm", "rghtRsn", "rghtRsnNm", "rgtRsn", "scrsItmsKcd") ??
      pick(r, "itmsNm") ??
      "권리행사",
    startDt: dash(pick(r, "rghtExerStrtDt", "rightExerStrtDt", "exerStrtDt")),
    endDt: dash(pick(r, "rghtExerEndDt", "rightExerEndDt", "exerEndDt")),
    closeStartDt: dash(pick(r, "mnrgClsBgnDt", "regClsStrtDt", "mnrgClsStrtDt")),
    closeEndDt: dash(pick(r, "mnrgClsEndDt", "regClsEndDt")),
    companyName: pick(r, "stckIssuCmpyNm", "isuNm", "itmsNm"),
    isinCd: pick(r, "isinCd"),
  }));

  const lo = `${begin.getFullYear()}-${String(begin.getMonth() + 1).padStart(2, "0")}-${String(
    begin.getDate(),
  ).padStart(2, "0")}`;
  return events
    .filter((e) => {
      const anchor = e.startDt ?? e.basDt;
      return anchor && anchor >= lo;
    })
    .sort((a, b) => (a.startDt ?? a.basDt).localeCompare(b.startDt ?? b.basDt));
}

/** 단축코드 → ISIN (이미 검증된 금융위 주식시세 서비스 이용) */
export async function resolveKrIsin(code: string): Promise<string | null> {
  if (!isConfigured()) return null;
  const digits = code.replace(/\D/g, "");
  try {
    const url =
      `https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo` +
      `?serviceKey=${key()}&resultType=json&numOfRows=1&pageNo=1&likeSrtnCd=${digits}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      response?: { body?: { items?: { item?: { isinCd?: string }[] | { isinCd?: string } } } };
    };
    const it = j.response?.body?.items?.item;
    const first = Array.isArray(it) ? it[0] : it;
    return first?.isinCd ?? null;
  } catch {
    return null;
  }
}
