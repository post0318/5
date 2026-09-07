import "server-only";

/**
 * 한국 종목 외국인 보유비율.
 *
 * 공식 무료 API(KRX OpenAPI)에 해당 항목이 없고 KRX MDC 는 세션 없이 차단되어,
 * 사용자 지시에 따라 네이버 금융 JSON 을 사용한다 (CLAUDE.md 크롤링 금지의
 * 예외 — 이 필드에 한함, 개인용). 실시간이 아니므로 일 1회 배치로 DB 에 적재.
 */

export interface KrForeignOwnership {
  /** 외국인 보유비율 (%) */
  ratio: number;
  /** 기준일 YYYY-MM-DD */
  asOf: string;
}

const pctToNum = (s: string | undefined): number | null => {
  if (!s) return null;
  const n = Number(s.replace(/[%,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

export async function fetchKrForeignOwnership(
  code: string,
): Promise<KrForeignOwnership | null> {
  const digits = code.replace(/\D/g, "").padStart(6, "0");
  try {
    const res = await fetch(
      `https://m.stock.naver.com/api/stock/${digits}/integration`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Referer: `https://m.stock.naver.com/domestic/stock/${digits}/total`,
        },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) return null;
    const j = (await res.json()) as {
      dealTrendInfos?: { bizdate?: string; foreignerHoldRatio?: string }[];
      totalInfos?: { code?: string; value?: string }[];
    };

    const trend = j.dealTrendInfos?.[0];
    const ratio =
      pctToNum(trend?.foreignerHoldRatio) ??
      pctToNum(j.totalInfos?.find((x) => x.code === "foreignRate")?.value);
    if (ratio == null) return null;

    const bd = trend?.bizdate;
    const asOf =
      bd && bd.length === 8
        ? `${bd.slice(0, 4)}-${bd.slice(4, 6)}-${bd.slice(6, 8)}`
        : new Date().toISOString().slice(0, 10);
    return { ratio, asOf };
  } catch {
    return null;
  }
}
