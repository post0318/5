import "server-only";
import { fetchJson, fetchText } from "../http";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { RecentFilings } from "./edgar-gapfill";
import { filingsForDa, instanceFacts } from "./edgar-cf-structure";
import { CF_INV_FAMILIES, OTHER_NC, SYN_NI_CF, SYN_OTHER_NC_CF, cfInvStdConcepts, cfZeroFillGroups } from "./edgar-cashflow";

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
// 운전자본 줄 = 증감 꼴 개념(오너 결정 2026-10-18 E 2안 — "In" 없는 회사 고유 꼴 포함: BE be_IncreaseDecreaseOnAccruedWarrantyLiability·
// …FinancingCashFlowsFromFinanceLeases, UBER 2021 uber_IncreaseDecreaseFundsHeldByInsurers — BE 2022~2025 야후 일치, UBER 2021 StockAnalysis 일치)
const WC = /^[a-z0-9-]+_IncreaseDecrease/i;
// 운전자본이 아닌 IncreaseDecreaseIn… — 자산복구충당부채(장기부채, VST "Change in asset retirement obligation liability"). 야후와의 연간 차이가
// 정확히 이 줄 값(VST 2025 −20·2024 38)이었다
// 지분증권 공정가치 변동(INTC "Gains on equity investments" — us-gaap_IncreaseDecreaseInEquitySecuritiesFvNi)도 운전자본 아님(비현금 평가손익)
// 이연법인세(ISRG us-gaap_IncreaseDecreaseInDeferredIncomeTaxes — 이름만 증감 꼴)도 운전자본 아님 → 기타 비현금 조정(OTHER_NC)
// 공정가치 변동 꼴(MRVL mrvl_IncreaseDecreaseInFairValueOfForwardStockPurchaseContract)·세금 수취약정 부채(VRT vrt_IncreaseDecreaseInTaxReceivableAgreement)도
// 같은 종류(비현금 평가손익·운전자본 밖 부채, 표시 구조에서도 운전자본 묶음 밖 — 감사 2026-10-18)
// 거래상대방 담보금 증감(CEG us-gaap_IncreaseDecreaseCashCollateralFromCounterparties — 헤지 증거금, 야후도 운전자본 밖)도 제외(오너 결정 2026-10-18 E 2안)
const NOT_WC = /_IncreaseDecrease(?:In)?(AssetRetirementObligations|EquitySecuritiesFvNi|DeferredIncomeTaxes|\w*FairValue\w*|TaxReceivableAgreement\w*|\w*Collateral\w*)$/i;
// 라벨로 운전자본임을 밝힌 줄(HLT us-gaap_OtherOperatingActivitiesCashFlowStatement "Working capital changes and other")
const WC_LABEL = /working capital|operating assets and liabilities/i;

/** 현금흐름표 표시 구조(_pre.xml)에 실린 개념 — 역할 이름에 CashFlow 가 있고 세부·괄호·정책 표가 아닌 역할 */
function cashFlowPresentation(pre: string): Set<string> {
  const out = new Set<string>();
  for (const m of pre.matchAll(/<(?:link:)?presentationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/(?:link:)?presentationLink>/g)) {
    const role = (m[1].split("/").pop() ?? "").replace(/[^A-Za-z]/g, "");
    if (!/CashFlow/i.test(role) || /Detail|Table|Parenth|Polic|Supplement|Narrative/i.test(role)) continue;
    for (const l of m[2].matchAll(/<(?:link:)?loc\b[^>]*xlink:href="[^"#]*#([^"]+)"/g)) out.add(l[1]);
  }
  return out;
}

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
    // 역할 이름의 하이픈·밑줄 무시(GLW 2024 10-K "statement-consolidated-statements-of-cash-flows" — 못 읽어 그 공시가 빠졌다, 2026-10-10)
    if (!/CASHFLOW/i.test(role.replace(/[^A-Za-z]/g, "")) || /Detail|Table|Parenth|Supplement/i.test(role)) continue;
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
    // 역할 이름의 하이픈·밑줄 무시(GLW 2024 10-K "statement-consolidated-statements-of-cash-flows" — 못 읽어 그 공시가 빠졌다, 2026-10-10)
    if (!/CASHFLOW/i.test(role.replace(/[^A-Za-z]/g, "")) || /Detail|Table|Parenth|Supplement/i.test(role)) continue;
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
        // 표준 개념 줄은 소계라도 그 자체로 — 단 "조정 항목" 소계(INTC: 비현금 조정·운전자본 줄이 모두 그 아래)는 내려간다
        else if ((a.to.startsWith("us-gaap_") && !/_AdjustmentsToReconcileNetIncomeLossToCashProvidedByUsedInOperatingActivities$/.test(a.to)) || !kids) other.set(a.to, s);
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
  const invFace = new Map<string, FactUnitEntry[]>(CF_INV_FAMILIES.map((f) => [f.derived, []]));
  const zeroGroups = cfZeroFillGroups();
  const dimOnly: NonNullable<CompanyFacts["cfDimOnly"]> = [];
  const niFace: FactUnitEntry[] = [];
  const ncFace: FactUnitEntry[] = [];
  // 기타 비현금 조정 후보 — 기간마다 공시별 값. 한 기간 = 가장 최근 공시, 그 공시가 계산 구조 누락(calcGap)이면 그다음 최근 공시
  const ncCand: { per: string; filed: string; e: FactUnitEntry; val: number | null; calcGap: boolean }[] = [];
  const niCons: string[] = [];
  let niRead = false;
  let wcRead = false;
  const wcMiss: string[] = []; // 본표 운전자본 줄은 읽었으나 합을 못 만든 기간의 종료일 // 본표에서 운전자본 줄을 읽은 공시가 하나라도 있음
  // 기간 → 그 기간 현금흐름표를 실은 가장 최근 공시(제출일) — 투자자산 본표 줄 합은 그 공시에서만(옛 공시의 합이 최신 공시 표준값을 덮지 않게 —
  // 7차 감사 2026-10-17: DELL FY2023 10-K 본표 두 줄 중 한 줄만 더한 256·94 가 FY2024 10-K 의 414·108 을 덮었다)
  const latestFiled = new Map<string, string>();
  for (const f0 of filingsForDa(recent))
    for (const e of (g.NetCashProvidedByUsedInOperatingActivities?.units?.USD ?? []).filter((x) => x.start && x.filed === f0.filed && x.form === f0.form)) {
      const k = `${e.start}|${e.end}`;
      if ((latestFiled.get(k) ?? "") < f0.filed) latestFiled.set(k, f0.filed);
    }
  // 현금흐름표 다른 줄이 쓰는 표준 개념(투자자산 합에 넣으면 이중 합산)
  const otherLineStd = new Set(cfZeroFillGroups().flat());
  let tenKLabs: Map<string, string[]> | undefined;
  {
    const k = filingsForDa(recent).filter((f) => f.form === "10-K").sort((x, y) => (x.filed < y.filed ? 1 : -1))[0];
    if (k) {
      const kb = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${k.accn.replace(/-/g, "")}`;
      const kn = (await fetchJson<{ directory: { item: { name: string }[] } }>(`${kb}/index.json`, opt)).directory.item.map((i) => i.name).find((n) => /_lab\.xml$/i.test(n));
      if (kn) tenKLabs = labelsOf(await fetchText(`${kb}/${kn}`, opt));
    }
  }
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
      // 단, 원본에 그 기간 사실이 차원으로만 있으면(CAT 2025 10-K 차입 줄 — 기계·금융 부문 멤버뿐, companyfacts 엔 차원 없는 값만 실려 빈다) "—" 가 아니다 —
      // 0 으로 채우지 않는다(감사 2026-10-17: CAT 장기차입금 조달·상환이 전 기간 0, 차입 흐름이 기타 재무활동으로 갔다). 후보가 있을 때만 원본을 읽는다
      const cand: [string, FactUnitEntry][] = [];
      if (faceK) for (const grp of zeroGroups) {
        const c0 = grp.find((c) => faceK.has(`us-gaap_${c}`));
        if (!c0) continue;
        const has = grp.flatMap((c) => g[c]?.units?.USD ?? []);
        for (const e of ocf) if (!has.some((x) => x.start === e.start && x.end === e.end)) cand.push([c0, { ...e, val: 0 }]);
      }
      if (cand.length) {
        // 원본 파일이 없으면 "—" 를 확인할 수 없어 0 으로 채우지 않는다(그 칸은 빈칸)
        const instN = names.find((n) => /_htm\.xml$/i.test(n));
        if (instN) {
          const want = new Set(cand.map(([c]) => `us-gaap_${c}`));
          const fsx = instanceFacts(await fetchText(`${base}/${instN}`, { headers: H, revalidate: false, timeoutMs: 30_000 }), (id) => want.has(id));
          for (const [c, e] of cand) {
            const xs = fsx.filter((x) => x.id === `us-gaap_${c}` && x.period === `${e.start}|${e.end}`);
            // 사실 없음 = "—" → 0. 차원 사실뿐인데 모두 0 이면 합도 0 이라 0(AMD 2020·2021 사업 인수). 0 아닌 차원 사실이 있으면 빈칸 + 사유
            if (!xs.length || (xs.every((x) => x.dims.length > 0) && xs.every((x) => x.val === 0))) zeros.push([c, e]);
            else if (xs.every((x) => x.dims.length > 0)) dimOnly.push({ concept: c, start: e.start!, end: e.end });
          }
        }
      }
    }
    // 현금흐름표 첫 줄 순이익 = 이 공시 본표에 실린 순이익 개념(하나뿐일 때), 값 = 이 공시 companyfacts 값. 둘 다·둘 다 없음이면 이 공시 기간은 빈칸
    const faceN = /^10-[KQ]/.test(f.form) ? cashFlowFace(calXml) : null;
    if (faceN) {
      niRead = true;
      const cs = (["NetIncomeLoss", "ProfitLoss"] as const).filter((c) => faceN.has(`us-gaap_${c}`));
      // 한 기간 = 그 기간을 실은 가장 최근 공시만(옛 공시 값이 분기 누적 차에 섞이지 않게 — 감사 2026-10-18: 이연법인세 합성값이 최신 공시부터 쌓여 분기 누적에서
      // 가장 옛 공시 값이 잡혔다, AMD·AXP 2025 Q2)
      if (cs.length === 1)
        for (const e of ocf) {
          if (latestFiled.get(`${e.start}|${e.end}`) !== f.filed) continue;
          const at = (c: string) => (g[c]?.units?.USD ?? []).find((x) => x.start === e.start && x.end === e.end && x.filed === f.filed && x.form === f.form);
          const v = at(cs[0]);
          if (!v) continue;
          niFace.push({ ...e, val: v.val });
          // 연결 순이익이고 비지배지분 몫이 있을 때만 — 그 공시의 지배주주 순이익이 따로 있고 값이 다르거나, 비지배지분 순이익이 0 이 아님
          // (CAT·BE 는 NetIncomeLoss 태그 없이 비지배 순이익만 공시, AVGO 는 둘 다 없음 — 주석 없음. 6차 감사 2026-10-17)
          // 지배주주 순이익·비지배 몫 태그가 이 공시에 없으면 그 기간을 실은 다른 공시 값(주석 판정에만 — BE FY2023 10-K 는 2021 NetIncomeLoss 없이 비지배 몫을
          // Nonredeemable·Redeemable 로 나눠 태깅, 감사 2026-10-18)
          const anyAt = (c: string) => at(c) ?? (g[c]?.units?.USD ?? []).find((x) => x.start === e.start && x.end === e.end);
          const nil = anyAt("NetIncomeLoss");
          const nci = ["NetIncomeLossAttributableToNoncontrollingInterest", "NetIncomeLossAttributableToNonredeemableNoncontrollingInterest", "NetIncomeLossAttributableToRedeemableNoncontrollingInterest"]
            .map(anyAt).filter((x): x is FactUnitEntry => !!x);
          if (cs[0] === "ProfitLoss" && ((nil && nil.val !== v.val) || nci.some((x) => x.val !== 0))) niCons.push(`${e.start}|${e.end}`);
        }
    }
    // 라벨로 운전자본을 판정하는 개념(WC_LABEL)은 회사 최근 10-K 라벨로 통일 — HLT 는 같은 개념(OtherOperatingActivitiesCashFlowStatement)을 10-Q 에선
    // "Working capital changes and other", 10-K 에선 "Other" 로 달아 LTM(사업연도 + 누적 차)에 정의가 섞였다(감사 2026-10-18 A)
    const labs0 = labF ? labelsOf(await fetchText(`${base}/${labF}`, opt)) : undefined;
    const labs = labs0;
    const labsWc = labs0 && tenKLabs ? new Map([...labs0, ...tenKLabs]) : labs0;
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
    // 투자자산 처분·취득 = 본표 줄 합 — 본표를 읽은 공시는 언제나(회사 고유 줄이 없어도) 같은 성격 본표 줄 전부(표준 + 회사 고유)를 그 공시 원본 값으로 더하고,
    // 한 기간 = 그 기간을 실은 가장 최근 공시(latestFiled). 예전엔 회사 고유 줄이 있을 때만 만들고 나머지는 표준 개념 목록을 연간 칸에서 개념별로 더해, 같은
    // 금액을 본표 줄·주석 태그로 함께 단 공시(CAT AFS 매각)나 태그를 바꾼 회사(META·NFLX 2023 — 2배)·옛 10-K 태그(PEP)가 두 번 들어갔다(8차 감사 2026-10-17,
    // 운영 판부터 있던 결함). 본표 줄인데 그 기간 값이 없으면 0("—"). 같은 성격 꼴 표준 줄(처분·취득 꼴 — AMD 단기투자 만기 회수, DELL 만기보유증권)은 넣되
    // 기타 투자·시장가 없는 지분·원전 해체기금은 투자자산, 지분법은 기타 투자활동(오너 결정 2026-10-18 — 판정은 CF_INV_FAMILIES 한 곳)
    if (faceS) {
      const local = (id: string) => id.replace(/^[^_]+_/, "");
      const fams = CF_INV_FAMILIES.map((fm) => {
        const std = new Set(cfInvStdConcepts(fm.label));
        const ids = [...faceS].filter((id) => (id.startsWith("us-gaap_")
          ? std.has(local(id)) || (fm.custom.test(local(id)) && !/EquityMethod/.test(local(id)) && !otherLineStd.has(local(id)))
          : fm.custom.test(local(id))));
        return { fm, ids };
      }).filter((x) => x.ids.length);
      const inst = fams.length ? names.find((n) => /_htm\.xml$/i.test(n)) : null;
      if (inst) {
        const want = new Set(fams.flatMap((x) => x.ids));
        const fsx = instanceFacts(await fetchText(`${base}/${inst}`, { headers: H, revalidate: false, timeoutMs: 30_000 }), (id) => want.has(id));
        for (const { fm, ids } of fams)
          for (const e of ocf) {
            if (latestFiled.get(`${e.start}|${e.end}`) !== f.filed) continue;
            const at = (id: string) => fsx.find((x) => x.id === id && x.period === `${e.start}|${e.end}` && x.dims.length === 0);
            // 본표 줄인데 차원 없는 값이 없고 0 아닌 차원 값만 있으면 0 으로 더하지 않는다(부분합 금지) — 그 칸 빈칸 + 사유
            const dimOnlyId = ids.find((id) => !at(id) && fsx.some((x) => x.id === id && x.period === `${e.start}|${e.end}` && x.val !== 0));
            if (dimOnlyId) { dimOnly.push({ concept: fm.derived, start: e.start!, end: e.end, force: true }); continue; }
            invFace.get(fm.derived)!.push({ ...e, val: ids.reduce((t, id) => t + (at(id)?.val ?? 0), 0) });
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
    const lines = cashFlowWcLines(calXml, labsWc);
    if (lines && /^10-[KQ]/.test(f.form)) wcRead = true;
    // 기타 비현금 조정 = 본표 비운전자본 줄 중 기타 비현금·이연법인세 개념의 그 공시 값 × 본표 가중치 합(한 기간 = 가장 최근 공시). 예전엔 개념 목록을 부호 고정으로
    // 더하고 운전자본 줄(기타 영업자산·부채·미수금 증감 — 운전자본 변동에도 들어감)까지 넣어, AAPL FY2021 이 451(본표 −4,921: 부호 반대 + 운전자본 3줄 이중)이고 기타
    // 영업활동이 −5,372 로 떠안았다(감사 2026-10-18 — 이연법인세 본표·주석 이중 합산 MSFT·옛 공시 섞임 CL·부호 반전 규칙 AMD 도 같은 원인). 본표에 해당 줄이 없으면
    // 넣지 않는다(빈칸 — 다른 비운전자본 줄은 기타 영업활동)
    if (lines && /^10-[KQ]/.test(f.form)) {
      const ids = OTHER_NC.filter((c) => lines.other.has(`us-gaap_${c}`));
      // companyfacts 에 그 공시 값이 빠진 줄은 그 공시 원본(인스턴스)에서 — ORCL FY2026 10-K: 본표 "Other, net"(OtherNoncashIncomeExpense)이 companyfacts 에
      // 없어 2024~2026·LTM 이 빈칸이었다. 원본에도 그 기간 차원 없는 값이 없으면 0("—"), 0 아닌 차원 값만 있으면 그 기간은 넣지 않음(빈칸)
      let fsx: ReturnType<typeof instanceFacts> | null | undefined;
      // 현금흐름표 표시 구조(_pre.xml)의 개념 — 계산 구조 누락 판정용(값만 있는 주석 태그와 구분: 이연법인세는 대개 법인세 주석에도 달린다)
      const preN = names.find((n) => /_pre\.xml$/i.test(n));
      const preCf = OTHER_NC.some((c) => !ids.includes(c) && !lines.wc.has(`us-gaap_${c}`) && ocf.some((e) => (g[c]?.units?.USD ?? []).some((x) => x.start === e.start && x.end === e.end && x.filed === f.filed)))
        && preN ? cashFlowPresentation(await fetchText(`${base}/${preN}`, opt)) : null;
      for (const e of ocf) {
        const per = `${e.start}|${e.end}`;
        const cf = (c: string) => (g[c]?.units?.USD ?? []).find((x) => x.start === e.start && x.end === e.end && x.filed === f.filed && x.form === f.form)?.val ?? null;
        // 그 공시가 값을 달았는데 계산 구조에 없는 개념 = 계산 구조 누락(INTC FY2023 10-K: 본표·표시 구조엔 이연법인세 줄이 있으나 계산 구조엔 없음) — 이 공시는 쓰지 않고
        // 그 기간을 실은 다음 최근 공시로(아래 ncCand)
        if (OTHER_NC.some((c) => !ids.includes(c) && cf(c) != null && !lines.wc.has(`us-gaap_${c}`) && preCf?.has(`us-gaap_${c}`))) { ncCand.push({ per, filed: f.filed, e, val: null, calcGap: true }); continue; }
        // 이 공시 본표에 해당 줄이 없음 — 이 기간은 빈칸(옛 공시 값으로 넘어가지 않게 후보로 남김, 감사 2026-10-18 F)
        if (!ids.length) { ncCand.push({ per, filed: f.filed, e, val: null, calcGap: false }); continue; }
        const vs: (number | null)[] = ids.map(cf);
        if (vs.some((x) => x == null)) {
          if (fsx === undefined) {
            const instN = names.find((n) => /_htm\.xml$/i.test(n));
            const want = new Set(ids.map((c) => `us-gaap_${c}`));
            fsx = instN ? instanceFacts(await fetchText(`${base}/${instN}`, { headers: H, revalidate: false, timeoutMs: 30_000 }), (id) => want.has(id)) : null;
          }
          if (!fsx) { ncCand.push({ per, filed: f.filed, e, val: null, calcGap: false }); continue; }
          let skip = false;
          ids.forEach((c, k) => {
            if (vs[k] != null) return;
            const xs = fsx!.filter((x) => x.id === `us-gaap_${c}` && x.period === per);
            const plain = xs.find((x) => x.dims.length === 0);
            if (plain) vs[k] = plain.val;
            else if (xs.some((x) => x.val !== 0)) skip = true;
            else vs[k] = 0;
          });
          if (skip) { ncCand.push({ per, filed: f.filed, e, val: null, calcGap: false }); continue; }
        }
        ncCand.push({ per, filed: f.filed, e, val: ids.reduce((t, c, k) => t + lines.other.get(`us-gaap_${c}`)! * vs[k]!, 0), calcGap: false });
      }
    }
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
      if (!inst) { ocf.forEach((e, i) => { if (sums[i] == null) wcMiss.push(e.end); }); continue; }
      const xml = await fetchText(`${base}/${inst}`, { headers: H, revalidate: false, timeoutMs: 30_000 });
      const fsx = instanceFacts(xml, (id) => lines.wc.has(id));
      ocf.forEach((e, i) => {
        if (sums[i] != null) return;
        const p = `${e.start}|${e.end}`;
        let sum = 0;
        for (const [c, w] of lines.wc) {
          // 계산 구조엔 있으나 이 공시 원본에 값이 하나도 없는 줄 = 이번 공시 표에 싣지 않은 줄 → 0(ORCL 2027 회계연도 1분기 10-Q
          // IncreaseDecreaseInContractWithCustomerLiability — 운전자본 합계를 못 만들어 매출채권 한 줄 −1,009 가 운전자본 칸에 올랐다)
          if (!fsx.some((x) => x.id === c)) continue;
          const all = fsx.filter((x) => x.id === c && x.period === p);
          // 차원 없는 값 → 그 값. 없으면 차원 값: 하나뿐이면 그 값, 여럿이면 모두 한 축의 서로 다른 멤버 하나씩일 때만 합(DAL: 본표 "Air traffic liability"·
          // "Loyalty program deferred revenue" 두 줄이 같은 개념 ContractWithCustomerLiability 의 멤버 둘 — 하나만 받던 규칙이라 운전자본 합을 못 만들고 하위 줄
          // 일부(2025 1,274, 본표 합 1,536)가 운전자본 칸에 올랐다)
          const plain = all.find((x) => x.dims.length === 0);
          const oneAxis = all.length > 1 && all.every((x) => x.dims.length === 1 && x.dims[0][0] === all[0].dims[0][0]) && new Set(all.map((x) => x.dims[0][1])).size === all.length;
          const v = plain ? plain.val : all.length === 1 ? all[0].val : oneAxis ? all.reduce((t, x) => t + x.val, 0) : null;
          if (v == null) return; // 줄 하나라도 그 기간 값이 없으면 합계를 만들지 않는다(부분 합 금지)
          sum += w * v;
        }
        sums[i] = sum;
      });
    }
    // 부호는 IncreaseDecreaseInOperatingCapital 과 같이 증가 = 유출
    ocf.forEach((e, i) => { if (sums[i] != null) synth.push({ ...e, val: -(sums[i] as number) }); else wcMiss.push(e.end); });
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
  const invAny = [...invFace.values()].some((x) => x.length);
  if (!synth.length && !zeros.length && !sbc.length && !capexParts.length && !invAny && !dimOnly.length && !niRead) return facts;
  const ng: Record<string, unknown> = { ...g };
  if (synth.length) ng[SYN_WC_CF] = { label: "운전자본 변동(본표 줄 합)", units: { USD: synth } };
  if (niRead) ng[SYN_NI_CF] = { label: "현금흐름표 본표 순이익", units: { USD: niFace } };
  {
    const byPer = new Map<string, typeof ncCand>();
    for (const c of ncCand) byPer.set(c.per, [...(byPer.get(c.per) ?? []), c]);
    for (const cs of byPer.values()) {
      const pick = cs.sort((x, y) => (x.filed < y.filed ? 1 : -1)).find((c) => !c.calcGap);
      if (pick?.val != null) ncFace.push({ ...pick.e, val: pick.val });
    }
  }
  if (wcRead) ng[SYN_OTHER_NC_CF] = { label: "현금흐름표 본표 기타 비현금 조정(가중치 합)", units: { USD: ncFace } };
  if (sbc.length) ng[SYN_SBC_CF] = { label: "주식보상비용(본표 회사 고유 줄)", units: { USD: sbc } };
  for (const [k, v] of invFace) if (v.length) ng[k] = { label: "투자자산 본표 줄 합(회사 고유 줄 포함)", units: { USD: v } };
  if (capexParts.length) ng[SYN_CAPEX_PARTS] = { label: "설비투자(항공기 + 기타 유형자산 줄 합)", units: { USD: capexParts } };
  for (const [c, e] of zeros) {
    const cur = (ng[c] ?? { units: {} }) as { label?: string; units: Record<string, FactUnitEntry[]> };
    ng[c] = { ...cur, units: { ...cur.units, USD: [...(cur.units.USD ?? []), e] } };
  }
  return { ...facts, ...(dimOnly.length ? { cfDimOnly: dimOnly } : {}), ...(niRead ? { niFace: true } : {}), ...(wcRead ? { wcFace: true } : {}), ...(wcMiss.length ? { cfWcMiss: [...new Set(wcMiss)] } : {}), ...(niCons.length ? { niConsolidated: niCons } : {}), facts: { ...facts.facts, "us-gaap": ng as never } };
}
