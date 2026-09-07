import "server-only";

/**
 * 네이버 금융 JSON — 한국 종목 보조지표.
 *
 * 공식 무료 API(KRX OpenAPI)에 없는 항목(외국인 보유비율)과, 야후가
 * 한국 종목에서 스케일 오류를 내는 항목(FnGuide 컨센서스 EPS/PER)을
 * 네이버에서 가져온다. CLAUDE.md 크롤링 금지의 예외 — 이 항목들에 한함,
 * 사용자 지시, 개인용. 실시간이 아니므로 일 1회 배치 + 짧은 캐시로 사용.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const num = (s: string | undefined | null): number | null => {
  if (s == null) return null;
  const n = Number(String(s).replace(/[%,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

async function naverJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`https://m.stock.naver.com/api/stock/${path}`, {
      headers: { "User-Agent": UA, Referer: "https://m.stock.naver.com/" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const code6 = (code: string) => code.replace(/\D/g, "").padStart(6, "0");

// ── 외국인 보유비율 ──────────────────────────────────────────────────

export interface KrForeignOwnership {
  ratio: number;
  asOf: string;
}

export async function fetchKrForeignOwnership(
  code: string,
): Promise<KrForeignOwnership | null> {
  const j = await naverJson<{
    dealTrendInfos?: { bizdate?: string; foreignerHoldRatio?: string }[];
    totalInfos?: { code?: string; value?: string }[];
  }>(`${code6(code)}/integration`);
  if (!j) return null;

  const t = j.dealTrendInfos?.[0];
  const ratio =
    num(t?.foreignerHoldRatio) ??
    num(j.totalInfos?.find((x) => x.code === "foreignRate")?.value);
  if (ratio == null) return null;

  const bd = t?.bizdate;
  const asOf =
    bd && bd.length === 8
      ? `${bd.slice(0, 4)}-${bd.slice(4, 6)}-${bd.slice(6, 8)}`
      : new Date().toISOString().slice(0, 10);
  return { ratio, asOf };
}

// ── FnGuide 컨센서스 (네이버 연간 재무 탭의 추정연도 컬럼) ──────────

export interface KrNaverConsensus {
  /** 추정 회계연도 (예: 2026) */
  estYear: number | null;
  /** 추정 EPS (원) */
  estEps: number | null;
  /** 추정 PER (네이버 표시값 — 현재가 ÷ 추정 EPS) */
  estPer: number | null;
  /** 추정 PBR */
  estPbr: number | null;
  /** 목표주가 평균 */
  targetMean: number | null;
  /** 투자의견 평균 (1 매수 ~ 5 매도) */
  recommMean: number | null;
  asOf: string | null;
}

export async function fetchKrNaverConsensus(
  code: string,
): Promise<KrNaverConsensus | null> {
  const c = code6(code);
  const [fin, integ] = await Promise.all([
    naverJson<{
      financeInfo?: {
        trTitleList?: { key: string; isConsensus: string }[];
        rowList?: { title: string; columns: Record<string, { value?: string }> }[];
      };
    }>(`${c}/finance/annual`),
    naverJson<{
      consensusInfo?: {
        createDate?: string;
        recommMean?: string;
        priceTargetMean?: string;
      };
    }>(`${c}/integration`),
  ]);

  const fi = fin?.financeInfo;
  const consKey = fi?.trTitleList?.find((t) => t.isConsensus === "Y")?.key ?? null;
  const rowVal = (title: string) =>
    consKey ? num(fi?.rowList?.find((r) => r.title === title)?.columns?.[consKey]?.value) : null;

  const ci = integ?.consensusInfo;
  const anyData = consKey || ci?.priceTargetMean;
  if (!anyData) return null;

  return {
    estYear: consKey ? Number(consKey.slice(0, 4)) : null,
    estEps: rowVal("EPS"),
    estPer: rowVal("PER"),
    estPbr: rowVal("PBR"),
    targetMean: num(ci?.priceTargetMean),
    recommMean: num(ci?.recommMean),
    asOf: ci?.createDate ?? null,
  };
}
