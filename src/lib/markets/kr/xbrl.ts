import "server-only";
import { unzipSync, strFromU8 } from "fflate";
import { fetchJson } from "../http";
import { resolveCorpCode } from "./corpcode";
import { dartRceptBinary } from "./dart-cache";

/**
 * DART XBRL 원본에서 현금흐름표 주석의 감가상각비·무형자산상각비 추출.
 * 재무제표 API(fnlttSinglAcntAll)는 "조정" 한 줄로 뭉쳐 나와 EBITDA 산출 불가 →
 * 사업보고서 XBRL(zip)을 받아 CF 조정내역 개념을 파싱한다.
 *
 * 하나의 사업보고서 XBRL 은 당기(CFY{y}dFY)와 전기(PFY{y-1}dFY) 두 해를 담는다.
 * 개념: ifrs-full:AdjustmentsForDepreciationExpense / AdjustmentsForAmortisationExpense
 *       (합산본 AdjustmentsForDepreciationAndAmortisationExpense 폴백)
 * 컨텍스트: 연결(ConsolidatedMember) · 무차원 또는 dart_ReportedAmountMember
 *
 * OpenDART XBRL 엔드포인트는 클라우드 IP(Vercel)를 차단 → 로컬 배치에서 파싱해 DB 적재.
 */

function key(): string {
  const k = process.env.DART_API_KEY;
  if (!k) throw new Error("DART_API_KEY 미설정");
  return k;
}

const BASE = "https://opendart.fss.or.kr/api";

interface ListRow {
  rcept_no: string;
  report_nm: string;
  rcept_dt: string;
}

/** 특정 사업연도 사업보고서의 접수번호 (정정본 우선). */
async function annualReportRcpNo(corpCode: string, year: number): Promise<string | null> {
  const res = await fetchJson<{ status: string; list?: ListRow[] }>(
    `${BASE}/list.json?crtfc_key=${key()}&corp_code=${corpCode}` +
      `&bgn_de=${year + 1}0101&end_de=${year + 1}0930&pblntf_detail_ty=A001&page_count=100`,
    { revalidate: 60 * 60 * 24 },
  );
  // 보고서명의 대상 연도가 맞는 것만 — 이듬해 목록에 지난 연도 정정본이 섞인다(현대차 2024-03 "[기재정정]사업보고서 (2022.12)")
  const rows = (res.list ?? []).filter((r) => /사업보고서/.test(r.report_nm) && r.report_nm.includes(`(${year}.`));
  rows.sort((a, b) => b.rcept_no.localeCompare(a.rcept_no)); // 최신(정정본) 우선
  return rows[0]?.rcept_no ?? null;
}

export interface KrDA {
  /** 연도별 감가상각비·무형자산상각비 (연결, 원) */
  byYear: Record<number, { depreciation: number | null; amortisation: number | null }>;
  source: string;
  /** 읽지 못한 보고서 사유(감사 2차 ⑨ — 예전엔 건너뛰기만 해 그 해가 사유 없이 빠졌다) */
  warnings: string[];
}

/** 연결 + (무차원 또는 ReportedAmount), 세그먼트·자산분류 축이 붙지 않은 컨텍스트만. */
function ctxOk(ctx: string, prefix: string): boolean {
  if (!ctx.startsWith(prefix + "_") && ctx !== prefix) return false;
  if (!ctx.includes("_ConsolidatedMember")) return false;
  if (/SegmentConsolidationItemsAxis|OperatingSegments|ClassesOfAssets|ClassesOfPropertyPlantAndEquipment|ClassesOfIntangibleAssets/.test(ctx))
    return false;
  return /ConsolidatedMember$/.test(ctx) || /ReportedAmountMember$/.test(ctx);
}

function pickFact(xml: string, concepts: string[], prefix: string): number | null {
  for (const c of concepts) {
    const re = new RegExp(`<(?:ifrs-full|dart):${c}\\b[^>]*contextRef="([^"]+)"[^>]*>(-?\\d+(?:\\.\\d+)?)</`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      if (ctxOk(m[1], prefix)) {
        const v = Number(m[2]);
        if (Number.isFinite(v)) return v;
      }
    }
  }
  return null;
}

const DEP_C = ["AdjustmentsForDepreciationExpense", "AdjustmentsForDepreciationAndAmortisationExpense"];
const AMO_C = ["AdjustmentsForAmortisationExpense"];
// 따로 적은 사용권자산·투자부동산 감가상각은 더한다(scripts/populate-kr-da.mjs 와 같은 규칙 — 한국 EV 에 리스부채가 들어가므로)
// [dart 표준 태그, 없을 때 회사 고유 태그] — 현대로템은 사용권자산 상각을 회사 고유 태그로 단다
const DEP_EXTRA: [string, RegExp][] = [
  ["AdjustmentsForDepreciationRightofuseAssets", /^Adjustments?For(?:Depreciation|Amorti[sz]ation)\w*?Right[Oo]f[Uu]seAssets/],
  ["AdjustmentsForDepreciationInvestmentProperty", /^Adjustments?ForDepreciation\w*?InvestmentPropert/],
];
/** 회사 고유(entity…) 태그 중 이름이 맞는 첫 값 */
function pickEntity(xml: string, nameRe: RegExp, prefix: string): number | null {
  for (const m of xml.matchAll(/<entity\d+:(\w+)\b[^>]*contextRef="([^"]+)"[^>]*>(-?\d+(?:\.\d+)?)</g))
    if (nameRe.test(m[1]) && ctxOk(m[2], prefix)) return Number(m[3]);
  return null;
}

/**
 * 분기·반기 보고서 XBRL(rcpNo, reprtCode 11013·11012·11014)에서 개념별 누적 금액 — 당기(CFY{Y}d{FQ|HY|TQ}A)·전기(PFY{Y−1}d…A, 정정본).
 * 오너 결정 2026-10-10: 현금흐름 LTM 전기 누적은 이 전기 칸(DART 재무제표 API 는 분기·반기 현금흐름표 전기 열을 주지 않는다). 컨텍스트 = 그 접두어만,
 * 또는 연결/별도 축 하나만(다른 축이 붙은 칸은 제외). 같은 개념·컨텍스트 종류에 값이 둘 이상 다르면 null(못 정함). 조회 실패는 던진다(호출부가 사유)
 */
export async function krInterimXbrlCum(
  rcpNo: string,
  reprtCode: string,
  year: number,
  concepts: readonly string[],
  fsDiv: "CFS" | "OFS",
): Promise<{ cur: number | null; prior: number | null }> {
  const buf = await dartRceptBinary("xbrl", rcpNo, async () => {
    const res = await fetch(`${BASE}/fnlttXbrl.xml?crtfc_key=${key()}&rcept_no=${rcpNo}&reprt_code=${reprtCode}`, { signal: AbortSignal.timeout(45_000) });
    if (!res.ok) throw new Error(`fnlttXbrl ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  });
  let files;
  try {
    files = unzipSync(buf);
  } catch {
    throw new Error(`분기 보고서 XBRL ${rcpNo} 압축 해제 실패 — ${strFromU8(buf.slice(0, 160)).replace(/\s+/g, " ")}`);
  }
  const name = Object.keys(files).find((n) => n.endsWith(".xbrl"));
  if (!name) throw new Error(`분기 보고서 XBRL ${rcpNo} — zip 안에 .xbrl 없음`);
  const xml = strFromU8(files[name]);
  const q = ({ "11013": "FQ", "11012": "HY", "11014": "TQ" } as Record<string, string>)[reprtCode];
  if (!q) throw new Error(`분기 보고서 코드 아님 ${reprtCode}`);
  const member = fsDiv === "CFS" ? "ConsolidatedMember" : "SeparateMember";
  const okCtx = (ctx: string, pre: string) => ctx === pre || ctx === `${pre}_ifrs-full_ConsolidatedAndSeparateFinancialStatementsAxis_ifrs-full_${member}`;
  const read = (pre: string): number | null => {
    for (const c of concepts) {
      const local = c.replace(/^(ifrs-full|dart)_/, "");
      const vals = new Set<number>();
      for (const m of xml.matchAll(new RegExp(`<(?:ifrs-full|dart):${local}\\b[^>]*contextRef="([^"]+)"[^>]*>(-?\\d+(?:\\.\\d+)?)</`, "g")))
        if (okCtx(m[1], pre)) vals.add(Number(m[2]));
      if (vals.size === 1) return [...vals][0];
      if (vals.size > 1) return null;
    }
    return null;
  };
  return { cur: read(`CFY${year}d${q}A`), prior: read(`PFY${year - 1}d${q}A`) };
}

/** 한 사업보고서(rcpNo)에서 당기·전기 2개년 D&A 추출. */
async function fromReport(
  rcpNo: string,
  year: number,
): Promise<Record<number, { depreciation: number | null; amortisation: number | null }>> {
  // 디스크 캐시(DART_CACHE_DIR — 판본 = 접수번호, dart-cache.ts)
  const buf = await dartRceptBinary("xbrl", rcpNo, async () => {
    const res = await fetch(`${BASE}/fnlttXbrl.xml?crtfc_key=${key()}&rcept_no=${rcpNo}&reprt_code=11011`, {
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`fnlttXbrl ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  });
  if (buf.length < 100) throw new Error(`xbrl empty (${buf.length}B)`);
  const files = unzipSync(buf);
  const name = Object.keys(files).find((n) => n.endsWith(".xbrl"));
  if (!name) throw new Error(`xbrl not in zip: ${Object.keys(files).join(",")}`);
  const xml = strFromU8(files[name]);

  const out: Record<number, { depreciation: number | null; amortisation: number | null }> = {};
  for (const [y, prefix] of [
    [year, `CFY${year}dFY`],
    [year - 1, `PFY${year - 1}dFY`],
  ] as [number, string][]) {
    const dep0 = pickFact(xml, DEP_C, prefix);
    // 기본 감가상각 줄이 없으면 부분합이 되므로 비운다
    const dep = dep0 == null ? null : DEP_EXTRA.reduce((a, [c, ent]) => a + (pickFact(xml, [c], prefix) ?? pickEntity(xml, ent, prefix) ?? 0), dep0);
    const amo = pickFact(xml, AMO_C, prefix);
    if (dep != null || amo != null) out[y] = { depreciation: dep, amortisation: amo };
  }
  return out;
}

/**
 * 최근 ~6개년 감가상각비·무형자산상각비. 사업보고서 XBRL 여러 건(각 2개년)을 병합.
 * @param backYears 최신 확정연도 기준 몇 년 전까지 (기본 5 → 6개년)
 */
export async function fetchKrDA(symbol: string, latestYear: number, backYears = 5): Promise<KrDA | null> {
  let corpCode: string;
  try {
    corpCode = (await resolveCorpCode(key(), symbol)).corpCode;
  } catch (e) {
    // 상장사 목록에 없는 종목 = 자료 없음(조회 실패가 아니다). 그 밖의 오류는 던진다
    if (/상장사 목록에 없는/.test(e instanceof Error ? e.message : String(e))) return null;
    throw e;
  }
  const byYear: KrDA["byYear"] = {};
  const warnings: string[] = [];
  // 각 보고서가 당기+전기 2개년을 주므로 2년 간격으로 조회
  // 매년 보고서(최신부터). 2년 간격이면 2022 보고서를 건너뛰어 2021 값이 빠졌다(2021 보고서 XBRL 은 주석 태깅 없음 — 2026-10-02)
  for (let y = latestYear; y >= latestYear - backYears; y -= 1) {
    const rcp = await annualReportRcpNo(corpCode, y);
    if (!rcp) continue;
    try {
      const part = await fromReport(rcp, y);
      for (const [k, v] of Object.entries(part)) if (!(Number(k) in byYear)) byYear[Number(k)] = v;
    } catch (e) {
      warnings.push(`FY${y} 사업보고서 XBRL(${rcp}) 조회 실패 — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (Object.keys(byYear).length === 0) {
    if (warnings.length) throw new Error(warnings.join(" · "));
    return null;
  }
  return { byYear, source: "DART XBRL (사업보고서 현금흐름표 주석)", warnings };
}
