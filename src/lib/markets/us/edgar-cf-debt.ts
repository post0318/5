import "server-only";
import { fetchJson, fetchText } from "../http";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { RecentFilings } from "./edgar-gapfill";
import { filingsForDa, instanceFacts } from "./edgar-cf-structure";

/**
 * **현금흐름표 차입금 줄 = 본표 차입 줄을 성격대로 모두 합한 값**(오너 결정 2026-10-10 — StockAnalysis·야후와 같은 구조: 단기·장기 조달 / 단기·장기 상환 /
 * 단기 순증감, 조달·상환 합계).
 *
 * - 공시(10-K·10-Q)마다 현금흐름표 계산 구조의 재무활동 합계 아래 **말단 줄**만 본다 — 소계와 그 하위 줄을 함께 더하지 않는다(순액·총액 이중 합산 없음).
 * - 성격은 개념 이름으로: 조달(Proceeds…·Issuance…·Borrowings…), 상환(Repayments…·PaymentsOn…·PaymentsOf…·PrincipalPayments…·PaymentsFor
 *   Repurchase/Extinguishment/Retirement/Redemption…), 순증감(ProceedsFromRepayments… 등 순액 줄 — **단기 표시가 있는 것만**, 기간 구분 없는·장기 순액은
 *   어느 줄에도 넣지 않는다 = 기타 재무활동). 단기 = ShortTerm·기업어음·신용한도·리볼빙·만기 3개월 이하·당좌차월, 그 밖 = 장기. 회사 고유 줄도 같은 규칙.
 *   제외: 리스(부채와 한 줄인 "Debt…Lease" 만 차입), 지분·이자·배당·파생·보증, 비용 지급 줄(PaymentsOf…Costs — 조달 줄 이름의 "NetOf…Costs" 는 조달 그대로,
 *   GOOG ProceedsFromDebtNetOfIssuanceCosts).
 * - 금액 = 줄 값 × 계산 구조 가중치(재무활동 합계까지의 곱) — 조달·순증감은 그대로, 상환은 부호를 뒤집어 양수(유출액). 회사 고유 줄의 부호 관례가 거꾸로여도 맞는다.
 * - 단기·장기는 라벨이 한쪽만 밝히면 라벨(「long-term debt」·「commercial paper」 등), 섞이거나 없으면 개념 이름.
 * - 순액 판정은 표시 라벨도 본다 — 개념 이름이 조달·상환이어도 라벨이 ", net"·"(repayments)"·"net increase (decrease)" 면 순액(ORCL
 *   orcl_ProceedsFromShort-TermFinancingRelatedToCapitalExpendituresNet 「…, net」). 조달 줄의 "net of issuance costs" 는 순액 아님.
 * - 값: us-gaap 개념은 companyfacts 의 그 공시 값, 없거나 회사 고유 개념이면 공시 원본(정밀한 값). 원본을 읽었는데 그 줄 사실이 없으면 본표 "—" = 0(오너 규칙 —
 *   모든 기간이 "—" 인 줄 포함). 원본 파일이 없거나 못 읽으면 판독 실패로 그 성격을 그 공시에서 비운다(사유, 0 으로 바꾸지 않음).
 * - 한 기간 = 그 기간을 실은 가장 최근 공시 하나(나중 공시 우선을 표 단위로 — CL 2022 중복 방지). 가장 최근 공시가 판독 실패면 그 기간 빈칸 + 사유
 *   (예전 표준 개념 목록으로 바꿔 채우지 않는다 — 잔여 줄 "기타 재무활동"도 그 칸 빈칸, edgar-cashflow.ts).
 * - 10-Q 와 직전 10-K 의 줄 구성이 다르면(분류 교체) 섞인 값이 나오므로 비운다:
 *   · 같은 방향(조달·상환)에서 10-K 에 없던 성격이 10-Q 에 생기고 다른 성격이 빠짐(AMD 같은 줄을 10-K 는 단기, 10-Q 는 장기 개념) → 그 방향의 단기·장기
 *   · 10-K 의 성격이 10-Q 에서 빠졌는데 다른 공시에 그 기간 0 아닌 값이 있어 0 으로 볼 수 없음(일부만 옮겨 감) → 그 방향의 단기·장기
 *   · 순증감 ↔ 총액이 바뀜(MSFT 같은 줄을 10-K 는 순액, 10-Q 는 상환 개념) → 순증감 + 그 방향의 단기·장기·합계
 *   합계는 단기·장기만 바뀐 경우엔 같은 정의라 그대로 쓴다.
 * - 10-Q 에서 빠진 성격(위 경우가 아님) = 0 — 다른 공시에 그 기간 0 아닌 값이 없을 때만(기존 0 채움 규칙과 같은 조건).
 */
export const DEBT_SYN = {
  issS: "DebtIssuedShortFaceDerived",
  issL: "DebtIssuedLongFaceDerived",
  repS: "DebtRepaidShortFaceDerived",
  repL: "DebtRepaidLongFaceDerived",
  netS: "DebtNetShortFaceDerived",
} as const;
export type DebtCat = keyof typeof DEBT_SYN;
export const DEBT_TOTAL_SYN = { iss: "DebtIssuedTotalFaceDerived", rep: "DebtRepaidTotalFaceDerived" } as const;
type Dir = keyof typeof DEBT_TOTAL_SYN;
const DIR: Record<Dir, [DebtCat, DebtCat]> = { iss: ["issS", "issL"], rep: ["repS", "repL"] };
const CATS = Object.keys(DEBT_SYN) as DebtCat[];
const dirOf = (c: DebtCat): Dir | null => (c === "issS" || c === "issL" ? "iss" : c === "repS" || c === "repL" ? "rep" : null);
/** 차입 줄 칸이 빈 사유(edgar-cashflow.ts 칸 주석) — 개념 → 결산일 → 사유 */
export type DebtBlank = { concept: string; end: string; reason: string };
export const DEBT_UNREAD = "본표 차입 줄 판독 불가(공시 원본 값 없음)";
export const DEBT_MIXED = "본표 차입 줄 분류가 직전 10-K 와 달라 사업연도와 섞을 수 없음";

const DEBT_WORD = /(Debt|Borrowing|Notes(?!Receivable)|CommercialPaper|LinesOfCredit|LineOfCredit|Loans?(?!Receivable)|CreditFacilit|Revolv|Bonds|Debentures|Overdraft|Financing(?!Activit|Cost|Receivable|Fee))/;
const DEBT_EXCL = /(Receivable|Stock|Equity|Warrant|Preferred|Investment|Premium|Derivative|Swap|Hedge|Dividend|Interest|Guarantee|Escrow|Restricted|Contingent)/;
/** 비용 지급 줄(차입 조달·상환 비용) — 조달 줄 이름 끝의 "NetOf…Costs" 는 해당 없음 */
const COST_PAY = /^Payments?(Of|For)?\w*(Cost|Fee)s?$/;
const DEBT_SHORT = /(Short-?Term|CommercialPaper|LinesOfCredit|LineOfCredit|Revolv|ThreeMonthsOrLess|Overdraft|Overnight)/;
const DEBT_NET = /^(ProceedsFromRepayments|ProceedsFromPaymentsFor|RepaymentsOfProceeds|ProceedsFrom\w*AndRepayments|NetIncreaseDecrease|IncreaseDecreaseIn|NetProceeds\w*Repayments)/;
const DEBT_ISS = /^(Proceeds|Issuance|Borrowings?)/;
const DEBT_REP = /^(Repayments?|PaymentsFor(RepurchaseOf|Repayment|Extinguishment|Retirement|Redemption)|PaymentsOn|PaymentsOf|PrincipalPayments|Retirement|Redemption)/;
/** 표시 라벨이 순액 줄인가(조달 줄의 "net of … costs" 는 제외) */
const NET_LABEL = /,\s*net\s*$|\(repayments?( of)?\)|\(payments?\)|\bnet (increase|decrease|change|borrowings?|repayments?|proceeds|issuances?)\b|increase \(decrease\)|decrease \(increase\)/i;
export function isNetLabel(label: string | null | undefined): boolean {
  return !!label && NET_LABEL.test(label.replace(/net of [a-z ,-]*(costs?|discounts?|fees?|premiums?)/gi, ""));
}
/** 단기·장기 — 라벨이 한쪽만 밝히면 라벨(회사가 본표에 쓴 말), 섞이거나 없으면 개념 이름. AMD 같은 금액을 10-K 는 ProceedsFromShortTermDebt 개념에
 *  「Proceeds from long-term debt issuance」 라벨로 실었다 — 라벨이 정한다 */
const SHORT_LABEL = /(short-term|short term|commercial paper|revolv|lines? of credit|credit facilit|overdraft|overnight|90 days or less|three months or less)/i;
const LONG_LABEL = /(long-term|long term|\bsenior\b|\bnotes\b|\bbonds?\b|debentures?|term loans?|convertible)/i;
function shortByLabel(label: string | null | undefined): boolean | null {
  if (!label) return null;
  const s = SHORT_LABEL.test(label), l = LONG_LABEL.test(label.replace(/short-term notes/gi, ""));
  return s && !l ? true : l && !s ? false : null;
}

/** 개념(접두어_이름) → 차입 줄 성격(아니면 null) */
export function debtCat(id: string, label?: string | null): DebtCat | null {
  const n = id.replace(/^[^_]+_/, "");
  if (!DEBT_WORD.test(n) || DEBT_EXCL.test(n) || COST_PAY.test(n)) return null;
  if (/Lease/.test(n) && !/Debt\w*Lease/.test(n)) return null;
  const short = shortByLabel(label) ?? DEBT_SHORT.test(n);
  if (DEBT_NET.test(n) || isNetLabel(label)) return short ? "netS" : null;
  if (DEBT_ISS.test(n) && !/Repay/.test(n)) return short ? "issS" : "issL";
  if (DEBT_REP.test(n)) return short ? "repS" : "repL";
  return null;
}

/** 현금흐름표 계산 구조의 재무활동 합계 아래 말단 줄 → 합계까지의 가중치 곱. 재무활동 합계를 못 찾으면 null */
function financingLeaves(cal: string): Map<string, number> | null {
  for (const m of cal.matchAll(/<(?:[\w-]+:)?calculationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?calculationLink>/g)) {
    const role = m[1].split("/").pop() ?? "";
    if (!/CASHFLOW/i.test(role.replace(/[^A-Za-z]/g, "")) || /Detail|Table|Parenth|Supplement/i.test(role)) continue;
    const loc = new Map<string, string>();
    for (const l of m[2].matchAll(/<(?:[\w-]+:)?loc\b([^>]*)\/?>/g)) {
      const id = /xlink:label="([^"]+)"/.exec(l[1])?.[1];
      const href = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1];
      if (id && href) loc.set(id, href);
    }
    const kids = new Map<string, [string, number][]>();
    for (const a of m[2].matchAll(/<(?:[\w-]+:)?calculationArc\b([^>]*)\/?>/g)) {
      const from = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? "");
      const to = loc.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
      const w = Number(/weight="([^"]+)"/.exec(a[1])?.[1] ?? "1");
      if (from && to) kids.set(from, [...(kids.get(from) ?? []), [to, w]]);
    }
    const root = [...kids.keys()].find((k) => /^us-gaap_NetCashProvidedByUsedInFinancingActivities(ContinuingOperations)?$/.test(k));
    if (!root) continue;
    const out = new Map<string, number>();
    const walk = (k: string, wk: number, d: number) => {
      if (d > 5) return;
      for (const [c, w] of kids.get(k) ?? []) {
        if (kids.has(c)) walk(c, wk * w, d + 1);
        else out.set(c, wk * w);
      }
    };
    walk(root, 1, 0);
    return out;
  }
  return null;
}

/** 라벨 파일 → 개념 → 표시 라벨(terseLabel → label) */
function labelsOf(lab: string): Map<string, string> {
  const loc = new Map<string, string>(), text = new Map<string, [string, string][]>(), out = new Map<string, string>();
  for (const l of lab.matchAll(/<(?:[\w-]+:)?loc\b([^>]*)\/?>/g)) {
    const id = /xlink:label="([^"]+)"/.exec(l[1])?.[1], h = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1];
    if (id && h) loc.set(id, h);
  }
  for (const m of lab.matchAll(/<(?:[\w-]+:)?label\b([^>]*)>([^<]*)<\/(?:[\w-]+:)?label>/g)) {
    const id = /xlink:label="([^"]+)"/.exec(m[1])?.[1], role = /xlink:role="[^"]*\/(\w+)"/.exec(m[1])?.[1] ?? "";
    if (id && !/documentation/i.test(role)) text.set(id, [...(text.get(id) ?? []), [role, m[2].trim()]]);
  }
  const all = new Map<string, [string, string][]>();
  for (const a of lab.matchAll(/<(?:[\w-]+:)?labelArc\b([^>]*)\/?>/g)) {
    const f = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? ""), t = text.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
    if (f && t) all.set(f, [...(all.get(f) ?? []), ...t]);
  }
  for (const [c, ls] of all) { const v = (ls.find(([r]) => /^terseLabel$/i.test(r)) ?? ls.find(([r]) => /^label$/i.test(r)) ?? ls[0])?.[1]; if (v) out.set(c, v); }
  return out;
}

const UA = process.env.SEC_USER_AGENT ?? "global-market-research (personal use) contact@example.com";
const H = { "user-agent": UA, "accept-encoding": "gzip, deflate" };
const FIN_TOTAL = ["NetCashProvidedByUsedInFinancingActivities", "NetCashProvidedByUsedInFinancingActivitiesContinuingOperations"];

interface FilingDebt {
  accn: string;
  form: string;
  filed: string;
  /** 재무활동 합계가 실린 기간 */
  periods: FactUnitEntry[];
  /** 본표 판독 실패(계산 구조 없음) — 이 공시의 모든 차입 칸 판독 불가 */
  unread: boolean;
  /** 본표에 있는 성격(판독 실패 성격 포함) */
  cats: Set<DebtCat>;
  /** 줄 값을 못 읽은 성격 */
  catUnread: Set<DebtCat>;
  /** 성격 → "시작|종료" → 값(양수 = 조달·상환액, 순증감은 부호 그대로) */
  vals: Map<DebtCat, Map<string, number>>;
}

export async function withCashFlowDebt(cik: string, facts: CompanyFacts, recent: RecentFilings | null): Promise<CompanyFacts> {
  if (!recent) return facts;
  const filings = filingsForDa(recent).filter((f) => /^10-[KQ]/.test(f.form));
  if (!filings.length) return facts;
  const g = facts.facts["us-gaap"] ?? {};
  const opt = { headers: H, revalidate: 60 * 60 * 24, timeoutMs: 30_000 };
  const read: FilingDebt[] = [];
  for (const f of filings) {
    const periods = FIN_TOTAL.flatMap((c) => g[c]?.units?.USD ?? []).filter((e) => e.start && e.filed === f.filed && e.form === f.form)
      .filter((e, i, a) => a.findIndex((x) => x.start === e.start && x.end === e.end) === i);
    if (!periods.length) continue;
    const fd: FilingDebt = { accn: f.accn, form: f.form, filed: f.filed, periods, unread: false, cats: new Set(), catUnread: new Set(), vals: new Map() };
    read.push(fd);
    const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${f.accn.replace(/-/g, "")}`;
    const names = (await fetchJson<{ directory: { item: { name: string }[] } }>(`${base}/index.json`, opt)).directory.item.map((i) => i.name);
    const cal = names.find((n) => /_cal\.xml$/i.test(n)) ?? names.find((n) => /\.xsd$/i.test(n));
    const leaves = cal ? financingLeaves(await fetchText(`${base}/${cal}`, opt)) : null;
    if (!leaves) { fd.unread = true; continue; }
    // 표시 라벨(순액 판정용) — 라벨 파일(_lab.xml, 없으면 .xsd 내장)
    const labF = names.find((n) => /_lab\.xml$/i.test(n)) ?? names.find((n) => /\.xsd$/i.test(n));
    const labels = labF ? labelsOf(await fetchText(`${base}/${labF}`, opt)) : new Map<string, string>();
    const lines = [...leaves].map(([id, w]) => ({ id, w, cat: debtCat(id, labels.get(id)) })).filter((x): x is { id: string; w: number; cat: DebtCat } => !!x.cat);
    for (const l of lines) fd.cats.add(l.cat);
    // 값 — companyfacts(us-gaap, 그 공시) → 없으면 공시 원본(정밀한 값). 원본이 없으면 그 줄은 판독 실패
    const fromCf = (id: string, p: FactUnitEntry) => (id.startsWith("us-gaap_") ? (g[id.slice(8)]?.units?.USD ?? []).find((x) => x.start === p.start && x.end === p.end && x.filed === f.filed && x.form === f.form)?.val ?? null : null);
    const needInst = lines.filter((l) => periods.every((p) => fromCf(l.id, p) == null));
    let inst: ReturnType<typeof instanceFacts> | null = null;
    if (needInst.length) {
      const instName = names.find((n) => /_htm\.xml$/i.test(n));
      if (instName) {
        const want = new Set(needInst.map((l) => l.id));
        inst = instanceFacts(await fetchText(`${base}/${instName}`, { headers: H, revalidate: false, timeoutMs: 30_000 }), (id) => want.has(id));
      }
    }
    const instRead = inst != null;
    const valOf = (id: string, p: FactUnitEntry): number | null =>
      fromCf(id, p) ?? inst?.find((x) => x.id === id && x.period === `${p.start}|${p.end}` && x.dims.length === 0)?.val ?? null;
    for (const l of lines) {
      const vs = periods.map((p) => valOf(l.id, p));
      // 모든 기간에 값이 없음 — 원본을 읽었으면 그 줄은 전 기간 "—"(= 0), 원본을 못 읽었으면(파일 없음) 판독 실패로 그 성격을 비운다
      if (vs.every((v) => v == null) && !instRead) { fd.catUnread.add(l.cat); continue; }
      const m = fd.vals.get(l.cat) ?? new Map<string, number>();
      periods.forEach((p, i) => {
        const k = `${p.start}|${p.end}`;
        const v = (vs[i] ?? 0) * (dirOf(l.cat) === "rep" ? -l.w : l.w);
        m.set(k, (m.get(k) ?? 0) + v);
      });
      fd.vals.set(l.cat, m);
    }
    for (const c of fd.catUnread) fd.vals.delete(c);
  }
  if (!read.length) return facts;

  // 10-Q 의 비울 성격·합계(분류 교체·옮겨 감) — 직전 10-K 와 비교
  const blankCat = new Map<string, Set<DebtCat>>(); // accn → 성격
  const blankTot = new Map<string, Set<Dir>>(); // accn → 방향
  const add = <T,>(m: Map<string, Set<T>>, k: string, v: T) => m.set(k, (m.get(k) ?? new Set<T>()).add(v));
  /** 그 성격의 그 기간 0 아닌 값이 다른 공시에 있는가 */
  const nonzeroElsewhere = (cat: DebtCat, q: FilingDebt) =>
    q.periods.some((p) => read.some((o) => o !== q && (o.vals.get(cat)?.get(`${p.start}|${p.end}`) ?? 0) !== 0));
  for (const q of read.filter((x) => /^10-Q/.test(x.form) && !x.unread)) {
    const k = read.filter((x) => /^10-K/.test(x.form) && !x.unread && x.filed < q.filed).sort((a, b) => b.filed.localeCompare(a.filed))[0];
    if (!k) continue;
    const appeared = CATS.filter((c) => q.cats.has(c) && !k.cats.has(c));
    const gone = CATS.filter((c) => k.cats.has(c) && !q.cats.has(c));
    const goneHard = gone.filter((c) => nonzeroElsewhere(c, q)); // 0 으로 볼 수 없게 빠짐
    for (const d of ["iss", "rep"] as Dir[]) {
      const ap = appeared.some((c) => dirOf(c) === d), gn = gone.some((c) => dirOf(c) === d), gh = goneHard.some((c) => dirOf(c) === d);
      if ((ap && gn) || gh) for (const c of DIR[d]) add(blankCat, q.accn, c);
    }
    // 순증감 ↔ 총액
    const netMoved = (appeared.includes("netS") && gone.some((c) => c !== "netS")) || (gone.includes("netS") && appeared.some((c) => c !== "netS"));
    if (netMoved) {
      add(blankCat, q.accn, "netS");
      for (const c of [...appeared, ...gone]) {
        const d = dirOf(c);
        if (!d) continue;
        for (const x of DIR[d]) add(blankCat, q.accn, x);
        add(blankTot, q.accn, d);
      }
    }
  }

  // 성격·합계 값 모음(공시별) — 10-Q 에서 빠진 성격은 0(조건부), 비울 성격·판독 실패는 제외
  const out = new Map<string, FactUnitEntry[]>();
  const blanks: DebtBlank[] = [];
  const push = (concept: string, f: FilingDebt, p: FactUnitEntry, val: number) => out.set(concept, [...(out.get(concept) ?? []), { ...p, val }]);
  // 기간 → 그 기간을 실은 가장 최근 공시
  const latestOf = new Map<string, string>();
  for (const f of read) for (const p of f.periods) { const k = `${p.start}|${p.end}`; if (!latestOf.has(k) || f.filed > latestOf.get(k)!) latestOf.set(k, f.filed); }
  const isLatest = (f: FilingDebt, p: FactUnitEntry) => latestOf.get(`${p.start}|${p.end}`) === f.filed;
  const unreadEnds = new Set<string>();
  for (const f of read) {
    const bc = blankCat.get(f.accn) ?? new Set<DebtCat>(), bt = blankTot.get(f.accn) ?? new Set<Dir>();
    for (const p of f.periods) {
      if (!isLatest(f, p)) continue;
      const k = `${p.start}|${p.end}`;
      if (f.unread) {
        unreadEnds.add(p.end);
        for (const c of CATS) blanks.push({ concept: DEBT_SYN[c], end: p.end, reason: DEBT_UNREAD });
        for (const d of ["iss", "rep"] as Dir[]) blanks.push({ concept: DEBT_TOTAL_SYN[d], end: p.end, reason: DEBT_UNREAD });
        continue;
      }
      const catVal = new Map<DebtCat, number | null | "unread" | "mixed">();
      for (const c of CATS) {
        if (f.catUnread.has(c)) { catVal.set(c, "unread"); continue; }
        if (bc.has(c)) { catVal.set(c, "mixed"); continue; }
        const v = f.vals.get(c)?.get(k);
        if (v != null) { catVal.set(c, v); continue; }
        // 본표에 그 성격 없음 — 10-Q 는 다른 공시에 0 아닌 값이 없으면 0, 아니면 빈칸(그 공시엔 없음)
        catVal.set(c, /^10-Q/.test(f.form) && !nonzeroElsewhere(c, f) ? 0 : null);
      }
      for (const c of CATS) {
        const v = catVal.get(c);
        if (v === "unread" || v === "mixed") { blanks.push({ concept: DEBT_SYN[c], end: p.end, reason: v === "unread" ? DEBT_UNREAD : DEBT_MIXED }); if (v === "unread") unreadEnds.add(p.end); continue; }
        if (v != null) push(DEBT_SYN[c], f, p, v);
      }
      // 합계 — 그 방향 성격 중 판독 실패가 있으면 빈칸, 분류 교체(순액↔총액)면 빈칸. 단기·장기만 교체(mixed)면 원래 줄 값의 합(같은 정의)
      for (const d of ["iss", "rep"] as Dir[]) {
        if (bt.has(d)) { blanks.push({ concept: DEBT_TOTAL_SYN[d], end: p.end, reason: DEBT_MIXED }); continue; }
        if (DIR[d].some((c) => catVal.get(c) === "unread")) { blanks.push({ concept: DEBT_TOTAL_SYN[d], end: p.end, reason: DEBT_UNREAD }); continue; }
        const raw = DIR[d].map((c) => (catVal.get(c) === "mixed" ? (f.vals.get(c)?.get(k) ?? (f.cats.has(c) ? 0 : null)) : (catVal.get(c) as number | null)));
        if (raw.every((x) => x == null)) continue;
        push(DEBT_TOTAL_SYN[d], f, p, raw.reduce((t: number, x) => t + (x ?? 0), 0));
      }
    }
  }
  const ng: Record<string, unknown> = { ...g };
  for (const [c, v] of out) ng[c] = { label: "차입금 본표 줄 합(edgar-cf-debt.ts)", units: { USD: v } };
  return {
    ...facts,
    debtFace: true,
    ...(blanks.length ? { debtBlanks: blanks } : {}),
    ...(unreadEnds.size ? { debtUnreadEnds: [...unreadEnds] } : {}),
    facts: { ...facts.facts, "us-gaap": ng as never },
  };
}
