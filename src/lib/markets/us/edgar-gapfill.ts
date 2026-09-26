import "server-only";
import { fetchText } from "../http";
import { fetchFailureReason, markUnavailable } from "./sec-unavailable";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import { instanceUrl, needsClassAFacts } from "./edgar-classfacts";

/**
 * **companyfacts 누락 보완** — 최신 10-Q/10-K 의 XBRL 인스턴스를 직접 읽어 채운다.
 *
 * 왜 필요한가 (검증 2026-09-24, docs/verification-status.md §1 시가총액):
 * 1. **SEC companyfacts API 가 공시를 통째로 빠뜨린다.** BE 2분기 10-Q(07-28
 *    제출, XBRL 정상 첨부)가 companyfacts 에 없어 BE 의 LTM 전체가 03-31 에 멈췄다.
 * 2. **CIK 변경.** XOM 은 2026-07-01 지주사 재편으로 2분기 재무가 새 CIK
 *    (2115436)에만 올라갔다. 옛 CIK(34088, 과거 재무 보유)의 공시 목록에도 같은
 *    10-Q 가 공동 제출로 올라와 있으므로 1번과 같은 방식으로 채워진다.
 * 3. **복수 클래스 표지 주식수.** META(Class A·B)·DELL(A·C)은 표지 주식수를
 *    클래스 차원에만 태깅해 차원 없는 값만 주는 companyfacts 에 아예 없다 →
 *    META 는 연간 희석 가중평균, DELL 은 백만 단위 반올림 기말 주식수로 대체됐다.
 *    인스턴스에서 클래스별 값을 합산해 차원 없는 표지 주식수로 넣는다.
 *    (Visa 형은 B·C 가 전환비율 미반영 원주식수라 단순 합이 틀려 제외 —
 *    edgar-classfacts.ts 의 as-converted 경로와 current-shares.ts 가 맡는다.)
 *
 * 인스턴스의 차원 없는 사실만 companyfacts 와 같은 모양(fy·fp·form·filed 는 그
 * 공시 기준)으로 변환해 붙인다. 실패하면 원본을 그대로 돌려준다.
 */

const UA =
  process.env.SEC_USER_AGENT ?? "global-market-research (personal use) contact@example.com";
const SEC_HEADERS = { "user-agent": UA, "accept-encoding": "gzip, deflate" };

/** 한 번에 보완할 누락 공시 수 상한 (정상이면 0건) */
const MAX_GAP_FILINGS = 3;
// 20-F 포함 — TSM 2025 20-F 가 companyfacts 에 없어 연도·LTM 이 비었다(검증 2026-09-24)
const PERIODIC = /^(10-[QK]|20-F)(\/A)?$/;

export interface RecentFilings {
  accessionNumber: string[];
  form: string[];
  filingDate: string[];
  primaryDocument: string[];
  /** 보고 기간 종료일(submissions API) */
  reportDate?: string[];
}

interface Filing {
  accn: string;
  form: string;
  filed: string;
  doc: string;
}

type Units = Record<string, FactUnitEntry[]>;
type Ns = Record<string, { units: Units }>;

interface ParsedInstance {
  usGaap: Record<string, Units>;
  ifrs: Record<string, Units>;
  dei: Record<string, Units>;
  /** 표지 주식수 — 차원 없는 값, 없으면 클래스별 합 */
  cover: { end: string; val: number } | null;
}

// ── 인스턴스 파싱 ─────────────────────────────────────────────────────

interface Ctx {
  start?: string;
  end?: string;
  dims: [string, string][];
}

const local = (q: string) => q.split(":").pop() ?? q;

function parseContexts(xml: string): Map<string, Ctx> {
  const out = new Map<string, Ctx>();
  const re = /<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const b = m[2];
    const start = /<(?:xbrli:)?startDate>([^<]+)</.exec(b)?.[1]?.trim();
    const end =
      /<(?:xbrli:)?endDate>([^<]+)</.exec(b)?.[1]?.trim() ??
      /<(?:xbrli:)?instant>([^<]+)</.exec(b)?.[1]?.trim();
    // 차원은 explicitMember 뿐 아니라 typedMember(값 입력형)도 있다 — dimension 속성을 모두 센다.
    // 예전엔 typedMember 를 놓쳐 차원 값을 "차원 없음"으로 읽어 TSM 2025 20-F 값이 4번씩 들어갔고,
    // 합산 매핑에서 차입금이 두 배가 됐다(검증 2026-09-24).
    const dims: [string, string][] = [];
    const dre = /dimension="([^"]+)"[^>]*>([^<]*)</g;
    let d: RegExpExecArray | null;
    while ((d = dre.exec(b))) dims.push([local(d[1]), local(d[2].trim())]);
    out.set(m[1], { start, end, dims });
  }
  return out;
}

/** unit id → companyfacts 단위 키 ("USD", "shares", "USD/shares", "pure" …) */
function parseUnits(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<(?:xbrli:)?unit\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?unit>/g;
  const measures = (s: string) =>
    [...s.matchAll(/<(?:xbrli:)?measure>([^<]+)</g)].map((x) => local(x[1].trim()));
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const b = m[2];
    const num = /unitNumerator>([\s\S]*?)<\/(?:xbrli:)?unitNumerator/.exec(b);
    const den = /unitDenominator>([\s\S]*?)<\/(?:xbrli:)?unitDenominator/.exec(b);
    out.set(
      m[1],
      num && den ? `${measures(num[1]).join("*")}/${measures(den[1]).join("*")}` : measures(b).join("*"),
    );
  }
  return out;
}

export function parseInstanceFacts(xml: string, f: Filing): ParsedInstance {
  const ctxs = parseContexts(xml);
  const units = parseUnits(xml);
  const text = (tag: string) =>
    new RegExp(`<dei:${tag}\\b[^>]*>([^<]+)</dei:${tag}>`).exec(xml)?.[1]?.trim();
  const fy = Number(text("DocumentFiscalYearFocus")) || 0;
  const fp = text("DocumentFiscalPeriodFocus") ?? (/^10-K/.test(f.form) ? "FY" : "");

  const out: ParsedInstance = { usGaap: {}, ifrs: {}, dei: {}, cover: null };
  const coverParts: { end: string; val: number; dims: number }[] = [];
  const re = /<(us-gaap|ifrs-full|dei):([A-Za-z0-9_]+)\b([^>]*?)>([^<]*)<\/\1:\2>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const [, ns, concept, attrs, raw] = m;
    const unitRef = /\bunitRef="([^"]+)"/.exec(attrs)?.[1];
    const cref = /\bcontextRef="([^"]+)"/.exec(attrs)?.[1];
    if (!unitRef || !cref) continue; // 숫자 사실만
    const ctx = ctxs.get(cref);
    const val = Number(raw.trim());
    if (!ctx?.end || !Number.isFinite(val)) continue;
    if (ns === "dei" && concept === "EntityCommonStockSharesOutstanding") {
      coverParts.push({ end: ctx.end, val, dims: ctx.dims.length });
      continue;
    }
    if (ctx.dims.length) continue; // 차원 없는 값만 (companyfacts 와 같은 범위)
    const unit = units.get(unitRef);
    if (!unit) continue;
    const bucket = ns === "dei" ? out.dei : ns === "ifrs-full" ? out.ifrs : out.usGaap;
    const entry: FactUnitEntry & { accn: string } = {
      end: ctx.end,
      val,
      fy,
      fp,
      form: f.form,
      filed: f.filed,
      accn: f.accn,
    };
    if (ctx.start) entry.start = ctx.start;
    // 같은 개념·단위·기간 값이 문맥 ID 만 달리 반복 태깅되는 경우(표 여러 곳에 같은 숫자) 하나만
    const list = ((bucket[concept] ??= {})[unit] ??= []);
    if (!list.some((x) => x.end === entry.end && (x.start ?? "") === (entry.start ?? ""))) list.push(entry);
  }

  // 표지 주식수: 차원 없는 값 우선, 없으면 클래스 차원 1개짜리의 합(같은 기준일)
  const plain = coverParts.filter((c) => c.dims === 0);
  const byClass = coverParts.filter((c) => c.dims === 1);
  if (plain.length) {
    const c = plain.reduce((a, b) => (b.end > a.end ? b : a));
    out.cover = { end: c.end, val: c.val };
  } else if (byClass.length) {
    const end = byClass.reduce((a, b) => (b.end > a.end ? b : a)).end;
    const val = byClass.filter((c) => c.end === end).reduce((s, c) => s + c.val, 0);
    if (val > 0) out.cover = { end, val };
  }
  return out;
}

// ── 병합 ──────────────────────────────────────────────────────────────

function mergeNs(base: Ns | undefined, add: Record<string, Units>): Ns {
  const out: Ns = { ...(base ?? {}) };
  for (const [concept, units] of Object.entries(add)) {
    const cur = out[concept];
    const merged: Units = { ...(cur?.units ?? {}) };
    for (const [u, entries] of Object.entries(units)) merged[u] = [...(merged[u] ?? []), ...entries];
    out[concept] = { ...(cur ?? {}), units: merged };
  }
  return out;
}

function maxFiled(ns: Ns | undefined): string {
  let max = "";
  for (const c of Object.values(ns ?? {}))
    for (const arr of Object.values(c.units))
      for (const e of arr) if (e.filed && e.filed > max) max = e.filed;
  return max;
}

async function loadInstance(cik: string, f: Filing): Promise<string | null> {
  const url = await instanceUrl(Number(cik), f.accn.replace(/-/g, ""), f.doc);
  if (!url) return null;
  return fetchText(url, { headers: SEC_HEADERS, revalidate: 60 * 60 * 24, timeoutMs: 30_000 });
}

/**
 * companyfacts 에 없는 최신 정기공시를 인스턴스로 보완하고, 표지 주식수가
 * 빠진 복수 클래스 종목은 클래스별 합으로 채운다.
 */
export async function withFilingGapFill(
  cik: string,
  facts: CompanyFacts,
  recent: RecentFilings | null,
): Promise<CompanyFacts> {
  if (!recent) return facts;
  const periodic: Filing[] = [];
  for (let i = 0; i < recent.form.length; i++)
    if (PERIODIC.test(recent.form[i]))
      periodic.push({
        accn: recent.accessionNumber[i],
        form: recent.form[i],
        filed: recent.filingDate[i],
        doc: recent.primaryDocument[i],
      });
  if (!periodic.length) return facts;

  const ifrsNs = (facts.facts as Record<string, Ns | undefined>)["ifrs-full"];
  const gaapMax = [maxFiled(facts.facts["us-gaap"] as Ns | undefined), maxFiled(ifrsNs)].sort().pop() ?? "";
  // 빈 companyfacts(재무 없는 엔티티)는 보완 대상이 아니다
  const gaps = gaapMax ? periodic.filter((f) => f.filed > gaapMax).slice(0, MAX_GAP_FILINGS) : [];

  const latest = periodic[0];
  const coverEntries = facts.facts.dei?.EntityCommonStockSharesOutstanding?.units?.shares ?? [];
  const coverStale = !coverEntries.some((e) => (e.filed ?? "") >= latest.filed);
  const wantCover = coverStale && !needsClassAFacts(facts);
  if (!gaps.length && !wantCover) return facts;

  let usGaap = facts.facts["us-gaap"] as Ns | undefined;
  let ifrsOut = ifrsNs;
  let dei = facts.facts.dei as Ns | undefined;
  const parsed = new Map<string, ParsedInstance>();
  // 오래된 것부터 붙여 "최신 filed 우선" 규칙과 맞춘다
  // 조회 실패한 누락 공시 — 그 공시가 빠진 채로 계산한 최근 12개월(LTM)은 같은 "LTM" 열에 더 오래된 기간 값이 들어가므로
  // 화면이 LTM 열을 공란 + 사유로 둔다(sec-unavailable.ts "filings"). 연도 열은 해당 연도가 통째로 빠질 뿐 값은 바뀌지 않는다
  const failed: string[] = [];
  let failReason = "";
  for (const f of [...gaps].reverse()) {
    try {
      const xml = await loadInstance(cik, f);
      if (!xml) continue;
      const p = parseInstanceFacts(xml, f);
      parsed.set(f.accn, p);
      usGaap = mergeNs(usGaap, p.usGaap);
      if (Object.keys(p.ifrs).length) ifrsOut = mergeNs(ifrsOut, p.ifrs);
      dei = mergeNs(dei, p.dei);
    } catch (e) {
      /* 이 공시만 건너뜀 — 조회 실패면 기록 */
      const why = fetchFailureReason(e);
      if (why != null) {
        failed.push(f.filed);
        failReason ||= `${f.form} ${f.filed} · ${why}`;
      }
    }
  }

  if (wantCover) {
    try {
      let p = parsed.get(latest.accn) ?? null;
      if (!p) {
        const xml = await loadInstance(cik, latest);
        p = xml ? parseInstanceFacts(xml, latest) : null;
      }
      if (p?.cover) {
        const entry: FactUnitEntry = {
          end: p.cover.end,
          val: p.cover.val,
          fy: 0,
          fp: "",
          form: latest.form,
          filed: latest.filed,
        };
        dei = mergeNs(dei, { EntityCommonStockSharesOutstanding: { shares: [entry] } });
      }
    } catch {
      /* 표지 보완 실패 — 기존 경로 유지 */
    }
  }

  const merged: CompanyFacts = {
    ...facts,
    facts: { ...facts.facts, "us-gaap": usGaap, dei, ...(ifrsOut ? { "ifrs-full": ifrsOut } : {}) } as CompanyFacts["facts"],
  };
  return failed.length ? markUnavailable(merged, "filings", failReason, failed) : merged;
}
