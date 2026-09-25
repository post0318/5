import type { AssembledIs, CompanyProfile, MetricSeries, MetricValue, StmtLine } from "../types";
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
    const mv = (l: StmtLine | null, rule: string, v?: number | null): MetricValue => ({
      v: v !== undefined ? v : (l?.v ?? null), col: a.col.key, end: a.col.end, line: l?.id ?? null, rule, gaps: a.col.gaps,
      ...(l?.why ? { why: l.why } : {}),
    });
    let out: MetricValue;
    const bankOrder = (): MetricValue => {
      const net = role("revenue.net");
      if (net) return mv(net, "net");
      const tot = role("revenue.total");
      if (tot) return mv(tot, "total");
      const nii = byId(NII), non = byId(NONII);
      if (nii && non) return mv(nii, "nii+nonii", nii.v! + non.v!);
      return mv(role("revenue"), "contract");
    };
    if (co.type === "bank" || co.type === "broker") out = bankOrder();
    else if (ov?.rule === "revenue-excl-nonop") {
      const op = role("revenue");
      const tot = role("revenue.total");
      const nonopLines = a.lines.filter((l) => l.role === "revenue.nonop");
      const nonop = nonopLines.filter((l) => l.v != null);
      if (op) out = mv(op, "override:operating-line");
      else if (tot && nonop.length && nonop.length === nonopLines.length) out = mv(tot, "override:total-nonop", tot.v! - nonop.reduce((s, l) => s + l.v!, 0));
      // 비영업 줄 자체가 없는 열(분리 구조를 찾지 못한 공시) — 총수익과 정의가 다르므로 대체하지 않고 비운다
      else out = mv(tot, nonopLines.length ? "override:비영업 값 없음" : "override:분리 구조 없음", null);
    } else {
      const tot = role("revenue.total");
      const rfc = role("revenue");
      const net = role("revenue.net");
      out = tot ? mv(tot, "total") : rfc ? mv(rfc, "contract") : net ? mv(net, "net") : mv(null, "none", null);
    }
    values[a.col.key] = out;
  }
  return { metric: "revenue", unit: "USD", values };
}
