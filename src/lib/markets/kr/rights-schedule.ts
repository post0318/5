import "server-only";

/**
 * 금융위원회_주식권리일정정보 (공공데이터포털).
 *  End Point : https://apis.data.go.kr/1160100/GetStocRighScheService_V2
 *  Operation : getRighExerReasSche_V2 (권리행사사유별일정조회)
 *  DATA_GO_KR_KEY 필요 (Encoding 인증키 — 이미 URL 인코딩된 문자열).
 *
 * 배당락·무상증자·유상증자·액면분할/병합·주식병합·주주총회·감자 등
 * 권리 이벤트 일정. 일 1회 갱신(익영업일 13시 이후). 종목 필터는 법인등록번호(crno).
 */

const EP =
  "https://apis.data.go.kr/1160100/GetStocRighScheService_V2/getRighExerReasSche_V2";

export interface KrRightEvent {
  /** 기준일 YYYY-MM-DD */
  basDt: string;
  /** 권리사유 — 예: 현금배당, 무상증자, 유상증자, 임시총회, 주식분할 */
  reason: string;
  /** 액면가 */
  parValue: string | null;
  /** 세부 일정 (기준일 / 명부폐쇄기간 / 총회개최일 등) */
  items: { kind: string; start: string | null; end: string | null }[];
}

const key = () => process.env.DATA_GO_KR_KEY ?? "";
const isConfigured = () => key().length > 0;

const dash = (s: unknown): string | null => {
  const v = String(s ?? "").replace(/\D/g, "");
  return v.length === 8 ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null;
};

interface RawRow {
  basDt?: string;
  stckIssuCmpyNm?: string;
  stckIssuRcdNm?: string;
  rgtExertRcdNm?: string;
  rgtExertSttgDt?: string;
  rgtExertEdDt?: string;
  nmlsLckSttgDt?: string;
  nmlsLckEdDt?: string;
  stckParPrc?: string;
  crno?: string;
}

async function callApi(params: Record<string, string>): Promise<{
  rows: RawRow[];
  total: number;
}> {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  const url = `${EP}?serviceKey=${key()}&${qs}`; // serviceKey 는 이미 인코딩됨
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  if (!res.ok || text.includes("OpenAPI_ServiceResponse"))
    throw new Error(`권리일정 API ${res.status}: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
  const body = (JSON.parse(text) as { response?: { body?: unknown } })?.response?.body as
    | { items?: { item?: RawRow | RawRow[] }; totalCount?: number }
    | undefined;
  const item = body?.items?.item;
  const rows = item ? (Array.isArray(item) ? item : [item]) : [];
  return { rows, total: body?.totalCount ?? rows.length };
}

/**
 * 한 종목의 권리일정. 현재 기준 1년 전 ~ 미래.
 * crno: 법인등록번호(13자리) — 종목 필터의 유일하게 신뢰 가능한 키.
 */
export async function fetchKrRightsSchedule(
  crno: string | null,
): Promise<KrRightEvent[] | null> {
  if (!isConfigured() || !crno) return null;

  // 데이터는 basDt 오름차순 → 최근분은 마지막 페이지. 총건수 먼저 확인 후 꼬리 조회.
  const head = await callApi({ resultType: "json", numOfRows: "1", pageNo: "1", crno });
  if (head.total === 0) return [];
  const PAGE = 300;
  const lastPage = Math.max(1, Math.ceil(head.total / PAGE));
  const tail = await callApi({
    resultType: "json",
    numOfRows: String(PAGE),
    pageNo: String(lastPage),
    crno,
  });

  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const lo = cutoff.toISOString().slice(0, 10);

  // (기준일 + 권리사유) 로 묶고 세부 일정 수집
  const groups = new Map<string, KrRightEvent>();
  for (const r of tail.rows) {
    const basDt = dash(r.basDt);
    if (!basDt || basDt < lo) continue;
    const reason = (r.stckIssuRcdNm ?? "권리행사").trim();
    const gk = `${basDt}|${reason}`;
    if (!groups.has(gk)) {
      groups.set(gk, {
        basDt,
        reason,
        parValue: r.stckParPrc ? String(Number(r.stckParPrc)) : null,
        items: [],
      });
    }
    const kind = (r.rgtExertRcdNm ?? "").trim();
    const start = dash(r.rgtExertSttgDt) ?? dash(r.nmlsLckSttgDt);
    const end = dash(r.rgtExertEdDt) ?? dash(r.nmlsLckEdDt);
    if (kind || start) groups.get(gk)!.items.push({ kind: kind || "일정", start, end });
  }

  return [...groups.values()].sort((a, b) => b.basDt.localeCompare(a.basDt));
}
