import "server-only";
import { fetchText } from "../http";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import { instanceUrl } from "./edgar-classfacts";
import type { RecentFilings } from "./edgar-gapfill";

/**
 * **콘텐츠 상각을 감가상각비에 포함** (오너 결정 2026-09-24 — "너무 심하게 차이가 나기에 포함하는 게
 * 맞다"). NFLX 는 표준 감가상각비가 연 3억 달러뿐이고 콘텐츠 상각(연 160억 달러대)은 매출원가에 들어가
 * EBITDA 가 인포맥스·Yahoo 의 절반 이하였다(−55~−70%). 인포맥스·Yahoo·블룸버그는 더한다.
 *
 * 콘텐츠 상각은 회사 고유 확장 태그(`nflx:CostofServicesAmortizationofStreamingContentAssets`)라
 * SEC companyfacts 에 없다 → 10-K·10-Q XBRL 원본에서 읽는다. 비용 때문에 미디어 업종(SIC)만 본다.
 * 읽은 값은 합성 태그 `DAIncludingContentAmortizationDerived`(= 그 기간 표준 감가상각 합계 + 콘텐츠
 * 상각)로 넣고, edgar-ev.ts DA_TOTAL 이 이 태그를 포함해 모든 화면의 감가상각비·EBITDA 가 같이 바뀐다.
 */

export const SYN_DA_WITH_CONTENT = "DAIncludingContentAmortizationDerived";
/**
 * 적용 대상 — **NFLX 만**(오너 결정 2026-09-24 "일단 nflx 만 수정하고 dis 등 나머지 문제점은 미수정으로
 * 분류"). 같은 규칙(현금흐름표 별도 줄)을 WBD·ROKU 에 적용하면 인포맥스(FactSet)와 오히려 더 벌어졌다
 * (FactSet 이 회사마다 조정 EBITDA 기준이 달라 보임). DIS 는 콘텐츠 상각이 주석에만 있어 대상 아님.
 * 대상을 넓히려면 이 목록에 CIK 를 추가한다.
 */
const CONTENT_CIKS = new Set(["0001065280"]); // NFLX
/** 콘텐츠 상각이 있을 법한 업종 — 영화·방송·케이블·스트리밍·음반 */
const MEDIA_SIC = new Set([4833, 4841, 4899, 7812, 7819, 7822, 7829, 7841, 7990]);
/** 확장·표준 태그명 패턴 (현금흐름표 조정 항목 포함) */
const CONTENT_RE = /Amortization\w*(Streaming)?Content|ContentAmortization|AmortizationOfFilm|FilmCostsAmortization|AmortizationOfProgramming/i;
const DA_BASE = ["DepreciationDepletionAndAmortization", "DepreciationAndAmortization", "DepreciationAmortizationAndAccretionNet"];

const UA = process.env.SEC_USER_AGENT ?? "global-market-research (personal use) contact@example.com";
const H = { "user-agent": UA, "accept-encoding": "gzip, deflate" };

interface Filing { accn: string; form: string; filed: string; doc: string }

function parse(xml: string, f: Filing, cfTags: Set<string>): FactUnitEntry[] {
  const ctx = new Map<string, { start?: string; end?: string; dimmed: boolean }>();
  for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
    const b = m[2];
    ctx.set(m[1], {
      start: /<(?:xbrli:)?startDate>([^<]+)</.exec(b)?.[1]?.trim(),
      end: /<(?:xbrli:)?endDate>([^<]+)</.exec(b)?.[1]?.trim(),
      dimmed: /dimension="/.test(b), // explicit·typed 모두
    });
  }
  const fp = /<dei:DocumentFiscalPeriodFocus\b[^>]*>([^<]+)</.exec(xml)?.[1]?.trim() ?? (/^10-K/.test(f.form) ? "FY" : "");
  const fy = Number(/<dei:DocumentFiscalYearFocus\b[^>]*>([^<]+)</.exec(xml)?.[1]) || 0;
  // 태그별로 모은 뒤, 가장 많이 쓰인(=본 표의) 콘텐츠 상각 태그 하나만 쓴다 — 주석의 세부 항목과 섞이지 않게
  const byTag = new Map<string, FactUnitEntry[]>();
  for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*?)>(-?[\d.]+)<\/\1:\2>/g)) {
    if (!CONTENT_RE.test(m[2]) || /Accumulated|Future|Expected|NextTwelve|Year(Two|Three|Four|Five)|Percentage/i.test(m[2])) continue;
    if (!cfTags.has(m[2])) continue; // 현금흐름표 본표 줄만
    const c = ctx.get(/contextRef="([^"]+)"/.exec(m[3])?.[1] ?? "");
    if (!c?.start || !c.end || c.dimmed || !/unitRef="[^"]*usd/i.test(m[3])) continue;
    const list = byTag.get(m[2]) ?? [];
    if (!list.some((e) => e.start === c.start && e.end === c.end))
      list.push({ start: c.start, end: c.end, val: Math.abs(Number(m[4])), fy, fp, form: f.form, filed: f.filed });
    byTag.set(m[2], list);
  }
  const best = [...byTag.values()].sort((a, b) => b.length - a.length)[0];
  return best ?? [];
}

/**
 * 미디어 업종이면 최근 10-K 3건 + 최신 10-Q 원본에서 콘텐츠 상각을 읽어 합성 감가상각 태그를 넣는다.
 * 콘텐츠 상각이 없으면(대부분) facts 를 그대로 돌려준다.
 */
export async function withContentAmortization(
  cik: string,
  facts: CompanyFacts,
  recent: RecentFilings | null,
  sic: number | null,
): Promise<CompanyFacts> {
  if (!recent || sic == null || !MEDIA_SIC.has(sic) || !CONTENT_CIKS.has(cik.padStart(10, "0"))) return facts;
  const pick = (re: RegExp, n: number): Filing[] => {
    const out: Filing[] = [];
    for (let i = 0; i < recent.form.length && out.length < n; i++)
      if (re.test(recent.form[i]))
        out.push({ accn: recent.accessionNumber[i], form: recent.form[i], filed: recent.filingDate[i], doc: recent.primaryDocument[i] });
    return out;
  };
  const filings = [...pick(/^10-K$/, 3), ...pick(/^10-Q$/, 1)];
  const cikNum = Number(cik);
  const content: FactUnitEntry[] = [];
  for (const f of filings) {
    try {
      const url = await instanceUrl(cikNum, f.accn.replace(/-/g, ""), f.doc);
      if (!url) continue;
      const xml = await fetchText(url, { headers: H, revalidate: 60 * 60 * 24, timeoutMs: 30_000 });
      // 현금흐름표 본표에 별도 비현금 조정 줄로 나오는 태그만 — 주석에만 있는 값(DIS)은 데이터 업체도
      // 더하지 않는다(검증 2026-09-24: DIS 를 주석 값으로 더해 인포맥스 대비 +76~138% 가 됐었다)
      const pre = await fetchText(url.replace(/_htm\.xml$/i, "_pre.xml").replace(/\.xml$/i, (m) => (url.endsWith("_htm.xml") ? m : "_pre.xml")), {
        headers: H, revalidate: 60 * 60 * 24, timeoutMs: 30_000,
      }).catch(() => "");
      const cfTags = new Set<string>();
      for (const m of pre.matchAll(/<link:presentationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/link:presentationLink>/g)) {
        if (!/CASH\s*FLOWS?/i.test(m[1].split("/").pop() ?? "") || /Detail|Table|Polic|Parenthetical/i.test(m[1])) continue;
        for (const h of m[2].matchAll(/xlink:href="[^"#]*#[a-z0-9-]+_([A-Za-z0-9]+)"/g)) cfTags.add(h[1]);
      }
      for (const e of parse(xml, f, cfTags))
        if (!content.some((x) => x.start === e.start && x.end === e.end && x.form === e.form && x.filed === e.filed)) content.push(e);
    } catch {
      /* 이 공시만 건너뜀 */
    }
  }
  if (!content.length) return facts;
  const g = facts.facts["us-gaap"] ?? {};
  // 같은 기간의 표준 감가상각 합계(최댓값) + 콘텐츠 상각
  const baseAt = (e: FactUnitEntry): number => {
    let m = 0;
    for (const t of DA_BASE)
      for (const b of g[t]?.units?.USD ?? []) if (b.start === e.start && b.end === e.end && b.val > m) m = b.val;
    return m;
  };
  const syn: FactUnitEntry[] = content.map((e) => ({ ...e, val: e.val + baseAt(e) }));
  return {
    ...facts,
    contentAmortization: true,
    facts: { ...facts.facts, "us-gaap": { ...g, [SYN_DA_WITH_CONTENT]: { units: { USD: syn } } } },
  } as CompanyFacts;
}
