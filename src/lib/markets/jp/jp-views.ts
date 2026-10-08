import "server-only";
import { fetchYahooEstimates } from "../quote/yahoo";
import type { FinancialStatement, TtmFlows } from "../types";
import type { FinancialHighlights } from "../us/edgar-highlights";
import { jpFundamentals, jpTtmFromModel, jpValuation, loadJpPx, type JpFund, type JpPx, type JpVal } from "./jp-ev";
import { buildJpAnalysis } from "./jp-analysis";
import { buildJpHighlights } from "./jp-highlights";
import { getJpFinModel } from "./statements";

/**
 * 일본 하이라이트·재무분석·개요 TTM·컨센서스 실적 행 — 조립(statements.ts) + 시세를 한 번 읽어 jp-ev.ts 단일 기준으로 계산한다.
 * 시세 조회 실패는 경고로 남기고(시가총액·멀티플 공란 + 사유) 재무 값은 그대로 보여 준다(조용한 대체 금지).
 */
async function load(symbol: string): Promise<{ f: JpFund; v: JpVal; px: JpPx | null; warn: string[]; pxFail: string | null; model: Awaited<ReturnType<typeof getJpFinModel>> }> {
  const st: { fail: string | null } = { fail: null };
  const [model, px] = await Promise.all([
    getJpFinModel(symbol),
    loadJpPx(symbol).catch((e) => {
      st.fail = `시세 조회 실패 — ${e instanceof Error ? e.message : String(e)} (시가총액·멀티플 공란)`;
      return null;
    }),
  ]);
  const pxFail = st.fail;
  const f = jpFundamentals(model);
  const v = jpValuation(f, px);
  const warn = [...(pxFail ? [`⚠ ${pxFail}`] : []), ...model.warn.slice(0, 5).map((w) => `⚠ 서류 판독 경고: ${w}`)];
  return { f, v, px, warn, pxFail, model };
}

export async function getJpHighlights(symbol: string, yahoo?: string | null): Promise<FinancialHighlights> {
  const [{ f, v, px, warn }, est] = await Promise.all([
    load(symbol),
    fetchYahooEstimates("jp", symbol, yahoo).catch(() => null),
  ]);
  const notes = [...warn];
  if (!est) notes.push("예상치(yahoo) 조회 실패 — 예상 열 없음");
  return buildJpHighlights(
    f,
    v,
    (est?.periods ?? []).map((p) => ({ period: p.period, endDate: p.endDate, epsAvg: p.epsAvg, revenueAvg: p.revenueAvg })),
    px?.lastDate ?? null,
    notes,
  );
}

export async function getJpAnalysis(symbol: string): Promise<FinancialStatement> {
  const { f, v, px, warn } = await load(symbol);
  return buildJpAnalysis(f, v, symbol, px?.lastDate ?? null, warn);
}

/** adapter.getTtm — 개요 멀티플·유니버스(computeTrailingMultiples 스냅샷 경로) */
export async function getJpTtm(symbol: string): Promise<TtmFlows> {
  const { model, px, pxFail } = await load(symbol);
  const t = jpTtmFromModel(model, px);
  // 시세 실패만 불완전 표시(서류 판독 경고는 재무 값 자체의 사유 — 칸 주석·하이라이트 주석에)
  if (pxFail) t.degraded = [pxFail];
  return t;
}

/** 컨센서스 실적 행 — 하이라이트와 같은 값(사업연도 → 값·사유) */
export interface JpConsensusYear {
  revenue: number | null;
  opIncome: number | null;
  netIncome: number | null;
  eps: number | null;
  bps: number | null;
  per: number | null;
  pbr: number | null;
  roe: number | null;
  evEbitda: number | null;
  price: number | null;
  notes: Partial<Record<"eps" | "bps" | "per" | "pbr" | "evEbitda" | "opIncome" | "netIncome", string>>;
}
export async function getJpConsensusYears(symbol: string): Promise<{ years: Map<number, JpConsensusYear>; fiscalMonth: number; warn: string[] }> {
  const { f, v, warn } = await load(symbol);
  const years = new Map<number, JpConsensusYear>();
  f.cols.forEach((c, i) => {
    if (c.kind !== "fy") return;
    const notes: JpConsensusYear["notes"] = {};
    const put = (k: keyof JpConsensusYear["notes"], s: string | null) => {
      if (s) notes[k] = s;
    };
    put("eps", v.eps.v[i] == null ? v.eps.n[i] : null);
    put("bps", v.bps.v[i] == null ? v.bps.n[i] : null);
    put("per", v.per.n[i]);
    put("pbr", v.pbr.v[i] == null ? v.pbr.n[i] : null);
    put("evEbitda", v.evEbitda.n[i]);
    put("opIncome", f.op.n[i]);
    put("netIncome", f.ni.v[i] == null ? f.ni.n[i] : null);
    years.set(c.fy, {
      revenue: f.rev.v[i],
      opIncome: f.op.v[i],
      netIncome: f.ni.v[i],
      eps: v.eps.v[i],
      bps: v.bps.v[i],
      per: v.per.v[i],
      pbr: v.pbr.v[i],
      roe: v.roe.v[i],
      evEbitda: v.evEbitda.v[i],
      price: v.price[i],
      notes,
    });
  });
  const lastEnd = f.cols.filter((c) => c.kind === "fy").at(-1)?.end;
  return { years, fiscalMonth: lastEnd ? Number(lastEnd.slice(5, 7)) : 3, warn };
}
