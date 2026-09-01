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

/** 등락률: 부호에 따라 up/down 색상 (음수만 빨강이 아니라 양수도 녹색) */
export function ChangePercent({
  value,
  className,
  fallback = "-",
}: {
  value: number | null | undefined;
  className?: string;
  fallback?: string;
}) {
  if (value == null || !Number.isFinite(value)) {
    return <span className={cn("tnum text-muted-foreground", className)}>{fallback}</span>;
  }
  const sign = value > 0 ? "+" : "";
  return (
    <span
      className={cn(
        "tnum",
        value > 0 && "text-up",
        value < 0 && "text-down",
        value === 0 && "text-muted-foreground",
        className,
      )}
    >
      {sign}
      {formatPercent(value, { alreadyPercent: true })}
    </span>
  );
}
