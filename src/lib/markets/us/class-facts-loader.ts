import "server-only";
import { isDbConfigured } from "@/lib/db";
import { getClassAFactsFromDb, saveClassAFactsToDb } from "@/lib/db/us-class-facts";
import type { CompanyFacts } from "./edgar";
import { fetchClassAFacts, needsClassAFacts, type ClassAFacts } from "./edgar-classfacts";
import { secFailuresSince } from "../fetch-health";

/**
 * 듀얼클래스 보정 시계열 로더 (라우트에서 사용).
 *  1) companyfacts 에 EPS·주식수가 있으면 보정 불필요 → null
 *  2) DB(`us_class_facts`, cron 갱신) 우선
 *  3) 없으면 10-K 인스턴스 실시간 파싱 + DB 백필(best-effort)
 * 프로세스 메모리에 짧게 캐시 (콜드스타트 후 첫 요청만 원격).
 */
const mem = new Map<string, { at: number; data: ClassAFacts | null }>();
const TTL = 1000 * 60 * 60 * 12;

export async function loadClassAFacts(
  cik: string,
  facts: CompanyFacts,
): Promise<ClassAFacts | null> {
  if (!needsClassAFacts(facts)) return null;

  const key = String(cik).replace(/\D/g, "").padStart(10, "0");
  const hit = mem.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;

  let data: ClassAFacts | null = null;
  const t0 = Date.now();
  if (isDbConfigured()) {
    data = await getClassAFactsFromDb(key);
  }
  // 전환 기준 주식수(sharesAsConverted) 도입 전 캐시 — 필드가 아예 없으면 다시 파싱한다
  const stale = !!data && [...data.values()].every((y) => y.sharesAsConverted === undefined);
  if (!data || data.size === 0 || stale) {
    try {
      const live = await fetchClassAFacts(key);
      if (live.size > 0) {
        data = live;
        if (isDbConfigured()) void saveClassAFactsToDb(key, live).catch(() => {});
      }
    } catch {
      /* 실패 시 보정 없이 진행 */
    }
  }

  // SEC 조회가 일시 오류로 실패했으면 결과(보정 없음 등)를 캐시하지 않는다 — 다음 요청이 다시 시도(fetch-health.ts)
  if (!secFailuresSince(key, t0).length) mem.set(key, { at: Date.now(), data: data ?? null });
  return data ?? null;
}
