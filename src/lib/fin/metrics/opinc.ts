import type { AssembledIs, CompanyProfile, DerivedInput, MetricSeries, MetricValue, StmtLine } from "../types";
import { cogsRuleFor } from "./cogs-rules";
import { FIN_TYPES } from "./cogs";

/**
 * 3층 — 영업이익·영업비용 지표(docs/metrics/cogs.md §8). 조립된 본표 줄에서 꺼내기만 한다(기간·판본·환율은 1층, 줄 구조는 2층).
 *  - 영업이익 = 본표 영업이익 소계 줄(OperatingIncomeLoss · IFRS ProfitLossFromOperatingActivities) 값 그대로.
 *  - **본표에 영업이익 소계가 없는 열(IBM·XOM 등) = 공시 계산 구조로 합성**(오너 결정 2026-09-24 — CLAUDE.md "영업이익 소계가 없는
 *    손익계산서 = 공시 계산 구조", 소비처 전환 2026-09-27): 세전이익 − 세전이익 계산식 하위 트리의 영업외 항목(이자·지분법·영업외손익·
 *    투자손익·환손익·채무소멸손익 — 정확한 개념명 목록, 회사 고유 말단 줄은 라벨이 정확히 "기타수익·비용" 형태일 때만) − 총수익 안의
 *    비영업 수익 줄(revenue.nonop — XOM 지분법·기타수익). 매출 노드 아래로는 내려가지 않는다. 옛 화면 모듈(markets/us/edgar-is-structure.ts)
 *    과 같은 규칙을 2층 조립 결과(본표 줄·계산 부모·가중치)로 계산한다 — 공시 원본을 다시 읽지 않는다. 값에 주석 OPINC_NOTE.synth.
 *    적용 범위: 일반·금융 자회사 보유(captive) 회사의 us-gaap 본표. 리츠·IFRS 본표·영업외 항목을 하나도 못 찾은 열·세전이익 계산식이
 *    불성립인 열은 빈칸 + 사유(세전이익 그대로·세전 + 이자 근사로 대신하지 않는다 — 그림자 채우기 금지).
 *  - 영업비용 = 매출총이익(fin gp) − 영업이익. 본표 영업이익 식이 "매출총이익 − 영업비용 합계 한 줄"이면 그 줄과 정확 일치를 확인하고,
 *    다르면 값을 두고 주석·경고(이슈)로 낸다.
 *  - 유형 D(cogs-rules.ts 구성 규칙이 있는 종목, 리드 2026-09-27): 영업이익 = 본표 소계(없으면 위 합성), 영업비용 = 구성 매출총이익 − 영업이익.
 *    규칙 대기(rule null) 종목은 정의 대기.
 *  - CAT(금융 자회사 보유)은 본표 영업이익 소계 그대로(오너 원칙 "CAT 매출원가는 본표값"과 같게, 2026-09-27).
 *  - 금융사(은행·증권·보험)는 범위 밖 — 빈칸 + "정의 대기"(화면은 기존 금융사 경로 그대로, markets/us/edgar-ev.ts opIncomeViaFin).
 */

export const OPINC_NOTE = {
  /** 범위 밖 — 정의 전 */
  deferred: "정의 대기",
  /** 본표 영업비용 합계 줄 ≠ 매출총이익 − 영업이익 */
  opexMismatch: "본표 영업비용 합계 ≠ 매출총이익 − 영업이익",
  /** 본표 영업이익 소계 없음 — 공시 계산 구조로 합성(세전이익 − 영업외 항목) */
  synth: "소계 없음 · 세전이익 − 영업외 항목(공시 계산 구조)",
} as const;

/**
 * 영업외 항목 — **정확한 개념명 목록**(us-gaap). markets/us/edgar-is-structure.ts NONOP 과 같은 목록. 부분일치는 은행·증권 순수익·
 * 순이자이익·보험 투자수익까지 잡아 영업이익이 음수·절반이 됐다(독립 감사 2026-09-24).
 */
const NONOP = new Set([
  "InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt", "InterestAndDebtExpense",
  "InterestIncomeExpenseNonoperatingNet", "InvestmentIncomeInterest", "InvestmentIncomeInterestAndDividend",
  "InvestmentIncomeNonoperating", "InterestAndOtherIncome",
  "NonoperatingIncomeExpense", "OtherNonoperatingIncomeExpense", "OtherNonoperatingIncome", "OtherNonoperatingExpense",
  "IncomeLossFromEquityMethodInvestments", "IncomeLossFromEquityMethodInvestmentsNetOfDividendsOrDistributions",
  "GainLossOnInvestments", "GainLossOnSaleOfInvestments", "ForeignCurrencyTransactionGainLossBeforeTax",
  "GainsLossesOnExtinguishmentOfDebt",
]);
/**
 * 회사 고유 말단 줄 중 영업외로 인정하는 라벨 — 정확히 "기타수익·비용" 형태(IBM "Other (income) and expense" — 연금 비영업 비용·
 * 환손익·매각손익). edgar-is-structure.ts EXT_NONOP_LABEL 과 같음.
 */
const EXT_NONOP_LABEL = /^\s*other\s*\(?\s*(income|expense)s?\s*\)?\s*(and|&|,)?\s*\(?\s*(income|expense)s?\s*\)?\s*(,\s*net)?\s*$/i;
/** 합성 적용 회사 유형 — 리츠(이자가 조달비용 — 옛 화면도 구조 합성 제외)·금융사 제외 */
const SYNTH_TYPES = new Set(["general", "captive"]);
/** 금융 자회사 보유사 중 계산 구조 합성을 허용하는 회사 — 본표 "Interest expense" 줄이 본사 이자만(금융 부문 이자는 원가 안)임을 확인. IBM(2026-09-27) */
const CAPTIVE_SYNTH_OK = new Set(["IBM"]);

const nsOf = (id: string) => id.slice(0, id.indexOf(":"));
const localOf = (id: string) => id.slice(id.indexOf(":") + 1);

/**
 * 본표 영업이익 소계가 없는 열 — 세전이익 − 영업외 항목(공시 계산 구조). 값 또는 빈칸 사유.
 * 걸음: 세전이익 줄에서 계산 자식으로 내려가며(가중치 곱) 영업외 항목이면 모으고 멈춘다. 매출 역할 줄(revenue·revenue.total 등)은
 * 내려가지 않고, 총수익(revenue.total)이면 그 자식 중 비영업 수익(revenue.nonop)을 모은다.
 */
function synthOpinc(a: AssembledIs, splitCo: boolean): { v: number; inputs: DerivedInput[]; unv: string[] } | { reason: string } {
  const key = a.col.key;
  const L = a.lines;
  const pi = L.findIndex((l) => l.role === "pretax");
  if (pi < 0) return { reason: "본표에 세전이익 줄 없음" };
  const pre = L[pi];
  if (nsOf(pre.id) !== "us-gaap") return { reason: `세전이익 줄이 us-gaap 개념 아님(${pre.id}) — 영업외 항목 목록 적용 불가` };
  if (pre.v == null) return { reason: "본표 세전이익 줄 값 없음" };
  const kidsOf = (i: number) => L.map((l, j) => ({ l, j })).filter(({ l }) => l.parent === i);
  if (kidsOf(pi).length < 2) return { reason: "세전이익 계산식 없음(계산 구조에 하위 줄 없음)" };
  const picked: { l: StmtLine; w: number }[] = [];
  const visited = new Set<number>([pi]);
  const missing: string[] = [];
  const walk = (i: number, w: number, depth: number) => {
    if (depth > 6) return;
    for (const { l, j } of kidsOf(i)) {
      const ww = w * l.w;
      const leaf = !L.some((x) => x.parent === j);
      const ns = nsOf(l.id);
      if ((ns === "us-gaap" && NONOP.has(localOf(l.id))) || (ns !== "us-gaap" && ns !== "syn" && leaf && EXT_NONOP_LABEL.test(l.label))) {
        picked.push({ l, w: ww });
        continue;
      }
      if (l.role === "revenue.total") {
        visited.add(j);
        for (const k of kidsOf(j))
          if (k.l.role === "revenue.nonop") {
            if (k.l.v == null) {
              if (splitCo) missing.push(k.l.id);
              continue;
            }
            picked.push({ l: k.l, w: ww * k.l.w });
          }
        continue;
      }
      if (l.role?.startsWith("revenue")) continue;
      visited.add(j);
      walk(j, ww, depth + 1);
    }
  };
  walk(pi, 1, 0);
  if (missing.length) return { reason: `총수익 안의 비영업 수익 값 없음(${missing.join(",")}) — 영업외 항목 분리 불가` };
  if (!picked.length) return { reason: "세전이익 계산식에서 영업외 항목을 찾지 못함" };
  // 걸은 계산식(세전이익·내려간 소계)이 불성립이면 비운다 — 판정 불완전(partial)이면 값은 두고 "항등식 미검증"
  const full: string[] = [];
  const unv: string[] = [];
  a.identity.fails.forEach((f, k) => {
    if (visited.has(a.identity.at[k])) (a.identity.partial[k] ? unv : full).push(f);
  });
  if (full.length) return { reason: `조립 항등식 불성립(세전이익 계산식) — ${full.join("; ")}` };
  // 값 없는 영업외 줄 = 그 기간 본표에 금액 없음(본표 "—", 항등식도 0 으로 성립) — 입력에서 뺀다
  const used = picked.filter((p) => p.l.v != null);
  const v = pre.v - used.reduce((s, p) => s + p.w * p.l.v!, 0);
  const inputs: DerivedInput[] = [
    { ref: `c:${key}|${pre.id}`, op: 1, role: "pretax" },
    ...used.map((p): DerivedInput => ({ ref: `c:${key}|${p.l.id}`, op: p.w > 0 ? -1 : 1, role: "nonop" })),
  ];
  return { v, inputs, unv };
}

export function opincOpex(cols: AssembledIs[], co: CompanyProfile, gp: MetricSeries): { opinc: MetricSeries; opex: MetricSeries } {
  const sym = co.symbol.toUpperCase();
  const deferred = (FIN_TYPES.has(co.type) ? `금융사 기준(${co.type}) — 기존 금융사 화면 구성 유지` : null) ?? (cogsRuleFor(sym)?.rule === null ? "본표에 매출원가 줄 없음(유형 D) · 구성 규칙 대기 — 영업이익·영업비용 정의 2단계" : null);
  // 총수익을 비영업 수익으로 나눈 회사(XOM) — 어느 열이든 revenue.nonop 값이 있으면. 그 회사에서 값 없는 열은 분리 불가(빈칸)
  const splitCo = cols.some((a) => a.lines.some((l) => l.role === "revenue.nonop" && l.v != null));
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
    if (!a.faceShape) o = none("deferred", `${OPINC_NOTE.deferred} — 본표 구조 판독 실패(Gap.LINKBASE)`);
    else if (!opLine) {
      if (!SYNTH_TYPES.has(co.type)) o = none("deferred", `${OPINC_NOTE.deferred} — 본표 영업이익 소계 없음(${co.type} — 계산 구조 합성 대상 아님)`);
      // 금융 자회사 보유사(captive)는 연결 이자비용에 금융 부문 조달비용이 섞여, 영업외로 빼면 영업이익이 부푼다(DE 2024 90억 → 125억) —
      // 빈칸 + 사유(오너 결정 2026-09-27). 예외: 이자비용 줄이 본사 이자만인 것을 확인한 회사(CAPTIVE_SYNTH_OK)
      else if (co.type === "captive" && !CAPTIVE_SYNTH_OK.has(sym)) o = none("deferred", `${OPINC_NOTE.deferred} — 본표 영업이익 소계 없음 · 금융 자회사 이자비용 구분 불가`);
      else {
        const s = synthOpinc(a, splitCo);
        o = "reason" in s
          ? none("synth-none", `${OPINC_NOTE.deferred} — 본표 영업이익 소계 없음 · ${s.reason}`)
          : { ...base, v: s.v, line: null, rule: "synth-structure", inputs: s.inputs, note: s.unv.length ? `${OPINC_NOTE.synth} · 항등식 미검증(${s.unv.join("; ")})` : OPINC_NOTE.synth, ...(s.unv.length ? { unv: s.unv } : {}) };
      }
    } else if (opLine.v == null) o = none("face", "본표 영업이익 줄 값 없음");
    else o = { ...base, v: opLine.v, line: opLine.id, rule: "face", ...(opLine.why ? { why: opLine.why } : {}), ...(opLine.inputs ? { inputs: opLine.inputs } : {}) };

    const g = gp.values[key];
    let x: MetricValue;
    if (o.v == null) x = none(o.rule, o.reason ?? "영업이익 없음");
    else if (g?.v == null) x = none("none", `매출총이익 없음 — ${g?.reason ?? ""}`.replace(/ — $/, ""));
    else {
      const gIn: DerivedInput[] = g.line ? [{ ref: `c:${key}|${g.line}`, op: 1, role: "gp" }] : (g.inputs ?? []);
      const oIn: DerivedInput[] = o.line ? [{ ref: `c:${key}|${o.line}`, op: -1, role: "opinc" }] : (o.inputs ?? []).map((i): DerivedInput => ({ ...i, op: i.op === 1 ? -1 : 1 }));
      x = { ...base, v: g.v - o.v, line: null, rule: "gp-opinc", inputs: [...gIn, ...oIn] };
      // 본표 영업이익 식 = 매출총이익 − 영업비용 합계 한 줄이면 그 줄과 대조(표시 부모 기준)
      if (opLine) {
        const oi = a.lines.indexOf(opLine);
        const kids = a.lines.filter((l) => l.parent === oi);
        const pos = kids.filter((l) => l.w > 0);
        const neg = kids.filter((l) => l.w < 0);
        if (pos.length === 1 && pos[0].role === "gross" && neg.length === 1 && neg[0].v != null) {
          const d = neg[0].v - x.v!;
          const tol = fxCol ? Math.abs(neg[0].v) * 1e-9 : 0.5;
          if (Math.abs(d) > tol) x = { ...x, note: `${OPINC_NOTE.opexMismatch}(${neg[0].id} ${neg[0].v} · 차 ${Math.round(d).toLocaleString("en-US")}달러)` };
        }
      }
    }
    opinc[key] = o;
    opex[key] = x;
  }
  return { opinc: { metric: "opinc", unit: "USD", values: opinc }, opex: { metric: "opex", unit: "USD", values: opex } };
}
