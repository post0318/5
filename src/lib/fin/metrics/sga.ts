import type { AssembledIs, CompanyProfile, DerivedInput, MetricSeries, MetricValue, StmtLine } from "../types";
import { FIN_TYPES } from "./cogs";
import { sgaRuleFor } from "./sga-rules";

/**
 * 3층 — 판관비(SG&A)·연구개발비(R&D) 지표(docs/metrics/sga.md). 조립된 본표 줄에서 꺼내기만 한다 — 어느 줄이 판관비·연구개발비인지는
 * 2층(assemble/is.ts identifySgaRnd)이 본표 계산 구조(영업이익 식, 없으면 세전이익 식)로 정한 줄(opx)을 따른다. 기간·판본·환율은 1층 몫.
 *
 * 오너 결정(2026-09-28):
 *  - 판관비 = 본표 판관비 성격 줄 전부의 합(여러 줄이면 합 + 화면 하위 줄), 본표에 판관비 소계가 있으면 그 소계.
 *  - 본표 이름이 판관비가 아닌 줄(HLT·MAR·SBUX 일반관리비, MCD "Other")도 판관비 — 원래 이름을 주석으로(화면 행 이름에 병기).
 *  - AMZN "Technology and infrastructure" = 연구개발비(원래 이름 병기).
 *  - 금융사(FIN_TYPES)·DAL(sga-rules.ts excludeSga) = 빈칸 + 사유.
 *  - 줄이 없으면 빈칸 + 사유 SGA_NOTE.noLine(소비처 "기타 영업비용" 계산에서는 0 으로 본다 — 본표에 그 비용 줄이 없음).
 */

export const SGA_NOTE = {
  /** 본표 영업이익 식에 그 성격 줄이 없음 — 소비처는 기타 영업비용 계산에서 0 으로 본다(이 문구로 시작) */
  noLine: "본표에 줄 없음",
  /** 파생 열(Q4·누적 차·LTM) 구성 공시 간 줄 구성 다름 */
  mix: "구성 공시 간 줄 구성 다름 — 기준 혼합",
  /** 본표 줄 이름이 표준 이름과 다름 — 원래 이름(화면 행 이름 병기) */
  face: "본표 줄 이름",
  /** 여러 줄 합 */
  sum: "본표 줄 합",
  fin: "금융사 — 해당 없음",
} as const;

/** 표준 이름 — 이 라벨이면 원래 이름을 병기하지 않는다 */
const SGA_STD_LABEL = /^(total )?(selling|sales),? general,? (and|&) administrative( expenses?| costs?)?( \(sg&a\)( costs?)?)?$/i;
const RND_STD_LABEL = /^(total )?research and development( expenses?| costs?)?( \(r&d\)( costs?)?)?$/i;

export function sgaRnd(cols: AssembledIs[], co: CompanyProfile): { sga: MetricSeries; rnd: MetricSeries } {
  const rule = sgaRuleFor(co.symbol);
  const sga: Record<string, MetricValue> = {};
  const rnd: Record<string, MetricValue> = {};
  for (const a of cols) {
    const key = a.col.key;
    const base = { col: key, end: a.col.end, gaps: a.col.gaps };
    const none = (r: string, reason: string): MetricValue => ({ ...base, v: null, line: null, rule: r, reason });
    if (FIN_TYPES.has(co.type)) {
      sga[key] = none("financial", `${SGA_NOTE.fin}(${co.type})`);
      rnd[key] = none("financial", `${SGA_NOTE.fin}(${co.type})`);
      continue;
    }
    const x = a.opx;
    const pick = (kind: "sga" | "rnd"): MetricValue => {
      const nm = kind === "sga" ? "판관비" : "연구개발비";
      if (kind === "sga" && rule?.excludeSga) return none("excluded", rule.excludeSga);
      if (!a.faceShape || !x) return none("none", "본표 구조 판독 실패(Gap.LINKBASE)");
      if (!x.root) return none("none", x.why ?? "본표에 영업이익·세전이익 줄 없음");
      const mix = x.mix?.[kind];
      if (mix) return none("mix", `${SGA_NOTE.mix}(${mix})`);
      // 파생 열 — 구성 공시끼리 줄 개념만 다르고 합이 같음(2층 identifySgaRnd): 구성 공시마다 그 공시 자체 줄의 합으로 만든 값
      const cell = x.cell?.[kind];
      if (cell) {
        if (cell.v == null) return none("face-renamed", `${cell.note} — 구성 공시 줄 값 없음`);
        return { ...base, v: cell.v, line: null, rule: "face-renamed", ...(cell.inputs ? { inputs: cell.inputs } : {}), note: cell.note };
      }
      const ls = x[kind];
      if (!ls.length) return none("none", `${SGA_NOTE.noLine} — 본표 ${x.root.endsWith("OperatingIncomeLoss") || x.root.endsWith("ProfitLossFromOperatingActivities") ? "영업이익" : "세전이익"} 식에 ${nm} 성격 줄 없음`);
      const lines = ls.map((p) => ({ p, l: a.lines.find((l) => l.id === p.id)! }));
      const miss = lines.filter(({ l }) => l?.v == null);
      if (miss.length) return none("face", `본표 ${nm} 줄 값 없음(${miss.map(({ p }) => p.id).join(",")}) — 구성 공시에 그 줄이 없거나 값 없음`);
      const std = kind === "sga" ? SGA_STD_LABEL : RND_STD_LABEL;
      if (lines.length === 1) {
        const { p, l } = lines[0];
        const note = std.test(l.label.trim()) ? undefined : `${SGA_NOTE.face}: "${l.label}"`;
        if (p.sign === 1)
          return { ...base, v: l.v, line: l.id, rule: "face", ...(l.why ? { why: l.why } : {}), ...(l.inputs ? { inputs: l.inputs } : {}), ...(note ? { note } : {}) };
        return { ...base, v: -l.v!, line: null, rule: "face", inputs: [{ ref: `c:${key}|${l.id}`, op: -1, role: kind }], ...(note ? { note } : {}) };
      }
      const inputs: DerivedInput[] = lines.map(({ p, l }) => ({ ref: `c:${key}|${l.id}`, op: p.sign, role: `${kind}.part` }));
      return {
        ...base, v: lines.reduce((s, { p, l }) => s + p.sign * l.v!, 0), line: null, rule: "face-parts", inputs,
        note: `${SGA_NOTE.sum}: ${lines.map(({ l }) => `"${l.label}"`).join(" + ")}`,
      };
    };
    let s = pick("sga");
    let r = pick("rnd");
    // 조립 항등식 — 판관비·연구개발비 줄이 걸린 불성립(매출원가 경로와 같은 방식, cogs.ts). 완전 판정 불성립이면 비우고, 판정 불완전이면 값 + unv
    const guard = (v: MetricValue, kind: "sga" | "rnd"): MetricValue => {
      if (v.v == null) return v;
      const used = new Set<number>();
      for (const p of x?.[kind] ?? []) used.add(a.lines.findIndex((l: StmtLine) => l.id === p.id));
      used.delete(-1);
      const onPath = (k: number) => used.has(a.identity.at[k]) || a.identity.terms[k].some((t) => used.has(t));
      const full = a.identity.fails.filter((_, k) => onPath(k) && !a.identity.partial[k]);
      const partial = a.identity.fails.filter((_, k) => onPath(k) && a.identity.partial[k]);
      if (full.length) return { ...v, v: null, inputs: undefined, note: undefined, rule: `identity-fail:${v.rule}`, reason: `조립 항등식 불성립(${kind === "sga" ? "판관비" : "연구개발비"} 줄 포함) — ${full.join("; ")}`, idFails: full };
      if (partial.length) return { ...v, unv: partial };
      return v;
    };
    s = guard(s, "sga");
    r = guard(r, "rnd");
    sga[key] = s;
    rnd[key] = r;
  }
  return { sga: { metric: "sga", unit: "USD", values: sga }, rnd: { metric: "rnd", unit: "USD", values: rnd } };
}
