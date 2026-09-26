import "server-only";
import { isDbConfigured } from "@/lib/db";
import { getClassAFactsFromDb, saveClassAFactsToDb } from "@/lib/db/us-class-facts";
import type { CompanyFacts } from "./edgar";
import { fetchClassAFacts, needsClassAFacts, type ClassAFacts } from "./edgar-classfacts";
import { withFetchScope } from "../fetch-health";
import { fetchFailureReason, markUnavailable, SecFetchError } from "./sec-unavailable";

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
  let failures: string[] = [];
  if (isDbConfigured()) {
    data = await getClassAFactsFromDb(key);
  }
  // 전환 기준 주식수(sharesAsConverted) 도입 전 캐시 — 필드가 아예 없으면 다시 파싱한다
  const stale = !!data && [...data.values()].every((y) => y.sharesAsConverted === undefined);
  if (!data || data.size === 0 || stale) {
    // 이 로더가 부른 SEC 조회의 실패만 본다(fetch-health.ts — 같은 CIK 의 다른 로더 실패와 섞지 않음)
    // 실패 시 보정 없이 진행 — 조회 실패(404 포함)면 부분 결과를 만들지 않고(edgar-classfacts.ts) 캐시하지 않는다
    const r = await withFetchScope(() =>
      fetchClassAFacts(key).catch((e) => {
        failures.push(fetchFailureReason(e) ?? "클래스별 공시 판독 오류");
        return null;
      }),
    );
    failures = [...failures, ...r.failures];
    const live = r.result;
    if (live && live.size > 0) {
      data = live;
      if (isDbConfigured()) void saveClassAFactsToDb(key, live).catch(() => {});
    }
  }

  // SEC 조회가 일시 오류로 실패했으면 결과(보정 없음 등)를 캐시하지 않는다 — 다음 요청이 다시 시도(fetch-health.ts)
  if (!failures.length) mem.set(key, { at: Date.now(), data: data ?? null });
  // 보정이 필요한 회사인데 원본 판독이 실패해 값이 없다 — "보정 없음"(null)으로 삼키지 않고 올린다(그림자 채우기 금지, 2026-09-27)
  if (failures.length && (!data || data.size === 0)) throw new SecFetchError("classFacts", failures[0]);
  return data ?? null;
}

/**
 * loadClassAFacts + 실패 기록 — 원본 판독 실패면 facts.sourceUnavailable.classFacts 에 적어 돌려준다(주식수·EPS 모듈이
 * 클래스별 값이 필요한 칸을 공란 + 사유로 둔다). 라우트·getTtm·컨센서스가 이것만 쓴다.
 */
export async function loadClassAFactsMarked(
  cik: string,
  facts: CompanyFacts,
): Promise<{ classFacts: ClassAFacts | null; facts: CompanyFacts }> {
  try {
    return { classFacts: await loadClassAFacts(cik, facts), facts };
  } catch (e) {
    return { classFacts: null, facts: markUnavailable(facts, "classFacts", fetchFailureReason(e) ?? `클래스별 공시 판독 오류 · ${e instanceof Error ? e.message : String(e)}`) };
  }
}
