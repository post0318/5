import "server-only";
import raw from "./data/high-dividend-companies.json";

/**
 * 한국거래소(KRX) 고배당기업 명단. mkind.krx.co.kr/dividend 는 robots.txt 전면
 * 차단 + 연 1회 갱신이라 자동 수집 대상이 아니다 → 정적 JSON 을 수동 갱신.
 * (data/high-dividend-companies.json 의 codes 배열 + asOf)
 */
interface RawFile {
  asOf: string;
  codes: string[];
}
const file = raw as RawFile;

const norm = (s: string) => s.replace(/[^0-9]/g, "").padStart(6, "0").slice(-6);
const SET = new Set(file.codes.map(norm));

export function isHighDividendKr(symbol: string): boolean {
  return SET.has(norm(symbol));
}

/** 명단 기준일 (빈 문자열이면 아직 미등록) */
export const HIGH_DIVIDEND_AS_OF = file.asOf;
