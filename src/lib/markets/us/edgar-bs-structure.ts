import "server-only";
import { fetchJson, fetchText } from "../http";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { RecentFilings } from "./edgar-gapfill";
import { fxToUsd } from "./edgar-foreign";

/**
 * **총차입금 = 대차대조표 본표의 차입금 줄**(10-K·10-Q 계산 구조 `_cal.xml`) — 태그 우선순위로 고르던 방식이
 * 주석 태그를 본표 줄과 섞어 이중 합산·누락을 냈다(검증 2026-09-24, SEC 본표·Yahoo·StockAnalysis 3곳 대조):
 * - AMAT·IBM: 본표 "단기차입금"(`ShortTermBorrowings`)이 이미 유동성 장기부채를 포함하는데 주석의
 *   `LongTermDebtCurrent` 를 또 더했다(AMAT +11.99억, IBM +57.72억).
 * - TSLA: 본표가 회사 고유 태그(`tsla_LongTermDebtAndFinanceLeasesCurrent/Noncurrent`)라 표준 태그 `LongTermDebt`
 *   (비유동분만)를 합계로 읽어 유동분 13.40억이 빠졌다.
 *
 * 규칙: ① 부채 트리에서 차입금 줄(개념명, 회사 고유 개념은 라벨)을 모두 더한다. ② 본표에 유동 차입금 줄이 없으면
 * (GOOG·AMZN — 유동성 장기부채를 "미지급비용 및 기타" 안에 둔다) 주석의 유동 차입금을 더한다. ③ 본표에 리스
 * 줄이 없으면 주석의 금융리스를 더한다(운용리스는 차입금 아님 — CLAUDE.md "미국 EV·EBITDA·차입금 단일 기준").
 * 운용·금융리스 합산 줄(VRT)은 운용리스가 대부분이라 빼고 주석 금융리스로 대신한다.
 *
 * 값: 그 공시의 인스턴스(회사 고유 개념·companyfacts 반영 전 분기 — CAT) → 없으면 companyfacts. 기간마다 그
 * 날짜를 담은 가장 최근 공시의 구조를 쓰고, 10-Q 에 대차대조표 계산 구조가 없으면(ORCL) 직전 공시의 줄 목록을
 * 쓴다. 공시로 덮이지 않는 옛 날짜는 edgar-ev.ts `resolveDebt` 의 태그 규칙 그대로.
 *
 * 차원으로만 공시된 줄(CAT — 본표가 ME·FP 부문 열만 있고 연결 합계 태그 없음)은 그 공시의 대차대조표 정의 구조
 * (`_def.xml`)에 나오는 축·멤버만 골라 **한 축의 멤버 합**을 줄 값으로 쓴다(합계·상위 멤버 제외, 같은 멤버 중복 제외 —
 * 부문 주석의 `FinancialProductsSegmentMember` 같은 중복 멤버는 본표 정의에 없어 빠진다). 2025-12-31 CAT = 43,330
 * (SEC 본표 = Yahoo). 축이 여럿인데 합이 다르거나 멤버를 못 고르면 예전처럼 기존 태그 규칙으로 폴백.
 *
 * 운용·금융리스 합산 줄(VRT `vrt:OperatingAndFinanceLeaseLiabilityNoncurrent`)은 차입금에서 빼지만, 비유동 운용리스
 * 태그가 없는 분기(VRT 10-Q)엔 이 줄이 유일한 운용리스 값이라 `SYN_MIXED_LEASE_*` 로 넘긴다 — 값 = 합산 줄 − 이 날짜에
 * 주석 금융리스로 차입금에 이미 더한 분(이중 계산 방지). edgar-ev.ts 가 표준 운용리스 태그가 없을 때만 쓴다.
 */

export const SYN_DEBT_FACE = "DebtFaceDerived";
export const SYN_DEBT_FACE_NONCURRENT = "DebtFaceNoncurrentDerived";
/** 본표 운용·금융리스 합산 줄에서 차입금에 넣은 금융리스분을 뺀 값(운용리스 몫) — 비유동·유동 */
export const SYN_MIXED_LEASE_NONCURRENT = "OperatingLeaseNoncurrentMixedFaceDerived";
export const SYN_MIXED_LEASE_CURRENT = "OperatingLeaseCurrentMixedFaceDerived";

const UA = process.env.SEC_USER_AGENT ?? "global-market-research (personal use) contact@example.com";
const H = { "user-agent": UA, "accept-encoding": "gzip, deflate" };

// FinancingObligation: 매각후재임차 등 금융거래로 회계처리한 조달(BE `be_FinancingObligationNoncurrent/Current` —
// 본표 줄 144,446k + 62,034k 가 빠져 StockAnalysis = 앱 + 206,480k 였다, 2026-09-25). 공급자금융(supplier finance)은
// 매입채무 성격이라 제외. AMZN 의 financing obligations 는 본표 줄이 아니라(주석) 여기 걸리지 않는다
const DEBT_CONCEPT = /Debt|Borrowing|NotesPayable|NotesAndLoans|CommercialPaper|FinanceLease|CapitalLease|LoansPayable|SeniorNotes|ConvertibleNotes|LineOfCredit|FinancingObligation/;
const NOT_DEBT = /OperatingLease|Interest|DeferredTax|Securities|Receivable|Issuance|Discount|Premium|Asset|Guarantee|Supplier/;
const DEBT_LABEL = /\b(debt|borrowings?|notes payable|commercial paper|finance leases?|capital leases?|loans? payable|senior notes|convertible notes|credit facilit|financing obligations?)/i;
const NOT_DEBT_LABEL = /operating lease|interest|guarantee|supplier/i;
// IFRS(20-F — TSM·SPOT): 리스부채는 운용·금융 구분이 없고 리스비용이 EBITDA 밖이라 차입금에 넣는다(한국 IFRS 와 같은 규칙,
// CLAUDE.md "외화·IFRS 공시"). 본표에 없는 유동 리스부채(TSM·SPOT 은 "미지급비용 및 기타유동부채" 안)는 주석 값으로 더한다
// (withBalanceSheetDebt 의 IFRS 분기 — 미국 규칙 ② 본표 밖 유동 차입금과 같은 취지)
const IFRS_DEBT_CONCEPT = /Borrowings|BondsIssued|LeaseLiabilities|Debentures|CommercialPaper|NotesPayable|LoansPayable/;
const IFRS_NOT_DEBT = /Interest|Derivative|FairValue|Warrant/;
const IFRS_NOTE_LEASE = ["ifrs-full_CurrentLeaseLiabilities", "ifrs-full_NoncurrentLeaseLiabilities"];
const IFRS_LEASE_TO_GAAP: Record<string, string> = {
  "ifrs-full_CurrentLeaseLiabilities": "FinanceLeaseLiabilityCurrent",
  "ifrs-full_NoncurrentLeaseLiabilities": "FinanceLeaseLiabilityNoncurrent",
};
/** 주석 유동 차입금 — 본표에 유동 줄이 없을 때. DebtCurrent 는 단기차입금·CP 포함 상위 개념이라 단독 */
const NOTE_CURRENT_TOTAL = ["DebtCurrent", "LongTermDebtAndCapitalLeaseObligationsCurrent"];
const NOTE_CURRENT_PARTS = ["LongTermDebtCurrent", "ShortTermBorrowings", "CommercialPaper", "OtherShortTermBorrowings"];
const NOTE_FIN_LEASE_PARTS = ["FinanceLeaseLiabilityCurrent", "FinanceLeaseLiabilityNoncurrent"];

interface Filing { accn: string; form: string; filed: string; doc: string; report: string }
interface Face { lines: string[]; current: Set<string>; hasCurrent: boolean; hasLease: boolean; mixed: string[]; mixedCurrent: Set<string>; ifrs: boolean }

// 계산 구조에 유동부채 소계가 없는 본표(비분류형)에서만 쓰는 이름 판정. "IncludingCurrentMaturities" 는 유동분을 포함한
// 장기 줄이지 유동 줄이 아니다(CVX — 이름 판정으로 장기차입금 39,781 이 0 이 됐다, 재감사 HIGH)
const isCurrentName = (id: string) => /Current|ShortTerm|CommercialPaper/.test(id) && !/Noncurrent|IncludingCurrent/.test(id);

function locs(x: string): Map<string, string> {
  const loc = new Map<string, string>();
  for (const l of x.matchAll(/<(?:link:)?loc\b([^>]*)\/?>/g)) {
    const id = /xlink:label="([^"]+)"/.exec(l[1])?.[1];
    const href = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1];
    if (id && href) loc.set(id, href);
  }
  return loc;
}

/** 표시 라벨(정의문 제외) */
function labels(lab: string): Map<string, string> {
  const loc = locs(lab);
  const text = new Map<string, string>();
  for (const m of lab.matchAll(/<(?:link:)?label\b([^>]*)>([^<]*)<\/(?:link:)?label>/g)) {
    const id = /xlink:label="([^"]+)"/.exec(m[1])?.[1];
    if (!id || /xlink:role="[^"]*documentation"/i.test(m[1])) continue;
    text.set(id, (text.get(id) ?? "") + " | " + m[2]);
  }
  const out = new Map<string, string>();
  for (const a of lab.matchAll(/<(?:link:)?labelArc\b([^>]*)\/?>/g)) {
    const from = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? "");
    const t = text.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
    if (from && t) out.set(from, (out.get(from) ?? "") + t);
  }
  return out;
}

/** 대차대조표 계산 구조의 차입금 줄. 대차대조표 역할이 없으면 null */
export function faceDebtLines(cal: string, lab: Map<string, string>): Face | null {
  for (const m of cal.matchAll(/<(?:link:)?calculationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/(?:link:)?calculationLink>/g)) {
    const role = m[1].split("/").pop() ?? "";
    if (!/BALANCE|FINANCIALPOSITION|FINANCIALCONDITION/i.test(role) || /Detail|Table|Parenth/i.test(role)) continue;
    const loc = locs(m[2]);
    const arcs: { from: string; to: string }[] = [];
    for (const a of m[2].matchAll(/<(?:link:)?calculationArc\b([^>]*)\/?>/g)) {
      const from = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? "");
      const to = loc.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
      if (from && to) arcs.push({ from, to });
    }
    // IFRS 20-F(TSM·SPOT)는 ifrs-full 소계(Liabilities·CurrentLiabilities·NoncurrentLiabilities·EquityAndLiabilities)
    const ifrs = arcs.some((a) => /^ifrs-full_(Current|Noncurrent)?Liabilities$/.test(a.from));
    if (!ifrs && !arcs.some((a) => /^us-gaap_Liabilities(Current|Noncurrent)?$/.test(a.from))) continue;
    const CUR = ifrs ? "ifrs-full_CurrentLiabilities" : "us-gaap_LiabilitiesCurrent";
    const lines: string[] = [];
    const underCurrent = new Set<string>();
    const mixed: string[] = [];
    const seen = new Set<string>();
    const walk = (id: string, depth: number, cur: boolean) => {
      if (depth > 5) return;
      for (const a of arcs.filter((x) => x.from === id)) {
        if (seen.has(a.to)) continue;
        seen.add(a.to);
        if (cur) underCurrent.add(a.to);
        const concept = a.to.slice(a.to.indexOf("_") + 1);
        if (/Equity|Stockholders/.test(concept) && !/Liabilit/.test(concept)) continue;
        const lb = lab.get(a.to) ?? "";
        const std = a.to.startsWith("us-gaap_") || a.to.startsWith("ifrs-full_");
        const text = std ? concept : lb || concept;
        // 운용·금융리스 합산 줄 — 차입금에서 빼고 주석 금융리스로 대신
        if (/OperatingAndFinanceLease|operating and finance lease/i.test(text)) { mixed.push(a.to); continue; }
        const debt = a.to.startsWith("ifrs-full_")
          ? IFRS_DEBT_CONCEPT.test(concept) && !IFRS_NOT_DEBT.test(concept)
          : std
            ? DEBT_CONCEPT.test(concept) && !NOT_DEBT.test(concept)
            : (DEBT_LABEL.test(lb) && !NOT_DEBT_LABEL.test(lb)) ||
              (ifrs && /\blease liabilit/i.test(lb) && !NOT_DEBT_LABEL.test(lb)) ||
              (!lb && DEBT_CONCEPT.test(concept) && !NOT_DEBT.test(concept));
        if (debt) lines.push(a.to);
        else walk(a.to, depth + 1, cur || a.to === CUR);
      }
    };
    const roots = ifrs
      ? ["ifrs-full_EquityAndLiabilities", "ifrs-full_Liabilities", "ifrs-full_CurrentLiabilities", "ifrs-full_NoncurrentLiabilities"]
      : ["us-gaap_LiabilitiesAndStockholdersEquity", "us-gaap_Liabilities", "us-gaap_LiabilitiesCurrent", "us-gaap_LiabilitiesNoncurrent"];
    for (const root of roots) walk(root, 0, root === CUR);
    // 유동 여부 = 계산 구조상 유동부채 소계 아래인가. 소계가 없는 본표만 이름으로
    const classified = arcs.some((a) => a.from === CUR);
    const current = new Set(lines.filter((l) => (classified ? underCurrent.has(l) : isCurrentName(l))));
    return {
      lines,
      current,
      // 유동분을 포함한 장기 줄이 있으면 유동 만기분도 본표에 있는 것 — 주석 유동분을 더하면 이중 합산
      hasCurrent: current.size > 0 || lines.some((l) => /IncludingCurrent/.test(l)),
      hasLease: !mixed.length && lines.some((l) => /Lease/i.test(l) || /lease/i.test(lab.get(l) ?? "")),
      mixed,
      mixedCurrent: new Set(mixed.filter((l) => (classified ? underCurrent.has(l) : isCurrentName(l)))),
      ifrs,
    };
  }
  return null;
}

interface DimValue { axis: string; member: string; val: number }
type InstantValues = Map<string, Map<string, number>> & { dimOnly?: Set<string>; dimVals?: Map<string, DimValue[]> };

/** 인스턴스의 차원 없는 시점 값: 개념 id(ns_Concept) → 날짜 → 값. 차원으로만 있는 "id|날짜" 는 dimOnly,
 *  그 날짜의 단일 명시 멤버 값은 dimVals("id|날짜" → 축·멤버·값) */
function instantValues(xml: string, ids: Set<string>, cur = "USD"): InstantValues {
  // 공시 통화 단위만(외화 공시는 원통화 — 20-F 의 USD 편의 환산 값은 단일 환율이라 쓰지 않는다, edgar-foreign.ts)
  const units = new Set<string>();
  const measure = new RegExp(`iso4217:${cur}\\s*<`, "i");
  for (const u of xml.matchAll(/<(?:xbrli:)?unit\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?unit>/g))
    if (!/divide/i.test(u[2]) && measure.test(u[2])) units.add(u[1]);
  const ctx = new Map<string, { d: string; dim: boolean; one: { axis: string; member: string } | null }>();
  for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
    const inst = /<(?:xbrli:)?instant>\s*([^<\s]+)/.exec(m[2])?.[1];
    if (!inst) continue;
    const dims = [...m[2].matchAll(/<(?:xbrldi:)?(explicit|typed)Member\b[^>]*dimension="([^"]+)"[^>]*>\s*([^<\s]*)/g)];
    // 멤버 하나짜리 명시 차원만 합산 후보 — 교차 차원·typed 차원은 합으로 못 쓴다
    const one = dims.length === 1 && dims[0][1] === "explicit" && dims[0][3]
      ? { axis: dims[0][2].replace(":", "_"), member: dims[0][3].replace(":", "_") }
      : null;
    ctx.set(m[1], { d: inst, dim: /dimension="/.test(m[2]), one });
  }
  const out: InstantValues = new Map();
  const dimmed = new Set<string>();
  const dimVals = new Map<string, DimValue[]>();
  for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*)>\s*(-?[\d.]+)\s*<\/\1:\2>/g)) {
    const id = `${m[1]}_${m[2]}`;
    if (!ids.has(id)) continue;
    const c = ctx.get(/contextRef="([^"]+)"/.exec(m[3])?.[1] ?? "");
    if (!c || !units.has(/unitRef="([^"]+)"/.exec(m[3])?.[1] ?? "")) continue;
    if (c.dim) {
      const k = `${id}|${c.d}`;
      dimmed.add(k);
      if (c.one) {
        const arr = dimVals.get(k) ?? [];
        // 같은 멤버가 두 번(다른 문맥 id) 나오면 한 번만
        if (!arr.some((x) => x.axis === c.one!.axis && x.member === c.one!.member)) arr.push({ ...c.one, val: Number(m[4]) });
        dimVals.set(k, arr);
      }
      continue;
    }
    const d = c.d;
    const byDate = out.get(id) ?? new Map<string, number>();
    if (!byDate.has(d)) byDate.set(d, Number(m[4]));
    out.set(id, byDate);
  }
  out.dimOnly = new Set([...dimmed].filter((k) => { const [id, d] = k.split("|"); return !out.get(id)?.has(d); }));
  out.dimVals = dimVals;
  return out;
}

/**
 * 대차대조표 정의 구조(`_def.xml`, 없으면 .xsd 내장)에 나오는 축 → 말단 멤버. 상위 멤버(도메인·합계 — 다른 멤버를
 * 거느린 멤버)는 합에 넣으면 이중 합산이라 뺀다. 본표 정의에 없는 멤버(부문 주석 전용 — CAT
 * `FinancialProductsSegmentMember`)도 자연히 빠진다.
 */
export function faceMembers(def: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of def.matchAll(/<(?:link:)?definitionLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/(?:link:)?definitionLink>/g)) {
    const role = m[1].split("/").pop() ?? "";
    if (!/BALANCE|FINANCIALPOSITION|FINANCIALCONDITION/i.test(role) || /Detail|Table|Parenth/i.test(role)) continue;
    const loc = locs(m[2]);
    const arcs: { role: string; from: string; to: string }[] = [];
    for (const a of m[2].matchAll(/<(?:link:)?definitionArc\b([^>]*)\/?>/g)) {
      const from = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? "");
      const to = loc.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
      const r = /xlink:arcrole="[^"]*\/([^"/]+)"/.exec(a[1])?.[1] ?? "";
      if (from && to) arcs.push({ role: r, from, to });
    }
    const parents = new Set(arcs.filter((a) => a.role === "domain-member").map((a) => a.from));
    for (const dd of arcs.filter((a) => a.role === "dimension-domain")) {
      const leaves = out.get(dd.from) ?? new Set<string>();
      const walk = (id: string, depth: number) => {
        if (depth > 5) return;
        if (!parents.has(id)) { if (id !== dd.to) leaves.add(id); return; }
        for (const a of arcs) if (a.role === "domain-member" && a.from === id) walk(a.to, depth + 1);
      };
      walk(dd.to, 0);
      if (leaves.size) out.set(dd.from, leaves);
    }
  }
  return out;
}

/**
 * 차원으로만 공시된 줄 값 = 본표 정의 축 하나의 말단 멤버 합. 축이 여럿이면 합이 모두 같을 때만. 못 정하면 undefined.
 * 연결 합계를 나누는 열(부문)이어야 하므로 — 그 날짜 본표 차입금 줄 전체에서 멤버가 2개 이상 보이는 축만 쓰고,
 * VIE 괄호 공시 축(ConsolidatedEntitiesAxis — 합계의 일부일 뿐)은 뺀다.
 */
function memberSum(vals: DimValue[] | undefined, members: Map<string, Set<string>>, partition: Set<string>): number | undefined {
  if (!vals?.length) return undefined;
  const sums = new Map<string, number>();
  for (const x of vals)
    if (partition.has(x.axis) && members.get(x.axis)?.has(x.member)) sums.set(x.axis, (sums.get(x.axis) ?? 0) + x.val);
  const s = [...sums.values()];
  if (!s.length || s.some((x) => Math.abs(x - s[0]) > Math.max(1, Math.abs(s[0]) * 0.001))) return undefined;
  return s[0];
}

/** 계산 구조·라벨(작다)만 받고, 인스턴스(수 MB — Next 데이터 캐시 2MB 한도를 넘어 매번 새로 받는다)는 필요할 때만 */
async function filingFiles(cik: number, f: Filing): Promise<{ cal: string; lab: string; instUrl: string; defUrl: string | null } | null> {
  const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${f.accn.replace(/-/g, "")}`;
  const idx = await fetchJson<{ directory: { item: { name: string }[] } }>(`${base}/index.json`, { headers: H, revalidate: 60 * 60 * 24 });
  const names = idx.directory.item.map((i) => i.name);
  // 계산 구조·라벨을 스키마(.xsd) 안에 넣어 제출하는 회사(MSFT·ORCL 2026~)는 .xsd 에서 읽는다
  const xsd = names.find((n) => /\.xsd$/i.test(n));
  const cal = names.find((n) => /_cal\.xml$/i.test(n)) ?? xsd;
  const lab = names.find((n) => /_lab\.xml$/i.test(n)) ?? xsd;
  const def = names.find((n) => /_def\.xml$/i.test(n)) ?? xsd;
  const inst = names.find((n) => /_htm\.xml$/i.test(n));
  if (!lab || !inst) return null;
  const opt = { headers: H, revalidate: 60 * 60 * 24, timeoutMs: 30_000 };
  const [c, l] = await Promise.all([cal ? fetchText(`${base}/${cal}`, opt) : Promise.resolve(""), fetchText(`${base}/${lab}`, opt)]);
  return { cal: c, lab: l, instUrl: `${base}/${inst}`, defUrl: def ? `${base}/${def}` : null };
}

export async function withBalanceSheetDebt(cik: string, facts: CompanyFacts, recent: RecentFilings | null): Promise<CompanyFacts> {
  if (!recent) return facts;
  const g = facts.facts["us-gaap"] ?? {};
  // 최신 10-Q(최신 10-K 보다 새로울 때) + 최근 10-K 5건 — 화면 연도 열 5개와 LTM 을 덮는다. 외국 발행사는 20-F·40-F 가
  // 연차 보고서(ASML·TSM·SPOT — 예전엔 10-K 만 봐서 본표 판정이 통째로 빠지고 태그 규칙으로 폴백했다, 2026-09-25)
  const filings: Filing[] = [];
  let k10 = 0;
  for (let i = 0; i < recent.form.length && k10 < 5; i++) {
    const form = recent.form[i];
    if (/^(10-K|20-F|40-F)$/.test(form)) k10++;
    else if (!(form === "10-Q" && k10 === 0 && !filings.some((x) => x.form === "10-Q"))) continue;
    filings.push({ accn: recent.accessionNumber[i], form, filed: recent.filingDate[i], doc: recent.primaryDocument[i], report: recent.reportDate?.[i] ?? "" });
  }
  if (!filings.length) return facts;
  // 외화 공시(edgar-foreign.ts 정규화 후) — 인스턴스는 원통화로 읽어 기말 환율로 환산(companyfacts 쪽과 같은 규칙)
  const cur = facts.reportingCurrency ?? "USD";
  const fx = cur !== "USD" ? await fxToUsd(cur) : null;

  const cfVal = (concept: string, d: string): number | undefined => {
    let best: FactUnitEntry | undefined;
    for (const e of g[concept]?.units?.USD ?? [])
      if (!e.start && e.end === d && (!best || (e.filed ?? "") > (best.filed ?? ""))) best = e;
    return best?.val;
  };

  const total: FactUnitEntry[] = [];
  const noncurrent: FactUnitEntry[] = [];
  const mixedNc: FactUnitEntry[] = [];
  const mixedCur: FactUnitEntry[] = [];
  const done = new Set<string>();
  const parsed: { f: Filing; face: Face | null; instUrl: string; defUrl: string | null }[] = [];
  for (const f of filings) {
    // 조회 실패는 올린다(로더가 총차입금을 공란 + 사유로 — sec-unavailable.ts). null = 라벨·인스턴스 파일이 원래 없음
    const fl = await filingFiles(Number(cik), f);
    if (!fl) return facts; // 하나라도 없으면 전체 미적용 — 기간마다 방식이 섞이지 않게
    parsed.push({ f, face: fl.cal ? faceDebtLines(fl.cal, labels(fl.lab)) : null, instUrl: fl.instUrl, defUrl: fl.defUrl });
  }
  const noteIds = [
    ...[...NOTE_CURRENT_TOTAL, ...NOTE_CURRENT_PARTS, "FinanceLeaseLiability", ...NOTE_FIN_LEASE_PARTS].map((c) => `us-gaap_${c}`),
    ...IFRS_NOTE_LEASE,
  ];
  for (let k = 0; k < parsed.length; k++) {
    const p = parsed[k];
    // 10-Q 에 대차대조표 계산 구조가 없으면(ORCL) 직전 공시의 줄 목록을 쓴다
    const face = p.face ?? parsed.slice(k + 1).find((q) => q.face)?.face ?? null;
    if (!face || !face.lines.length) continue;
    // 이 공시의 대차대조표 날짜 — companyfacts 에서 같은 날 제출된 부채 총계(당기말·전기말)
    const cfDates = new Set<string>();
    for (const c of ["Liabilities", "LiabilitiesAndStockholdersEquity"])
      for (const e of g[c]?.units?.USD ?? []) if (!e.start && e.filed === p.f.filed) cfDates.add(e.end);
    const faceIds = [...face.lines, ...face.mixed];
    const allUsGaap = faceIds.every((l) => l.startsWith("us-gaap_"));
    const cfComplete = !fx && allUsGaap && cfDates.size > 0 && [...cfDates].every((d) => faceIds.every((l) => cfVal(l.slice(8), d) !== undefined));
    // 회사 고유 줄·companyfacts 미반영 공시·빈 줄이 있으면 인스턴스에서 읽는다
    let inst: InstantValues | null = null;
    if (!cfComplete) {
      const xml = await fetchText(p.instUrl, { headers: H, revalidate: false, timeoutMs: 30_000 });
      inst = instantValues(xml, new Set([...faceIds, ...noteIds]), cur);
    }
    const dates = new Set<string>(cfDates);
    if (inst)
      for (const l of face.lines) {
        for (const d of inst.get(l)?.keys() ?? []) dates.add(d);
        for (const k of inst.dimOnly ?? []) if (k.startsWith(`${l}|`)) dates.add(k.slice(l.length + 1));
      }
    // 본표 정의 구조의 축·멤버 — 차원으로만 공시된 줄이 있을 때만 받는다
    let members: Map<string, Set<string>> | null = null;
    for (const d of dates) {
      if (done.has(d)) continue;
      // 본표 줄이 부문 차원으로만 공시된 날짜(CAT — 연결 합계 태그 없음) — 본표 정의 축의 멤버 합을 줄 값으로
      const dimOnlyLines = inst ? face.lines.filter((l) => inst.dimOnly?.has(`${l}|${d}`)) : [];
      const fromMembers = new Map<string, number>();
      if (dimOnlyLines.length) {
        if (!members) {
          const def = p.defUrl ? await fetchText(p.defUrl, { headers: H, revalidate: 60 * 60 * 24, timeoutMs: 30_000 }) : null;
          members = def ? faceMembers(def) : new Map();
        }
        const seenMembers = new Map<string, Set<string>>();
        for (const l of dimOnlyLines)
          for (const x of inst!.dimVals?.get(`${l}|${d}`) ?? [])
            if (members.get(x.axis)?.has(x.member)) seenMembers.set(x.axis, (seenMembers.get(x.axis) ?? new Set()).add(x.member));
        const partition = new Set([...seenMembers].filter(([ax, ms]) => ms.size >= 2 && !/ConsolidatedEntitiesAxis/.test(ax)).map(([ax]) => ax));
        for (const l of dimOnlyLines) {
          const x = memberSum(inst!.dimVals?.get(`${l}|${d}`), members, partition);
          if (x !== undefined) fromMembers.set(l, x);
        }
        // 한 줄이라도 못 정하면 합이 모자라므로 기존 규칙으로 둔다
        if (fromMembers.size < dimOnlyLines.length) continue;
      }
      const rate = fx ? fx.at(d) : 1;
      if (rate == null) continue; // 환율 없는 날짜는 원통화를 USD 로 섞지 않는다
      const v = (id: string): number | undefined => {
        const m = fromMembers.get(id);
        if (m !== undefined) return m * rate;
        const x = inst?.get(id)?.get(d);
        if (x !== undefined) return x * rate;
        if (id.startsWith("us-gaap_")) return cfVal(id.slice(8), d);
        // IFRS 리스 주석값이 이 공시 인스턴스에 없는 날짜(전기말 — SPOT 은 당기말만 주석 공시)는 그 해 공시에서 온
        // companyfacts 값(edgar-foreign.ts 가 금융리스 개념으로 매핑·USD 환산한 것)
        const mapped = IFRS_LEASE_TO_GAAP[id];
        return mapped ? cfVal(mapped, d) : undefined;
      };
      if (!face.lines.some((l) => v(l) !== undefined)) continue;
      let sum = 0;
      let nc = 0;
      // 줄 값이 비면 0(본표의 "—")
      for (const l of face.lines) {
        const x = v(l) ?? 0;
        sum += x;
        if (!face.current.has(l)) nc += x;
      }
      if (face.ifrs) {
        // IFRS 리스부채는 전부 차입금(CLAUDE.md "외화·IFRS 공시" — 한국 규칙과 같음). 본표에 유동·비유동 리스 줄 중 한쪽만 있으면 없는 쪽은
        // 주석 값으로 더한다 — 유동 리스부채를 "미지급비용 및 기타유동부채" 안에 두는 발행사(TSM·SPOT)도 같은 범위가 되게
        // (미국 규칙 ②·③ — 본표에 없는 유동 차입금·금융리스를 주석으로 더하는 것과 같은 취지). us-gaap 주석 규칙은 쓰지 않는다
        // (IFRS→us-gaap 매핑 개념이 본표 줄과 같은 값이라 이중 합산)
        const hasCurL = face.lines.some((l) => /(^|_)CurrentLeaseLiabilities$/.test(l));
        const hasNcL = face.lines.some((l) => /NoncurrentLeaseLiabilities$/.test(l));
        // 본표에 리스 줄이 **하나도 없으면** 더하지 않는다 — 리스부채를 차입금 줄 안에 넣어 표시하는 발행사가 있다(NVO:
        // 본표 "장기차입금" 118,941 = 차입금 111,705 + 비유동 리스 7,236 백만 DKK, 주석 Borrowings 130,958 = 본표 합).
        // 이때 주석 리스를 더하면 이중 합산(검증 2026-09-25, 139,530 vs 본표·Yahoo 130,958). 한쪽만 있으면 나머지 쪽만 더한다
        if (hasCurL || hasNcL) {
          const cl = v("ifrs-full_CurrentLeaseLiabilities"), ncl = v("ifrs-full_NoncurrentLeaseLiabilities");
          if (!hasCurL) sum += cl ?? 0;
          if (!hasNcL) { sum += ncl ?? 0; nc += ncl ?? 0; }
        }
      } else if (!face.hasCurrent) {
        const t = NOTE_CURRENT_TOTAL.map((c) => v(`us-gaap_${c}`)).find((x) => x !== undefined);
        sum += t ?? NOTE_CURRENT_PARTS.reduce((s, c) => s + (v(`us-gaap_${c}`) ?? 0), 0);
      }
      // 주석 금융리스로 차입금에 더한 몫(비유동·유동) — 운용·금융 합산 줄에서 운용리스 몫을 가를 때 뺀다
      let finNcAdded = 0;
      let finCurAdded = 0;
      if (!face.hasLease && !face.ifrs) {
        const t = v("us-gaap_FinanceLeaseLiability");
        const cur = v("us-gaap_FinanceLeaseLiabilityCurrent") ?? 0;
        const ncl = v("us-gaap_FinanceLeaseLiabilityNoncurrent") ?? 0;
        sum += t ?? cur + ncl;
        finNcAdded = t !== undefined ? t - cur : ncl;
        finCurAdded = cur;
        nc += finNcAdded;
      }
      done.add(d);
      const base = { end: d, fy: 0, fp: "", form: p.f.form, filed: p.f.filed };
      total.push({ ...base, val: sum });
      noncurrent.push({ ...base, val: nc });
      // 운용·금융 합산 줄의 운용리스 몫(VRT) — 음수면 합산 줄 해석이 틀린 것이라 내지 않는다
      const mixedPart = (ids: string[], fin: number, out: FactUnitEntry[]) => {
        const xs = ids.map(v).filter((x): x is number => x !== undefined);
        if (xs.length && xs.reduce((s, x) => s + x, 0) - fin >= 0) out.push({ ...base, val: xs.reduce((s, x) => s + x, 0) - fin });
      };
      mixedPart(face.mixed.filter((l) => !face.mixedCurrent.has(l)), finNcAdded, mixedNc);
      mixedPart(face.mixed.filter((l) => face.mixedCurrent.has(l)), finCurAdded, mixedCur);
    }
  }
  if (!total.length) return facts;
  return {
    ...facts,
    facts: {
      ...facts.facts,
      "us-gaap": {
        ...g,
        [SYN_DEBT_FACE]: { units: { USD: total } },
        [SYN_DEBT_FACE_NONCURRENT]: { units: { USD: noncurrent } },
        ...(mixedNc.length ? { [SYN_MIXED_LEASE_NONCURRENT]: { units: { USD: mixedNc } } } : {}),
        ...(mixedCur.length ? { [SYN_MIXED_LEASE_CURRENT]: { units: { USD: mixedCur } } } : {}),
      },
    },
  } as CompanyFacts;
}
