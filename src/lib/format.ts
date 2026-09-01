/**
 * 숫자 · 통화 표시 규칙 (prd.md §7)
 * - 천 단위 콤마
 * - 외화(USD, JPY 등): 소수점 2자리, 버림(trunc, 반올림 아님)
 * - 원화(KRW): 정수, 버림(trunc)
 *
 * 버림은 부동소수점 오차를 피하기 위해 문자열 기반으로 처리한다.
 */

export type CurrencyCode = "KRW" | "USD" | "JPY" | "EUR" | (string & {});

/** 통화별 표시 소수 자릿수. 원화는 0, 그 외 외화는 2. */
export function currencyFractionDigits(currency: CurrencyCode): number {
  return currency === "KRW" ? 0 : 2;
}

/**
 * 반올림 없이 소수점 `digits`자리에서 버린다. (음수는 0 방향으로 버림)
 * 문자열 처리로 이진 부동소수점 오차를 피한다.
 */
export function truncateToDigits(value: number, digits: number): number {
  if (!Number.isFinite(value)) return NaN;
  if (digits < 0) digits = 0;

  const neg = value < 0;
  // 지수 표기(1e-7 등)를 피하려고 toFixed로 넉넉히 확장한 뒤 자른다.
  const fixed = Math.abs(value).toFixed(digits + 4);
  const dot = fixed.indexOf(".");
  const truncated = digits === 0 ? fixed.slice(0, dot) : fixed.slice(0, dot + 1 + digits);
  const n = Number(truncated);
  return neg ? -n : n;
}

/** 정수부에 천 단위 콤마를 넣고, 소수부는 `digits`자리로 고정한다. */
function groupWithCommas(value: number, digits: number): string {
  const neg = value < 0 || Object.is(value, -0);
  const abs = Math.abs(value);
  const [intPart, fracPart = ""] = abs.toFixed(digits).split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = digits > 0 ? `${grouped}.${fracPart.padEnd(digits, "0")}` : grouped;
  return neg ? `-${body}` : body;
}

export interface FormatOptions {
  /** null/undefined/NaN일 때 표시할 값. 기본 "-" */
  fallback?: string;
  /** 0을 fallback으로 표시할지. 기본 false */
  zeroAsFallback?: boolean;
}

/**
 * 통화 값 포맷. prd.md §7 규칙 적용.
 * @example formatCurrency(1234.567, "USD") -> "1,234.56"
 * @example formatCurrency(1234.9, "KRW")   -> "1,235"  (X)  → "1,234"
 */
export function formatCurrency(
  value: number | null | undefined,
  currency: CurrencyCode,
  opts: FormatOptions = {},
): string {
  const { fallback = "-", zeroAsFallback = false } = opts;
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  if (zeroAsFallback && value === 0) return fallback;

  const digits = currencyFractionDigits(currency);
  const truncated = truncateToDigits(value, digits);
  return groupWithCommas(truncated, digits);
}

/**
 * 일반 숫자 포맷 (통화 아님). 천 단위 콤마 + 지정 소수 자릿수 버림.
 */
export function formatNumber(
  value: number | null | undefined,
  digits = 0,
  opts: FormatOptions = {},
): string {
  const { fallback = "-", zeroAsFallback = false } = opts;
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  if (zeroAsFallback && value === 0) return fallback;

  const truncated = truncateToDigits(value, digits);
  return groupWithCommas(truncated, digits);
}

/**
 * 배수(멀티플) 표기. 소수 2자리 버림 + "x" 접미사.
 * @example formatMultiple(12.345) -> "12.34x"
 */
export function formatMultiple(value: number | null | undefined, opts: FormatOptions = {}): string {
  const { fallback = "-" } = opts;
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  return `${groupWithCommas(truncateToDigits(value, 2), 2)}x`;
}

/**
 * 퍼센트 표기. 입력은 비율(0.1234) 기준, 소수 2자리 버림.
 * @example formatPercent(0.12345) -> "12.34%"
 */
export function formatPercent(
  ratio: number | null | undefined,
  opts: FormatOptions & { alreadyPercent?: boolean } = {},
): string {
  const { fallback = "-", alreadyPercent = false } = opts;
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return fallback;
  const pct = alreadyPercent ? ratio : ratio * 100;
  return `${groupWithCommas(truncateToDigits(pct, 2), 2)}%`;
}

/** 큰 금액을 조/억/백만 단위로 축약 (통화 무관, 한국식 단위). */
export function formatCompactKRW(value: number | null | undefined, opts: FormatOptions = {}): string {
  const { fallback = "-" } = opts;
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}${formatNumber(abs / 1e12, 2)}조`;
  if (abs >= 1e8) return `${sign}${formatNumber(abs / 1e8, 2)}억`;
  if (abs >= 1e6) return `${sign}${formatNumber(abs / 1e6, 2)}백만`;
  return formatNumber(value, 0);
}

/** 값이 음수인지 (표시 색상 판단용). prd.md §6: 마이너스는 빨간색. */
export function isNegative(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value < 0;
}
