import "server-only";
import { fetchJson, fetchText } from "../http";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { RecentFilings } from "./edgar-gapfill";
import { filingsForDa, instanceFacts } from "./edgar-cf-structure";
import { CF_INV_FAMILIES, cfInvStdConcepts, cfZeroFillGroups } from "./edgar-cashflow";

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
/**
 * **차입금 줄 = 본표 차입 줄을 성격대로 모두 합한 값**(오너 결정 2026-10-10 — StockAnalysis·야후와 같은 구조: 단기·장기 조달 / 단기·장기 상환 / 단기 순증감).
 * 공시마다 현금흐름표 계산 구조의 재무활동 아래 말단 줄을 개념 이름으로 나눈다 — 조달(Proceeds…)·상환(Repayments…·PaymentsFor Repurchase/
 * Extinguishment of debt)·순증감(ProceedsFromRepayments… 등 순액 줄), 단기(ShortTerm·기업어음·신용한도·리볼빙·만기 3개월 이하) / 장기(그 밖).
 * 회사 고유 줄도 이름으로 같은 규칙. 리스는 제외(부채와 리스를 한 줄로 공시한 "DebtAndCapitalLeaseObligations" 류만 차입으로 — 나눌 수 없음).
 * 값 = us-gaap 개념은 companyfacts 의 그 공시 값, 회사 고유 개념은 공시 원본. 본표 줄인데 그 기간 값이 없으면 0("—"). 말단 줄만 더해 순액·총액 이중 합산
 * 없음. 장기 순액 줄은 어느 줄에도 넣지 않는다(기타 재무활동). 그 성격 줄이 본표에 없으면 그 공시엔 값이 없다(빈칸 원칙) — 10-Q 는 기존 0 채움 규칙과 같이
 * 본표에 없고 다른 공시에도 그 기간 0 아닌 값이 없을 때만 0
 */
export const DEBT_SYN = {
  issS: "DebtIssuedShortFaceDerived",
  issL: "DebtIssuedLongFaceDerived",
  repS: "DebtRepaidShortFaceDerived",
  repL: "DebtRepaidLongFaceDerived",
  netS: "DebtNetShortFaceDerived",
} as const;
type DebtCat = keyof typeof DEBT_SYN;
/** 조달·상환 합계(단기 + 장기) — 공시마다 그 방향 줄이 하나라도 있으면. 단기·장기 분류가 공시마다 달라도(AMD 같은 줄을 10-K 는 단기, 10-Q 는 장기 개념)
 *  합계는 같은 정의라 LTM·분기 합계는 이것으로 낸다 */
export const DEBT_TOTAL_SYN = { iss: "DebtIssuedTotalFaceDerived", rep: "DebtRepaidTotalFaceDerived" } as const;
const DIR: Record<"iss" | "rep", [DebtCat, DebtCat]> = { iss: ["issS", "issL"], rep: ["repS", "repL"] };
// Financing — 회사 고유 "단기 금융"(ORCL orcl_ProceedsFromRepaymentsOfShort-TermFinancingRelatedToCapitalExpendituresNet). 재무활동 기타·비용은 제외
const DEBT_WORD = /(Debt|Borrowing|Notes(?!Receivable)|CommercialPaper|LinesOfCredit|LineOfCredit|Loans?(?!Receivable)|CreditFacilit|Revolv|Bonds|Debentures|Financing(?!Activit|Cost|Receivable|Fee))/;
const DEBT_EXCL = /(Receivable|Stock|Equity|Warrant|Preferred|Investment|IssuanceCost|ExtinguishmentCost|Costs?$|Fees?$|Premium|Derivative|Swap|Hedge|Collateral|Dividend|Interest|Guarantee|Escrow|Restricted|Contingent)/;
const DEBT_SHORT = /(Short-?Term|CommercialPaper|LinesOfCredit|LineOfCredit|Revolv|ThreeMonthsOrLess|Overdraft|Overnight)/;
const DEBT_NET = /^(ProceedsFromRepayments|ProceedsFromPaymentsFor|RepaymentsOfProceeds|ProceedsFrom\w*AndRepayments|NetIncreaseDecrease|IncreaseDecreaseIn|NetProceeds\w*Repayments)/;
const DEBT_ISS = /^(Proceeds|Issuance|Borrowings?)/;
const DEBT_REP = /^(Repayments?|PaymentsFor(RepurchaseOf|Repayment|Extinguishment|Retirement|Redemption)|PaymentsOf(?!.*Cost)|Retirement|Redemption)/;
/** 개념(접두어_이름) → 차입 줄 성격(아니면 null) */
export function debtCat(id: string): DebtCat | null {
  const n = id.replace(/^[^_]+_/, "");
  if (!DEBT_WORD.test(n) || DEBT_EXCL.test(n)) return null;
  // 리스 — 부채와 한 줄로 묶인 경우만 차입(나눌 수 없음)
  if (/Lease/.test(n) && !/Debt\w*Lease/.test(n)) return null;
  const short = DEBT_SHORT.test(n);
  if (DEBT_NET.test(n)) return /LongTerm/.test(n) ? null : "netS";
  if (DEBT_ISS.test(n) && !/Repay/.test(n)) return short ? "issS" : "issL";
  if (DEBT_REP.test(n)) return short ? "repS" : "repL";
  return null;
}
/** 현금흐름표 계산 구조에서 재무활동 합계 아래 말단 줄(없으면 null) */
function financingLeaves(cal: string): Set<string> | null {
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
    const kids = new Map<string, string[]>();
    for (const a of m[2].matchAll(/<(?:link:)?calculationArc\b([^>]*)\/?>/g)) {
      const from = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? "");
      const to = loc.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
      if (from && to) kids.set(from, [...(kids.get(from) ?? []), to]);
    }
    const root = [...kids.keys()].find((k) => /^us-gaap_NetCashProvidedByUsedInFinancingActivities(ContinuingOperations)?$/.test(k));
    if (!root) continue;
    const out = new Set<string>();
    const walk = (k: string, d: number) => {
      if (d > 4) return;
      for (const c of kids.get(k) ?? []) { if (kids.has(c)) walk(c, d + 1); else out.add(c); }
    };
    walk(root, 0);
    return out;
  }
  return null;
}
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
  const invFace = new Map<string, FactUnitEntry[]>(CF_INV_FAMILIES.map((f) => [f.derived, []]));
  const debtVals = new Map<DebtCat, FactUnitEntry[]>((Object.keys(DEBT_SYN) as DebtCat[]).map((k) => [k, []]));
  /** 10-Q 본표에 그 성격 줄이 없는 공시 — 다른 공시에 그 기간 0 아닌 값이 없으면 0(아래) */
  const debtAbsentQ: { cat: DebtCat; ocf: FactUnitEntry[]; accn: string }[] = [];
  const debtTot = new Map<"iss" | "rep", FactUnitEntry[]>([["iss", []], ["rep", []]]);
  /** 공시별 차입 성격 집합(단기·장기 분류가 공시마다 바뀌었는지 판정 — 아래) */
  const debtCats: { accn: string; form: string; filed: string; cats: Set<DebtCat>; periods: Set<string> }[] = [];
  let debtFace = false;
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
    // 투자자산 처분·취득 — 본표에 회사 고유 줄이 섞이면 같은 성격 본표 줄 전부(표준 + 회사 고유) 합. 본표 줄인데 그 기간 값이 없으면 0("—")
    if (faceS) {
      const local = (id: string) => id.replace(/^[^_]+_/, "");
      const fams = CF_INV_FAMILIES.map((fm) => {
        const std = new Set(cfInvStdConcepts(fm.label));
        const ids = [...faceS].filter((id) => (id.startsWith("us-gaap_") ? std.has(local(id)) : fm.custom.test(local(id))));
        return { fm, ids, custom: ids.filter((id) => !id.startsWith("us-gaap_")) };
      }).filter((x) => x.custom.length);
      const inst = fams.length ? names.find((n) => /_htm\.xml$/i.test(n)) : null;
      if (inst) {
        const want = new Set(fams.flatMap((x) => x.ids));
        const fsx = instanceFacts(await fetchText(`${base}/${inst}`, { headers: H, revalidate: false, timeoutMs: 30_000 }), (id) => want.has(id));
        for (const { fm, ids, custom } of fams)
          for (const e of ocf) {
            const at = (id: string) => fsx.find((x) => x.id === id && x.period === `${e.start}|${e.end}` && x.dims.length === 0);
            if (!custom.some(at)) continue;
            invFace.get(fm.derived)!.push({ ...e, val: ids.reduce((t, id) => t + (at(id)?.val ?? 0), 0) });
          }
      }
    }
    // 차입금 줄 — 재무활동 말단 줄을 성격대로 합(위 DEBT_SYN)
    const finLeaves = /^10-[KQ]/.test(f.form) ? financingLeaves(calXml) : null;
    if (finLeaves) {
      debtFace = true;
      const byCat = new Map<DebtCat, string[]>();
      for (const id of finLeaves) { const c = debtCat(id); if (c) byCat.set(c, [...(byCat.get(c) ?? []), id]); }
      const custom = [...byCat.values()].flat().filter((id) => !id.startsWith("us-gaap_"));
      let fsx: ReturnType<typeof instanceFacts> | null = null;
      if (custom.length) {
        const inst = names.find((n) => /_htm\.xml$/i.test(n));
        if (!inst) throw new Error(`차입 줄 회사 고유 개념 원본 없음 ${f.accn}`);
        fsx = instanceFacts(await fetchText(`${base}/${inst}`, { headers: H, revalidate: false, timeoutMs: 30_000 }), (id) => custom.includes(id));
      }
      const valOfId = (id: string, e: FactUnitEntry): number | null => {
        if (id.startsWith("us-gaap_")) return (g[id.slice(8)]?.units?.USD ?? []).find((x) => x.start === e.start && x.end === e.end && x.filed === f.filed && x.form === f.form)?.val ?? null;
        return fsx!.find((x) => x.id === id && x.period === `${e.start}|${e.end}` && x.dims.length === 0)?.val ?? null;
      };
      debtCats.push({ accn: f.accn, form: f.form, filed: f.filed, cats: new Set(byCat.keys()), periods: new Set(ocf.map((e) => `${e.start}|${e.end}`)) });
      for (const cat of Object.keys(DEBT_SYN) as DebtCat[]) {
        const ids = byCat.get(cat);
        if (!ids) { if (/^10-Q/.test(f.form)) debtAbsentQ.push({ cat, ocf, accn: f.accn }); continue; }
        for (const e of ocf) debtVals.get(cat)!.push({ ...e, val: ids.reduce((t, id) => t + (valOfId(id, e) ?? 0), 0) });
      }
      for (const d of ["iss", "rep"] as const) {
        const ids = DIR[d].flatMap((c) => byCat.get(c) ?? []);
        if (ids.length) for (const e of ocf) debtTot.get(d)!.push({ ...e, val: ids.reduce((t, id) => t + (valOfId(id, e) ?? 0), 0) });
        else if (/^10-Q/.test(f.form)) debtAbsentQ.push({ cat: d === "iss" ? "issS" : "repS", ocf: [], accn: f.accn }); // 자리 표시 — 합계 0 채움은 아래
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
  const invAny = [...invFace.values()].some((x) => x.length);
  // 단기·장기 분류가 바뀐 10-Q(직전 10-K 에 없던 성격이 생기고, 10-K 에 있던 같은 방향 성격이 빠짐 — AMD 같은 줄을 10-K 는 ProceedsFromShortTermDebt,
  // 10-Q 는 ProceedsFromIssuanceOfLongTermDebt) — 그 10-Q 의 단기·장기 값은 버린다(사업연도와 섞으면 LTM·분기 값이 틀린다). 합계는 위 debtTot 로 그대로
  const swapped = new Set<string>();
  for (const q of debtCats.filter((x) => /^10-Q/.test(x.form))) {
    const k = debtCats.filter((x) => /^10-K/.test(x.form) && x.filed < q.filed).sort((a, b) => b.filed.localeCompare(a.filed))[0];
    if (!k) continue;
    for (const d of ["iss", "rep"] as const) {
      const [a, b] = DIR[d];
      const sw = (q.cats.has(a) && !k.cats.has(a) && k.cats.has(b) && !q.cats.has(b)) || (q.cats.has(b) && !k.cats.has(b) && k.cats.has(a) && !q.cats.has(a));
      if (sw) for (const c of DIR[d]) swapped.add(`${q.accn}|${c}`);
    }
  }
  for (const [cat, vs] of debtVals) {
    const keep = vs.filter((x) => ![...debtCats].some((d) => d.filed === x.filed && swapped.has(`${d.accn}|${cat}`)));
    debtVals.set(cat, keep);
  }
  // 10-Q 에서 빠진 차입 성격 = 0 — 그 공시의 어느 기간이든 다른 공시에 0 아닌 값이 있으면 채우지 않는다(줄이 다른 성격으로 옮겨 간 것일 수 있음). 분류가 바뀐 공시는 채우지 않는다
  for (const { cat, ocf, accn } of debtAbsentQ) {
    if (!ocf.length || swapped.has(`${accn}|${cat}`)) continue;
    const vs = debtVals.get(cat)!;
    if (ocf.some((e) => vs.some((x) => x.start === e.start && x.end === e.end && x.val !== 0))) continue;
    for (const e of ocf) if (!vs.some((x) => x.start === e.start && x.end === e.end && x.filed === e.filed)) vs.push({ ...e, val: 0 });
  }
  // 한 기간의 차입 값은 그 기간을 실은 가장 최근 공시 하나에서만(나중 공시 우선을 표 단위로 — CL 2022: 2023 10-K 의 단기 조달 540 이 2024 10-K 에서
  // 순증감 줄로 바뀌었는데, 성격마다 따로 최신 공시를 고르면 단기 조달 540 과 순증감 540 이 둘 다 남았다). 최근 공시에 없는 성격은 그 기간 빈칸
  const latestOf = new Map<string, string>();
  for (const d of debtCats) for (const p of d.periods) if (!latestOf.has(p) || d.filed > latestOf.get(p)!) latestOf.set(p, d.filed);
  const fromLatest = (x: FactUnitEntry) => latestOf.get(`${x.start}|${x.end}`) === x.filed;
  for (const [k, vs] of debtVals) debtVals.set(k, vs.filter(fromLatest));
  // 합계 — 10-Q 에 그 방향 줄이 하나도 없으면 같은 규칙으로 0
  for (const d of ["iss", "rep"] as const) {
    const vs = debtTot.get(d)!;
    for (const { cat, accn } of debtAbsentQ) {
      if (cat !== (d === "iss" ? "issS" : "repS")) continue;
      const q = debtAbsentQ.find((x) => x.accn === accn && x.ocf.length);
      const ocf = q?.ocf ?? [];
      if (!ocf.length || vs.some((x) => ocf.some((e) => x.filed === e.filed))) continue;
      if (ocf.some((e) => vs.some((x) => x.start === e.start && x.end === e.end && x.val !== 0))) continue;
      for (const e of ocf) vs.push({ ...e, val: 0 });
    }
  }
  const debtAny = [...debtVals.values(), ...debtTot.values()].some((x) => x.length);
  if (!synth.length && !zeros.length && !sbc.length && !capexParts.length && !invAny && !debtAny && !debtFace) return facts;
  const ng: Record<string, unknown> = { ...g };
  if (synth.length) ng[SYN_WC_CF] = { label: "운전자본 변동(본표 줄 합)", units: { USD: synth } };
  if (sbc.length) ng[SYN_SBC_CF] = { label: "주식보상비용(본표 회사 고유 줄)", units: { USD: sbc } };
  for (const [k, v] of invFace) if (v.length) ng[k] = { label: "투자자산 본표 줄 합(회사 고유 줄 포함)", units: { USD: v } };
  for (const [k, vs] of debtTot) debtTot.set(k, vs.filter(fromLatest));
  for (const [k, v] of debtVals) if (v.length) ng[DEBT_SYN[k]] = { label: `차입금 본표 줄 합(${k})`, units: { USD: v } };
  for (const [k, v] of debtTot) if (v.length) ng[DEBT_TOTAL_SYN[k]] = { label: `차입금 본표 줄 합(${k} 합계)`, units: { USD: v } };
  if (capexParts.length) ng[SYN_CAPEX_PARTS] = { label: "설비투자(항공기 + 기타 유형자산 줄 합)", units: { USD: capexParts } };
  for (const [c, e] of zeros) {
    const cur = (ng[c] ?? { units: {} }) as { label?: string; units: Record<string, FactUnitEntry[]> };
    ng[c] = { ...cur, units: { ...cur.units, USD: [...(cur.units.USD ?? []), e] } };
  }
  return { ...facts, ...(debtFace ? { debtFace: true } : {}), facts: { ...facts.facts, "us-gaap": ng as never } };
}
