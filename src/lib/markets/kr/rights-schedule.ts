import "server-only";

/**
 * 금융위원회 공공데이터포털 (data.go.kr, 1160100) — 한국 주식 권리일정 + 배당.
 *  권리일정 : GetStocRighScheService_V2/getRighExerReasSche_V2
 *  배당정보 : GetStocDiviInfoService_V2/getDiviInfo_V2
 *  시세     : GetStockSecuritiesInfoService/getStockPriceInfo (배당수익률 계산용 종가)
 *  DATA_GO_KR_KEY 필요 (Encoding 인증키 — 이미 URL 인코딩된 문자열).
 *
 * 종목 필터는 법인등록번호(crno). 일 1회 갱신(익영업일 13시 이후).
 */

const KEY = () => process.env.DATA_GO_KR_KEY ?? "";
const isConfigured = () => KEY().length > 0;

const dash = (s: unknown): string | null => {
  const v = String(s ?? "").replace(/\D/g, "");
  return v.length === 8 ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null;
};
const num = (s: unknown): number | null => {
  const n = Number(String(s ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

async function callApi(
  path: string,
  params: Record<string, string>,
): Promise<{ rows: Record<string, string>[]; total: number }> {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  const url = `https://apis.data.go.kr/1160100/${path}?serviceKey=${KEY()}&${qs}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  if (!res.ok || text.includes("OpenAPI_ServiceResponse"))
    throw new Error(`data.go.kr ${res.status}: ${text.slice(0, 160).replace(/\s+/g, " ")}`);
  const body = (JSON.parse(text) as { response?: { body?: unknown } })?.response?.body as
    | { items?: { item?: unknown }; totalCount?: number }
    | undefined;
  const item = body?.items?.item;
  const rows = (item ? (Array.isArray(item) ? item : [item]) : []) as Record<string, string>[];
  return { rows, total: body?.totalCount ?? rows.length };
}

/** 오름차순 데이터의 최근 구간만 조회 (총건수 확인 후 마지막 페이지). */
async function fetchTail(
  path: string,
  op: string,
  crno: string,
  pageSize: number,
): Promise<Record<string, string>[]> {
  const head = await callApi(`${path}/${op}`, {
    resultType: "json",
    numOfRows: "1",
    pageNo: "1",
    crno,
  });
  if (head.total === 0) return [];
  const lastPage = Math.max(1, Math.ceil(head.total / pageSize));
  const tail = await callApi(`${path}/${op}`, {
    resultType: "json",
    numOfRows: String(pageSize),
    pageNo: String(lastPage),
    crno,
  });
  return tail.rows;
}

// ── 배당 (주당 배당금) ───────────────────────────────────────────────

/** 배당기준일(YYYYMMDD) → 보통주 주당 배당금 */
async function fetchDividendMap(crno: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const rows = await fetchTail("GetStocDiviInfoService_V2", "getDiviInfo_V2", crno, 300);
    for (const r of rows) {
      // 보통주(0101) 우선. 우선주만 있으면 그대로.
      const isCommon = r.scrsItmsKcd === "0101" || (r.scrsItmsKcdNm ?? "").includes("보통");
      const amt = num(r.stckGenrDvdnAmt);
      const bd = String(r.dvdnBasDt ?? "").replace(/\D/g, "");
      if (bd.length !== 8 || amt == null || amt <= 0) continue;
      if (isCommon || !map.has(bd)) map.set(bd, amt);
    }
  } catch {
    /* 배당 없으면 스킵 */
  }
  return map;
}

// ── 배당수익률용 종가 ────────────────────────────────────────────────

async function fetchCloseMap(
  srtnCd: string,
  beginYmd: string,
  endYmd: string,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const { rows } = await callApi(
      "service/GetStockSecuritiesInfoService/getStockPriceInfo",
      {
        resultType: "json",
        numOfRows: "400",
        pageNo: "1",
        beginBasDt: beginYmd,
        endBasDt: endYmd,
        likeSrtnCd: srtnCd,
      },
    );
    for (const r of rows) {
      const d = String(r.basDt ?? "").replace(/\D/g, "");
      const c = num(r.clpr);
      if (d.length === 8 && c != null) map.set(d, c);
    }
  } catch {
    /* 시세 실패 시 수익률 생략 */
  }
  return map;
}

/** 기준일 이하 가장 가까운 거래일 종가 */
function closeAtOrBefore(map: Map<string, number>, ymd: string): number | null {
  let best: string | null = null;
  for (const k of map.keys()) if (k <= ymd && (best === null || k > best)) best = k;
  return best ? map.get(best)! : null;
}

// ── 권리일정 ─────────────────────────────────────────────────────────

export interface KrRightEvent {
  /** 기준일 YYYY-MM-DD */
  basDt: string;
  /** 권리락일 YYYY-MM-DD */
  exRightsDate: string | null;
  /** 배당금지급일 YYYY-MM-DD */
  payoutDate: string | null;
  /** 권리사유 — 배당/분배, 무상증자, 유상증자, 액면분할 … */
  reason: string;
  /** 배당/분배: 주당 배당금(원) */
  dividendPerShare: number | null;
  /** 배당/분배: 배당수익률(%) = 주당배당금 / 기준일 종가 */
  dividendYield: number | null;
  /** 증자·액면·감자: 관련 DART 공시 */
  filing: { title: string; url: string; date: string } | null;
  /** 그 외 사유의 참고 텍스트 (액면가 등) */
  note: string | null;
}

export interface DartFilingLite {
  title: string;
  url: string;
  date: string;
}

const FILING_PATTERN: { test: RegExp; want: RegExp }[] = [
  { test: /무상증자/, want: /무상증자/ },
  { test: /유상증자/, want: /유상증자/ },
  { test: /분할/, want: /주식분할|액면.*분할|분할.*결정/ },
  { test: /병합/, want: /주식병합|액면.*병합|병합.*결정/ },
  { test: /감자|자본감소/, want: /감자|자본감소/ },
];

/** 사유·기준일에 가장 가까운 관련 공시 1건 */
function matchFiling(
  reason: string,
  basDt: string,
  filings: DartFilingLite[],
): DartFilingLite | null {
  const rule = FILING_PATTERN.find((r) => r.test.test(reason));
  if (!rule) return null;
  const base = new Date(basDt).getTime();
  const cand = filings
    .filter((f) => rule.want.test(f.title))
    .map((f) => ({ f, gap: Math.abs(new Date(f.date).getTime() - base) }))
    .filter((x) => x.gap <= 75 * 864e5)
    .sort((a, b) => a.gap - b.gap);
  return cand[0]?.f ?? null;
}

const EP_RIGHTS = "GetStocRighScheService_V2";
const OP_RIGHTS = "getRighExerReasSche_V2";
const KEEP = /배당|분배|증자|액면|감자|병합|분할/;

export async function fetchKrRightsSchedule(
  crno: string | null,
  srtnCd: string,
  filings: DartFilingLite[] = [],
): Promise<KrRightEvent[] | null> {
  if (!isConfigured() || !crno) return null;

  const rows = await fetchTail(EP_RIGHTS, OP_RIGHTS, crno, 300);
  if (rows.length === 0) return [];

  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const lo = cutoff.toISOString().slice(0, 10);

  const groups = new Map<string, KrRightEvent>();
  for (const r of rows) {
    const basDt = dash(r.basDt);
    if (!basDt || basDt < lo) continue;
    const reason = (r.stckIssuRcdNm ?? "권리행사").trim();
    if (!KEEP.test(reason)) continue;

    const gk = `${basDt}|${reason}`;
    if (!groups.has(gk)) {
      groups.set(gk, {
        basDt,
        exRightsDate: null,
        payoutDate: null,
        reason,
        dividendPerShare: null,
        dividendYield: null,
        filing: matchFiling(reason, basDt, filings),
        note: r.stckParPrc ? `액면가 ${Number(r.stckParPrc).toLocaleString()}원` : null,
      });
    }
    const g = groups.get(gk)!;
    const kind = (r.rgtExertRcdNm ?? "").trim();
    const start = dash(r.rgtExertSttgDt) ?? dash(r.nmlsLckSttgDt);
    if (kind === "권리락일") g.exRightsDate = start;
    else if (kind.startsWith("배당금지급일") && !g.payoutDate) g.payoutDate = start;
  }

  const events = [...groups.values()].sort((a, b) => b.basDt.localeCompare(a.basDt));
  if (events.length === 0) return [];

  // 배당 이벤트에 주당 배당금 + 수익률 부착
  const divEvents = events.filter((e) => /배당|분배/.test(e.reason));
  if (divEvents.length > 0) {
    const divMap = await fetchDividendMap(crno);
    const dates = divEvents.map((e) => e.basDt.replace(/-/g, "")).sort();
    const widen = (ymd: string, days: number) => {
      const d = new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10).replace(/-/g, "");
    };
    const closeMap = await fetchCloseMap(
      srtnCd,
      widen(dates[0], -10),
      widen(dates[dates.length - 1], 2),
    );
    for (const e of divEvents) {
      const ymd = e.basDt.replace(/-/g, "");
      const dps = divMap.get(ymd) ?? null;
      e.dividendPerShare = dps;
      if (dps != null) {
        const close = closeMap.get(ymd) ?? closeAtOrBefore(closeMap, ymd);
        if (close && close > 0) e.dividendYield = Math.round((dps / close) * 10000) / 100;
      }
    }
  }

  return events;
}
