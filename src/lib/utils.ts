import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 증권사 원본 PDF 링크가 http:// 로 내려오는 경우가 있다(예: NH투자증권
 * download.nhqv.com). https:// 페이지(배포본)에서 target="_blank"로 열면
 * 일부 모바일 브라우저가 안전하지 않은 최상위 탐색으로 보고 빈 탭만 띄우고
 * 조용히 막는다(오너 실측 — 탭하면 about:blank만 뜸). 대상 서버가 https도
 * 지원하는 걸 확인했으니(NH 등) 링크를 렌더링하기 직전에 스킴만 올린다 —
 * 수집 스크립트·DB는 그대로 두고 표시 단계에서만 처리해 이미 저장된
 * 기존 레코드에도 바로 적용된다.
 */
export function toHttps(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  return url.startsWith("http://") ? `https://${url.slice(7)}` : url;
}
