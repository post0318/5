/**
 * 한국 사업보고서 XBRL(fnlttXbrl.xml zip) → RawFact 전부(주석 태그·차원·decimals 포함 — 손실 없는 기록, 설계 §2.1 원칙).
 * 리스부채 주석(B16·079550 단위 오류)·이자(R-KR6)·감가상각(R-KR11) 판독의 재료. 연결/별도 = ConsolidatedAndSeparateFinancialStatementsAxis 멤버.
 * 2021 이전 보고서 XBRL 은 본표만 태깅 — 주석 사실이 없는 것은 그대로 드러난다(빈칸 사유는 Item 단계).
 */
import { unzipEntries } from "../common/format.mjs";
import { parseFacts } from "../common/xbrl.mjs";
import { fyKey, markPrecisionDuplicates, monthsBetween, normNum, rawFact } from "../common/rawfact.mjs";

export function krXbrlFacts(zipBuf, { sym, corp, rcept, code = "11011" }) {
  const inst = unzipEntries(zipBuf).find((e) => /\.xbrl$/.test(e.name));
  if (!inst) return { facts: [], missing: ["instance"] };
  const { facts } = parseFacts(inst.data.toString("utf8"));
  const out = [];
  for (const f of facts) {
    if (!f.ctx || f.raw == null) continue;
    const c = f.ctx;
    const isDur = !!c.start;
    const end = isDur ? c.end : c.instant;
    const csAxis = c.dims.find((d) => /ConsolidatedAndSeparateFinancialStatementsAxis/.test(d.axis));
    const consolidation = !csAxis ? "unspecified" : /SeparateMember$/.test(csAxis.member) ? "separate" : "consolidated";
    const dims = c.dims.filter((d) => d !== csAxis).map((d) => ({ axis: d.axis, member: d.member, typed: d.typed }));
    out.push(rawFact({
      market: "kr",
      entity: { sym, corp },
      filing: { id: rcept, form: code, filed_at: null, period_end: null, amends: null },
      concept: { id: f.concept, label: null, standard: /^(ifrs-full|dart|ifrs)$/.test(f.concept.split(":")[0]) },
      placement: { face: null },
      period: { kind: isDur ? "duration" : "instant", start: c.start, end, months: isDur ? monthsBetween(c.start, end) : null, fy_key: fyKey("kr", end), fp: code, column: f.contextRef },
      scope: { consolidation, attribution: /OwnersOfParent/.test(f.concept) ? "parent" : /NoncontrollingInterests/.test(f.concept) ? "nci" : "none", ops: /Discontinued/.test(f.concept) ? "discontinued" : /Continuing/.test(f.concept) ? "continuing" : "none", dims },
      value: { raw: f.raw, num: f.nil ? null : normNum(f.raw), unit: f.unit, decimals: f.decimals, sign: null, nil: f.nil },
      locator: { source: "dart-xbrl", rcept, file: inst.name, contextRef: f.contextRef, element: f.concept, id: f.id },
      fetch: null,
    }));
  }
  markPrecisionDuplicates(out);
  return { facts: out };
}
