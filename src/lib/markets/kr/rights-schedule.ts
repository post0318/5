import "server-only";

/**
 * 금융위원회 공공데이터포털 (data.go.kr, 1160100) — 한국 주식 권리일정 + 배당.
 *  권리일정 : GetStocRighScheService_V2/getRighExerReasSche_V2
 *  배당정보 : GetStocDiviInfoService_V2/getDiviInfo_V2
 *  시세     : GetStockSecuritiesInfoService/getStockPriceInfo (배당수익률 계산용 종가)
 *  DATA_GO_KR_KEY 필요 (Encoding 인증키 — 이미 URL 인코딩된 문자열).
 *
 * 종목 필터는 법인등록번호(crno). 일 1회 갱신(익영업일 오전 8시).
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

interface DivRecord {
  ymd: string; // 배당기준일 YYYYMMDD
  amt: number; // 보통주 주당 배당금
  payYmd: string | null; // 현금배당지급일
}

/** 보통주 배당 내역 (배당기준일·주당배당금·지급일) */
async function fetchDividendList(crno: string): Promise<DivRecord[]> {
  try {
    const rows = await fetchTail("GetStocDiviInfoService_V2", "getDiviInfo_V2", crno, 400);
    const out: DivRecord[] = [];
    for (const r of rows) {
      const isCommon = r.scrsItmsKcd === "0101" || (r.scrsItmsKcdNm ?? "").includes("보통");
      if (!isCommon) continue;
      const amt = num(r.stckGenrDvdnAmt);
      const bd = String(r.dvdnBasDt ?? "").replace(/\D/g, "");
      if (bd.length !== 8 || amt == null || amt <= 0) continue;
      const pd = String(r.cashDvdnPayDt ?? "").replace(/\D/g, "");
      out.push({ ymd: bd, amt, payYmd: pd.length === 8 ? pd : null });
    }
    return out.sort((a, b) => a.ymd.localeCompare(b.ymd));
  } catch {
    return [];
  }
}

const daysBetween = (a: string, b: string) => {
  const t = (y: string) =>
    Date.UTC(+y.slice(0, 4), +y.slice(4, 6) - 1, +y.slice(6, 8));
  return Math.round((t(a) - t(b)) / 864e5);
};

/**
 * 주당 배당금 — 보통주 기준.
 *  - annual : 최근 "완결" 회계연도(캘린더연도) 배당기준일 합계
 *  - ttm    : 최근 12개월(366일) 내 배당기준일 합계
 */
export async function fetchKrAnnualDps(crno: string | null): Promise<{
  annual: { dps: number; year: number } | null;
  ttm: { dps: number; from: string; to: string } | null;
} | null> {
  if (!isConfigured() || !crno) return null;
  let rows: Record<string, string>[];
  try {
    rows = await fetchTail("GetStocDiviInfoService_V2", "getDiviInfo_V2", crno, 400);
  } catch {
    return null;
  }

  const events: { bd: string; amt: number }[] = [];
  for (const r of rows) {
    const isCommon = r.scrsItmsKcd === "0101" || (r.scrsItmsKcdNm ?? "").includes("보통");
    if (!isCommon) continue;
    const amt = num(r.stckGenrDvdnAmt);
    const bd = String(r.dvdnBasDt ?? "").replace(/\D/g, "");
    if (bd.length !== 8 || amt == null || amt <= 0) continue;
    events.push({ bd, amt });
  }
  if (events.length === 0) return { annual: null, ttm: null };
  events.sort((a, b) => a.bd.localeCompare(b.bd));
  const ymd = (b: string) => `${b.slice(0, 4)}-${b.slice(4, 6)}-${b.slice(6, 8)}`;

  // annual: 연도별 합산 → 직전연도 우선
  const byYear = new Map<number, number>();
  for (const e of events) byYear.set(+e.bd.slice(0, 4), (byYear.get(+e.bd.slice(0, 4)) ?? 0) + e.amt);
  const yy = new Date().getFullYear();
  let annual: { dps: number; year: number } | null = null;
  for (const y of [yy - 1, yy, yy - 2]) {
    const v = byYear.get(y);
    if (v) {
      annual = { dps: Math.round(v * 100) / 100, year: y };
      break;
    }
  }

  // ttm: 최근 366일
  const cut = new Date();
  cut.setDate(cut.getDate() - 366);
  const lo = cut.toISOString().slice(0, 10).replace(/-/g, "");
  const t = events.filter((e) => e.bd >= lo);
  const ttm =
    t.length > 0
      ? {
          dps: Math.round(t.reduce((s, e) => s + e.amt, 0) * 100) / 100,
          from: ymd(t[0].bd),
          to: ymd(t[t.length - 1].bd),
        }
      : null;

  return { annual, ttm };
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

  // 조회일 기준 최근 4분기(+버퍼) — 분기 경계 근처에서도 4건이 잡히도록 15개월
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 15);
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

  let events = [...groups.values()].sort((a, b) => b.basDt.localeCompare(a.basDt));
  if (events.length === 0) return [];

  // 배당 이벤트에 주당 배당금 + 지급일 + 수익률 부착
  const divEvents = events.filter((e) => /배당|분배/.test(e.reason));
  if (divEvents.length > 0) {
    const divList = await fetchDividendList(crno);
    // 각 배당 이벤트를 가장 가까운 배당기준일(±80일)에 매칭
    const matchedRec = new Map<KrRightEvent, DivRecord>();
    for (const e of divEvents) {
      const ey = e.basDt.replace(/-/g, "");
      let best: DivRecord | null = null;
      let bestGap = 81;
      for (const rec of divList) {
        const gap = Math.abs(daysBetween(rec.ymd, ey));
        if (gap < bestGap) {
          bestGap = gap;
          best = rec;
        }
      }
      if (best) matchedRec.set(e, best);
    }
    // 같은 배당 레코드에 여러 이벤트가 붙으면 금액 있는 쪽만 남김
    const byRec = new Map<DivRecord, KrRightEvent[]>();
    for (const [e, rec] of matchedRec) byRec.set(rec, [...(byRec.get(rec) ?? []), e]);
    const drop = new Set<KrRightEvent>();
    for (const [rec, es] of byRec) {
      if (es.length < 2) continue;
      // 배당기준일과 basDt가 가장 가까운 것을 대표로
      es.sort(
        (a, b) =>
          Math.abs(daysBetween(rec.ymd, a.basDt.replace(/-/g, ""))) -
          Math.abs(daysBetween(rec.ymd, b.basDt.replace(/-/g, ""))),
      );
      es.slice(1).forEach((e) => drop.add(e));
    }
    events = events.filter((e) => !drop.has(e));

    // 종가 조회 창
    const ys = divEvents
      .filter((e) => !drop.has(e))
      .map((e) => e.basDt.replace(/-/g, ""))
      .sort();
    const widen = (ymd: string, days: number) => {
      const d = new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10).replace(/-/g, "");
    };
    const closeMap = ys.length
      ? await fetchCloseMap(srtnCd, widen(ys[0], -10), widen(ys[ys.length - 1], 2))
      : new Map<string, number>();

    for (const e of divEvents) {
      if (drop.has(e)) continue;
      const rec = matchedRec.get(e);
      if (!rec) continue;
      e.dividendPerShare = rec.amt;
      if (!e.payoutDate && rec.payYmd) {
        e.payoutDate = `${rec.payYmd.slice(0, 4)}-${rec.payYmd.slice(4, 6)}-${rec.payYmd.slice(6, 8)}`;
      }
      const ymd = e.basDt.replace(/-/g, "");
      const close = closeMap.get(ymd) ?? closeAtOrBefore(closeMap, ymd);
      if (close && close > 0) e.dividendYield = Math.round((rec.amt / close) * 10000) / 100;
    }
  }

  return events;
}
