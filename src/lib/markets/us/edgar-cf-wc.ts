import "server-only";
import { fetchJson, fetchText } from "../http";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { RecentFilings } from "./edgar-gapfill";
import { filingsForDa, instanceFacts } from "./edgar-cf-structure";
import { cfZeroFillGroups } from "./edgar-cashflow";

/**
 * **운전자본 변동 합계 = 현금흐름표 본표의 운전자본 줄 합**(10-K·10-Q 계산 구조, 2026-10-02).
 *
 * 분기보고서를 요약형으로 내는 회사(IBM·MCD·VST·HLT·XOM)는 10-Q 에 "영업 자산·부채 변동" 한 줄(IncreaseDecreaseInOperatingCapital 등)만,
 * 10-K 에는 매출채권·재고·매입채무 등 항목별 줄을 공시한다. 앱이 운전자본을 세 항목 합으로만 만들면 분기에 항목이 없어 LTM 운전자본이 비었다
 * (검증기 "현금흐름 LTM 공란 정당성" — 야후 분기 값은 있음). 공시마다 영업활동 계산 구조에서 운전자본 줄(개념명 IncreaseDecreaseIn…)을
 * 가중치(±1)대로 합해 같은 정의의 합계를 만들고, 부호는 IncreaseDecreaseInOperatingCapital 과 같이(양수 = 운전자본 증가 = 현금 유출) 둔다.
 */
export const SYN_WC_CF = "OperatingCapitalCashFlowDerived";
/**
 * 주식보상비용 본표 줄이 회사 고유 태그인 회사(BE — be_SharebasedCompensationAndIssuanceOfStockAndWarrantsForServicesOrClaims, 본표 표시 라벨
 * "Stock-based compensation expense", 2026-10-09). 본표에 표준 주식보상 개념이 없고 표시 라벨이 주식보상비용인 회사 고유 줄이 있으면 그 값을 공시 원본에서
 * 읽어 이 합성 개념으로 넣는다(본표 기준 원칙 — 예전엔 "본표에 별도 줄 없음" 빈칸이었다)
 */
export const SYN_SBC_CF = "ShareBasedCompensationFaceDerived";
const SBC_STD = ["us-gaap_ShareBasedCompensation", "us-gaap_AllocatedShareBasedCompensationExpense"];
const SBC_LABEL = /^(stock|share)[- ]based compensation( expense)?$/i;
/**
 * 설비투자(CAPEX) 합계 줄이 없는 공시 — 항공기 + 기타 유형자산 두 줄 합(오너 결정 2026-10-09, DAL 2026 2분기 10-Q: PaymentsForFlightEquipment 2,244 +
 * PaymentsToAcquireOtherProductiveAssets 414). 근거: 합계 줄이 있는 다른 모든 기간에 합계 = 두 줄 합이 정확히 성립(하나라도 어긋나면 만들지 않음)
 */
export const SYN_CAPEX_PARTS = "CapexComponentsDerived";
const CAPEX_TOTAL = ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets", "PaymentsForCapitalImprovements"];
const CAPEX_PARTS = ["PaymentsForFlightEquipment", "PaymentsToAcquireOtherProductiveAssets"];
const UA = process.env.SEC_USER_AGENT ?? "global-market-research (personal use) contact@example.com";
const H = { "user-agent": UA, "accept-encoding": "gzip, deflate" };
const OP_CF_ROOT = /^us-gaap_NetCashProvidedByUsedInOperatingActivities(ContinuingOperations)?$/;
// 운전자본 줄 — 표준·회사 고유 모두(MCD 10-K "mcd_IncreaseDecreaseInInventoriesPrepaidExpenses…")
const WC = /^[a-z0-9-]+_IncreaseDecreaseIn/i;
// 운전자본이 아닌 IncreaseDecreaseIn… — 자산복구충당부채(장기부채, VST "Change in asset retirement obligation liability"). 야후와의 연간 차이가
// 정확히 이 줄 값(VST 2025 −20·2024 38)이었다
const NOT_WC = /_IncreaseDecreaseInAssetRetirementObligations$/;
// 라벨로 운전자본임을 밝힌 줄(HLT us-gaap_OtherOperatingActivitiesCashFlowStatement "Working capital changes and other")
const WC_LABEL = /working capital|operating assets and liabilities/i;

/** 표시 라벨(_lab.xml) — 개념명 → 라벨들 */
function labelsOf(lab: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const locs = new Map<string, string>();
  for (const l of lab.matchAll(/<(?:link:)?loc\b([^>]*)\/?>/g)) {
    const id = /xlink:label="([^"]+)"/.exec(l[1])?.[1];
    const href = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1];
    if (id && href) locs.set(id, href);
  }
  const arcs = new Map<string, string[]>();
  for (const a of lab.matchAll(/<(?:link:)?labelArc\b([^>]*)\/?>/g)) {
    const from = locs.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? "");
    const to = /xlink:to="([^"]+)"/.exec(a[1])?.[1];
    if (from && to) arcs.set(to, [...(arcs.get(to) ?? []), from]);
  }
  // 설명(documentation) 라벨은 제외 — 긴 정의문에 "operating assets and liabilities" 가 섞여 나온다
  for (const m of lab.matchAll(/<(?:link:)?label\b([^>]*)>([^<]*)</g)) {
    const id = /xlink:label="([^"]+)"/.exec(m[1])?.[1];
    if (!id || /documentation/i.test(m[1])) continue;
    for (const c of arcs.get(id) ?? []) out.set(c, [...(out.get(c) ?? []), m[2]]);
  }
  return out;
}

/** 현금흐름표 본표 계산 구조에 나오는 개념 전체(없으면 null) */
function cashFlowFace(cal: string): Set<string> | null {
  let out: Set<string> | null = null;
  for (const m of cal.matchAll(/<(?:link:)?calculationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/(?:link:)?calculationLink>/g)) {
    const role = m[1].split("/").pop() ?? "";
    if (!/CASHFLOW/i.test(role) || /Detail|Table|Parenth|Supplement/i.test(role)) continue;
    out ??= new Set<string>();
    for (const l of m[2].matchAll(/xlink:href="[^"#]*#([^"]+)"/g)) out.add(l[1]);
  }
  return out;
}

/**
 * 영업활동 아래 줄을 운전자본(wc)과 그 밖(other)으로 나눈다 — 개념명 → 가중치. 운전자본 소계(IncreaseDecreaseInOperatingCapital)가 본표
 * 줄이면 그 하위로 내려가지 않는다. 그 밖 줄은 회사 고유 개념이면 하위로 내려가 표준 개념까지 찾는다(값은 companyfacts 에 표준 개념만 있다)
 */
export function cashFlowWcLines(cal: string, labels?: Map<string, string[]>): { wc: Map<string, number>; other: Map<string, number> } | null {
  for (const m of cal.matchAll(/<(?:link:)?calculationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/(?:link:)?calculationLink>/g)) {
    const role = m[1].split("/").pop() ?? "";
    if (!/CASHFLOW/i.test(role) || /Detail|Table|Parenth|Supplement/i.test(role)) continue;
    const loc = new Map<string, string>();
    for (const l of m[2].matchAll(/<(?:link:)?loc\b([^>]*)\/?>/g)) {
      const id = /xlink:label="([^"]+)"/.exec(l[1])?.[1];
      const href = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1];
      if (id && href) loc.set(id, href);
    }
    const arcs: { from: string; to: string; w: number }[] = [];
    for (const a of m[2].matchAll(/<(?:link:)?calculationArc\b([^>]*)\/?>/g)) {
      const from = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? "");
      const to = loc.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
      const w = Number(/weight="([^"]+)"/.exec(a[1])?.[1] ?? "1");
      if (from && to) arcs.push({ from, to, w });
    }
    const root = arcs.find((a) => OP_CF_ROOT.test(a.from))?.from;
    if (!root) continue;
    const wc = new Map<string, number>();
    const other = new Map<string, number>();
    const seen = new Set<string>();
    const walk = (id: string, sign: number, depth: number) => {
      if (depth > 3) return;
      for (const a of arcs.filter((x) => x.from === id)) {
        if (seen.has(a.to)) continue;
        seen.add(a.to);
        const s = sign * a.w;
        const kids = arcs.some((x) => x.from === a.to);
        const isWc = (WC.test(a.to) && !NOT_WC.test(a.to)) || (labels?.get(a.to) ?? []).some((t) => WC_LABEL.test(t));
        if (isWc) wc.set(a.to, s); // 운전자본 줄(소계면 그 자체) — 하위로 내려가지 않음
        else if (a.to.startsWith("us-gaap_") || !kids) other.set(a.to, s);
        else walk(a.to, s, depth + 1);
      }
    };
    walk(root, 1, 0);
    return wc.size ? { wc, other } : null;
  }
  return null;
}

export async function withCashFlowWc(cik: string, facts: CompanyFacts, recent: RecentFilings | null): Promise<CompanyFacts> {
  if (!recent) return facts;
  const g = facts.facts["us-gaap"] ?? {};
  const opt = { headers: H, revalidate: 60 * 60 * 24, timeoutMs: 30_000 };
  const synth: FactUnitEntry[] = [];
  const zeros: [string, FactUnitEntry][] = [];
  const sbc: FactUnitEntry[] = [];
  const capexParts: FactUnitEntry[] = [];
  const zeroGroups = cfZeroFillGroups();
  for (const f of filingsForDa(recent)) {
    const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${f.accn.replace(/-/g, "")}`;
    const idx = await fetchJson<{ directory: { item: { name: string }[] } }>(`${base}/index.json`, opt);
    const names = idx.directory.item.map((i) => i.name);
    const cal = names.find((n) => /_cal\.xml$/i.test(n)) ?? names.find((n) => /\.xsd$/i.test(n));
    if (!cal) continue;
    const labF = names.find((n) => /_lab\.xml$/i.test(n));
    const calXml = await fetchText(`${base}/${cal}`, opt);
    // 이 공시의 현금흐름표 기간 — 같은 날 제출된 영업활동 현금흐름
    const ocf = (g.NetCashProvidedByUsedInOperatingActivities?.units?.USD ?? []).filter((e) => e.start && e.filed === f.filed && e.form === f.form);
    // 본표에서 빠진 투자·재무 줄 = 0 (AMAT 2026 회계연도 10-Q 3건에 "장기차입금 조달" 줄이 없다 — 당기·전년 동기 모두 조달 0 이라 생략, LTM 이 비었다.
    // 야후 분기 0). 이 공시 본표 구조에 그 줄 태그가 하나도 없고, companyfacts 에도 이 공시 값이 없고, 전년 동기 값이 이전 공시에 0(또는 없음)일
    // 때만 — 전년 동기가 0 이 아니었다면 줄이 다른 태그로 옮겨 간 것이라 채우지 않는다
    // 0 채움은 분기 보고서(10-Q)만 — 10-K 본표에 줄이 없으면 그 해는 "본표에 별도 줄 없음"(오너 규칙 2026-10-02 — 0 으로 채우지 않음). 10-K 에도
    // 적용하던 동안 줄이 다른 개념으로 옮겨 간 회사(GLW 설비투자 → PaymentsForCapitalImprovements)·줄 자체가 없는 회사(IBM·DAL·AMZN 자기주식 취득)의
    // 연간 칸이 0 으로 채워졌다(2026-10-08 전체 모드 검증)
    const face = /^10-Q/.test(f.form) ? cashFlowFace(calXml) : null;
    if (face) {
      for (const grp of zeroGroups) {
        if (grp.some((c) => face.has(`us-gaap_${c}`))) continue;
        const has = grp.flatMap((c) => g[c]?.units?.USD ?? []);
        if (!has.length || has.some((x) => x.filed === f.filed)) continue;
        if (ocf.some((e) => has.some((x) => x.start === e.start && x.end === e.end && x.val !== 0))) continue;
        const c0 = grp.find((c) => (g[c]?.units?.USD ?? []).length) as string;
        for (const e of ocf) zeros.push([c0, { ...e, val: 0 }]);
      }
    }
    // 10-K 본표에 줄이 있는데 그 기간 칸이 "—"(값 태그 없음)이면 0(2026-10-09 — GLW 2024 10-K 자기주식 취득 줄의 2023 칸 "—", 앱이 "본표에 별도 줄 없음"
    // 빈칸으로 두던 것. 검증기 A층이 같은 판독으로 확인). 어느 공시에든 그 기간 값이 있으면 그 값을 쓰고 채우지 않는다
    // 10-Q 도 같다(2026-10-09 — GLW 2026 2분기 10-Q 자기주식 취득 줄의 당기 누적 칸 "—", 전년 동기 133: 앱이 LTM 을 "LTM 구성 분기 없음"으로 비웠다.
    // 오너 규칙 "본표 줄의 — = 0" — 검증기 A층이 같은 판독으로 확인)
    if (/^10-[KQ]/.test(f.form)) {
      const faceK = cashFlowFace(calXml);
      if (faceK) for (const grp of zeroGroups) {
        const c0 = grp.find((c) => faceK.has(`us-gaap_${c}`));
        if (!c0) continue;
        const has = grp.flatMap((c) => g[c]?.units?.USD ?? []);
        for (const e of ocf) if (!has.some((x) => x.start === e.start && x.end === e.end)) zeros.push([c0, { ...e, val: 0 }]);
      }
    }
    const labs = labF ? labelsOf(await fetchText(`${base}/${labF}`, opt)) : undefined;
    // 주식보상비용 — 본표에 표준 개념이 없고 표시 라벨이 주식보상비용인 회사 고유 줄(영업활동 계산 구조 안)
    const faceS = /^10-[KQ]/.test(f.form) ? cashFlowFace(calXml) : null;
    if (faceS && labs && !SBC_STD.some((c) => faceS.has(c))) {
      const ids = [...faceS].filter((id) => !id.startsWith("us-gaap_") && (labs.get(id) ?? []).some((t) => SBC_LABEL.test(t.trim())));
      if (ids.length === 1) {
        const inst = names.find((n) => /_htm\.xml$/i.test(n));
        if (inst) {
          const xml = await fetchText(`${base}/${inst}`, { headers: H, revalidate: false, timeoutMs: 30_000 });
          const fsx = instanceFacts(xml, (id) => id === ids[0]);
          for (const e of ocf) {
            const v = fsx.find((x) => x.id === ids[0] && x.period === `${e.start}|${e.end}` && x.dims.length === 0);
            if (v) sbc.push({ ...e, val: v.val });
          }
        }
      }
    }
    // CAPEX 합계 줄 없음 + 두 구성 줄 있음 → 두 줄 합
    if (faceS && !CAPEX_TOTAL.some((c) => faceS.has(`us-gaap_${c}`)) && CAPEX_PARTS.every((c) => faceS.has(`us-gaap_${c}`)))
      for (const e of ocf) {
        // 합계 개념 값이 이 공시·기간에 있으면 그 값(합계 줄이 계산 구조에서 상위 노드로만 잡히는 공시가 있다 — DAL 2026 1분기)
        if (CAPEX_TOTAL.some((c) => (g[c]?.units?.USD ?? []).some((x) => x.start === e.start && x.end === e.end && x.filed === e.filed))) continue;
        const vs = CAPEX_PARTS.map((c) => (g[c]?.units?.USD ?? []).find((x) => x.start === e.start && x.end === e.end && x.filed === e.filed));
        if (vs.every(Boolean)) capexParts.push({ ...e, val: vs.reduce((t, x) => t + x!.val, 0) });
      }
    const lines = cashFlowWcLines(calXml, labs);
    if (!lines) continue;
    // ① companyfacts — 운전자본 줄이 모두 표준 개념이고 값이 다 있으면
    const fromCf = (e: FactUnitEntry): number | null => {
      let sum = 0;
      for (const [c, w] of lines.wc) {
        if (!c.startsWith("us-gaap_")) return null;
        const v = (g[c.slice(8)]?.units?.USD ?? []).find((x) => x.start === e.start && x.end === e.end && x.filed === e.filed);
        if (!v) return null;
        sum += w * v.val;
      }
      return sum;
    };
    const sums = ocf.map(fromCf);
    // ② 공시 원본(인스턴스) — 회사 고유 줄(MCD·IBM·XOM)이나 차원을 붙여 태깅한 본표 줄(HLT 로열티 부채 변동 — ProductOrServiceAxis=
    //    GuestLoyaltyProgramMember)이 있으면. 차원 없는 값이 우선, 없으면 그 기간에 값이 하나뿐인 차원 값(본표 줄이 차원으로만 태깅된 경우)
    if (sums.some((v) => v == null)) {
      const inst = names.find((n) => /_htm\.xml$/i.test(n));
      if (!inst) continue;
      const xml = await fetchText(`${base}/${inst}`, { headers: H, revalidate: false, timeoutMs: 30_000 });
      const fsx = instanceFacts(xml, (id) => lines.wc.has(id));
      ocf.forEach((e, i) => {
        if (sums[i] != null) return;
        const p = `${e.start}|${e.end}`;
        let sum = 0;
        for (const [c, w] of lines.wc) {
          const all = fsx.filter((x) => x.id === c && x.period === p);
          const v = all.find((x) => x.dims.length === 0) ?? (all.length === 1 ? all[0] : undefined);
          if (!v) return; // 줄 하나라도 값이 없으면 합계를 만들지 않는다(부분 합 금지)
          sum += w * v.val;
        }
        sums[i] = sum;
      });
    }
    // 부호는 IncreaseDecreaseInOperatingCapital 과 같이 증가 = 유출
    ocf.forEach((e, i) => { if (sums[i] != null) synth.push({ ...e, val: -(sums[i] as number) }); });
  }
  // 근거 확인 — 합계·두 줄이 같은 공시·기간에 모두 있는 기간마다 합계 = 두 줄 합(하나라도 어긋나거나 확인 기간이 없으면 만들지 않음).
  // 확인 범위 = 이 함수가 읽는 공시 창(최근 10-K 5건~)에 제출된 값 — 그보다 옛 공시는 줄 구성이 달랐다(DAL 2016 10-K 의 2013: 합계 2,568 = 두 줄 2,521 + 다른 줄)
  if (capexParts.length) {
    const from = filingsForDa(recent).reduce((m, f) => (f.filed < m ? f.filed : m), "9999");
    const tot = CAPEX_TOTAL.flatMap((c) => g[c]?.units?.USD ?? []).filter((x) => x.start && (x.filed ?? "") >= from);
    const pair = tot.map((t) => CAPEX_PARTS.map((c) => (g[c]?.units?.USD ?? []).find((x) => x.start === t.start && x.end === t.end && x.filed === t.filed)))
      .map((ps, i) => (ps.every(Boolean) ? [tot[i].val, ps.reduce((s0, x) => s0 + x!.val, 0)] : null)).filter((x): x is number[] => !!x);
    if (!pair.length || pair.some(([a, b]) => a !== b)) capexParts.length = 0;
  }
  if (!synth.length && !zeros.length && !sbc.length && !capexParts.length) return facts;
  const ng: Record<string, unknown> = { ...g };
  if (synth.length) ng[SYN_WC_CF] = { label: "운전자본 변동(본표 줄 합)", units: { USD: synth } };
  if (sbc.length) ng[SYN_SBC_CF] = { label: "주식보상비용(본표 회사 고유 줄)", units: { USD: sbc } };
  if (capexParts.length) ng[SYN_CAPEX_PARTS] = { label: "설비투자(항공기 + 기타 유형자산 줄 합)", units: { USD: capexParts } };
  for (const [c, e] of zeros) {
    const cur = (ng[c] ?? { units: {} }) as { label?: string; units: Record<string, FactUnitEntry[]> };
    ng[c] = { ...cur, units: { ...cur.units, USD: [...(cur.units.USD ?? []), e] } };
  }
  return { ...facts, facts: { ...facts.facts, "us-gaap": ng as never } };
}
