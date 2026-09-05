import "server-only";
import iconv from "iconv-lite";

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
 * charset="cp949" 지정 시 원문 바이트를 CP949(확장 EUC-KR)로 디코딩 후
 * JSON.parse. (KRX OPEN API가 서비스마다 응답 인코딩이 다름 — 대부분
 * UTF-8 이지만 선물 일별매매(drv/fut_bydd_trd)는 CP949 로 확인됨.
 * Node TextDecoder가 cp949를 지원 안 해 iconv-lite 사용.)
 */
async function krx<T = Record<string, string>>(
  path: string,
  params: Record<string, string>,
  charset?: "cp949",
): Promise<T[]> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/${path}?${qs}`, {
    headers: { AUTH_KEY: authKey() },
    signal: AbortSignal.timeout(20_000),
    next: { revalidate: 60 * 60 * 12 },
  });
  if (!res.ok) throw new Error(`KRX ${path} ${res.status}`);
  let j: { OutBlock_1?: T[] };
  if (charset === "cp949") {
    const buf = Buffer.from(await res.arrayBuffer());
    const text = iconv.decode(buf, "cp949");
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

/**
 * 코스피200 선물(표준, 미니 제외) 근월물 베이시스.
 * drv/fut_bydd_trd 응답은 CP949 인코딩 + 한글 필드가 상품별로 깨질 수 있고,
 * ISU_CD 접두사 체계도 시기별로 KRX가 바꿔서(예: 2022년 표준="101"/미니="105",
 * 2026년 표준="A016"/미니="A056") 접두사 하드코딩은 못 씀.
 * 대신 이름과 무관하게: ① 종가가 코스피200 지수 ±15% 이내인 선물만 추리면
 * 채권·업종 선물 등은 자동 제외되고, ② 그 중 미결제약정(ACC_OPNINT_QTY)이
 * 가장 큰 행 = 코스피200 "표준" 선물의 근월·정규장 (미니는 항상 표준보다
 * 유동성이 훨씬 작아 자연히 걸러짐).
 */
export async function fetchKospi200Futures(
  basDd: string,
): Promise<{ close: number | null; spot: number | null; basis: number | null }> {
  const [rows, k200] = await Promise.all([
    krx("drv/fut_bydd_trd", { basDd }, "cp949"),
    fetchKospi200Index(basDd),
  ]);
  if (k200 == null) return { close: null, spot: null, basis: null };
  const candidates = rows.filter((r) => {
    const close = n(r.TDD_CLSPRC);
    return close != null && Math.abs(close - k200) < k200 * 0.15;
  });
  if (!candidates.length) return { close: null, spot: null, basis: null };
  // 미결제약정은 주간/야간이 같은 계약을 공유해 거의 동일 — 이걸로는 종목(ISU_CD)만
  // 특정하고, 주간(거래량이 훨씬 큼) 선택은 거래량으로 별도 판단
  candidates.sort((a, b) => (n(b.ACC_OPNINT_QTY) ?? 0) - (n(a.ACC_OPNINT_QTY) ?? 0));
  const nearCode = candidates[0].ISU_CD;
  const sameCode = candidates.filter((r) => r.ISU_CD === nearCode);
  sameCode.sort((a, b) => (n(b.ACC_TRDVOL) ?? 0) - (n(a.ACC_TRDVOL) ?? 0));
  const best = sameCode[0];
  const close = n(best.TDD_CLSPRC);
  const spot = n(best.SPOT_PRC) ?? k200;
  return { close, spot, basis: close != null && spot != null ? close - spot : null };
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
