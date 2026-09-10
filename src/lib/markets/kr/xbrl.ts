import "server-only";
import { unzipSync, strFromU8 } from "fflate";
import { fetchJson } from "../http";
import { resolveCorpCode } from "./corpcode";

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
  const rows = (res.list ?? []).filter((r) => /사업보고서/.test(r.report_nm));
  rows.sort((a, b) => b.rcept_no.localeCompare(a.rcept_no)); // 최신(정정본) 우선
  return rows[0]?.rcept_no ?? null;
}

export interface KrDA {
  /** 연도별 감가상각비·무형자산상각비 (연결, 원) */
  byYear: Record<number, { depreciation: number | null; amortisation: number | null }>;
  source: string;
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

/** 한 사업보고서(rcpNo)에서 당기·전기 2개년 D&A 추출. */
async function fromReport(
  rcpNo: string,
  year: number,
): Promise<Record<number, { depreciation: number | null; amortisation: number | null }>> {
  const res = await fetch(`${BASE}/fnlttXbrl.xml?crtfc_key=${key()}&rcept_no=${rcpNo}&reprt_code=11011`, {
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`fnlttXbrl ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
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
    const dep = pickFact(xml, DEP_C, prefix);
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
  } catch {
    return null;
  }
  const byYear: KrDA["byYear"] = {};
  // 각 보고서가 당기+전기 2개년을 주므로 2년 간격으로 조회
  for (let y = latestYear; y >= latestYear - backYears; y -= 2) {
    const rcp = await annualReportRcpNo(corpCode, y);
    if (!rcp) continue;
    try {
      const part = await fromReport(rcp, y);
      for (const [k, v] of Object.entries(part)) if (!(Number(k) in byYear)) byYear[Number(k)] = v;
    } catch {
      // skip this report
    }
  }
  if (Object.keys(byYear).length === 0) return null;
  return { byYear, source: "DART XBRL (사업보고서 현금흐름표 주석)" };
}
