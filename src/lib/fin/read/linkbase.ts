import type { LinkArc, LinkRole } from "../types";

/**
 * 1층 — XBRL 링크베이스 판독(architecture.md §1). `markets/us/edgar-is-structure.ts` 의 `_cal` 판독(역할·loc·arc 정규식)을
 * 옮겨 표시 구조(_pre)·라벨(_lab)까지 같은 방식으로 읽는다. .xsd 에 내장된 링크베이스도 같은 요소 이름이라 그대로 읽힌다.
 *
 * 개념 id 는 "ns:Name"(href 조각 "ns_Name" 의 첫 "_" 를 ":" 로) — 인스턴스·companyfacts 와 같은 형식.
 */

const hrefId = (href: string): string | null => {
  const frag = /#([^"#]+)$/.exec(href)?.[1];
  if (!frag) return null;
  const i = frag.indexOf("_");
  return i < 0 ? frag : `${frag.slice(0, i)}:${frag.slice(i + 1)}`;
};

function parseLinks(text: string, link: "presentationLink" | "calculationLink", arc: "presentationArc" | "calculationArc"): LinkRole[] {
  const out: LinkRole[] = [];
  // 빈 링크(자기 닫힘 `<link:calculationLink xlink:role="…/CoverPage" … />` — Workiva 공시)는 먼저 지운다. 남겨 두면 아래 정규식이
  // 그 빈 요소부터 다음 링크의 닫는 태그까지를 한 링크로 읽어 **다음 역할의 호를 빈 역할 이름으로** 가져간다(재감사 2026-09-25 —
  // WDC 2020 10-K 는 손익계산서 계산 구조가 CoverPage 역할로 읽혀 손익 역할이 비었고, 2019 전후 다수 10-K 에서 같은 증상)
  text = text.replace(new RegExp(`<(?:link:)?${link}\\b[^>]*\\/>`, "g"), "");
  const re = new RegExp(`<(?:link:)?${link}\\b[^>]*xlink:role="([^"]+)"[^>]*>([\\s\\S]*?)<\\/(?:link:)?${link}>`, "g");
  for (const m of text.matchAll(re)) {
    const loc = new Map<string, string>();
    for (const l of m[2].matchAll(/<(?:link:)?loc\b([^>]*)\/?>/g)) {
      const label = /xlink:label="([^"]+)"/.exec(l[1])?.[1];
      const href = /xlink:href="([^"]+)"/.exec(l[1])?.[1];
      const id = href ? hrefId(href) : null;
      if (label && id) loc.set(label, id);
    }
    const arcs: LinkArc[] = [];
    const are = new RegExp(`<(?:link:)?${arc}\\b([^>]*)\\/?>`, "g");
    for (const a of m[2].matchAll(are)) {
      const from = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? "");
      const to = loc.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
      if (!from || !to) continue;
      const order = Number(/\border="([^"]+)"/.exec(a[1])?.[1] ?? 0);
      const weight = Number(/\bweight="([^"]+)"/.exec(a[1])?.[1] ?? 0);
      const preferredLabel = /preferredLabel="([^"]+)"/.exec(a[1])?.[1];
      arcs.push({ from, to, order: Number.isFinite(order) ? order : 0, weight: Number.isFinite(weight) ? weight : 0, ...(preferredLabel ? { preferredLabel } : {}) });
    }
    // 같은 역할이 여러 조각으로 나뉘어 있으면 합친다
    const prev = out.find((r) => r.role === m[1]);
    if (prev) prev.arcs.push(...arcs);
    else if (arcs.length) out.push({ role: m[1], arcs });
  }
  return out;
}

export const parsePresentation = (t: string) => parseLinks(t, "presentationLink", "presentationArc");
export const parseCalculation = (t: string) => parseLinks(t, "calculationLink", "calculationArc");

/** 라벨 — 개념 id → (라벨 역할 → 문구). 정의문(documentation) 제외 */
export function parseLabels(lab: string): Map<string, Map<string, string>> {
  const loc = new Map<string, string>();
  for (const l of lab.matchAll(/<(?:link:)?loc\b([^>]*)\/?>/g)) {
    const label = /xlink:label="([^"]+)"/.exec(l[1])?.[1];
    const href = /xlink:href="([^"]+)"/.exec(l[1])?.[1];
    const id = href ? hrefId(href) : null;
    if (label && id) loc.set(label, id);
  }
  const res = new Map<string, { role: string; text: string }[]>();
  for (const m of lab.matchAll(/<(?:link:)?label\b([^>]*)>([\s\S]*?)<\/(?:link:)?label>/g)) {
    const id = /xlink:label="([^"]+)"/.exec(m[1])?.[1];
    const role = /xlink:role="([^"]+)"/.exec(m[1])?.[1] ?? "http://www.xbrl.org/2003/role/label";
    if (!id || /documentation/i.test(role)) continue;
    const text = m[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
    (res.get(id) ?? res.set(id, []).get(id)!).push({ role, text });
  }
  const out = new Map<string, Map<string, string>>();
  for (const a of lab.matchAll(/<(?:link:)?labelArc\b([^>]*)\/?>/g)) {
    const from = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? "");
    const t = res.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
    if (!from || !t) continue;
    const m = out.get(from) ?? new Map<string, string>();
    for (const x of t) if (!m.has(x.role)) m.set(x.role, x.text);
    out.set(from, m);
  }
  return out;
}

const SKIP_NODE = /(Abstract|LineItems|Table|Axis|Member|Domain)$/;
const REVENUE_Q = /^(us-gaap:(Revenues|RevenueFromContractWithCustomer\w*|RevenuesNetOfInterestExpense|InterestAndDividendIncomeOperating|InterestIncomeExpenseNet|NoninterestIncome)|ifrs-full:(Revenue|RevenueFromContractsWithCustomers))$/;
const NI_Q = /^(us-gaap:(NetIncomeLoss|ProfitLoss|NetIncomeLossAvailableToCommonStockholdersBasic)|ifrs-full:(ProfitLoss|ProfitLossAttributableToOwnersOfParent))$/;

export interface StatementShape {
  role: string;
  /** 표시 순서대로(중복 제거) — 개념 id·깊이·선호 라벨 역할 */
  lines: { id: string; depth: number; preferredLabel?: string }[];
}

/**
 * 손익계산서 역할 고르기 — 역할 이름이 손익(INCOME·OPERATIONS·EARNINGS·PROFIT) 이고 주석·표·세부·괄호·세금·부문·연결조정표가
 * 아닌 것 중, 매출 개념과 순이익 개념을 담은 것을 우선. 포괄손익 단독은 매출이 없으면 제외(IFRS 결합 보고서는 매출이 있음).
 */
export function pickIncomeStatement(pre: LinkRole[]): StatementShape | null {
  const cands: { r: LinkRole; score: number }[] = [];
  for (const r of pre) {
    const name = r.role.split("/").pop() ?? r.role;
    if (!/INCOME|OPERATIONS|EARNINGS|PROFIT|LOSS/i.test(name)) continue;
    if (/Parenthetical|Detail|Table|Polic|Tax|Segment|Consolidating|Guarantor|Parent|Schedule|Narrative|Quarterly|Unaudited|Supplement|Summary|Note|Disclosure|Reconciliation/i.test(name)) continue;
    const ids = new Set(r.arcs.flatMap((a) => [a.from, a.to]));
    const hasRev = [...ids].some((i) => REVENUE_Q.test(i));
    const hasNi = [...ids].some((i) => NI_Q.test(i));
    if (!hasRev && !hasNi) continue;
    let score = (hasRev ? 10 : 0) + (hasNi ? 5 : 0);
    if (/Comprehensive/i.test(name)) score -= hasRev ? 1 : 20;
    cands.push({ r, score });
  }
  // 역할 이름에 단서가 없는 공시(번호형 역할) — 매출·순이익을 함께 담은 첫 역할(재무제표 본표가 주석보다 앞선다)
  if (!cands.length)
    for (const r of pre) {
      const name = r.role.split("/").pop() ?? r.role;
      if (/Parenthetical|Detail|Table|Polic|Segment|Narrative/i.test(name)) continue;
      const ids = new Set(r.arcs.flatMap((a) => [a.from, a.to]));
      if ([...ids].some((i) => REVENUE_Q.test(i)) && [...ids].some((i) => NI_Q.test(i))) { cands.push({ r, score: 1 }); break; }
    }
  // 역할 이름을 잘못 단 공시 — 손익계산서가 다른 표 이름(괄호 주석 등)으로 들어가 이름으로 고른 후보에 매출이 없으면(포괄손익계산서만
  // 남음) 매출·순이익을 함께 담은 본표 역할을 이름과 무관하게 찾는다. Ford 2023 10-K(accn 0000037996-24-000009)는 손익계산서를
  // "CONSOLIDATEDSTATEMENTOFCASHFLOWSParenthetical" 역할로 공시해 FY2021 열이 포괄손익계산서로 조립·매출 빈칸이었다.
  // (이름으로 고른 후보가 전부 포괄손익계산서일 때만 — 회사 고유 매출 태그라 매출 개념이 안 보이는 정상 손익계산서(XOM 2018 이전)는 그대로)
  const onlyComprehensive = cands.length > 0 && cands.every((c) => c.score < 10 && /Comprehensive/i.test(c.r.role.split("/").pop() ?? ""));
  if (onlyComprehensive)
    for (const r of pre) {
      const name = r.role.split("/").pop() ?? r.role;
      if (/Detail|Table|Polic|Segment|Narrative|Notes?$|Disclosure|Schedule/i.test(name)) continue;
      const ids = new Set(r.arcs.flatMap((a) => [a.from, a.to]));
      if ([...ids].some((i) => REVENUE_Q.test(i)) && [...ids].some((i) => NI_Q.test(i))) { cands.push({ r, score: 9 }); break; }
    }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  const r = cands[0].r;
  // 루트부터 순서대로 펼친다(표·축·멤버·추상 노드는 건너뛰고 그 아래로)
  const kids = new Map<string, LinkArc[]>();
  const hasParent = new Set<string>();
  for (const a of r.arcs) {
    (kids.get(a.from) ?? kids.set(a.from, []).get(a.from)!).push(a);
    hasParent.add(a.to);
  }
  for (const k of kids.values()) k.sort((a, b) => a.order - b.order);
  const roots = [...kids.keys()].filter((k) => !hasParent.has(k));
  const lines: StatementShape["lines"] = [];
  const seen = new Set<string>();
  const walk = (id: string, depth: number, pl: string | undefined, guard: number) => {
    if (guard > 40) return;
    const skip = SKIP_NODE.test(id);
    if (!skip && !seen.has(id)) {
      seen.add(id);
      lines.push({ id, depth, ...(pl ? { preferredLabel: pl } : {}) });
    }
    for (const a of kids.get(id) ?? []) walk(a.to, skip ? depth : depth + 1, a.preferredLabel, guard + 1);
  };
  for (const root of roots) walk(root, 0, undefined, 0);
  return { role: r.role, lines };
}

/**
 * 계산 구조 — 같은 역할(없으면 줄을 가장 많이 담은 손익 역할)의 **합계식 전체**(부모 → [자식·가중치] 모든 호)와 표시용 부모.
 *
 * 한 개념이 둘 이상의 합계식의 항일 수 있다(XBRL 계산 구조는 트리가 아니다). AMD 2023 10-K: 매출원가(감가상각 제외) 줄이
 * "매출원가 = 원가 + 인수 무형상각"과 "매출총이익 = 매출 − 원가 − 인수 무형상각" 두 식의 항이다. 예전엔 자식마다 첫 호 하나만
 * 부모로 남겨 두 번째 식(매출총이익)이 매출만 자식으로 가진 식으로 잘려 항등식이 틀리게 판정됐다(재감사 2026-09-25).
 * 항등식은 `sums`(부모별 모든 호)로 판정하고, `parents` 는 화면 들여쓰기용 한 부모(표시 줄 안에 있는 부모 우선, 그중 첫 호)다.
 */
export function calcParents(cal: LinkRole[], role: string, lineIds: Set<string>): {
  parents: Map<string, { parent: string; w: number }>;
  sums: Map<string, { to: string; w: number }[]>;
} {
  let r = cal.find((c) => c.role === role) ?? null;
  if (!r) {
    let best = 0;
    for (const c of cal) {
      const name = c.role.split("/").pop() ?? "";
      if (!/INCOME|OPERATIONS|EARNINGS|PROFIT|LOSS/i.test(name) || /Parenthetical|Detail|Segment|Tax/i.test(name)) continue;
      const n = c.arcs.filter((a) => lineIds.has(a.to)).length;
      if (n > best) { best = n; r = c; }
    }
  }
  const parents = new Map<string, { parent: string; w: number }>();
  const sums = new Map<string, { to: string; w: number }[]>();
  const arcs = [...(r?.arcs ?? [])].sort((a, b) => a.order - b.order);
  for (const a of arcs) {
    const k = sums.get(a.from) ?? sums.set(a.from, []).get(a.from)!;
    if (!k.some((x) => x.to === a.to)) k.push({ to: a.to, w: a.weight });
  }
  // 표시 부모 — 표시 줄 안의 부모를 먼저(없으면 첫 호)
  for (const pass of [true, false])
    for (const a of arcs) if (!parents.has(a.to) && (!pass || lineIds.has(a.from))) parents.set(a.to, { parent: a.from, w: a.weight });
  return { parents, sums };
}
