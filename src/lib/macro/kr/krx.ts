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

/**
 * charset 지정 시 원문 바이트를 해당 인코딩으로 디코딩 후 JSON.parse.
 * (KRX OPEN API가 서비스마다 응답 인코딩이 다름 — 대부분 UTF-8 이지만
 * 선물 일별매매(drv/fut_bydd_trd)는 EUC-KR 로 확인됨.)
 */
async function krx<T = Record<string, string>>(
  path: string,
  params: Record<string, string>,
  charset?: string,
): Promise<T[]> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/${path}?${qs}`, {
    headers: { AUTH_KEY: authKey() },
    signal: AbortSignal.timeout(20_000),
    next: { revalidate: 60 * 60 * 12 },
  });
  if (!res.ok) throw new Error(`KRX ${path} ${res.status}`);
  let j: { OutBlock_1?: T[] };
  if (charset) {
    const buf = await res.arrayBuffer();
    const text = new TextDecoder(charset).decode(buf);
    j = JSON.parse(text) as { OutBlock_1?: T[] };
  } else {
    j = (await res.json()) as { OutBlock_1?: T[] };
  }
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

/** KOSPI 200 변동성지수(VKOSPI). KRX 파생지수 응답에 옵션지수가 간헐적으로 빠져 재시도 */
export async function fetchVkospi(basDd: string): Promise<number | null> {
  for (let i = 0; i < 3; i++) {
    try {
      const rows = await krx("idx/drvprod_dd_trd", { basDd });
      const v = rows.find((r) => (r.IDX_NM ?? "").includes("변동성지수"));
      if (v) return n(v.CLSPRC_IDX);
    } catch {
      // 재시도
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return null;
}

/** KOSPI 지수 종가 (해당일) */
export async function fetchKospiIndex(basDd: string): Promise<number | null> {
  const rows = await krx("idx/kospi_dd_trd", { basDd });
  const v = rows.find((r) => (r.IDX_NM ?? "").trim() === "코스피");
  return v ? n(v.CLSPRC_IDX) : null;
}

/** 코스피200 지수(현물) 종가 — 베이시스 계산용 */
export async function fetchKospi200Index(basDd: string): Promise<number | null> {
  const rows = await krx("idx/kospi_dd_trd", { basDd });
  const v = rows.find((r) => {
    const nm = (r.IDX_NM ?? "").trim();
    return nm === "코스피 200" || nm === "코스피200";
  });
  return v ? n(v.CLSPRC_IDX) : null;
}

/** 임시 진단용 — 선물 일별매매 원본 행 그대로 반환 (필드명·경로 확인용) */
export async function fetchFuturesRaw(basDd: string, path: string): Promise<Record<string, string>[]> {
  return krx(path, { basDd }, "cp949");
}

/**
 * 코스피200 계열 옵션 풋/콜 비율.
 *  - byVolume: 거래량(계약수) 기준
 *  - byValue : 거래대금 기준 (개인 투기 쏠림이 덜 반영 → 메이저 심리에 더 정확, 권장)
 */
export async function fetchPutCall(
  basDd: string,
): Promise<{ byVolume: number | null; byValue: number | null }> {
  const rows = await krx("drv/opt_bydd_trd", { basDd });
  let callVol = 0;
  let putVol = 0;
  let callVal = 0;
  let putVal = 0;
  for (const r of rows) {
    const prod = r.PROD_NM ?? "";
    if (!prod.includes("코스피200") && !prod.includes("코스피 200")) continue;
    const vol = n(r.ACC_TRDVOL) ?? 0;
    const val = n(r.ACC_TRDVAL) ?? 0;
    if (r.RGHT_TP_NM === "CALL") {
      callVol += vol;
      callVal += val;
    } else if (r.RGHT_TP_NM === "PUT") {
      putVol += vol;
      putVal += val;
    }
  }
  return {
    byVolume: callVol > 0 ? putVol / callVol : null,
    byValue: callVal > 0 ? putVal / callVal : null,
  };
}
