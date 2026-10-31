import "server-only";
import { fetchText } from "../http";
import { instanceUrl } from "./edgar-classfacts";

/**
 * ADR 비율 — 최근 20-F 표지(dei:Security12bTitle)의 「American Depositary Shares, each representing eight Ordinary Shares」 문구에서(2026-10-31).
 * 예전엔 비율을 「표지 보통주 수 ÷ 현재 ADR 주식수」로만 역산했는데, 회사 표지 주식수 태깅 오류(BABA 2026-03-31 1,858,037,427 — 본표 18,580,374,278)나
 * 날짜 차이로 비율이 틀렸다(BABA 0.75 → 1:1 로 보고 시가총액 8배). 문구가 없으면(TSM·ASML·SPOT 등 보통주 직접 상장·비율 미기재) null — 기존 역산 그대로
 */
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20, "twenty-five": 25, thirty: 30, forty: 40, fifty: 50, hundred: 100, "one hundred": 100 };
export function parseAdrRatio(titles: string[]): number | null {
  for (const raw of titles) {
    const t = raw.replace(/&#160;|&nbsp;/g, " ").replace(/&#x[0-9a-f]+;/gi, " ").replace(/\s+/g, " ").toLowerCase().replace(/americandepositary/g, "american depositary");
    if (!/american depositary share/.test(t)) continue;
    const m = /represent(?:s|ing)\s+(\d+(?:\.\d+)?|[a-z-]+(?: hundred)?)\s+(?:class [a-z]\s+)?(?:ordinary|common)\s+shares?/.exec(t);
    if (!m) continue;
    const n = /^\d/.test(m[1]) ? Number(m[1]) : WORDS[m[1]];
    if (n && Number.isFinite(n)) return n;
  }
  return null;
}

export async function adrRatioFromCover(cik: string, recent: { accessionNumber: string[]; form: string[]; primaryDocument: string[] } | null | undefined): Promise<number | null> {
  if (!recent) return null;
  const i = recent.form.findIndex((f) => /^20-F$/.test(f));
  if (i < 0) return null;
  const url = await instanceUrl(Number(cik), recent.accessionNumber[i].replace(/-/g, ""), recent.primaryDocument[i]);
  if (!url) return null;
  const x = await fetchText(url, { headers: { "user-agent": "post0318 research post0318@gmail.com", "accept-encoding": "gzip, deflate" }, revalidate: 60 * 60 * 24, timeoutMs: 60_000 });
  return parseAdrRatio([...x.matchAll(/<dei:Security12bTitle[^>]*>([^<]*)</g)].map((m) => m[1]));
}
