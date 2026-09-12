import { cn } from "@/lib/utils";
import {
  formatCurrency,
  formatMultiple,
  formatNumber,
  formatPercent,
  isNegative,
  type CurrencyCode,
} from "@/lib/format";

interface BaseProps {
  className?: string;
  /** 마이너스일 때 빨간색 (prd.md §6). 기본 true */
  colorNegative?: boolean;
  /** 괄호 표기 `(1,234)` */
  parenNegative?: boolean;
}

function wrap(
  text: string,
  value: number | null | undefined,
  { className, colorNegative = true, parenNegative = false }: BaseProps,
) {
  const neg = isNegative(value);
  const display = neg && parenNegative ? `(${text.replace("-", "")})` : text;
  return (
    <span
      className={cn(
        "tnum",
        neg && colorNegative && "text-down",
        className,
      )}
    >
      {display}
    </span>
  );
}

export function Money({
  value,
  currency,
  fallback = "-",
  ...rest
}: BaseProps & { value: number | null | undefined; currency: CurrencyCode; fallback?: string }) {
  return wrap(formatCurrency(value, currency, { fallback }), value, rest);
}

export function NumberText({
  value,
  digits = 0,
  fallback = "-",
  ...rest
}: BaseProps & { value: number | null | undefined; digits?: number; fallback?: string }) {
  return wrap(formatNumber(value, digits, { fallback }), value, rest);
}

export function Multiple({
  value,
  fallback = "-",
  ...rest
}: BaseProps & { value: number | null | undefined; fallback?: string }) {
  return wrap(formatMultiple(value, { fallback }), value, rest);
}

export function Percent({
  value,
  alreadyPercent = false,
  fallback = "-",
  ...rest
}: BaseProps & {
  value: number | null | undefined;
  alreadyPercent?: boolean;
  fallback?: string;
}) {
  return wrap(formatPercent(value, { alreadyPercent, fallback }), value, rest);
}

/**
 * 등락 방향 색상 클래스. 기본(미국 등)은 상승 녹색·하락 적색, market="kr"이면
 * 상승 빨강·하락 파랑(국내 관행)으로 뒤집는다. 주가·투자의견 등 "등락" 표시에만
 * 쓰고, 재무제표 마이너스 표기(Money 등의 colorNegative)에는 적용하지 않는다.
 */
export function stockDirClass(positive: boolean, market?: "kr" | "us" | "jp" | string): string {
  if (market === "kr") return positive ? "text-kr-up" : "text-kr-down";
  return positive ? "text-up" : "text-down";
}

/** 등락률: 부호에 따라 up/down 색상 (음수만 빨강이 아니라 양수도 녹색). market="kr"이면 색상 반전. */
export function ChangePercent({
  value,
  className,
  fallback = "-",
  market,
}: {
  value: number | null | undefined;
  className?: string;
  fallback?: string;
  /** "kr"이면 상승=빨강·하락=파랑(국내 관행)으로 색상 반전. 미지정 시 기본(상승 녹색·하락 적색). */
  market?: "kr" | "us" | "jp" | string;
}) {
  if (value == null || !Number.isFinite(value)) {
    return <span className={cn("tnum text-muted-foreground", className)}>{fallback}</span>;
  }
  const sign = value > 0 ? "+" : "";
  return (
    <span
      className={cn(
        "tnum",
        value > 0 && stockDirClass(true, market),
        value < 0 && stockDirClass(false, market),
        value === 0 && "text-muted-foreground",
        className,
      )}
    >
      {sign}
      {formatPercent(value, { alreadyPercent: true })}
    </span>
  );
}
