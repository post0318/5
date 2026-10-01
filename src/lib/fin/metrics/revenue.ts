import type { AssembledIs, CompanyProfile, DerivedInput, MetricSeries, MetricValue, StmtLine } from "../types";
import { overrideFor } from "./overrides";

/**
 * 3층 — 매출 지표(docs/metrics/revenue.md §1). **조립된 손익계산서 줄에서 꺼내기만 한다** — 태그를 다시 고르거나 기간·
 * 판본·환율을 다루지 않는다(1층 몫). 회사 유형은 프로필(1층 read/profile.ts)만 본다.
 *
 * | 유형 | 규칙 |
 * | 일반·보험·금융자회사·리츠 | 총매출(revenue.total) → 고객계약 매출(revenue) → 순수익(revenue.net) |
 * | 은행·카드사 | 순수익(revenue.net) → 총수익(revenue.total) → 순이자이익 + 비이자이익 |
 * | 증권사 | 순수익(revenue.net) → 은행 순서 |
 * | 예외(overrides.ts) revenue-excl-nonop | 총수익 − 비영업 수익(지분법·기타수익) = 영업 매출 |
 * 보험사·금융 자회사 보유 기업은 현행 총수익 유지 — 오너 결정 보류(revenue.md §9).
 */

const NII = "us-gaap:InterestIncomeExpenseNet";
const NONII = "us-gaap:NoninterestIncome";

export function revenue(cols: AssembledIs[], co: CompanyProfile): MetricSeries {
  const ov = overrideFor(co.symbol, "revenue");
  const values: Record<string, MetricValue> = {};
  for (const a of cols) {
    const role = (r: StmtLine["role"]) => a.lines.find((l) => l.role === r && l.v != null) ?? null;
    const byId = (id: string) => a.lines.find((l) => l.id === id && l.v != null) ?? null;
    // 입력: 줄 하나 그대로면 그 줄의 파생 입력(있으면)을 그대로, 여러 줄을 합치면 같은 열 칸 참조(c:) — 칸이 파생이면 재귀 전개
    const cell = (l: StmtLine, op: 1 | -1, role?: string): DerivedInput => ({ ref: `c:${a.col.key}|${l.id}`, op, ...(role ? { role } : {}) });
    const mv = (l: StmtLine | null, rule: string, v?: number | null, inputs?: DerivedInput[]): MetricValue => {
      const ins = v === null ? undefined : v !== undefined ? inputs : l?.inputs;
      return {
        v: v !== undefined ? v : (l?.v ?? null), col: a.col.key, end: a.col.end, line: l?.id ?? null, rule, gaps: a.col.gaps,
        ...(l?.why ? { why: l.why } : {}), ...(ins ? { inputs: ins } : {}),
      };
    };
    let out: MetricValue;
    const bankOrder = (): MetricValue => {
      const net = role("revenue.net");
      if (net) return mv(net, "net");
      const tot = role("revenue.total");
      if (tot) return mv(tot, "total");
      const nii = byId(NII), non = byId(NONII);
      if (nii && non) return mv(nii, "nii+nonii", nii.v! + non.v!, [cell(nii, 1, "nii"), cell(non, 1, "nonii")]);
      return mv(role("revenue"), "contract");
    };
    if (co.type === "bank" || co.type === "broker") out = bankOrder();
    else if (ov?.rule === "revenue-excl-nonop") {
      const op = role("revenue");
      const tot = role("revenue.total");
      const nonopLines = a.lines.filter((l) => l.role === "revenue.nonop");
      const nonop = nonopLines.filter((l) => l.v != null);
      if (op) out = mv(op, "override:operating-line");
      else if (tot && nonop.length && nonop.length === nonopLines.length)
        out = mv(tot, "override:total-nonop", tot.v! - nonop.reduce((s, l) => s + l.v!, 0), [cell(tot, 1, "total"), ...nonop.map((l) => cell(l, -1, "nonop"))]);
      // 비영업 줄 자체가 없는 열(분리 구조를 찾지 못한 공시) — 총수익과 정의가 다르므로 대체하지 않고 비운다
      else out = mv(tot, nonopLines.length ? "override:비영업 값 없음" : "override:분리 구조 없음", null);
    } else {
      const tot = role("revenue.total");
      const rfc = role("revenue");
      const net = role("revenue.net");
      out = tot ? mv(tot, "total") : rfc ? mv(rfc, "contract") : net ? mv(net, "net") : mv(null, "none", null);
    }
    // 조립 항등식 불성립이 매출 줄에 걸리면(매출 줄이 그 식의 부모이거나 항 — 예: 매출총이익 = 매출 − 매출원가) 그 열의
    // 매출을 비운다(revenue.md §6). 매출과 무관한 줄의 불성립은 값을 두고 index.ts 가 경고·gaps 로 노출한다.
    const used = new Set<number>();
    const idx = (l: StmtLine | null) => (l ? a.lines.indexOf(l) : -1);
    if (out.v != null) {
      used.add(idx(a.lines.find((l) => l.id === out.line) ?? null));
      if (out.rule === "nii+nonii") used.add(idx(byId(NONII)));
      if (out.rule === "override:total-nonop") for (const l of a.lines) if (l.role === "revenue.nonop") used.add(a.lines.indexOf(l));
      used.delete(-1);
    }
    // 매출 경로 = 매출 줄이 그 식의 부모이거나 항(합계식 전체 — 표시 부모 아님)
    const onPath = (k: number) => used.has(a.identity.at[k]) || a.identity.terms[k].some((t) => used.has(t));
    const revFails = a.identity.fails.filter((_, k) => onPath(k) && !a.identity.partial[k]);
    // 판정 불완전 식(is.ts ①~⑤)은 값 섞임의 증거가 아니라 매출을 비우지 않는다 — 대신 "항등식 미검증"으로 표시하고 검증기가
    // 그 열을 SEC 본표 매출과 직접 대조한다(재감사 2026-09-25: 판정 불완전 예외가 틀린 매출을 숨길 수 있었음 — WDC 주입 재현)
    const revUnv = a.identity.fails.filter((_, k) => onPath(k) && a.identity.partial[k]);
    // 매출 줄이 어느 식에도 속하지 않으면(계산 구조 없음·매출 줄이 식 밖 — WDC 2020 10-K) 항등식이 매출에 닿지 않는다 — 같은 "미검증"
    const unc = [...used].filter((u) => a.identity.uncovered.includes(u)).map((u) => a.lines[u].id);
    if (unc.length && !revFails.length) revUnv.push(`${unc.join(",")}: 계산 구조 식 밖(항등식 검사 없음)`);
    if (revFails.length) out = { ...out, v: null, inputs: undefined, rule: `identity-fail:${out.rule}`, reason: `조립 항등식 불성립(매출 줄 포함) — ${revFails.join("; ")}`, idFails: revFails };
    else if (revUnv.length && out.v != null) out = { ...out, reason: `항등식 미검증 — ${revUnv.join("; ")}`, unv: revUnv };
    values[a.col.key] = out;
  }
  return { metric: "revenue", unit: "USD", values };
}
