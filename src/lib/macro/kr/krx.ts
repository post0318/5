import "server-only";

/**
 * KRX 정보데이터시스템 OPEN API — 한국판 공포·탐욕 지수용 원자료.
 * AUTH_KEY 헤더. 서비스: 전종목 일별매매 / 파생상품지수(VKOSPI) / 옵션 일별매매.
 */

const BASE = "https://data-dbg.krx.co.kr/svc/apis";

function authKey(): string {
  const k = process.env.KRX_API_KEY;
  if (!k) throw new Error("KRX_API_KEY 미설정");
  return k;
}

async function krx<T = Record<string, string>>(
  path: string,
  params: Record<string, string>,
): Promise<T[]> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/${path}?${qs}`, {
    headers: { AUTH_KEY: authKey() },
    signal: AbortSignal.timeout(20_000),
    next: { revalidate: 60 * 60 * 12 },
  });
  if (!res.ok) throw new Error(`KRX ${path} ${res.status}`);
  const j = (await res.json()) as { OutBlock_1?: T[] };
  return j.OutBlock_1 ?? [];
}

const n = (v: string | undefined) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/** basDd: YYYYMMDD */
export interface DayStockRow {
  code: string;
  market: "KOSPI" | "KOSDAQ";
  close: number | null;
  changePrc: number | null; // 전일 대비 (원)
  high: number | null;
  low: number | null;
  volume: number | null;
}

export async function fetchAllStocks(basDd: string): Promise<DayStockRow[]> {
  const [kospi, kosdaq] = await Promise.all([
    krx("sto/stk_bydd_trd", { basDd }),
    krx("sto/ksq_bydd_trd", { basDd }),
  ]);
  const map = (rows: Record<string, string>[], market: "KOSPI" | "KOSDAQ"): DayStockRow[] =>
    rows.map((r) => ({
      code: r.ISU_CD ?? "",
      market,
      close: n(r.TDD_CLSPRC),
      changePrc: n(r.CMPPREVDD_PRC),
      high: n(r.TDD_HGPRC),
      low: n(r.TDD_LWPRC),
      volume: n(r.ACC_TRDVOL),
    }));
  return [...map(kospi, "KOSPI"), ...map(kosdaq, "KOSDAQ")];
}

/** KOSPI 200 변동성지수(VKOSPI) */
export async function fetchVkospi(basDd: string): Promise<number | null> {
  const rows = await krx("idx/drvprod_dd_trd", { basDd });
  const v = rows.find((r) => (r.IDX_NM ?? "").includes("변동성지수"));
  return v ? n(v.CLSPRC_IDX) : null;
}

/** KOSPI 지수 종가 (해당일) */
export async function fetchKospiIndex(basDd: string): Promise<number | null> {
  const rows = await krx("idx/kospi_dd_trd", { basDd });
  const v = rows.find((r) => (r.IDX_NM ?? "").trim() === "코스피");
  return v ? n(v.CLSPRC_IDX) : null;
}

/** 코스피200 계열 옵션 풋/콜 거래량 비율 */
export async function fetchPutCall(basDd: string): Promise<number | null> {
  const rows = await krx("drv/opt_bydd_trd", { basDd });
  let call = 0;
  let put = 0;
  for (const r of rows) {
    const prod = r.PROD_NM ?? "";
    if (!prod.includes("코스피200") && !prod.includes("코스피 200")) continue;
    const vol = n(r.ACC_TRDVOL) ?? 0;
    if (r.RGHT_TP_NM === "CALL") call += vol;
    else if (r.RGHT_TP_NM === "PUT") put += vol;
  }
  return call > 0 ? put / call : null;
}
