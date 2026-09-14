import "server-only";
import { getCachedTranslation, setCachedTranslation } from "../db/translation-cache";

/**
 * 뉴스 제목 번역 + 가벼운 왕복검증. 무인증 Google 번역 웹 엔드포인트를 먼저 쓰고
 * (품질 양호), 실패하면 MyMemory로 폴백한다. LLM 토큰·유료 API 없음.
 * (post0318/4 프로젝트의 src/lib/server/translate.ts 동일 패턴을 이식)
 *
 * translateChecked: 번역 후 역번역이 원문과 크게 어긋나면(오역 의심) ok:false 로
 * 표시해 화면에서 원문을 우선 노출하게 한다.
 */

const REQ_TIMEOUT_MS = 3500;

/**
 * 성공한 번역 결과 메모이즈(2026-09, 오너 지적 — "거시경제 해외뉴스에 번역이
 * 안 된 게 있다"). 원인: translateTitles 는 라우트 1회 호출당 동시성 5·전체
 * 7초 예산 안에서만 번역을 시도하고 예산을 넘기면 원문 그대로 둔다(라우트
 * 전체가 느려지는 것 방지 목적, 의도된 동작) — 그런데 거시경제 해외뉴스는
 * 후보가 최대 30건(야후 3개 주제어 + 구글 뉴스 RSS 합산)까지 늘어나 동시성
 * 5개로는 예산 안에 다 처리 못 하는 경우가 실측으로 확인됨. RSS 원본은
 * 15분 캐시(googleNews.ts)라 같은 기사가 여러 번 재조회되는데, 캐시가 없으면
 * 이전에 성공한 번역까지 매번 처음부터 다시 시도해(불필요한 API 호출 반복,
 * 무료 엔드포인트 레이트리밋 위험 증가) 실패 확률만 계속 유지된다. 이 메모리
 * 캐시는 한 번 성공한 번역은 24시간 재사용해 다음 요청부터 그 항목은 예산을
 * 안 쓰고, 남은 예산을 아직 못 번역한 새 항목에 더 쓸 수 있게 한다(실패는
 * 캐시하지 않음 — 다음 요청에서 다시 시도, 대부분 일시적 오류라 재시도가
 * 안전). 서버리스 인스턴스 재시작 시 초기화되지만(Fluid Compute 는 인스턴스
 * 재사용이 잦아 실무상 효과 있음), 인스턴스가 살아있는 동안은 계속 누적.
 */
const CACHE_TTL_MS = 24 * 3600_000;
const CACHE_MAX = 2000;
const translationCache = new Map<string, { ko: string; ok: boolean; at: number }>();

function cacheGet(key: string): { ko: string; ok: boolean } | null {
  const e = translationCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) {
    translationCache.delete(key);
    return null;
  }
  return e;
}

function cacheSet(key: string, ko: string, ok: boolean) {
  if (translationCache.size >= CACHE_MAX) {
    const oldest = translationCache.keys().next().value;
    if (oldest !== undefined) translationCache.delete(oldest);
  }
  translationCache.set(key, { ko, ok, at: Date.now() });
}

async function viaGoogle(text: string, sl: string, tl = "ko"): Promise<string | null> {
  try {
    const url =
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=` +
      encodeURIComponent(text);
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
    const out = (data[0] as unknown[])
      .map((seg) => (Array.isArray(seg) ? String(seg[0] ?? "") : ""))
      .join("")
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

async function viaMyMemory(text: string, sl: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${sl}|ko`,
      { signal: AbortSignal.timeout(REQ_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      responseStatus?: number;
      responseData?: { translatedText?: string };
    };
    const out = data.responseData?.translatedText;
    if (!out || data.responseStatus !== 200) return null;
    if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(out)) return null;
    return out;
  } catch {
    return null;
  }
}

function contentWords(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/** 두 문자열의 내용어 집합 Dice 계수 (0~1) */
function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return (2 * inter) / (a.size + b.size);
}

/** sl(원문 언어) → 한국어. sl="ko"면 번역 없이 그대로 통과. */
export async function translateChecked(
  src: string,
  sl: "en" | "ja" | "ko",
): Promise<{ ko: string | null; ok: boolean }> {
  if (sl === "ko") return { ko: src, ok: true };
  const cacheKey = `${sl}:${src}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  // DB 캐시(인스턴스 재시작·다른 서버리스 인스턴스에도 살아남음) — 오너 지적,
  // 2026-09: "새로고침할 때마다 번역이 달라지는데 LLM 비용이 계속 쓰는거
  // 아닌가?" — 인메모리 캐시만으로는 HTTP 엣지 캐시가 실제로 안 먹히는
  // 요청에서 같은 헤드라인이 매번 재번역되고(LLM 폴백은 매번 문구도 살짝
  // 달라짐) 있었다. DB에서 찾으면 인메모리에도 채워 같은 인스턴스 안에서는
  // DB 왕복도 생략.
  const dbCached = await getCachedTranslation(sl, src);
  if (dbCached) {
    cacheSet(cacheKey, dbCached.ko, dbCached.ok);
    return dbCached;
  }
  // 1) Google 시도 + 성공 시에만 왕복검증(영어권 위주. dice 계수는 알파벳 기준이라
  //    일본어 역번역 검증엔 약함 — 실패해도 원문 노출이라 안전)
  const gk = await viaGoogle(src, sl, "ko");
  if (gk && gk.trim() !== src.trim()) {
    if (sl !== "en") {
      cacheSet(cacheKey, gk, true);
      void setCachedTranslation(sl, src, gk, true);
      return { ko: gk, ok: true };
    }
    const back = await viaGoogle(gk, "ko", sl);
    if (!back) {
      cacheSet(cacheKey, gk, true);
      void setCachedTranslation(sl, src, gk, true);
      return { ko: gk, ok: true };
    }
    const ok = dice(contentWords(back), contentWords(src)) >= 0.3;
    cacheSet(cacheKey, gk, ok);
    void setCachedTranslation(sl, src, gk, ok);
    return { ko: gk, ok };
  }
  // 2) Google 실패/미번역 → MyMemory 폴백 (왕복검증 생략)
  const mk = await viaMyMemory(src, sl);
  if (mk && mk.trim() !== src.trim()) {
    cacheSet(cacheKey, mk, true);
    void setCachedTranslation(sl, src, mk, true);
    return { ko: mk, ok: true };
  }
  // 3) 무료 경로(Google·MyMemory) 둘 다 실패 → Claude Haiku 최종 폴백(오너
  // 승인, 2026-09 — Google 웹 엔드포인트가 배포 IP에서 간헐적으로 429를
  // 내고, MyMemory는 그럴 때 원문을 그대로 돌려주는 경우가 실측 확인됨).
  // 일본어는 sl="ja"만 지원(ko 는 위에서 이미 처리, en/ja 외 값은 안 옴).
  if (sl === "en" || sl === "ja") {
    const llm = await translateViaLlmFallback(src, sl);
    if (llm) {
      cacheSet(cacheKey, llm, true);
      // LLM 폴백 결과는 특히 DB에 꼭 남겨야 한다 — 실제 비용이 든 호출이라
      // 캐시가 안 먹히면 새로고침마다 돈이 계속 나간다(이번 수정의 핵심 동기).
      await setCachedTranslation(sl, src, llm, true);
      return { ko: llm, ok: true };
    }
  }
  // 실패는 캐시하지 않음 — 다음 요청에서 재시도(대부분 일시적 오류).
  return { ko: null, ok: false };
}

/** LLM 폴백 — 예산 초과·API 키 미설정·호출 실패 시 조용히 null(헤드라인 원문 노출로 안전하게 폴백). */
async function translateViaLlmFallback(text: string, sl: "en" | "ja"): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const { isBudgetExceeded, incUsage } = await import("../db/llm-usage");
    if (await isBudgetExceeded()) return null;
    const { translateHeadline } = await import("../llm/claude");
    const { ko, costUsd } = await translateHeadline(text, sl);
    await incUsage(costUsd);
    return ko;
  } catch (err) {
    console.error("[news] 헤드라인 LLM 번역 폴백 실패:", err);
    return null;
  }
}

/**
 * 여러 항목을 소수 동시성(POOL)·시간예산(DEADLINE_MS) 안에서 번역한다.
 * 예산을 넘긴 항목은 원문 그대로 둔다(라우트가 통째로 느려지는 것을 방지).
 */
export async function translateTitles<T>(
  items: T[],
  sl: "en" | "ja" | "ko",
  getTitle: (item: T) => string,
): Promise<{ titleKo: string; translationOk: boolean }[]> {
  const POOL = 5;
  const DEADLINE_MS = 7000;
  const out = new Array<{ titleKo: string; translationOk: boolean }>(items.length);
  const deadline = Date.now() + DEADLINE_MS;
  let next = 0;

  async function worker() {
    while (next < items.length && Date.now() < deadline) {
      const i = next++;
      const src = getTitle(items[i]);
      const r = await translateChecked(src, sl);
      out[i] = { titleKo: r.ko ?? src, translationOk: r.ko ? r.ok : true };
    }
  }
  await Promise.all(Array.from({ length: Math.min(POOL, items.length || 1) }, worker));
  // 예산 초과로 처리 못한 항목은 원문
  for (let i = 0; i < items.length; i++) {
    if (!out[i]) out[i] = { titleKo: getTitle(items[i]), translationOk: true };
  }
  return out;
}
