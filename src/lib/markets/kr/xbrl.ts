import "server-only";
import { unzipSync, strFromU8 } from "fflate";
import { fetchJson } from "../http";
import { resolveCorpCode } from "./corpcode";

/**
 * DART XBRL 원본에서 현금흐름표 주석의 감가상각비·무형자산상각비 추출.
 * 재무제표 API(fnlttSinglAcntAll)는 "조정" 한 줄로 뭉쳐 나와 EBITDA 산출 불가 →
 * 사업보고서 XBRL(zip)을 받아 CF 조정내역 개념을 파싱한다.
 *
 * 개념: ifrs-full:AdjustmentsForDepreciationExpense / AdjustmentsForAmortisationExpense
 *       (일부 회사는 합산 AdjustmentsForDepreciationAndAmortisationExpense)
 * 컨텍스트: 당기(CFY…) · 연결(ConsolidatedMember) · 무차원(추가 Axis 없음)
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

/** 해당 사업연도 사업보고서의 접수번호 */
async function annualReportRcpNo(corpCode: string, year: number): Promise<string | null> {
  const res = await fetchJson<{ status: string; list?: ListRow[] }>(
    `${BASE}/list.json?crtfc_key=${key()}&corp_code=${corpCode}` +
      `&bgn_de=${year + 1}0101&end_de=${year + 1}0930&pblntf_detail_ty=A001&page_count=100`,
    { revalidate: 60 * 60 * 24 },
  );
  const hit = (res.list ?? []).find(
    (r) => /사업보고서/.test(r.report_nm) && !/기재정정/.test(r.report_nm),
  );
  // 정정본이 있으면 최신(가장 큰 rcept_no) 우선
  const revised = (res.list ?? [])
    .filter((r) => /사업보고서/.test(r.report_nm))
    .sort((a, b) => b.rcept_no.localeCompare(a.rcept_no))[0];
  return revised?.rcept_no ?? hit?.rcept_no ?? null;
}

export interface KrDA {
  /** 회계연도 */
  year: number;
  /** 감가상각비 (연결) */
  depreciation: number | null;
  /** 무형자산상각비 (연결) */
  amortisation: number | null;
  source: string;
}

/**
 * contextRef 가 "당기 + 연결 + (보고금액)" 인지.
 * - CF 주석 조정내역: …ConsolidatedMember_…CarryingAmount…Axis_dart_ReportedAmountMember
 * - 본표 개념: …ConsolidatedMember 로 종료
 * 세그먼트·자산분류 등 다른 축이 붙은 컨텍스트는 제외.
 */
function isCurrentConsolidatedPlain(ctx: string, year: number): boolean {
  if (!ctx.startsWith(`CFY${year}dFY_`)) return false;
  if (!ctx.includes("_ConsolidatedMember")) return false;
  if (/SegmentConsolidationItemsAxis|OperatingSegments|ClassesOfAssets/.test(ctx)) return false;
  return /ConsolidatedMember$/.test(ctx) || /ReportedAmountMember$/.test(ctx);
}

function pickFact(xml: string, concepts: string[], year: number): number | null {
  for (const c of concepts) {
    const re = new RegExp(
      `<(?:ifrs-full|dart):${c}\\b[^>]*contextRef="([^"]+)"[^>]*>(-?\\d+)</`,
      "g",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      if (isCurrentConsolidatedPlain(m[1], year)) {
        const v = Number(m[2]);
        if (Number.isFinite(v)) return v;
      }
    }
  }
  return null;
}

export async function fetchKrDA(symbol: string, year: number): Promise<KrDA | null> {
  let corpCode: string;
  try {
    corpCode = (await resolveCorpCode(key(), symbol)).corpCode;
  } catch {
    return null;
  }
  const rcpNo = await annualReportRcpNo(corpCode, year).catch(() => null);
  if (!rcpNo) return null;

  let xml: string;
  try {
    const res = await fetch(
      `${BASE}/fnlttXbrl.xml?crtfc_key=${key()}&rcept_no=${rcpNo}&reprt_code=11011`,
      { signal: AbortSignal.timeout(20_000) },
    );
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    const files = unzipSync(buf);
    const name = Object.keys(files).find((n) => n.endsWith(".xbrl"));
    if (!name) return null;
    xml = strFromU8(files[name]);
  } catch {
    return null;
  }

  const dep =
    pickFact(xml, ["AdjustmentsForDepreciationExpense"], year) ??
    pickFact(xml, ["AdjustmentsForDepreciationAndAmortisationExpense"], year);
  const amo = pickFact(xml, ["AdjustmentsForAmortisationExpense"], year);
  if (dep == null && amo == null) return null;

  return {
    year,
    depreciation: dep,
    amortisation: amo,
    source: "DART XBRL (사업보고서 현금흐름표 주석)",
  };
}
