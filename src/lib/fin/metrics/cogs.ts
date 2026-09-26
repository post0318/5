import type { AssembledIs, CompanyProfile, DerivedInput, MetricSeries, MetricValue, StmtLine } from "../types";
import { cogsRuleFor } from "./cogs-rules";

/**
 * 3층 — 매출원가(COGS)·매출총이익(GP) 지표(docs/metrics/cogs.md). 조립된 손익계산서 줄에서 꺼내기만 한다 — 어느 줄이 매출원가인지는
 * 2층(assemble/is.ts identifyCogs)이 본표 계산 구조로 붙인 역할(cogs·cogs.part)을 따른다. 기간·판본·환율은 1층 몫.
 *
 * | 유형 | 매출원가 | 매출총이익 |
 * | A·B 본표 매출총이익 소계 있음 | 매출총이익 식의 빼는 항(소계 그대로 — 인수 무형상각·구조조정 포함) | 본표 매출총이익 줄 |
 * | C 소계 없음 · 원가 줄 하나 | 그 줄(라벨로 판정) | 매출 − 매출원가 합성(주석 SYNTH_GP) |
 * | D 원가 줄 없음 | cogs-rules.ts 구성 규칙(대기면 빈칸 + "구성 규칙 대기") | 매출 − 구성 매출원가 |
 * 본표 매출총이익 ≠ 매출 − 매출원가(IBM 반올림·TSM 2018 이전 관계기업 미실현이익 줄)면 본표 값을 두고 "회사 공시 자체"로 적는다.
 */

/** 화면 주석 문구 — 소비처(손익계산서 등)가 이 문구로 줄 이름·각주를 단다(fin index.ts 가 내보냄) */
export const COGS_NOTE = {
  /** 매출총이익을 본표 소계 없이 매출 − 매출원가로 합성 */
  synth: "본표 소계 없음 · 매출 − 매출원가",
  /** 유형 D 구성 규칙이 아직 없음 */
  pending: "구성 규칙 대기",
  /** 본표 매출총이익이 매출 − 매출원가와 다름(본표 값 유지) */
  self: "회사 공시 자체",
  /** 원가 줄이 제외 항목을 둔 기준(UBER "exclusive of depreciation and amortization") */
  excl: "본표 원가 줄 — 제외 항목 있음",
  /** 카드·보험·은행 — 금융사 기준(매출원가·매출총이익 개념 없음) */
  fin: "금융사 — 해당 없음",
} as const;

/** 금융사 기준 회사 유형(오너 2026-09-26 — "카드 보험 은행은 금융사기준으로 정한다. 앱도 그렇게 구성하고 있다").
 *  판정은 profile.ts companyType(SIC 60~61 은행·카드 · 62 증권 · 63~64 보험). V 등 결제망(SIC 7389)은 일반 기업(오너 결정) */
export const FIN_TYPES = new Set(["bank", "broker", "insurer"]);

const EXCL_LABEL = /exclusive of|excluding/i;

export function cogsGp(cols: AssembledIs[], co: CompanyProfile, rev: MetricSeries): { cogs: MetricSeries; gp: MetricSeries } {
  const entry = cogsRuleFor(co.symbol);
  const cogs: Record<string, MetricValue> = {};
  const gp: Record<string, MetricValue> = {};
  const fxCol = co.reportingCurrency !== "USD";
  for (const a of cols) {
    const key = a.col.key;
    const base = { col: key, end: a.col.end, gaps: a.col.gaps };
    const cell = (l: StmtLine, op: 1 | -1, role?: string): DerivedInput => ({ ref: `c:${key}|${l.id}`, op, ...(role ? { role } : {}) });
    const none = (rule: string, reason: string): MetricValue => ({ ...base, v: null, line: null, rule, reason });
    const one = (l: StmtLine, rule: string, note?: string): MetricValue => ({
      ...base, v: l.v, line: l.id, rule, ...(l.why ? { why: l.why } : {}), ...(l.inputs ? { inputs: l.inputs } : {}), ...(note ? { note } : {}),
    });
    const sum = (ls: { l: StmtLine; op: 1 | -1 }[], rule: string, role: string, note?: string): MetricValue => ({
      ...base, v: ls.reduce((s, x) => s + x.op * x.l.v!, 0), line: null, rule, inputs: ls.map((x) => cell(x.l, x.op, role)), ...(note ? { note } : {}),
    });

    // ── 매출원가 ──
    let c: MetricValue;
    let composed: string | null = null;
    if (FIN_TYPES.has(co.type)) {
      cogs[key] = none("financial", `${COGS_NOTE.fin}(${co.type})`);
      gp[key] = none("financial", `${COGS_NOTE.fin}(${co.type})`);
      continue;
    }
    if (entry) {
      if (!entry.rule) c = none("rule-pending", `${COGS_NOTE.pending} — 본표에 매출원가 줄 없음(cogs.md §3 유형 D)`);
      else {
        const ls = entry.rule.terms.map((t) => ({ t, l: a.faceShape ? (t.concepts.map((c) => a.lines.find((l) => l.id === c && l.v != null)).find(Boolean) ?? null) : null }));
        const miss = ls.filter((x) => !x.l).map((x) => x.t.group ?? x.t.concepts.join("|"));
        composed = entry.rule.label;
        c = miss.length ? none("rule", `구성 항 값 없음(${miss.join(",")})`) : sum(ls.map((x) => ({ l: x.l!, op: x.t.sign })), "rule", "term", `구성: ${entry.rule.label}`);
      }
    } else {
      const single = a.lines.find((l) => l.role === "cogs") ?? null;
      const parts = a.lines.filter((l) => l.role === "cogs.part");
      const excl = (l: StmtLine) => (EXCL_LABEL.test(l.label) ? `${COGS_NOTE.excl}("${l.label}")` : undefined);
      if (single) c = single.v == null ? none(`face-${a.cogsBy}`, "본표 매출원가 줄 값 없음") : one(single, `face-${a.cogsBy}`, excl(single));
      else if (parts.length) {
        const miss = parts.filter((l) => l.v == null);
        c = miss.length ? none("face-parts", `매출총이익 식 원가 항 값 없음(${miss.map((l) => l.id).join(",")})`) : sum(parts.map((l) => ({ l, op: 1 as const })), "face-parts", "part");
      } else c = none("none", a.cogsWhy ?? "본표에 매출원가 줄 없음");
    }

    // ── 매출총이익 ──
    const r = rev.values[key];
    const grossLine = entry || !a.faceShape ? null : (a.lines.find((l) => l.role === "gross" && l.v != null) ?? null);
    let g: MetricValue;
    if (grossLine) {
      g = one(grossLine, "face");
      // 본표 매출총이익 ≠ 매출 − 매출원가 — 본표 값을 둔다(IBM ±1 반올림 · TSM 2018 이전 관계기업 미실현이익 조정 줄)
      if (r?.v != null && c.v != null) {
        const d = grossLine.v! - (r.v - c.v);
        const tol = fxCol ? Math.abs(grossLine.v!) * 1e-9 : 0.5;
        if (Math.abs(d) > tol) g = { ...g, note: `${COGS_NOTE.self} — 본표 매출총이익 ≠ 매출 − 매출원가(차 ${Math.round(d).toLocaleString("en-US")}달러)` };
      }
    } else if (c.v != null && r?.v != null) {
      // 합성 — 매출 지표(줄 하나면 그 칸, 여러 줄이면 매출 입력) − 매출원가(줄 하나면 그 칸, 합이면 그 입력)
      const revIn: DerivedInput[] = r.line && !r.rule.startsWith("override:total") && r.rule !== "nii+nonii" ? [{ ref: `c:${key}|${r.line}`, op: 1, role: "rev" }] : (r.inputs ?? []);
      const cIn: DerivedInput[] = c.line ? [{ ref: `c:${key}|${c.line}`, op: -1, role: "cogs" }] : (c.inputs ?? []).map((i) => ({ ...i, op: (-i.op) as 1 | -1 }));
      g = {
        ...base, v: r.v - c.v, line: null, rule: "gp-synth", inputs: [...revIn, ...cIn],
        note: composed ? `${COGS_NOTE.synth}(구성: ${composed})` : COGS_NOTE.synth,
      };
    } else if (c.v == null) g = none(c.rule === "rule-pending" ? "rule-pending" : "gp-none", c.reason ?? "매출원가 없음");
    else g = none("gp-none", "매출 없음 — 매출총이익 합성 불가");

    // ── 조립 항등식 — 매출원가·매출총이익 줄이 걸린 불성립(매출 경로와 같은 방식, revenue.md §6.1) ──
    const used = new Set<number>();
    for (const v of [c, g]) {
      if (v.v == null) continue;
      if (v.line) used.add(a.lines.findIndex((l) => l.id === v.line));
      for (const i of v.inputs ?? []) if (i.ref.startsWith(`c:${key}|`)) used.add(a.lines.findIndex((l) => l.id === i.ref.slice(key.length + 3)));
    }
    for (const l of a.lines) if (l.role === "revenue" || l.role?.startsWith("revenue.")) used.delete(a.lines.indexOf(l)); // 매출 줄의 불성립은 매출 지표가 다룬다
    used.delete(-1);
    const onPath = (k: number) => used.has(a.identity.at[k]) || a.identity.terms[k].some((t) => used.has(t));
    const full = a.identity.fails.filter((_, k) => onPath(k) && !a.identity.partial[k]);
    const partial = a.identity.fails.filter((_, k) => onPath(k) && a.identity.partial[k]);
    if (full.length) {
      const why = `조립 항등식 불성립(매출원가·매출총이익 줄 포함) — ${full.join("; ")}`;
      if (c.v != null) c = { ...c, v: null, inputs: undefined, rule: `identity-fail:${c.rule}`, reason: why, idFails: full };
      if (g.v != null) g = { ...g, v: null, inputs: undefined, rule: `identity-fail:${g.rule}`, reason: why, idFails: full };
    } else if (partial.length) {
      if (c.v != null) c = { ...c, unv: partial };
      if (g.v != null) g = { ...g, unv: partial };
    }
    cogs[key] = c;
    gp[key] = g;
  }
  return { cogs: { metric: "cogs", unit: "USD", values: cogs }, gp: { metric: "gp", unit: "USD", values: gp } };
}
