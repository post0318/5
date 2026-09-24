import "server-only";
import { fetchJson, fetchText } from "../http";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { RecentFilings } from "./edgar-gapfill";

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
 * 차원으로만 공시된 값(CAT — 부문별 열만 있고 연결 합계 태그 없음)은 날짜가 잡히지 않아 기존 규칙으로 폴백한다.
 */

export const SYN_DEBT_FACE = "DebtFaceDerived";
export const SYN_DEBT_FACE_NONCURRENT = "DebtFaceNoncurrentDerived";

const UA = process.env.SEC_USER_AGENT ?? "global-market-research (personal use) contact@example.com";
const H = { "user-agent": UA, "accept-encoding": "gzip, deflate" };

const DEBT_CONCEPT = /Debt|Borrowing|NotesPayable|NotesAndLoans|CommercialPaper|FinanceLease|CapitalLease|LoansPayable|SeniorNotes|ConvertibleNotes|LineOfCredit/;
const NOT_DEBT = /OperatingLease|Interest|DeferredTax|Securities|Receivable|Issuance|Discount|Premium|Asset|Guarantee/;
const DEBT_LABEL = /\b(debt|borrowings?|notes payable|commercial paper|finance leases?|capital leases?|loans? payable|senior notes|convertible notes|credit facilit)/i;
const NOT_DEBT_LABEL = /operating lease|interest|guarantee/i;
/** 주석 유동 차입금 — 본표에 유동 줄이 없을 때. DebtCurrent 는 단기차입금·CP 포함 상위 개념이라 단독 */
const NOTE_CURRENT_TOTAL = ["DebtCurrent", "LongTermDebtAndCapitalLeaseObligationsCurrent"];
const NOTE_CURRENT_PARTS = ["LongTermDebtCurrent", "ShortTermBorrowings", "CommercialPaper", "OtherShortTermBorrowings"];
const NOTE_FIN_LEASE_PARTS = ["FinanceLeaseLiabilityCurrent", "FinanceLeaseLiabilityNoncurrent"];

interface Filing { accn: string; form: string; filed: string; doc: string; report: string }
interface Face { lines: string[]; current: Set<string>; hasCurrent: boolean; hasLease: boolean }

// 계산 구조에 유동부채 소계가 없는 본표(비분류형)에서만 쓰는 이름 판정. "IncludingCurrentMaturities" 는 유동분을 포함한
// 장기 줄이지 유동 줄이 아니다(CVX — 이름 판정으로 장기차입금 39,781 이 0 이 됐다, 재감사 HIGH)
const isCurrentName = (id: string) => /Current|ShortTerm|CommercialPaper/.test(id) && !/Noncurrent|IncludingCurrent/.test(id);

function locs(x: string): Map<string, string> {
  const loc = new Map<string, string>();
  for (const l of x.matchAll(/<link:loc\b([^>]*)\/?>/g)) {
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
  for (const m of lab.matchAll(/<link:label\b([^>]*)>([^<]*)<\/link:label>/g)) {
    const id = /xlink:label="([^"]+)"/.exec(m[1])?.[1];
    if (!id || /xlink:role="[^"]*documentation"/i.test(m[1])) continue;
    text.set(id, (text.get(id) ?? "") + " | " + m[2]);
  }
  const out = new Map<string, string>();
  for (const a of lab.matchAll(/<link:labelArc\b([^>]*)\/?>/g)) {
    const from = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? "");
    const t = text.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
    if (from && t) out.set(from, (out.get(from) ?? "") + t);
  }
  return out;
}

/** 대차대조표 계산 구조의 차입금 줄. 대차대조표 역할이 없으면 null */
export function faceDebtLines(cal: string, lab: Map<string, string>): Face | null {
  for (const m of cal.matchAll(/<link:calculationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/link:calculationLink>/g)) {
    const role = m[1].split("/").pop() ?? "";
    if (!/BALANCE|FINANCIALPOSITION|FINANCIALCONDITION/i.test(role) || /Detail|Table|Parenth/i.test(role)) continue;
    const loc = locs(m[2]);
    const arcs: { from: string; to: string }[] = [];
    for (const a of m[2].matchAll(/<link:calculationArc\b([^>]*)\/?>/g)) {
      const from = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? "");
      const to = loc.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
      if (from && to) arcs.push({ from, to });
    }
    if (!arcs.some((a) => /^us-gaap_Liabilities(Current|Noncurrent)?$/.test(a.from))) continue;
    const lines: string[] = [];
    const underCurrent = new Set<string>();
    let mixedLease = false;
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
        const text = a.to.startsWith("us-gaap_") ? concept : lb || concept;
        // 운용·금융리스 합산 줄 — 차입금에서 빼고 주석 금융리스로 대신
        if (/OperatingAndFinanceLease|operating and finance lease/i.test(text)) { mixedLease = true; continue; }
        const debt = a.to.startsWith("us-gaap_")
          ? DEBT_CONCEPT.test(concept) && !NOT_DEBT.test(concept)
          : (DEBT_LABEL.test(lb) && !NOT_DEBT_LABEL.test(lb)) || (!lb && DEBT_CONCEPT.test(concept) && !NOT_DEBT.test(concept));
        if (debt) lines.push(a.to);
        else walk(a.to, depth + 1, cur || a.to === "us-gaap_LiabilitiesCurrent");
      }
    };
    for (const root of ["us-gaap_LiabilitiesAndStockholdersEquity", "us-gaap_Liabilities", "us-gaap_LiabilitiesCurrent", "us-gaap_LiabilitiesNoncurrent"]) walk(root, 0, root === "us-gaap_LiabilitiesCurrent");
    // 유동 여부 = 계산 구조상 유동부채 소계 아래인가. 소계가 없는 본표만 이름으로
    const classified = arcs.some((a) => a.from === "us-gaap_LiabilitiesCurrent");
    const current = new Set(lines.filter((l) => (classified ? underCurrent.has(l) : isCurrentName(l))));
    return {
      lines,
      current,
      // 유동분을 포함한 장기 줄이 있으면 유동 만기분도 본표에 있는 것 — 주석 유동분을 더하면 이중 합산
      hasCurrent: current.size > 0 || lines.some((l) => /IncludingCurrent/.test(l)),
      hasLease: !mixedLease && lines.some((l) => /Lease/i.test(l) || /lease/i.test(lab.get(l) ?? "")),
    };
  }
  return null;
}

type InstantValues = Map<string, Map<string, number>> & { dimOnly?: Set<string> };

/** 인스턴스의 차원 없는 시점 값: 개념 id(ns_Concept) → 날짜 → 값. 차원으로만 있는 "id|날짜" 는 dimOnly */
function instantValues(xml: string, ids: Set<string>): InstantValues {
  const ctx = new Map<string, { d: string; dim: boolean }>();
  for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
    const inst = /<(?:xbrli:)?instant>\s*([^<\s]+)/.exec(m[2])?.[1];
    if (inst) ctx.set(m[1], { d: inst, dim: /dimension="/.test(m[2]) });
  }
  const out: InstantValues = new Map();
  const dimmed = new Set<string>();
  for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*)>\s*(-?[\d.]+)\s*<\/\1:\2>/g)) {
    const id = `${m[1]}_${m[2]}`;
    if (!ids.has(id)) continue;
    const c = ctx.get(/contextRef="([^"]+)"/.exec(m[3])?.[1] ?? "");
    if (!c || !/unitRef="[^"]*usd/i.test(m[3])) continue;
    if (c.dim) { dimmed.add(`${id}|${c.d}`); continue; }
    const d = c.d;
    const byDate = out.get(id) ?? new Map<string, number>();
    if (!byDate.has(d)) byDate.set(d, Number(m[4]));
    out.set(id, byDate);
  }
  out.dimOnly = new Set([...dimmed].filter((k) => { const [id, d] = k.split("|"); return !out.get(id)?.has(d); }));
  return out;
}

/** 계산 구조·라벨(작다)만 받고, 인스턴스(수 MB — Next 데이터 캐시 2MB 한도를 넘어 매번 새로 받는다)는 필요할 때만 */
async function filingFiles(cik: number, f: Filing): Promise<{ cal: string; lab: string; instUrl: string } | null> {
  const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${f.accn.replace(/-/g, "")}`;
  const idx = await fetchJson<{ directory: { item: { name: string }[] } }>(`${base}/index.json`, { headers: H, revalidate: 60 * 60 * 24 });
  const names = idx.directory.item.map((i) => i.name);
  // 계산 구조·라벨을 스키마(.xsd) 안에 넣어 제출하는 회사(MSFT·ORCL 2026~)는 .xsd 에서 읽는다
  const xsd = names.find((n) => /\.xsd$/i.test(n));
  const cal = names.find((n) => /_cal\.xml$/i.test(n)) ?? xsd;
  const lab = names.find((n) => /_lab\.xml$/i.test(n)) ?? xsd;
  const inst = names.find((n) => /_htm\.xml$/i.test(n));
  if (!lab || !inst) return null;
  const opt = { headers: H, revalidate: 60 * 60 * 24, timeoutMs: 30_000 };
  const [c, l] = await Promise.all([cal ? fetchText(`${base}/${cal}`, opt) : Promise.resolve(""), fetchText(`${base}/${lab}`, opt)]);
  return { cal: c, lab: l, instUrl: `${base}/${inst}` };
}

export async function withBalanceSheetDebt(cik: string, facts: CompanyFacts, recent: RecentFilings | null): Promise<CompanyFacts> {
  if (!recent) return facts;
  const g = facts.facts["us-gaap"] ?? {};
  // 최신 10-Q(최신 10-K 보다 새로울 때) + 최근 10-K 5건 — 화면 연도 열 5개와 LTM 을 덮는다
  const filings: Filing[] = [];
  let k10 = 0;
  for (let i = 0; i < recent.form.length && k10 < 5; i++) {
    const form = recent.form[i];
    if (form === "10-K") k10++;
    else if (!(form === "10-Q" && k10 === 0 && !filings.some((x) => x.form === "10-Q"))) continue;
    filings.push({ accn: recent.accessionNumber[i], form, filed: recent.filingDate[i], doc: recent.primaryDocument[i], report: recent.reportDate?.[i] ?? "" });
  }
  if (!filings.length) return facts;

  const cfVal = (concept: string, d: string): number | undefined => {
    let best: FactUnitEntry | undefined;
    for (const e of g[concept]?.units?.USD ?? [])
      if (!e.start && e.end === d && (!best || (e.filed ?? "") > (best.filed ?? ""))) best = e;
    return best?.val;
  };

  const total: FactUnitEntry[] = [];
  const noncurrent: FactUnitEntry[] = [];
  const done = new Set<string>();
  const parsed: { f: Filing; face: Face | null; instUrl: string }[] = [];
  for (const f of filings) {
    const fl = await filingFiles(Number(cik), f).catch(() => null);
    if (!fl) return facts; // 하나라도 못 읽으면 전체 미적용 — 기간마다 방식이 섞이지 않게
    parsed.push({ f, face: fl.cal ? faceDebtLines(fl.cal, labels(fl.lab)) : null, instUrl: fl.instUrl });
  }
  const noteIds = [...NOTE_CURRENT_TOTAL, ...NOTE_CURRENT_PARTS, "FinanceLeaseLiability", ...NOTE_FIN_LEASE_PARTS].map((c) => `us-gaap_${c}`);
  for (let k = 0; k < parsed.length; k++) {
    const p = parsed[k];
    // 10-Q 에 대차대조표 계산 구조가 없으면(ORCL) 직전 공시의 줄 목록을 쓴다
    const face = p.face ?? parsed.slice(k + 1).find((q) => q.face)?.face ?? null;
    if (!face || !face.lines.length) continue;
    // 이 공시의 대차대조표 날짜 — companyfacts 에서 같은 날 제출된 부채 총계(당기말·전기말)
    const cfDates = new Set<string>();
    for (const c of ["Liabilities", "LiabilitiesAndStockholdersEquity"])
      for (const e of g[c]?.units?.USD ?? []) if (!e.start && e.filed === p.f.filed) cfDates.add(e.end);
    const allUsGaap = face.lines.every((l) => l.startsWith("us-gaap_"));
    const cfComplete = allUsGaap && cfDates.size > 0 && [...cfDates].every((d) => face.lines.every((l) => cfVal(l.slice(8), d) !== undefined));
    // 회사 고유 줄·companyfacts 미반영 공시·빈 줄이 있으면 인스턴스에서 읽는다
    let inst: InstantValues | null = null;
    if (!cfComplete) {
      const xml = await fetchText(p.instUrl, { headers: H, revalidate: false, timeoutMs: 30_000 }).catch(() => null);
      if (!xml) return facts;
      inst = instantValues(xml, new Set([...face.lines, ...noteIds]));
    }
    const dates = new Set<string>(cfDates);
    if (inst) for (const l of face.lines) for (const d of inst.get(l)?.keys() ?? []) dates.add(d);
    for (const d of dates) {
      if (done.has(d)) continue;
      // 본표 줄이 부문 차원으로만 공시된 날짜(CAT — 연결 합계 태그 없음)는 합이 모자라므로 기존 규칙으로 둔다
      if (inst && face.lines.some((l) => inst.dimOnly?.has(`${l}|${d}`))) continue;
      const v = (id: string): number | undefined => {
        const x = inst?.get(id)?.get(d);
        if (x !== undefined) return x;
        return id.startsWith("us-gaap_") ? cfVal(id.slice(8), d) : undefined;
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
      if (!face.hasCurrent) {
        const t = NOTE_CURRENT_TOTAL.map((c) => v(`us-gaap_${c}`)).find((x) => x !== undefined);
        sum += t ?? NOTE_CURRENT_PARTS.reduce((s, c) => s + (v(`us-gaap_${c}`) ?? 0), 0);
      }
      if (!face.hasLease) {
        const t = v("us-gaap_FinanceLeaseLiability");
        const cur = v("us-gaap_FinanceLeaseLiabilityCurrent") ?? 0;
        const ncl = v("us-gaap_FinanceLeaseLiabilityNoncurrent") ?? 0;
        sum += t ?? cur + ncl;
        nc += t !== undefined ? t - cur : ncl;
      }
      done.add(d);
      const base = { end: d, fy: 0, fp: "", form: p.f.form, filed: p.f.filed };
      total.push({ ...base, val: sum });
      noncurrent.push({ ...base, val: nc });
    }
  }
  if (!total.length) return facts;
  return {
    ...facts,
    facts: {
      ...facts.facts,
      "us-gaap": { ...g, [SYN_DEBT_FACE]: { units: { USD: total } }, [SYN_DEBT_FACE_NONCURRENT]: { units: { USD: noncurrent } } },
    },
  } as CompanyFacts;
}
