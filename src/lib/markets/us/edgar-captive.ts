import "server-only";
import { fetchJson, fetchText } from "../http";
import { withFetchScope } from "../fetch-health";
import { instanceUrl } from "./edgar-classfacts";
import { resolveDebt, type CaptiveDebtPoint } from "./edgar-ev";

/**
 * 금융 자회사(캡티브 파이낸스) 차입금 분리 — EV 에는 **제조 부문 차입금만**
 * 넣는다(오너 결정 2026-09-23).
 *
 * 왜: 포드 크레딧·GM 파이낸셜·캣 파이낸셜의 차입금은 은행 예금처럼 영업용
 * 부채다. 할부금융 이자비용이 이미 매출원가에 들어가 EBITDA 가 그만큼 줄어
 * 있으므로, 그 차입금까지 EV 에 더하면 운용리스와 같은 이유로 이중 반영이
 * 된다(포드는 EV 가 약 1,370억 달러 부풀려짐). MarketScreener 도 포드는 제조
 * 부문 기준으로 본다.
 *
 * 왜 인스턴스 파싱인가: 이 회사들은 차입금을 **부문 차원으로만** 태깅해
 * companyfacts(차원 없는 값만 제공)에 연결 합계조차 없다(Ford·CAT 실측). 상위
 * 600개 스캔(2026-09-23)에서 부문 분리가 확인된 비금융 기업: F·GM·CNH·CAT·
 * PCAR·LEN·DHI·PHM·TXT. DE 는 금융 자회사가 있지만 XBRL 에서 부문 구분을 하지
 * 않아 EV 를 비운다("unsplit").
 */

const UA =
  process.env.SEC_USER_AGENT ??
  "global-market-research (personal use) contact@example.com";
const SEC_HEADERS = { "user-agent": UA, "accept-encoding": "gzip, deflate" };

/** 부문을 나누는 축 — GM 은 BusinessGroupAxis 를 쓴다(첫 스캔에서 놓쳤던 사례).
 *  ConsolidationItemsAxis 는 넣지 않는다 — "내부거래 제거" 같은 조정 멤버가
 *  제조 부문으로 오분류될 수 있다. */
const SEGMENT_AXIS =
  /^(StatementBusinessSegmentsAxis|SegmentsAxis|ProductOrServiceAxis|BusinessGroupAxis)$/;
/** 금융 부문 멤버 — FordCredit·GmFinancial·FinancialProducts·FinancialServices·FinanceGroup.
 *  "…Excluding…"(포드 제조 부문 `CompanyExcludingFordCredit`)은 이름에 Credit 이
 *  들어가도 금융 부문이 아니다 — 이걸 금융으로 잘못 분류해 포드가 판별 실패했었다. */
const FIN_MEMBER = /Financ|Credit|Capital(?!Lease)|Leasing|Lending/i;
const isFinancialMember = (m: string) => FIN_MEMBER.test(m) && !/Excluding/i.test(m);

/** 금융 자회사 차입금 부문 분리에 필요한 태그 (edgar-ev.ts resolveDebt 가 읽는 것) */
const DEBT_TAGS = new Set([
  "LongTermDebtNoncurrent",
  "LongTermDebtAndCapitalLeaseObligations",
  "DebtCurrent",
  "LongTermDebtAndCapitalLeaseObligationsCurrent",
  "LongTermDebtCurrent",
  "ShortTermBorrowings",
  "OtherShortTermBorrowings",
  "CommercialPaper",
  "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities",
  "LongTermDebt",
  "DebtLongtermAndShorttermCombinedAmount",
  "DebtInstrumentCarryingAmount",
  "NotesPayable",
  "LoansPayable",
  "FinanceLeaseLiabilityNoncurrent",
  "FinanceLeaseLiabilityCurrent",
]);

/**
 * 인스턴스 1건에서 기준일별 제조/금융 부문 차입금을 뽑는다.
 * 부문 축 하나만 걸린 시점 값만 본다(차원이 둘 이상이면 채권 종류별 내역 등이라
 * 합계와 중복).
 */
export function extractCaptiveDebt(xml: string): CaptiveDebtPoint[] {
  const ctx = new Map<string, { instant: string; axis: string; member: string }>();
  const cre = /<(?:xbrli:)?context id="([^"]+)">([\s\S]*?)<\/(?:xbrli:)?context>/g;
  let m: RegExpExecArray | null;
  while ((m = cre.exec(xml))) {
    const instant = /<(?:xbrli:)?instant>([^<]+)</.exec(m[2])?.[1];
    if (!instant) continue;
    const dims = [...m[2].matchAll(/dimension="([^"]+)">([^<]+)</g)].map((d) => [
      d[1].split(":").pop()!,
      d[2].trim().split(":").pop()!,
    ]);
    if (dims.length !== 1 || !SEGMENT_AXIS.test(dims[0][0])) continue;
    ctx.set(m[1], { instant, axis: dims[0][0], member: dims[0][1] });
  }
  // date → member → concept → value
  const byDate = new Map<string, Map<string, Map<string, number>>>();
  const fre = /<us-gaap:([A-Za-z0-9]+)\b[^>]*contextRef="([^"]+)"[^>]*>([-0-9.eE]+)</g;
  while ((m = fre.exec(xml))) {
    if (!DEBT_TAGS.has(m[1])) continue;
    const c = ctx.get(m[2]);
    if (!c) continue;
    const v = Number(m[3]);
    if (!Number.isFinite(v)) continue;
    const mem = byDate.get(c.instant) ?? new Map();
    const concepts = mem.get(c.member) ?? new Map();
    concepts.set(m[1], v);
    mem.set(c.member, concepts);
    byDate.set(c.instant, mem);
  }
  const out: CaptiveDebtPoint[] = [];
  for (const [date, members] of byDate) {
    let industrial = 0;
    let financial = 0;
    let hasFin = false;
    let hasInd = false;
    for (const [member, concepts] of members) {
      const r = resolveDebt((c) => concepts.get(c) ?? null);
      if (!r) continue;
      if (isFinancialMember(member)) {
        financial += r.debt;
        hasFin = true;
      } else {
        industrial += r.debt;
        hasInd = true;
      }
    }
    // 금융·제조 부문이 둘 다 잡혀야 분리로 인정 (한쪽만 있으면 판단 불가)
    if (hasFin && hasInd) out.push({ date, industrialDebt: industrial, financialDebt: financial });
  }
  return out;
}

// ── 부문을 나누지 않는 금융 자회사 ────────────────────────────────────

/**
 * 금융 자회사가 있지만 XBRL 에서 차입금을 부문별로 나누지 않는 회사 — EV 를
 * 비운다(연결 차입금에 할부금융 차입금이 섞여 기준이 맞지 않음).
 *
 * XBRL 만으로는 "금융 자회사가 없는 회사"와 구분할 수 없어 목록으로 둔다.
 * 실측(2026-09-23 최신 분기 인스턴스): DE·DELL·SNA·IBM·HPE·CSCO·HOG·XRX 모두
 * 금융 부문 차입금 태그 없음. 오너 결정은 DE 만 미표시 — 나머지는 확인 중.
 * (할부채권 비중으로 자동 판별하려 했으나 실측 실패: GM·CNH·PCAR·DE 등이
 * 회사 고유 태그를 써 0% 로 나오고, RPRX·MELI·SHOP 이 오탐.)
 */
const UNSPLIT_CAPTIVE_CIKS = new Set<number>([
  315189, // DE — Deere & Company
]);

// ── 로더 ─────────────────────────────────────────────────────────────

interface SubmissionsRecent {
  filings: {
    recent: { accessionNumber: string[]; form: string[]; primaryDocument: string[] };
  };
}

const mem = new Map<string, { at: number; data: { points: CaptiveDebtPoint[] } | "unsplit" | null }>();
const TTL = 1000 * 60 * 60 * 12;

/**
 * 금융 자회사 차입금 부문 분리 로드. 금융 자회사가 없으면 null.
 * 부문 분리가 없는 금융 자회사(목록)는 "unsplit" — EV 를 비운다.
 * 최신 파일링 1건으로 판별하고, 금융 자회사면 10-K 4건을 더 받아 과거 연도를
 * 채운다(각 10-K 는 당기·전기 재무상태표를 담아 5개년 커버).
 */
export async function loadCaptiveDebt(
  cik: string,
  sic: string | null | undefined,
): Promise<{ points: CaptiveDebtPoint[] } | "unsplit" | null> {
  // 은행·보험 등 금융 SIC 는 EV 자체를 계산하지 않으므로 볼 필요 없음
  if (sic && /^6/.test(sic)) return null;
  const key = String(cik).replace(/\D/g, "").padStart(10, "0");
  if (UNSPLIT_CAPTIVE_CIKS.has(Number(key))) return "unsplit";
  const hit = mem.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;

  const cikNum = Number(key);
  let data: { points: CaptiveDebtPoint[] } | "unsplit" | null = null;
  // 이 로더가 부른 SEC 조회의 실패만 본다(fetch-health.ts)
  const { failures } = await withFetchScope(async () => {
    try {
      const sub = await fetchJson<SubmissionsRecent>(
        `https://data.sec.gov/submissions/CIK${key}.json`,
        { headers: SEC_HEADERS, revalidate: 60 * 60 * 6 },
      );
      const r = sub.filings.recent;
      const picks: { accn: string; doc: string }[] = [];
      let q = 0;
      let k = 0;
      for (let i = 0; i < r.accessionNumber.length && (q < 1 || k < 4); i++) {
        const f = r.form[i];
        if (f === "10-Q" && q < 1 && k === 0) {
          picks.push({ accn: r.accessionNumber[i], doc: r.primaryDocument[i] });
          q++;
        } else if (f === "10-K" && k < 4) {
          picks.push({ accn: r.accessionNumber[i], doc: r.primaryDocument[i] });
          k++;
        }
      }
      const byDate = new Map<string, CaptiveDebtPoint>();
      for (const [idx, p] of picks.entries()) {
        try {
          const url = await instanceUrl(cikNum, p.accn.replace(/-/g, ""), p.doc);
          if (!url) {
            if (idx === 0) break; // 최신 건을 못 읽으면 판별 불가 — 과거 10-K 로 대신 판별하지 않는다
            continue;
          }
          const xml = await fetchText(url, { headers: SEC_HEADERS, revalidate: false, timeoutMs: 25_000 });
          // 최신 파일링을 먼저 넣고 유지 — 이후(과거) 파일링은 빈 날짜만 채운다(재작성본 우선)
          const pts = extractCaptiveDebt(xml);
          // 판별: 가장 최근 파일링에 금융 부문 차입금이 없으면 금융 자회사 없음 —
          // 나머지 파일링은 받지 않는다(대부분의 종목이 여기서 끝나 비용이 1건).
          if (idx === 0 && !pts.length) break;
          for (const pt of pts) if (!byDate.has(pt.date)) byDate.set(pt.date, pt);
        } catch {
          if (idx === 0) break; // 최신 건조차 실패 → 판단 불가, 금융 자회사 없음으로 둔다
        }
      }
      data = byDate.size ? { points: [...byDate.values()] } : null;
    } catch {
      data = null;
    }
  });
  // 최신 공시 조회가 일시 오류(SEC 429 등)로 실패하면 "금융 자회사 없음"으로 12시간 굳지 않게 캐시하지 않는다
  if (!failures.length) mem.set(key, { at: Date.now(), data });
  return data;
}
