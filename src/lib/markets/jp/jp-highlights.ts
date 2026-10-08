import "server-only";
import type { FinancialHighlights, HighlightColumn, HighlightRow } from "../us/edgar-highlights";
import type { JpFund, JpVal, Ser } from "./jp-ev";

/**
 * 일본 재무 하이라이트 — 미국 `edgar-highlights.ts`·한국 `dart-highlights.ts` 와 같은 표(EV 브릿지 + 5개 사업연도 + 현재/LTM + 예상).
 * 값은 전부 jp-ev.ts(단일 기준)에서 — 여기서는 열·줄 배치와 칸 주석만.
 * 금융업(은행·보험 서식 — 日本郵政 등)은 미국 은행 레이아웃처럼 EV·EBITDA 없이 경상수익·경상이익·순이익·ROE·PER·PBR·DPS.
 */

export interface JpEstimate {
  period: string;
  endDate: string | null;
  epsAvg: number | null;
  revenueAvg: number | null;
}

const yoy = (cur: number | null, prev: number | null): number | null =>
  cur == null || prev == null || prev === 0 ? null : ((cur - prev) / Math.abs(prev)) * 100;
const margin = (part: number | null, whole: number | null): number | null =>
  part == null || whole == null || whole === 0 ? null : (part / whole) * 100;

export function buildJpHighlights(f: JpFund, v: JpVal, estimates: JpEstimate[], asOfLtm: string | null, extraNotes: string[] = []): FinancialHighlights {
  const nBase = f.cols.length;
  const lastFy = f.cols.filter((c) => c.kind === "fy").at(-1);
  const columns: HighlightColumn[] = f.cols.map((c) =>
    c.kind === "ltm"
      ? { key: "LTM", label: "현재/LTM", date: asOfLtm ?? c.end, kind: "ltm" }
      : { key: `FY${c.fy}`, label: `${c.fy}Y`, date: c.end, kind: "fy" },
  );
  const est: JpEstimate[] = [];
  for (const p of estimates) {
    if (!["0y", "+1y", "+2y"].includes(p.period) || !p.endDate || !lastFy || p.endDate <= lastFy.end) continue;
    if (est.some((e) => e.endDate!.slice(0, 7) === p.endDate!.slice(0, 7))) continue;
    est.push(p);
  }
  est.sort((a, b) => a.endDate!.localeCompare(b.endDate!));
  for (const e of est.slice(0, 2)) {
    const y = Number(e.endDate!.slice(0, 4));
    columns.push({ key: `FY${y}E`, label: `${y}Y 예상`, date: e.endDate!, kind: "estimate" });
  }
  const nCol = columns.length;
  const estOf = (i: number) => (i >= nBase ? est[i - nBase] : null);
  const ltmI = f.cols.findIndex((c) => c.kind === "ltm");
  const curShares = ltmI >= 0 ? v.shares.v[ltmI] : null;
  const curMcap = ltmI >= 0 ? v.mcap.v[ltmI] : null;
  const curPrice = ltmI >= 0 ? v.price[ltmI] : null;

  /** 기본 열 값 + 예상 열(est 함수) — 칸 주석은 기본 열만 */
  const row = (key: string, label: string, format: HighlightRow["format"], s: Ser | null, extra: Partial<HighlightRow> = {}, estFn?: (e: JpEstimate) => number | null): HighlightRow => {
    const values = columns.map((_, i) => (i < nBase ? (s?.v[i] ?? null) : estFn ? estFn(estOf(i)!) : null));
    const notes = columns.map((_, i) => (i < nBase ? (s?.n[i] ?? null) : null));
    return { key, label, format, values, ...(notes.some(Boolean) ? { cellNotes: notes } : {}), ...extra };
  };
  const pct = (key: string, vals: (number | null)[]): HighlightRow => ({ key, label: "", format: "pct", indent: true, values: vals });
  const spacer = (key: string): HighlightRow => ({ key, label: "", format: "money", spacer: true, values: Array(nCol).fill(null) });
  /** 연도 열 YoY(앞 열이 바로 전 사업연도일 때만), LTM = 최근 사업연도 대비(LTM 이 최근 사업연도와 같으면 공란), 예상 열 = 앞 열 대비 */
  const seq = (vals: (number | null)[]): (number | null)[] =>
    vals.map((x, i) => {
      if (i === 0) return null;
      const c = columns[i];
      if (c.kind === "ltm") return f.ltmIsFy ? null : yoy(x, vals[i - 1]);
      return yoy(x, vals[c.kind === "estimate" && columns[i - 1].kind === "ltm" ? i - 2 : i - 1]);
    });

  const rev = row("revenue", f.financial ? "경상수익" : "매출액", "money", f.rev, {}, (e) => e.revenueAvg);
  const op = row("opinc", "영업이익", "money", f.op);
  const ord = row("ordinary", "경상이익", "money", f.ordinary);
  const ebitda = row("ebitda", "EBITDA", "money", f.ebitda);
  const niEst = (e: JpEstimate) => (e.epsAvg != null && curShares != null ? e.epsAvg * curShares : null);
  const ni = row("ni", "순이익 (지배)", "money", f.ni, {}, niEst);
  const eps = row("eps", "EPS (희석)", "eps", v.eps, {}, (e) => e.epsAvg);
  const dps = row("dps", "DPS", "eps", v.dps);
  const divY: HighlightRow = { ...row("divyield", "배당수익률 %", "pct", v.divYield), indent: true };
  const m = (r: HighlightRow) => r.values.map((x, i) => margin(x, rev.values[i]));

  const mc = row("mktcap", "시가총액", "money", v.mcap);
  const valuation: HighlightRow[] = [
    row("per", "PER", "mult", v.per, {}, (e) => (curPrice != null && e.epsAvg != null && e.epsAvg > 0 ? curPrice / e.epsAvg : null)),
    row("pbr", "PBR", "mult", v.pbr),
    row("psr", f.financial ? "PSR (경상수익 기준)" : "PSR", "mult", v.psr, {}, (e) => (curMcap != null && e.revenueAvg ? curMcap / e.revenueAvg : null)),
    ...(f.financial ? [] : [row("ev_ebitda", "EV/EBITDA", "mult", v.evEbitda)]),
  ];

  let rows: HighlightRow[];
  if (f.financial) {
    rows = [
      mc,
      spacer("sp0"),
      row("equity", "자기자본 (지배주주)", "money", f.eqParent),
      { ...row("assets", "자산총계", "money", f.assets), emphasis: true },
      spacer("sp1"),
      rev,
      { ...pct("revenue_yoy", seq(rev.values)), label: "성장률 % YoY" },
      ord,
      { ...pct("ordinary_m", m(ord)), label: "마진 %" },
      ni,
      { ...pct("ni_m", m(ni)), label: "마진 %" },
      { ...row("roe", "ROE %", "pct", v.roe), indent: true },
      eps,
      { ...pct("eps_yoy", seq(eps.values)), label: "성장률 % YoY" },
      dps,
      divY,
    ];
  } else {
    const cashNeg: Ser = { v: f.cash.v.map((x) => (x == null ? null : -x)), n: f.cash.n };
    const ocf = row("ocf", "영업활동 현금흐름", "money", f.ocf);
    const capexNeg: Ser = { v: f.capex.v.map((x) => (x == null ? null : -x)), n: f.capex.n };
    const fcf: Ser = { v: f.ocf.v.map((x, i) => (x != null && f.capex.v[i] != null ? x - f.capex.v[i]! : null)), n: f.ocf.n.map((x, i) => x ?? f.capex.n[i]) };
    rows = [
      mc,
      { ...row("cash", "− 현금성자산", "money", cashNeg) },
      row("debt", "+ 총차입금 (리스부채 포함)", "money", f.debt),
      ...(f.nci.v.some((x) => x != null && x !== 0) ? [row("nci", "+ 비지배지분", "money", f.nci)] : []),
      { ...row("ev", "기업가치 (EV)", "money", v.ev), emphasis: true },
      spacer("sp1"),
      rev,
      { ...pct("revenue_yoy", seq(rev.values)), label: "성장률 % YoY" },
      op,
      { ...pct("opinc_m", m(op)), label: "마진 %" },
      ebitda,
      { ...pct("ebitda_m", m(ebitda)), label: "마진 %" },
      ni,
      { ...pct("ni_m", m(ni)), label: "마진 %" },
      eps,
      { ...pct("eps_yoy", seq(eps.values)), label: "성장률 % YoY" },
      dps,
      divY,
      spacer("sp2"),
      ocf,
      row("capex", "자본지출", "money", capexNeg),
      row("fcf", "잉여현금흐름", "money", fcf),
    ];
  }

  const notes = [
    `실적·재무상태표·현금흐름: EDINET 有価証券報告書·半期報告書 XBRL 본표(${f.std ?? "기준 미상"} · ${f.cons ? "연결" : "개별"}) — 열마다 그 기간을 실은 가장 나중 제출본`,
    "시가총액: 각 결산일(현재/LTM = 현재가) 실제 종가 × 그 날 유통주식수(발행주식수 − 회사 명의 자기주식, 有報 株式の総数等·自己株式等)",
    ...(f.financial
      ? ["금융업(은행·보험 서식) — 경상수익·경상이익 기준, EV·EBITDA 는 계산하지 않음(예금·보험부채가 영업 부채)"]
      : [
          "EV = 시가총액 + 총차입금(사채·차입금·CP·리스부채) + 비지배지분 − 현금성자산(現金及び現金同等物·現金及び預金 + 定期預金·短期投資·有価証券)",
          "EBITDA = 영업이익 + 감가상각비(현금흐름표 減価償却費·償却費 줄 — 손상이 함께 묶인 줄은 그대로, 따로 있는 減損損失 줄은 제외)",
        ]),
    "EPS = 경영지표 희석 EPS(희석 “－”이면 기본 EPS) · EPS·DPS 는 현재 주식 기준으로 분할 보정(PER·배당수익률은 같은 기준 주가)",
    "순이익 = 親会社株主(所有者)に帰属する当期純利益 · PBR 분모 = 지배주주 자본",
    f.ltmIsFy ? `현재/LTM: 최근 사업연도(${lastFy?.end ?? ""}) — 그 뒤 반기 보고서 아직 없음` : `현재/LTM: 최근 사업연도 + 반기 누적 − 전년 같은 반기, 재무상태표·주식수 = ${f.cols[ltmI]?.end ?? ""} 반기말`,
    ...(est.length ? ["예상(매출·EPS): yahoo-finance2 컨센서스 · 예상 순이익 = 예상 EPS × 현재 주식수 · 나머지 항목은 무료 컨센서스 없음"] : []),
    ...f.notes,
    ...v.notes,
    ...extraNotes,
  ];

  return {
    currency: "JPY",
    unitLabel: "JPY 백만",
    asOfLtm: asOfLtm ?? f.cols[ltmI]?.end ?? "",
    columns,
    rows,
    valuationRows: valuation,
    notes,
    source: "EDINET XBRL + Yahoo 시세 · 자체 계산",
  };
}
