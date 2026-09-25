import "server-only";
import { fetchText } from "../http";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import { instanceUrl } from "./edgar-classfacts";
import type { RecentFilings } from "./edgar-gapfill";

/**
 * **총수익 안의 비영업 수익(지분법 이익·기타수익) 분리** — 영업이익 태그가 없는 회사 전용.
 *
 * XOM 은 손익계산서 첫 줄을 "Total revenues and other income" 하나(`us-gaap:Revenues`)로 태깅하고
 * 그 안을 제품·서비스 차원(`srt:ProductOrServiceAxis`)으로 나눠 매출 및 기타영업수익·**지분법 이익**·
 * **기타수익**을 공시한다. 차원 값이라 SEC companyfacts(차원 없는 값만)에는 없고 10-K·10-Q 원본에만
 * 있다. 이걸 못 읽어서(검증 2026-09-24, 오너 지시 "xom 공시자료부터 전혀 불가능한지 확인해라"):
 *   - 매출이 지분법·기타수익 포함 합계(2024 3,495.85억)로 나와 Yahoo·StockAnalysis·MarketScreener·
 *     인포맥스(모두 3,392.47억 — 매출 및 기타영업수익)보다 3% 컸고
 *   - 영업이익을 세전이익 + 이자로 근사해 EBITDA 가 인포맥스(637.5억)·MarketScreener(635.8억)보다
 *     13~15% 컸다(Yahoo 733.1억만 세전 기준).
 * 원본에서 두 항목을 읽어 비영업 수익 합성 태그로 넣는다 — 영업이익(EBIT 근사)만 edgar-ev.ts 가 사용한다. 매출은 재무 5층
 * 구조(src/lib/fin — metrics/overrides.ts revenue-excl-nonop)가 같은 분리를 따로 하므로 여기서 매출 태그를 만들지 않는다.
 */

export const SYN_NONOP_IN_REVENUES = "NonoperatingIncomeInRevenuesDerived";

/**
 * 비영업 수익 멤버(지분법·기타수익). 기타수익은 멤버 이름 **전체**가 일치할 때만 — 부분일치로는 LLY 의
 * "CollaborationandOtherRevenueMember"(협업·로열티 매출 53억, 본업 매출)가 비영업으로 빠져 매출이 16~18%,
 * 영업이익이 최대 89% 작게 나왔다(검증 2026-09-24). XOM 은 정확히 "OtherRevenueMember".
 */
const NONOP_MEMBER = /EquityAffiliate|EquityMethod|EquityCompan|^(OtherRevenueMember|OtherIncomeMember)$/i;

const UA = process.env.SEC_USER_AGENT ?? "global-market-research (personal use) contact@example.com";
const H = { "user-agent": UA, "accept-encoding": "gzip, deflate" };

interface Filing { accn: string; form: string; filed: string; doc: string }

function parse(xml: string, f: Filing): { nonop: FactUnitEntry[]; total: FactUnitEntry[]; viaDims: boolean; cands: (FactUnitEntry & { concept: string })[] } {
  const ctx = new Map<string, { start?: string; end?: string; dims: [string, string][] }>();
  for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
    const b = m[2];
    const dims = [...b.matchAll(/dimension="([^"]+)"[^>]*>([^<]*)</g)].map((d) => [d[1].split(":").pop() ?? "", d[2].trim().split(":").pop() ?? ""] as [string, string]);
    ctx.set(m[1], { start: /<(?:xbrli:)?startDate>([^<]+)</.exec(b)?.[1]?.trim(), end: /<(?:xbrli:)?endDate>([^<]+)</.exec(b)?.[1]?.trim(), dims });
  }
  const fp = /<dei:DocumentFiscalPeriodFocus\b[^>]*>([^<]+)</.exec(xml)?.[1]?.trim() ?? (/^10-K/.test(f.form) ? "FY" : "");
  const fy = Number(/<dei:DocumentFiscalYearFocus\b[^>]*>([^<]+)</.exec(xml)?.[1]) || 0;
  const nonopBy = new Map<string, FactUnitEntry>();
  const total: FactUnitEntry[] = [];
  for (const m of xml.matchAll(/<us-gaap:Revenues\b([^>]*)>(-?[\d.]+)<\/us-gaap:Revenues>/g)) {
    const c = ctx.get(/contextRef="([^"]+)"/.exec(m[1])?.[1] ?? "");
    if (!c?.start || !c.end || !/unitRef="[^"]*usd/i.test(m[1])) continue;
    const base = { start: c.start, end: c.end, fy, fp, form: f.form, filed: f.filed };
    if (c.dims.length === 0) {
      if (!total.some((e) => e.start === c.start && e.end === c.end)) total.push({ ...base, val: Number(m[2]) });
      continue;
    }
    // 제품·서비스 차원 하나짜리 중 비영업 멤버만 — 같은 기간끼리 합산(지분법 + 기타수익)
    if (c.dims.length !== 1 || c.dims[0][0] !== "ProductOrServiceAxis" || !NONOP_MEMBER.test(c.dims[0][1])) continue;
    const k = `${c.start}|${c.end}|${c.dims[0][1]}`;
    if (!nonopBy.has(k)) nonopBy.set(k, { ...base, val: Number(m[2]) });
  }
  // 방식 2 — 회사 고유 태그(CVX: cvx:EquityMethodInvestmentIncome·cvx:NonoperatingIncome). 차원 멤버를
  // 못 찾았을 때만. 오판을 막으려고 호출부가 "총수익 − 이 합 = 고객계약 매출"(0.5%)을 확인한다.
  const viaDims = nonopBy.size > 0;
  const cands: (FactUnitEntry & { concept: string })[] = [];
  if (!nonopBy.size) {
    const NONOP_CONCEPT = /^(EquityMethodInvestmentIncome|IncomeFromEquityAffiliates|IncomeLossFromEquityMethodInvestments|EquityInEarningsOfAffiliates|NonoperatingIncome|OtherIncome|OtherNonoperatingIncome)$/;
    for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*)>(-?[\d.]+)<\/\1:\2>/g)) {
      if (!NONOP_CONCEPT.test(m[2])) continue;
      const c = ctx.get(/contextRef="([^"]+)"/.exec(m[3])?.[1] ?? "");
      if (!c?.start || !c.end || c.dims.length || !/unitRef="[^"]*usd/i.test(m[3])) continue;
      if (!cands.some((x) => x.concept === m[2] && x.start === c.start && x.end === c.end))
        cands.push({ concept: m[2], start: c.start, end: c.end, fy, fp, form: f.form, filed: f.filed, val: Number(m[4]) });
    }
  }
  const sum = new Map<string, FactUnitEntry>();
  for (const e of nonopBy.values()) {
    const k = `${e.start}|${e.end}`;
    const p = sum.get(k);
    sum.set(k, p ? { ...p, val: p.val + e.val } : { ...e });
  }
  return { nonop: [...sum.values()], total, viaDims, cands };
}

/**
 * 영업이익 태그가 없는 회사만 — 최근 10-K 3건 + 10-Q 8건(비교기간 포함 최근 약 13개 분기) 원본에서 총수익의 비영업 멤버를 읽어
 * 합성 태그(비영업 수익, 영업 매출)를 넣는다. 10-K 3건 = 최근 5개 사업연도. 해당 멤버가 없으면 facts 그대로.
 */
export async function withRevenueDims(cik: string, facts: CompanyFacts, recent: RecentFilings | null): Promise<CompanyFacts> {
  const g = facts.facts["us-gaap"] ?? {};
  if (!recent || g.OperatingIncomeLoss?.units?.USD?.some((e) => e.end >= "2020-01-01")) return facts;
  if (!g.Revenues) return facts;
  const pick = (re: RegExp, n: number): Filing[] => {
    const out: Filing[] = [];
    for (let i = 0; i < recent.form.length && out.length < n; i++)
      if (re.test(recent.form[i])) out.push({ accn: recent.accessionNumber[i], form: recent.form[i], filed: recent.filingDate[i], doc: recent.primaryDocument[i] });
    return out;
  };
  const nonop: FactUnitEntry[] = [];
  const total: FactUnitEntry[] = [];
  let viaDims = false;
  const cands: (FactUnitEntry & { concept: string })[] = [];
  for (const f of [...pick(/^10-K$/, 3), ...pick(/^10-Q$/, 8)]) {
    try {
      const url = await instanceUrl(Number(cik), f.accn.replace(/-/g, ""), f.doc);
      if (!url) return facts; // 인스턴스 없음 — 위와 같은 이유로 전체 미적용
      const xml = await fetchText(url, { headers: H, revalidate: 60 * 60 * 24, timeoutMs: 30_000 });
      const p = parse(xml, f);
      if (p.viaDims) viaDims = true;
      for (const e of p.cands) if (!cands.some((x) => x.concept === e.concept && x.start === e.start && x.end === e.end && x.filed === e.filed)) cands.push(e);
      for (const e of p.nonop) if (!nonop.some((x) => x.start === e.start && x.end === e.end && x.filed === e.filed)) nonop.push(e);
      for (const e of p.total) if (!total.some((x) => x.start === e.start && x.end === e.end && x.filed === e.filed)) total.push(e);
    } catch {
      // 한 건이라도 못 읽으면 적용하지 않는다 — 일부 기간만 분리되면 LTM(연간 + 당기 누적 − 전년 누적)에서
      // 분리·미분리 정의가 섞인다(감사 2026-09-24). 다음 로드 때 다시 시도.
      return facts;
    }
  }
  // 회사 고유 태그 방식(CVX) — 후보 태그의 부분집합 중 "총수익 − 합 = 고객계약 매출"(0.5%)이 되는 조합이
  // 있는지로 **구조만** 확인한다(총수익 = 고객계약 매출 + 지분법·기타수익). 값은 부분집합 합을 쓰지 않는다 —
  // 기간마다 맞는 조합이 달라 일부 기간만 채워졌고(2026 분기·누적 누락) LTM 에서 총수익과 섞였다
  // (검증 2026-09-24: CVX LTM 매출 하이라이트 2,152.61억 vs 손익계산서 2,106.62억). 구조가 확인되면
  // 영업 매출 = 공시된 고객계약 매출, 비영업 수익 = 총수익 − 고객계약 매출을 **모든 기간**에 쓴다.
  const rfcAll = g.RevenueFromContractWithCustomerExcludingAssessedTax?.units?.USD ?? [];
  if (!viaDims && cands.length) {
    let structural = 0;
    const periods = new Set(cands.map((c) => `${c.start}|${c.end}|${c.filed}`));
    for (const pk of periods) {
      const [st, en, fd] = pk.split("|");
      const t = total.find((x) => x.start === st && x.end === en && x.filed === fd);
      const r = rfcAll.find((x) => x.start === st && x.end === en);
      if (!t || !r) continue;
      // 차이가 미미하면(총수익의 1% 미만) 우연히 맞는 조합이 생긴다 — OXY 는 Revenues 가 손익계산서 "Net sales"
      // 그 자체이고 고객계약 매출과 0.1% 차이뿐인데 작은 기타수익 태그 하나가 들어맞아 오판됐다(검증 2026-09-24)
      if (t.val - r.val < 0.01 * Math.abs(t.val)) continue;
      const list = cands.filter((c) => c.start === st && c.end === en && c.filed === fd).slice(0, 10);
      for (let mask = 1; mask < 1 << list.length; mask++) {
        const v = list.filter((_, i) => mask & (1 << i)).reduce((acc, c) => acc + c.val, 0);
        if (Math.abs(t.val - v - r.val) <= 0.005 * Math.abs(r.val)) { structural++; break; }
      }
    }
    if (structural < 2) return facts;
    // 총수익 = 고객계약 매출 + 지분법·기타수익 구조라면 **연간**으로는 고객계약 매출이 총수익을 넘지 않는다.
    // OXY 는 Revenues 가 "Net sales"(파생상품 손익 포함) 자체라 2023·2024 연간에서 고객계약 매출 > 총수익 —
    // Yahoo 도 OXY 매출은 총수익(Revenues)을 쓴다. 분기는 지분법 손실로 음수가 될 수 있어(CVX 2020 2분기) 보지 않는다.
    const revAll = g.Revenues?.units?.USD ?? [];
    if (revAll.some((t) => t.fp === "FY" && rfcAll.some((r) => r.start === t.start && r.end === t.end && r.val > t.val))) return facts;
    const key = (e: FactUnitEntry) => `${e.start}|${e.end}|${e.form}|${e.fp}|${e.filed}`;
    const rfcBy = new Map(rfcAll.map((r) => [key(r), r]));
    const opRev: FactUnitEntry[] = [];
    const nonopAll: FactUnitEntry[] = [];
    for (const t of revAll) {
      const r = rfcBy.get(key(t));
      if (!t.start || !r || r.val > t.val) continue;
      opRev.push({ ...t, val: r.val });
      nonopAll.push({ ...t, val: t.val - r.val });
    }
    if (!opRev.length) return facts;
    return {
      ...facts,
      nonopInRevenues: true,
      facts: {
        ...facts.facts,
        "us-gaap": { ...g, [SYN_NONOP_IN_REVENUES]: { units: { USD: nonopAll } } },
      },
    } as CompanyFacts;
  }
  if (!nonop.length) return facts;
  // 영업 매출 = 같은 공시·같은 기간의 총수익 − 비영업 수익
  const opRev: FactUnitEntry[] = [];
  for (const n of nonop) {
    const t = total.find((x) => x.start === n.start && x.end === n.end && x.filed === n.filed);
    if (t) opRev.push({ ...t, val: t.val - n.val });
  }
  // 대조: 고객계약 매출(RevenueFromContract…)이 있는 기간은 영업 매출과 0.5% 안에서 맞아야 한다.
  // 회사 고유 태그 방식(CVX)은 이 대조가 되는 경우에만 쓴다(오판 방지). 차원 방식(XOM)은 멤버명이 명시적.
  const rfc = g.RevenueFromContractWithCustomerExcludingAssessedTax?.units?.USD ?? [];
  let matched = 0;
  for (const o of opRev) {
    const r = rfc.find((x) => x.start === o.start && x.end === o.end);
    if (!r) continue;
    if (Math.abs(o.val - r.val) / Math.abs(r.val) > 0.005) return facts;
    matched++;
  }
  if (!viaDims && matched === 0) return facts;
  return {
    ...facts,
    nonopInRevenues: true,
    facts: {
      ...facts.facts,
      "us-gaap": { ...g, [SYN_NONOP_IN_REVENUES]: { units: { USD: nonop } } },
    },
  } as CompanyFacts;
}
