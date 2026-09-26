import type { AssembledIs, CompanyProfile, DerivedInput, MetricSeries, MetricValue } from "../types";
import { cogsRuleFor } from "./cogs-rules";
import { FIN_TYPES } from "./cogs";

/**
 * 3층 — 영업이익·영업비용 지표 1단계(docs/metrics/cogs.md §8, 오너 지시 2026-09-26 — "매출원가부터 영업이익까지 같이 본다. 일반적이고
 * 기본적인 구성부터 확정"). **본표에 공시된 기본 구성만** 다룬다:
 *  - 영업이익 = 본표 영업이익 소계 줄(OperatingIncomeLoss · IFRS ProfitLossFromOperatingActivities) 값 그대로. 소계가 없는 열은 빈칸
 *    + "정의 대기"(합성 규칙은 2단계).
 *  - 영업비용 = 매출총이익(fin gp) − 영업이익. 본표 영업이익 식이 "매출총이익 − 영업비용 합계 한 줄"이면 그 줄과 정확 일치를 확인하고,
 *    다르면 값을 두고 주석·경고(이슈)로 낸다.
 *  - 2단계로 미룬 종목(유형 D 11종목·CAT)은 본표 소계가 있어도 빈칸 + "정의 대기"(기존 화면 값은 옛 계산 그대로 — 소비처 전환 전).
 * 화면(소비처)은 아직 이 값을 쓰지 않는다 — 전환은 매출원가·매출총이익 검증 통과 후(리드 지시).
 */

export const OPINC_NOTE = {
  /** 1단계 범위 밖 — 2단계에서 정의 */
  deferred: "정의 대기",
  /** 본표 영업비용 합계 줄 ≠ 매출총이익 − 영업이익 */
  opexMismatch: "본표 영업비용 합계 ≠ 매출총이익 − 영업이익",
} as const;

/** 2단계로 미룬 종목 — 유형 D(cogs-rules.ts 표) 외에 추가로 */
const DEFERRED: Record<string, string> = {
  CAT: "금융 자회사 보유(매출에 금융상품 수익 · 금융상품 이자비용은 영업비용 안) — 영업이익 정의 2단계",
};

export function opincOpex(cols: AssembledIs[], co: CompanyProfile, gp: MetricSeries): { opinc: MetricSeries; opex: MetricSeries } {
  const sym = co.symbol.toUpperCase();
  const deferred = DEFERRED[sym] ?? (FIN_TYPES.has(co.type) ? `금융사 기준(${co.type}) — 기존 금융사 화면 구성 유지, 영업이익 정의 2단계` : null) ?? (cogsRuleFor(sym) ? "본표에 매출원가 줄 없음(유형 D) — 영업이익·영업비용 정의 2단계" : null);
  const opinc: Record<string, MetricValue> = {};
  const opex: Record<string, MetricValue> = {};
  const fxCol = co.reportingCurrency !== "USD";
  for (const a of cols) {
    const key = a.col.key;
    const base = { col: key, end: a.col.end, gaps: a.col.gaps };
    const none = (rule: string, reason: string): MetricValue => ({ ...base, v: null, line: null, rule, reason });
    if (deferred) {
      opinc[key] = none("deferred", `${OPINC_NOTE.deferred} — ${deferred}`);
      opex[key] = none("deferred", `${OPINC_NOTE.deferred} — ${deferred}`);
      continue;
    }
    const opLine = a.faceShape ? (a.lines.find((l) => l.role === "opinc") ?? null) : null;
    let o: MetricValue;
    if (!opLine) o = none("deferred", `${OPINC_NOTE.deferred} — 본표 영업이익 소계 없음`);
    else if (opLine.v == null) o = none("face", "본표 영업이익 줄 값 없음");
    else o = { ...base, v: opLine.v, line: opLine.id, rule: "face", ...(opLine.why ? { why: opLine.why } : {}), ...(opLine.inputs ? { inputs: opLine.inputs } : {}) };

    const g = gp.values[key];
    let x: MetricValue;
    if (o.v == null) x = none(o.rule, o.reason ?? "영업이익 없음");
    else if (g?.v == null) x = none("none", `매출총이익 없음 — ${g?.reason ?? ""}`.replace(/ — $/, ""));
    else {
      const gIn: DerivedInput[] = g.line ? [{ ref: `c:${key}|${g.line}`, op: 1, role: "gp" }] : (g.inputs ?? []);
      x = { ...base, v: g.v - o.v, line: null, rule: "gp-opinc", inputs: [...gIn, { ref: `c:${key}|${opLine!.id}`, op: -1, role: "opinc" }] };
      // 본표 영업이익 식 = 매출총이익 − 영업비용 합계 한 줄이면 그 줄과 대조(표시 부모 기준)
      const oi = a.lines.indexOf(opLine!);
      const kids = a.lines.filter((l) => l.parent === oi);
      const pos = kids.filter((l) => l.w > 0), neg = kids.filter((l) => l.w < 0);
      if (pos.length === 1 && pos[0].role === "gross" && neg.length === 1 && neg[0].v != null) {
        const d = neg[0].v - x.v!;
        const tol = fxCol ? Math.abs(neg[0].v) * 1e-9 : 0.5;
        if (Math.abs(d) > tol) x = { ...x, note: `${OPINC_NOTE.opexMismatch}(${neg[0].id} ${neg[0].v} · 차 ${Math.round(d).toLocaleString("en-US")}달러)` };
      }
    }
    opinc[key] = o;
    opex[key] = x;
  }
  return { opinc: { metric: "opinc", unit: "USD", values: opinc }, opex: { metric: "opex", unit: "USD", values: opex } };
}
