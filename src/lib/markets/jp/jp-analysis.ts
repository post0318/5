import "server-only";
import type { FinancialLineItem, FinancialStatement } from "../types";
import type { JpFund, JpVal, Ser } from "./jp-ev";

/**
 * 일본 재무분석 — 미국 `edgar-analysis.ts`·한국 `dart-analysis.ts` 와 같은 섹션·라벨(개요 요약 칩 호환).
 * 열 = 최근 5개 사업연도 + 현재/LTM. 값은 jp-ev.ts(단일 기준) — 하이라이트·개요 멀티플과 같은 값.
 * 평균 잔액 = (기말 + 1년 전 기말) / 2 — 1년 전이 없으면 공란(기말로 대신하지 않음). LTM 열의 1년 전 = 전년 같은 반기말(반기 화면).
 * 금융업(은행·보험 서식)은 밸류에이션·수익성·주주환원·성장률만(EV·차입금·운전자본 지표는 의미 없음).
 */

const LTM = "현재/LTM";

export function buildJpAnalysis(f: JpFund, v: JpVal, symbol: string, asOfLtm: string | null, extraNotes: string[] = []): FinancialStatement {
  const n = f.cols.length;
  const labels = f.cols.map((c) => (c.kind === "ltm" ? LTM : `${c.fy}Y`));
  const idx = [...Array(n).keys()];
  type Arr = (number | null)[];
  const R = (label: string, vals: Arr, fmt: FinancialLineItem["numberFormat"], why: (string | null | undefined)[] = [], opts: Partial<FinancialLineItem> = {}): FinancialLineItem => {
    const values: Record<string, number | null> = {};
    const cellNotes: Record<string, string> = {};
    labels.forEach((l, i) => {
      const x = vals[i];
      values[l] = x != null && Number.isFinite(x) ? x : null;
      if (values[l] == null && why[i]) cellNotes[l] = why[i]!;
    });
    return { accountName: label, accountId: `an:${label}`, depth: 1, isSubtotal: false, isHighlight: false, values, numberFormat: fmt, ...(Object.keys(cellNotes).length ? { cellNotes } : {}), ...opts };
  };
  const HEAD = (t: string): FinancialLineItem => ({ accountName: t, accountId: `an:h:${t}`, depth: 0, isSubtotal: true, isHighlight: false, values: Object.fromEntries(labels.map((l) => [l, null])) });
  const SP = (k: string): FinancialLineItem => ({ accountName: "", accountId: `an:sp:${k}`, depth: 0, isSubtotal: false, isHighlight: false, values: Object.fromEntries(labels.map((l) => [l, null])) });
  /** 값 하나가 빈 칸이면 그 입력의 사유를 칸 주석으로 */
  const whyOf = (...ss: Ser[]) => idx.map((i) => ss.find((s) => s.v[i] == null && s.n[i])?.n[i] ?? null);
  const ratio = (a: Ser, b: Ser, k = 1): Arr => idx.map((i) => (a.v[i] != null && b.v[i] != null && b.v[i] !== 0 ? (a.v[i]! / b.v[i]!) * k : null));
  const posRatio = (a: Ser, b: Ser): Arr => idx.map((i) => (a.v[i] != null && b.v[i] != null && b.v[i]! > 0 ? a.v[i]! / b.v[i]! : null));
  const S = (vals: Arr, why: (string | null)[] = []): Ser => ({ v: vals, n: idx.map((i) => why[i] ?? null) });
  type BsField = "assets" | "eqAll" | "eqParent" | "curL" | "ar" | "inv" | "ap" | "curDebt";
  const NOPREV = "1년 전 기말 없음(평균 불가)";
  const avg = (field: BsField): Ser => {
    const s = f[field] as Ser;
    const vals = idx.map((i) => {
      const p = f.bsPrev(field, i);
      return s.v[i] != null && p != null ? (s.v[i]! + p) / 2 : null;
    });
    return S(vals, idx.map((i) => (vals[i] == null ? (s.v[i] == null ? s.n[i] : NOPREV) : null)));
  };
  /** 연도 열 YoY — 앞 열이 바로 전 사업연도일 때만. LTM = 최근 사업연도 대비(LTM 이 최근 사업연도와 같으면 공란) */
  const fyIdx = idx.filter((i) => f.cols[i].kind === "fy");
  const lastFy = fyIdx.at(-1) ?? -1;
  const yoy = (s: Ser): Arr =>
    idx.map((i) => {
      const prev = f.cols[i].kind === "ltm" ? (f.ltmIsFy ? -1 : lastFy) : fyIdx[fyIdx.indexOf(i) - 1] ?? -1;
      if (prev < 0) return null;
      const cur = s.v[i];
      const p = s.v[prev];
      return cur != null && p != null && p !== 0 ? ((cur - p) / Math.abs(p)) * 100 : null;
    });
  const yoyWhy = (s: Ser) => idx.map((i) => (f.cols[i].kind === "ltm" && f.ltmIsFy ? "LTM = 최근 사업연도(그 뒤 반기 없음)" : fyIdx.indexOf(i) === 0 ? "전년 열 없음" : (s.v[i] == null ? s.n[i] : null)));
  const cagr = (s: Ser, k: number): Arr =>
    idx.map((i) => {
      const at = f.cols[i].kind === "ltm" ? lastFy : i;
      const base = fyIdx[fyIdx.indexOf(at) - k];
      if (base == null) return null;
      const cur = f.cols[i].kind === "ltm" ? s.v[i] : s.v[at];
      const b = s.v[base];
      return cur != null && b != null && b > 0 && cur > 0 ? (Math.pow(cur / b, 1 / k) - 1) * 100 : null;
    });

  // ── 공통 계산 ──
  const fcf = S(idx.map((i) => (f.ocf.v[i] != null && f.capex.v[i] != null ? f.ocf.v[i]! - f.capex.v[i]! : null)), whyOf(f.ocf, f.capex));
  const netDebt = S(idx.map((i) => (f.debt.v[i] != null && f.cash.v[i] != null ? f.debt.v[i]! - f.cash.v[i]! : null)), whyOf(f.debt, f.cash));
  const eqA = avg("eqParent");
  const asA = avg("assets");
  const roe = ratio(f.ni, eqA, 100);
  const roa = ratio(f.ni, asA, 100);
  const niMargin = ratio(f.ni, f.rev, 100);
  const eps3 = cagr(v.eps, 3);
  const peg = idx.map((i) => (v.per.v[i] != null && v.per.v[i]! > 0 && eps3[i] != null && eps3[i]! >= 1 ? v.per.v[i]! / eps3[i]! : null));
  const payout = ratio(f.divPaid, f.ni, 100);

  let items: FinancialLineItem[];
  if (f.financial) {
    items = [
      HEAD("밸류에이션"),
      R("PER", v.per.v, "mult", v.per.n),
      R("PBR", v.pbr.v, "mult", v.pbr.n),
      R("PSR (경상수익 기준)", v.psr.v, "mult", v.psr.n),
      R("PEG (EPS 3Y CAGR)", peg, "mult"),
      SP("1"),
      HEAD("수익성"),
      R("ROE (%)", roe, "pct", whyOf(f.ni, eqA)),
      R("ROA (%)", roa, "pct", whyOf(f.ni, asA)),
      R("순이익률 (%)", niMargin, "pct", whyOf(f.ni, f.rev)),
      R("경상이익률 (%)", ratio(f.ordinary, f.rev, 100), "pct", whyOf(f.ordinary, f.rev)),
      R("유효세율 (%)", ratio(f.tax, f.pretax, 100), "pct", whyOf(f.tax, f.pretax)),
      SP("2"),
      HEAD("자본"),
      R("자기자본비율 (%)", ratio(f.eqParent, f.assets, 100), "pct", whyOf(f.eqParent, f.assets)),
      SP("3"),
      HEAD("주주환원"),
      R("배당성향 (%)", payout, "pct", whyOf(f.divPaid, f.ni)),
      SP("5"),
      HEAD("성장률 (1년 YoY)"),
      R("경상수익", yoy(f.rev), "pct", yoyWhy(f.rev)),
      R("경상이익", yoy(f.ordinary), "pct", yoyWhy(f.ordinary)),
      R("순이익", yoy(f.ni), "pct", yoyWhy(f.ni)),
      R("희석 EPS", yoy(v.eps), "pct", yoyWhy(v.eps)),
      SP("6"),
      HEAD("성장률 (3년 CAGR)"),
      R("경상수익", cagr(f.rev, 3), "pct"),
      R("EPS", eps3, "pct"),
    ];
  } else {
    const curLA = avg("curL");
    const curDA = avg("curDebt");
    const nopat = idx.map((i) => {
      const op = f.op.v[i];
      const pt = f.pretax.v[i];
      const tx = f.tax.v[i];
      if (op == null || !pt || tx == null) return null;
      return op * (1 - Math.min(Math.max(tx / pt, 0), 0.4));
    });
    const invCap = idx.map((i) => (asA.v[i] != null && curLA.v[i] != null && curDA.v[i] != null ? asA.v[i]! - (curLA.v[i]! - curDA.v[i]!) : null));
    const roic = idx.map((i) => (nopat[i] != null && invCap[i] ? (nopat[i]! / invCap[i]!) * 100 : null));
    const wc = idx.map((i) => (f.curA.v[i] != null && f.curL.v[i] != null ? f.curA.v[i]! - f.curL.v[i]! : null));
    const altZ = idx.map((i) => {
      const a = f.assets.v[i];
      const mc = v.mcap.v[i];
      if (!a || wc[i] == null || f.retained.v[i] == null || f.op.v[i] == null || mc == null || !f.liab.v[i] || f.rev.v[i] == null) return null;
      return 1.2 * (wc[i]! / a) + 1.4 * (f.retained.v[i]! / a) + 3.3 * (f.op.v[i]! / a) + 0.6 * (mc / f.liab.v[i]!) + 1.0 * (f.rev.v[i]! / a);
    });
    // 당좌비율 = (현금성자산 + 매출채권) / 유동부채 — 한국과 같은 범위(현금성자산에 단기투자 포함)
    const quick = idx.map((i) => (f.curL.v[i] ? ((f.cash.v[i] ?? 0) + (f.ar.v[i] ?? 0)) / f.curL.v[i]! : null));
    const cogs = S(idx.map((i) => (f.cogs.v[i] != null ? Math.abs(f.cogs.v[i]!) : f.rev.v[i] != null && f.gross.v[i] != null ? Math.abs(f.rev.v[i]! - f.gross.v[i]!) : null)), whyOf(f.cogs));
    const arA = avg("ar");
    const invA = avg("inv");
    const apA = avg("ap");
    const dso = ratio(arA, f.rev, 365);
    const dio = ratio(invA, cogs, 365);
    const dpo = ratio(apA, cogs, 365);
    const ccc = idx.map((i) => (dso[i] != null && dio[i] != null && dpo[i] != null ? dso[i]! + dio[i]! - dpo[i]! : null));
    // 주당 FCF — 현재 주식 기준(EPS·DPS 와 같은 분할 보정 기준): 주식수 = 시가총액 ÷ 주가(현재 기준 종가)
    const fcfPs = idx.map((i) => (fcf.v[i] != null && v.mcap.v[i] && v.price[i] ? (fcf.v[i]! * v.price[i]!) / v.mcap.v[i]! : null));
    items = [
      HEAD("밸류에이션"),
      R("PER", v.per.v, "mult", v.per.n),
      R("PBR", v.pbr.v, "mult", v.pbr.n),
      R("PSR", v.psr.v, "mult", v.psr.n),
      R("EV/EBITDA", v.evEbitda.v, "mult", v.evEbitda.n),
      R("PEG (EPS 3Y CAGR)", peg, "mult"),
      SP("1"),
      HEAD("수익성"),
      R("ROE (%)", roe, "pct", whyOf(f.ni, eqA)),
      R("순이익률 (%)", niMargin, "pct", whyOf(f.ni, f.rev), { depth: 2 }),
      R("× 총자산회전율 (회)", ratio(f.rev, asA), "mult", whyOf(f.rev, asA), { depth: 2 }),
      R("× 재무레버리지 (배)", ratio(asA, eqA), "mult", whyOf(asA, eqA), { depth: 2 }),
      R("ROA (%)", roa, "pct", whyOf(f.ni, asA)),
      R("ROIC (%)", roic, "pct", whyOf(f.op, f.tax, f.pretax, asA, curLA)),
      R("FCF 마진 (%)", ratio(fcf, f.rev, 100), "pct", whyOf(fcf, f.rev)),
      R("매출총이익률 (%)", ratio(f.gross, f.rev, 100), "pct", whyOf(f.gross, f.rev)),
      R("영업이익률 (%)", ratio(f.op, f.rev, 100), "pct", whyOf(f.op, f.rev)),
      R("유효세율 (%)", ratio(f.tax, f.pretax, 100), "pct", whyOf(f.tax, f.pretax)),
      SP("2"),
      HEAD("현금창출"),
      R("영업현금흐름 / 순이익", ratio(f.ocf, f.ni), "mult", whyOf(f.ocf, f.ni)),
      R("주당 FCF", fcfPs, "eps", whyOf(fcf, v.mcap)),
      SP("3"),
      HEAD("레버리지"),
      R("부채비율 (%)", ratio(f.liab, f.eqAll, 100), "pct", whyOf(f.liab, f.eqAll)),
      R("총차입금 / 자기자본 (%)", ratio(f.debt, f.eqAll, 100), "pct", whyOf(f.debt, f.eqAll)),
      R("총차입금 / 총자산 (%)", ratio(f.debt, f.assets, 100), "pct", whyOf(f.debt, f.assets)),
      R("순차입금 / 자기자본 (%)", ratio(netDebt, f.eqAll, 100), "pct", whyOf(netDebt, f.eqAll)),
      SP("4"),
      HEAD("재무건전성"),
      R("총차입금 / EBITDA", posRatio(f.debt, f.ebitda), "mult", whyOf(f.debt, f.ebitda)),
      R("순차입금 / EBITDA", posRatio(netDebt, f.ebitda), "mult", whyOf(netDebt, f.ebitda)),
      R("영업이익 / 총차입금", ratio(f.op, f.debt), "mult", whyOf(f.op, f.debt)),
      R("이자보상배율 (EBIT/이자)", ratio(f.op, f.intPaid), "mult", whyOf(f.op, f.intPaid)),
      R("CFO / 총차입금", ratio(f.ocf, f.debt), "mult", whyOf(f.ocf, f.debt)),
      R("FCF / 총차입금", ratio(fcf, f.debt), "mult", whyOf(fcf, f.debt)),
      R("알트만 Z-스코어", altZ, "pct", whyOf(f.op, v.mcap, f.retained)),
      SP("4a"),
      HEAD("유동성"),
      R("유동비율", ratio(f.curA, f.curL), "mult", whyOf(f.curA, f.curL)),
      R("당좌비율", quick, "mult", whyOf(f.curL)),
      R("현금비율", ratio(f.cash, f.curL), "mult", whyOf(f.cash, f.curL)),
      R("CFO / 유동부채", ratio(f.ocf, curLA), "mult", whyOf(f.ocf, curLA)),
      SP("4b"),
      HEAD("운전자본"),
      R("매출채권 회전일수 (DSO)", dso, "pct", whyOf(arA, f.rev)),
      R("재고자산 회전일수 (DIO)", dio, "pct", whyOf(invA, cogs)),
      R("매입채무 회전일수 (DPO)", dpo, "pct", whyOf(apA, cogs)),
      R("현금전환주기 (CCC)", ccc, "pct"),
      SP("4c"),
      HEAD("주주환원"),
      R("배당성향 (%)", payout, "pct", whyOf(f.divPaid, f.ni)),
      SP("5"),
      HEAD("성장률 (1년 YoY)"),
      R("매출액", yoy(f.rev), "pct", yoyWhy(f.rev)),
      R("영업이익", yoy(f.op), "pct", yoyWhy(f.op)),
      R("순이익", yoy(f.ni), "pct", yoyWhy(f.ni)),
      R("희석 EPS", yoy(v.eps), "pct", yoyWhy(v.eps)),
      R("영업활동 현금흐름", yoy(f.ocf), "pct", yoyWhy(f.ocf)),
      R("잉여현금흐름", yoy(fcf), "pct", yoyWhy(fcf)),
      SP("6"),
      HEAD("성장률 (3년 CAGR)"),
      R("매출액", cagr(f.rev, 3), "pct"),
      R("EPS", eps3, "pct"),
    ];
  }

  const ltmI = f.cols.findIndex((c) => c.kind === "ltm");
  return {
    symbol,
    market: "jp",
    periodType: "annual",
    unit: "円",
    currency: "JPY",
    consolidation: f.cons ? "consolidated" : "separate",
    periods: f.cols.map((c, i) => ({ label: labels[i], fiscalYear: c.kind === "ltm" ? c.fy + 1 : c.fy, fiscalQuarter: null, endDate: c.kind === "ltm" ? (asOfLtm ?? c.end) : c.end })),
    sections: [{ title: "분석 지표", items }],
    source:
      `EDINET XBRL 본표(${f.std ?? "기준 미상"}) + Yahoo 시세 · 자체 계산(하이라이트·개요와 같은 단일 기준 — jp-ev.ts)` +
      (f.ltmIsFy ? ` · 현재/LTM = 최근 사업연도(${f.cols[ltmI]?.end ?? ""} — 그 뒤 반기 보고서 없음)` : ` · LTM 흐름 = 최근 사업연도 + 반기 − 전년 반기, 재무상태표 = ${f.cols[ltmI]?.end ?? ""} 반기말`) +
      [...f.notes, ...v.notes, ...extraNotes].map((t) => ` · ${t}`).join(""),
  };
}
