import "server-only";
import { USAGE_WARN_RATIO } from "./config.mjs";
import { kstDay, readUsageDay } from "./ledger.mjs";

export type UsageDay = ReturnType<typeof readUsageDay>;
export interface GeminiMonth {
  month: string;
  costUsd: number;
  calls: number;
  budgetUsd: number;
}

const n = (v: number) => v.toLocaleString("en-US");

/** "yesterday"·"today"·YYYYMMDD → YYYYMMDD(KST). 형식이 틀리면 null */
export function resolveUsageDay(q: string | null): string | null {
  if (!q || q === "today") return kstDay();
  if (q === "yesterday") return kstDay(new Date(Date.now() - 864e5));
  return /^\d{8}$/.test(q) ? q : null;
}

/** 상한의 80% 이상인 서비스(점검·즉시 알림용) */
export function usageWarnings(u: UsageDay) {
  return u.services.filter((s) => s.cap != null && s.net >= s.cap * USAGE_WARN_RATIO);
}

/** 텔레그램 한 메시지(매일 08:00 보고) */
export function formatUsageReport(u: UsageDay, gemini: GeminiMonth | null, tag = "1호기"): string {
  const d = `${u.day.slice(4, 6)}-${u.day.slice(6, 8)}`;
  const lines = [`📊 [${tag}] 외부 서비스 사용량 ${d}(KST)`];
  const capped = u.services.filter((s) => s.cap != null);
  const uncapped = u.services.filter((s) => s.cap == null && (s.net > 0 || s.hit > 0));
  for (const s of capped) {
    const mark = s.cap != null && s.net >= s.cap ? " 🛑" : s.cap != null && s.net >= s.cap * USAGE_WARN_RATIO ? " ⚠️" : "";
    const extra = [s.hit ? `캐시 ${n(s.hit)}` : "", s.batch ? `배치 ${n(s.batch)}` : "", s.blocked ? `막힘 ${n(s.blocked)}` : ""].filter(Boolean).join(" · ");
    lines.push(`• ${s.label} ${n(s.net)} / ${n(s.cap!)} (${s.pct}%)${mark}${extra ? ` — ${extra}` : ""}`);
  }
  if (uncapped.length) {
    lines.push("상한 미확인(집계만):");
    for (const s of uncapped) lines.push(`• ${s.label} ${n(s.net)}${s.hit ? ` — 캐시 ${n(s.hit)}` : ""}${s.batch ? ` · 배치 ${n(s.batch)}` : ""}`);
  }
  if (gemini) {
    const pct = gemini.budgetUsd > 0 ? Math.floor((gemini.costUsd / gemini.budgetUsd) * 100) : 0;
    lines.push(`Gemini ${gemini.month} 누적 $${gemini.costUsd.toFixed(2)} / $${gemini.budgetUsd} (${pct}%) · ${n(gemini.calls)}회`);
  }
  if (u.shards === 0) lines.push("(장부 파일 없음 — 장부가 꺼졌거나 그날 대상 요청이 없었음)");
  lines.push("요청 수 = 실제 네트워크 요청(캐시 적중 제외). 1호기 앱·배치만 — 2호기·로컬·Cloud Run·IPO 운영은 장부 밖");
  return lines.join("\n");
}
